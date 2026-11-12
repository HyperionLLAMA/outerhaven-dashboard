// Company web check for Credit and BDC targets (13 Nov 2026, Tengku): before we message a CFO about a maturity, Google the last
// year of news for the three things that make the message wrong: it already refinanced, it already hired an adviser / banker,
// or it is being sold. Two Serper searches, pages fetched by index.ts, sentences found here in code (no LLM). Trust rule as for
// funds: a fact needs the company's name and the cue in the SAME sentence of a page we actually read (or Google's snippet).
import { htmlText, sentences } from './read.js';

const SUFFIX = /\b(inc|incorporated|corp|corporation|co|company|holdings?|group|llc|l\.?l\.?c|ltd|limited|lp|l\.?p|plc|n\.?v|s\.?a|the|intermediate|parent|topco|midco|buyer|acquisition|opco|holdco)\b\.?/gi;
// "HYDROFARM HOLDINGS GROUP, INC." -> "Hydrofarm"; "TAUC Management, LLC" -> "TAUC Management". The brand Google and the press use.
export function brand(name) {
  const s = String(name || '').replace(/\([^)]*\)/g, ' ').replace(/&amp;/g, '&').replace(/,/g, ' ').replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
  // Too short alone ("ADS Group Opco" -> "ADS" matches every "ads"): keep Group / Holdings, drop only legal and deal-vehicle words.
  const t = s.length >= 4 ? s : String(name || '').replace(/\([^)]*\)/g, ' ').replace(/,/g, ' ').replace(/\b(inc|corp|llc|l\.?l\.?c|ltd|lp|opco|holdco|midco|topco|buyer|parent)\b\.?/gi, ' ').replace(/\s+/g, ' ').trim();
  return t === t.toUpperCase() && t.length > 4 ? t.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : t;
}
// Whole words only: "ads" must not match "roads".
export const has = (text, key) => ` ${norm(text)} `.includes(` ${key} `);
export const norm = t => String(t || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

// Both searches limited to the past year (Serper tbs qdr:y): older news is already in the filings we read.
export function companyQueries(name) {
  const b = brand(name);
  return [`"${b}" refinancing OR "credit facility" OR "credit agreement" OR "term loan" OR notes`, `"${b}" "strategic alternatives" OR "financial advisor" OR acquired OR acquisition`];
}

const AMT = String.raw`(?:(?:US)?\$[\d.,]+ ?(?:million|billion|mm|m|bn|b)? )?`;
const EV = [
  ['refinanced', new RegExp(String.raw`\brefinanc(?:ed|es|ing)\b|\bnew ${AMT}(?:senior )?(?:secured )?(?:credit|term loan|revolving)[a-z ]{0,20}facilit|\bentered into (?:a |an )?(?:new |amended (?:and restated )?)?${AMT}(?:senior )?(?:secured )?(?:revolving )?(?:credit agreement|credit facilit|term loan|loan agreement|note purchase)|\bamend(?:ed|ment)? and (?:extend|extension|restate)|\bextend(?:ed|s|ing)? the maturity|\bmaturity (?:date )?(?:was |has been )?extended|\b(?:closed|completed|priced) (?:a |an |its |the )?${AMT}(?:private placement|offering of [a-z ]*notes|senior notes|notes offering|term loan|credit facilit|financing)`, 'i')],
  ['adviser', /\b(?:retained|engaged|hired|appointed|selected|tapped)\b[^.]{0,80}\b(?:as (?:its )?(?:exclusive )?(?:financial|investment banking|restructuring|capital markets|debt) advis[eo]r|to (?:advise|explore|evaluate|run|lead))|\bstrategic alternatives\b|\brestructuring advis[eo]r/i],
];
// Being sold: the company is the object ("acquired by", "agreed to acquire <name>", "acquisition of <name>"), never the buyer.
const saleRe = b => new RegExp(`${esc(b)}[^.]{0,60}\\b(?:(?:has been|was|to be|will be|is being|agreed to be|signed a definitive agreement to be) acquired|enter(?:ed|s) into a definitive (?:merger )?agreement to be acquired|to merge with)|\\b(?:acquir(?:e|es|ed|ing)|acquisition of|to buy|completed the acquisition of)\\s+(?:all (?:of the )?(?:outstanding )?(?:shares of )?)?${esc(b)}`, 'i');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Serper dates: "Mar 4, 2026", "2026-03-04", "3 weeks ago". -> YYYY-MM-DD or null.
export function dateOf(t, now = new Date()) {
  const s = String(t || '');
  const iso = s.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/); if (iso) return iso[0];
  const rel = s.match(/(\d+)\s+(hour|day|week|month|year)s?\s+ago/i);
  if (rel) { const n = +rel[1], u = rel[2].toLowerCase(), d = new Date(now); d.setUTCDate(d.getUTCDate() - n * ({ hour: 0, day: 1, week: 7, month: 30, year: 365 })[u]); return d.toISOString().slice(0, 10); }
  const p = Date.parse(s);
  if (Number.isFinite(p) && /20\d{2}/.test(s)) { const x = new Date(p), z = n => String(n).padStart(2, '0'); return `${x.getFullYear()}-${z(x.getMonth() + 1)}-${z(x.getDate())}`; }
  return null;
}

// One page (fetched text, or the Google snippet) -> facts naming this company.
export function scanCompany(name, page, now = new Date()) {
  const b = brand(name), key = norm(b), sale = saleRe(b), out = [];
  if (key.length < 3) return out;
  const date = dateOf(page.date, now), host = (() => { try { return new URL(page.url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  for (const q of sentences(page.text)) {
    if (!has(q, key)) continue;
    let ev = sale.test(q) ? 'sale' : (EV.find(([, re]) => re.test(q)) || [])[0];
    if (!ev) continue;
    out.push({ event: ev, quote: q.slice(0, 400), date, url: page.url, source: host });
  }
  return out;
}
// All pages for one company -> { at, pages, facts, refi, adviser, sale } (newest dated fact of each kind).
export function readCompany(name, pages, at = new Date().toISOString(), now = new Date()) {
  const facts = [], seen = new Set();
  for (const p of pages) for (const f of scanCompany(name, p, now)) { const k = f.event + norm(f.quote).slice(0, 120); if (!seen.has(k)) { seen.add(k); facts.push(f); } }
  const best = ev => facts.filter(f => f.event === ev).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0] || null;
  return { at: at.slice(0, 10), pages: pages.length, facts: facts.length, refi: best('refinanced'), adviser: best('adviser'), sale: best('sale') };
}
export { htmlText };
