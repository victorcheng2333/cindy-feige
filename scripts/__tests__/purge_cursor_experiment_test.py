"""Unit: one-time deletion must preserve other engines and support dry runs/backups.
The existing app tests do not exercise this standalone SQLite cleanup command.
Minimal fixture: one Cursor task and one Codex child, with messages and FTS.
"""
import importlib.util
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('purge', Path(__file__).parents[1] / 'purge-cursor-experiment.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PurgeCursor(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cindy-purge-test-')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'cindy-fixture.db'
        with closing(sqlite3.connect(self.path)) as db, db:
            db.executescript('''
              PRAGMA foreign_keys=ON;
              CREATE TABLE sessions(id TEXT PRIMARY KEY,agent_kind TEXT,parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,active_turn_started_at INT,last_turn_ended_at INT);
              CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,content TEXT);
              CREATE VIRTUAL TABLE messages_fts USING fts5(id,content);
              CREATE TRIGGER remove_fts AFTER DELETE ON messages BEGIN DELETE FROM messages_fts WHERE id=old.id; END;
              CREATE TABLE ghost_cards(session_id TEXT,content TEXT);
              INSERT INTO sessions VALUES('experiment','cursor',null,1,2),('keep','codex','experiment',1,2);
              INSERT INTO messages VALUES('a','experiment','remove'),('b','keep','retain');
              INSERT INTO messages_fts VALUES('a','remove'),('b','retain');
              INSERT INTO ghost_cards VALUES('experiment','remove'),('keep','retain');
            ''')

    def test_preview_does_not_write(self):
        self.assertEqual(module.purge(self.path)['tasks'], 1)
        self.assertFalse((self.path.parent / 'backups').exists())
        with closing(sqlite3.connect(self.path)) as db, db:
            self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0], 2)

    def test_apply_preserves_other_engine_and_backup_and_is_repeatable(self):
        result = module.purge(self.path, True)
        with closing(sqlite3.connect(self.path)) as db, db:
            self.assertEqual(db.execute('SELECT id,parent_session_id FROM sessions').fetchall(), [('keep', None)])
            self.assertEqual(db.execute('SELECT content FROM messages').fetchall(), [('retain',)])
            self.assertEqual(db.execute('SELECT content FROM messages_fts').fetchall(), [('retain',)])
            self.assertEqual(db.execute('SELECT content FROM ghost_cards').fetchall(), [('retain',)])
        with closing(sqlite3.connect(Path(result['backup']) / self.path.name)) as backup:
            self.assertEqual(backup.execute('SELECT count(*) FROM messages').fetchone()[0], 2)
        self.assertEqual(module.purge(self.path, True)['tasks'], 0)

    def test_running_turn_refuses_without_deleting(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("UPDATE sessions SET active_turn_started_at=3 WHERE id='experiment'")
        with self.assertRaisesRegex(ValueError, 'Stop running'):
            module.purge(self.path, True)
        with closing(sqlite3.connect(self.path)) as db, db:
            self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0], 2)

    def test_cleans_residual_usage_tables_even_after_sessions_removed(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.executescript('''
              CREATE TABLE daily_model_usage(day TEXT, agent_kind TEXT, model TEXT);
              CREATE TABLE account_usage_snapshots(agent_kind TEXT PRIMARY KEY, snapshot TEXT);
              CREATE TABLE daily_token_attribution(day TEXT, provider TEXT, model TEXT);
              CREATE TABLE token_reporting_first_day(provider TEXT, model TEXT);
              INSERT INTO daily_model_usage VALUES('2026-11-01','cursor','composer-2.5'),('2026-11-01','codex','gpt-5.5');
              INSERT INTO account_usage_snapshots VALUES('cursor','{}'),('antigravity','{}');
              INSERT INTO daily_token_attribution VALUES('2026-11-01','cursor','composer-2.5'),('2026-11-01','xd','claude-sonnet-4-6');
              INSERT INTO token_reporting_first_day VALUES('cursor','composer-2.5'),('anthropic','claude-sonnet-4-6');
            ''')
        # Delete session rows first to verify residual usage tables are still detected & cleaned.
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("DELETE FROM sessions WHERE agent_kind='cursor'")
        preview = module.purge(self.path, False)
        self.assertEqual(preview['tasks'], 0)
        self.assertEqual(preview['usage_rows'], 4)
        applied = module.purge(self.path, True)
        self.assertTrue(applied['applied'])
        with closing(sqlite3.connect(self.path)) as db, db:
            self.assertEqual(db.execute('SELECT agent_kind FROM daily_model_usage').fetchall(), [('codex',)])
            self.assertEqual(db.execute('SELECT agent_kind FROM account_usage_snapshots').fetchall(), [('antigravity',)])
            self.assertEqual(db.execute('SELECT provider FROM daily_token_attribution').fetchall(), [('xd',)])
            self.assertEqual(db.execute('SELECT provider FROM token_reporting_first_day').fetchall(), [('anthropic',)])

    def test_standalone_cursor_schedule_refuses_without_deleting(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.executescript('''
              CREATE TABLE schedules(id TEXT PRIMARY KEY, target_session_id TEXT, agent_kind TEXT, model_agent_kind TEXT, provider_id TEXT);
              INSERT INTO schedules VALUES('s1', NULL, 'cursor', NULL, 'cursor');
            ''')
        with self.assertRaisesRegex(ValueError, 'Cursor automations'):
            module.purge(self.path, True)
        with closing(sqlite3.connect(self.path)) as db, db:
            self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0], 2)


if __name__ == '__main__':
    unittest.main()
