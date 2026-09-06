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

export function resolveApiModel(sessionStore) {
  return sessionStore.getRuntimeConfig(KEYS.model) || environment.yukiApiModel;
}

export const RUNTIME_CONFIG_KEYS = KEYS;
