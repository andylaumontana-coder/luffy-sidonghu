import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.LUFFY_DATA_DIR ?? path.join(__dirname, '../data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'luffy.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  question            TEXT NOT NULL,
  step                INTEGER NOT NULL,
  defined_topic       TEXT,
  summary             TEXT,
  owner_token         TEXT,
  selected_personas   TEXT,
  share_token         TEXT UNIQUE,
  created_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_token, created_at DESC);

CREATE TABLE IF NOT EXISTS facilitator_messages (
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  PRIMARY KEY (session_id, idx)
);

CREATE TABLE IF NOT EXISTS persona_outputs (
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  persona_id  TEXT NOT NULL,
  content     TEXT NOT NULL,
  PRIMARY KEY (session_id, persona_id)
);

CREATE TABLE IF NOT EXISTS persona_followups (
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  persona_id  TEXT NOT NULL,
  idx         INTEGER NOT NULL,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  PRIMARY KEY (session_id, persona_id, idx)
);
`);

try { db.exec(`ALTER TABLE sessions ADD COLUMN owner_token TEXT`); } catch { /* column already exists */ }
try { db.exec(`ALTER TABLE sessions ADD COLUMN selected_personas TEXT`); } catch { /* column already exists */ }
try { db.exec(`ALTER TABLE sessions ADD COLUMN share_token TEXT`); } catch { /* column already exists */ }
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_share ON sessions(share_token) WHERE share_token IS NOT NULL`); } catch { /* ignore */ }
