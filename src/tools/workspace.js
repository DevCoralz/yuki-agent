// Workspace path safety — the single choke point every file/terminal tool
// resolves a user- or model-supplied path through, ported from an earlier
// agent build's `workspace.py` / `safe_path()`. Consolidates what used to
// be three separate, slightly-different containment checks scattered
// across terminal.js and mediaTools.js into one shared implementation.
//
// safePath():
//   - resolves symlinks and `..` traversal BEFORE checking containment
//     (checking containment on the raw path first is exactly what lets a
//     symlink or `../../` sequence slip through undetected)
//   - rejects anything that resolves outside the given workspace root
//   - rejects anything inside an explicitly protected path (panel files,
//     /etc, ssh keys, /proc, ...), even if the workspace root were ever
//     misconfigured to point somewhere unsafe — this is a backstop, not
//     the primary defense
//
// Every session's workspace is already its own subfolder under
// YUKI_WORKSPACE_ROOT (see sessionStore.js), so under normal operation the
// protected-paths check should never actually trigger — it exists for the
// case where it's ever wrong, not as the main safety mechanism.

import fs from 'node:fs';
import path from 'node:path';
import { environment } from '../config/environment.js';

export class UnsafePathError extends Error {}

// Node's path.resolve() is purely lexical — unlike Python's Path.resolve(),
// it does NOT follow symlinks. A symlink inside the workspace pointing
// outside it would pass a lexical-only check even though it doesn't pass
// Myra's actual Python guarantee. This walks up from the target to the
// nearest existing ancestor, resolves THAT with realpathSync (which does
// follow symlinks), then reattaches the not-yet-existing tail — giving the
// same guarantee for write targets (files that don't exist yet) as for
// reads of existing files.
function resolveRealPath(lexicallyResolved) {
  let current = lexicallyResolved;
  const tail = [];
  while (true) {
    try {
      const real = fs.realpathSync(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Hit filesystem root without finding an existing ancestor —
        // nothing to resolve symlinks against; return as-is.
        return lexicallyResolved;
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function isWithin(child, parent) {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Resolves each configured protected path once per call rather than
// caching, since these rarely change and correctness (picking up an
// updated env var without a restart) matters more than the small cost of
// re-resolving a handful of paths per tool call.
function protectedRoots(workspaceRootResolved) {
  const roots = [];
  for (const raw of environment.yukiProtectedPaths || []) {
    const resolved = resolveRealPath(path.resolve(raw));
    // Carve the workspace back out: if the workspace root sits inside (or
    // equals) a "protected" path, that protected path can't apply here,
    // or every tool call would be blocked from working inside the one
    // place it's supposed to operate.
    if (resolved === workspaceRootResolved || isWithin(workspaceRootResolved, resolved)) {
      continue;
    }
    roots.push(resolved);
  }
  return roots;
}

/**
 * Resolves `rawPath` against `workspaceRoot`, guaranteeing the result is
 * inside the workspace and outside every protected path. Throws
 * UnsafePathError otherwise.
 *
 * @param {string} workspaceRoot - absolute path to this session's workspace
 * @param {string} rawPath - path as supplied by the model/tool call, may be relative, absolute, contain .., etc.
 * @param {{mustExist?: boolean}} [opts]
 * @returns {string} the resolved, safe, absolute path
 */
export function safePath(workspaceRoot, rawPath, opts = {}) {
  const { mustExist = false } = opts;
  const root = resolveRealPath(path.resolve(workspaceRoot));

  const text = String(rawPath ?? '').trim();
  if (!text || text === '.' || text === './') {
    return root;
  }
  if (text.includes('\x00')) {
    throw new UnsafePathError('Path contains a null byte.');
  }

  const candidate = path.isAbsolute(text) ? text : path.join(root, text);
  const resolved = resolveRealPath(path.resolve(candidate));

  if (resolved !== root && !isWithin(resolved, root)) {
    throw new UnsafePathError(`Path escapes the workspace: ${text}`);
  }

  for (const protectedRoot of protectedRoots(root)) {
    if (resolved === protectedRoot || isWithin(resolved, protectedRoot)) {
      throw new UnsafePathError(`Path is protected and cannot be accessed: ${protectedRoot}`);
    }
  }

  if (mustExist && !fs.existsSync(resolved)) {
    throw new Error(`No such file or directory: ${toRelative(root, resolved)}`);
  }

  return resolved;
}

/** Workspace-relative display path — never leaks the absolute host path back to the model or user. */
export function toRelative(workspaceRoot, absolutePath) {
  const root = path.resolve(workspaceRoot);
  const rel = path.relative(root, path.resolve(absolutePath));
  if (rel === '') return '.';
  return rel;
}

export function ensureParentDir(absolutePath) {
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
}
