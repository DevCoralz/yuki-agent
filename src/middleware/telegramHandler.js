import { environment } from '../config/environment.js';
import { sessionManager } from '../workers/sessionManager.js';
import { formatPairingCode, validatePhoneNumber } from '../utils/phone.js';
import { buildMenuText, dispatchAdminCommand, cmdCtx, cmdMyKey, cmdMyEndpoint, cmdMyModel } from '../config/adminCommands.js';
import { sessionStore } from '../storage/sessionStore.js';
import { isAdminSession, getAccessMode, getCtxLimitChars } from '../config/adminConfig.js';
import { runYuki } from '../ai/yuki.js';
import { markdownToTelegram } from '../ai/telegramFormat.js';

// WhatsApp pairing (/connect, /disconnect) stays restricted to
// YUKI_AUTHORIZED_CHAT_IDS — this is the "only allowed chat id can pair
// WhatsApp" boundary. isAdminSession/ADMIN_SESSIONS below is a SEPARATE,
// unrelated boundary: general chat + admin config commands, open to any
// registered Telegram chat unless admin-only mode is active, exactly
// mirroring WhatsApp's own behavior — this is what makes "Peter" the
// same identity whether he messages from WhatsApp or Telegram.
function authorized(chatId) {
  return environment.telegramAuthorizedChatIds.length === 0 || environment.telegramAuthorizedChatIds.includes(Number(chatId));
}

function nav() {
  return { inline_keyboard: [[{ text: '⚡ Pair WhatsApp', callback_data: 'pair_device' }]] };
}

async function requireAuthorized(bot, chatId) {
  if (authorized(chatId)) return true;
  await bot.sendMessage(chatId, 'This command is not enabled for this Telegram chat.');
  return false;
}

async function disconnectSession(bot, msg) {
  const chatId = msg.chat.id;
  if (!(await requireAuthorized(bot, chatId))) return;

  if (!sessionManager.hasAnyConfiguredSession() && !sessionManager.session) {
    await bot.sendMessage(chatId, 'No WhatsApp session to disconnect.');
    return;
  }

  const existing = sessionManager.getPairedPhone();
  await sessionManager.removeSession(true);
  await bot.sendMessage(
    chatId,
    existing
      ? `🔌 Disconnected +${existing}. Use /connect to pair again.`
      : '🔌 Session cleared. Use /connect to pair again.',
  );
}

async function beginPairing(bot, msg, rawNumber) {
  const chatId = msg.chat.id;
  if (!(await requireAuthorized(bot, chatId))) return;

  const { valid, phone, reason } = validatePhoneNumber(rawNumber);
  if (!valid) {
    await bot.sendMessage(chatId, `❌ Invalid number. ${reason}\n\nExample: /connect 2348012345678`);
    return;
  }

  if (sessionManager.hasAnyConfiguredSession()) {
    const existing = sessionManager.getPairedPhone();
    await bot.sendMessage(chatId, existing ? `❌ Only one WhatsApp number can be paired. Current number: +${existing}.` : '❌ A WhatsApp number is already paired. Only one number is allowed.');
    return;
  }

  const wait = await bot.sendMessage(chatId, `⏳ Starting WhatsApp pairing for +${phone}…`);
  const result = await sessionManager.createSession(phone, chatId);

  if (!result.success) {
    await bot.editMessageText(`❌ Pairing failed: ${result.message}`, { chat_id: chatId, message_id: wait.message_id });
    return;
  }

  if (!result.pairingCode) {
    await bot.editMessageText(`✅ WhatsApp session started for +${phone}.`, { chat_id: chatId, message_id: wait.message_id });
    return;
  }

  await bot.editMessageText(
    `🔑 *WhatsApp pairing code*\n\n\`${formatPairingCode(result.pairingCode)}\`\n\nOpen WhatsApp → Linked Devices → Link a device → Enter code.`,
    { chat_id: chatId, message_id: wait.message_id, parse_mode: 'Markdown', reply_markup: nav() },
  );
}

// Admin config commands (/setctx, /resetmodel, /setendpoint, /setmodel,
// /setkey, /ctxreset, /adminonly, /everyone) now live in
// ../config/adminCommands.js, shared with the WhatsApp side (whatsapp.js)
// so they aren't Telegram-only — see that file's header comment for why
// authorization is resolved per-platform before being passed in here.

const TELEGRAM_USER_EXTRA = ['/start — pairing help', '/connect <number> — pair WhatsApp (restricted)', '/disconnect — unpair WhatsApp (restricted)', '/register <name> — register this chat'];

function telegramJid(chatId) {
  // A distinct, unambiguous prefix so a Telegram registration can never
  // collide on the jid UNIQUE constraint with a real WhatsApp jid — the
  // NAME collision (registered_name UNIQUE COLLATE NOCASE, no type
  // filter) is what's SUPPOSED to happen across platforms (that's the
  // whole point: "Peter" on WhatsApp blocks "Peter" on Telegram), this
  // is only about the underlying jid identifier being unique per row.
  return `tg:${chatId}`;
}

/**
 * Telegram's typing indicator (sendChatAction 'typing') self-clears
 * after ~5 seconds — Telegram's own docs are explicit about this — so a
 * single call before a potentially-long runYuki() call would show
 * "typing..." for a few seconds and then silently stop while the model
 * is still actually working. Mirrors WhatsApp's withTyping in this same
 * codebase: re-sends every 4.5s (just under the 5s expiry) for as long
 * as fn() is running, then lets it lapse naturally once done (no
 * explicit "stopped typing" action exists on Telegram's side the way
 * WhatsApp has 'paused' — it just times out on its own).
 */
async function withTypingTelegram(bot, chatId, fn) {
  let timer;
  try {
    await bot.sendChatAction(chatId, 'typing').catch(() => {});
    timer = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4500);
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

async function handleRegister(bot, msg, rawName) {
  const chatId = msg.chat.id;
  const name = String(rawName || '').trim();
  if (!name) {
    await bot.sendMessage(chatId, 'Use /register <name> to register this chat.');
    return;
  }
  try {
    const result = await sessionStore.register(telegramJid(chatId), 'telegram', name);
    if (!result.ok) {
      const reply = result.code === 'already_registered'
        ? 'This chat is already registered.'
        : result.code === 'name_taken'
          ? `The name "${result.name}" is already in use (registered names are shared across WhatsApp and Telegram — pick a different one).`
          : 'That name is not valid. Please pick another name.';
      await bot.sendMessage(chatId, reply);
      return;
    }
    sessionStore.recordParticipant(result.session.id, telegramJid(chatId), msg.from?.first_name || msg.from?.username || 'Telegram user');
    await bot.sendMessage(chatId, `✅ Registered as "${result.session.registered_name}".\n\nYour chat session is ready.`);
  } catch (error) {
    console.error('[Telegram registration]', error?.message || error);
    await bot.sendMessage(chatId, 'Registration could not be completed. Please try again.');
  }
}

async function handleChat(bot, msg, text) {
  const chatId = msg.chat.id;
  const jid = telegramJid(chatId);
  const session = sessionStore.getByJid(jid);

  // Same three gates as WhatsApp, in the same order, for the same
  // reasons — see whatsapp.js's handleIncomingMessage for the full
  // reasoning on each: ban is total silence and checked first; admin-only
  // silently ignores non-admins (including unregistered strangers, so
  // registration itself is blocked too, consistent with WhatsApp); an
  // unregistered chat gets pointed at /register.
  if (sessionStore.isBanned(session)) return;

  if (getAccessMode(sessionStore) === 'adminonly' && !(session && isAdminSession(session))) {
    return;
  }

  if (!session) {
    await bot.sendMessage(chatId, '👋 Before we can chat here, please register this chat.\n\nUse: /register <name>');
    return;
  }

  const displayName = msg.from?.first_name || msg.from?.username || 'Telegram user';
  sessionStore.recordParticipant(session.id, jid, displayName);
  await sessionStore.appendChat(session, { role: 'user', content: text, senderJid: jid, senderName: displayName, at: new Date().toISOString() });

  let reply;
  try {
    reply = await withTypingTelegram(bot, chatId, () => runYuki(session, text, jid, displayName, {}));
  } catch (error) {
    console.error('[Yuki call failed - telegram]', error?.message || error);
    await bot.sendMessage(chatId, `⚠️ Couldn't get a reply from the model: ${error?.message || 'unknown error'}`);
    return;
  }
  if (!isAdminSession(session)) {
    const ctxLimit = getCtxLimitChars(sessionStore);
    if (ctxLimit) sessionStore.addCtxUsage(session.id, text.length + reply.length);
  }
  await bot.sendMessage(chatId, markdownToTelegram(reply), { parse_mode: 'HTML' });
}

export async function handleTelegramMessage(bot, msg, callbackQueryId = null) {
  const chatId = msg.chat.id;
  if (callbackQueryId) {
    await bot.answerCallbackQuery(callbackQueryId).catch(() => {});
  }

  const text = String(msg.text || '').trim();
  if (text === 'pair_device') {
    await bot.sendMessage(chatId, '📱 Send your WhatsApp number with country code:\n\n/connect 234xxxxxxxxx');
    return;
  }

  if (!text.startsWith('/')) {
    if (text) await handleChat(bot, msg, text);
    return;
  }

  const [command, ...args] = text.split(/\s+/);
  const name = command.slice(1).toLowerCase();
  const rest = text.slice(command.length).trim();

  if (name === 'start' || name === 'pair') {
    await bot.sendMessage(chatId, '⚡ *WhatsApp Pairing*\n\n/connect 234xxxxxxxxx', { parse_mode: 'Markdown', reply_markup: nav() });
    return;
  }

  // /connect and /disconnect stay restricted to YUKI_AUTHORIZED_CHAT_IDS
  // — this is the ONE thing that stays gated; everything else below is
  // open to any Telegram chat, same as WhatsApp.
  if (name === 'connect') {
    await beginPairing(bot, msg, args[0]);
    return;
  }

  if (name === 'disconnect') {
    await disconnectSession(bot, msg);
    return;
  }

  if (name === 'register') {
    await handleRegister(bot, msg, rest);
    return;
  }

  const session = sessionStore.getByJid(telegramJid(chatId));

  if (name === 'menu') {
    const isAuthorized = authorized(chatId);
    await bot.sendMessage(chatId, markdownToTelegram(buildMenuText(isAuthorized, TELEGRAM_USER_EXTRA)), { parse_mode: 'HTML' });
    return;
  }

  if (name === 'ctx') {
    await cmdCtx((t) => bot.sendMessage(chatId, markdownToTelegram(t), { parse_mode: 'HTML' }), session);
    return;
  }

  if (name === 'mykey') {
    await cmdMyKey((t) => bot.sendMessage(chatId, markdownToTelegram(t), { parse_mode: 'HTML' }), session, rest);
    return;
  }

  if (name === 'myendpoint') {
    await cmdMyEndpoint((t) => bot.sendMessage(chatId, markdownToTelegram(t), { parse_mode: 'HTML' }), session, rest);
    return;
  }

  if (name === 'mymodel') {
    await cmdMyModel((t) => bot.sendMessage(chatId, markdownToTelegram(t), { parse_mode: 'HTML' }), session, rest);
    return;
  }

  const reply = (t) => bot.sendMessage(chatId, markdownToTelegram(t), { parse_mode: 'HTML' });
  const isAdmin = isAdminSession(session);
  const handled = await dispatchAdminCommand(name, args, rest, reply, isAdmin, chatId);
  if (handled) return;

  // Not a recognized command and starts with '/' — could be a genuine
  // typo, or just a message that happens to start with a slash. Treat it
  // as chat rather than silently dropping it, same as WhatsApp falls
  // through to the AI for an unrecognized command-prefixed message.
  await handleChat(bot, msg, text);
}

export function handleTelegramError(error) {
  console.error('[Telegram]', error?.message || error);
}
