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


if __name__ == '__main__':
    unittest.main()
