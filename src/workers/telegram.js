import TelegramBot from 'node-telegram-bot-api';
import { environment } from '../config/environment.js';
import { handleTelegramMessage, handleTelegramError } from '../middleware/telegramHandler.js';

let bot;

export function initializeTelegramBot() {
  if (!environment.telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN is required.');
  bot = new TelegramBot(environment.telegramBotToken, { polling: true });
  bot.on('error', handleTelegramError);
  bot.on('polling_error', handleTelegramError);
  bot.on('message', msg => handleTelegramMessage(bot, msg).catch(handleTelegramError));
  bot.on('callback_query', query => {
    const msg = query.message;
    if (!msg) return;
    msg.from = query.from;
    msg.text = query.data;
    handleTelegramMessage(bot, msg, query.id).catch(handleTelegramError);
  });
  return bot;
}
