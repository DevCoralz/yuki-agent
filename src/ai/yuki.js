import { environment } from '../config/environment.js';
import { sessionStore } from '../storage/sessionStore.js';
import { tools, executeTool } from '../tools/agentTools.js';
import { sanitizeIdentityLeak } from './identityFilter.js';
import { markdownToWhatsApp } from './whatsappFormat.js';
import { resolveApiBaseUrl, resolveApiKey, resolveApiModel } from './runtimeConfig.js';

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

function endpoint() {
  const base = resolveApiBaseUrl(sessionStore);
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function identity(session) {
  const groupRules = session.type === 'group'
    ? `

CRITICAL — this is a GROUP chat with multiple people:
- Every message you see is prefixed "Name: message text" — that name is WHO SENT IT. Never confuse one person's message or request with another's, even if they're active in the same conversation moments apart.
- When you tag/reply/respond to "you" or "me", that means the person who sent THIS specific message — check the prefix on the message you're currently replying to, not an earlier one from someone else.
- If a request or instruction came from one named person, it applies to what THAT person asked — don't apply their preferences (e.g. "only tag me") to a different person who speaks next.`
    : '';

  return `${environment.yukiSystemPrompt}

Current session: ${session.registered_name}.
Chat type: ${session.type}.
Workspace: ${session.workspace_path}.
Memory database: ${session.memory_db_path}.
The workspace and memory belong only to this chat session.${groupRules}

How to talk:
- Match the energy of whoever you're talking to. If they're joking around, joke back — be genuinely funny, quick, a little sharp, never stiff or robotic. If they're being serious or need real help, drop the jokes and focus.
- Talk like a sharp, clever friend texting back, not like a customer support bot. Contractions, casual phrasing, no corporate hedging, no "I'd be happy to help you with that!" filler.
- Keep replies as short as the moment calls for. A one-line joke back for a one-line joke. Longer, structured answers only when the task actually needs it.
- Never narrate what you're about to do ("Let me check that for you...") — just do it and reply with the result.
- Never reveal tool names, function-call syntax, or internal mechanics to the user.
- This is WhatsApp, not a Markdown renderer: use *single asterisks* for bold (never **double**), _underscores_ for italic, ~single tildes~ for strikethrough, single backticks for \`inline code\`, and triple backticks for code blocks. Never use ## headers or | tables — WhatsApp doesn't render either; use a short bold line for a heading, and a plain bulleted list instead of a table.

How to think:
- For anything with real stakes or complexity — debugging, multi-step tasks, decisions with tradeoffs, math, planning — reason through it carefully step by step before answering, and actually use run_command to check your work when you can (run the code, don't just guess what it does).
- For simple stuff — a greeting, a joke, a quick fact — just answer. Don't overthink small talk.
- NEVER report a tool call as successful if its actual result was an error. If list_files, delete_path, or any tool returns an error, say so plainly and either try a different real approach or tell the user it failed — don't guess at what the result probably would have been and present that guess as what happened.
- If the same approach fails repeatedly (same error, same method, no real progress), don't just keep blindly retrying it — after a few tries, stop and tell the user what's failing and ask whether to try a different approach or drop it. Trying a genuinely different method after a failure is fine and often the right move; grinding the identical failing thing over and over without saying anything is not.
- If the user says to stop, cancel, or drop something mid-task, stop immediately — don't finish "just one more attempt" first.`;
}

async function buildMessages(session, userText, participantJid, participantName) {
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

  return [{ role: 'system', content: identity(session) }, ...messages];
}

// Models whose chat template enforces strict user/assistant alternation
// and has no native `tool` role. Add to this list if you swap in another
// model with the same constraint.
const STRICT_ALTERNATION_MODELS = new Set(['yuki', 'gemma-3-1b-it', 'yuki-coder', 'granite-4.0-1b']);

async function callModel(messages, modelId) {
  const outgoing = STRICT_ALTERNATION_MODELS.has(modelId)
    ? normalizeForStrictAlternation(messages)
    : messages;

  const body = {
    model: modelId,
    messages: outgoing,
    temperature: 0.7,
    tools,
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

  const response = await fetch(endpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolveApiKey(sessionStore)}` },
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
 * run commands. progress(status) is only called on tool *errors* now —
 * routine tool calls stay silent (the typing indicator already shows
 * the bot is working) instead of narrating every step.
 *
 * MAX_CONSECUTIVE_FAILURES exists separately from yukiMaxToolRounds:
 * the round limit caps TOTAL tool-call rounds per message (default 12),
 * but nothing previously stopped the model from spending all 12 of
 * those rounds retrying the exact same failing approach — e.g. a login
 * attempt that keeps failing the same way. This tracks failures IN A
 * ROW (reset to 0 by any successful tool call, since a fresh success
 * means it's not stuck) and, once that streak hits the threshold,
 * breaks out of the loop and hands control back with a clear summary —
 * not a silent stall, not another 7 rounds of the same failing retry.
 * The model can still keep trying past one failure (that's normal and
 * expected — only a STREAK stops it), and a plain "stop" from the user
 * mid-task should end the loop even before the streak limit, which is
 * handled by checking the user's own latest message for a stop word
 * before running another round.
 */
const MAX_CONSECUTIVE_TOOL_FAILURES = 5;
const STOP_WORD_PATTERN = /\b(stop|cancel|abort|never\s*mind|nevermind|forget it|that'?s enough|enough)\b/i;

export async function runYuki(session, userText, participantJid, participantName, toolCtx = {}, progress = async () => {}) {
  const messages = await buildMessages(session, userText, participantJid, participantName);

  let consecutiveFailures = 0;
  let lastFailureSummaries = [];

  for (let round = 0; round < environment.yukiMaxToolRounds; round++) {
    const message = await callModel(messages, resolveApiModel(sessionStore));
    const calls = message?.tool_calls || [];

    if (!calls.length) {
      const rawReply = String(message?.content || '').trim();
      const { text: identityClean } = sanitizeIdentityLeak(rawReply);
      const reply = markdownToWhatsApp(identityClean);
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
        await progress(`Hit an issue on that step: ${e?.message || 'unknown error'}. Trying another way.`);
      }
      if (result?.error) {
        lastFailureSummaries.push(`${call.function.name}: ${result.error}`.slice(0, 200));
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }

    consecutiveFailures = anySucceededThisRound ? 0 : consecutiveFailures + 1;

    if (consecutiveFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
      const recap = [...new Set(lastFailureSummaries.slice(-MAX_CONSECUTIVE_TOOL_FAILURES))].join('\n');
      const reply = markdownToWhatsApp(
        `That approach failed ${consecutiveFailures} times in a row, so I'll stop here instead of continuing to retry the same thing:\n\n${recap}\n\nWant me to try a different approach, or should I drop it?`,
      );
      sessionStore.recordMemory(session, 'assistant', reply);
      await sessionStore.appendChat(session, { role: 'assistant', content: reply, at: new Date().toISOString() });
      return reply;
    }

    // A mid-task "stop" from the user (checked in their most recent real
    // message, not the tool-injected messages) should end this immediately
    // rather than waiting for the failure streak or the round limit —
    // the streak counter alone wouldn't catch a case where the model is
    // technically succeeding at retrying (e.g. successfully re-navigating)
    // but the user has already said they want it to stop.
    if (STOP_WORD_PATTERN.test(userText)) {
      const reply = markdownToWhatsApp('Stopped — let me know if you want to try a different approach.');
      sessionStore.recordMemory(session, 'assistant', reply);
      await sessionStore.appendChat(session, { role: 'assistant', content: reply, at: new Date().toISOString() });
      return reply;
    }
  }

  throw new Error('The agent reached its tool-step limit.');
}
