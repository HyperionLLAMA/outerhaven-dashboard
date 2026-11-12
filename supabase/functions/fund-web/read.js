// fund-web read rules: turns Exa search results into checked facts about one fund (13 Nov 2026, Tengku).
// Form D lags: a fund that closed may never amend, and the next fund is often announced before it files. The web check asks
// three things: did THIS fund hold a final close (and for how much), has the manager announced a NEWER fund, and what is the
// firm's total AUM. Plain JS so it runs in the edge function and in Node tests (scripts/tests/test_fund_web.mjs).
//
// Trust rule: Exa's summary is written by an LLM, so nothing is taken from it directly. A fact counts only when its quote is
// found word for word in the page text AND the page names the manager. Amounts are read from the quote itself, never from the
// LLM's number field. A page that only repeats Form D numbers (SEC mirrors) is excluded at search time.

const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
const WORD = { one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4, five: 5, fifth: 5 };
export const EXCLUDE = ['sec.gov', 'formds.com', 'capedge.com', 'fintel.io', 'disclosurequest.com', 'secdatabase.com', 'privatefunddata.com', 'whalewisdom.com'];

// What Exa's summary model fills in for each page.
export const SCHEMA = {
  type: 'object',
  properties: {
    about_manager: { type: 'boolean', description: 'true only if the page is about the investment firm named in the request' },
    events: {
      type: 'array',
      description: 'Every fund close, launch or fundraise of this firm mentioned on the page',
      items: {
        type: 'object',
        properties: {
          fund_name: { type: 'string', description: 'fund name as written, e.g. "Acme Ventures Fund II"' },
          event: { type: 'string', enum: ['final_close', 'first_close', 'interim_close', 'launch', 'raising', 'other'] },
          date: { type: 'string', description: 'date of the event as written on the page' },
          quote: { type: 'string', description: 'the exact sentence from the page that states this, copied word for word' },
        },
        required: ['fund_name', 'event', 'quote'],
      },
    },
    aum_quote: { type: 'string', description: "exact sentence from the page stating the firm's total assets under management, if any" },
  },
  required: ['about_manager', 'events'],
};

const norm = t => String(t || '').toLowerCase().replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
// The fund's own words, without the legal suffix: "Ground Game Venture Fund I, L.P." -> "Ground Game Venture Fund I".
export const cleanName = n => String(n || '').replace(/\([^)]*\)/g, ' ').replace(/,?\s*\b(l\.?\s?p\.?|llc|l\.?l\.?c\.?|ltd|inc|scsp)\b\.?/gi, ' ').replace(/[,\s]+$/, '').replace(/\s+/g, ' ').trim();
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

// Fund number from a name or sentence: "Fund II", "Fund 2", "second fund", "Fund III-A".
export function fundNo(text) {
  const t = String(text || '');
  let m = t.match(/\bfund\s+([IVX]{1,4})(?:-[A-Z0-9]+)?\b/i) || t.match(/\b([IVX]{1,4})(?:-[A-Z0-9]+)?\s*,?\s*(?:l\.?p\.?|llc)?\s*$/i);
  if (m && ROMAN[m[1].toUpperCase()]) return ROMAN[m[1].toUpperCase()];
  m = t.match(/\bfund\s+(\d{1,2})\b/i); if (m) return +m[1];
  m = t.match(/\b(first|second|third|fourth|fifth)\s+(?:\w+\s+)?fund\b/i); if (m) return WORD[m[1].toLowerCase()];
  return 0;
}

// USD amounts in a sentence, in order: "$45 million", "$45M", "US$1.2 billion", "$450mm".
function amounts(text) {
  const re = /(?:US)?\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(billion|bn|b|million|mm|mn|m|thousand|k)?\b/gi, out = [];
  let m;
  while ((m = re.exec(String(text || '')))) {
    const n = Number(m[1].replace(/,/g, '')), u = (m[2] || '').toLowerCase();
    const v = /^(billion|bn|b)$/.test(u) ? n * 1e9 : /^(million|mm|mn|m)$/.test(u) ? n * 1e6 : /^(thousand|k)$/.test(u) ? n * 1e3 : n;
    if (Number.isFinite(v) && v >= 1e5) out.push({ v, at: m.index });
  }
  return out;
}
// The amount that belongs to the cue: the first one after it ("closed Fund II at $50M, bringing AUM to $120M" -> $50M for a
// close, $120M for AUM), else the one nearest before it, else the first in the sentence. null when there is none.
export function amountNear(text, cue) {
  const a = amounts(text);
  if (!a.length) return null;
  const m = String(text || '').match(cue);
  if (!m) return a[0].v;
  const after = a.find(x => x.at >= m.index), before = a.filter(x => x.at < m.index).pop();
  return (after && (!before || after.at - m.index <= 120) ? after : before || after).v;
}
export const moneyIn = t => amountNear(t, /$^/);
const CLOSE = /clos(?:e|ed|ing)|raised|oversubscribed|commitments/i, AUM = /assets under management|\baum\b|in assets|manages/i;

// Two searches per fund. The first uses the fund's own name; the second the people named on the Form D (managers often
// announce a new fund under the firm or a partner's name, not the old fund's legal name).
export function queriesFor(s) {
  const name = cleanName(s.company_name), kw = s.check_keyword || name;
  const who = (s.executives || []).map(p => p.name).filter(Boolean).slice(0, 2).join(' ');
  const since = (s.first_sale || s.filing_date || '').slice(0, 10) || null;
  const q = [{ query: `${name} fund close announcement`, since }];
  q.push({ query: `${who ? who + ' ' : ''}${kw} investment firm new fund close assets under management`, since: null });
  return q;
}
export const summaryQuery = s => `About the investment firm "${s.check_keyword || cleanName(s.company_name)}"${(s.executives || [])[0]?.name ? ` (people: ${(s.executives || []).slice(0, 3).map(p => p.name).join(', ')})` : ''}: list every fund close, launch or fundraise of this firm on the page, with the exact sentence, and the exact sentence giving the firm's total assets under management.`;

const parseSummary = r => { try { return typeof r.summary === 'string' ? JSON.parse(r.summary) : r.summary || null; } catch { return null; } };
const dateOf = (txt, published) => {
  const t = String(txt || ''), iso = t.match(/\b(20\d{2})-(\d{2})(?:-(\d{2}))?\b/);
  if (iso) return iso[0];
  const d = Date.parse(t);
  if (Number.isFinite(d) && /20\d{2}/.test(t)) { const x = new Date(d), p = n => String(n).padStart(2, '0'); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`; }  // local parse, local date
  const y = t.match(/\b(20\d{2})\b/);
  return y ? y[1] : published ? String(published).slice(0, 10) : null;
};

// results = Exa result objects ({ url, title, publishedDate, text, summary }) from all queries for one fund.
export function readResults(s, results, at = new Date().toISOString()) {
  const kw = norm(s.check_keyword || cleanName(s.company_name)), mine = s.fund_no || 1;
  const facts = [], seen = new Set();
  let aum = null, pages = 0;
  for (const r of results || []) {
    if (!r?.url || seen.has(r.url) || EXCLUDE.includes(host(r.url))) continue;
    seen.add(r.url); pages++;
    const text = norm(r.text), title = norm(r.title), sum = parseSummary(r);
    if (!sum || !text || !kw || !(text.includes(kw) || title.includes(kw))) continue;   // the page must name the manager
    const ok = q => { const n = norm(q); return n.length >= 20 && text.includes(n); };
    for (const e of Array.isArray(sum.events) ? sum.events : []) {
      if (!e?.quote || !ok(e.quote)) continue;
      const no = fundNo(e.fund_name) || fundNo(e.quote);
      // The fund named must be this manager's: its name (or the quote) carries the manager keyword.
      if (!no || !(norm(e.fund_name).includes(kw) || norm(e.quote).includes(kw))) continue;
      facts.push({ fund_no: no, event: e.event, amount: amountNear(e.quote, CLOSE), date: dateOf(e.date, r.publishedDate), quote: String(e.quote).trim().slice(0, 400), url: r.url, source: host(r.url) });
    }
    if (sum.aum_quote && ok(sum.aum_quote) && AUM.test(sum.aum_quote)) {
      const v = amountNear(sum.aum_quote, AUM), d = r.publishedDate || '';
      if (v && (!aum || d > aum.published)) aum = { amount: v, quote: String(sum.aum_quote).trim().slice(0, 400), url: r.url, source: host(r.url), published: d.slice(0, 10) };
    }
  }
  const rank = { final_close: 3, interim_close: 2, first_close: 2, launch: 1, raising: 1, other: 0 };
  const best = list => list.sort((a, b) => (rank[b.event] || 0) - (rank[a.event] || 0) || String(b.date).localeCompare(String(a.date)))[0] || null;
  const own = facts.filter(f => f.fund_no === mine);
  const final = best(own.filter(f => f.event === 'final_close'));
  const first = final ? null : best(own.filter(f => f.event === 'first_close' || f.event === 'interim_close'));
  const top = Math.max(0, ...facts.map(f => f.fund_no));
  const later = top > mine ? best(facts.filter(f => f.fund_no === top)) : null;
  return { at: at.slice(0, 10), pages, facts: facts.length, final, first, later, aum };
}

// ---- Serper (Google results) path, 13 Nov 2026: ~10x cheaper than Exa. Serper returns links + snippets only, so the edge
// function fetches the pages and this code finds the sentences itself (no LLM at all). scanPage() turns a page into the same
// shape Exa returns, so readResults() and its trust rule (quote on the page, page names the manager) apply unchanged.
const R = n => Object.keys(ROMAN).find(k => ROMAN[k] === n) || String(n);
// "Ground Game Venture Fund I, L.P." -> "Ground Game Venture": the firm, for quoted Google searches.
export const firmName = s => cleanName(s.company_name).replace(/\s+(?:fund\s+)?(?:[IVX]{1,4}|\d{1,2})(?:-[A-Z0-9]+)?$/i, '').replace(/\s+fund$/i, '').trim() || s.check_keyword || '';
// Three searches: this fund's close, the next fund, the firm + a named partner (AUM, renamed funds).
export function serperQueries(s) {
  const firm = firmName(s), n = s.fund_no || 1, who = (s.executives || [])[0]?.name || '';
  return [`"${firm}" "Fund ${R(n)}" close`, `"${firm}" "Fund ${R(n + 1)}"`, `"${firm}"${who ? ` "${who}"` : ''} fund assets under management`];
}
export const htmlText = html => String(html || '').replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|h\d|td|tr)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&#8217;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;|&#8220;|&#8221;/g, '"')
  .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, '-').replace(/&#36;/g, '$').replace(/[ \t\r\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
export const sentences = text => String(text || '').split(/\n+|(?<=[.!?])\s+(?=[A-Z"“$])/).map(x => x.replace(/\s+/g, ' ').trim()).filter(x => x.length >= 20 && x.length <= 600);
// Event words, most specific first: an explicit "final close" beats a generic "closed".
const CUES = [[/final close|final closing/i, 'final_close'], [/first close|initial close|first closing/i, 'first_close'], [/interim close|second close/i, 'interim_close'],
  [/\bclosed\b[^.]{0,60}\bfund\b|\bfund\b[^.]{0,60}\b(?:closed|oversubscribed)\b|hard cap/i, 'final_close'], [/\blaunch(?:es|ed|ing)?\b|\b(?:is|now|began|begins) raising\b|\btargeting \$/i, 'launch']];
export function scanPage(s, page) {
  const kw = norm(s.check_keyword || cleanName(s.company_name)), all = sentences(page.text), events = [];
  for (const q of all) {
    if (!norm(q).includes(kw) || !fundNo(q)) continue;
    const ev = CUES.find(([re]) => re.test(q));
    if (ev) events.push({ fund_name: q, event: ev[1], quote: q });
  }
  const aumQ = all.filter(q => AUM.test(q) && amounts(q).length).sort((a, b) => norm(b).includes(kw) - norm(a).includes(kw))[0];
  return { url: page.url, title: page.title || '', publishedDate: page.date || null, text: all.join('\n'), summary: JSON.stringify({ about_manager: true, events, aum_quote: aumQ || '' }) };
}
