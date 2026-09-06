// Filesystem tools — ported from an earlier agent build's tools.py
// filesystem section. Every path goes through safePath() (see workspace.js)
// before touching the real filesystem; there is no unguarded path.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { safePath, toRelative, ensureParentDir } from './workspace.js';
import { environment } from '../config/environment.js';

// Directories skipped when walking for list_files / search_code — noise
// that would otherwise dominate output for any real project.
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv',
  'dist', 'build', '.next', '.cache',
]);

/**
 * Lists files and directories inside the workspace, breadth-limited by
 * depth. Mirrors Myra's list_files: skips noise dirs, caps output at 800
 * lines so a huge tree doesn't blow the model's context.
 */
export async function listFiles(workspace, relPath = '.', depth = 2) {
  const root = safePath(workspace, relPath, { mustExist: true });
  const stat = await fs.stat(root);
  if (stat.isFile()) {
    return `${toRelative(workspace, root)} (file, ${stat.size} bytes)`;
  }

  const maxDepth = Math.max(1, Math.min(Number.parseInt(depth, 10) || 2, 4));
  const lines = [];
  const baseDepthParts = root.split(path.sep).length;

  async function walk(dir) {
    if (lines.length > 800) return;
    const level = dir.split(path.sep).length - baseDepthParts;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = entries.filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter(e => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));

    for (const f of files) {
      const filePath = path.join(dir, f.name);
      let size = 0;
      try { size = (await fs.stat(filePath)).size; } catch { /* race: file removed mid-walk */ }
      lines.push(`${toRelative(workspace, filePath)}  (${size} B)`);
      if (lines.length > 800) { lines.push('… [listing truncated]'); return; }
    }
    if (level >= maxDepth) return;
    for (const d of dirs) {
      await walk(path.join(dir, d.name));
      if (lines.length > 800) return;
    }
  }

  await walk(root);
  return lines.join('\n') || '(empty directory)';
}

/**
 * Reads a UTF-8 text file, optionally a line range, with 1-indexed line
 * numbers prefixed (matches Myra's read_file output shape, which the model
 * needs for edit_file's exact-match requirement to be usable in practice).
 */
export async function readFile(workspace, relPath, startLine, endLine) {
  const file = safePath(workspace, relPath, { mustExist: true });
  const stat = await fs.stat(file);
  if (stat.isDirectory()) {
    throw new Error(`${toRelative(workspace, file)} is a directory — use list_files.`);
  }
  if (stat.size > environment.yukiMaxFileBytes) {
    throw new Error(`${toRelative(workspace, file)} is larger than the ${environment.yukiMaxFileBytes} byte read limit.`);
  }

  const text = await fs.readFile(file, 'utf-8');
  const lines = text.split(/\r?\n/);
  const start = Math.max(1, Number.parseInt(startLine, 10) || 1);
  const end = Math.min(lines.length, Number.parseInt(endLine, 10) || lines.length);

  const numbered = [];
  for (let i = start; i <= end; i++) numbered.push(`${i}: ${lines[i - 1]}`);
  return numbered.join('\n');
}

/** Creates or fully overwrites a text file with new content. */
export async function writeFile(workspace, relPath, content) {
  const file = safePath(workspace, relPath);
  ensureParentDir(file);
  const existed = fsSync.existsSync(file);
  const text = content ?? '';
  await fs.writeFile(file, text, 'utf-8');
  return `${existed ? 'Updated' : 'Created'} ${toRelative(workspace, file)} (${text.length} chars)`;
}

/**
 * Replaces one exact occurrence of `oldText` with `newText` inside a file.
 * Requires the snippet to appear exactly once — same design as Myra's
 * edit_file: this is what makes edits safe for a model to make blind,
 * since an ambiguous match is rejected rather than guessed at.
 */
export async function editFile(workspace, relPath, oldText, newText = '') {
  const file = safePath(workspace, relPath, { mustExist: true });
  const text = await fs.readFile(file, 'utf-8');

  if (!oldText) throw new Error('`old` must be non-empty.');
  const hits = text.split(oldText).length - 1;
  if (hits === 0) throw new Error(`Snippet not found in ${toRelative(workspace, file)}.`);
  if (hits > 1) throw new Error(`Snippet appears ${hits} times in ${toRelative(workspace, file)} — make it unique.`);

  const updated = text.replace(oldText, newText);
  await fs.writeFile(file, updated, 'utf-8');
  return `Edited ${toRelative(workspace, file)}`;
}

/** Deletes a file or an entire directory inside the workspace. */
export async function deletePath(workspace, relPath) {
  const target = safePath(workspace, relPath, { mustExist: true });
  const root = safePath(workspace, '.');
  if (target === root) {
    throw new Error('Refusing to delete the workspace root.');
  }
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    await fs.rm(target, { recursive: true, force: true });
    return `Deleted directory ${toRelative(workspace, target)}`;
  }
  await fs.unlink(target);
  return `Deleted ${toRelative(workspace, target)}`;
}

/** Moves or renames a file/directory inside the workspace. */
export async function movePath(workspace, sourceRel, destRel) {
  const src = safePath(workspace, sourceRel, { mustExist: true });
  const dst = safePath(workspace, destRel);
  ensureParentDir(dst);
  await fs.rename(src, dst);
  return `Moved ${toRelative(workspace, src)} -> ${toRelative(workspace, dst)}`;
}

/**
 * Regex search across workspace files. Returns matching file:line snippets,
 * capped at 200 matches. Skips files over the read-size limit and the same
 * noise directories as list_files.
 */
export async function searchCode(workspace, pattern, relPath = '.', glob) {
  const root = safePath(workspace, relPath, { mustExist: true });

  let regex;
  try {
    regex = new RegExp(pattern);
  } catch (e) {
    throw new Error(`Invalid regex: ${e.message}`);
  }

  // Minimal glob support: only the simple "*.ext" / "prefix*" shapes Myra's
  // own glob param realistically sees from a model, not a full glob engine.
  let globRegex = null;
  if (glob) {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    globRegex = new RegExp(`^${escaped}$`);
  }

  const results = [];
  let truncated = false;

  async function walk(dir) {
    if (results.length >= 200) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= 200) { truncated = true; return; }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (globRegex && !globRegex.test(entry.name)) continue;

      let stat;
      try { stat = await fs.stat(full); } catch { continue; }
      if (stat.size > environment.yukiMaxFileBytes) continue;

      let text;
      try { text = await fs.readFile(full, 'utf-8'); } catch { continue; }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push(`${toRelative(workspace, full)}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
          if (results.length >= 200) { truncated = true; break; }
        }
      }
    }
  }

  await walk(root);
  if (!results.length) return 'No matches.';
  return results.join('\n') + (truncated ? '\n… [more matches omitted]' : '');
}
