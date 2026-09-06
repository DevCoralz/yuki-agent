import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { environment } from '../config/environment.js';

function safeName(value) {
  return String(value).trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

function openMemory(session) {
  const db = new DatabaseSync(session.memory_db_path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    sender_jid TEXT,
    sender_name TEXT,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS memory_facts (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT);`);

  // CREATE TABLE IF NOT EXISTS does not retroactively add columns to a
  // table that already existed before this column was introduced — every
  // session database created before this change needs an explicit ALTER
  // TABLE, or forgetFact()/getFacts() below will throw "no such column"
  // on any pre-existing session.
  const existingColumns = db.prepare('PRAGMA table_info(memory_facts)').all().map(c => c.name);
  if (!existingColumns.includes('deleted_at')) {
    db.exec('ALTER TABLE memory_facts ADD COLUMN deleted_at TEXT;');
  }
  return db;
}

export class SessionStore {
  constructor() {
    this.root = path.resolve(environment.yukiWorkspaceRoot);
    this.registryPath = path.join(this.root, 'registry.sqlite');
    this.db = null;
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
    this.db = new DatabaseSync(this.registryPath);
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jid TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK(type IN ('dm','group')),
        registered_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        session_path TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        memory_db_path TEXT NOT NULL,
        chat_json_path TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS participants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        participant_jid TEXT NOT NULL,
        display_name TEXT,
        first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(session_id, participant_jid),
        FOREIGN KEY(session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_participants_session ON participants(session_id);
      CREATE TABLE IF NOT EXISTS runtime_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_by_jid TEXT
      );`);
  }

  /**
   * Global runtime config overrides (API base URL, key, model) — set via
   * an admin-password-gated command, NOT stored in .env. Deliberately
   * separate from per-session memory_facts: this is bot-wide config, not
   * a per-chat remembered fact, and it must never be forgettable via the
   * ordinary forget tool. Lives in the top-level registry.sqlite (one per
   * bot), not a per-session memory DB.
   */
  setRuntimeConfig(key, value, updatedByJid) {
    this.db.prepare('INSERT INTO runtime_config (key,value,updated_at,updated_by_jid) VALUES (?,?,CURRENT_TIMESTAMP,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP,updated_by_jid=excluded.updated_by_jid')
      .run(String(key).trim(), String(value), updatedByJid || null);
  }

  getRuntimeConfig(key) {
    const row = this.db.prepare('SELECT value FROM runtime_config WHERE key = ?').get(String(key).trim());
    return row ? row.value : null;
  }

  getAllRuntimeConfig() {
    return this.db.prepare('SELECT key,value,updated_at,updated_by_jid FROM runtime_config ORDER BY key').all();
  }

  getByJid(jid) { return this.db.prepare('SELECT * FROM chat_sessions WHERE jid = ?').get(jid) || null; }
  getByName(name) { return this.db.prepare('SELECT * FROM chat_sessions WHERE registered_name = ? COLLATE NOCASE').get(name) || null; }

  async register(jid, type, name) {
    const registeredName = safeName(name);
    if (!registeredName) return { ok: false, code: 'invalid_name' };
    if (this.getByJid(jid)) return { ok: false, code: 'already_registered' };
    if (this.getByName(registeredName)) return { ok: false, code: 'name_taken', name: registeredName };

    const sessionPath = path.join(this.root, registeredName);
    const workspacePath = path.join(sessionPath, 'workspace');
    const memoryDbPath = path.join(sessionPath, `${registeredName}.sqlite`);
    const chatJsonPath = path.join(sessionPath, 'chat.json');
    await fs.mkdir(workspacePath, { recursive: true });

    let session;
    try {
      const result = this.db.prepare(`INSERT INTO chat_sessions
        (jid,type,registered_name,session_path,workspace_path,memory_db_path,chat_json_path)
        VALUES (?,?,?,?,?,?,?)`).run(jid, type, registeredName, sessionPath, workspacePath, memoryDbPath, chatJsonPath);
      session = this.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(Number(result.lastInsertRowid));

      const memory = openMemory(session);
      const meta = memory.prepare('INSERT OR REPLACE INTO metadata (key,value) VALUES (?,?)');
      for (const [k, v] of [['session_id', String(session.id)], ['registered_name', registeredName], ['chat_jid', jid], ['chat_type', type]]) meta.run(k, v);
      memory.close();

      await fs.writeFile(chatJsonPath, JSON.stringify({
        sessionId: session.id,
        registeredName,
        jid,
        type,
        messages: []
      }, null, 2));
    } catch (error) {
      if (session) this.db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(session.id);
      await fs.rm(sessionPath, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return { ok: true, session };
  }

  recordParticipant(sessionId, participantJid, displayName) {
    this.db.prepare(`INSERT INTO participants (session_id,participant_jid,display_name) VALUES (?,?,?)
      ON CONFLICT(session_id,participant_jid) DO UPDATE SET display_name=excluded.display_name,last_seen_at=CURRENT_TIMESTAMP`)
      .run(sessionId, participantJid, displayName || null);
  }

  getParticipants(sessionId) {
    return this.db.prepare('SELECT participant_jid, display_name FROM participants WHERE session_id = ? ORDER BY first_seen_at').all(sessionId);
  }

  recordMemory(session, role, content, senderJid = null, senderName = null) {
    const memory = openMemory(session);
    memory.prepare('INSERT INTO memory (role,sender_jid,sender_name,content) VALUES (?,?,?,?)')
      .run(role, senderJid, senderName, String(content));
    memory.close();
  }

  saveFact(session, key, value) {
    const memory = openMemory(session);
    // ON CONFLICT clears deleted_at too — saving a fact again (even one
    // that was previously forgotten) revives it, since that's clearly the
    // user's intent when they ask to remember the same key again.
    memory.prepare('INSERT INTO memory_facts (key,value,updated_at,deleted_at) VALUES (?,?,CURRENT_TIMESTAMP,NULL) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP,deleted_at=NULL').run(String(key).trim(), String(value).trim());
    memory.close();
  }

  getFacts(session) {
    const memory = openMemory(session);
    const rows = memory.prepare('SELECT key,value FROM memory_facts WHERE deleted_at IS NULL ORDER BY updated_at DESC').all();
    memory.close();
    return rows;
  }

  /**
   * Soft-deletes a fact by key — sets deleted_at rather than removing the
   * row, so memory_facts never actually loses data via the agent's own
   * tools. Mirrors an equivalent forget()/trash design from a prior agent
   * build: recoverable, not a permanent delete. Returns false if no
   * active (non-deleted) fact exists under that key.
   */
  forgetFact(session, key) {
    const memory = openMemory(session);
    const result = memory.prepare('UPDATE memory_facts SET deleted_at = CURRENT_TIMESTAMP WHERE key = ? AND deleted_at IS NULL').run(String(key).trim());
    memory.close();
    return result.changes > 0;
  }

  /** Searches facts by key/value substring, active facts only — the recall side of remember/forget. */
  recallFacts(session, query) {
    const memory = openMemory(session);
    let rows;
    if (query && query.trim()) {
      const needle = `%${query.trim()}%`;
      rows = memory.prepare('SELECT key,value FROM memory_facts WHERE deleted_at IS NULL AND (key LIKE ? OR value LIKE ?) ORDER BY updated_at DESC').all(needle, needle);
    } else {
      rows = memory.prepare('SELECT key,value FROM memory_facts WHERE deleted_at IS NULL ORDER BY updated_at DESC').all();
    }
    memory.close();
    return rows;
  }

  getMemory(session, limit = 30) {
    const memory = openMemory(session);
    const rows = memory.prepare('SELECT role,sender_jid,sender_name,content,created_at FROM memory ORDER BY id DESC LIMIT ?').all(limit).reverse();
    memory.close();
    return rows;
  }

  async appendChat(session, message) {
    let data;
    try { data = JSON.parse(await fs.readFile(session.chat_json_path, 'utf8')); } catch { data = { sessionId: session.id, registeredName: session.registered_name, jid: session.jid, type: session.type, messages: [] }; }
    data.messages.push(message);
    data.messages = data.messages.slice(-Math.max(environment.yukiHistoryMessages * 2, 20));
    await fs.writeFile(session.chat_json_path, JSON.stringify(data, null, 2));
  }

  async getChatMessages(session) {
    try {
      const data = JSON.parse(await fs.readFile(session.chat_json_path, 'utf8'));
      return Array.isArray(data.messages) ? data.messages.slice(-environment.yukiHistoryMessages) : [];
    } catch { return []; }
  }
}

export const sessionStore = new SessionStore();
export function detectChat(jid) { return String(jid).endsWith('@g.us') ? 'group' : 'dm'; }
