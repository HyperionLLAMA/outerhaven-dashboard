// Fund signals rules. Turns a Form D filing (from the GitHub edgartools job, or the Apify fallback) into a judged lead,
// and reads a "did they file again?" check. Plain JS so it runs in the edge function and in Node tests.
// Every verdict carries its reasons, so HQ can show exactly why a fund was kept or cut.

// Bump when the rules change: the cron re-judges every stored signal on the old version.
export const RULES_VERSION = 24;
export const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
export const romanOf = n => Object.keys(ROMAN).find(k => ROMAN[k] === n) || '';
const US = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
// Managers with their own fundraising teams, and wealth platforms whose feeders just repackage someone else's fund.
const BRANDS = /\b(apollo|blackstone|kkr|carlyle|ares|cerberus|adams street|investcorp|canyon capital|h\.?i\.?g\.?|bain capital|andreessen|lightspeed|neuberger|icapital|cais|brown advisory|ashwood|nuveen|crestline|lindsay goldberg|hines|greystar|goldman|morgan stanley|j\.?p\.? ?morgan|blackrock|tpg|warburg|general atlantic|sequoia|accel|insight partners|thoma bravo|brookfield|oaktree|hamilton lane|stepstone|pantheon|harbourvest|partners group|ardian|eqt|cvc|permira|silver lake|fortress|starwood|pimco|invesco|fidelity|ubs|wells fargo|meridiam|cresset|moonfare|yieldstreet|novacap|columbia capital|patient square|grey rock|cvp nolimit|blue owl|dfj|petershill|gcm grosvenor|grosvenor|siguler guff|strategic value|arrowmark)\b/i;
// Single-deal or pass-through vehicles: not a fund raising from LPs.
// Audit 8 Oct 2026 added: employee funds, overflow / overage (co-invest top-ups), access feeders, holdcos and GP-commitment vehicles,
// none of which raise from outside investors.
const VEHICLE = /\b(spv|co-?invest\w*|series of|splitter|blocker|continuation|sidecar|aggregator|access fund|annex|employees?|overflow|overage|hedgeaccess|holdco|gp commitment|general partner commitment)\b|\saccess\b|\bseries\s+(?!fund\b)[a-z0-9]/i; // "Access" only after the first word: "Access Venture Partners" is a real firm
// One fund files many Form Ds: amendments, feeders, parallel and offshore twins, -A/-B classes. Same family = same fund.
export const fundFamily = name => String(name || '').toLowerCase().replace(/\([^)]*\)/g, ' ')
  .replace(/\b(feeder|offshore|onshore|parallel|master|qp|ai|institutional|international|cayman|delaware|us|usd|eur|lux|scsp|l\.?\s?p\.?|llc|ltd|limited|inc|co|the)\b/g, ' ')
  .replace(/\b([ivx]+)-[a-z0-9]+\b/g, '$1').replace(/[^a-z0-9 ]/g, ' ').replace(/\b[a-z]\b/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set('fund funds lp llc llp ltd inc l p gp partners partnership capital ventures venture vc equity growth opportunity opportunities holdings investors investment investments management private credit global strategic select co company the a limited sicav scsp master offshore onshore feeder parallel us international series of and & fof'.split(' '));
const ENTITY = /\b(llc|l\.?l\.?c|l\.?p\.?|inc|ltd|limited|gp|partners|management|corporation|company|s\.?a\.? ?r\.?l|trust|fund|advisers|advisors|group|holdings)\b/i;

export const num = v => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : null; };
export const money = n => n == null ? '—' : n >= 1e9 ? '$' + +(n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? '$' + +(n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + Math.round(n / 1e3) + 'K' : '$' + Math.round(n);
const pctTxt = x => Math.round(x * 100) + '%';
// Can they pay us? (21 Oct 2026, Tengku, after HI Mark Capital: $6M Fund I = ~$120K fees a year, couldn't pay $15K upfront.)
// Fee income ~2% of capital managed (1.5% once a fund is 5+ years old: fees step down). A small GP spends most of it on
// salaries, admin, audit and legal, so ~25% is the most it can put toward fundraising help. Offer tiers = our current terms.
export function payOf(base, ageMonths = 0) {
  const fee = base * (ageMonths > 60 ? 0.015 : 0.02), month = fee * 0.25 / 12;
  const offer = month >= 12.5e3 ? 'retainer-ready, lead with the $12.5K/month retainer'
    : month >= 4e3 ? 'lead with milestones ($15K upfront, paid per meeting batch)'
    : 'success fee only, or wait until the new fund has money in';
  return { fee, month, text: `Fee income about ${money(fee)} a year, so about ${money(month)}/month it could spend on a placement adviser: ${offer}` };
}
const isoDate = v => /^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : null;

// "Ground Game Venture Fund I, L.P." → { fund_no: 1, manager_key: 'ground game', keyword: 'Ground Game' }
export function parseName(name) {
  const clean = String(name || '').replace(/\([^)]*\)/g, ' ').replace(/[.,]/g, ' ').replace(/\s+-\s+/g, ' ').replace(/\s+/g, ' ').trim();
  const toks = clean.split(' ').filter(t => /[a-z0-9]/i.test(t));
  let fund_no = 0, at = -1;
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i].toUpperCase().replace(/-[A-Z0-9]+$/, '');
    if (ROMAN[t]) { fund_no = ROMAN[t]; at = i; break; }
    if (/^FUND$/i.test(toks[i - 1]) && /^\d{1,2}$/.test(t)) { fund_no = +t; at = i; break; }
  }
  const head = (at < 0 ? toks : toks.slice(0, at));
  let i = 0; while (i < head.length && STOP.has(head[i].toLowerCase())) i++;
  const kept = [];
  for (; i < head.length && kept.length < 3; i++) { if (STOP.has(head[i].toLowerCase())) break; kept.push(head[i]); }
  const words = kept.length ? kept : toks.slice(0, 2);
  return { fund_no, manager_key: words.join(' ').toLowerCase(), keyword: words.map(w => w[0] + w.slice(1).toLowerCase()).join(' ') };
}

function people(it) {
  const d = Array.isArray(it.executivesDetail) ? it.executivesDetail : [];
  const out = [];
  for (const p of d) {
    const first = String(p.firstName || '').trim(), last = String(p.lastName || '').trim(), full = `${first} ${last}`.trim();
    if (!first || !last || /^(n\/?a|na|-+|\.|\[none\]|none)$/i.test(first) || ENTITY.test(full) || /general partner|managing member/i.test(full)) continue;
    const nice = s => s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()) : s;
    out.push({ name: `${nice(first)} ${nice(last)}`, title: p.title || '', location: p.location || '' });
  }
  return out;
}

// One Apify item → one fund_signals row (before judging).
export function normalize(it, list) {
  const p = parseName(it.companyName);
  const off = num(it.totalOfferingAmount);
  return {
    accession: it.accessionNumber || `${it.cik || 'x'}-${it.filingDate || ''}-${it.companyName || ''}`,
    list, company_name: it.companyName || 'Unknown', cik: it.cik || null,
    fund_no: p.fund_no, manager_key: p.manager_key, check_keyword: p.keyword, fund_key: `${p.manager_key}#${p.fund_no}`,
    filing_date: isoDate(it.filingDate), form_type: it.formType || null,
    offering: off, offering_text: off == null ? (it.totalOfferingAmount || null) : null,
    sold: num(it.totalAmountSold), investors: num(it.numberOfInvestors),
    first_sale: isoDate(it.dateOfFirstSale), commissions: num(it.salesCommissions) || 0, finders: num(it.findersFeesExpenses) || 0,
    exemptions: it.federalExemptions || null, state: it.state || null, city: it.city || null, phone: it.phone || null,
    industry: it.industryGroup || null, executives: people(it), executives_text: it.executives || '',
    filing_url: it.filingUrl || null, edgar_url: it.edgarUrl || null,
    amended_at: isoDate(it.amendedAt), amendment_url: it.amendmentUrl || null,
  };
}

// Strategy from the fund name (Form D has no strategy field). Order matters: "Real Estate Credit" is credit.
// The adviser's name counts too ("EV3 Fund II LP" says nothing; its adviser "EV3 Ventures LLC" does). "Income" alone is credit
// only when nothing says real estate ("Multifamily Income Fund" is real estate). Audit 2 Nov 2026: "X Finance / Financing Fund"
// (litigation, trade, export, mine, rescue financing), special situations, distressed and capital solutions funds sat in 'other';
// they are credit ("Real Estate Special Situations" stays real estate). "Financial" (fintech VC, "Socially Financed" series) is not. "Yield" is credit only after infra ("Natural Gas Yield").
export function strategyOf(s) {
  const t = `${s.company_name || ''} ${s.industry || ''} ${s.adviser_name || ''}`.toLowerCase();
  if (/\b(credit|lending|loans?|debt|mezz\w*|direct lend\w*|specialty finance|asset[- ]based|finance|financing|rescue)\b/.test(t)) return 'credit';
  if (/\b(real estate|realty|propert\w*|multi-?family|apartments?|housing|residential|homes|land|reit|self[- ]storage|hospitality|hotels?|opportunity zone|qof|industrial outdoor)\b/.test(t)) return 'real_estate';
  if (/\b(income|special situations?|distress\w*|capital solutions)\b/.test(t)) return 'credit';
  if (/\b(infrastructure|infra|energy|power|natural gas|oil|midstream|renewables?|solar|wind|transition|climate)\b/.test(t)) return 'infra';
  if (/\byield\b/.test(t)) return 'credit';
  if (/\b(ventures?|vc|seed|pre-?seed|founders?|labs|angels?|accelerator|studios?)\b/.test(t)) return 'venture';
  if (/\b(buyout|private equity|equity partners|growth equity|search fund|lower middle market|lmm)\b/.test(t)) return 'buyout';
  return 'other';
}
export const STRATEGY_LABEL = { credit: 'Private credit', real_estate: 'Real estate', infra: 'Infrastructure / energy', venture: 'Venture', buyout: 'Buyout / PE', other: 'Strategy unclear' };

// Judge a signal. Returns { verdict: 'target' | 'maybe' | 'cut', score 0-100, reasons: [{ tone, text }] }.
export function classify(s, now = Date.now()) {
  const R = [], add = (tone, text, pts = 0) => R.push({ tone, text, pts });
  const name = s.company_name || '';
  let stage = s.list === 'live' ? 'raising' : null, expected = null;
  if (VEHICLE.test(name)) add('cut', 'Single-deal vehicle (SPV, co-invest or series), not a fund raising from investors');
  if (BRANDS.test(name) || BRANDS.test(s.executives_text || '')) add('cut', 'Big brand or wealth platform: has its own fundraising team');
  if (s.commissions > 0) add('cut', `Already pays a placement agent (${money(s.commissions)} in sales commissions)`);
  else if (s.finders > 0) add('cut', `Already pays a finder (${money(s.finders)})`);
  if (s.state && !US.has(s.state)) add('maybe', `Non-US manager (state code ${s.state})`);
  if (!(s.executives || []).length) add('maybe', 'No named people in the filing, only entities');
  // A fund's legal name nearly always says what it is; "MCF SpaceX-I LLC" or "TS Rover I, LLC" is usually a one-deal vehicle.
  if (!/\b(fund|funds|partners|capital|ventures?|vc|equity|investors|investments?|opportunit\w*|growth|credit|holdings|lp|l\.?p\.?|scsp)\b/i.test(name)) add('maybe', "Name doesn't read like a fund: could be a single-deal vehicle");

  const sold = s.sold || 0, pctSold = s.offering ? sold / s.offering : null;
  const start = s.first_sale ? Date.parse(s.first_sale) : s.filing_date ? Date.parse(s.filing_date) : null;
  const months = start ? (now - start) / (30.44 * 864e5) : null;

  if (s.list === 'live') {
    if (s.fund_no >= 4) add('cut', `Fund ${romanOf(s.fund_no)}: established manager with existing investors`);
    else if (s.fund_no === 0) add('maybe', 'Fund number not in the name');
    else if (s.fund_no === 1) add('maybe', 'Fund I: usually too early (no track record to sell)');
    else add('good', s.fund_no === 2 ? 'Fund II: the hardest raise, no realised returns yet' : 'Fund III: still building its investor base', s.fund_no === 2 ? 20 : 12);
    if (s.offering == null) add('maybe', 'Target size not stated ("Indefinite"), so % raised is unknown');
    else if (s.offering < 50e6) add('cut', `Too small: ${money(s.offering)} target (we want $50–250M)`);
    else if (s.offering > 250e6) add('cut', `Too big: ${money(s.offering)} target (we want $50–250M)`);
    if (pctSold != null && (sold > 0 || s.first_sale)) {
      if (pctSold >= 0.6) add('cut', `Mostly raised: ${pctTxt(pctSold)} of target`);
      else add('good', `${pctTxt(pctSold)} raised, ${money(s.offering - sold)} still to raise`, pctSold < 0.3 ? 15 : 8);
    }
    if (!s.first_sale) add('good', 'Filed before taking any money: the earliest possible contact', 15);
    else if (months != null && months <= 1.5) add('good', 'Started raising in the last 6 weeks', 12);
    // 19 Oct 2026 (Tengku, Schutte Capital II: 4% in 50 months ranked #1). Past 2 years under 30% is a dead raise or an
    // always-open vehicle, not a GP mid-raise; same line as the fund1 list's "open over 2 years" rule.
    if (months != null && months > 24 && pctSold != null && pctSold < 0.3 && s.first_sale) add('maybe', `Open ${Math.round(months)} months with only ${pctTxt(pctSold)} raised: a stalled raise or an always-open vehicle, not a live fundraise`, -15);
    else if (months != null && months >= 6 && pctSold != null && pctSold < 0.3 && s.first_sale) add('good', `Stuck: only ${pctTxt(pctSold)} raised in ${Math.round(months)} months. They need help, but ask why investors are passing (a stall is also a weaker story)`, 20);
    else if (months != null && months >= 12 && pctSold == null && s.first_sale) add('good', `Still raising ${Math.round(months)} months after the first sale`, 20);
    // 19 Oct 2026 (Tengku, Future Labs Fund II: $6.5M of $65M in 19 months, Fund I closed $22.6M of $65M). Motivation is not the
    // problem mid-raise: a stuck GP wants help most. Placeability is. Re-ups come first in any raise, so a Fund II far below
    // Fund I after a year means Fund I's own investors aren't coming back, and a Fund I that missed its target is a weak story.
    const n = s.fund_no || 0, myStart = s.first_sale || s.filing_date;
    // A higher-numbered fund by the same people that started first (Schutte III 2021, II 2022): the numbers are labels on
    // parallel vehicles, so "Fund II, the hardest raise" is wrong.
    const later = (s.history || []).find(h => h.fund_no > n && h.first && myStart && h.first <= myStart);
    if (later) add('maybe', `Fund numbers out of order: ${later.name} started ${later.first}, before this one. Parallel vehicles, not a new fund`, -10);
    const prior = (s.history || []).filter(h => h.fund_no === n - 1 && h.first && myStart && h.first < myStart).sort((a, b) => b.sold - a.sold)[0];
    if (prior && prior.sold > 0) {
      const pFull = prior.offering > 0 ? prior.sold / prior.offering : null, pNm = `Fund ${romanOf(prior.fund_no) || 'I'}`;
      if (pFull != null && pFull < 0.6) add('maybe', `${pNm} closed at ${pctTxt(pFull)} of its ${money(prior.offering)} target (${money(prior.sold)}): new investors will ask why${s.offering && prior.offering && s.offering >= prior.offering ? ', and this fund asks for the same or more' : ''}`, -10);
      if (months >= 12 && sold < 0.5 * prior.sold) add('maybe', `${money(sold)} in after ${Math.round(months)} months vs ${money(prior.sold)} for ${pNm}: its own investors aren't re-upping much. Ask why before pitching`, -10);
      else if (sold >= prior.sold) add('good', `Already past ${pNm}'s ${money(prior.sold)}: investors are coming back`, 5);
    }
    // Ability to pay, stated only (no points): fees come from earlier funds plus what this one has raised so far.
    const earlierSold = (s.history || []).filter(h => h.fund_no < n && h.first && myStart && h.first < myStart).reduce((t, h) => t + (h.sold || 0), 0);
    const payBase = Math.max(Number(s.manager_total) || 0, earlierSold + sold);
    if (payBase > 0) add('info', payOf(payBase).text);
  } else {
    // Next-fund watch (list 'fund1' holds Fund Is AND Fund IIs since 5 Oct 2026): a manager whose last fund is old enough
    // that the next one is due. Fund II managers raising a Fund III are in scope too.
    const n = s.fund_no || 1, nm = `Fund ${romanOf(n) || 'I'}`, nextNm = `Fund ${romanOf(n + 1)}`;
    if (n >= 3) add('cut', `${nm}: established manager with existing investors`);
    // Size = the target. The amount raised on the first Form D is only the first close (filed within 15 days of it), so it
    // is used only when no target is stated, or once the check has read the latest amendment.
    // Once an amendment (or the check) has given the money actually raised, that is the fund's real size: a $10M target
    // that raised $2.4M in three years (Horn of Africa Fund I) is a $2.4M fund.
    const raisedFinal = (s.check_status || s.amended_at) && s.sold > 0 ? s.sold : null;
    const size = raisedFinal || s.offering || (s.sold > 0 ? s.sold : null), max = n === 2 ? 150e6 : 75e6;
    const word = raisedFinal ? 'raised' : s.offering ? 'targeted' : 'raised';
    if (!size) add('maybe', `${nm} size unknown (target "Indefinite", nothing raised yet at filing)`);
    else if (size < 10e6 && !(s.offering == null && !s.check_status && !s.amended_at)) add('cut', `${nm} ${word} only ${money(size)}: too small to pay for help on ${nextNm}`);
    else if (size < 10e6) add('maybe', `${nm} had raised ${money(size)} at its first filing, target not stated: check for later amendments`);
    else if (size > max) add('cut', `${nm} ${word} ${money(size)} (over ${money(max)}): likely already has a fundraising process`);
    // Windows from the cadence study (5 Oct 2026, 250 Fund Is + 250 Fund IIs filed in 2019, next fund = first later fund by the
    // same people, any name, 9+ months later): Fund I -> next median 24 months (middle half 16-35); Fund II -> next median 28
    // (19-37). Only ~1 in 7 Fund I managers with no next fund at year 3 files one by year 5.
    const W = n === 2 ? { lo: 15, hi: 39, med: 28, q: '19-37' } : { lo: 12, hi: 36, med: 24, q: '16-35' };
    // Has the current fund finished raising? (8 Oct 2026, Peter call.) A Form D is filed within 15 days of the first sale and
    // a fund usually takes 12-18 months (up to 24) to close. Open offerings must re-file every year (Rule 503), so no filing
    // for 13+ months means the raise has most likely ended (or the manager stopped filing: ask).
    const lastAct = [s.filing_date, s.amended_at].filter(Boolean).sort().pop();
    const sinceAct = lastAct ? (now - Date.parse(lastAct)) / (30.44 * 864e5) : null;
    const known = !!(s.amended_at || ['clear', 'next', 'unsure'].includes(s.check_status));
    const full = s.offering > 0 && s.sold > 0 ? s.sold / s.offering : null;
    // Audit 8 Oct 2026: of 273 targets, 78 showed raised = target to the dollar and none raised more. Managers usually amend the
    // target down (or up) to the final size at close, so "100% of target" proves the fund closed, not that it hit its goal.
    const reset = full != null && Math.abs(s.sold - s.offering) < 1;
    // still_raising is stored at check time: it only counts while that filing is under 13 months old.
    stage = s.still_raising && sinceAct != null && sinceAct <= 13 ? 'raising' : full != null && full >= 0.95 ? 'closed' : known && sinceAct != null && sinceAct > 13 ? 'closed' : 'unclear';
    // 14 Oct 2026 (Tengku): still open 12+ months after the first sale = placement target for THIS fund, not a next-fund
    // pitch. Most Fund Is take 18-24 months; by month 12 the GP's own network is spent. Best with a first close, no agent.
    if (stage === 'raising' && months >= 12) stage = 'stuck';
    if (stage === 'stuck') {
      add('good', `Still raising ${nm} ${Math.round(months)} months after the first sale: pitch placement on this fund`, 15);
      // Tengku: a Fund I has no fund track record to sell. Only placeable on attributable deals from a prior firm or deal-by-deal.
      if (n === 1) add('maybe', 'Fund I: no fund track record yet. Placeable only if the GPs have attributable deals (prior firm or deal-by-deal): ask first');
      if (!(s.sold > 0)) add('maybe', `No money reported raised after ${Math.round(months)} months: no first close, investors have likely passed`, -10);
      else if (full != null && full >= 0.6) add('info', `Already ${pctTxt(full)} raised: little left to place`, -10);
      else if (full != null) add('good', `First close done: ${money(s.sold)} in (${pctTxt(full)}), ${money(s.offering - s.sold)} still to raise`, 10);
      if (months > 24 && !(full >= 0.3)) add('maybe', `Open over 2 years with under 30% raised: likely a stalled raise`, -10);
    } else if (stage === 'raising') add('maybe', `Still raising ${nm} (${s.still_raising}), under 12 months in: too early to pitch. Revisit at 12 months for placement, or after it closes for ${nextNm}`);
    else if (stage === 'closed' && full != null && full >= 0.95) add('good', `${nm} closed at ${money(s.sold)}${reset ? ' (the filing sets the target to the final size, so this proves it closed, not that it hit its first goal)' : ''}`, 12);
    else if (stage === 'closed') add('good', `${nm} raise has ended: no filing for ${Math.round(sinceAct)} months (open raises must re-file every year)`, 12);
    else add('info', `Not sure ${nm} has closed yet (last filing ${lastAct || 'unknown'}): confirm on the first call`);

    // The manager's own history (8 Oct 2026, Tengku: their own pace beats the market average, but check both).
    const hist = s.history || [], myBase = base(s.company_name), myStart = s.first_sale || s.filing_date;
    const earlier = hist.filter(h => h.fund_no && h.fund_no < n && h.first && myStart && h.first < myStart);
    const prior = earlier.filter(h => h.fund_no === n - 1).sort((a, b) => (b.base === myBase) - (a.base === myBase) || b.sold - a.sold)[0] || null;
    if (earlier.length) add('info', `Earlier funds: ${earlier.map(h => `${h.name} (${String(h.first).slice(0, 4)}${h.sold ? `, ${money(h.sold)}` : ''}${h.investors ? `, ${h.investors} investors` : ''})`).join('; ')}`);

    // When is the next fund likely? Market: the cadence study (500 funds filed in 2019: Fund I -> II median 24 months, middle
    // half 16-35; Fund II -> III median 28, 19-37). Own pace: the gap from their previous fund to this one. One gap is a single
    // data point, so it is blended 50/50 with the market median rather than trusted alone; both are shown.
    const ownGap = prior && myStart ? (Date.parse(myStart) - Date.parse(prior.first)) / (30.44 * 864e5) : null;
    const useOwn = ownGap != null && ownGap >= 9 && ownGap <= 72;
    const expM = useOwn ? (ownGap + W.med) / 2 : W.med;
    const when = m => new Date(Date.parse(myStart) + m * 30.44 * 864e5).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    if (months != null && myStart && stage !== 'stuck') {
      expected = new Date(Date.parse(myStart) + expM * 30.44 * 864e5).toISOString().slice(0, 10);
      const basis = `${useOwn ? `their own pace: ${romanOf(n - 1) ? `Fund ${romanOf(n - 1)}` : 'last fund'} to ${nm} took ${Math.round(ownGap)} months; ` : ''}market median ${W.med} months, middle half ${W.q}`;
      const toGo = expM - months, est = `${nextNm} expected around ${when(expM)} (${basis})`;
      if (months > 60) add('maybe', `${nm} is ${(months / 12).toFixed(1)} years old: most managers who raise again have done so by now`);
      else if (toGo > 12) add('maybe', `Early: ${est}. Investor meetings usually start 6-12 months before launch`);
      else if (toGo >= -9) add('good', `In the pre-launch window: ${est}`, 15);
      else add('info', `Past the expected launch (${est}) with no ${nextNm} filed: stalled, or raising before filing. Ask`);
    }

    // Track record we can see in public filings (real returns are never public at this size: ask on the first call).
    // Peter: a weak fund is a weak story, hard to place with new investors. So a miss counts against, never for.
    if (stage !== 'raising' && stage !== 'stuck' && full != null && s.sold > 0 && !reset) {
      if (full >= 1) add('good', `Raised ${pctTxt(full)} of its ${nm} target: oversubscribed`, 12);
      else if (full >= 0.8) add('good', `Raised ${pctTxt(full)} of the ${nm} target`, 5);
      else if (full < 0.6 && stage === 'closed') add('maybe', `${nm} closed at only ${pctTxt(full)} of target: a weak story for new investors`, -10);
    }
    // Step-up: did the last fund's investors come back with more? The strongest public sign of how the last fund went.
    let earnedTrack = n === 2;
    if (prior && prior.sold > 0 && size) {
      const x = size / prior.sold;
      if (prior.sold < 5e6) { earnedTrack = false; add('info', `${romanOf(n - 1) ? `Fund ${romanOf(n - 1)}` : 'The last fund'} was only ${money(prior.sold)}, so ${nm} (${money(size)}) wasn't built on its returns. Ask what drove the jump`); }
      else if (x >= 1.3) add('good', `${nm} is ${x.toFixed(1)}x the size of ${romanOf(n - 1) ? `Fund ${romanOf(n - 1)}` : 'the last fund'} (${money(prior.sold)}): earlier investors came back and new ones joined`, 8);
      else if (x >= 0.8) add('info', `${nm} is about the same size as the last fund (${money(prior.sold)})`);
      else { earnedTrack = false; add('maybe', `${nm} is smaller than the last fund (${money(size)} vs ${money(prior.sold)}): some investors didn't come back`, -5); }
    }
    // Who the investors are, by average cheque: family offices write $1M+; under ~$250K is mostly individuals.
    // Not the count alone (8 Oct 2026, Tengku/Peter): many investors can mean proof, or a base that refills the next fund unaided.
    const inv = s.investors, avg = inv > 0 && size ? size / inv : null;
    if (inv > 0 && inv <= 5 && size >= 15e6) add('info', `Only ${inv} investor${inv === 1 ? '' : 's'} (about ${money(avg)} each): one or two anchors carry it. Ask if the anchor re-ups`);
    else if (avg != null && avg >= 1e6) add('good', `Average cheque about ${money(avg)} across ${inv} investors: family-office-sized backers`, 6);
    else if (avg != null && avg < 250e3) add('info', `Average cheque about ${money(avg)} across ${inv} investors: mostly individuals. A weaker story, but they need us to reach family offices`);

    // Can they pay? Same points as before (-8 under $400K fees, +5 above); the text now states the budget and which offer to lead with.
    if (size) {
      const pay = payOf(size, months);
      if (pay.fee < 400e3) add('info', pay.text, -8);
      else add('good', pay.text, 5);
      // The ask for the next fund: managers usually aim 1.5-2x bigger; existing investors re-up roughly 60% of what they put in.
      if (stage !== 'raising' && stage !== 'stuck') add('info', `Likely ${nextNm}: ${money(size * 1.5)}-${money(size * 2)}, of which roughly ${money(size * 0.9)}-${money(size * 1.4)} has to come from new investors`);
    }
    if (n === 2 && earnedTrack) add('good', 'Fund II manager: has a Fund I track record to show for Fund III', 5);
    if (s.check_status === 'clear' && !(s.sold > 0)) add('maybe', `No money reported raised, even in later filings: ${nm} may never have closed`);
    else if (s.check_status === 'clear') add('good', `No ${nextNm} or renamed next fund filed yet (checked ${String(s.checked_at || '').slice(0, 10)})`, 15);
    else if (s.check_status === 'next') add('cut', s.check_note || 'Already filed a later fund');
    else if (s.check_status === 'unsure') add('maybe', s.check_note || `Possible ${nextNm}, not confirmed: check by hand`);
    else if (s.check_status === 'error') add('maybe', 'Next-fund check failed: run it again');
    else if (s.check_status === 'checking') add('info', `Checking EDGAR for a ${nextNm}…`);
    else if (s.check_status === 'queued') add('info', 'Queued for a next-fund check (runs hourly on GitHub)');
    else add('info', 'Not checked for a next fund yet');
  }
  const strategy = strategyOf(s);
  if (strategy === 'real_estate') add('info', 'Real estate: the most crowded raise and the hardest to get paid on (Peter)', -15);
  else if (strategy === 'credit') add('good', 'Private credit: where family offices and Gulf money are moving now (Peter)', 8);
  if (/06c/.test(s.exemptions || '')) add('good', 'Rule 506(c): allowed to market publicly, so already looking for investors openly', 8);
  // Manager size (6 Oct 2026, Tengku): all its funds together under $150M = the target; $150-500M = keep, lower priority;
  // over $500M = established, cut. From the adviser's Form ADV (assets under management / private fund gross assets),
  // or the Form Ds of this manager's funds when no adviser filing is found.
  const mt = s.manager_total != null ? Number(s.manager_total) : null, src = s.manager_total_src ? ` (${s.manager_total_src})` : '';
  if (mt != null && mt > 500e6) add('cut', `Manager runs ${money(mt)} in total${src}: established, not an emerging manager`);
  else if (mt != null && mt > 150e6) add('info', `Manager runs ${money(mt)} in total${src}: past emerging, lower priority`, -15);
  else if (mt != null && mt > 0) add('good', `Emerging manager: ${money(mt)} across all its funds${src}`, s.list === 'live' ? 20 : 12);
  else if (s.adviser_checked_at && !s.adviser_crd) add('info', 'No SEC adviser filing found: likely a small, state-registered manager');

  const verdict = R.some(r => r.tone === 'cut') ? 'cut' : R.some(r => r.tone === 'maybe') ? 'maybe' : 'target';
  const score = Math.max(0, Math.min(100, R.reduce((n, r) => n + r.pts, 0)));
  return { verdict, score: verdict === 'cut' ? Math.min(score, 20) : score, reasons: R.map(({ tone, text }) => ({ tone, text })), stage, strategy, next_expected: expected };
}

// People on a filing, as comparable keys: "aman brar" → "a brar". Entities are already dropped by people().
const personKeys = list => new Set((list || []).map(p => String(p.name || `${p.firstName || ''} ${p.lastName || ''}`).toLowerCase().replace(/[^a-z\s]/g, ' ').trim().split(/\s+/)).filter(w => w.length >= 2).map(w => `${w[0][0]} ${w[w.length - 1]}`));

// People on both lists; sameCity = that person's address city matches too (a stronger sign it's the same person).
function sharedPeople(ours, theirs) {
  const key = p => { const w = String(p.name || '').toLowerCase().replace(/[^a-z\s]/g, ' ').trim().split(/\s+/).filter(x => x.length >= 2); return w.length >= 2 ? `${w[0][0]} ${w[w.length - 1]}` : ''; };
  const city = p => String(p.location || '').split(',')[0].trim().toLowerCase();
  const mine = new Map((ours || []).map(p => [key(p), p]));
  return (theirs || []).filter(p => key(p) && mine.has(key(p))).map(p => ({ name: p.name, sameCity: !!city(p) && city(p) === city(mine.get(key(p))) }));
}

// The manager's own funds, oldest first: one entry per fund (feeders, offshore twins and amendments folded together,
// largest amount kept), counting only filings that share a named person with this one (or the same SEC company), so two
// firms with similar names never mix. peers = our stored rows with the same manager_key + earlier funds the adviser job
// found on EDGAR (s.prior_funds).
const base = name => fundFamily(name).replace(/\b[ivx]+\b/g, ' ').replace(/\s+/g, ' ').trim();
// Same fund name apart from the number, and one filing names no people (21 Oct 2026, Tengku: Fund II rows showing no Fund I,
// e.g. DBDK Venture Fund I filed with no executives, so the shared-person test dropped it). Only when people can't be compared:
// two filings that both name people and share none stay apart. Short or generic names never match on name alone.
function twinName(s, p) {
  const a = base(s.company_name);
  if (!a || a !== base(p.company_name) || (a.length < 8 && !a.includes(' '))) return false;
  return !personKeys(s.executives).size || !personKeys(p.executives).size;
}
export function managerHistory(s, peers) {
  const ours = personKeys(s.executives), city = String(s.city || '').toLowerCase(), fams = new Map();
  for (const p of [...(peers || []), ...(s.prior_funds || [])]) {
    if (!p || !p.company_name || VEHICLE.test(p.company_name)) continue;
    const same = p.id === s.id || (s.cik && p.cik && Number(s.cik) === Number(p.cik)) || [...personKeys(p.executives)].some(k => ours.has(k)) || (!ours.size && city && String(p.city || '').toLowerCase() === city) || twinName(s, p);
    if (!same) continue;
    // A fund's start = its earliest first sale; a filing date only when no filing gives one (a fund can file before any money).
    const key = `${fundFamily(p.company_name)}#${p.fund_no || 0}`, sold = Number(p.sold) || 0;
    const f = fams.get(key) || { name: p.company_name, fund_no: p.fund_no || 0, base: base(p.company_name), sale: null, filed: null, sold: 0, investors: null, offering: null };
    if (Number(p.offering) > (f.offering || 0)) f.offering = Number(p.offering);
    if (p.first_sale && (!f.sale || p.first_sale < f.sale)) f.sale = p.first_sale;
    if (p.filing_date && (!f.filed || p.filing_date < f.filed)) f.filed = p.filing_date;
    f.first = f.sale || f.filed;
    if (sold > f.sold) { f.sold = sold; f.name = p.company_name; }
    if (Number(p.investors) > (f.investors || 0)) f.investors = Number(p.investors);
    fams.set(key, f);
  }
  return [...fams.values()].map(({ sale, filed, ...f }) => f).sort((a, b) => String(a.first).localeCompare(String(b.first)));
}

// Money raised across this manager's funds in our Form D data: the latest amount per fund (feeders and parallels folded
// into one fund), counting only filings that share a named person with this one (or the same city), so two firms with
// similar names never add up.
export function formDTotal(s, peers) {
  const ours = personKeys(s.executives), city = String(s.city || '').toLowerCase();
  const best = new Map();
  for (const p of peers || []) {
    const theirs = personKeys(p.executives);
    // A renamed earlier fund (found by searching the people) counts when it shares a named person (22 Oct 2026).
    if (p.manager_key !== s.manager_key && ![...theirs].some(k => ours.has(k))) continue;
    const same = p.id === s.id || [...theirs].some(k => ours.has(k)) || (!ours.size && city && String(p.city || '').toLowerCase() === city) || twinName(s, p);
    if (!same) continue;
    const fam = `${fundFamily(p.company_name)}#${p.fund_no || 0}`, v = Number(p.sold) || 0;
    if (v > (best.get(fam) || 0)) best.set(fam, v);
  }
  let total = 0; for (const v of best.values()) total += v;
  return { total, funds: best.size };
}

// Read a check run: later filings (D or D/A) whose name matches this manager.
// A higher fund number by the same manager = they already started the next fund. "Same manager" needs the name match AND
// at least one person (partner/director) on both filings; without people to compare it's only "unsure".
// Same fund number under the same SEC company number (CIK), later date = an amendment with fresh numbers.
export function readCheck(s, items) {
  const mine = Math.max(1, s.fund_no || 0), later = [], amends = [], strangers = [], unsure = [];
  const ours = personKeys(s.executives);
  const byPerson = [];
  for (const it of items || []) {
    const p = parseName(it.companyName);
    if (VEHICLE.test(it.companyName || '')) continue;
    // Found by searching a person's name: a fund under ANY name that the same people filed later (managers often drop the
    // numbering: "Stratos Venture Partners Fund I", then "Frontier Fund"). Judged on the people, not the name.
    if (it.via === 'person' && p.manager_key !== s.manager_key) {
      const date = isoDate(it.filingDate);
      if (s.cik && it.cik && Number(s.cik) === Number(it.cik)) continue;
      if (!date || (s.filing_date && date <= s.filing_date)) continue;
      if (it.industryGroup && it.industryGroup !== 'Pooled Investment Fund') continue;
      // Deal vehicles (one property, one co-invest) don't count as a next fund: under $10M, or AIV / opportunity-zone names.
      const off = num(it.totalOfferingAmount);
      if ((off != null && off < 10e6) || /\b(aiv|oz|qof|qozf|investco|propco)\b/i.test(it.companyName || '')) continue;
      const theirs = people(it), shared = sharedPeople(s.executives, theirs);
      if (!shared.length) continue;
      byPerson.push({ name: it.companyName, date, form: it.formType, offering: off, sold: num(it.totalAmountSold), fund_no: p.fund_no, cik: it.cik || null,
        shared: shared.map(x => x.name), strong: shared.length >= 2 || shared.some(x => x.sameCity) || theirs.length === 1 });
      continue;
    }
    if (p.manager_key !== s.manager_key) continue;
    const row = { name: it.companyName, date: isoDate(it.filingDate), form: it.formType, offering: num(it.totalOfferingAmount), sold: num(it.totalAmountSold), fund_no: p.fund_no, cik: it.cik || null };
    // Same fund = same SEC company id (CIK); fall back to the exact name when a CIK is missing.
    const same = s.cik && row.cik ? Number(s.cik) === Number(row.cik) : String(it.companyName || '').toLowerCase() === String(s.company_name || '').toLowerCase();
    if (same) { if (row.date && (!s.filing_date || row.date > s.filing_date)) amends.push(row); continue; }
    if (!(p.fund_no > mine) || (s.filing_date && row.date && row.date <= s.filing_date)) continue;
    const theirs = personKeys(people(it));
    row.shared = [...theirs].filter(k => ours.has(k));
    if (!ours.size || !theirs.size) unsure.push(row);
    else if (row.shared.length) later.push(row);
    else strangers.push(row);
  }
  const byDate = (a, b) => String(a.date).localeCompare(String(b.date));
  // One fund files several Form Ds (amendments, feeders): keep the first filing per fund name.
  const firstPer = rows => rows.sort(byDate).filter((r, i, a) => a.findIndex(x => String(x.name).toLowerCase() === String(r.name).toLowerCase()) === i);
  const renamed = firstPer(byPerson.filter(r => r.strong)), renamedUnsure = firstPer(byPerson.filter(r => !r.strong));
  later.push(...renamed.map(r => ({ ...r, renamed: true }))); unsure.push(...renamedUnsure.map(r => ({ ...r, renamed: true })));
  const families = rows => rows.sort(byDate).filter((r, i, a) => a.findIndex(x => fundFamily(x.name) === fundFamily(r.name)) === i);
  later.splice(0, later.length, ...families(later)); unsure.splice(0, unsure.length, ...families(unsure));
  amends.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const out = { funds_since: later.length, later: [...later, ...unsure.map(r => ({ ...r, unconfirmed: true })), ...strangers.map(r => ({ ...r, other_manager: true }))], latest: amends.find(a => a.sold != null) || amends[0] || null };
  const fresh = out.latest ? `Latest Fund ${romanOf(mine)} filing ${out.latest.date}${out.latest.sold != null ? `: ${money(out.latest.sold)} raised${out.latest.offering ? ` of ${money(out.latest.offering)}` : ''}` : ''}` : '';
  const ignored = strangers.length ? ` Ignored ${strangers.length} same-name filing${strangers.length > 1 ? 's' : ''} by different people (${strangers[0].name}).` : '';
  if (later.length) { const f = later[0]; out.status = 'next'; out.note = f.renamed
    ? `Already raised a later fund under a new name: ${f.name} (${f.date}${f.offering ? `, ${money(f.offering)} target` : ''}), same people (${f.shared.join(', ')})`
    : `Already filed ${f.name} (${f.date}${f.offering ? `, ${money(f.offering)} target` : ''}); same people on both filings`;
    if (later.length > 1) out.note += `. ${later.length} funds since: ${later.map(x => `${x.name} (${String(x.date).slice(0, 4)})`).join('; ')}`; }
  else if (unsure.length) { const f = unsure[0]; out.status = 'unsure'; out.note = f.renamed
    ? `Possible later fund under a new name: ${f.name} (${f.date}) names ${f.shared.join(', ')}, but nothing else matches (could be another firm with the same person). Check by hand.${ignored}`
    : `Possible Fund II: ${f.name} (${f.date}), but no named people to confirm it's the same manager. Check by hand.${ignored}`; }
  else { out.status = 'clear'; out.note = (fresh ? `No later fund. ${fresh}.` : `No later fund filed since ${s.filing_date || 'the original filing'}.`) + ignored; }
  return out;
}

// ---- Credit signals: small US public companies that need private credit (Peter's lane) ----
// Item from scripts/credit_signals.py: { cik, name, tickers, exchange, sic, sicDesc, state, periodEnd, debtCurrent,
// debtNoncurrent, cash, revenue, publicFloat, flags: { going_concern?, forbearance? }, filingUrl }
export const CREDIT_RULES_VERSION = 11;
// Lender-fit tags (4 Nov 2026, Tengku: "don't leave it at maybe, set tags"). Stored in credit_signals.tags, filtered in HQ.
// cut = the company is out; the rest describe why it is (or isn't) a loan a private credit lender would write.
export const CREDIT_TAGS = {
  lendable: 'Lendable', stretched: 'Highly levered', bank_refi: 'Bank will refinance', check_data: 'Check the numbers',
  burning_cash: 'Burning cash', over_levered: 'Over-levered', too_big: 'Too big', too_small: 'Too small', not_borrower: 'Not a borrower', chapter_11: 'In Chapter 11', non_us: 'Non-US',
  lane_refi: 'Refinancing', lane_rescue: 'Rescue', can_pay: 'Can pay a retainer', small_loan: 'Loan too small',
};
export function normalizeCredit(it) {
  return {
    cik: String(Number(it.cik)), company_name: it.name || 'Unknown', tickers: (it.tickers || []).join ? (it.tickers || []).join(', ') : it.tickers || null,
    exchange: (it.exchanges || []).join ? (it.exchanges || []).join(', ') : it.exchange || null, sic: it.sic ? String(it.sic) : null, sic_desc: it.sicDesc || null,
    state: it.state || null, period_end: isoDate(it.periodEnd), debt_current: num(it.debtCurrent), debt_noncurrent: num(it.debtNoncurrent), revolver_current: num(it.revolverCurrent),
    cash: num(it.cash), revenue: num(it.revenue), public_float: num(it.publicFloat), flags: it.flags || {}, filing_url: it.filingUrl || null,
    ebitda: num(it.ebitda), interest_expense: num(it.interestExpense), debt_types: Array.isArray(it.debtTypes) ? it.debtTypes : null,
  };
}
export function classifyCredit(s) {
  const R = [], add = (tone, text, pts = 0) => R.push({ tone, text, pts }), tags = new Set();
  const sic = Number(s.sic) || 0, f = s.flags || {};
  const dc = s.debt_current, cash = s.cash, total = (s.debt_current || 0) + (s.debt_noncurrent || 0);
  const when = s.period_end ? ` (balance sheet ${s.period_end})` : '';
  if (sic >= 6000 && sic <= 6799 && sic !== 6798) tags.add('not_borrower'), add('cut', `Bank, insurer or fund (${s.sic_desc || 'SIC ' + sic}): not a borrower for us`);
  // Regulated utilities (water, gas, electric) borrow cheaply in their own markets and don't hire a private credit adviser.
  if ((sic >= 4900 && sic <= 4949) || sic === 4961 || sic === 4991) tags.add('not_borrower'), add('cut', `Regulated utility (${s.sic_desc || 'SIC ' + sic}): borrows cheaply in its own markets, won't hire us`);
  if (s.on_latest === false) add('cut', 'No longer on the latest scan: its numbers stopped showing a trigger (earlier runs counted revolving lines as debt due)');
  if (/(^|,\s*)[A-Z]{4}Q(,|$)/.test(s.tickers || '')) tags.add('chapter_11'), add('cut', 'Ticker ends in Q: already in Chapter 11, its rescue lenders are set');
  if (s.revenue == null) add('maybe', 'Revenue not found in its filings');
  else if (s.revenue === 0) tags.add('too_small'), add('cut', 'No revenue reported: pre-revenue, nothing for a lender to lend against');
  else if (s.revenue < 20e6) tags.add('too_small'), add('cut', `Revenue only ${money(s.revenue)}: no cash flow for a lender to lend against`);
  // Too big (4 Nov 2026): Peter's lenders write $20-300M; above that, or $1B+ revenue, banks and the bond market cover it.
  if (total > 300e6) tags.add('too_big'), add('cut', `${money(total)} of debt: above the $300M private credit lenders write, banks and the bond market cover it`);
  else if (s.revenue > 1e9) tags.add('too_big'), add('cut', `${money(s.revenue)} revenue: big enough for bank and bond coverage`);
  if (s.public_float != null && s.public_float > 2e9) tags.add('too_big'), add('cut', `Public float ${money(s.public_float)}: too large, has bank coverage`);
  if (s.state && !US.has(s.state)) tags.add('non_us'), add('maybe', `Non-US company (${s.state})`);
  let trigger = false;
  // Points (0-100): the refinancing deadline and lender stress matter most, then fit. Bigger gap = more urgent.
  // Real maturity dates read from the latest 10-Q / 10-K text (scripts/maturities.py, 7 Nov 2026). The balance sheet's
  // "due within 12 months" also counts revolvers and convertibles that mature years out (Bowman, Shutterstock, A10).
  const mats = Array.isArray(f.maturities?.items) ? f.maturities.items : null;
  const monthsTo = d => (Date.parse(d) - Date.now()) / (30.44 * 864e5);
  // v10 (7 Nov audit): items under $5M (Jushi's $1.4M acquisition note) are not the company's real debt.
  const real = mats ? mats.filter(i => !i.small) : null;
  const soon = real ? real.map(i => ({ ...i, m: monthsTo(i.date) })).filter(i => i.m >= 0 && i.m <= 24).sort((a, b) => (a.m < 4) - (b.m < 4) || (a.kind === 'revolver') - (b.kind === 'revolver') || a.m - b.m)[0] : null;  // a stale under-4-month date never hides a real later one (Galaxy)
  // Leverage is needed before the maturity can be judged: a revolver at a strong earner just gets renewed by its bank.
  const e0 = s.ebitda, lev0 = e0 > 0 && total > 0 ? (total - (cash || 0)) / e0 : null;
  if (soon) {
    const on = new Date(soon.date).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const src = `${f.maturities.form || 'filing'} text`;
    if (soon.m < 4) { trigger = true; add('maybe', `Debt matures ${on} (${src}): under 4 months, likely already being refinanced`); }
    else if (soon.kind === 'revolver') {
      if (lev0 != null && lev0 >= 3) { trigger = true; add('good', `Revolving facility matures ${on} (${src}): a renewal its bank may not simply roll at this leverage`, 10); }
      else add('info', `Revolving facility matures ${on} (${src}): usually renewed by its bank`);
    } else { trigger = true; add('good', `Debt matures ${on} (${src}): a dated refinancing deadline`, soon.m <= 12 ? 25 : soon.m <= 18 ? 20 : 10); }
  }
  const dueNow = dc >= 10e6 && cash != null && dc > cash;
  if (dueNow && real && real.length && !soon) add('maybe', 'Balance sheet shows debt due within 12 months, but the filing dates every maturity 2+ years out: check the debt note');
  if (dueNow) { trigger = true; add('good', `${money(dc)} of term debt due within 12 months vs ${money(cash)} cash${when}: must refinance`, 30 + Math.min(15, Math.round((dc / Math.max(cash, 1e6) - 1) * 5))); }
  else if (dc >= 10e6 && cash != null && dc > 0.5 * cash) add('good', `${money(dc)} due within 12 months, ${Math.round(dc / cash * 100)}% of its cash${when}`, 10);
  // Rescue (3 Nov 2026, Tengku: the 100s were XCF / Hydrofarm with negative EBITDA): private credit refinances companies that
  // can pay interest, so distress only scores when cash flow can carry a new loan.
  const e = s.ebitda, ix = s.interest_expense, net = total - (cash || 0);
  // No debt on file = no leverage figure (it used to read as net cash and get "bank will refinance").
  const lev = e > 0 && total > 0 ? net / e : null, cover = e > 0 && ix > 0 ? e / ix : null;
  const rescue = e != null && (e <= 0 || (lev != null && (lev > 10 || (cover != null && cover < 1))));
  if (f.forbearance) { trigger = true; add('good', `Lender forbearance agreement (${f.forbearance.form} ${f.forbearance.date}): current lender is losing patience`, rescue ? 10 : 30); }
  if (f.going_concern) { trigger = true; add('good', `Going-concern doubt disclosed (${f.going_concern.form} ${f.going_concern.date}): needs rescue or bridge financing`, rescue ? 0 : 15); }
  if (s.revolver_current >= 5e6) add('info', `Plus ${money(s.revolver_current)} on a revolving line (classed as current but usually rolls over)`);
  if (s.revenue >= 20e6 && s.revenue <= 200e6) add('good', `${money(s.revenue)} revenue: Peter's sweet spot ($20-200M), too small for the big advisers to chase`, 10);
  else if (s.revenue > 200e6 && s.revenue <= 1e9) add('good', `${money(s.revenue)} revenue: enough cash flow for a private loan, but the big advisers may already be there`, 3);
  if (s.public_float != null && s.public_float <= 300e6) add('good', `Small cap (public float ${money(s.public_float)}): too small for the bond market`, 10);
  if (total >= 20e6 && total <= 300e6) add('good', `${money(total)} total debt: the size Peter's private credit lenders write`, 8);
  // Peter's leverage screen (8 Oct 2026): debt against cash flow. Net debt over 7x EBITDA with interest covered under 2x
  // usually ends in a restructuring or an expensive refinancing. And the audit's catch: a maturity alone means little when
  // cash flow is strong (net debt under 3x, interest covered 4x+): the bank refinances it, so it drops down the list.
  // Lendable band: 3-7x with interest covered 1.2x+ is what a private credit lender can refinance (AMS, DLH).
  if (e != null) {
    // Any cash burn is a rescue: net cash just means a runway (Karyopharm), and missing debt tags hide the debt (Celularity).
    if (e <= 0) { trigger = true; tags.add('burning_cash'); add('cut', `Negative EBITDA (${money(e)})${net > 0 ? ` with ${money(net)} net debt` : ''}: burning cash, a rescue that private credit rarely refinances`, -20); }
    else if (rescue) { trigger = true; tags.add('over_levered'); add('cut', `Net debt ${lev.toFixed(1)}x EBITDA${cover != null ? `, interest covered ${cover.toFixed(1)}x` : ''}: a rescue, private credit rarely refinances this`, -15); }
    else if (lev != null && lev >= 7 && (cover == null || cover < 2)) { tags.add('stretched'); trigger = true; add('good', `Net debt ${lev.toFixed(1)}x EBITDA${cover != null ? `, interest covered ${cover.toFixed(1)}x` : ''}: likely to need a restructuring or refinancing (Peter's screen)`, 25); }
    else if (lev != null && lev >= 5) tags.add('stretched'), add('good', `Net debt ${lev.toFixed(1)}x EBITDA: highly levered`, 8);
    else if (lev != null && lev < 3 && (cover == null || cover >= 4) && !f.forbearance && !f.going_concern) tags.add('bank_refi'), add('maybe', `Strong cash flow (net debt ${Math.max(lev, 0).toFixed(1)}x EBITDA${cover != null ? `, interest covered ${cover.toFixed(1)}x` : ''}): its bank will refinance it, so it won't pay us`, -15);
  }
  if (lev != null && lev >= 3 && lev < 7 && (cover == null || cover >= 1.2)) tags.add('lendable'), add('good', `Lendable: net debt ${lev.toFixed(1)}x EBITDA${cover != null ? `, interest covered ${cover.toFixed(1)}x` : ''}, cash flow a private credit lender can refinance`, 10);
  // Net cash (Akebia, Vireo, Beachbody): it can repay the maturity from cash, no lender needed.
  if (total > 0 && cash != null && cash >= total && !f.forbearance && !f.going_concern) tags.add('bank_refi'), add('maybe', `Cash ${money(cash)} covers all ${money(total)} of debt: it can repay without a new lender`);
  // A loan under $10M is too small for Peter's lenders (Mannatech $3M, Aeries $1.6M were targets on a going-concern hit alone).
  if (total > 0 && total < 10e6) tags.add('small_loan'), add('cut', `Only ${money(total)} of debt: too small a loan for private credit lenders`);
  // Who can pay us (HI Mark lesson, 21 Oct): a retainer needs real cash flow; under $2M EBITDA it's success fee only.
  if (e >= 5e6) tags.add('can_pay'), add('good', `EBITDA ${money(e)}: can pay a monthly retainer`, 5);
  else if (e > 0 && e < 2e6) add('info', `EBITDA ${money(e)}: too thin for a retainer, success fee only`);
  if (f.forbearance || f.going_concern) tags.add('lane_rescue'); else if (trigger) tags.add('lane_refi');
  // Numbers more than ~9 months old: the problem may already be fixed.
  if (s.period_end && Date.now() - Date.parse(s.period_end) > 270 * 864e5) add('info', `Balance sheet from ${s.period_end}: check the latest filing before calling`, -5);
  if (!trigger) add('maybe', 'No refinancing deadline, leverage problem, forbearance or going-concern warning found');
  // Numbers we can't trust: no EBITDA, no debt on file, or interest cover too high to be real (1847 Holdings showed 60.9x).
  if (e == null || !total || (cover != null && cover > 30)) { tags.add('check_data'); add('maybe', e == null ? 'EBITDA not found in its filings: check the 10-Q' : !total ? 'No debt figure in its filings: check the 10-Q' : `Interest covered ${cover.toFixed(0)}x looks wrong: check the 10-Q`); }
  const verdict = R.some(r => r.tone === 'cut') ? 'cut' : R.some(r => r.tone === 'maybe') ? 'maybe' : 'target';
  const score = Math.max(0, Math.min(100, R.reduce((n, r) => n + r.pts, 0)));
  return { verdict, score: verdict === 'cut' ? Math.min(score, 20) : score, reasons: R.map(({ tone, text }) => ({ tone, text })), tags: [...tags] };
}
