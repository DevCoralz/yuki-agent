const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

export const config = {
  nodeEnv: process.env.NODE_ENV || 'production',
  commandPrefix: process.env.WHATSAPP_COMMAND_PREFIX || '/',
  sessionDataPath: required('SESSION_DATA_PATH'),
  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
  telegramAuthorizedChatIds: (process.env.YUKI_AUTHORIZED_CHAT_IDS || '').split(',').map(v => v.trim()).filter(Boolean).map(Number),
  yukiApiBaseUrl: required('YUKI_API_BASE_URL').replace(/\/$/, ''),
  yukiApiModel: required('YUKI_API_MODEL'),
  yukiApiKey: required('YUKI_API_KEY'),
  yukiWorkspaceRoot: required('YUKI_WORKSPACE_ROOT'),
  yukiSystemPrompt: required('YUKI_SYSTEM_PROMPT'),
  yukiMaxToolRounds: Number.parseInt(process.env.YUKI_MAX_TOOL_ROUNDS || '12', 10),
  yukiHistoryMessages: Number.parseInt(process.env.YUKI_HISTORY_MESSAGES || '12', 10),
  // Optional. e.g. 'low' | 'medium' | 'high' — only sent to the model if set,
  // and only understood by reasoning-effort-compatible endpoints.
  yukiReasoningEffort: process.env.YUKI_REASONING_EFFORT || '',
  // Paths the file/terminal tools may never read or write, even if a
  // session workspace were ever misconfigured to point somewhere unsafe.
  // This is a backstop, not the primary defense — the primary defense is
  // every session's workspace_path already being its own subfolder under
  // YUKI_WORKSPACE_ROOT (see sessionStore.js). Ported from an equivalent
  // safeguard in a prior agent build; same real risk applies here since
  // this also runs on Pterodactyl (or similar shared panel hosting).
  yukiProtectedPaths: (process.env.YUKI_PROTECTED_PATHS || '/etc,/root/.ssh,/proc,/sys,/var/lib/pterodactyl,/home/container')
    .split(',').map(v => v.trim()).filter(Boolean),
  // Read-tool size ceiling in bytes — prevents a single huge file (a log,
  // a media file mistakenly in the workspace) from blowing the context
  // window or hanging a read. Default 512KB.
  yukiMaxFileBytes: Number.parseInt(process.env.YUKI_MAX_FILE_BYTES || '512000', 10),
  // Gates the set_model_config tool — changing the live API base/key/model
  // requires BOTH the session being registered as "coralz" or "yuki" AND
  // this password in the command itself. Registering under that name
  // alone is not the security boundary; this is. Optional on purpose (if
  // unset, the admin tool refuses entirely rather than silently allowing
  // anyone through) — set a real value in .env to actually enable it.
  yukiAdminPassword: process.env.YUKI_ADMIN_PASSWORD || '',
};
