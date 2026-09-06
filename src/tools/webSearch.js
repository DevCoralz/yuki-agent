// Keyless web search, in two layers:
//
// 1. DuckDuckGo Instant Answer API (api.duckduckgo.com) — official, free,
//    no key, no published rate limit. But it only returns curated
//    abstracts/definitions/calculator answers, NOT general search results.
//    Most ordinary queries ("latest news about X", "how do I do Y") return
//    nothing here — that's expected, not a bug.
//
// 2. DuckDuckGo HTML results page (html.duckduckgo.com/html/) — UNOFFICIAL,
//    undocumented, no key. This is what actually returns real search
//    results, used only as a fallback when step 1 comes back empty. It can
//    break silently if DuckDuckGo changes their HTML markup (no changelog,
//    no warning — you'll just start getting empty results), and heavy use
//    from one IP risks a CAPTCHA/bot-block page instead of results.
//    Community reports suggest this can trigger under ~30 requests/minute
//    from a single IP — this is a shared box, so stay well under that.
//
// If both layers come back empty, the tool returns a clear "no results"
// object rather than throwing — a search miss is a normal outcome the
// model should handle gracefully, not an error state.

const INSTANT_ANSWER_URL = 'https://api.duckduckgo.com/';
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

async function tryHtmlSearch(query) {
  const response = await fetchWithTimeout(HTML_SEARCH_URL, {
    method: 'POST',
    headers: {
      'User-Agent': BROWSER_USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `q=${encodeURIComponent(query)}`,
  });
  if (!response.ok) return null;

  const html = await response.text();
  const results = parseHtmlResults(html);
  return results.length ? results : null;
}

/**
 * Searches the web for `query`. Tries the official Instant Answer API
 * first; falls back to the unofficial HTML results page only if that
 * comes back empty. Never throws on a search miss — returns
 * { results: [], note: '...' } instead, so the model can tell the user
 * plainly rather than the tool call erroring out.
 */
export async function webSearch(query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('A search query is required.');

  let results = null;
  let usedFallback = false;

  try {
    results = await tryInstantAnswer(q);
  } catch {
    // Instant Answer API being unreachable isn't fatal — fall through to HTML.
  }

  if (!results) {
    usedFallback = true;
    try {
      results = await tryHtmlSearch(q);
    } catch (e) {
      return {
        results: [],
        note: `Search failed: ${e?.message || 'unknown error'}. This uses a keyless, unofficial search path that can be temporarily blocked — if this keeps happening, a real search API key may be needed.`,
      };
    }
  }

  if (!results || !results.length) {
    return {
      results: [],
      note: 'No search results found for this query.',
    };
  }

  return { results, source: usedFallback ? 'html_fallback' : 'instant_answer' };
}
