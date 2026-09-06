import 'dotenv/config';
import { initializeTelegramBot } from './workers/telegram.js';
import { sessionManager } from './workers/sessionManager.js';
import { sessionStore } from './storage/sessionStore.js';

async function main() {
  await sessionManager.init();
  await sessionStore.init();
  initializeTelegramBot();
  await sessionManager.restoreSessions();
  console.log('Telegram pairing service online — SINGLE WHATSAPP SESSION ONLY.');
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
main().catch(error => { console.error(error); process.exit(1); });
