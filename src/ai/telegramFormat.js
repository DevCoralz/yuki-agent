// Converts standard Markdown (what most LLMs default to writing) into
// Telegram's HTML parse_mode. Telegram supports two rich-formatting
// modes — MarkdownV2 and HTML — and MarkdownV2 requires escaping a long
// list of special characters (_ * [ ] ( ) ~ ` > # + - = | { } . !)
// ANYWHERE they appear outside a formatting entity, which is fragile for
// free-form LLM output that wasn't generated with that escaping in mind
// (a stray "3.5" or "e.g." breaks MarkdownV2 rendering). HTML mode only
// needs 3 characters escaped (< > &) and supports the same bold/italic/
// code/strikethrough Telegram already renders, so it's the more robust
// choice here — this mirrors whatsappFormat.js's approach (rewrite
// standard Markdown into the target platform's real syntax) but targets
// HTML instead of WhatsApp's asterisk dialect.
//
// Telegram HTML tags used: <b>, <i>, <s>, <code>, <pre>, <a href="">.

function convertTable(tableBlock) {
  const lines = tableBlock.trim().split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return tableBlock;

  const splitRow = (line) => line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const headers = splitRow(lines[0]);
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

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Rewrites Markdown formatting into Telegram HTML. Code content is
 * extracted first (and HTML-escaped on its own, since code often
 * legitimately contains < > &), then the REMAINING plain text is
 * HTML-escaped too — this ordering matters, since escaping the whole
 * string up front would corrupt the ** / __ / ~~ markers the regexes
 * below need to match.
 */
export function markdownToTelegram(text) {
  if (!text) return text;

  // 1. Protect fenced code blocks — escape their content for HTML safety
  // and wrap in <pre>, then placeholder them out of the rest of the pipeline.
  const codeBlocks = [];
  let working = text.replace(/```(?:\w+\n)?([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(`<pre>${escapeHtml(code.replace(/\n$/, ''))}</pre>`);
    return `\u0000CODEBLOCK${codeBlocks.length - 1}\u0000`;
  });

  // 2. Protect inline code the same way, wrapped in <code>.
  const inlineCode = [];
  working = working.replace(/`([^`\n]+)`/g, (_, code) => {
    inlineCode.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000INLINECODE${inlineCode.length - 1}\u0000`;
  });

  // 3. Markdown tables -> flat list, same as the WhatsApp converter.
  working = working.replace(/(^\|.+\|[ \t]*\n\|[ \t\-:|]+\|[ \t]*\n(?:\|.*\|[ \t]*\n?)*)/gm, (m) => convertTable(m) + '\n');

  // 4. Escape HTML-significant characters in what's now plain text
  // (code is already protected as placeholders, so this can't double-escape it).
  working = escapeHtml(working);

  // 5. Headers -> bold line.
  working = working.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // 6. Bold: **text** or __text__ -> <b>text</b>.
  working = working.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  working = working.replace(/__(.+?)__/g, '<b>$1</b>');

  // 7. Italic: remaining single *text* or _text_ -> <i>text</i>.
  working = working.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '<i>$1</i>');
  working = working.replace(/(?<!_)_([^_\n]+?)_(?!_)/g, '<i>$1</i>');

  // 8. Strikethrough: ~~text~~ -> <s>text</s>.
  working = working.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // 9. Markdown links [text](url) -> <a href="url">text</a>.
  working = working.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');

  // 10. Restore protected code (already HTML-escaped and tagged above).
  working = working.replace(/\u0000INLINECODE(\d+)\u0000/g, (_, i) => inlineCode[Number(i)]);
  working = working.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, i) => codeBlocks[Number(i)]);

  return working;
}
