// Converts standard Markdown (what most LLMs default to writing) into
// WhatsApp's own, much smaller formatting syntax. WhatsApp does not render
// GitHub-style Markdown at all — **bold**, ## headers, and | tables show
// up as literal asterisks/hashes/pipes to the reader. This is the reliable
// fix (a real converter) sitting alongside the identity prompt's own
// instruction to write correctly in the first place — same two-layer
// approach as identityFilter.js, since a small/third-party model won't
// reliably follow "use single asterisks" 100% of the time on its own.
//
// WhatsApp's real formatting (confirmed against current WhatsApp docs):
//   *bold*          (single asterisk, not **)
//   _italic_        (underscore, not *italic* or __italic__)
//   ~strikethrough~ (single tilde, not ~~)
//   `inline code`   (single backtick)
//   ```code block```(triple backtick — same as Markdown, no change needed)
//   - / * bullet list, 1. numbered list, > block quote (same leading chars as Markdown)
//   NO table syntax exists in WhatsApp at all — a Markdown table has no
//   direct equivalent and gets converted into a plain indented list instead.

/**
 * Converts a single Markdown table into a flat list, since WhatsApp has no
 * table rendering at all. Format: for each data row, "Header: value" pairs
 * joined by " — ", one row per line. Falls back to leaving the row as
 * plain text (pipes stripped) if the header row can't be parsed.
 */
function convertTable(tableBlock) {
  const lines = tableBlock.trim().split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return tableBlock; // not really a table, leave as-is

  const splitRow = (line) => line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const headers = splitRow(lines[0]);
  // lines[1] is the "---|---|---" separator row — skip it
  const dataRows = lines.slice(2).map(splitRow);

  if (!headers.length || headers.every(h => !h)) return tableBlock;

  const out = [];
  for (const row of dataRows) {
    const parts = headers.map((h, i) => {
      const cell = row[i] ?? '';
      return h ? `${h}: ${cell}` : cell;
    }).filter(Boolean);
    if (parts.length) out.push(`- ${parts.join(' — ')}`);
  }
  return out.join('\n');
}

/**
 * Rewrites Markdown formatting into WhatsApp's syntax. Order matters —
 * bold/italic conversions must not touch text already inside a code
 * block, so code blocks are extracted and replaced with placeholders
 * before any other regex runs, then restored untouched at the end.
 */
export function markdownToWhatsApp(text) {
  if (!text) return text;

  // 1. Protect fenced code blocks (```...```) from every other rule —
  // code content should never have *bold*/_italic_ applied inside it.
  const codeBlocks = [];
  let working = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\u0000CODEBLOCK${codeBlocks.length - 1}\u0000`;
  });

  // 2. Protect inline code (`...`) the same way, separately from blocks.
  const inlineCode = [];
  working = working.replace(/`[^`\n]+`/g, (match) => {
    inlineCode.push(match);
    return `\u0000INLINECODE${inlineCode.length - 1}\u0000`;
  });

  // 3. Markdown tables -> flat list (must run before header/bullet rules,
  // since a table row looks like "| a | b |" which nothing else handles).
  working = working.replace(/(^\|.+\|[ \t]*\n\|[ \t\-:|]+\|[ \t]*\n(?:\|.*\|[ \t]*\n?)*)/gm, (m) => convertTable(m) + '\n');

  // 4. Headers (#, ##, ###...) -> bold line. WhatsApp has no heading
  // concept, so bold is the closest equivalent emphasis.
  working = working.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // 5. Bold: **text** or __text__ -> *text* (WhatsApp bold is single-char).
  //    Must run before italic, since *text* (single) is ALSO valid
  //    Markdown italic-ish and would otherwise be double-processed.
  working = working.replace(/\*\*(.+?)\*\*/g, '*$1*');
  working = working.replace(/__(.+?)__/g, '*$1*');

  // 6. Strikethrough: ~~text~~ -> ~text~
  working = working.replace(/~~(.+?)~~/g, '~$1~');

  // 7. Restore protected inline code and code blocks.
  working = working.replace(/\u0000INLINECODE(\d+)\u0000/g, (_, i) => inlineCode[Number(i)]);
  working = working.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, i) => codeBlocks[Number(i)]);

  return working;
}
