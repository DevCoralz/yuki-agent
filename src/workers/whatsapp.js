import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadContentFromMessage,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'node:path';
import fs from 'node:fs/promises';
import pino from 'pino';
import { environment } from '../config/environment.js';
import { sessionStore, detectChat } from '../storage/sessionStore.js';
import { runYuki, isSessionBusy, queueMessageForBusySession } from '../ai/yuki.js';
import { markdownToWhatsApp } from '../ai/whatsappFormat.js';
import { isAdminSession, getAccessMode, getCtxLimitChars } from '../config/adminConfig.js';
import { buildMenuText, dispatchAdminCommand, cmdCtx, cmdMyKey, cmdMyEndpoint, cmdMyModel } from '../config/adminCommands.js';
import { whatsappMessageHasMedia } from '../tools/mediaTools.js';

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

// Same rationale as Telegram's captionlessMediaInstruction in
// telegramHandler.js: a photo/document/etc. with no caption carries no
// actual instruction, so rather than silently dropping it (the previous
// behavior — see the `if (!text) return` guard this feeds into), this
// tells Yuki explicitly to download it, actually inspect it, then report
// and ask before doing anything further. Never written into chat history
// as if the user said it — only used as this turn's message to the model.
function captionlessMediaInstruction(message) {
  const kind = message?.imageMessage ? 'photo'
    : message?.documentMessage ? 'document'
    : message?.videoMessage ? 'video'
    : message?.audioMessage ? 'audio/voice message'
    : message?.stickerMessage ? 'sticker'
    : 'file';

  return `[The user just sent a ${kind} with no caption or instruction attached.]\n\nUse receive_file to download it, then run_command/analyze_image to actually inspect it (use analyze_image for images — real dimensions, format, and color data, not a guess). Then tell the user plainly what you found — what it is, key details, and for an image its dimensions and dominant colors — and ask what they'd like done with it, or whether there's anything to change or add, before taking any further action. Don't guess at what they want; wait for their answer.`;
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
 *
 * Reply-to-bot detection does NOT compare raw JID strings with
 * startsWith. WhatsApp/Baileys addressing has two parallel schemes —
 * plain phone-number JIDs (2348012345678@s.whatsapp.net) and LIDs
 * (184729384756123@lid, an unrelated arbitrary number) — and accounts
 * increasingly get migrated to LID addressing. If the bot's own
 * identity (sock.user.id) and the replied-to message's participant
 * field happen to be in different schemes, a naive
 * `contextInfo.participant.startsWith(botNumber)` silently never
 * matches, even for a genuine reply to the bot's own message — this is
 * the exact same class of bug already root-caused and fixed once before
 * in a sibling project (see bot-ecosystem memory: normalizeJidToNumber's
 * LID detection bug). The fix there was to prefer Baileys' own
 * message-key phone-number fields (senderPn/participantPn) over string
 * derivation — applied the same way here via isSameWaUser(), which
 * compares the numeric local-part of two JIDs regardless of which
 * scheme each happens to be in, and only requires a real numeric match,
 * not a specific domain suffix.
 */
const YUKI_NAME_PATTERN = /\byuki\b/i;

function jidLocalPart(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

/**
 * True if two JIDs refer to the same WhatsApp account, tolerant of one
 * being a LID (@lid) and the other a phone-number JID
 * (@s.whatsapp.net) — a plain string comparison across those two
 * schemes will never match even for the same real account, since a LID
 * is an arbitrary unrelated number, not derived from the phone number.
 */
function isSameWaUser(jidA, jidB) {
  if (!jidA || !jidB) return false;
  return jidLocalPart(jidA) === jidLocalPart(jidB);
}

function isAddressedInGroup(sock, msg, text) {
  const botJid = sock.user?.id;
  if (!botJid) return false;

  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
  // mentionedJid entries and contextInfo.participant can each
  // independently be in either scheme (LID or phone-JID) depending on
  // account migration state — isSameWaUser handles both without caring
  // which one either side happens to use.
  const mentioned = contextInfo?.mentionedJid?.some(j => isSameWaUser(j, botJid));
  const isReplyToBot = isSameWaUser(contextInfo?.participant, botJid);
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

/**
 * Sends a text (optionally with an attached image as the caption image)
 * to every registered session's jid. Image detection follows the same
 * pattern as receive_file/saveIncomingMediaWhatsApp in mediaTools.js — checks
 * the /broadcast message itself for an attached imageMessage. Skips
 * banned sessions (a ban should mean total silence, including broadcasts)
 * and reports real success/failure counts rather than an unconditional
 * "sent ✅", since a stale/invalid jid or a send error for one session
 * shouldn't be hidden behind a blanket success claim.
 */
async function broadcastToAllSessions(sock, msg, caption) {
  const text = String(caption || '').trim();
  const imageMsg = msg.message?.imageMessage;
  if (!text && !imageMsg) {
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Usage: /broadcast <message> (optionally attach an image — its caption becomes this text).' });
    return;
  }

  let imageBuffer = null;
  if (imageMsg) {
    try {
      const stream = await downloadContentFromMessage(imageMsg, 'image');
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      imageBuffer = Buffer.concat(chunks);
    } catch (error) {
      await sock.sendMessage(msg.key.remoteJid, { text: `❌ Couldn't read the attached image: ${error?.message || 'unknown error'}. Sending as text only.` });
    }
  }

  const sessions = sessionStore.listSessions().filter(s => !s.banned);
  let sent = 0;
  const failures = [];
  for (const s of sessions) {
    const full = sessionStore.getByName(s.registered_name);
    if (!full?.jid) { failures.push(`${s.registered_name}: no jid on record`); continue; }
    try {
      if (imageBuffer) {
        await sock.sendMessage(full.jid, { image: imageBuffer, caption: text || undefined });
      } else {
        await sock.sendMessage(full.jid, { text });
      }
      sent++;
    } catch (error) {
      failures.push(`${s.registered_name}: ${error?.message || 'send failed'}`);
    }
  }

  const summary = `📢 Broadcast sent to ${sent}/${sessions.length} session${sessions.length === 1 ? '' : 's'}.` +
    (failures.length ? `\n\nFailed:\n${failures.join('\n')}` : '');
  await sock.sendMessage(msg.key.remoteJid, { text: summary });
}

async function handleIncomingMessage(msg) {
  if (msg.key.fromMe || !msg.key.remoteJid || msg.key.remoteJid === 'status@broadcast') return;

  const jid = msg.key.remoteJid;
  const type = detectChat(jid);
  const text = String(messageText(msg.message)).trim();
  const hasMedia = whatsappMessageHasMedia(msg);
  if (!text && !hasMedia) return;

  const participantJid = senderOf(msg);
  const displayName = senderName(msg);
  const session = sessionStore.getByJid(jid);

  // Banned sessions get ZERO reply — not a refusal message, not
  // anything — checked before every other gate (admin-only mode,
  // registration flow, everything) since "won't even reply a dime" was
  // explicit: any reply at all, even "you're banned", is still a reply.
  if (sessionStore.isBanned(session)) return;

  // Admin-only mode: unregistered strangers AND any registered non-admin
  // session are silently ignored (no reply at all — an explicit refusal
  // would still leak that the bot exists and is just gatekept, which
  // isn't the point of this switch). Registration itself is blocked too,
  // not just replies, since letting new sessions register while
  // admin-only is on would be confusing (they'd register successfully,
  // then get silence forever). Admin sessions are completely unaffected.
  if (getAccessMode(sessionStore) === 'adminonly' && !(session && isAdminSession(session))) {
    return;
  }

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

  // Real command handling for registered sessions — WITHOUT this, /menu
  // and every other admin command (/setctx, /resetmodel, /setendpoint,
  // etc.) typed on WhatsApp were never intercepted at all: they fell
  // straight through to the AI like ordinary chat text, and the model
  // just improvised a plausible-looking reply from its system prompt
  // (different wording each time, no real command list behind it) —
  // which is exactly what was happening before this. In groups, gated
  // behind the same isAddressedInGroup check the AI reply path already
  // uses — without it, ANY group member typing a command-prefixed
  // aside (not meant for the bot at all) would trigger real command
  // dispatch, including admin commands from non-admins (harmless
  // "not enabled" replies, but still noisy and unexpected). Checked
  // BEFORE the per-user quota logic since a command is not a chat
  // message and shouldn't count against anyone's context quota.
  // isAdminSession(session) is the WhatsApp-side authorization boundary
  // (see adminCommands.js header) — unrelated to Telegram's chat-ID
  // allowlist, since there's no equivalent concept here.
  if (text.startsWith(environment.commandPrefix) && (type !== 'group' || isAddressedInGroup(this, msg, text))) {
    const [command, ...args] = text.split(/\s+/);
    const cmdName = command.slice(environment.commandPrefix.length).toLowerCase();
    const rest = text.slice(command.length).trim();
    const reply = (t) => this.sendMessage(jid, { text: t });
    const isAdmin = isAdminSession(session);

    if (cmdName === 'menu') {
      await reply(markdownToWhatsApp(buildMenuText(isAdmin)));
      return;
    }

    if (cmdName === 'ctx') {
      await cmdCtx((t) => reply(markdownToWhatsApp(t)), session);
      return;
    }

    if (cmdName === 'mykey') {
      await cmdMyKey((t) => reply(markdownToWhatsApp(t)), session, rest);
      return;
    }

    if (cmdName === 'myendpoint') {
      await cmdMyEndpoint((t) => reply(markdownToWhatsApp(t)), session, rest);
      return;
    }

    if (cmdName === 'mymodel') {
      await cmdMyModel((t) => reply(markdownToWhatsApp(t)), session, rest);
      return;
    }

    if (cmdName === 'broadcast') {
      if (!isAdmin) { await reply('This command is not enabled for this chat.'); return; }
      await broadcastToAllSessions(this, msg, rest);
      return;
    }

    const handled = await dispatchAdminCommand(cmdName, args, rest, (t) => reply(markdownToWhatsApp(t)), isAdmin, participantJid);
    if (handled) return;
    // Not a recognized command (e.g. "/register" again, already handled
    // above, or genuinely unknown) — fall through to the AI as before,
    // same as any command-prefixed text always did.
  }

  const botNumber = jidLocalPart(this.user?.id);
  const cleanText = type === 'group' && botNumber
    ? text.replace(new RegExp(`@${botNumber}\\s*`, 'gi'), '').trim() || text
    : text;

  sessionStore.recordParticipant(session.id, participantJid, displayName);
  // Logged as what the user actually sent (real text, or a plain
  // placeholder for captionless media) — the synthesized instruction
  // built below is only what goes to the MODEL this turn, never written
  // into chat history as if the user said it.
  await sessionStore.appendChat(session, {
    role: 'user',
    content: cleanText || (hasMedia ? '[media, no caption]' : ''),
    senderJid: participantJid,
    senderName: displayName,
    at: new Date().toISOString(),
  });

  // Group chats: message is now logged to history either way, but the
  // model is only invoked when the bot is actually addressed — this is
  // what keeps it silent during normal group chatter. Captionless media
  // in a group still needs an explicit address (mention/reply/prefix)
  // same as text would — isAddressedInGroup handles that check already.
  if (type === 'group' && !isAddressedInGroup(this, msg, text)) return;

  const effectiveText = cleanText || (hasMedia ? captionlessMediaInstruction(msg.message) : '');
  if (!effectiveText) return;

  // If this session already has a runYuki() call actively running (a
  // multi-round tool task still in progress), do NOT start a second,
  // competing call — this used to be the real bug behind a message sent
  // mid-task silently getting no reply (two calls racing on the same
  // session with no coordination). Queue it into the running call's
  // inbox instead — the model that's already working sees it on its next
  // round (see the queue-drain in runYuki's loop, yuki.js) and decides
  // for itself what it means, same as WhatsApp's Telegram counterpart in
  // telegramHandler.js.
  if (isSessionBusy(session.id)) {
    queueMessageForBusySession(session.id, effectiveText);
    return;
  }

  // Quota enforcement itself now lives INSIDE runYuki — being over quota
  // no longer blocks the message entirely; the model still replies
  // conversationally, just without tool access (see yuki.js). isAdmin/
  // ctxLimit are still needed here only for the usage-recording call
  // below, not for gating.
  const isAdmin = isAdminSession(session);
  const ctxLimit = getCtxLimitChars(sessionStore);

  const toolCtx = { sock: this, jid, sourceMsg: msg };
  let reply;
  try {
    reply = await withTyping(this, jid, () => runYuki(
      session,
      effectiveText,
      participantJid,
      displayName,
      toolCtx,
      async (status) => { await this.sendMessage(jid, { text: `⋯ ${status}` }); },
    ));
  } catch (error) {
    // Without this, a failed model call (bad YUKI_API_BASE_URL, unreachable
    // model server, bad key, wrong model name) was caught silently further
    // up in messages.upsert's catch block — logged to `fly logs` only, with
    // the user never getting any reply at all. That looked like "commands
    // work but AI doesn't", with no visible error on the WhatsApp side.
    // Surfacing the real message here means the next failure is
    // immediately diagnosable from the chat itself, not just server logs.
    console.error('[Yuki call failed]', error?.message || error);
    await this.sendMessage(jid, { text: `⚠️ Couldn't get a reply from the model: ${error?.message || 'unknown error'}` }, { quoted: msg });
    return;
  }
  if (!isAdmin && ctxLimit) {
    // chars/4 ~= tokens is this codebase's existing estimate (the model
    // endpoint returns no usage field) — counting both the user's message
    // and the reply, since both cost real context either way.
    sessionStore.addCtxUsage(session.id, cleanText.length + reply.length);
  }
  // runYuki now returns plain Markdown (platform formatting moved OUT of
  // yuki.js so Telegram sessions don't get WhatsApp's dialect baked in
  // before telegramHandler.js's own converter runs on top of it — that
  // was a real double-conversion bug). Applied here, once, for WhatsApp.
  await this.sendMessage(jid, { text: markdownToWhatsApp(reply) }, { quoted: msg });
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
  return { sock, pairingCode, registered: state.creds.registered };
}
