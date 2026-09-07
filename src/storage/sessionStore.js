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
        type TEXT NOT NULL CHECK(type IN ('dm','group','telegram')),
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
      );
      CREATE TABLE IF NOT EXISTS ctx_usage (
        session_id INTEGER PRIMARY KEY,
        chars_used INTEGER NOT NULL DEFAULT 0,
        window_started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      );`);

    // The CHECK(type IN (...)) constraint above only takes effect on a
    // FRESH create — an existing chat_sessions table on disk (this DB
    // lives on the mounted Fly volume and survives redeploys, so that's
    // the normal case for anyone who deployed before this change, not a
    // fresh empty one) keeps whatever CHECK constraint it was originally
    // created with. SQLite has no ALTER TABLE for modifying a CHECK
    // constraint directly — the officially documented way to change one
    // is: rename the old table, create a new one with the constraint you
    // want, copy the data across, drop the old table. This adds
    // 'telegram' as a valid type, needed so a Telegram chat can register
    // a session the same way a WhatsApp DM does (shared registered_name
    // namespace, one identity across both platforms, per an explicit
    // design request). Runs once — after the rebuild, sqlite_master's own
    // CHECK clause already says 'telegram', so this comparison is false
    // on every later boot and the whole block is skipped.
    //
    // The old table being migrated may or may not already have the
    // banned/banned_at/banned_by columns (depends whether it was booted
    // at least once after THAT migration was added, before this one) —
    // explicit column names handles both cases correctly, unlike
    // `INSERT INTO x SELECT *`, which breaks the instant the two tables'
    // column counts don't match exactly (this was caught in testing: a
    // fresh 9-column table hit a "12 columns but 9 values" error against
    // a blind SELECT *).
    const currentCheck = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='chat_sessions'").get()?.sql || '';
    if (currentCheck.includes("'dm','group'") && !currentCheck.includes('telegram')) {
      const oldColumns = this.db.prepare('PRAGMA table_info(chat_sessions)').all().map(c => c.name);
      const hasBanned = oldColumns.includes('banned');
      this.db.exec(`
        ALTER TABLE chat_sessions RENAME TO chat_sessions_old_migrating;
        CREATE TABLE chat_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          jid TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL CHECK(type IN ('dm','group','telegram')),
          registered_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          session_path TEXT NOT NULL,
          workspace_path TEXT NOT NULL,
          memory_db_path TEXT NOT NULL,
          chat_json_path TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          banned INTEGER NOT NULL DEFAULT 0,
          banned_at TEXT,
          banned_by TEXT
        );
        INSERT INTO chat_sessions (id,jid,type,registered_name,session_path,workspace_path,memory_db_path,chat_json_path,created_at${hasBanned ? ',banned,banned_at,banned_by' : ''})
          SELECT id,jid,type,registered_name,session_path,workspace_path,memory_db_path,chat_json_path,created_at${hasBanned ? ',banned,banned_at,banned_by' : ''}
          FROM chat_sessions_old_migrating;
        DROP TABLE chat_sessions_old_migrating;
      `);
    }

    // CREATE TABLE IF NOT EXISTS does not retroactively add a column to
    // a chat_sessions table that already exists on disk (this DB lives
    // on the mounted Fly volume and survives redeploys, so a real
    // pre-existing registry.sqlite is the normal case here, not a fresh
    // empty one) — needs an explicit ALTER TABLE, same pattern already
    // used for memory_facts.deleted_at above. Still needed even after
    // the rebuild above, for any database that predates BOTH migrations
    // (rebuild already includes these columns for anyone rebuilt just
    // now, so this is a no-op in that case — PRAGMA table_info confirms
    // either way rather than assuming).
    const sessionColumns = this.db.prepare('PRAGMA table_info(chat_sessions)').all().map(c => c.name);
    if (!sessionColumns.includes('banned')) {
      this.db.exec('ALTER TABLE chat_sessions ADD COLUMN banned INTEGER NOT NULL DEFAULT 0;');
    }
    if (!sessionColumns.includes('banned_at')) {
      this.db.exec('ALTER TABLE chat_sessions ADD COLUMN banned_at TEXT;');
    }
    if (!sessionColumns.includes('banned_by')) {
      this.db.exec('ALTER TABLE chat_sessions ADD COLUMN banned_by TEXT;');
    }
    // own_api_key: the user's personal key, set via /mykey. NULL until
    // set. own_key_allowed/public_key_allowed: independent per-user
    // switches an admin can flip with /allowownkey, /disallowownkey,
    // /allowpublickey, /disallowpublickey (or "all" for every session at
    // once) — see resolveApiKeyForSession() in runtimeConfig.js for how
    // the two combine into one actual decision. Both default to 1
    // (allowed) so existing behavior (shared key works for everyone) is
    // unchanged until an admin deliberately restricts someone.
    if (!sessionColumns.includes('own_api_key')) {
      this.db.exec('ALTER TABLE chat_sessions ADD COLUMN own_api_key TEXT;');
    }
    if (!sessionColumns.includes('own_key_allowed')) {
      this.db.exec('ALTER TABLE chat_sessions ADD COLUMN own_key_allowed INTEGER NOT NULL DEFAULT 1;');
    }
    if (!sessionColumns.includes('public_key_allowed')) {
      this.db.exec('ALTER TABLE chat_sessions ADD COLUMN public_key_allowed INTEGER NOT NULL DEFAULT 1;');
    }
    // own_base_url/own_model: a user bringing their own key is very
    // possibly pointing at a DIFFERENT provider entirely (not just a
    // different credential for this bot's existing shared endpoint) —
    // e.g. their own OpenAI/Anthropic-compatible account, which almost
    // certainly needs its own base URL and may need a different model
    // name too. NULL means "use the shared base_url/model" (set via
    // /myendpoint, /mymodel — independent of whether own_api_key is
    // set, so a user can set these ahead of/without a key change).
    if (!sessionColumns.includes('own_base_url')) {
      this.db.exec('ALTER TABLE chat_sessions ADD COLUMN own_base_url TEXT;');
    }
    if (!sessionColumns.includes('own_model')) {
      this.db.exec('ALTER TABLE chat_sessions ADD COLUMN own_model TEXT;');
    }
  }

  /**
   * Per-session rolling context quota — separate from runtime_config
   * (bot-wide settings) since this is per-session USAGE, not a setting.
   * The window auto-resets (chars_used back to 0, window_started_at bumped
   * to now) the first time it's checked after resetHours have elapsed —
   * no cron/scheduler needed, it just self-heals on next use. addChars is
   * called after a successful model reply with that reply's char count
   * (chars/4 is this codebase's existing token estimate, used elsewhere
   * for the same apis.coralz.de5.net-style endpoint that has no usage
   * field of its own).
   */
  getCtxUsage(sessionId, resetHours) {
    const row = this.db.prepare('SELECT chars_used, window_started_at FROM ctx_usage WHERE session_id = ?').get(sessionId);
    if (!row) {
      this.db.prepare('INSERT INTO ctx_usage (session_id, chars_used, window_started_at) VALUES (?, 0, CURRENT_TIMESTAMP)').run(sessionId);
      return { charsUsed: 0, windowStartedAt: new Date().toISOString() };
    }
    const windowAgeMs = Date.now() - new Date(row.window_started_at + 'Z').getTime();
    if (windowAgeMs > resetHours * 60 * 60 * 1000) {
      this.db.prepare('UPDATE ctx_usage SET chars_used = 0, window_started_at = CURRENT_TIMESTAMP WHERE session_id = ?').run(sessionId);
      return { charsUsed: 0, windowStartedAt: new Date().toISOString() };
    }
    return { charsUsed: row.chars_used, windowStartedAt: row.window_started_at };
  }

  addCtxUsage(sessionId, chars) {
    this.db.prepare('UPDATE ctx_usage SET chars_used = chars_used + ? WHERE session_id = ?').run(Math.max(0, chars | 0), sessionId);
  }

  resetCtxUsage(sessionId) {
    this.db.prepare('UPDATE ctx_usage SET chars_used = 0, window_started_at = CURRENT_TIMESTAMP WHERE session_id = ?').run(sessionId);
  }

  resetAllCtxUsage() {
    this.db.prepare('UPDATE ctx_usage SET chars_used = 0, window_started_at = CURRENT_TIMESTAMP').run();
  }

  /**
   * Force-resets every ctx_usage row whose window has aged past
   * resetHours, REGARDLESS of whether that session has sent a message
   * recently. getCtxUsage() above only resets lazily — the next time
   * THAT SPECIFIC session happens to be checked — which does not satisfy
   * "reset every six hours even when not used": a session that goes
   * quiet for a week would just sit at its last usage number forever,
   * never actually reset, since nothing re-checks it. This is the
   * counterpart called on a real timer (see app.js) rather than only
   * from the per-message path. Skips admin sessions implicitly by simply
   * never being consulted for them — getCtxLimitChars/isAdminSession
   * already bypass quota checks for admins everywhere else, and this
   * function only touches ctx_usage rows that exist at all, which are
   * only ever created for non-admin sessions being checked in the first
   * place (admins never call getCtxUsage since the quota check is
   * skipped before it). Returns how many rows were actually reset, for
   * logging/diagnostics.
   */
  forceResetExpiredCtxWindows(resetHours) {
    const cutoffMs = resetHours * 60 * 60 * 1000;
    const rows = this.db.prepare('SELECT session_id, window_started_at FROM ctx_usage').all();
    let resetCount = 0;
    for (const row of rows) {
      const ageMs = Date.now() - new Date(row.window_started_at + 'Z').getTime();
      if (ageMs > cutoffMs) {
        this.db.prepare('UPDATE ctx_usage SET chars_used = 0, window_started_at = CURRENT_TIMESTAMP WHERE session_id = ?').run(row.session_id);
        resetCount++;
      }
    }
    return resetCount;
  }

  /**
   * Per-user API key + the two independent admin-controlled permission
   * switches (own_key_allowed, public_key_allowed). See
   * resolveApiKeyForSession() in runtimeConfig.js for how these combine
   * into one actual key-selection decision — this class only stores the
   * raw values, it doesn't decide anything.
   */
  setOwnApiKey(sessionId, key) {
    this.db.prepare('UPDATE chat_sessions SET own_api_key = ? WHERE id = ?').run(key, sessionId);
  }

  clearOwnApiKey(sessionId) {
    this.db.prepare('UPDATE chat_sessions SET own_api_key = NULL WHERE id = ?').run(sessionId);
  }

  setOwnKeyAllowed(sessionId, allowed) {
    this.db.prepare('UPDATE chat_sessions SET own_key_allowed = ? WHERE id = ?').run(allowed ? 1 : 0, sessionId);
  }

  setOwnKeyAllowedForAll(allowed) {
    this.db.prepare('UPDATE chat_sessions SET own_key_allowed = ?').run(allowed ? 1 : 0);
  }

  setPublicKeyAllowed(sessionId, allowed) {
    this.db.prepare('UPDATE chat_sessions SET public_key_allowed = ? WHERE id = ?').run(allowed ? 1 : 0, sessionId);
  }

  setPublicKeyAllowedForAll(allowed) {
    this.db.prepare('UPDATE chat_sessions SET public_key_allowed = ?').run(allowed ? 1 : 0);
  }

  /**
   * Per-user base URL / model overrides — independent of own_api_key
   * (a user might set their own endpoint/model before ever setting a
   * key, or vice versa). NULL means "use whatever the shared/global
   * config resolves to" (see resolveApiBaseUrlForSession/
   * resolveApiModelForSession in runtimeConfig.js).
   */
  setOwnBaseUrl(sessionId, url) {
    this.db.prepare('UPDATE chat_sessions SET own_base_url = ? WHERE id = ?').run(url, sessionId);
  }

  clearOwnBaseUrl(sessionId) {
    this.db.prepare('UPDATE chat_sessions SET own_base_url = NULL WHERE id = ?').run(sessionId);
  }

  setOwnModel(sessionId, model) {
    this.db.prepare('UPDATE chat_sessions SET own_model = ? WHERE id = ?').run(model, sessionId);
  }

  clearOwnModel(sessionId) {
    this.db.prepare('UPDATE chat_sessions SET own_model = NULL WHERE id = ?').run(sessionId);
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

  /**
   * Deletes a runtime_config row entirely (not just sets it empty) — used
   * by /resetmodel to revert to .env/Fly-secret defaults. resolveApiBaseUrl
   * etc. (runtimeConfig.js) already do `getRuntimeConfig(key) ||
   * environment.xyz`, and a missing row returns null from getRuntimeConfig,
   * which correctly falls through to the .env default.
   */
  clearRuntimeConfig(key) {
    this.db.prepare('DELETE FROM runtime_config WHERE key = ?').run(String(key).trim());
  }

  getByJid(jid) { return this.db.prepare('SELECT * FROM chat_sessions WHERE jid = ?').get(jid) || null; }
  getByName(name) { return this.db.prepare('SELECT * FROM chat_sessions WHERE registered_name = ? COLLATE NOCASE').get(name) || null; }

  listSessions() {
    return this.db.prepare('SELECT id, registered_name, type, banned, banned_at, created_at FROM chat_sessions ORDER BY created_at DESC').all();
  }

  /**
   * banByName/unbanByName look up by registered_name (case-insensitive,
   * matching getByName) rather than requiring a jid, since /ban and
   * /unban are meant to be usable by name from a completely different
   * chat (an admin banning someone doesn't need that person's raw jid
   * on hand). actorId is whoever ran the command, recorded for
   * accountability the same way runtime_config already tracks
   * updated_by_jid.
   */
  banByName(name, actorId) {
    const session = this.getByName(name);
    if (!session) return { ok: false, code: 'not_found' };
    this.db.prepare('UPDATE chat_sessions SET banned = 1, banned_at = CURRENT_TIMESTAMP, banned_by = ? WHERE id = ?').run(String(actorId ?? ''), session.id);
    return { ok: true, session };
  }

  unbanByName(name) {
    const session = this.getByName(name);
    if (!session) return { ok: false, code: 'not_found' };
    this.db.prepare('UPDATE chat_sessions SET banned = 0, banned_at = NULL, banned_by = NULL WHERE id = ?').run(session.id);
    return { ok: true, session };
  }

  isBanned(session) {
    return Boolean(session?.banned);
  }

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
