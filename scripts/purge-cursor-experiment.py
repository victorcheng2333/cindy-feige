#!/usr/bin/env python3
"""One-time cleanup of Cindy's discarded Cursor experiment (not a runtime migration).

Preview: python3 scripts/purge-cursor-experiment.py --database /path/to/cindy-OWNER.db
Apply after stopping Cursor turns: same command plus --apply.
A SQLite backup and quarantined Cindy-owned SDK state stay beside the database.
Never touches ~/.cursor, project files, or other engines' tasks.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile


ORPHAN_TABLES = (
    ('skill_usage_exposures', 'session_id'), ('skill_usage_sources', 'session_id'),
    ('ghost_cards', 'session_id'), ('im_notification_origins', 'session_id'),
    ('daily_session_usage', 'session_id'), ('plugin_usage_events', 'session_id'),
    ('media_refs', 'origin_session_id'),
)


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def columns(db, table):
    return {row[1] for row in db.execute('PRAGMA table_info(' + quote(table) + ')')}


def purge(database, apply=False):
    database = Path(database).resolve(strict=True)
    if not database.name.startswith('cindy-') or database.suffix != '.db':
        raise ValueError('Expected an explicit Cindy owner database: cindy-OWNER.db')
    owner = database.stem[len('cindy-'):]
    profile = database.parent
    owner_key = hashlib.sha256(owner.encode()).hexdigest()[:20]
    state = [profile / 'owners' / owner_key / 'cursor',
             profile / 'safe-storage' / ('owner_' + owner_key + '_provider_oauth_cursor.enc')]
    # No symbolic-link traversal into another profile/project.
    for path in state:
        if path.exists() and (path.is_symlink() or not path.resolve().is_relative_to(profile)):
            raise ValueError('Refusing an SDK state path outside this profile')
    mode = 'rw' if apply else 'ro'
    db = sqlite3.connect(database.as_uri() + '?mode=' + mode, uri=True, timeout=15)
    db.execute('PRAGMA foreign_keys=ON')
    try:
        ids = [r[0] for r in db.execute("SELECT id FROM sessions WHERE agent_kind='cursor' ORDER BY id")]
        count = db.execute("SELECT count(*) FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE agent_kind='cursor')").fetchone()[0]
        result = {'tasks': len(ids), 'messages': count, 'applied': False,
                  'sdk_state': [str(p) for p in state if p.exists()]}
        if not apply or not ids and not result['sdk_state']:
            return result
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        sc = columns(db, 'sessions')
        if {'active_turn_started_at', 'last_turn_ended_at'} <= sc:
            active = db.execute("SELECT count(*) FROM sessions WHERE agent_kind='cursor' AND active_turn_started_at > coalesce(last_turn_ended_at,0)").fetchone()[0]
            if active:
                raise ValueError('Stop running Cursor turns before cleanup')
        if 'embedding_jobs' in tables and db.execute("SELECT count(*) FROM embedding_jobs WHERE source='chat' AND source_id IN (SELECT id FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE agent_kind='cursor'))").fetchone()[0]:
            raise ValueError('These tasks have vector indexes; use Cindy database cleanup before retrying')
        if 'schedules' in tables and 'target_session_id' in columns(db, 'schedules'):
            if db.execute("SELECT count(*) FROM schedules WHERE target_session_id IN (SELECT id FROM sessions WHERE agent_kind='cursor')").fetchone()[0]:
                raise ValueError('Detach task-bound automations before cleanup')
        baseline_violations = set(db.execute('PRAGMA foreign_key_check').fetchall())
        backup_root = profile / 'backups'
        backup_root.mkdir(mode=0o700, exist_ok=True)
        backup = Path(tempfile.mkdtemp(prefix='cursor-experiment-', dir=backup_root))
        os.chmod(backup, 0o700)
        backup_db = backup / database.name
        with closing(sqlite3.connect(backup_db)) as snapshot:
            db.backup(snapshot)
        os.chmod(backup_db, 0o600)
        db.execute('BEGIN IMMEDIATE')
        try:
            current = [r[0] for r in db.execute("SELECT id FROM sessions WHERE agent_kind='cursor' ORDER BY id")]
            if current != ids:
                raise ValueError('Cursor task set changed during backup; retry preview')
            db.execute('CREATE TEMP TABLE cleanup_cursor_ids(id TEXT PRIMARY KEY)')
            db.executemany('INSERT INTO cleanup_cursor_ids VALUES (?)', [(i,) for i in ids])
            for table, column in ORPHAN_TABLES:
                if table in tables and column in columns(db, table):
                    db.execute('DELETE FROM ' + quote(table) + ' WHERE ' + quote(column) + ' IN (SELECT id FROM cleanup_cursor_ids)')
            # Existing foreign keys remove messages, queues and child observations;
            # references from surviving tasks use SET NULL, not recursive task deletion.
            db.execute("DELETE FROM sessions WHERE agent_kind='cursor' AND id IN (SELECT id FROM cleanup_cursor_ids)")
            if set(db.execute('PRAGMA foreign_key_check').fetchall()) - baseline_violations:
                raise ValueError('Cleanup introduced a foreign-key violation')
            db.commit()
        except BaseException:
            db.rollback()
            raise
        moved = []
        for path in state:
            if path.exists():
                target = backup / 'sdk-state' / path.relative_to(profile)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(path), str(target))
                moved.append(str(path))
        result.update(applied=True, backup=str(backup), quarantined=moved)
        (backup / 'receipt.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        return result
    finally:
        db.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    print(json.dumps(purge(args.database, args.apply), ensure_ascii=False, indent=2))
