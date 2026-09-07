import { environment } from '../config/environment.js';
import { sessionStore } from '../storage/sessionStore.js';
import { tools, executeTool } from '../tools/agentTools.js';
import { sanitizeIdentityLeak } from './identityFilter.js';
import { resolveApiKeyForSession, resolveApiBaseUrlForSession, resolveApiModelForSession } from './runtimeConfig.js';
import { killBackgroundJobs } from '../tools/terminal.js';
import { isAdminSession, getCtxLimitChars, getCtxResetHours } from '../config/adminConfig.js';

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
- If the same approach fails repeatedly (same error, same method, no real progress), don't just keep blindly retrying it — after a few tries, stop and tell the user what's failing and ask whether to try a different approach or drop it. Trying a genuinely different method after a failure is fine and often the right move; grinding the identical failing thing over and over without saying anything is not.
- If the user says to stop, cancel, or drop something mid-task, stop immediately — don't finish "just one more attempt" first.`;
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

  const body = {
    model: modelId,
    messages: outgoing,
    temperature: 0.7,
    // Omitted entirely (not sent as an empty array) when tools are
    // locked out — most OpenAI-compatible servers treat an absent
    // `tools` field as "no tools available" and just generate a normal
    // chat reply, which is exactly what a quota-exceeded-but-still-
    // chatting session needs: the model can't call anything, but text
    // generation is unaffected.
    ...(toolsEnabled ? { tools } : {}),
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
      body.reasoning_effort = environment.yukiReasoningEffort;
    } else {
      console.warn(
        `[Yuki] YUKI_REASONING_EFFORT="${environment.yukiReasoningEffort}" is not one of ${validEffort.join(', ')} — ignoring it for this call instead of sending an invalid value that would fail every request.`,
      );
    }
  }

  const response = await fetch(endpoint(baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
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
const STOP_WORD_PATTERN = /\b(stop|cancel|abort|never\s*mind|nevermind|forget it|that'?s enough|enough|ctrl\s*[+\-]?\s*c)\b/i;

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
  const isAdmin = isAdminSession(session);

  // CODE-LEVEL stop, checked BEFORE any model call — deliberately not
  // something the model decides to honor. See killBackgroundJobs() in
  // terminal.js for why this has to be a direct kill, not a text reply
  // claiming something happened.
  if (STOP_WORD_PATTERN.test(userText)) {
    const { killed, alreadyDead } = killBackgroundJobs(session.id);
    const reply = killed > 0
      ? `Stopped. Killed ${killed} running background job${killed === 1 ? '' : 's'}.`
      : alreadyDead > 0
        ? 'Nothing was actually still running (any earlier background job had already ended) — but stopping here as asked.'
        : "Stopped — there wasn't a background job to kill, but I won't run anything further for this message.";
    sessionStore.recordMemory(session, 'assistant', reply);
    await sessionStore.appendChat(session, { role: 'assistant', content: reply, at: new Date().toISOString() });
    return reply;
  }

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

  const messages = await buildMessages(session, userText, participantJid, participantName, { overQuota, resetAt, ctxLimit });

  let consecutiveFailures = 0;
  let lastFailureSummaries = [];
  const toolsEnabled = !overQuota;

  for (let round = 0; round < environment.yukiMaxToolRounds; round++) {
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
        result = await executeTool(call.function.name, args, { session, participantJid, participantName, ...toolCtx });
        if (!result?.error) anySucceededThisRound = true;
      } catch (e) {
        result = { error: e?.message || 'Tool execution failed.' };
      }
      if (result?.error) {
        lastFailureSummaries.push(`${call.function.name}: ${result.error}`.slice(0, 300));
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }

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
