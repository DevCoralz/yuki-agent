import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'node:path';
import fs from 'node:fs/promises';
import pino from 'pino';
import { environment } from '../config/environment.js';
import { sessionStore, detectChat } from '../storage/sessionStore.js';
import { runYuki } from '../ai/yuki.js';

const silentLogger = pino({ level: 'silent' });

function fatalDisconnect(code) {
  return code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden;
}

function messageText(message) {
  return message?.conversation
    || message?.extendedTextMessage?.text
    || message?.imageMessage?.caption
    || message?.videoMessage?.caption
    || '';
}

function senderOf(msg) {
  return msg.key.participant || msg.key.remoteJid;
}

function senderName(msg) {
  return msg.pushName || msg.key.participant || msg.key.remoteJid || 'Unknown user';
}

/**
 * In groups, only respond when directly addressed: @-mentioned, replied
 * to, the message starts with the command prefix, or the message says
 * "yuki" anywhere (case-insensitive, whole word — so "yukiwara" or a
 * random substring doesn't false-trigger). Otherwise the bot stays silent
 * and just logs the message to history (via the caller) without ever
 * calling the model — this is what keeps it quiet in group chatter until
 * someone actually talks to it.
 */
const YUKI_NAME_PATTERN = /\byuki\b/i;

function isAddressedInGroup(sock, msg, text) {
  const botNumber = sock.user?.id?.split(':')[0];
  if (!botNumber) return false;

  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
  const mentioned = contextInfo?.mentionedJid?.some(j => j.startsWith(botNumber));
  const isReplyToBot = contextInfo?.participant?.startsWith(botNumber);
  const startsWithPrefix = text.startsWith(environment.commandPrefix);
  const saysYukiByName = YUKI_NAME_PATTERN.test(text);

  return Boolean(mentioned || isReplyToBot || startsWithPrefix || saysYukiByName);
}

async function withTyping(sock, jid, fn) {
  let timer;
  try {
    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    timer = setInterval(() => sock.sendPresenceUpdate('composing', jid).catch(() => {}), 4500);
    return await fn();
  } finally {
    clearInterval(timer);
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
  }
}

async function handleIncomingMessage(msg) {
  if (msg.key.fromMe || !msg.key.remoteJid || msg.key.remoteJid === 'status@broadcast') return;

  const jid = msg.key.remoteJid;
  const type = detectChat(jid);
  const text = String(messageText(msg.message)).trim();
  if (!text) return;

  const participantJid = senderOf(msg);
  const displayName = senderName(msg);
  const session = sessionStore.getByJid(jid);

  if (!session) {
    if (type === 'group' && !isAddressedInGroup(this, msg, text)) return;

    if (text.toLowerCase().startsWith(`${environment.commandPrefix}register`)) {
      const [, ...parts] = text.split(/\s+/);
      const name = parts.join(' ').trim();
      if (!name) {
        await this.sendMessage(jid, { text: 'Use /register <name> to register this chat.' });
        return;
      }
      try {
        const result = await withTyping(this, jid, () => sessionStore.register(jid, type, name));
        if (!result.ok) {
          const reply = result.code === 'already_registered'
            ? 'This chat is already registered.'
            : result.code === 'name_taken'
              ? `The name "${result.name}" is already in use. Please pick another name.`
              : 'That name is not valid. Please pick another name.';
          await this.sendMessage(jid, { text: reply });
          return;
        }
        sessionStore.recordParticipant(result.session.id, participantJid, displayName);
        await this.sendMessage(jid, {
          text: `✅ Registered as "${result.session.registered_name}".\n\nYour ${type === 'group' ? 'group session' : 'chat session'} is ready.`,
        });
      } catch (error) {
        console.error('[Registration]', error?.message || error);
        await this.sendMessage(jid, { text: 'Registration could not be completed. Please try again.' });
      }
      return;
    }

    await this.sendMessage(jid, { text: '👋 Before we can chat here, please register this chat.\n\nUse: /register <name>' });
    return;
  }

  const botNumber = this.user?.id?.split(':')[0] || '';
  const cleanText = type === 'group' && botNumber
    ? text.replace(new RegExp(`@${botNumber}\\s*`, 'gi'), '').trim() || text
    : text;

  sessionStore.recordParticipant(session.id, participantJid, displayName);
  await sessionStore.appendChat(session, { role: 'user', content: cleanText, senderJid: participantJid, senderName: displayName, at: new Date().toISOString() });

  // Group chats: message is now logged to history either way, but the
  // model is only invoked when the bot is actually addressed — this is
  // what keeps it silent during normal group chatter.
  if (type === 'group' && !isAddressedInGroup(this, msg, text)) return;

  const toolCtx = { sock: this, jid, sourceMsg: msg };
  const reply = await withTyping(this, jid, () => runYuki(
    session,
    cleanText,
    participantJid,
    displayName,
    toolCtx,
    async (status) => { await this.sendMessage(jid, { text: status }); },
  ));
  await this.sendMessage(jid, { text: reply }, { quoted: msg });
}

export async function createWhatsAppSocket(phoneNumber, manager) {
  // Each phone number gets its own creds subfolder — isolated from
  // pairing-meta.json and from any other pairing attempt. Sharing one
  // flat folder was causing Baileys to read/write colliding or stale
  // creds, which is why a pairing code would be issued but the phone
  // side could never complete the handshake.
  const sessionPath = path.join(path.resolve(environment.sessionDataPath), phoneNumber);
  await fs.mkdir(sessionPath, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  let version;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
  } catch {
    // Claude's pinned known-good fallback. Without this, a failed
    // version fetch leaves Baileys to negotiate with WhatsApp using
    // whatever default is baked into the library, which can get the
    // socket closed by WhatsApp right after a pairing code is issued.
    version = [2, 3000, 1015901307];
  }

  const sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, silentLogger) },
    logger: silentLogger,
    printQRInTerminal: false,
    // Matches Claude's exact browser fingerprint. WhatsApp's pairing-code
    // flow is picky about this string — a fingerprint it doesn't
    // recognize as a real client can get the session closed before the
    // code is ever usable, which is exactly this symptom.
    browser: ['Windows', 'Chrome', '114.0.5735.198'],
    version,
    markOnlineOnConnect: true,
    shouldSyncHistoryMessage: () => false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: true,
    connectTimeoutMs: 60000,
    // undefined prevents a premature timeout that closes the connection
    // right when requestPairingCode() is called.
    defaultQueryTimeoutMs: undefined,
    keepAliveIntervalMs: 30000,
  });

  let pairingCode = null;
  let reconnectAttempts = 0;
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg || !msg.message) continue;
      try {
        await handleIncomingMessage.call(sock, msg);
      } catch (error) {
        console.error('[WhatsApp message]', error?.message || error);
      }
    }
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      reconnectAttempts = 0;
      manager.markConnected();
      return;
    }
    if (connection !== 'close') return;

    const statusCode = lastDisconnect?.error instanceof Boom
      ? lastDisconnect.error.output.statusCode
      : 500;
    manager.markDisconnected();
    if (fatalDisconnect(statusCode)) {
      await manager.removeSession(true);
      return;
    }

    // restartRequired (515) fires right after a pairing code is accepted
    // on the phone — WhatsApp closes the socket on purpose and expects an
    // immediate reconnect using the SAME creds to finish the link. Any
    // delay here, or tearing down instead of reconnecting fast, orphans
    // the pairing and it never completes.
    if (statusCode === DisconnectReason.restartRequired) {
      manager.reconnect();
      return;
    }

    // Not yet linked and it's not the expected restart signal — reconnect
    // immediately with no backoff. Any delay here risks the pairing code
    // expiring on the phone before the link finishes.
    if (!state.creds.registered) {
      manager.reconnect();
      return;
    }

    reconnectAttempts += 1;
    const delay = Math.min(5000 * (2 ** (reconnectAttempts - 1)), 30000);
    setTimeout(() => manager.reconnect(), delay).unref?.();
  });

  if (!state.creds.registered && !manager.wasPairingRequested()) {
    // Give the socket a moment to finish its initial handshake before
    // requesting a code — asking too early is a common cause of the
    // code arriving but the link never completing.
    await new Promise(resolve => setTimeout(resolve, 3000));
    if (typeof sock.requestPairingCode === 'function') {
      try {
        pairingCode = await sock.requestPairingCode(phoneNumber);
        manager.markPairingRequested();
      } catch (error) {
        // Don't leave the manager thinking pairing succeeded if the
        // code request itself failed — let the caller see the error
        // and clean up instead of getting stuck in a half-paired state.
        throw new Error(`Pairing code request failed: ${error?.message || error}`);
      }
    }
  }
  return { sock, pairingCode };
}
