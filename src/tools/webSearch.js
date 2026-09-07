// Keyless web search, in three layers:
//
// 1. DuckDuckGo Instant Answer API (api.duckduckgo.com) — official, free,
//    no key, no published rate limit. But it only returns curated
//    abstracts/definitions/calculator answers, NOT general search results.
//    Most ordinary queries ("latest news about X", "how do I do Y") return
//    nothing here — that's expected, not a bug.
//
// 2. Wikipedia's official REST API (en.wikipedia.org/w/rest.php) — also
//    official, free, no key, genuinely stable (not scraped HTML — a real
//    documented JSON API). Added specifically because it's a much more
//    reliable path for FACTUAL/definitional queries ("who is X", "what is
//    Y", "when did Z happen") than the scraping fallback below, and covers
//    exactly the case that was failing: asking for a fact and getting
//    nothing back, because layer 1 has no article and layer 3 (below) had
//    silently hit a bot-block page.
//
// 3. DuckDuckGo HTML results page (html.duckduckgo.com/html/) — UNOFFICIAL,
//    undocumented, no key. Broadest coverage (general search, not just
//    facts/definitions), used as the last resort. This is confirmed
//    fragile in practice, not just theoretically: DuckDuckGo can serve an
//    anti-bot/CAPTCHA "anomaly" page instead of real results, especially
//    from datacenter IPs (which a Fly.io box is) rather than residential
//    ones — every serious independent implementation of this same scrape
//    explicitly checks for that page and treats it as a distinct failure,
//    not a plain empty result. This tool now does that check too — see
//    isBlockedPage() — instead of silently reporting "no results" when the
//    real cause was a bot-block page, which is exactly what was happening
//    before and made a real block indistinguishable from a genuine miss.
//
// If all three layers come back empty, the tool returns a clear "no
// results" object (with the REAL reason, e.g. "blocked" vs "genuinely no
// matches") rather than throwing — a search miss is a normal outcome the
// model should handle gracefully, not an error state.

const INSTANT_ANSWER_URL = 'https://api.duckduckgo.com/';
const WIKIPEDIA_SEARCH_URL = 'https://en.wikipedia.org/w/rest.php/v1/search/page';
const HTML_SEARCH_URL = 'https://html.duckduckgo.com/html/';
const FETCH_TIMEOUT_MS = 10000;
const MAX_HTML_RESULTS = 5;

// A plain fetch() with no User-Agent is more likely to get flagged as a
// bot immediately. This doesn't make the scrape "official" or guarantee
// anything — it just matches what a real browser sends.
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// DuckDuckGo serves this instead of real results when it thinks the
// request is automated — confirmed against multiple independent
// implementations of this exact scrape, all of which check for this
// specifically rather than treating it as zero results. A blocked page
// has none of the real result markup, so checking for its absence AND
// these markers avoids ever mistaking "confirmed blocked" for "confirmed
// no matches" — the two need different handling (retry later / note a
// real key may be needed, vs. just telling the user nothing was found).
function isBlockedPage(html) {
  return /anomaly-modal|unusual traffic|detected unusual|bots use duckduckgo too/i.test(html)
    && !/class="result__a"/.test(html);
}

async function tryInstantAnswer(query) {
  const url = `${INSTANT_ANSWER_URL}?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const response = await fetchWithTimeout(url, {
    headers: { 'User-Agent': BROWSER_USER_AGENT },
  });
  if (!response.ok) return null;

  const data = await response.json();

  const results = [];
  if (data.AbstractText) {
    results.push({
      title: data.Heading || query,
      snippet: data.AbstractText,
      url: data.AbstractURL || null,
      source: data.AbstractSource || 'DuckDuckGo Instant Answer',
    });
  }
  if (data.Answer) {
    results.push({ title: 'Direct answer', snippet: data.Answer, url: null, source: 'DuckDuckGo' });
  }
  if (data.Definition) {
    results.push({
      title: 'Definition',
      snippet: data.Definition,
      url: data.DefinitionURL || null,
      source: data.DefinitionSource || 'DuckDuckGo',
    });
  }
  for (const topic of (data.RelatedTopics || [])) {
    if (topic.Text && topic.FirstURL) {
      results.push({ title: topic.Text.split(' - ')[0], snippet: topic.Text, url: topic.FirstURL, source: 'DuckDuckGo' });
    }
    if (results.length >= MAX_HTML_RESULTS) break;
  }

  return results.length ? results : null;
}

// Extracts result blocks from DuckDuckGo's HTML results page. This is
// regex-based, not a real HTML parser — the page structure is simple and
// stable enough for this to work today, but it's exactly the kind of thing
// that silently breaks if DuckDuckGo changes their markup. If results
// start consistently coming back empty from this layer, that's the first
// thing to check (fetch the URL manually and look for structure changes).
function parseHtmlResults(html) {
  const results = [];
  // Each result lives in <a class="result__a" href="...">Title</a> followed
  // later by <a class="result__snippet" ...>snippet text</a>. We take them
  // as parallel ordered lists rather than trying to scope to one containing
  // block, since DDG's HTML nesting varies slightly per result type.
  const titleLinkPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gs;
  const snippetPattern = /<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/gs;

  const stripTags = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const decodeEntities = (s) =>
    s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

  const titles = [];
  let m;
  while ((m = titleLinkPattern.exec(html)) && titles.length < MAX_HTML_RESULTS) {
    // DDG's HTML result links route through a redirect wrapper
    // (//duckduckgo.com/l/?uddg=<encoded-real-url>&...) rather than the
    // real URL directly — unwrap it so the model gets a usable link.
    let href = m[1];
    const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch) {
      try { href = decodeURIComponent(uddgMatch[1]); } catch { /* leave as-is if malformed */ }
    } else if (href.startsWith('//')) {
      href = 'https:' + href;
    }
    titles.push({ url: href, title: decodeEntities(stripTags(m[2])) });
  }

  const snippets = [];
  while ((m = snippetPattern.exec(html)) && snippets.length < MAX_HTML_RESULTS) {
    snippets.push(decodeEntities(stripTags(m[1])));
  }

  for (let i = 0; i < titles.length; i++) {
    results.push({
      title: titles[i].title,
      url: titles[i].url,
      snippet: snippets[i] || '',
      source: 'DuckDuckGo Search',
    });
  }
  return results;
}

/**
 * Wikipedia's official search REST API — a real documented JSON endpoint,
 * not scraped HTML, so it doesn't share the CAPTCHA/markup-drift fragility
 * of the HTML fallback below. Best for factual/definitional/biographical
 * queries; won't help with current news, prices, or anything Wikipedia
 * wouldn't have an article on — that's still what layer 3 is for.
 */
async function tryWikipedia(query) {
  const url = `${WIKIPEDIA_SEARCH_URL}?q=${encodeURIComponent(query)}&limit=${MAX_HTML_RESULTS}`;
  const response = await fetchWithTimeout(url, {
    // Wikipedia's own REST API docs and etiquette expect a real
    // identifying User-Agent here, not a browser-spoofed one (unlike the
    // DuckDuckGo scrape below, where that's the whole point) — this is
    // a legitimate, welcomed API client, not something trying to look
    // like a browser.
    headers: { 'User-Agent': 'YukiAgent/1.0 (WhatsApp assistant; keyless search fallback)', Accept: 'application/json' },
  });
  if (!response.ok) return null;

  const data = await response.json();
  const pages = data?.pages || [];
  if (!pages.length) return null;

  return pages.map(p => ({
    title: p.title,
    snippet: (p.excerpt || '').replace(/<[^>]+>/g, ''), // API wraps matched terms in <span>, strip for plain text
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.key)}`,
    source: 'Wikipedia',
  }));
}

async function tryHtmlSearch(query) {
  const response = await fetchWithTimeout(HTML_SEARCH_URL, {
    method: 'POST',
    headers: {
      'User-Agent': BROWSER_USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `q=${encodeURIComponent(query)}`,
  });
  if (!response.ok) return { results: null, blocked: false };

  const html = await response.text();
  if (isBlockedPage(html)) return { results: null, blocked: true };

  const results = parseHtmlResults(html);
  return { results: results.length ? results : null, blocked: false };
}

/**
 * Searches the web for `query` across three keyless layers — DuckDuckGo
 * Instant Answer (curated facts/definitions), Wikipedia (general facts,
 * official API), DuckDuckGo HTML scrape (broadest, least reliable) — in
 * that order, stopping at the first that returns something. Never throws
 * on a search miss — returns { results: [], note: '...' } instead, so the
 * model can tell the user plainly rather than the tool call erroring out.
 * The note distinguishes a confirmed bot-block from a genuine "nothing
 * found", since those need different framing to the user (retry later /
 * a real API key may help, vs. this topic just isn't out there).
 */
export async function webSearch(query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('A search query is required.');

  try {
    const results = await tryInstantAnswer(q);
    if (results) return { results, source: 'instant_answer' };
  } catch {
    // Instant Answer API being unreachable isn't fatal — fall through.
  }

  try {
    const results = await tryWikipedia(q);
    if (results) return { results, source: 'wikipedia' };
  } catch {
    // Wikipedia being unreachable isn't fatal either — fall through to the scrape.
  }

  let blocked = false;
  try {
    const html = await tryHtmlSearch(q);
    if (html.results) return { results: html.results, source: 'html_fallback' };
    blocked = html.blocked;
  } catch (e) {
    return {
      results: [],
      note: `Search failed: ${e?.message || 'unknown error'}. This uses keyless search paths that can be temporarily unreachable — if this keeps happening, a real search API key may be needed.`,
    };
  }

  return {
    results: [],
    note: blocked
      ? 'The search backend returned a bot-block page instead of results (this happens sometimes on shared hosting IPs) — this is a temporary block, not confirmation that nothing exists for this query. Worth trying again shortly, or rephrasing.'
      : 'No search results found for this query across all available sources.',
  };
}
