import { environment } from '../config/environment.js';
import { sessionManager } from '../workers/sessionManager.js';
import { formatPairingCode, validatePhoneNumber } from '../utils/phone.js';

function authorized(chatId) {
  return environment.telegramAuthorizedChatIds.length === 0 || environment.telegramAuthorizedChatIds.includes(Number(chatId));
}

function nav() {
  return { inline_keyboard: [[{ text: '⚡ Pair WhatsApp', callback_data: 'pair_device' }]] };
}

async function disconnectSession(bot, msg) {
  const chatId = msg.chat.id;
  if (!authorized(chatId)) {
    await bot.sendMessage(chatId, 'Pairing is not enabled for this Telegram chat.');
    return;
  }

  if (!sessionManager.hasAnyConfiguredSession() && !sessionManager.session) {
    await bot.sendMessage(chatId, 'No WhatsApp session to disconnect.');
    return;
  }

  const existing = sessionManager.getPairedPhone();
  await sessionManager.removeSession(true);
  await bot.sendMessage(
    chatId,
    existing
      ? `🔌 Disconnected +${existing}. Use /connect to pair again.`
      : '🔌 Session cleared. Use /connect to pair again.',
  );
}

async function beginPairing(bot, msg, rawNumber) {
  const chatId = msg.chat.id;
  if (!authorized(chatId)) {
    await bot.sendMessage(chatId, 'Pairing is not enabled for this Telegram chat.');
    return;
  }

  const { valid, phone, reason } = validatePhoneNumber(rawNumber);
  if (!valid) {
    await bot.sendMessage(chatId, `❌ Invalid number. ${reason}\n\nExample: /connect 2348012345678`);
    return;
  }

  if (sessionManager.hasAnyConfiguredSession()) {
    const existing = sessionManager.getPairedPhone();
    await bot.sendMessage(chatId, existing ? `❌ Only one WhatsApp number can be paired. Current number: +${existing}.` : '❌ A WhatsApp number is already paired. Only one number is allowed.');
    return;
  }

  const wait = await bot.sendMessage(chatId, `⏳ Starting WhatsApp pairing for +${phone}…`);
  const result = await sessionManager.createSession(phone, chatId);

  if (!result.success) {
    await bot.editMessageText(`❌ Pairing failed: ${result.message}`, { chat_id: chatId, message_id: wait.message_id });
    return;
  }

  if (!result.pairingCode) {
    await bot.editMessageText(`✅ WhatsApp session started for +${phone}.`, { chat_id: chatId, message_id: wait.message_id });
    return;
  }

  await bot.editMessageText(
    `🔑 *WhatsApp pairing code*\n\n\`${formatPairingCode(result.pairingCode)}\`\n\nOpen WhatsApp → Linked Devices → Link a device → Enter code.`,
    { chat_id: chatId, message_id: wait.message_id, parse_mode: 'Markdown', reply_markup: nav() },
  );
}

export async function handleTelegramMessage(bot, msg, callbackQueryId = null) {
  const chatId = msg.chat.id;
  if (callbackQueryId) {
    await bot.answerCallbackQuery(callbackQueryId).catch(() => {});
  }

  const text = String(msg.text || '').trim();
  if (text === 'pair_device') {
    await bot.sendMessage(chatId, '📱 Send your WhatsApp number with country code:\n\n/connect 234xxxxxxxxx');
    return;
  }

  if (!text.startsWith('/')) return;
  const [command, ...args] = text.split(/\s+/);
  const name = command.slice(1).toLowerCase();

  if (name === 'start' || name === 'pair') {
    await bot.sendMessage(chatId, '⚡ *WhatsApp Pairing*\n\n/connect 234xxxxxxxxx', { parse_mode: 'Markdown', reply_markup: nav() });
    return;
  }

  if (name === 'connect') {
    await beginPairing(bot, msg, args[0]);
    return;
  }

  if (name === 'disconnect') {
    await disconnectSession(bot, msg);
  }
}

export function handleTelegramError(error) {
  console.error('[Telegram]', error?.message || error);
}
