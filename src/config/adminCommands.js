// Shared command logic for /menu, /setctx, /resetmodel, /setendpoint,
// /setmodel, /setkey, /ctxreset, /adminonly, /everyone — used by BOTH
// Telegram (telegramHandler.js) and WhatsApp (whatsapp.js), so these
// aren't accidentally Telegram-only. Each function here takes a `reply`
// callback (just `(text) => Promise<void>`) instead of a bot/sock object
// directly, so it works the same regardless of which platform is
// actually sending the message.
//
// WHO CAN RUN THESE, per platform (two different trust boundaries,
// deliberately not unified into one — they answer different questions):
//   - Telegram: environment.telegramAuthorizedChatIds (a Telegram chat ID
//     allowlist) — unrelated to WhatsApp session identity entirely.
//   - WhatsApp: isAdminSession(session), i.e. registered under one of the
//     ADMIN_SESSIONS names — there's no Telegram-chat-ID concept on the
//     WhatsApp side to reuse, so admin-session identity is the natural,
//     already-existing equivalent boundary there.
// A caller passes in isAuthorized (already resolved by the platform
// adapter) rather than this module trying to know about chat IDs or
// WhatsApp sessions itself.

import { environment } from './environment.js';
import { sessionStore } from '../storage/sessionStore.js';
import { RUNTIME_CONFIG_KEYS } from '../ai/runtimeConfig.js';
import { getCtxResetHours, setCtxLimitChars, setAccessMode } from './adminConfig.js';

const USER_MENU_LINES = [
  '📋 *Menu*',
  '',
  '/register <name> — register this chat (WhatsApp only)',
];

const ADMIN_MENU_EXTRA_LINES = [
  '',
  '🔐 *Admin*',
  '/setctx <num> — per-user char quota (non-admin sessions only; blank/0 = unlimited)',
  '/ctxreset [session] — reset quota window now (all sessions, or just one)',
  '/resetmodel — clear model overrides, revert to .env defaults',
  '/setendpoint <url> — set live API base URL',
  '/setmodel <model> — set live model ID',
  '/setkey <key> — set live API key',
  '/adminonly — only admin sessions get replies',
  '/everyone — all sessions get replies (default)',
];

/**
 * platformExtraUserLines/platformExtraAdminLines let each transport add
 * its own commands (e.g. Telegram's /connect, /disconnect) without this
 * shared menu needing to know about pairing at all.
 */
export function buildMenuText(isAuthorized, platformExtraUserLines = [], platformExtraAdminLines = []) {
  const lines = [...USER_MENU_LINES, ...platformExtraUserLines];
  if (isAuthorized) lines.push(...ADMIN_MENU_EXTRA_LINES, ...platformExtraAdminLines);
  return lines.join('\n');
}

export async function cmdSetCtx(reply, isAuthorized, rawNum, actorId) {
  if (!isAuthorized) { await reply('This command is not enabled for this chat.'); return; }
  const trimmed = String(rawNum || '').trim();
  if (!trimmed || trimmed === '0') {
    setCtxLimitChars(sessionStore, 0, actorId);
    await reply('✅ Per-user context quota cleared — non-admin sessions are now unlimited.');
    return;
  }
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n <= 0) {
    await reply('❌ Give a positive number of characters, e.g. /setctx 400000 (or /setctx 0 to clear).');
    return;
  }
  setCtxLimitChars(sessionStore, n, actorId);
  await reply(`✅ Non-admin sessions are now limited to ${n.toLocaleString()} characters per ${getCtxResetHours(sessionStore)}h window. Admin sessions (${environment.adminSessions.join(', ')}) bypass this.`);
}

export async function cmdCtxReset(reply, isAuthorized, rawTarget) {
  if (!isAuthorized) { await reply('This command is not enabled for this chat.'); return; }
  const target = String(rawTarget || '').trim();
  if (!target) {
    sessionStore.resetAllCtxUsage();
    await reply('✅ Context quota usage reset for every session.');
    return;
  }
  const session = sessionStore.getByName(target);
  if (!session) {
    await reply(`❌ No registered session named "${target}".`);
    return;
  }
  sessionStore.resetCtxUsage(session.id);
  await reply(`✅ Context quota usage reset for "${session.registered_name}".`);
}

export async function cmdResetModel(reply, isAuthorized) {
  if (!isAuthorized) { await reply('This command is not enabled for this chat.'); return; }
  for (const key of Object.values(RUNTIME_CONFIG_KEYS)) {
    sessionStore.clearRuntimeConfig(key);
  }
  await reply(`✅ Model config reset to .env defaults.\n\nbase_url: ${environment.yukiApiBaseUrl}\nmodel: ${environment.yukiApiModel}\napi_key: ••••••••`);
}

export async function cmdSetEndpoint(reply, isAuthorized, rawUrl, actorId) {
  if (!isAuthorized) { await reply('This command is not enabled for this chat.'); return; }
  const url = String(rawUrl || '').trim();
  if (!url) { await reply('❌ Usage: /setendpoint <url>'); return; }
  sessionStore.setRuntimeConfig(RUNTIME_CONFIG_KEYS.base, url.replace(/\/$/, ''), actorId);
  await reply(`✅ API base URL set to ${url}\n\nTakes effect on the next message, no restart needed. If this turns out to be wrong, /resetmodel or /setendpoint again always work regardless — this command never depends on the model responding.`);
}

export async function cmdSetModel(reply, isAuthorized, rawModel, actorId) {
  if (!isAuthorized) { await reply('This command is not enabled for this chat.'); return; }
  const model = String(rawModel || '').trim();
  if (!model) { await reply('❌ Usage: /setmodel <model-id>'); return; }
  sessionStore.setRuntimeConfig(RUNTIME_CONFIG_KEYS.model, model, actorId);
  await reply(`✅ Model set to ${model}\n\nTakes effect on the next message.`);
}

export async function cmdSetKey(reply, isAuthorized, rawKey, actorId) {
  if (!isAuthorized) { await reply('This command is not enabled for this chat.'); return; }
  const key = String(rawKey || '').trim();
  if (!key) { await reply('❌ Usage: /setkey <api-key>'); return; }
  sessionStore.setRuntimeConfig(RUNTIME_CONFIG_KEYS.key, key, actorId);
  await reply('✅ API key updated (••••••••). Takes effect on the next message.');
}

export async function cmdAccessMode(reply, isAuthorized, mode, actorId) {
  if (!isAuthorized) { await reply('This command is not enabled for this chat.'); return; }
  setAccessMode(sessionStore, mode, actorId);
  await reply(
    mode === 'adminonly'
      ? `🔒 Admin-only mode ON — only sessions registered as ${environment.adminSessions.join(' or ')} get replies. Everyone else is silently ignored.`
      : '🌐 Everyone mode ON — all registered sessions get replies.',
  );
}

/**
 * Dispatches a single admin command by name. Returns true if `name`
 * matched a known admin command (whether or not it succeeded/was
 * authorized) so the caller knows NOT to fall through to the AI/model —
 * false means "not one of these, handle it some other way".
 */
export async function dispatchAdminCommand(name, args, rest, reply, isAuthorized, actorId) {
  switch (name) {
    case 'setctx': await cmdSetCtx(reply, isAuthorized, args[0], actorId); return true;
    case 'ctxreset': await cmdCtxReset(reply, isAuthorized, args[0]); return true;
    case 'resetmodel': await cmdResetModel(reply, isAuthorized); return true;
    case 'setendpoint': await cmdSetEndpoint(reply, isAuthorized, rest, actorId); return true;
    case 'setmodel': await cmdSetModel(reply, isAuthorized, rest, actorId); return true;
    case 'setkey': await cmdSetKey(reply, isAuthorized, rest, actorId); return true;
    case 'adminonly': await cmdAccessMode(reply, isAuthorized, 'adminonly', actorId); return true;
    case 'everyone': await cmdAccessMode(reply, isAuthorized, 'everyone', actorId); return true;
    default: return false;
  }
}
