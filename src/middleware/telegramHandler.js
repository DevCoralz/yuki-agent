import { environment } from '../config/environment.js';
import { sessionManager } from '../workers/sessionManager.js';
import { formatPairingCode, validatePhoneNumber } from '../utils/phone.js';
import { sessionStore } from '../storage/sessionStore.js';
import { RUNTIME_CONFIG_KEYS } from '../ai/runtimeConfig.js';
import {
  getAccessMode, setAccessMode,
  getCtxLimitChars, setCtxLimitChars,
  getCtxResetHours, setCtxResetHours,
} from '../config/adminConfig.js';

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

// --- Admin config commands ------------------------------------------
//
// Deliberately Telegram-only, NOT chat-to-the-AI tool calls. This is the
// core fix for the earlier self-lock risk: set_model_config (in
// agentTools.js, still available conversationally) has to go through a
// live model call before the tool even fires, so a badly broken
// base_url/model can leave you with no way to talk your way back out.
// These commands never touch the model at all — pure Telegram + SQLite
// writes via sessionStore, so they always work regardless of how broken
// the current model config is. Every setting here is stored in
// registry.sqlite's runtime_config table (same table set_model_config
// already uses) on the mounted Fly volume, so it's live-effective
// immediately and survives both a bot restart and a full redeploy —
// nothing here is written to .env or a Fly secret.

const USER_MENU = [
  '📋 *Menu*',
  '',
  '/start — pairing help',
  '/connect <number> — pair WhatsApp',
  '/disconnect — unpair WhatsApp',
].join('\n');

const ADMIN_MENU_EXTRA = [
  '',
  '🔐 *Admin*',
  '/setctx <num> — per-user char quota (non-admin sessions only; blank/0 = unlimited)',
  '/ctxreset [session] — reset quota window now (all sessions, or just one)',
  '/resetmodel — clear model overrides, revert to .env defaults',
  '/setendpoint <url> — set live API base URL',
  '/setmodel <model> — set live model ID',
  '/setkey <key> — set live API key',
  '/adminonly — only admin WhatsApp sessions get replies',
  '/everyone — all WhatsApp sessions get replies (default)',
].join('\n');

async function showMenu(bot, chatId) {
  const text = authorized(chatId) ? `${USER_MENU}${ADMIN_MENU_EXTRA}` : USER_MENU;
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

async function cmdSetCtx(bot, chatId, rawNum) {
  if (!(await requireAuthorized(bot, chatId))) return;
  const trimmed = String(rawNum || '').trim();
  if (!trimmed || trimmed === '0') {
    setCtxLimitChars(sessionStore, 0, chatId);
    await bot.sendMessage(chatId, '✅ Per-user context quota cleared — non-admin sessions are now unlimited.');
    return;
  }
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n <= 0) {
    await bot.sendMessage(chatId, '❌ Give a positive number of characters, e.g. /setctx 400000 (or /setctx 0 to clear).');
    return;
  }
  setCtxLimitChars(sessionStore, n, chatId);
  await bot.sendMessage(chatId, `✅ Non-admin sessions are now limited to ${n.toLocaleString()} characters per ${getCtxResetHours(sessionStore)}h window. Admin sessions (${environment.adminSessions.join(', ')}) bypass this.`);
}

async function cmdCtxReset(bot, chatId, rawTarget) {
  if (!(await requireAuthorized(bot, chatId))) return;
  const target = String(rawTarget || '').trim();
  if (!target) {
    sessionStore.resetAllCtxUsage();
    await bot.sendMessage(chatId, '✅ Context quota usage reset for every session.');
    return;
  }
  const session = sessionStore.getByName(target);
  if (!session) {
    await bot.sendMessage(chatId, `❌ No registered session named "${target}".`);
    return;
  }
  sessionStore.resetCtxUsage(session.id);
  await bot.sendMessage(chatId, `✅ Context quota usage reset for "${session.registered_name}".`);
}

async function cmdResetModel(bot, chatId) {
  if (!(await requireAuthorized(bot, chatId))) return;
  // Deletes the override rows entirely rather than setting them empty —
  // getRuntimeConfig returns null for a missing row, which correctly
  // falls through to the .env/Fly-secret default in runtimeConfig.js.
  for (const key of Object.values(RUNTIME_CONFIG_KEYS)) {
    sessionStore.clearRuntimeConfig(key);
  }
  await bot.sendMessage(
    chatId,
    `✅ Model config reset to .env defaults.\n\nbase_url: ${environment.yukiApiBaseUrl}\nmodel: ${environment.yukiApiModel}\napi_key: ••••••••`,
  );
}

async function cmdSetEndpoint(bot, chatId, rawUrl) {
  if (!(await requireAuthorized(bot, chatId))) return;
  const url = String(rawUrl || '').trim();
  if (!url) {
    await bot.sendMessage(chatId, '❌ Usage: /setendpoint <url>');
    return;
  }
  sessionStore.setRuntimeConfig(RUNTIME_CONFIG_KEYS.base, url.replace(/\/$/, ''), chatId);
  await bot.sendMessage(chatId, `✅ API base URL set to ${url}\n\nTakes effect on the next message, no restart needed. If this turns out to be wrong, /resetmodel or /setendpoint again always work from here regardless — this command never depends on the model responding.`);
}

async function cmdSetModel(bot, chatId, rawModel) {
  if (!(await requireAuthorized(bot, chatId))) return;
  const model = String(rawModel || '').trim();
  if (!model) {
    await bot.sendMessage(chatId, '❌ Usage: /setmodel <model-id>');
    return;
  }
  sessionStore.setRuntimeConfig(RUNTIME_CONFIG_KEYS.model, model, chatId);
  await bot.sendMessage(chatId, `✅ Model set to ${model}\n\nTakes effect on the next message.`);
}

async function cmdSetKey(bot, chatId, rawKey) {
  if (!(await requireAuthorized(bot, chatId))) return;
  const key = String(rawKey || '').trim();
  if (!key) {
    await bot.sendMessage(chatId, '❌ Usage: /setkey <api-key>');
    return;
  }
  sessionStore.setRuntimeConfig(RUNTIME_CONFIG_KEYS.key, key, chatId);
  // Never echo the key back, same rule set_model_config's tool description follows.
  await bot.sendMessage(chatId, '✅ API key updated (••••••••). Takes effect on the next message.');
}

async function cmdAccessMode(bot, chatId, mode) {
  if (!(await requireAuthorized(bot, chatId))) return;
  setAccessMode(sessionStore, mode, chatId);
  await bot.sendMessage(
    chatId,
    mode === 'adminonly'
      ? `🔒 Admin-only mode ON — only sessions registered as ${environment.adminSessions.join(' or ')} get replies. Everyone else is silently ignored.`
      : '🌐 Everyone mode ON — all registered WhatsApp sessions get replies.',
  );
}

// ----------------------------------------------------------------------

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

  if (!text.startsWith('/')) return;
  const [command, ...args] = text.split(/\s+/);
  const name = command.slice(1).toLowerCase();
  const rest = text.slice(command.length).trim();

  if (name === 'start' || name === 'pair') {
    await bot.sendMessage(chatId, '⚡ *WhatsApp Pairing*\n\n/connect 234xxxxxxxxx', { parse_mode: 'Markdown', reply_markup: nav() });
    return;
  }

  if (name === 'connect') {
    await beginPairing(bot, msg, args[0]);
    return;
  }

  if (name === 'disconnect') {
    await disconnectSession(bot, msg);
    return;
  }

  if (name === 'menu') {
    await showMenu(bot, chatId);
    return;
  }

  if (name === 'setctx') {
    await cmdSetCtx(bot, chatId, args[0]);
    return;
  }

  if (name === 'ctxreset') {
    await cmdCtxReset(bot, chatId, args[0]);
    return;
  }

  if (name === 'resetmodel') {
    await cmdResetModel(bot, chatId);
    return;
  }

  if (name === 'setendpoint') {
    await cmdSetEndpoint(bot, chatId, rest);
    return;
  }

  if (name === 'setmodel') {
    await cmdSetModel(bot, chatId, rest);
    return;
  }

  if (name === 'setkey') {
    await cmdSetKey(bot, chatId, rest);
    return;
  }

  if (name === 'adminonly') {
    await cmdAccessMode(bot, chatId, 'adminonly');
    return;
  }

  if (name === 'everyone') {
    await cmdAccessMode(bot, chatId, 'everyone');
  }
}

export function handleTelegramError(error) {
  console.error('[Telegram]', error?.message || error);
}
