import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.SESSION_DATA_PATH = path.join(os.tmpdir(), 'yuki-smoke-session');
process.env.YUKI_WORKSPACE_ROOT = await mkdtemp(path.join(os.tmpdir(), 'yuki-smoke-'));
process.env.TELEGRAM_BOT_TOKEN = 'smoke';
process.env.YUKI_API_BASE_URL = 'https://example.test/v1/chat/completions';
process.env.YUKI_API_MODEL = 'smoke-model';
process.env.YUKI_API_KEY = 'smoke-key';
process.env.YUKI_SYSTEM_PROMPT = 'smoke';
process.env.YUKI_AUTHORIZED_CHAT_IDS = '';

const required = [
  'src/app.js','src/workers/telegram.js','src/workers/whatsapp.js','src/workers/sessionManager.js',
  'src/middleware/telegramHandler.js','src/config/config.js','src/config/environment.js','src/utils/phone.js',
  'src/storage/sessionStore.js','src/ai/yuki.js','src/tools/agentTools.js','src/tools/terminal.js'
];
for (const file of required) await fs.access(file);
for (const file of required) {
  const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  if(r.status!==0) throw new Error(`${file}: ${r.stderr}`);
}
const pkg=JSON.parse(await fs.readFile('package.json','utf8'));
const forbidden=['playwright','sharp','tesseract.js','cheerio','pdf-lib','ffmpeg-static','@modelcontextprotocol/client','@modelcontextprotocol/server'];
for(const name of forbidden) if(pkg.dependencies?.[name]||pkg.devDependencies?.[name]) throw new Error(`Forbidden dependency remains: ${name}`);
const { SessionStore, detectChat }=await import('../src/storage/sessionStore.js');
const store=new SessionStore(); await store.init();
if(detectChat('123@s.whatsapp.net')!=='dm') throw new Error('DM detection failed');
if(detectChat('123@g.us')!=='group') throw new Error('Group detection failed');
let r=await store.register('111@s.whatsapp.net','dm','coralz');
if(!r.ok) throw new Error('DM registration failed');
for(const p of [r.session.workspace_path,r.session.memory_db_path,r.session.chat_json_path]) if(!(await fs.stat(p)).isFile && !(await fs.stat(p)).isDirectory) throw new Error('Session artifact missing');
store.recordMemory(r.session,'user','hello','111@s.whatsapp.net','Coralz');
await store.appendChat(r.session,{role:'user',content:'hello',senderJid:'111@s.whatsapp.net',senderName:'Coralz'});
store.saveFact(r.session,'user_name','Coralz');
if(store.getFacts(r.session)[0].value!=='Coralz') throw new Error('Memory fact failed');
if((await store.getChatMessages(r.session)).length!==1) throw new Error('chat.json failed');
r=await store.register('222@s.whatsapp.net','dm','coralz'); if(r.code!=='name_taken') throw new Error('Name collision failed');
r=await store.register('111@s.whatsapp.net','dm','another'); if(r.code!=='already_registered') throw new Error('Duplicate DM registration failed');
r=await store.register('333@g.us','group','group-one'); if(!r.ok) throw new Error('Group registration failed');
store.recordParticipant(r.session.id,'u1@s.whatsapp.net','Alice'); store.recordParticipant(r.session.id,'u2@s.whatsapp.net','Bob');
store.recordMemory(r.session,'user','hello','u1@s.whatsapp.net','Alice'); store.recordMemory(r.session,'user','hi','u2@s.whatsapp.net','Bob');
console.log('SMOKE PASS: single pairing + per-chat session + chat.json + user sqlite memory + workspace + DM/group participant tracking + env-driven AI config.');
