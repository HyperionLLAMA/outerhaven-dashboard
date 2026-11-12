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
// Strong verbs only: "acquired Microvast securities" (a class-action notice) and "reasons to buy X stock" are not a sale.
const saleRe = b => new RegExp(`${esc(b)}[^.]{0,60}\\b(?:(?:has been|was|to be|will be|is being|agreed to be|signed a definitive agreement to be) acquired|enter(?:ed|s) into a definitive (?:merger )?agreement to be acquired|to merge with)|\\b(?:(?:agreed|agreement|deal|offer) to acquire|completed (?:its |the )?acquisition of|(?:announced|closed|completes|completed) (?:its |the )?(?:pending )?(?:sale|purchase|acquisition) of)\\s+${esc(b)}(?!\\s+(?:securities|shares|stock|common|notes))`, 'i');
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

// ---- Who holds the job now (13 Nov 2026, Tengku: the 10-Q signer is often gone; the CEO often covers as interim CFO). Same
// patterns as change_people() in scripts/officers.py (8-K Item 5.02 text); here they read news sentences. Names need first + last.
const NAME = String.raw`(?:(?:Mr|Ms|Mrs|Dr)\.\s+)?(?!(?:The|On|In|As|At|By|Effective|Following|Our|Its|Their|Mr|Ms|Mrs|Dr|January|February|March|April|May|June|July|August|September|October|November|December)\b)([A-Z][a-zA-Z'’-]+(?:\s+[A-Z]\.)?(?:\s+[A-Z][a-zA-Z'’-]+){1,2})(?:,\s*(?:M\.D\.|Ph\.D\.|Jr\.|Sr\.|CPA|CFA)(?=[,\s]))?`;
const ROLE = String.raw`([Cc]hief [Ff]inancial [Oo]fficer|CFO|[Pp]rincipal [Ff]inancial [Oo]fficer|[Cc]hief [Ee]xecutive [Oo]fficer|CEO|[Pp]rincipal [Ee]xecutive [Oo]fficer)`;
// "the Company’s President and Chief Executive Officer": possessive (straight or curly) + another title joined by "and".
const ART = String.raw`(?:the Company[’']s |the company[’']s |its |our |the |their )?(?:new |permanent )?(?:(?:[A-Z][\w-]* ){1,4}and )?`;
const INT = String.raw`((?:[Ii]nterim|[Aa]cting) )?`;
const GAP = String.raw`(?:(?!\. [A-Z])[^;]){0,130}?`;   // no sentence break ("Inc. (“CRCFO”)" is fine)
const LEFT = String.raw`(?:resigned|resigns|has resigned|will resign|departed|departs|will depart|stepped down|steps down|will step down|is stepping down|will be stepping down|retired|retires|will retire|is retiring|will be retiring|is leaving|will leave|was terminated|notified the Company of (?:his|her|their) (?:decision to )?(?:resign|retire|resignation|retirement))`;
const RX = {
  appoint: new RegExp(String.raw`\b(?:appointed|appoints|named|names|promoted|promotes|hired|hires|elected)\s+${NAME},?\s+(?:${GAP}\s)?(?:to serve |to act )?(?:as|to)\s+(?:the (?:role|position) of )?${ART}${INT}${ROLE}`, 'g'),
  passive: new RegExp(String.raw`${NAME}(?:,${GAP},)?\s+(?:has been|was|will be|is|had been)\s+(?:appointed|named|promoted|elected)\s+(?:to serve |to act )?(?:as\s+|to\s+)?${ART}${INT}${ROLE}`, 'g'),
  serve: new RegExp(String.raw`${NAME}(?:,${GAP},)?\s+(?:will|to|shall)\s+(?:also\s+)?(?:serve|act|assume (?:the )?(?:duties|role)s?)\s+(?:as|of)\s+${ART}${INT}${ROLE}`, 'g'),
  left: new RegExp(String.raw`${NAME}(?:,${GAP},)?\s+(?:[^.]{0,40}?\s)?${LEFT}[^.]{0,80}?${ROLE}`, 'g'),
  // "appointed X as interim CFO, succeeding / following the resignation of Y": Y held the role X takes.
  follow: new RegExp(String.raw`(?:as|to)\s+${ART}(?:(?:[Ii]nterim|[Aa]cting) )?${ROLE}${GAP}\b(?:following|after|succeeding|replacing|to succeed|to replace) (?:the (?:resignation|departure|retirement|termination) of )?${NAME}`, 'g'),
  leftOf: new RegExp(String.raw`(?:resignation|departure|retirement|termination) of ${NAME},?\s+(?:as\s+)?${ART}${ROLE}`, 'g'),
};
const NOT_NAME = /\b(Agreement|Agreements|Stockholders?|Shareholders?|Plan|Plans|Section|Sections|Securities|Exchange|Act|Report|Form|Exhibit|Employment|Separation|Release|Award|Awards|Bonus|Compensation|Equity|Incentive|Notes|Credit|Loan|Trust|Fund|Bank|Corporation|Company|Board|Committee|Directors?|Officer|Officers|Chief|Financial|Executive|President|Holdings|Group|Capital|Partners|Inc|Corp|LLC|Item|Interim|Acting|Annual|Meeting|Effective|Following|Pursuant|Under|Our|Its|The|On|In|As)\b/;
const roleKey = r => /financial|cfo/i.test(r) ? 'cfo' : 'ceo';
const badName = n => NOT_NAME.test(n) || n.trim().split(/\s+/).length < 2;
// Like matchAll, but a match whose "name" is not a person ("Harmony Biosciences Holdings") retries one character later
// instead of swallowing the real name behind it.
function* scan(re, t, ni) {
  re.lastIndex = 0; let m;
  while ((m = re.exec(t))) { if (badName(m[ni])) { re.lastIndex = m.index + 1; continue; } yield m; }
}
export function officersIn(text) {
  const t = String(text || '').replace(/\s+/g, ' '), out = [], seen = new Set();
  let at = 0;
  const add = (name, role, event, interim, quote) => {
    name = name.trim();
    const k = `${event}|${name.toLowerCase()}|${role}`;
    // "of Globex" right after the role = the job is at another company (kept for officersFromPages to check).
    const of = (t.slice(at, at + 80).match(/^,?\s+(?:of|at)\s+([A-Z][\w&.'’-]*(?:\s+(?:[A-Z][\w&.'’-]*|&|and))*)/) || [])[1] || null;
    if (!seen.has(k)) { seen.add(k); out.push({ name, role, event, interim: !!interim, quote: quote.slice(0, 300), of }); }
  };
  const each = (re, ni, f) => { for (const m of scan(re, t, ni)) { at = m.index + m[0].length; f(m); } };
  for (const kind of ['appoint', 'passive', 'serve']) each(RX[kind], 1, m => add(m[1], roleKey(m[3]), 'appointed', m[2], m[0]));
  each(RX.left, 1, m => add(m[1], roleKey(m[2]), 'left', false, m[0]));
  each(RX.leftOf, 1, m => add(m[1], roleKey(m[2]), 'left', false, m[0]));
  each(RX.follow, 2, m => add(m[2], roleKey(m[1]), 'left', false, m[0]));
  return out;
}
export const officerQuery = name => `"${brand(name)}" ("chief financial officer" OR CFO OR "chief executive officer") appointed OR named OR interim OR resigned OR "steps down"`;
// News sentences naming this company -> officer events, newest first per person.
export function officersFromPages(name, pages, now = new Date()) {
  const key = norm(brand(name)), out = [];
  for (const p of pages) {
    const date = dateOf(p.date, now), host = (() => { try { return new URL(p.url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
    // The company named in the sentence, or the page is about it (title) and the sentence names the role.
    const about = has(p.title || '', key);
    for (const q of sentences(p.text)) if ((has(q, key) || about) && !/\b(?:formerly|previously|former \w+) (?:of|at|with)\b/i.test(q))
      for (const o of officersIn(q)) if (!o.of || has(o.of, key)) { const { of, ...rest } = o; out.push({ ...rest, date, url: p.url, source: host }); }
  }
  return out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

// ---- PE owner's deal partner (13 Nov 2026): a PE-owned BDC borrower's refinancing is run by the owner, so the person to reach is
// the partner on that deal. Investment press releases quote them: "said Jane Doe, Partner at Audax" / "Audax Principal John Roe".
const TITLE = String.raw`((?:Senior |Managing |Operating |Founding |Executive )?(?:Partner|Principal|Managing Director|Director|Vice President|Co-Founder|Founder)(?: and [A-Z][\w ]{2,30}?)?)`;
export const sponsorQuery = (owner, name) => `"${owner}" "${brand(name)}" said partner`;
export function sponsorsIn(text, owner) {
  const t = String(text || '').replace(/\s+/g, ' '), o = esc(String(owner || '').replace(/,?\s+(LLC|L\.?P\.?|Inc\.?)$/i, '').trim()), out = [];
  if (!o) return out;
  const rx = [
    [new RegExp(String.raw`${NAME},\s+(?:a |the |an )?${TITLE}\s+(?:at|of|with)\s+${o}`, 'g'), 1, 2],
    [new RegExp(String.raw`${o}(?:'s|’s)?\s+${TITLE}\s+${NAME}`, 'g'), 2, 1],
    [new RegExp(String.raw`${NAME},\s+(?:a |the |an )?${TITLE},\s+${o}`, 'g'), 1, 2],          // "X, Partner, LLR Partners"
    [new RegExp(String.raw`${NAME},\s+${o}(?:'s|’s)?\s+${TITLE}\b`, 'g'), 1, 2],               // "X, LLR Partners Partner" (deal sites)
  ];
  for (const [re, ni, ti] of rx) for (const m of t.matchAll(re)) {
    const name = m[ni].trim();
    if (NOT_NAME.test(name) || name.split(' ').length < 2 || out.some(x => x.name === name)) continue;
    out.push({ name, title: m[ti].trim(), quote: m[0].slice(0, 300) });
  }
  return out;
}
// Pages about the owner + company -> partners; those in a sentence naming the company first.
export function sponsorsFromPages(name, owner, pages) {
  // On the deal: the sentence or the page (title / URL) names the company; pages shorten names, so the first distinctive word counts.
  const key = norm(brand(name)), first = key.split(' ').find(w => w.length >= 4) || key, out = [];
  for (const p of pages) for (const q of sentences(p.text)) for (const s of sponsorsIn(q, owner)) {
    const i = out.findIndex(x => x.name === s.name), on = has(q, key) || has(p.title || '', key) || has(`${p.title || ''} ${String(p.url || '').replace(/[-_/.]/g, ' ')}`, first);
    if (i < 0) out.push({ ...s, on_deal: on, url: p.url }); else if (on) out[i].on_deal = true;
  }
  return out.sort((a, b) => Number(b.on_deal) - Number(a.on_deal));
}
