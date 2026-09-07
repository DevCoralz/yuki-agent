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
//
// SCOPE — this only rewrites SELF-IDENTIFICATION, never a bare mention.
// The earlier version matched a bare `\bAgnes\b` (or \bGoogle\b, \bIBM\b,
// etc.) anywhere in the reply, which meant a genuinely informative answer
// to "what is Agnes AI?" or "who makes Gemma?" got its content silently
// mangled into nonsense — the user asked a real question and got a
// broken non-answer instead. A leak is specifically the MODEL CLAIMING TO
// BE (or be made by) one of these brands — "I'm Agnes", "created by
// Google", "powered by Qwen2.5" — not the brand name appearing in
// substantive content the user asked about. Each pattern below is
// therefore anchored to a self-identification frame, not a bare name.

const FALLBACK_LINE = "I'm Yuki, an AI agent by Coralz.";

// Self-identification frames a leak tends to appear in. Kept generic
// (not per-brand) so it composes with BRANDS below via a template,
// rather than needing every frame spelled out per brand.
//
// Deliberately FIRST-PERSON ONLY. An earlier draft also matched
// third-person frames like "made by X" / "powered by X" / "an AI by X"
// with no requirement that the sentence be self-referential — which
// still false-matched completely normal informative prose like "Agnes AI
// is a product made by Sapiens AI" (a real, correct answer to a real
// question, not a leak). Anchoring every frame to I/I'm/I am/my/me means
// a match only fires when the model is talking about ITSELF, which is
// the actual definition of a leak.
const SELF_ID_FRAMES = [
  (brand) => `\\bI'?m\\s+${brand}\\b`,
  (brand) => `\\bI\\s+am\\s+${brand}\\b`,
  (brand) => `\\bI\\s+was\\s+(?:made|created|built|trained|developed)\\s+by\\s+${brand}\\b`,
  (brand) => `\\bI'?m\\s+(?:made|created|built|trained|developed)\\s+by\\s+${brand}\\b`,
  (brand) => `\\bI'?m\\s+powered\\s+by\\s+${brand}\\b`,
  (brand) => `\\bmy\\s+(?:name|model)\\s+is\\s+${brand}\\b`,
  (brand) => `\\byou'?re\\s+(?:talking\\s+to|chatting\\s+with)\\s+me,?\\s+${brand}\\b`,
  (brand) => `\\bI'?m\\s+an?\\s+AI\\s+(?:model\\s+)?(?:by|from)\\s+${brand}\\b`,
];

// Brand name -> replacement identity. `name` is the regex-source for the
// brand (escape-free here since none contain regex metacharacters beyond
// spaces, which SELF_ID_FRAMES already handles with \s+); `replacement`
// is what Yuki's own identity says in that slot (Yuki for a model/agent
// name, Coralz for a company/provider name).
const BRANDS = [
  { name: 'Alibaba\\s+Cloud', replacement: 'Coralz' },
  { name: 'Alibaba', replacement: 'Coralz' },
  { name: 'Qwen\\d*(?:\\.\\d+)?[\\w-]*', replacement: 'Yuki' },
  { name: 'Qwen', replacement: 'Yuki' },
  { name: 'Tongyi\\s*Qianwen', replacement: 'Yuki' },
  { name: 'Gemma\\d*(?:\\.\\d+)?[\\w-]*', replacement: 'Yuki' },
  { name: 'Gemma', replacement: 'Yuki' },
  { name: 'Google\\s+DeepMind', replacement: 'Coralz' },
  { name: 'DeepMind', replacement: 'Coralz' },
  { name: 'Google', replacement: 'Coralz' },
  { name: 'Granite\\d*(?:\\.\\d+)?[\\w-]*', replacement: 'Yuki' },
  { name: 'Granite', replacement: 'Yuki' },
  { name: 'IBM', replacement: 'Coralz' },
  { name: 'OpenCoder[\\w.-]*', replacement: 'Yuki' },
  { name: 'Infly', replacement: 'Coralz' },
  { name: 'SmolLM\\d*(?:\\.\\d+)?[\\w-]*', replacement: 'Yuki' },
  { name: 'Hugging\\s*Face', replacement: 'Coralz' },
  // Leaks specific to whatever third-party API is currently behind
  // YUKI_API_BASE_URL. Add to this list as new leaks are observed — a
  // swapped backend can bake in any persona, so this can't be predicted
  // in advance, only patched reactively.
  { name: 'Agnes', replacement: 'Yuki' },
  { name: 'Sapiens\\s*AI', replacement: 'Coralz' },
];

// Built once at module load: every (brand x frame) combination, each
// still paired with that brand's replacement, longer/more specific brand
// patterns first (matches the old ordering rationale — a whole-phrase
// replacement reads more naturally than replacing fragments).
const LEAK_PATTERNS = BRANDS.flatMap(({ name, replacement }) =>
  SELF_ID_FRAMES.map((frame) => [new RegExp(frame(name), 'gi'), replacement]),
);

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
