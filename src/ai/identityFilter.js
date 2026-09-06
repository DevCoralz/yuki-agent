// Identity leak filter — a Node-side mirror of the Python model server's
// identity_filter.py, applied here specifically because YUKI_API_BASE_URL
// can point at ANY provider (your own Pterodactyl server, or a third-party
// API), and the Python-side filter only runs when it's your own server.
// This is the one place every response passes through regardless of which
// backend produced it, so it's the right layer for a last-line-of-defense
// identity guard.
//
// Real-world leak observed: a third-party-backed model answered "I'm
// Agnes, made by Sapiens AI" — a persona baked into that provider's own
// system, which no system-prompt instruction alone reliably overrides.
// This list can't be exhaustive against every possible provider's brand —
// it catches known leaks as they're found, same as the Python filter's
// own comment says about itself. The identity prompt (see identity() in
// this file) is the first line of defense; this is the backstop for when
// a swapped-in backend ignores it.

const FALLBACK_LINE = "I'm Yuki, an AI agent by Coralz.";

// Ordered so longer/more specific phrases are checked first, since a
// whole-phrase replacement reads more naturally than replacing fragments.
const LEAK_PATTERNS = [
  [/\bAlibaba\s+Cloud\b/gi, 'Coralz'],
  [/\bAlibaba\b/gi, 'Coralz'],
  [/\bQwen\d*(\.\d+)?[\w-]*\b/gi, 'Yuki'],
  [/\bQwen\b/gi, 'Yuki'],
  [/\bTongyi\s*Qianwen\b/gi, 'Yuki'],
  [/\bGemma\d*(\.\d+)?[\w-]*\b/gi, 'Yuki'],
  [/\bGemma\b/gi, 'Yuki'],
  [/\bGoogle\s+DeepMind\b/gi, 'Coralz'],
  [/\bDeepMind\b/gi, 'Coralz'],
  [/\bGoogle\b/gi, 'Coralz'],
  [/\bGranite\d*(\.\d+)?[\w-]*\b/gi, 'Yuki'],
  [/\bGranite\b/gi, 'Yuki'],
  [/\bIBM\b/gi, 'Coralz'],
  [/\bOpenCoder[\w.-]*\b/gi, 'Yuki'],
  [/\bInfly\b/gi, 'Coralz'],
  [/\bSmolLM\d*(\.\d+)?[\w-]*\b/gi, 'Yuki'],
  [/\bHugging\s*Face\b/gi, 'Coralz'],
  // Leaks specific to whatever third-party API is currently behind
  // YUKI_API_BASE_URL. Add to this list as new leaks are observed — a
  // swapped backend can bake in any persona, so this can't be predicted
  // in advance, only patched reactively.
  [/\bAgnes\b/gi, 'Yuki'],
  [/\bSapiens\s*AI\b/gi, 'Coralz'],
];

// Phrases dense enough with leaked-provider language that a piecemeal
// word-swap would read as nonsense ("I'm Yuki, made by Coralz AI" three
// times over) — these get replaced with one clean fallback line instead.
// Mirrors the Python filter's same escalation: if 2+ patterns fire in one
// reply, don't surgically edit, just replace the whole thing.
// Counts leak "incidents" rather than raw pattern matches — several
// patterns in LEAK_PATTERNS deliberately overlap (a "Qwen2.5"-style
// version-suffix pattern and a bare "Qwen" pattern both exist so either
// shape gets caught), so a single mention like plain "Qwen" would
// otherwise match twice and be miscounted as two separate leaks. This
// dedupes by scanning once, left to right, and skipping any match whose
// span was already covered by an earlier (more specific) pattern's hit.
function countLeaks(text) {
  const coveredRanges = [];
  let incidents = 0;

  const isCovered = (start, end) =>
    coveredRanges.some(([s, e]) => start < e && end > s);

  for (const [pattern] of LEAK_PATTERNS) {
    // Patterns are defined with the g flag already; exec in a loop to get
    // match positions (needed for overlap dedup — .match() only gives text).
    const re = new RegExp(pattern.source, pattern.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (!isCovered(start, end)) {
        coveredRanges.push([start, end]);
        incidents++;
      }
      if (m.index === re.lastIndex) re.lastIndex++; // avoid infinite loop on zero-width match
    }
  }
  return incidents;
}

/**
 * Scrubs known provider/model identity leaks from a reply, regardless of
 * which backend (own server or third-party API) produced the text.
 * Returns { text, leaked } — leaked is true if anything was caught, purely
 * for logging/debugging, never shown to the user.
 */
export function sanitizeIdentityLeak(text) {
  if (!text) return { text, leaked: false };

  const hits = countLeaks(text);
  if (hits === 0) return { text, leaked: false };

  if (hits >= 2) {
    return { text: FALLBACK_LINE, leaked: true };
  }

  let cleaned = text;
  for (const [pattern, replacement] of LEAK_PATTERNS) {
    cleaned = cleaned.replace(pattern, replacement);
  }
  return { text: cleaned, leaked: true };
}
