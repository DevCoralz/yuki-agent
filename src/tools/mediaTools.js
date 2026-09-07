import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { safePath } from './workspace.js';

const DOWNLOAD_TYPE_BY_MESSAGE = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
};

async function writeBufferToWorkspace(workspace, buffer, fileName, fallbackExt, mimetype) {
  await fs.mkdir(workspace, { recursive: true });
  const ext = fallbackExt || (mimetype || '').split('/')[1]?.split(';')[0] || 'bin';
  const safeName = fileName ? path.basename(fileName) : `incoming-${Date.now()}.${ext}`;
  const outPath = safePath(workspace, safeName);
  await fs.writeFile(outPath, buffer);
  return { path: outPath, fileName: safeName, mimetype: mimetype || 'application/octet-stream', bytes: buffer.length };
}

/** True if this WhatsApp message carries downloadable media directly (not counting a quoted/replied-to message — that's handled separately by saveIncomingMediaWhatsApp when the user is clearly referring to it). */
export function whatsappMessageHasMedia(waMessage) {
  const direct = waMessage?.message;
  return !!(direct && Object.keys(DOWNLOAD_TYPE_BY_MESSAGE).some(k => direct[k]));
}

/**
 * Downloads the media attached to `quotedMsg` (the message the user sent,
 * or the message they replied to) into the session workspace so tools
 * like ffmpeg can operate on it via the terminal. WhatsApp/Baileys path.
 */
export async function saveIncomingMediaWhatsApp(workspace, waMessage, fileName) {
  // Check the message itself first, then whatever it quoted/replied to —
  // covers "here's a file" and "compress *this*" (replying to an earlier
  // media message) equally.
  const direct = waMessage?.message;
  const quoted = waMessage?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  const messageContent = (direct && Object.keys(DOWNLOAD_TYPE_BY_MESSAGE).some(k => direct[k])) ? direct : quoted;
  if (!messageContent) throw new Error('No message content to download from.');

  const typeKey = Object.keys(DOWNLOAD_TYPE_BY_MESSAGE).find(k => messageContent[k]);
  if (!typeKey) throw new Error('The referenced message has no downloadable media.');

  const media = messageContent[typeKey];
  const downloadType = DOWNLOAD_TYPE_BY_MESSAGE[typeKey];
  const stream = await downloadContentFromMessage(media, downloadType);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);

  return writeBufferToWorkspace(workspace, buffer, fileName, null, media.mimetype);
}

// Telegram message fields that carry downloadable media, in priority
// order — photo is an array of sizes (Telegram re-encodes/resizes into
// several), so the LARGEST (last element) is what we want for real
// analysis. Everything else is a single file_id.
function extractTelegramFileRef(msg) {
  if (!msg) return null;
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1];
    return { file_id: largest.file_id, kind: 'photo', mimetype: 'image/jpeg' };
  }
  if (msg.document) return { file_id: msg.document.file_id, kind: 'document', mimetype: msg.document.mime_type, name: msg.document.file_name };
  if (msg.video) return { file_id: msg.video.file_id, kind: 'video', mimetype: msg.video.mime_type || 'video/mp4' };
  if (msg.video_note) return { file_id: msg.video_note.file_id, kind: 'video_note', mimetype: 'video/mp4' };
  if (msg.voice) return { file_id: msg.voice.file_id, kind: 'voice', mimetype: msg.voice.mime_type || 'audio/ogg' };
  if (msg.audio) return { file_id: msg.audio.file_id, kind: 'audio', mimetype: msg.audio.mime_type, name: msg.audio.file_name };
  if (msg.sticker) return { file_id: msg.sticker.file_id, kind: 'sticker', mimetype: msg.sticker.is_animated ? 'application/x-tgsticker' : 'image/webp' };
  return null;
}

/** True if this Telegram message (or its reply-to) carries downloadable media. */
export function telegramMessageHasMedia(msg) {
  return !!(extractTelegramFileRef(msg) || extractTelegramFileRef(msg?.reply_to_message));
}

/**
 * Downloads the media attached to a Telegram message (or the message it
 * replied to) into the session workspace — mirrors saveIncomingMediaWhatsApp
 * but via the Telegram Bot API's file endpoint (bot.getFileLink +
 * a direct fetch, since node-telegram-bot-api's own downloadFile writes
 * to a temp dir under its own naming, and we want it straight into the
 * session workspace with our own safe naming).
 */
export async function saveIncomingMediaTelegram(bot, workspace, tgMessage, fileName) {
  const ref = extractTelegramFileRef(tgMessage) || extractTelegramFileRef(tgMessage?.reply_to_message);
  if (!ref) throw new Error('No message content to download from.');

  const fileLink = await bot.getFileLink(ref.file_id);
  const response = await fetch(fileLink);
  if (!response.ok) throw new Error(`Telegram file download failed (${response.status}).`);
  const buffer = Buffer.from(await response.arrayBuffer());

  const ext = ref.name ? path.extname(ref.name).slice(1) : (ref.mimetype || '').split('/')[1]?.split(';')[0];
  return writeBufferToWorkspace(workspace, buffer, fileName || ref.name, ext || 'bin', ref.mimetype);
}

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain', json: 'application/json',
};

function guessMime(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/**
 * Sends a file from the session workspace back to the chat. Path is
 * validated to be inside the workspace so the model can only ever send
 * files it (or the user) actually put there. WhatsApp/Baileys path.
 */
export async function sendWorkspaceFileWhatsApp(sock, jid, workspace, relPath, caption) {
  const filePath = safePath(workspace, relPath, { mustExist: true });
  const fileName = path.basename(filePath);
  const mimetype = guessMime(filePath);

  if (mimetype.startsWith('image/')) {
    await sock.sendMessage(jid, { image: { stream: createReadStream(filePath) }, caption: caption || fileName });
  } else if (mimetype.startsWith('video/')) {
    await sock.sendMessage(jid, { video: { stream: createReadStream(filePath) }, caption: caption || fileName });
  } else if (mimetype.startsWith('audio/')) {
    await sock.sendMessage(jid, { audio: { stream: createReadStream(filePath) }, mimetype, ptt: false });
  } else {
    await sock.sendMessage(jid, { document: { stream: createReadStream(filePath) }, fileName, mimetype, caption: caption || '' });
  }

  return { sent: true, fileName, mimetype };
}

/**
 * Sends a file from the session workspace back to a Telegram chat.
 * Mirrors sendWorkspaceFileWhatsApp — picks the right Telegram send
 * method (photo/video/voice/document) based on the file's mimetype.
 */
export async function sendWorkspaceFileTelegram(bot, chatId, workspace, relPath, caption) {
  const filePath = safePath(workspace, relPath, { mustExist: true });
  const fileName = path.basename(filePath);
  const mimetype = guessMime(filePath);
  const opts = caption ? { caption } : {};

  if (mimetype.startsWith('image/')) {
    await bot.sendPhoto(chatId, filePath, opts);
  } else if (mimetype.startsWith('video/')) {
    await bot.sendVideo(chatId, filePath, opts);
  } else if (mimetype.startsWith('audio/')) {
    await bot.sendVoice(chatId, filePath, opts);
  } else {
    await bot.sendDocument(chatId, filePath, opts);
  }

  return { sent: true, fileName, mimetype };
}
