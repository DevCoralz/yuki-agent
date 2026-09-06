import 'dotenv/config';
import { initializeTelegramBot, getBotInstance } from './workers/telegram.js';
import { sessionManager, setNotifier } from './workers/sessionManager.js';
import { sessionStore } from './storage/sessionStore.js';

async function main() {
  await sessionManager.init();
  await sessionStore.init();
  initializeTelegramBot();
  setNotifier(getBotInstance());
  await sessionManager.restoreSessions();
  console.log('Telegram pairing service online — SINGLE WHATSAPP SESSION ONLY.');
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
main().catch(error => { console.error(error); process.exit(1); });
