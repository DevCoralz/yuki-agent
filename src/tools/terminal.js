import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { safePath } from './workspace.js';
import { screenCommand } from './commandScreen.js';

const MAX_OUTPUT = 30000;

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
 */
export async function runTerminal(workspace, commandInput, opts = {}) {
  const { cwd, timeoutMs = 120000 } = opts;

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
    // group. That's required for the kill below to actually reach any
    // grandchildren the command itself spawns (a background process, a
    // held-open curl, anything the command starts and doesn't wait on) —
    // child.kill() alone only ever signals the single bash process,
    // never its descendants, so a command that spawns its own children
    // could leave them running (and holding memory) even after this
    // promise rejects and the caller moves on. Confirmed as a real
    // problem, not theoretical: multiple orphaned bash children were
    // found still running (SIGKILL-reaped) right before a Fly machine
    // OOM/crash, consistent with a retry loop that kept spawning new
    // commands without every previous one's full process tree having
    // actually exited yet.
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd: runDir,
      env: { ...process.env, PWD: runDir },
      detached: true,
    });
    let stdout = '', stderr = '';
    let killedForTimeout = false;
    const timer = setTimeout(() => {
      killedForTimeout = true;
      // Negative pid = signal the whole process GROUP, not just child.pid.
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* group may already be gone */ }
      // Grace period, then a hard SIGKILL to the group in case something
      // ignored SIGTERM — this is the actual fix for processes surviving
      // past the point the caller believes they've been stopped.
      setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }, 3000).unref?.();
      reject(new Error('Terminal command timed out.'));
    }, timeoutMs);
    child.stdout.on('data', c => { stdout = (stdout + c).slice(-MAX_OUTPUT); });
    child.stderr.on('data', c => { stderr = (stderr + c).slice(-MAX_OUTPUT); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      // Belt-and-suspenders: even on a normal (non-timeout) close, make
      // sure nothing this command's shell spawned is left behind in its
      // process group. Safe to call even if the group is already empty.
      if (!killedForTimeout) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* nothing left, expected in the common case */ }
      }
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
