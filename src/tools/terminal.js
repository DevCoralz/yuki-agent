import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { safePath } from './workspace.js';
import { screenCommand } from './commandScreen.js';

const MAX_OUTPUT = 30000;

/**
 * Tracks live process-group ids per session, so a command that
 * backgrounds something with `&` (a loop, a server, anything the shell
 * itself doesn't wait on) can actually be found and killed later — the
 * exit-vs-close fix below means the TOOL CALL returns promptly, but the
 * backgrounded job itself is a real, independent process that needs an
 * explicit kill path. Without this, "stop"/"clear workspace" had no
 * mechanism to reach a background job at all — it could only ever
 * affect the CURRENT tool call, never a job left running from an
 * earlier one. Keyed by session.id; cleared automatically once a group
 * is confirmed dead (checked via a zero-signal kill probe).
 */
const liveGroups = new Map(); // sessionId -> Set<pid>

function trackGroup(sessionId, pid) {
  if (!liveGroups.has(sessionId)) liveGroups.set(sessionId, new Set());
  liveGroups.get(sessionId).add(pid);
}

function untrackGroup(sessionId, pid) {
  liveGroups.get(sessionId)?.delete(pid);
}

function isGroupAlive(pid) {
  try {
    // Signal 0 sends nothing — just probes whether the process/group
    // exists and is killable, without actually affecting it.
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kills every tracked backgrounded process group for a session. Returns
 * how many were actually alive and killed (vs. already-dead entries,
 * which are just cleaned up silently) so the caller can report a real,
 * specific number instead of an unconditional "done ✅".
 */
export function killBackgroundJobs(sessionId) {
  const pids = liveGroups.get(sessionId);
  if (!pids || pids.size === 0) return { killed: 0, alreadyDead: 0 };
  let killed = 0, alreadyDead = 0;
  for (const pid of [...pids]) {
    if (isGroupAlive(pid)) {
      try { process.kill(-pid, 'SIGTERM'); } catch { /* raced with natural exit */ }
      setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }, 2000).unref?.();
      killed++;
    } else {
      alreadyDead++;
    }
    untrackGroup(sessionId, pid);
  }
  return { killed, alreadyDead };
}

export function hasBackgroundJobs(sessionId) {
  const pids = liveGroups.get(sessionId);
  if (!pids) return false;
  for (const pid of pids) if (isGroupAlive(pid)) return true;
  return false;
}

function resolveCwd(workspace, cwd) {
  if (!cwd) return safePath(workspace, '.');
  // mustExist: false here — the caller (runTerminal) mkdir's the resolved
  // dir right after, so a not-yet-existing cwd the model wants to create
  // is fine, but it still can't escape the workspace or hit a protected path.
  return safePath(workspace, cwd);
}

/**
 * Runs a shell command in the session workspace.
 * Accepts either `command` (a single string, may itself be multiline /
 * a heredoc) or `commandLines` (an array of lines joined with \n) —
 * mirrors the run_command tool schema: command / command_lines.
 * sessionId is used only to track this command's process group for
 * later killBackgroundJobs() calls — passing it is optional (falls back
 * to no tracking) so existing callers aren't broken.
 */
export async function runTerminal(workspace, commandInput, opts = {}) {
  const { cwd, timeoutMs = 120000, sessionId = null } = opts;

  const command = Array.isArray(commandInput)
    ? commandInput.join('\n')
    : String(commandInput ?? '');

  if (!command.trim()) throw new Error('Command is required.');
  screenCommand(command, workspace);

  await fs.mkdir(workspace, { recursive: true });
  const runDir = resolveCwd(workspace, cwd);
  await fs.mkdir(runDir, { recursive: true });

  return await new Promise((resolve, reject) => {
    // detached: true puts this child in its OWN process group (its pid
    // becomes the group id) rather than sharing this Node process's
    // group — required for the kill below to reach any grandchildren
    // the command spawns (a background job, a held-open curl, a server
    // left running) instead of only the top-level bash process.
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd: runDir,
      env: { ...process.env, PWD: runDir },
      detached: true,
    });
    if (sessionId) trackGroup(sessionId, child.pid);

    let stdout = '', stderr = '';
    let settled = false;

    function settleOnce(fn) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    }

    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* group may already be gone */ }
      setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }, 3000).unref?.();
      settleOnce(() => reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s (still running when the limit hit — check if it's waiting on input, stuck in a loop, or genuinely long-running).`)));
    }, timeoutMs);

    child.stdout.on('data', c => { stdout = (stdout + c).slice(-MAX_OUTPUT); });
    child.stderr.on('data', c => { stderr = (stderr + c).slice(-MAX_OUTPUT); });
    child.on('error', e => settleOnce(() => reject(e)));

    // Resolve on 'exit' (the bash process itself is actually done), NOT
    // 'close' (which additionally waits for stdout/stderr streams to
    // fully end). A command that backgrounds something with `&` makes
    // bash exit almost immediately, exactly as intended — but a
    // backgrounded grandchild inherits the same stdout/stderr file
    // descriptors and can keep them open for as long as IT runs. `close`
    // then doesn't fire until that grandchild finishes too, which for a
    // sleep-loop or a long-lived process means it never fires before
    // the timeout. Reproduced directly while diagnosing this: for the
    // same backgrounded command, 'exit' fired at 5ms, 'close' didn't
    // fire until 5017ms later. This was the real cause of "Terminal
    // command timed out" repeating on every attempt to background
    // anything — the promise itself was stuck waiting on a signal that
    // a background job delays or prevents outright, which is also why
    // no user "stop"/"ctrl c" message could have ended it any sooner:
    // there was no code path that resolved before the full timeout,
    // repeatedly, regardless of what was said in chat.
    //
    // The short setTimeout after 'exit' just gives same-tick foreground
    // output (the command's own direct stdout, before any `&`) a moment
    // to arrive, without waiting on a backgrounded grandchild's pipes.
    child.on('exit', (code) => {
      setTimeout(() => {
        // Only untrack if the group is actually confirmed dead — the
        // top-level bash exiting does NOT mean a backgrounded `&` job
        // inside it has also exited; that job keeps the SAME process
        // group id (it doesn't get a new one just because its parent
        // shell returned), so it's still reachable and trackable under
        // child.pid even after 'exit' fires.
        if (sessionId && !isGroupAlive(child.pid)) untrackGroup(sessionId, child.pid);
        settleOnce(() => resolve({ exitCode: code ?? 1, stdout, stderr }));
      }, 50);
    });
  });
}
