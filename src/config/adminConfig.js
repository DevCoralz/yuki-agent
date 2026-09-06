// Bot-wide settings controllable live via Telegram commands (/adminonly,
// /everyone, /setctx, /ctxreset, /resetmodel, /setendpoint, /setmodel,
// /setkey) — everything here persists in registry.sqlite's runtime_config
// table (same table set_model_config already uses), which lives on the
// mounted Fly volume. That means every setting below survives a bot
// restart AND a full redeploy without needing to be re-set — nothing
// here is read from process.env at request time, .env/Fly secrets are
// only the very first boot's fallback default.
//
// Deliberately NOT AI tool calls (unlike set_model_config/get_model_config
// in agentTools.js, which remain available for conversational use) —
// these are Telegram-only commands. Telegram is a fully separate code
// path from the WhatsApp/model-call flow, so /resetmodel etc. keep
// working even if the model endpoint is completely dead — the exact gap
// that made a bad set_model_config call potentially unrecoverable before.

import { environment } from './environment.js';

const KEYS = {
  accessMode: 'yuki_access_mode', // 'everyone' | 'adminonly'
  ctxLimit: 'yuki_ctx_limit_chars', // per-user quota, in characters (chars/4 ~= tokens, matching the existing chars/4 token estimate used elsewhere in this codebase)
  ctxResetHours: 'yuki_ctx_reset_hours', // rolling window length, in hours
};

export function isAdminSession(session) {
  const name = String(session?.registered_name || '').toLowerCase();
  return environment.adminSessions.includes(name);
}

export function getAccessMode(sessionStore) {
  return sessionStore.getRuntimeConfig(KEYS.accessMode) || 'everyone';
}

export function setAccessMode(sessionStore, mode, updatedByJid) {
  sessionStore.setRuntimeConfig(KEYS.accessMode, mode, updatedByJid);
}

export function getCtxLimitChars(sessionStore) {
  const raw = sessionStore.getRuntimeConfig(KEYS.ctxLimit);
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null; // null = no quota configured, i.e. unlimited
}

export function setCtxLimitChars(sessionStore, chars, updatedByJid) {
  sessionStore.setRuntimeConfig(KEYS.ctxLimit, String(chars), updatedByJid);
}

export function getCtxResetHours(sessionStore) {
  const raw = sessionStore.getRuntimeConfig(KEYS.ctxResetHours);
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 4; // default: 4-hour rolling window, matching the existing chat-quota pattern from an earlier build in this lineage
}

export function setCtxResetHours(sessionStore, hours, updatedByJid) {
  sessionStore.setRuntimeConfig(KEYS.ctxResetHours, String(hours), updatedByJid);
}

export const ADMIN_CONFIG_KEYS = KEYS;
