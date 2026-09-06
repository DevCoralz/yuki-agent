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
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd: runDir,
      env: { ...process.env, PWD: runDir },
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Terminal command timed out.'));
    }, timeoutMs);
    child.stdout.on('data', c => { stdout = (stdout + c).slice(-MAX_OUTPUT); });
    child.stderr.on('data', c => { stderr = (stderr + c).slice(-MAX_OUTPUT); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
