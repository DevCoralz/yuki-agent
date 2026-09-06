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

/**
 * Downloads the media attached to `quotedMsg` (the message the user sent,
 * or the message they replied to) into the session workspace so tools
 * like ffmpeg can operate on it via the terminal.
 */
export async function saveIncomingMedia(workspace, waMessage, fileName) {
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

  await fs.mkdir(workspace, { recursive: true });
  const ext = (media.mimetype || '').split('/')[1]?.split(';')[0] || 'bin';
  const safeName = fileName ? path.basename(fileName) : `incoming-${Date.now()}.${ext}`;
  const outPath = safePath(workspace, safeName);
  await fs.writeFile(outPath, buffer);

  return { path: outPath, fileName: safeName, mimetype: media.mimetype || 'application/octet-stream', bytes: buffer.length };
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
 * files it (or the user) actually put there.
 */
export async function sendWorkspaceFile(sock, jid, workspace, relPath, caption) {
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
