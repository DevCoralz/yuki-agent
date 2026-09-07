// Resolves the three model-connection settings (API base URL, key, model)
// with runtime overrides taking priority over their .env defaults. The
// override is set via an admin-password-gated command (see adminConfig.js)
// and persists in registry.sqlite's runtime_config table — NEVER written
// back into .env itself, since rewriting a live process's own env file is
// a much riskier operation (partial writes, format corruption, races)
// than reading an extra DB row on each request.
//
// This is read fresh on every call, not cached — an admin changing the
// model mid-session should take effect on the very next message, not
// require a restart.

import { environment } from '../config/environment.js';

const KEYS = {
  base: 'yuki_api_base_url',
  key: 'yuki_api_key',
  model: 'yuki_api_model',
};

export function resolveApiBaseUrl(sessionStore) {
  return sessionStore.getRuntimeConfig(KEYS.base) || environment.yukiApiBaseUrl;
}

export function resolveApiKey(sessionStore) {
  return sessionStore.getRuntimeConfig(KEYS.key) || environment.yukiApiKey;
}

/**
 * Resolves which API key a SPECIFIC session should use, given the two
 * independent admin-controlled switches (session.own_key_allowed,
 * session.public_key_allowed) and whether that session has set its own
 * key at all (session.own_api_key).
 *
 * Decision order:
 *   1. Own key set AND own_key_allowed -> use the session's own key.
 *   2. public_key_allowed -> fall back to the shared/global key
 *      (resolveApiKey above — the bot's own .env/admin-set key).
 *   3. Neither usable -> return null. The caller (yuki.js) must treat a
 *      null key as "this session cannot make model calls right now" and
 *      say so plainly, not silently send an empty/undefined Authorization
 *      header to the model server.
 *
 * Admin sessions bypass all of this entirely (checked by the caller via
 * isAdminSession before ever reaching this function) — this only
 * applies to ordinary registered sessions.
 */
export function resolveApiKeyForSession(sessionStore, session) {
  if (session?.own_api_key && session?.own_key_allowed) {
    return { key: session.own_api_key, source: 'own' };
  }
  if (session?.public_key_allowed) {
    return { key: resolveApiKey(sessionStore), source: 'public' };
  }
  return { key: null, source: 'none' };
}

export function resolveApiModel(sessionStore) {
  return sessionStore.getRuntimeConfig(KEYS.model) || environment.yukiApiModel;
}

/**
 * Resolves base URL + model for a SPECIFIC session, deliberately tied
 * to the SAME key-source decision resolveApiKeyForSession made — not
 * resolved independently. Sending a user's own key to the shared bot's
 * base URL (or vice versa: the shared key to a user's own endpoint)
 * would silently fail or, worse, send credentials to the wrong
 * provider. So: when the resolved key source is 'own', own_base_url/
 * own_model are used if the user set them (falling back to the shared
 * ones only if they didn't bother setting their own endpoint, which is
 * a reasonable default for someone just swapping in their own key on
 * the SAME provider). When the key source is 'public' or 'none', the
 * user's own base_url/model are irrelevant and never used.
 */
export function resolveApiBaseUrlForSession(sessionStore, session, keySource) {
  if (keySource === 'own' && session?.own_base_url) return session.own_base_url;
  return resolveApiBaseUrl(sessionStore);
}

export function resolveApiModelForSession(sessionStore, session, keySource) {
  if (keySource === 'own' && session?.own_model) return session.own_model;
  return resolveApiModel(sessionStore);
}

export const RUNTIME_CONFIG_KEYS = KEYS;
