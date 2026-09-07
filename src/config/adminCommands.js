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
import { getCtxResetHours, getCtxLimitChars, setCtxLimitChars, setAccessMode, isAdminSession } from './adminConfig.js';

const USER_MENU_LINES = [
  '✨ *Yuki* ✨',
  '',
  '👤 *Your commands*',
  '/register <name> — register this chat',
  '/ctx — check your usage & reset time',
  '/mykey <key> — use your own API key (send "clear" to remove)',
  '/myendpoint <url> — your own base URL (only used with your own key)',
  '/mymodel <model> — your own model (only used with your own key)',
];

const ADMIN_MENU_EXTRA_LINES = [
  '',
  '━━━━━━━━━━━━━━',
  '🔐 *Admin*',
  '',
  '_Access & moderation_',
  '/sessions — list every registered session',
  '/ban <name> — zero replies, ever, until /unban',
  '/unban <name>',
  '/adminonly — only admin sessions get replies',
  '/everyone — all sessions get replies (default)',
  '',
  '_Usage limits_',
  '/setctx <num> — per-user char quota (0 = unlimited)',
  '/ctxreset [name] — reset usage now (all, or one session)',
  '',
  '_Model config_',
  '/resetmodel — revert to .env defaults',
  '/setendpoint <url>',
  '/setmodel <model>',
  '/setkey <key> — sets the SHARED key (not any one user\'s)',
  '',
  '_Per-user key permissions_',
  '/allowownkey <name|all>',
  '/disallowownkey <name|all>',
  '/allowpublickey <name|all>',
  '/disallowpublickey <name|all>',
  '',
  '_Broadcast_',
  '/broadcast <message> — to every session (WhatsApp; image+caption OK)',
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

export async function cmdSessions(reply, isAuthorized) {
  if (!isAuthorized) { await reply('This command is not enabled for this chat.'); return; }
  const sessions = sessionStore.listSessions();
  if (!sessions.length) { await reply('No registered sessions yet.'); return; }
  const lines = sessions.map(s => {
    const tag = s.banned ? '🚫 BANNED' : (environment.adminSessions.includes(String(s.registered_name).toLowerCase()) ? '👑 admin' : '');
    return `• ${s.registered_name} (${s.type})${tag ? ` — ${tag}` : ''}`;
  });
  await reply(`📋 *Registered sessions* (${sessions.length})\n\n${lines.join('\n')}`);
}

export async function cmdBan(reply, isAuthorized, rawName, actorId) {
  if (!isAuthorized) { await reply('This command is not enabled for this chat.'); return; }
  const name = String(rawName || '').trim();
  if (!name) { await reply('❌ Usage: /ban <session-name>'); return; }
  const result = sessionStore.banByName(name, actorId);
  if (!result.ok) { await reply(`❌ No registered session named "${name}".`); return; }
  await reply(`🚫 "${result.session.registered_name}" is now banned — no replies at all until /unban.`);
}

export async function cmdUnban(reply, isAuthorized, rawName) {
  if (!isAuthorized) { await reply('This command is not enabled for this chat.'); return; }
  const name = String(rawName || '').trim();
  if (!name) { await reply('❌ Usage: /unban <session-name>'); return; }
  const result = sessionStore.unbanByName(name);
  if (!result.ok) { await reply(`❌ No registered session named "${name}".`); return; }
  await reply(`✅ "${result.session.registered_name}" is unbanned.`);
}

// --- User-facing commands (no admin gate — any registered session can
// run these on themselves) --------------------------------------------

/**
 * /ctx — shows the CALLING session's own usage for the current window.
 * Admins are unlimited by design (isAdminSession bypasses every quota
 * check elsewhere), so this tells them that plainly instead of a fake
 * "0 / 400000" that would misrepresent their real (unlimited) status.
 */
export async function cmdCtx(reply, session) {
  if (!session) { await reply('Register first with /register <name> to have a context window to check.'); return; }
  if (isAdminSession(session)) {
    await reply('👑 Admin session — no usage limit applies to you.');
    return;
  }
  const ctxLimit = getCtxLimitChars(sessionStore);
  const resetHours = getCtxResetHours(sessionStore);
  if (!ctxLimit) {
    await reply('No usage limit is currently configured — you have unlimited access.');
    return;
  }
  const usage = sessionStore.getCtxUsage(session.id, resetHours);
  const remaining = Math.max(0, ctxLimit - usage.charsUsed);
  const pct = Math.min(100, Math.round((usage.charsUsed / ctxLimit) * 100));
  const resetAt = new Date(new Date(usage.windowStartedAt + 'Z').getTime() + resetHours * 60 * 60 * 1000);
  const lines = [
    `📊 *Your usage*`,
    '',
    `Used: ${usage.charsUsed.toLocaleString()} / ${ctxLimit.toLocaleString()} characters (${pct}%)`,
    `Remaining: ${remaining.toLocaleString()}`,
    `Resets: ${resetAt.toLocaleString()} (every ${resetHours}h)`,
  ];
  if (usage.charsUsed >= ctxLimit) {
    lines.push('', "⚠️ You've used 100% of your free usage limit. I can still chat, but tools (files, commands, memory, etc.) are locked until the reset above.");
  }
  await reply(lines.join('\n'));
}

/**
 * /mykey <key> — sets the CALLING session's own personal API key. This
 * is deliberately a DIFFERENT command from admin's /setkey (which sets
 * the bot-wide SHARED key) — same word, opposite scope, would be
 * genuinely confusing if merged into one command name. Whether this key
 * actually gets USED depends on session.own_key_allowed (an admin
 * switch) — set here regardless of that switch's current value, so
 * flipping the switch on later doesn't require the user to re-enter
 * their key.
 */
export async function cmdMyKey(reply, session, rawKey) {
  if (!session) { await reply('Register first with /register <name>.'); return; }
  const key = String(rawKey || '').trim();
  if (!key) {
    if (session.own_api_key) {
      await reply(`Your key is set (••••••••). Own-key use is currently ${session.own_key_allowed ? 'allowed' : 'DISABLED by an admin'} for your session.\n\nUsage: /mykey <key> to change it, or /mykey clear to remove it.`);
    } else {
      await reply('Usage: /mykey <your-api-key>\n\nOnce set, you can also point it at a different provider with /myendpoint and /mymodel — useful if your key isn\'t for the same service this bot uses by default.');
    }
    return;
  }
  if (key.toLowerCase() === 'clear') {
    sessionStore.clearOwnApiKey(session.id);
    await reply('✅ Your key has been removed. You\'ll use the shared key (if allowed for your session) from now on.');
    return;
  }
  sessionStore.setOwnApiKey(session.id, key);
  await reply(
    session.own_key_allowed
      ? '✅ Your key is set and will be used for your messages from now on (••••••••). If it\'s for a different provider than the default, set /myendpoint and /mymodel too.'
      : "✅ Your key is saved (••••••••), but an admin has disabled own-key use for your session right now, so the shared key is used instead until that's turned back on.",
  );
}

/**
 * /myendpoint <url> — sets the CALLING session's own base URL, used
 * ONLY when their own key is the one actually in use (see
 * resolveApiBaseUrlForSession in runtimeConfig.js) — irrelevant, and
 * silently ignored, while they're on the shared key. Independent of
 * /mykey itself — a user can set this before or after setting a key.
 */
export async function cmdMyEndpoint(reply, session, rawUrl) {
  if (!session) { await reply('Register first with /register <name>.'); return; }
  const url = String(rawUrl || '').trim();
  if (!url) {
    await reply(session.own_base_url
      ? `Your endpoint is set to: ${session.own_base_url}\n\nUsage: /myendpoint <url> to change it, or /myendpoint clear to remove it (falls back to the shared endpoint).`
      : 'Usage: /myendpoint <url>\n\nOnly used while your own key (/mykey) is active — ignored otherwise.');
    return;
  }
  if (url.toLowerCase() === 'clear') {
    sessionStore.clearOwnBaseUrl(session.id);
    await reply('✅ Your endpoint override has been removed — falls back to the shared endpoint whenever your own key is active.');
    return;
  }
  sessionStore.setOwnBaseUrl(session.id, url.replace(/\/$/, ''));
  await reply(`✅ Your endpoint is set to ${url}. Only takes effect while your own key (/mykey) is active.`);
}

/**
 * /mymodel <model-id> — same shape and same "only while own key is
 * active" rule as /myendpoint.
 */
export async function cmdMyModel(reply, session, rawModel) {
  if (!session) { await reply('Register first with /register <name>.'); return; }
  const model = String(rawModel || '').trim();
  if (!model) {
    await reply(session.own_model
      ? `Your model is set to: ${session.own_model}\n\nUsage: /mymodel <model-id> to change it, or /mymodel clear to remove it (falls back to the shared model).`
      : 'Usage: /mymodel <model-id>\n\nOnly used while your own key (/mykey) is active — ignored otherwise.');
    return;
  }
  if (model.toLowerCase() === 'clear') {
    sessionStore.clearOwnModel(session.id);
    await reply('✅ Your model override has been removed — falls back to the shared model whenever your own key is active.');
    return;
  }
  sessionStore.setOwnModel(session.id, model);
  await reply(`✅ Your model is set to ${model}. Only takes effect while your own key (/mykey) is active.`);
}

// --- Admin key-permission commands ------------------------------------

function resolveKeyTarget(rawTarget) {
  const target = String(rawTarget || '').trim();
  if (!target) return { error: true };
  if (target.toLowerCase() === 'all') return { all: true };
  const session = sessionStore.getByName(target);
  if (!session) return { error: true, notFound: target };
  return { session };
}

export async function cmdAllowOwnKey(reply, isAuthorized, rawTarget) {
  if (!isAuthorized) { await reply('This command is not enabled for this chat.'); return; }
  const t = resolveKeyTarget(rawTarget);
  if (t.error) { await reply(t.notFound ? `❌ No registered session named "${t.notFound}".` : '❌ Usage: /allowownkey <name|all>'); return; }
  if (t.all) { sessionStore.setOwnKeyAllowedForAll(true); await reply('✅ Own-key use allowed for all sessions.'); return; }
  sessionStore.setOwnKeyAllowed(t.session.id, true);
  await reply(`✅ Own-key use allowed for "${t.session.registered_name}".`);
}

export async function cmdDisallowOwnKey(reply, isAuthorized, rawTarget) {
  if (!isAuthorized) { await reply('This command is not enabled for this chat.'); return; }
  const t = resolveKeyTarget(rawTarget);
  if (t.error) { await reply(t.notFound ? `❌ No registered session named "${t.notFound}".` : '❌ Usage: /disallowownkey <name|all>'); return; }
  if (t.all) { sessionStore.setOwnKeyAllowedForAll(false); await reply('🚫 Own-key use disallowed for all sessions — everyone falls back to the shared key (if allowed).'); return; }
  sessionStore.setOwnKeyAllowed(t.session.id, false);
  await reply(`🚫 Own-key use disallowed for "${t.session.registered_name}" — falls back to the shared key (if allowed).`);
}

export async function cmdAllowPublicKey(reply, isAuthorized, rawTarget) {
  if (!isAuthorized) { await reply('This command is not enabled for this chat.'); return; }
  const t = resolveKeyTarget(rawTarget);
  if (t.error) { await reply(t.notFound ? `❌ No registered session named "${t.notFound}".` : '❌ Usage: /allowpublickey <name|all>'); return; }
  if (t.all) { sessionStore.setPublicKeyAllowedForAll(true); await reply('✅ Shared/public key use allowed for all sessions.'); return; }
  sessionStore.setPublicKeyAllowed(t.session.id, true);
  await reply(`✅ Shared/public key use allowed for "${t.session.registered_name}".`);
}

export async function cmdDisallowPublicKey(reply, isAuthorized, rawTarget) {
  if (!isAuthorized) { await reply('This command is not enabled for this chat.'); return; }
  const t = resolveKeyTarget(rawTarget);
  if (t.error) { await reply(t.notFound ? `❌ No registered session named "${t.notFound}".` : '❌ Usage: /disallowpublickey <name|all>'); return; }
  if (t.all) {
    sessionStore.setPublicKeyAllowedForAll(false);
    await reply('🚫 Shared/public key use disallowed for all sessions — anyone without their own key (or with own-key also disallowed) can no longer make model calls at all.');
    return;
  }
  sessionStore.setPublicKeyAllowed(t.session.id, false);
  await reply(`🚫 Shared/public key use disallowed for "${t.session.registered_name}". If they also have no own key allowed, they can no longer make model calls at all.`);
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
    case 'sessions': await cmdSessions(reply, isAuthorized); return true;
    case 'ban': await cmdBan(reply, isAuthorized, args[0], actorId); return true;
    case 'unban': await cmdUnban(reply, isAuthorized, args[0]); return true;
    case 'allowownkey': await cmdAllowOwnKey(reply, isAuthorized, args[0]); return true;
    case 'disallowownkey': await cmdDisallowOwnKey(reply, isAuthorized, args[0]); return true;
    case 'allowpublickey': await cmdAllowPublicKey(reply, isAuthorized, args[0]); return true;
    case 'disallowpublickey': await cmdDisallowPublicKey(reply, isAuthorized, args[0]); return true;
    default: return false;
  }
}
