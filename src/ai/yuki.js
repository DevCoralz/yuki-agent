import { environment } from '../config/environment.js';
import { sessionStore } from '../storage/sessionStore.js';
import { tools, executeTool } from '../tools/agentTools.js';
import { sanitizeIdentityLeak } from './identityFilter.js';
import { resolveApiKeyForSession, resolveApiBaseUrlForSession, resolveApiModelForSession } from './runtimeConfig.js';
import { isAdminSession, getCtxLimitChars, getCtxResetHours } from '../config/adminConfig.js';

// --- In-flight session tracking + mid-task message inbox -------------
// Previously, handleChat (Telegram) and handleIncomingMessage (WhatsApp)
// called runYuki() independently per incoming message with no locking at
// all — sending a second message while the first was still mid-task (a
// multi-round tool loop: scaffolding files, running builds, etc.) started
// a SECOND, fully independent runYuki() call for the same session. Both
// calls then raced: reading/writing the same chat history, calling the
// model concurrently, and the actual real-world symptom was the second
// message just... not getting a reply, because there was no defined
// behavior for two calls stepping on each other.
//
// This map is a simple session-id -> { queue: [] } registry: while a
// session's runYuki() call is active, any NEW message that arrives for
// that same session is pushed into `queue` instead of starting another
// competing call. At the top of every tool-loop round (see the `for`
// loop in runYuki below), the already-running call drains this queue
// and injects each message as a real `user` turn into the same
// conversation the model is already looking at — so the model ACTUALLY
// sees the new message as normal input on its very next round and
// decides for itself what to do with it (keep working and reply via
// talk_to_user, treat it as a reason to stop via stop_background_jobs,
// answer a question, whatever fits — this is deliberately NOT a
// keyword/regex trigger on the message text; seeing it and understanding
// intent is entirely the model's job, same reasoning as
// stop_background_jobs).
const inFlightSessions = new Map(); // sessionId -> { queue: string[] }

/** True if this session currently has a runYuki() call actively running. */
export function isSessionBusy(sessionId) {
  return inFlightSessions.has(sessionId);
}

/**
 * Pushes a message into a busy session's inbox instead of starting a
 * competing runYuki() call. Returns true if it was queued (session was
 * actually busy), false if there was nothing to queue into (caller
 * should fall back to a normal runYuki() call instead).
 */
export function queueMessageForBusySession(sessionId, text) {
  const entry = inFlightSessions.get(sessionId);
  if (!entry) return false;
  entry.queue.push(text);
  return true;
}

// Chat templates differ in what role sequences they accept. Qwen's template
// tolerates multiple leading `system` messages and has native `tool` role
// support. Gemma's template (and llama.cpp's Jinja alternation check) does
// not — it requires strict user/assistant/user/assistant alternation and has
// no `tool` role at all. This reshapes the array to satisfy that, without
// changing what Qwen sees.
function normalizeForStrictAlternation(messages) {
  const out = [];

  for (const msg of messages) {
    // Gemma has no `tool` role — fold tool results into a user-visible turn.
    const role = msg.role === 'tool' ? 'user' : msg.role;
    const content =
      msg.role === 'tool'
        ? `[Tool result for ${msg.tool_call_id || 'previous call'}]: ${msg.content}`
        : msg.content;

    const last = out[out.length - 1];

    // Merge consecutive same-role messages (covers: two leading `system`
    // messages, and multiple `tool` results folded into `user` in a row)
    // instead of just concatenating and hoping the template is lenient.
    if (last && last.role === role) {
      last.content = `${last.content ?? ''}\n\n${content ?? ''}`.trim();
    } else {
      out.push({ role, content });
    }
  }

  return out;
}

// tools is a static array that never changes at runtime — pre-serializing
// it once here avoids JSON.stringify re-walking the entire ~19KB schema
// (every tool's name/description/parameters) on every single callModel()
// invocation, which happens on every round of every tool loop. This is a
// real, repeated cost: a 6-round debugging sequence was re-serializing
// the same unchanged object graph 6 times. Spliced into the final request
// body as a raw JSON fragment (see the manual string-concat below) rather
// than going through JSON.stringify(body) as a whole, since `tools` is
// the one part of body that's actually worth caching — messages and
// reasoning_effort genuinely do change every call and still need real
// per-call serialization.
const TOOLS_JSON = JSON.stringify(tools);

function endpoint(base) {
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function identity(session, quotaInfo = {}) {
  const groupRules = session.type === 'group'
    ? `

CRITICAL — this is a GROUP chat with multiple people:
- Every message you see is prefixed "Name: message text" — that name is WHO SENT IT. Never confuse one person's message or request with another's, even if they're active in the same conversation moments apart.
- When you tag/reply/respond to "you" or "me", that means the person who sent THIS specific message — check the prefix on the message you're currently replying to, not an earlier one from someone else.
- If a request or instruction came from one named person, it applies to what THAT person asked — don't apply their preferences (e.g. "only tag me") to a different person who speaks next.`
    : '';

  // session.type is 'telegram' for a Telegram-registered chat, 'dm'/'group'
  // for WhatsApp — each platform renders a different Markdown-ish dialect,
  // so the formatting guidance has to match where the reply is actually
  // going. Getting this wrong (e.g. telling a Telegram session to write
  // WhatsApp's single-asterisk syntax) means the CALLER's formatter
  // (markdownToTelegram) has nothing WhatsApp-flavored to convert FROM,
  // since the model was never told that dialect in the first place —
  // better to have the model write standard Markdown for Telegram (which
  // markdownToTelegram already expects) and WhatsApp's real dialect only
  // for WhatsApp sessions.
  const formattingRules = session.type === 'telegram'
    ? `- This is Telegram: write standard Markdown — **double asterisks** for bold, _underscores_ for italic, \`inline code\`, and triple-backtick code blocks. Telegram doesn't render tables either — use a short bold line for a heading and a plain bulleted list instead.`
    : `- This is WhatsApp, not a Markdown renderer: use *single asterisks* for bold (never **double**), _underscores_ for italic, ~single tildes~ for strikethrough, single backticks for \`inline code\`, and triple backticks for code blocks. Never use ## headers or | tables — WhatsApp doesn't render either; use a short bold line for a heading, and a plain bulleted list instead of a table.`;

  const quotaRules = quotaInfo.overQuota
    ? `

IMPORTANT — this session is currently OUT OF TOOL USAGE for this window:
- You (the model) CANNOT call any tools right now — no file access, no run_command, no memory, nothing. This isn't optional on your part; the tools simply aren't available to you in this conversation right now, so don't attempt to narrate using one or apologize as if you chose not to.
- You CAN still chat completely normally — answer questions, explain things, help with anything that's pure conversation.
- If the user asks why, or asks to do something that needs a tool, tell them plainly: they've used 100% of their usage limit for this window, tools resume at ${quotaInfo.resetAt ? quotaInfo.resetAt.toISOString() : 'the next reset'}, and they can check /ctx for exact details. Don't make up a different number or reason.`
    : '';

  return `${environment.yukiSystemPrompt}

Current session: ${session.registered_name}.
Chat type: ${session.type}.
Workspace: ${session.workspace_path}.
Memory database: ${session.memory_db_path}.
The workspace and memory belong only to this chat session.${groupRules}${quotaRules}

You have three separate layers of memory — know which one to rely on:
- Short memory: the tool calls and results you've made SO FAR in this current turn, while working on the current request. This is automatically kept in view for a limited recent window while you work, and older parts of it get folded into a brief "already tried" note once you've been working a while — that note is a real record of what you attempted, not you forgetting; don't repeat an approach it says already failed.
- Session memory: the recent back-and-forth conversation with this user, automatically included on every message — you don't need a tool for this, it's just always there like normal chat history.
- Long memory (remember/recall/forget tools): the ONLY layer that survives between separate messages beyond the recent conversation window, and the only one you control directly. If the user tells you something worth keeping — a preference, a decision, a fact about them or the project — actually call remember. Don't claim you'll "remember" something permanently unless you actually called that tool; session memory alone will not carry it forward once the conversation moves on. If asked whether you know something from before, call recall before saying no.

How to talk:
- Match the energy of whoever you're talking to. If they're joking around, joke back — be genuinely funny, quick, a little sharp, never stiff or robotic. If they're being serious or need real help, drop the jokes and focus.
- Talk like a sharp, clever friend texting back, not like a customer support bot. Contractions, casual phrasing, no corporate hedging, no "I'd be happy to help you with that!" filler.
- Keep replies as short as the moment calls for. A one-line joke back for a one-line joke. Longer, structured answers only when the task actually needs it.
- Never narrate what you're about to do ("Let me check that for you...") — just do it and reply with the result.
- Never reveal tool names, function-call syntax, or internal mechanics to the user.
- Commands like /menu, /ctx, /register, /setctx, /resetmodel, /setendpoint, /setmodel, /setkey, /mykey, /ctxreset, /adminonly, /everyone are real, code-handled commands, not something you answer yourself — if one somehow reaches you as a normal message (e.g. a typo), say to double check the spelling and try again exactly, rather than inventing your own version of what that command does.
${formattingRules}

How to think:
- For anything with real stakes or complexity — debugging, multi-step tasks, decisions with tradeoffs, math, planning — reason through it carefully step by step before answering, and actually use run_command to check your work when you can (run the code, don't just guess what it does).
- For simple stuff — a greeting, a joke, a quick fact — just answer. Don't overthink small talk.
- NEVER report a tool call as successful if its actual result was an error. If list_files, delete_path, or any tool returns an error, say so plainly and either try a different real approach or tell the user it failed — don't guess at what the result probably would have been and present that guess as what happened.
- The reverse also applies: never invent a dramatic-sounding reason for a failure when the tool result already tells you the real one. If run_command returns "command not found" for something like git, that means it genuinely isn't installed yet — say exactly that and install it (e.g. apt-get install -y git, or the right package manager for whatever's missing) via run_command yourself, then retry. Do NOT tell the user you're blocked by "sandbox restrictions", "security policy", or any other invented limitation that isn't what the tool actually returned — you have real, working shell access (run_command), file access, and the ability to install anything missing. If something is genuinely unavailable (no network reachable, a real permission error from the OS itself), report that exact error, not a guess dressed up as a policy.
- Don't blanket-deny a capability you actually have. Before telling someone you can't do something, check: is there a tool for this (run_command, file tools, web_search, receive_file/send_file, analyze_image)? Could installing something make it possible? Only say no once you've actually tried and hit a real, reportable error — not as a first response to something that sounds hard.
- If the same approach fails repeatedly (same error, same method, no real progress), don't just keep blindly retrying it — after a few tries, stop and tell the user what's failing and ask whether to try a different approach or drop it. Trying a genuinely different method after a failure is fine and often the right move; grinding the identical failing thing over and over without saying anything is not.
- If the user clearly means to stop/cancel/abort something currently running (not just the word "stop" appearing somewhere in an unrelated sentence — judge real intent), call stop_background_jobs immediately and don't finish "just one more attempt" first. Confirm what actually happened based on the tool's real result, not an assumption.
- For any real multi-step task (scaffolding a project, a multi-file change, anything with several distinct pieces) — break it into concrete steps with add_todo BEFORE starting work, mark each in_progress when you actually start it and done the moment it's genuinely finished with update_todo. This is not optional bookkeeping — it's what makes the rest of this section possible: an accurate answer if the user asks where things stand, and a persistent record that survives even if the conversation history gets trimmed. Never claim something is done without actually having done it.
- A message from the user can arrive WHILE you're still mid-task — it shows up as a normal new turn in the conversation, exactly like this one. There is no special marker and no keyword to look for; read it the same way you'd read anything else they say and decide what it actually means from context. It might be a question about progress (check list_todos and answer from the real list, then keep going), an unrelated comment (acknowledge briefly if it warrants it, keep going), a change of direction, or genuinely wanting you to stop what's running — you decide which, the same way you already decide this for stop_background_jobs. Use talk_to_user to respond to it without losing your place in the task, unless what they said really is a reason to stop.
- Working in the background is normally SILENT — this is the default, not an exception. Running commands, retrying something that failed, checking files, debugging: none of that gets narrated. Don't call talk_to_user just because a round finished or a command ran; that produces exactly the wall-of-status-updates spam that must never happen, and it also leaks internal mechanics (raw commands, file paths, retry loops) that should never reach the user — same rule as never revealing tool names or function-call syntax. Only call talk_to_user when there's a real reason: the user actually asked something mid-task (answer from list_todos, then keep working), or something genuinely blocking happened that changes what you'll do next. A long task finishing its normal internal steps — even many of them, even several retries — is not by itself a reason to say anything until you're done.`;
}

async function buildMessages(session, userText, participantJid, participantName, quotaInfo = {}) {
  const facts = sessionStore.getFacts(session);
  const chat = await sessionStore.getChatMessages(session);
  const messages = [];
  const recent = chat.slice(-environment.yukiHistoryMessages);

  for (const row of recent) {
    if (row.role === 'assistant') {
      messages.push({ role: 'assistant', content: row.content });
    } else if (row.role === 'user') {
      messages.push({
        role: 'user',
        content: session.type === 'group' ? `${row.senderName || row.senderJid || 'User'}: ${row.content}` : row.content,
      });
    }
  }

  const factText = facts.map(f => `- ${f.key}: ${f.value}`).join('\n');
  const context = factText ? `Persistent memory for this session:\n${factText}` : 'No saved persistent facts yet.';
  messages.unshift({ role: 'system', content: context });
  messages.push({
    role: 'user',
    content: session.type === 'group' ? `${participantName || participantJid || 'User'}: ${userText}` : userText,
  });

  return [{ role: 'system', content: identity(session, quotaInfo) }, ...messages];
}

// Models whose chat template enforces strict user/assistant alternation
// and has no native `tool` role. Add to this list if you swap in another
// model with the same constraint.
const STRICT_ALTERNATION_MODELS = new Set(['yuki', 'gemma-3-1b-it', 'yuki-coder', 'granite-4.0-1b']);

async function callModel(messages, modelId, apiKey, baseUrl, toolsEnabled = true) {
  const outgoing = STRICT_ALTERNATION_MODELS.has(modelId)
    ? normalizeForStrictAlternation(messages)
    : messages;

  const bodyWithoutTools = {
    model: modelId,
    messages: outgoing,
    temperature: 0.7,
  };
  // Optional: only sent if configured, so providers that reject unknown
  // fields (anything not OpenAI-o-series-compatible) aren't broken by it.
  // Validated against the actual accepted enum first — a bad value here
  // (e.g. a numeric string like "50" instead of a real effort level) was
  // previously sent straight through and broke EVERY model call with a
  // 400 from the server's own OpenAI-compat validation, not a partial
  // degradation. An invalid value is dropped (with a one-time console
  // warning) rather than sent and allowed to take the whole bot down.
  const validEffort = ['none', 'low', 'medium', 'high', 'max'];
  if (environment.yukiReasoningEffort) {
    if (validEffort.includes(environment.yukiReasoningEffort)) {
      bodyWithoutTools.reasoning_effort = environment.yukiReasoningEffort;
    } else {
      console.warn(
        `[Yuki] YUKI_REASONING_EFFORT="${environment.yukiReasoningEffort}" is not one of ${validEffort.join(', ')} — ignoring it for this call instead of sending an invalid value that would fail every request.`,
      );
    }
  }

  // Splice the pre-serialized tools schema in as a raw JSON fragment
  // instead of including `tools` in bodyWithoutTools and letting
  // JSON.stringify walk the whole thing again — see TOOLS_JSON's
  // comment above for why. Omitted entirely (not sent as an empty
  // array) when tools are locked out — most OpenAI-compatible servers
  // treat an absent `tools` field as "no tools available" and just
  // generate a normal chat reply, which is exactly what a
  // quota-exceeded-but-still-chatting session needs: the model can't
  // call anything, but text generation is unaffected.
  const serializedBody = toolsEnabled
    ? `${JSON.stringify(bodyWithoutTools).slice(0, -1)},"tools":${TOOLS_JSON}}`
    : JSON.stringify(bodyWithoutTools);

  const response = await fetch(endpoint(baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: serializedBody,
  });
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Model returned non-JSON (${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || `Model request failed (${response.status}).`);
  }
  return data?.choices?.[0]?.message;
}

/**
 * toolCtx: { sock, jid, sourceMsg } — passed straight through to
 * executeTool alongside session, so tools can send/receive files and
 * run commands. `progress` is accepted for call-signature compatibility
 * with whatsapp.js but is no longer invoked per tool-call attempt — it
 * used to send a "Hit an issue on that step... Trying another way"
 * message on every single failure, which meant a command that failed
 * (or a backgrounded job that made the tool call hang/timeout) produced
 * a stream of repeated, near-identical error messages instead of one
 * clear report. Now the user gets exactly one message, after the
 * consecutive-failure threshold trips, with the FULL real error detail
 * from every attempt — not a summary, not a repeated generic line.
 *
 * MAX_CONSECUTIVE_FAILURES exists separately from yukiMaxToolRounds:
 * the round limit caps TOTAL tool-call rounds per message (default 12),
 * but nothing previously stopped the model from spending all 12 of
 * those rounds retrying the exact same failing approach — e.g. a login
 * attempt that keeps failing the same way. This tracks failures IN A
 * ROW (reset to 0 by any successful tool call, since a fresh success
 * means it's not stuck) and, once that streak hits the threshold,
 * breaks out of the loop and hands control back with the full detail —
 * not a silent stall, not another 7 rounds of the same failing retry.
 * The model can still keep trying past one failure (that's normal and
 * expected — only a STREAK stops it).
 */
const MAX_CONSECUTIVE_TOOL_FAILURES = 5;

// --- Short memory: cap the in-turn tool-call buffer -------------------
// `messages` inside runYukiInner's tool loop is built ONCE by
// buildMessages() (system prompt + session/JSON history + this turn's
// user message) and then grows every round: one assistant tool_calls
// entry plus one tool-result entry per call, per round, up to
// yukiMaxToolRounds rounds. None of that ever went through
// sessionStore.appendChat (by design — it's mid-task scratch, not
// session history), but nothing ever trimmed the live array either, so
// a long multi-round task resent the FULL accumulated tool transcript
// on every single callModel() call within that turn. That's the actual
// "short memory" tier: bounded per-turn tool activity, distinct from
// session memory (capped JSON) and long memory (memory_facts sqlite).
//
// A "round" here is exactly one iteration of the runYukiInner tool loop:
// one assistant tool_calls message + all of that round's tool-result
// messages. We find round boundaries by scanning for
// { role: 'assistant', tool_calls: [...] } markers, since that's the
// only message type that starts a new round.
function findRoundStartIndices(messages) {
  const starts = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant' && Array.isArray(messages[i].tool_calls)) {
      starts.push(i);
    }
  }
  return starts;
}

function charLength(messages) {
  return messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length), 0);
}

/**
 * Turns the messages of one dropped round into a single short line: what
 * tool(s) were called and whether each succeeded or failed (with the
 * error, truncated). This is deliberately compact — it exists so the
 * model doesn't repeat a dead-end approach or lose track of what it
 * already tried after that round's raw messages are gone, not to
 * preserve full detail (that's what the raw recent rounds still in the
 * window are for).
 */
function summarizeRound(roundMessages) {
  const assistantMsg = roundMessages.find(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
  const calls = assistantMsg?.tool_calls || [];
  const parts = calls.map(call => {
    const toolMsg = roundMessages.find(m => m.role === 'tool' && m.tool_call_id === call.id);
    let outcome = 'ok';
    if (toolMsg) {
      try {
        const parsed = JSON.parse(toolMsg.content);
        if (parsed?.error) outcome = `failed: ${String(parsed.error).slice(0, 80)}`;
      } catch { /* non-JSON tool content, treat as ok */ }
    }
    return `${call.function?.name || 'tool'} (${outcome})`;
  });
  return parts.length ? `tried: ${parts.join(', ')}` : null;
}

/**
 * Caps the in-turn messages array to at most yukiShortMemRounds of the
 * most recent tool-call rounds, AND at most yukiShortMemMaxChars total —
 * whichever limit is hit first. Everything before the first kept round
 * (system prompt, session history, the current user turn's lead-in) is
 * always preserved untouched. Rounds dropped from the front are folded
 * into a single running summary line injected right after the
 * preserved lead-in, so the model keeps a record of what it already
 * tried even once the raw messages are gone.
 *
 * Mutates nothing — returns a new array. Called at the top of every
 * loop iteration in runYukiInner, so it runs BEFORE callModel() sees
 * the array, not after (trimming after the fact would mean the
 * over-budget call already happened).
 */
const SHORT_MEM_SUMMARY_PREFIX = 'Earlier this turn (details trimmed to stay in budget) — ';

function trimShortMemory(messages) {
  const roundStarts = findRoundStartIndices(messages);
  if (roundStarts.length <= environment.yukiShortMemRounds && charLength(messages) <= environment.yukiShortMemMaxChars) {
    return messages; // nothing to trim yet
  }

  // How many of the most recent rounds we can keep under BOTH caps.
  // Start from "keep by round count", then shrink further if that's
  // still over the char budget.
  let keepFromRound = Math.max(0, roundStarts.length - environment.yukiShortMemRounds);
  while (keepFromRound < roundStarts.length) {
    const candidateStart = roundStarts[keepFromRound];
    const candidate = messages.slice(0, roundStarts[0]).concat(messages.slice(candidateStart));
    if (charLength(candidate) <= environment.yukiShortMemMaxChars) break;
    keepFromRound += 1;
  }
  if (keepFromRound >= roundStarts.length) keepFromRound = roundStarts.length - 1; // always keep at least the latest round

  // The "lead" is everything before the first tool round: system prompt +
  // session history + this turn's opening user message + (from a PRIOR
  // call to this function) at most one existing running summary message.
  // That existing summary is pulled out here — not left inside `lead` —
  // so its lines get MERGED with this pass's newly-dropped rounds into a
  // single line, rather than stacking a fresh summary message on every
  // trim (which is what produced one line per round previously).
  const rawLead = messages.slice(0, roundStarts[0]);
  const existingSummaryIdx = rawLead.findIndex(m => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(SHORT_MEM_SUMMARY_PREFIX));
  const priorSummaryText = existingSummaryIdx >= 0 ? rawLead[existingSummaryIdx].content.slice(SHORT_MEM_SUMMARY_PREFIX.length) : '';
  const lead = existingSummaryIdx >= 0 ? rawLead.filter((_, i) => i !== existingSummaryIdx) : rawLead;

  const droppedRoundRanges = [];
  for (let r = 0; r < keepFromRound; r++) {
    const start = roundStarts[r];
    const end = roundStarts[r + 1] ?? messages.length;
    droppedRoundRanges.push(messages.slice(start, end));
  }
  const kept = messages.slice(roundStarts[keepFromRound]);

  const newLines = droppedRoundRanges.map(summarizeRound).filter(Boolean);
  const allLines = priorSummaryText ? [priorSummaryText, ...newLines] : newLines;
  const summaryMessage = allLines.length
    ? [{ role: 'system', content: `${SHORT_MEM_SUMMARY_PREFIX}${allLines.join('; ')}` }]
    : [];

  return [...lead, ...summaryMessage, ...kept];
}

/**
 * Returns null if this session can make model calls right now, or a
 * plain-text explanation if it can't. Two independent things can block
 * a call entirely (not just tools):
 *   - No usable key at all (own key disallowed/unset AND public key
 *     disallowed for this session) — nothing can be sent to any model.
 *   - (Quota alone does NOT go here — being over quota still allows
 *     chatting, just without tools. See the toolsEnabled logic in
 *     runYuki below.)
 */
function keyBlockReason(session, isAdmin) {
  if (isAdmin) return null;
  const { key } = resolveApiKeyForSession(sessionStore, session);
  if (!key) {
    return "I can't make any model calls for this chat right now — both your own key and the shared key are turned off for this session. Ask an admin to enable one.";
  }
  return null;
}

export async function runYuki(session, userText, participantJid, participantName, toolCtx = {}, progress = async () => {}) {
  // Registered BEFORE any work starts, unregistered in `finally` so this
  // is true for the exact lifetime of the call regardless of which
  // return path or thrown error ends it — see the header comment above
  // on inFlightSessions for why this exists (fixes the real concurrency
  // race that silently dropped a message sent mid-task).
  const inboxEntry = { queue: [] };
  inFlightSessions.set(session.id, inboxEntry);
  try {
    return await runYukiInner(session, userText, participantJid, participantName, toolCtx, progress, inboxEntry);
  } finally {
    inFlightSessions.delete(session.id);
  }
}

async function runYukiInner(session, userText, participantJid, participantName, toolCtx, progress, inboxEntry) {
  const isAdmin = isAdminSession(session);

  // Stopping a running background job is now a TOOL CALL
  // (stop_background_jobs in agentTools.js), not a code-level regex match
  // on the message text. The earlier version matched the bare word
  // "stop"/"cancel"/etc. ANYWHERE in the message and killed every
  // background job unconditionally — "stop by the store later" or "don't
  // stop until it works" both wrongly triggered a real kill. The model
  // now judges actual intent from context (see that tool's description)
  // before calling it; the kill mechanism itself (killBackgroundJobs) is
  // unchanged and still a real SIGTERM/SIGKILL, just gated by judgment
  // instead of substring match.

  // No usable key at all -> can't call the model, period, chat or not.
  const blockReason = keyBlockReason(session, isAdmin);
  if (blockReason) {
    await sessionStore.appendChat(session, { role: 'assistant', content: blockReason, at: new Date().toISOString() });
    return blockReason;
  }

  const { key: apiKey, source: keySource } = isAdmin
    ? { key: resolveApiKeyForSession(sessionStore, session).key || environment.yukiApiKey, source: 'admin' }
    : resolveApiKeyForSession(sessionStore, session);

  // Tied to keySource, not resolved independently — see the header
  // comment on resolveApiBaseUrlForSession/resolveApiModelForSession in
  // runtimeConfig.js for why: a user's own base_url/model only make
  // sense to use when their own key is the one actually being sent.
  const apiBaseUrl = resolveApiBaseUrlForSession(sessionStore, session, keySource);
  const apiModel = resolveApiModelForSession(sessionStore, session, keySource);

  // Quota lockout: over the limit does NOT block the message — the
  // model still replies conversationally, it just can't call any tools
  // (run_command, file access, memory, everything in agentTools.js).
  // toolsEnabled=false makes callModel omit the `tools` field entirely,
  // which for an OpenAI-compatible server means the model literally
  // cannot emit a tool_calls response — there's nothing for it to call,
  // this isn't the model "choosing" to respect a limit it could ignore.
  // The identity() prompt tells the model it's in this state (and when
  // it resets) so it can explain that to the user itself if asked,
  // rather than the code needing to intercept every tool-shaped request
  // with a canned refusal.
  const ctxLimit = getCtxLimitChars(sessionStore);
  const resetHours = getCtxResetHours(sessionStore);
  let overQuota = false;
  let resetAt = null;
  if (!isAdmin && ctxLimit) {
    const usage = sessionStore.getCtxUsage(session.id, resetHours);
    overQuota = usage.charsUsed >= ctxLimit;
    resetAt = new Date(new Date(usage.windowStartedAt + 'Z').getTime() + resetHours * 60 * 60 * 1000);
  }

  let messages = await buildMessages(session, userText, participantJid, participantName, { overQuota, resetAt, ctxLimit });

  let consecutiveFailures = 0;
  let lastFailureSummaries = [];
  const toolsEnabled = !overQuota;

  for (let round = 0; round < environment.yukiMaxToolRounds; round++) {
    // Drain any messages that arrived WHILE this task was already
    // running (see inFlightSessions / queueMessageForBusySession above).
    // Injected as real `user` turns into the SAME conversation the model
    // is already working through — the model sees them on this round's
    // callModel() exactly like any other message and decides for itself
    // what they mean and what to do (keep going + talk_to_user, treat it
    // as a reason to stop_background_jobs, answer a question, change
    // direction — entirely its judgment, nothing here interprets the
    // text). Logged to chat history the same as any user message, so
    // there's a real record of when it actually arrived relative to the
    // task, not just when the task happened to finish.
    if (inboxEntry.queue.length) {
      const pending = inboxEntry.queue.splice(0, inboxEntry.queue.length);
      for (const queuedText of pending) {
        messages.push({ role: 'user', content: `${participantName}: ${queuedText}` });
        await sessionStore.appendChat(session, { role: 'user', content: queuedText, senderJid: participantJid, senderName: participantName, at: new Date().toISOString() });
      }
    }

    const message = await callModel(messages, apiModel, apiKey, apiBaseUrl, toolsEnabled);
    let calls = message?.tool_calls || [];

    // Defense in depth: omitting `tools` from the request should make it
    // impossible for a well-behaved OpenAI-compatible model to emit
    // tool_calls at all, but a smaller/quantized model can occasionally
    // hallucinate a tool_calls-shaped response anyway even with no
    // schema offered. If that happens while locked out, every call is
    // rejected with the lockout reason rather than actually executed —
    // this is the real enforcement backstop, not just the missing
    // schema.
    if (calls.length && !toolsEnabled) {
      messages.push({ role: 'assistant', content: message.content || null, tool_calls: calls });
      for (const call of calls) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: `Tools are locked out for this session until the usage window resets${resetAt ? ` at ${resetAt.toISOString()}` : ''}. Do not attempt another tool call — just tell the user this plainly.` }),
        });
      }
      continue;
    }

    if (!calls.length) {
      const rawReply = String(message?.content || '').trim();
      const { text: reply } = sanitizeIdentityLeak(rawReply);
      if (reply) {
        sessionStore.recordMemory(session, 'assistant', reply);
        await sessionStore.appendChat(session, { role: 'assistant', content: reply, at: new Date().toISOString() });
      }
      return reply || "Didn't get anything back there — try that again?";
    }

    messages.push({ role: 'assistant', content: message.content || null, tool_calls: calls });

    let anySucceededThisRound = false;
    for (const call of calls) {
      let result;
      try {
        const args = JSON.parse(call.function.arguments || '{}');
        result = await executeTool(call.function.name, args, { session, participantJid, participantName, progress, ...toolCtx });
        if (!result?.error) anySucceededThisRound = true;
      } catch (e) {
        result = { error: e?.message || 'Tool execution failed.' };
      }
      if (result?.error) {
        lastFailureSummaries.push(`${call.function.name}: ${result.error}`.slice(0, 300));
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }

    // Short-memory cap: trim NOW, right after this round's messages are
    // in, so the array handed to callModel() at the top of the NEXT
    // round is already within budget — never resend an unbounded
    // in-turn transcript. See trimShortMemory's header comment.
    messages = trimShortMemory(messages);

    consecutiveFailures = anySucceededThisRound ? 0 : consecutiveFailures + 1;

    if (consecutiveFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
      const recap = lastFailureSummaries.join('\n\n');
      const reply = `That approach failed ${consecutiveFailures} times in a row, so I stopped instead of continuing to retry it. Here's exactly what happened each time:\n\n${recap}\n\nWant me to try a different approach, or drop it?`;
      sessionStore.recordMemory(session, 'assistant', reply);
      await sessionStore.appendChat(session, { role: 'assistant', content: reply, at: new Date().toISOString() });
      return reply;
    }
  }

  throw new Error('The agent reached its tool-step limit.');
}
