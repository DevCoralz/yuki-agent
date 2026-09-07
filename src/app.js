import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { initializeTelegramBot, getBotInstance } from './workers/telegram.js';
import { sessionManager, setNotifier } from './workers/sessionManager.js';
import { sessionStore } from './storage/sessionStore.js';
import { getCtxResetHours } from './config/adminConfig.js';

// Startup guard: verify the persistent volume is mounted
async function checkVolume() {
  const dataDir = process.env.YUKI_WORKSPACE_ROOT || '/data/sessions';
  try {
    await fs.access(path.dirname(dataDir));
    console.log(`[guard] Volume mounted OK at ${path.dirname(dataDir)}`);
  } catch {
    console.error(`\n[guard] FATAL: Persistent volume not mounted at ${path.dirname(dataDir)}`);
    console.error('[guard] Data will be lost on every restart!');
    console.error('[guard] Create the Fly volume first:');
    console.error('[guard]   fly volumes create session_data --size 3 --region iad');
    console.error('[guard] Then redeploy: fly deploy\n');
    // Don't exit — allow startup so the user can still see the error in logs
  }
}
checkVolume().catch(() => {});


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
