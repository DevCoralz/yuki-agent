import 'dotenv/config';
import { initializeTelegramBot, getBotInstance } from './workers/telegram.js';
import { sessionManager, setNotifier } from './workers/sessionManager.js';
import { sessionStore } from './storage/sessionStore.js';
import { getCtxResetHours } from './config/adminConfig.js';

// Real, activity-independent reset sweep — runs on a timer, not just
// lazily on a session's own next message. Without this, a session that
// goes quiet would sit at its last usage number forever (nothing
// re-checks it), which does not satisfy "reset every six hours even
// when not used". Runs every 15 minutes — frequent enough that no
// window sits expired for long, cheap enough (a handful of SQLite rows)
// that this isn't worth a more complex scheduler.
const CTX_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
function startCtxResetSweep() {
  setInterval(() => {
    try {
      const resetHours = getCtxResetHours(sessionStore);
      const count = sessionStore.forceResetExpiredCtxWindows(resetHours);
      if (count > 0) console.log(`[ctx-sweep] Force-reset ${count} expired context window(s).`);
    } catch (error) {
      console.error('[ctx-sweep]', error?.message || error);
    }
  }, CTX_SWEEP_INTERVAL_MS).unref();
}

async function main() {
  await sessionManager.init();
  await sessionStore.init();
  initializeTelegramBot();
  setNotifier(getBotInstance());
  await sessionManager.restoreSessions();
  startCtxResetSweep();
  console.log('Telegram pairing service online — SINGLE WHATSAPP SESSION ONLY.');
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
main().catch(error => { console.error(error); process.exit(1); });
