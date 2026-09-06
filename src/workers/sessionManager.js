import fs from 'node:fs/promises';
import path from 'node:path';
import { environment } from '../config/environment.js';
import { createWhatsAppSocket } from './whatsapp.js';

const META_FILE = 'pairing-meta.json';

// Injected from app.js after initializeTelegramBot() runs — see the
// comment in telegram.js's getBotInstance() for why this isn't a direct
// import (would create a real module cycle via telegramHandler.js).
let notifierBot = null;
export function setNotifier(botInstance) {
  notifierBot = botInstance;
}

async function notifyRestoreFailed(chatId, phoneNumber, message) {
  if (!notifierBot || !chatId) return;
  try {
    await notifierBot.sendMessage(chatId, `⚠️ +${phoneNumber}: ${message}`);
  } catch (error) {
    // Best-effort — if Telegram itself is unreachable, fall back to the
    // server log, which is still better than nothing, but shouldn't
    // throw and abort the rest of restoreSessions().
    console.error('[WhatsApp] Could not send restore-failure notification:', error?.message || error);
  }
}

class SessionManager {
  constructor() {
    this.session = null;
    this.pairingLock = false;
    this.meta = null;
  }

  async init() {
    await fs.mkdir(path.resolve(environment.sessionDataPath), { recursive: true });
    this.meta = await this.readMeta();
  }

  async readMeta() {
    try {
      return JSON.parse(await fs.readFile(path.resolve(environment.sessionDataPath, META_FILE), 'utf8'));
    } catch {
      return null;
    }
  }

  async writeMeta(phoneNumber, telegramChatId) {
    this.meta = { phoneNumber, telegramChatId: telegramChatId ?? null };
    await fs.writeFile(
      path.resolve(environment.sessionDataPath, META_FILE),
      JSON.stringify(this.meta, null, 2),
      'utf8',
    );
  }

  hasAnyConfiguredSession() {
    return Boolean(this.session?.connected);
  }

  getPairedPhone() {
    return this.meta?.phoneNumber || this.session?.phoneNumber || null;
  }

  isActive(phoneNumber) {
    return this.session?.phoneNumber === phoneNumber;
  }

  async createSession(phoneNumber, telegramChatId) {
    // Only block on a session that actually finished linking. A session
    // that was written to meta but never reached "connected" (i.e. the
    // pairing code was issued but the phone never completed the link)
    // is a dead attempt, not a real session — let it be retried instead
    // of locking the bot out permanently.
    if (this.session?.connected) {
      const existing = this.getPairedPhone();
      return {
        success: false,
        message: `A WhatsApp number is already paired (+${existing}). Only one number is allowed.`,
      };
    }

    if (this.pairingLock) {
      return { success: false, message: 'Pairing is already in progress.' };
    }

    this.pairingLock = true;
    try {
      // Tear down any previous unfinished attempt (socket + stale auth
      // creds for this number) before starting fresh. This is the core
      // fix: without it, a retried pairing reuses corrupted/partial
      // creds from the failed attempt and can never complete the link.
      if (this.session) {
        try { this.session.sock?.ev?.removeAllListeners(); } catch {}
        try { this.session.sock?.ws?.close(); } catch {}
        this.session = null;
      }
      await fs.rm(path.resolve(environment.sessionDataPath, phoneNumber), { recursive: true, force: true }).catch(() => {});

      await this.writeMeta(phoneNumber, telegramChatId);
      const result = await createWhatsAppSocket(phoneNumber, this);
      this.session = {
        sock: result.sock,
        phoneNumber,
        telegramChatId,
        pairingRequested: Boolean(result.pairingCode),
        connected: false,
      };
      return { success: true, pairingCode: result.pairingCode };
    } catch (error) {
      this.session = null;
      await fs.rm(path.resolve(environment.sessionDataPath, META_FILE), { force: true }).catch(() => {});
      await fs.rm(path.resolve(environment.sessionDataPath, phoneNumber), { recursive: true, force: true }).catch(() => {});
      return { success: false, message: error?.message || 'Could not start WhatsApp pairing.' };
    } finally {
      this.pairingLock = false;
    }
  }

  wasPairingRequested() {
    return this.session?.pairingRequested === true;
  }

  markPairingRequested() {
    if (this.session) this.session.pairingRequested = true;
  }

  markConnected() {
    if (this.session) this.session.connected = true;
  }

  markDisconnected() {
    if (this.session) this.session.connected = false;
  }

  async reconnect() {
    if (!this.session || this.pairingLock) return;
    const current = this.session;
    this.pairingLock = true;
    try {
      try {
        current.sock?.ev?.removeAllListeners();
        current.sock?.ws?.close();
      } catch {}
      // Keep the session object alive (marked disconnected) through the
      // reconnect instead of nulling it out first. createWhatsAppSocket
      // checks manager.wasPairingRequested() / manager.session while it
      // runs — if session were null here, it would think no code had
      // been requested yet and issue a brand new one on every single
      // reconnect, invalidating whatever code the user is mid-typing.
      this.session = { ...current, sock: null, connected: false, pairingRequested: true };
      const result = await createWhatsAppSocket(current.phoneNumber, this);
      this.session = {
        sock: result.sock,
        phoneNumber: current.phoneNumber,
        telegramChatId: current.telegramChatId,
        pairingRequested: true,
        connected: false,
      };
    } catch (error) {
      console.error('[WhatsApp] Reconnect failed:', error?.message || error);
    } finally {
      this.pairingLock = false;
    }
  }

  async removeSession(deleteAuth = false) {
    const current = this.session;
    try { current?.sock?.ev?.removeAllListeners(); } catch {}
    try { current?.sock?.ws?.close(); } catch {}
    this.session = null;
    if (deleteAuth) {
      await fs.rm(path.resolve(environment.sessionDataPath), { recursive: true, force: true });
      await fs.mkdir(path.resolve(environment.sessionDataPath), { recursive: true });
      this.meta = null;
    }
  }

  async restoreSessions() {
    await this.init();
    if (!this.meta?.phoneNumber) return;

    try {
      // pairingRequested: true is set BEFORE the call, not after — this
      // is the actual fix. createWhatsAppSocket only skips requesting a
      // brand-new pairing code when manager.wasPairingRequested() is
      // already true at the moment it runs; setting this.session with
      // pairingRequested:true only after the call returns meant
      // wasPairingRequested() read a still-null this.session during
      // restore and returned false, so any restore where
      // state.creds.registered came back false (e.g. the Baileys creds
      // file was mid-write when the process was killed, so it read back
      // corrupted/incomplete) silently requested a FRESH pairing code
      // instead of attempting to reconnect the existing link — a code
      // nobody was watching for, since this isn't a Telegram-initiated
      // /connect. From WhatsApp's side the device stays listed as linked
      // (nothing explicitly logged it out) but the bot-side session was
      // actually a dead, orphaned socket waiting on a connection that was
      // never coming — exactly "device still linked, bot never
      // reconnects". Setting the session (with pairingRequested: true)
      // before the call makes wasPairingRequested() correctly read true
      // during restore, so a restore NEVER silently issues a new code.
      this.session = {
        sock: null,
        phoneNumber: this.meta.phoneNumber,
        telegramChatId: this.meta.telegramChatId ?? null,
        pairingRequested: true,
        connected: false,
      };
      const result = await createWhatsAppSocket(this.meta.phoneNumber, this);
      this.session = {
        sock: result.sock,
        phoneNumber: this.meta.phoneNumber,
        telegramChatId: this.meta.telegramChatId ?? null,
        pairingRequested: true,
        connected: false,
      };

      // If Baileys itself reports the restored creds as unregistered,
      // that's the corrupted-creds scenario above — surface it to
      // Telegram explicitly rather than leaving a dead socket running
      // silently. The person needs to know a real /connect is required;
      // WhatsApp still showing the device as "linked" on the phone is
      // not evidence the bot side actually has a working session.
      if (result.registered === false && this.meta.telegramChatId) {
        await notifyRestoreFailed(
          this.meta.telegramChatId,
          this.meta.phoneNumber,
          'The saved WhatsApp session looks incomplete after the restart (this can happen if the process was killed mid-write). Your phone may still show the device as linked, but this bot cannot use that link anymore — use /disconnect then /connect to re-pair.',
        );
      }
    } catch (error) {
      console.error('[WhatsApp] Could not restore the single session:', error?.message || error);
      if (this.meta?.telegramChatId) {
        await notifyRestoreFailed(
          this.meta.telegramChatId,
          this.meta.phoneNumber,
          `Couldn't restore the WhatsApp session after restart: ${error?.message || 'unknown error'}. Use /disconnect then /connect to re-pair.`,
        );
      }
    }
  }
}

export const sessionManager = new SessionManager();
