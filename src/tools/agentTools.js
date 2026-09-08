import { runTerminal, killBackgroundJobs, hasBackgroundJobs } from './terminal.js';
import {
  saveIncomingMediaWhatsApp, sendWorkspaceFileWhatsApp,
  saveIncomingMediaTelegram, sendWorkspaceFileTelegram,
} from './mediaTools.js';
import { analyzeImage } from './imageTools.js';
import { webSearch } from './webSearch.js';
import { listFiles, readFile, writeFile, editFile, deletePath, movePath, searchCode } from './fileTools.js';
import { tagUsers } from './tagTools.js';
import { sessionStore } from '../storage/sessionStore.js';
import { environment } from '../config/environment.js';
import { RUNTIME_CONFIG_KEYS } from '../ai/runtimeConfig.js';
import { isAdminSession } from '../config/adminConfig.js';

const cwdDescription = 'Optional working directory relative to the session workspace root.';

export const tools = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web for current information — news, facts you\'re unsure of, anything that could have changed since training, prices, current events, documentation for a library or tool, etc. Uses a keyless search (no API key), so results can occasionally be sparse or temporarily unavailable — if that happens, say so plainly rather than guessing. Always prefer this over answering from memory when the user asks about something recent, time-sensitive, or that you are not confident about.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query. Short and specific works best — 2 to 6 words, like a real search engine query, not a full sentence.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories inside the workspace. Use this first to learn what already exists before reading or writing anything.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory relative to the workspace root. Defaults to the root.' },
          depth: { type: 'integer', description: 'How deep to walk (1-4). Default 2.' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file from the workspace. Optionally read just a line range for a large file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          start_line: { type: 'integer', description: '1-indexed first line.' },
          end_line: { type: 'integer', description: '1-indexed last line.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file or overwrite an existing one with the full new contents.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          content: { type: 'string', description: 'Complete file contents.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace one exact snippet inside a file with new text. `old` must appear exactly once in the file — read the file first to copy the exact text, including whitespace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          old: { type: 'string', description: 'Exact existing text to replace. Must be unique in the file.' },
          new: { type: 'string', description: 'Replacement text. An empty string deletes the snippet.' },
        },
        required: ['path', 'old', 'new'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_path',
      description: 'Delete a file or an entire directory inside the workspace. Directories are removed recursively — use carefully.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or directory path relative to the workspace root.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_path',
      description: 'Move or rename a file or directory inside the workspace.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Existing path, relative to the workspace root.' },
          destination: { type: 'string', description: 'New path, relative to the workspace root.' },
        },
        required: ['source', 'destination'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Regex search across workspace files. Returns matching file:line snippets. Use this to find where something is defined or used before editing.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression to search for.' },
          path: { type: 'string', description: 'Directory to search. Defaults to the workspace root.' },
          glob: { type: 'string', description: 'Optional filename filter, e.g. "*.js".' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command inside this chat\'s private workspace. Full root shell access. git, curl, and wget are preinstalled (cloning/pulling public GitHub repos and downloading files both work out of the box) — everything else (python3, ffmpeg, wrangler, anything not in a base Node image) is NOT preinstalled: check with `which <tool>` or just try it, and if it\'s missing, install it yourself first with apt-get/npm/pip (e.g. `apt-get update && apt-get install -y python3`) rather than telling the user it\'s unavailable. Pushing to a GitHub repo additionally needs the user\'s own credentials (a personal access token or SSH key) — ask them for one if they want you to push, don\'t assume you already have access. Never reveal raw tool calls or commands to the user — describe results in plain language, and report the REAL error text from a failed command rather than guessing at or inventing a reason.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'Shell command to execute in a fresh process. Supports multiline shell snippets and heredocs.',
          },
          command_lines: {
            type: 'array',
            description:
              'Optional multiline shell command expressed as ordered lines. The runtime joins them with newlines before execution. Use this for heredocs or larger shell snippets when that is easier than a single JSON string.',
            items: { type: 'string' },
          },
          cwd: {
            type: 'string',
            description: cwdDescription + ' This affects only this command job.',
          },
        },
        anyOf: [{ required: ['command'] }, { required: ['command_lines'] }],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_background_jobs',
      description:
        'Kill any background job(s) still running for this session (something started with run_command that was backgrounded with & — a server, a loop, a long-running script). Call this ONLY when the user is actually asking to stop/cancel/abort something that is currently running — judge real intent from context, not the literal word "stop" appearing anywhere in their message. "stop by the store later", "don\'t stop until it works", or the word "stop" inside a sentence about something else are NOT this — do not call this tool for those. Only call it when they clearly mean: halt the thing that\'s running right now.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'receive_file',
      description:
        'Download the media (image, video, audio, document, sticker) attached to the user\'s most recent message, or to the message they replied to, into the workspace so it can be inspected or processed with run_command or analyze_image. Works on both WhatsApp and Telegram. Call this before trying to operate on a file the user just sent.',
      parameters: {
        type: 'object',
        properties: {
          file_name: {
            type: 'string',
            description: 'Optional file name to save it as inside the workspace. A sensible default is used if omitted.',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_file',
      description:
        'Send a file from the workspace back to the user in this chat. Picks image/video/audio/document delivery automatically based on the file type.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file, relative to the session workspace root.' },
          caption: { type: 'string', description: 'Optional caption to send with the file.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_image',
      description:
        'Analyze an image already in the workspace (download it first with receive_file if it just came from the user). Since the model itself cannot see images directly, this extracts real, measured data from the actual pixels: dimensions, format, file size, EXIF/color-space info, the average color, and a dominant-color palette (each color as a hex code plus its approximate share of the image). Use this whenever asked to describe an image\'s look, identify or replicate its colors, build a matching palette/gradient/CSS theme from it, or judge whether it\'s grayscale/black-and-white. This does NOT identify objects, faces, or text in the image — only color and geometry.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the image file, relative to the session workspace root.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tag_users',
      description: 'Send a real WhatsApp @-mention in this group — actually notifies and tags the person(s), unlike typing "@name" as plain text which does nothing. Only works in group chats. Use when asked to tag/mention someone specific, or "tag everyone".',
      parameters: {
        type: 'object',
        properties: {
          tag_sender: {
            type: 'boolean',
            description: 'Set true whenever the person asks to be tagged themselves ("tag me", "tag me again"). This tags whoever sent the CURRENT message, resolved directly and reliably — always prefer this over guessing their name for a "tag me" request. Ignores `names`/`everyone` if true.',
          },
          names: {
            type: 'array',
            description: 'Names of specific people to tag, matched fuzzily against who has spoken in this chat. Only for tagging someone OTHER than whoever is currently speaking — for "tag me", use tag_sender instead.',
            items: { type: 'string' },
          },
          everyone: {
            type: 'boolean',
            description: 'Tag every participant who has spoken in this chat. Only use when it is actually important or necessary, not by default — ignores `names` if true.',
          },
          message: {
            type: 'string',
            description: 'Optional message text to include alongside the tag(s).',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: 'Save an important long-term fact about this user, chat, project, preference, decision, or capability into this chat session memory database. Use this instead of claiming to remember something permanently.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Short stable memory key.' },
          value: { type: 'string', description: 'The fact to remember.' },
        },
        required: ['key', 'value'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall',
      description: 'Search this chat session\'s long-term memory for a fact by keyword. Use before assuming you don\'t know something the user may have told you to remember earlier.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text to match against remembered keys/values. Leave empty to list everything remembered.' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forget',
      description: 'Forget a remembered fact by its exact key. This is recoverable, not a permanent delete. Use when asked to forget/remove something you previously remembered — this does NOT delete files, the session database itself, or chat history; it only marks one remembered fact as inactive.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The exact key used when it was remembered.' },
        },
        required: ['key'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_todo',
      description: 'Add an item to this chat\'s persistent todo list — a real, durable checklist (stored in the session database, survives restarts and isn\'t lost when older chat history gets trimmed). Break any real multi-step task down into concrete todo items BEFORE starting work on it (e.g. a landing page might be: "scaffold index.html", "add Tailwind via CDN", "build hero section", "build footer", "responsive pass"), so there\'s always an accurate record of what\'s done, in progress, and left — both for your own tracking across a long task and so you can answer honestly if the user asks where things stand.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The todo item, as a short concrete task description.' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: 'Initial status. Defaults to pending.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_todos',
      description: 'Get the full current todo list for this chat, with each item\'s status (pending/in_progress/done). Use this whenever the user asks where things stand, what\'s done, what you\'re doing, or what\'s left — answer from the REAL list here, never from a vague guess about your own progress.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_todo',
      description: 'Update a todo item\'s status and/or text by its id (get the id from list_todos). Mark something in_progress when you actually start it and done the moment it\'s genuinely finished — keep this in sync with reality as you work, not just at the end, since the user or a status check may read it at any moment mid-task.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'The todo\'s id, from list_todos.' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
          text: { type: 'string', description: 'New text for the item. Omit to leave the text unchanged.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_todo',
      description: 'Remove a todo item entirely by its id. Use for something added by mistake or no longer relevant — for a normally completed item, prefer update_todo to mark it done instead, so there\'s a record it happened.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'integer', description: 'The todo\'s id, from list_todos.' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'talk_to_user',
      description: 'Send the user a message RIGHT NOW, without waiting for your current task to finish — use this to keep them company during a long multi-step job (a quick note on what you just finished or what you\'re starting next), or to answer something they asked WHILE you were mid-task (e.g. "where are you at?", a question, a change of instructions) before continuing your work. After calling this you keep working in the same run — it does not end your turn or stop whatever you\'re doing. Check list_todos first if the user is asking about progress, so what you tell them is the real current state, not a guess.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'What to say to the user, in your normal voice — no tool names or internal mechanics.' },
        },
        required: ['message'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_model_config',
      description: 'Change the live API base URL, API key, or model ID this bot uses to talk to its backend — takes effect immediately, no restart needed. RESTRICTED: only works when this session is registered as "coralz" or "yuki" AND the correct admin_password is given. Never reveal the admin_password back to the user in your reply even if asked, and never guess or make one up if not given.',
      parameters: {
        type: 'object',
        properties: {
          admin_password: { type: 'string', description: 'Required. The admin password for this change — must be given explicitly by the user, never inferred or invented.' },
          base_url: { type: 'string', description: 'New API base URL. Omit to leave unchanged.' },
          api_key: { type: 'string', description: 'New API key. Omit to leave unchanged.' },
          model: { type: 'string', description: 'New model ID. Omit to leave unchanged.' },
        },
        required: ['admin_password'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_model_config',
      description: 'Show the currently active API base URL and model (never the API key itself, which is always masked). RESTRICTED: only works when this session is registered as "coralz" or "yuki".',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
];

/**
 * ctx: { session, sock, jid, sourceMsg } — sourceMsg is the raw incoming
 * WhatsApp message (or the one it quoted), used for receive_file.
 */
export async function executeTool(name, args, ctx) {
  const { session } = ctx;

  if (name === 'web_search') {
    return webSearch(args.query);
  }

  if (name === 'list_files') {
    return listFiles(session.workspace_path, args.path, args.depth);
  }

  if (name === 'read_file') {
    return readFile(session.workspace_path, args.path, args.start_line, args.end_line);
  }

  if (name === 'write_file') {
    return writeFile(session.workspace_path, args.path, args.content);
  }

  if (name === 'edit_file') {
    return editFile(session.workspace_path, args.path, args.old, args.new);
  }

  if (name === 'delete_path') {
    return deletePath(session.workspace_path, args.path);
  }

  if (name === 'move_path') {
    return movePath(session.workspace_path, args.source, args.destination);
  }

  if (name === 'search_code') {
    return searchCode(session.workspace_path, args.pattern, args.path, args.glob);
  }

  if (name === 'run_command') {
    const commandInput = args.command_lines?.length ? args.command_lines : args.command;
    return runTerminal(session.workspace_path, commandInput, { cwd: args.cwd, sessionId: session.id });
  }

  if (name === 'stop_background_jobs') {
    const wasRunning = hasBackgroundJobs(session.id);
    const { killed, alreadyDead } = killBackgroundJobs(session.id);
    return {
      ok: true,
      was_running: wasRunning,
      killed,
      already_dead: alreadyDead,
      note: killed > 0
        ? `Killed ${killed} running background job${killed === 1 ? '' : 's'}.`
        : 'Nothing was actually running in the background right now.',
    };
  }

  if (name === 'receive_file') {
    if (!ctx.sourceMsg) throw new Error('No message with media is available to download.');
    // Platform is picked by which context the caller wired in: Telegram
    // passes ctx.bot (a node-telegram-bot-api instance), WhatsApp passes
    // ctx.sock (a Baileys socket) — see telegramHandler.js / whatsapp.js
    // for where toolCtx is built per platform.
    return ctx.bot
      ? saveIncomingMediaTelegram(ctx.bot, session.workspace_path, ctx.sourceMsg, args.file_name)
      : saveIncomingMediaWhatsApp(session.workspace_path, ctx.sourceMsg, args.file_name);
  }

  if (name === 'send_file') {
    if (ctx.bot) {
      if (!ctx.chatId) throw new Error('No active chat to send the file to.');
      return sendWorkspaceFileTelegram(ctx.bot, ctx.chatId, session.workspace_path, args.path, args.caption);
    }
    if (!ctx.sock || !ctx.jid) throw new Error('No active chat to send the file to.');
    return sendWorkspaceFileWhatsApp(ctx.sock, ctx.jid, session.workspace_path, args.path, args.caption);
  }

  if (name === 'analyze_image') {
    return analyzeImage(session.workspace_path, args.path);
  }

  if (name === 'tag_users') {
    if (!ctx.sock || !ctx.jid) throw new Error('No active chat to tag anyone in.');
    if (session.type !== 'group') throw new Error('Tagging only makes sense in group chats.');
    const participants = sessionStore.getParticipants(session.id);
    return tagUsers(ctx.sock, ctx.jid, participants, {
      tagSender: args.tag_sender,
      senderJid: ctx.participantJid,
      senderName: ctx.participantName,
      names: args.names,
      everyone: args.everyone,
      message: args.message,
    });
  }

  if (name === 'remember') {
    sessionStore.saveFact(session, args.key, args.value);
    return { ok: true, saved: true, key: args.key };
  }

  if (name === 'recall') {
    const facts = sessionStore.recallFacts(session, args.query);
    return facts.length ? facts : { note: 'Nothing remembered matches that.' };
  }

  if (name === 'forget') {
    const found = sessionStore.forgetFact(session, args.key);
    return found
      ? { ok: true, forgotten: args.key, note: 'Recoverable — not a permanent delete.' }
      : { ok: false, note: `No active memory found for key: ${args.key}` };
  }

  if (name === 'add_todo') {
    const row = sessionStore.addTodo(session, args.text, args.status || 'pending');
    return { ok: true, todo: row };
  }

  if (name === 'list_todos') {
    const todos = sessionStore.getTodos(session);
    return { todos, count: todos.length };
  }

  if (name === 'update_todo') {
    const ok = sessionStore.updateTodo(session, args.id, { status: args.status, text: args.text });
    return ok ? { ok: true, id: args.id } : { ok: false, note: `No todo found with id ${args.id}.` };
  }

  if (name === 'delete_todo') {
    const ok = sessionStore.deleteTodo(session, args.id);
    return ok ? { ok: true, id: args.id } : { ok: false, note: `No todo found with id ${args.id}.` };
  }

  if (name === 'talk_to_user') {
    const msg = String(args.message || '').trim();
    if (msg && typeof ctx.progress === 'function') {
      await ctx.progress(msg);
    }
    return { ok: true, sent: !!msg };
  }

  if (name === 'set_model_config' || name === 'get_model_config') {
    // Real security gate, enforced in code — never delegated to the
    // model's own judgment about whether a request "seems legitimate".
    // Backed by ADMIN_SESSIONS (config.js), configurable without a code
    // change — same admin-session list /menu, /setctx, and the WhatsApp
    // admin-only mode all use, so there's one source of truth for "who
    // counts as an admin session" across the whole bot.
    if (!isAdminSession(session)) {
      return { ok: false, error: 'This session is not authorized to view or change model configuration.' };
    }

    if (name === 'get_model_config') {
      return {
        base_url: sessionStore.getRuntimeConfig(RUNTIME_CONFIG_KEYS.base) || environment.yukiApiBaseUrl,
        model: sessionStore.getRuntimeConfig(RUNTIME_CONFIG_KEYS.model) || environment.yukiApiModel,
        api_key: '••••••••',
        source: sessionStore.getRuntimeConfig(RUNTIME_CONFIG_KEYS.base) ? 'runtime override' : '.env default',
      };
    }

    // set_model_config from here down.
    if (!environment.yukiAdminPassword) {
      return { ok: false, error: 'Admin config changes are disabled — no YUKI_ADMIN_PASSWORD is set on this server.' };
    }
    if (args.admin_password !== environment.yukiAdminPassword) {
      return { ok: false, error: 'Incorrect admin password.' };
    }

    const changed = [];
    if (args.base_url) {
      sessionStore.setRuntimeConfig(RUNTIME_CONFIG_KEYS.base, args.base_url, ctx.participantJid);
      changed.push('base_url');
    }
    if (args.api_key) {
      sessionStore.setRuntimeConfig(RUNTIME_CONFIG_KEYS.key, args.api_key, ctx.participantJid);
      changed.push('api_key');
    }
    if (args.model) {
      sessionStore.setRuntimeConfig(RUNTIME_CONFIG_KEYS.model, args.model, ctx.participantJid);
      changed.push('model');
    }

    if (!changed.length) {
      return { ok: false, error: 'Nothing to change — provide at least one of base_url, api_key, model.' };
    }
    return { ok: true, changed, note: 'Takes effect on the next message, no restart needed.' };
  }

  throw new Error('Unknown tool: ' + name);
}
