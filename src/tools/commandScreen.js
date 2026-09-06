// Command screening — the ONLY restriction is reaching outside the
// session's own workspace/panel files (see DENY_PATTERNS below for the
// exact policy and why it's scoped this way). Everything else — package
// installs, git push, running tests, whatever a real dev workflow needs —
// is fully allowed, by explicit choice: this agent should have complete
// command capability within its own session, no broader restriction.
//
// This exists because `cwd` alone (the only thing terminal.js checked
// before) cannot contain a real shell — `cd ..` in the command TEXT
// bypasses a cwd check entirely, since cwd only sets bash's starting
// directory, not what it can do once running. That gap is what let a
// real Pterodactyl server get suspended: the agent reached
// /home/container (panel files, session keys, .env credentials) via a
// plain `cd ..` that nothing screened.
//
// Note the honest limit here: this blocks the shell-level mechanism that
// actually caused the incident, not every conceivable way a command could
// reach outside the workspace (a script using its own language's file I/O
// rather than a shell cd/path would not be caught by this). Real OS-level
// sandboxing (bubblewrap/user namespaces) would close that gap fully, but
// depends on the specific Pterodactyl node's Docker/kernel config and is
// a separate, unresolved investigation — not something this file claims
// to provide.

export class CommandBlockedError extends Error {}

// Per explicit instruction: the ONLY thing this blocks is reaching outside
// the session's own workspace/panel files. Every other command — sudo,
// package managers, git push, curl, whatever a real dev workflow needs —
// is allowed. This is a narrower, more honest boundary than a general
// "dangerous command" blocklist: it doesn't pretend to guarantee safety
// against every possible way a command could reach outside the workspace
// (e.g. a script reading a file via its own language's file I/O, not a
// shell command name) — it blocks the SPECIFIC mechanism that actually
// caused a real incident (cd .. / absolute paths into /home/container),
// not a broad "scary command names" list.
const DENY_PATTERNS = [
  [/\/home\/container/, 'Pterodactyl panel files are off limits'],
  [/\b(pterodactyl|wings)\b/, 'Pterodactyl panel files are off limits'],
  // cd / pushd to an absolute or parent-relative path is the exact
  // mechanism observed escaping the workspace ("cd .." then reading
  // /home/container/*) — block it outright rather than trying to
  // enumerate every possible destination it could reach.
  [/\bcd\s+(\.\.|\/|~)/, 'changing directory outside the workspace'],
  [/\bpushd\s+(\.\.|\/|~)/, 'changing directory outside the workspace'],
];

/**
 * Throws CommandBlockedError if `command` matches a denied pattern.
 * `workspacePath` mentions are blanked out first so operating inside the
 * session's own workspace never false-triggers the panel-protection
 * patterns — only references to panel paths OUTSIDE the workspace still do.
 */
export function screenCommand(command, workspacePath) {
  const text = String(command || '').trim();
  if (!text) throw new CommandBlockedError('Empty command.');
  if (text.length > 4000) throw new CommandBlockedError('Command is too long.');

  const lowered = text.toLowerCase();
  const workspaceLower = workspacePath ? String(workspacePath).toLowerCase() : '';
  const screened = workspaceLower ? lowered.split(workspaceLower).join('') : lowered;

  for (const [pattern, reason] of DENY_PATTERNS) {
    if (pattern.test(screened)) {
      throw new CommandBlockedError(`Blocked by guardrails (${reason}).`);
    }
  }
}
