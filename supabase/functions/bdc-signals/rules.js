// BDC loans rules: which BDC-financed private companies are worth Peter's call. Pure JS (no imports) so HQ and tests can read it.
// Input: a bdc_signals row (scripts/bdc_signals.py). Every verdict stores its reasons.
// Size (Tengku, 8 Oct 2026): under $10M of debt wastes Peter's time; over ~$150M the big banks and placement agents take it.
// $10-75M is the core (~$2-17M EBITDA at the usual 4-5.5x leverage), $75-150M the upper end.
// v2: weights rescaled after the first live run (half the targets scored 100, so the score didn't rank anything).
// v3: a maturity that passed AFTER the lenders' last report is unknown (extended, refinanced or defaulted), not 'still outstanding';
// stressed loans show the refinancing gap (debt minus the lenders' own value), which a plain refinancing can't close.
// v4 (12 Oct 2026, Tengku: Global Integrated Flooring was No. 1 and shouldn't have been): two lanes, scored separately.
//   'refi' = the company refinances a performing loan and hires us (outreach to the company). Distress is no longer a plus here.
//   'loan_sale' = marked under 85¢, non-accrual, or past due and marked down: the lender decides, so Peter pitches the BDC to sell
//   the loan. Needs Peter's $20M minimum (loan buyers want size). Too late (< 4 months to maturity) = the lender is already negotiating.
//   Owner found by search (s.owner, signal-contacts) = not founder-owned: the owner runs the refinancing, so refi drops to maybe.
// v5 (12 Oct 2026, Tengku: Datalink at 42 days and 72¢ sat in the loan-sale top 3): a loan maturing in under 4 months can't be sold in
//   time (NDA, diligence and settlement take 4-8 weeks; the lender and owner are already negotiating), so it's Maybe in both lanes.
//   Lenders count by manager, not by fund (BCP Investment + BC Partners Lending = one seller). Scores shown out of 100 = points ÷ the
//   lane's maximum (refi 69, loan sale 78); verdicts are decided on the points, so rescaling changes no verdict and no order.
// v6 (12 Oct 2026, TAUC Management = Total Access Urgent Care, owned by ICV Partners; search on "TAUC" found nothing): no owner found
//   no longer scores (+5 "possibly founder-owned" removed, refi max 64); it's a Check line instead.
export const BDC_RULES_VERSION = 7;
// Company web check (fund-web company.js, 13 Nov 2026): news from the past year that makes a maturity pitch wrong. A fact dated
// before our filing is already in the numbers (info); after it, or undated, it changes the call.
export function webNews(web, since) {
  const out = [];
  if (!web) return out;
  const when = f => f.date ? `news ${f.date}` : 'news, date unknown', src = f => ` (${f.source || 'web'}: "${String(f.quote).slice(0, 160)}")`;
  const fresh = f => !f.date || !since || f.date > since;
  if (web.sale) out.push(fresh(web.sale) ? { tone: 'maybe', pts: -20, text: `Being sold (${when(web.sale)}): the buyer decides how its debt is refinanced${src(web.sale)}` } : { tone: 'info', pts: 0, text: `Sale news from ${web.sale.date}, before the filing: check it's still live${src(web.sale)}` });
  if (web.refi) out.push(fresh(web.refi) ? { tone: 'maybe', pts: web.refi.date ? -15 : -5, text: `May already be refinanced (${when(web.refi)}): read it before any message${src(web.refi)}` } : { tone: 'info', pts: 0, text: `Financing news from ${web.refi.date}, before the filing (already in its numbers)${src(web.refi)}` });
  if (web.adviser && fresh(web.adviser)) out.push({ tone: 'maybe', pts: -10, text: `Already has a banker or adviser (${when(web.adviser)}): we'd be second in line${src(web.adviser)}` });
  if (!web.sale && !web.refi && !web.adviser) out.push({ tone: 'info', pts: 0, text: `Web check ${web.at}: no refinancing, adviser or sale news in the past year` });
  return out;
}

export const SIZE = { min: 10e6, core: 75e6, max: 150e6, sale: 20e6 };
// Most points a row can get in each lane (sum of every positive rule below). Change these with any rule's points.
export const MAX = { refi: 15 + 25 + 8 + 8 + 3 + 5, loan_sale: 20 + 25 + 8 + 10 + 10 + 5 };
const TOO_LATE = 122;   // days: under ~4 months a refinancing or a loan sale can't close before maturity

// Lender families by BDC name. Big platforms = upper middle market (sponsor deals, facility far bigger than the BDC piece);
// syndicated = broadly syndicated loan buyers (large public loans); lower middle market = owner-run and small-sponsor companies;
// venture = venture debt to VC-backed companies.
const BIG = /\b(ARES|BLACKSTONE|BLUE OWL|OWL ROCK|HPS|GOLUB|APOLLO|MIDCAP|GOLDMAN|MORGAN STANLEY|NORTH HAVEN|KKR|OAKTREE|SIXTH STREET|ANTARES|BARINGS|BAIN CAPITAL|CARLYLE|TCG BDC|BLACKROCK|JPMORGAN|J\.P\. MORGAN|NUVEEN|CHURCHILL|BROOKFIELD|TPG|ALLIANCEBERNSTEIN|AB PRIVATE|NEW MOUNTAIN|MSD|VISTA CREDIT|THOMA BRAVO|STONE POINT|PGIM|FIDELITY|T\. ROWE|OHA|BLACKROCK TCP|KAYNE|AUDAX|CRESCENT|HPS CORPORATE|STEPSTONE|JEFFERIES|ONEX|LORD ABBETT|MANULIFE|JOHN HANCOCK|AGL|26NORTH|SILVER POINT|BLUE OWL|ADAMS STREET|NORTHLEAF|CLIFFWATER|FRANKLIN BSP|KENNEDY LEWIS)\b/;
const SYNDICATED = /\b(PALMER SQUARE|CIFC|MUZINICH|STEELE CREEK|SENIOR CREDIT INVESTMENTS|NEXPOINT|THIRD POINT|EAGLE POINT|OXFORD SQUARE)\b/;
const LMM = /\b(MAIN STREET|MSC INCOME|CAPITAL SOUTHWEST|FIDUS|GLADSTONE|SARATOGA|MONROE|STELLUS|PHENIXFIN|OFS|GREAT ELM|WHITEHORSE|STAR MOUNTAIN|BRIGHTWOOD|COMVEST|LAFAYETTE SQUARE|INVESTCORP|HARVEST CAPITAL|RAND CAPITAL|EQUUS|PROSPECT|PORTMAN RIDGE|LOGAN RIDGE|CAPITALA|PENNANTPARK|FIRST EAGLE|CHICAGO ATLANTIC|ADVANCED FLOWER|SILVER SPIKE|SLR|BCP INVESTMENT|BC PARTNERS|MUZINICH BDC|DIAMOND HILL|DRIVE|TRINITY CAPITAL|VARAGON|STELLUS PRIVATE|LGAM|SCP PRIVATE|CCS|5C LENDING|MOUNT LOGAN)\b/;
const VENTURE = /\b(VENTURE LENDING|HERCULES|TRINITY CAPITAL|HORIZON TECHNOLOGY|RUNWAY GROWTH|TRIPLEPOINT|BIP VENTURES|WTI|WESTERN TECHNOLOGY|SURESTONE|CLARION)\b/;
// The manager behind a BDC: several BDCs share one manager and count as one lender / seller.
// shortcut: first word after a few known aliases; add an alias when two names of one manager show as two lenders.
const ALIAS = [[/^BCP\b/, 'BC'], [/^MSC INCOME\b/, 'MAIN'], [/^OWL ROCK\b/, 'BLUE'], [/^NORTH HAVEN\b/, 'MORGAN'], [/^TCG BDC\b/, 'CARLYLE'], [/^SCP PRIVATE\b/, 'SLR'], [/^HANCOCK PARK\b/, 'OFS']];
export const familyOf = bdc => { let n = String(bdc || '').toUpperCase().trim(); for (const [re, f] of ALIAS) if (re.test(n)) return f; return n.split(/\s+/)[0]; };
export const tierOf = bdc => { const n = String(bdc || '').toUpperCase(); return SYNDICATED.test(n) ? 'syndicated' : VENTURE.test(n) ? 'venture' : BIG.test(n) ? 'big' : LMM.test(n) ? 'lmm' : 'other'; };

const m = n => n >= 1e9 ? '$' + +(n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? '$' + +(n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M' : '$' + Math.round(n / 1e3) + 'K';
const mon = d => d ? new Date(d + 'T12:00:00Z').toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
const short = s => String(s || '').replace(/,? (INC|CORP|CORPORATION|LLC|FUND|LP|L\.P\.|LTD)\.?$/i, '').replace(/\b(\w)(\w*)/g, (w, a, b) => w.length <= 3 ? w : a + b.toLowerCase());
export const HOLDCO = /\b(buyer|midco|bidco|topco|holdco|parent|purchaser|acquisition|acquiror|intermediate|borrower|merger sub)\b/i;
// EBITDA the facility implies at the usual 4-5.5x senior leverage for this size.
export const ebitdaRange = f => f ? [f / 5.5, f / 4] : null;

export function classifyBdc(s, today = new Date()) {
  const reasons = [], f = Number(s.facility) || 0, mark = s.mark == null ? null : Number(s.mark), prev = s.prev_mark == null ? null : Number(s.prev_mark);
  const holders = Array.isArray(s.holders) ? s.holders : [], tiers = holders.map(h => tierOf(h.bdc));
  const out = (verdict, score, lane = null) => ({ verdict, score: lane ? Math.max(0, Math.min(100, Math.round(score / MAX[lane] * 100))) : 0, reasons, lane });
  if (s.on_latest === false) { reasons.push({ tone: 'cut', text: 'Not in the BDCs\' latest filings any more (repaid, refinanced or sold).' }); return out('cut', 0); }
  if (s.public_ticker) { reasons.push({ tone: 'cut', text: `Public company (${s.public_ticker}): see Credit signals.` }); return out('cut', 0); }
  if (s.controlled) { reasons.push({ tone: 'cut', text: 'Controlled by its BDC lender (the lender owns it): it won\'t hire an adviser to refinance its own owner.' }); return out('cut', 0); }
  if (tiers.length && tiers.every(t => t === 'syndicated')) { reasons.push({ tone: 'cut', text: 'Held only by syndicated-loan buyers: a large public loan run by the big banks.' }); return out('cut', 0); }
  const er = ebitdaRange(f), eb = er ? `~${m(er[0])}–${m(er[1])} EBITDA at 4–5.5× leverage` : '';
  if (f < SIZE.min) { reasons.push({ tone: 'cut', text: `BDCs hold ${m(f)} of its debt: under the $10M floor.` }); return out('cut', 0); }
  if (f > SIZE.max) { reasons.push({ tone: 'cut', text: `BDCs alone hold ${m(f)}: large enough that big banks and placement agents cover it.` }); return out('cut', 0); }

  const mat = s.earliest_maturity || s.maturity, days = mat ? Math.round((new Date(mat + 'T12:00:00Z') - today) / 864e5) : null;
  const mo = days == null ? null : Math.round(days / 30.4), after = s.period && mat && mat > String(s.period).slice(0, 10);
  const drop = mark != null && prev != null ? Math.round(prev - mark) : null, d = drop >= 3 ? ` (down ${drop} points this quarter)` : '';
  const names = [...new Set(holders.map(h => short(h.bdc)))].slice(0, 4).join(', '), managers = new Set(holders.map(h => familyOf(h.bdc))).size;
  const sale = !!s.nonaccrual || (mark != null && mark < 85) || (days != null && days < 0 && !after && mark != null && mark < 95);

  // Loan sale lane: the lender, not the company, decides what happens. Peter calls the BDC's portfolio manager.
  if (sale) {
    let score = 0, ok = true;
    reasons.push({ tone: 'info', text: `Loan sale lane: lenders hold it at ${mark == null ? '?' : Math.round(mark) + '¢'}${d}. The lender decides what happens next, not the company. Peter calls ${names || 'the lender'} about selling the loan; don't pitch the company.` });
    if (f < SIZE.sale) { ok = false; reasons.push({ tone: 'maybe', text: `${m(f)} of debt: under Peter's $20M minimum, and most loan buyers want $25M+.` }); }
    else { score += f <= SIZE.core ? 20 : 12; reasons.push({ tone: 'good', text: `${m(f)} of debt held by BDCs (${eb}): big enough for loan buyers.` }); }
    if (mark != null && mark < 50) { ok = false; reasons.push({ tone: 'maybe', text: `Marked at ${Math.round(mark)}¢: deep distress, likely already restructuring with advisers.` }); }
    else if (mark != null && mark < 80) { score += 25; reasons.push({ tone: 'good', text: `Marked at ${Math.round(mark)}¢: stressed. Lenders often sell at this level rather than work it out.` }); }
    else if (mark != null) { score += 15; reasons.push({ tone: 'good', text: `Marked at ${Math.round(mark)}¢: the lender expects trouble.` }); }
    if (drop >= 5) { score += 8; reasons.push({ tone: 'good', text: `Marked down ${drop} points in one quarter: getting worse.` }); }
    if (s.nonaccrual) { score += 10; reasons.push({ tone: 'good', text: 'On non-accrual at a lender (interest not being paid).' }); }
    if (days != null && days >= 0 && days < TOO_LATE) { ok = false; reasons.push({ tone: 'maybe', text: `Matures ${mon(mat)} (${Math.round(days)} days): too soon to sell. A loan sale takes 4–8 weeks and the lender is already negotiating an extension with the owner. Recheck after the next filing.` }); }
    else if (days != null && days >= 0 && days <= 365) { score += 10; reasons.push({ tone: 'good', text: `Matures ${mon(mat)} (${mo} months): the lender has to decide in the next few months.` }); }
    if (managers >= 2) { score += 5; reasons.push({ tone: 'info', text: `${managers} different lending managers: more than one seller to call.` }); }
    else if (holders.length >= 2) reasons.push({ tone: 'info', text: `${holders.length} BDCs but one manager (${names}): one seller.` });
    if (tiers.includes('syndicated')) { ok = false; reasons.push({ tone: 'maybe', text: `A syndicated-loan buyer holds it too (${names}): a broadly syndicated loan that trades on bank desks, not through Peter.` }); }
    else if (tiers.includes('big')) { score -= 10; reasons.push({ tone: 'maybe', text: `Upper-middle-market lender in the deal (${names}): big platforms rarely sell through outside advisers.` }); }
    if (tiers.includes('venture')) { ok = false; reasons.push({ tone: 'maybe', text: `Venture debt (${names}): loans to VC-backed companies rarely trade; the VCs and the lender work it out.` }); }
    if (s.country) { ok = false; reasons.push({ tone: 'maybe', text: s.country === 'Outside the US' ? 'Non-US company (foreign legal form in the name): outside Peter\'s US loan buyers.' : `Based in ${s.country}: outside Peter's US loan buyers.` }); }
    if (s.owner) reasons.push({ tone: 'info', text: `Owned by ${s.owner}: the owner negotiates with the lenders.` });
    for (const n of webNews(s.web, s.period && String(s.period).slice(0, 10))) reasons.push({ tone: 'info', text: n.text });
    return out(ok && score >= 35 ? 'target' : 'maybe', ok ? score : Math.min(score, 34), 'loan_sale');
  }

  // Refinancing lane: a performing loan with a deadline; the company hires an adviser to run the refinancing.
  let score = 0, trigger = false, maybe = false;
  if (f <= SIZE.core) { score += 15; reasons.push({ tone: 'good', text: `${m(f)} of debt held by BDCs (${eb}): in Peter's range.` }); }
  else { score += 3; reasons.push({ tone: 'maybe', text: `${m(f)} of debt held by BDCs (${eb}): upper end of Peter's range.` }); }
  if (days != null) {
    if (days < 0 && after) { score += 10; trigger = true; reasons.push({ tone: 'good', text: `Matured ${mon(mat)}, after the lenders' last report (${mon(String(s.period).slice(0, 10))}): it was extended, refinanced or defaulted since. Find out which before calling; the next filing will show it.` }); }
    else if (days < 0) { score += 5; reasons.push({ tone: 'maybe', text: `Filed maturity ${mon(mat)} has passed but lenders still mark it near par: probably extended. Check the latest terms.` }); }
    else if (days < TOO_LATE) { score += 5; reasons.push({ tone: 'maybe', text: `Matures ${mon(mat)} (${mo} months): too late to run a process, the lender is already negotiating an extension.` }); }
    else if (days <= 365) { score += 25; trigger = true; reasons.push({ tone: 'good', text: `Matures ${mon(mat)} (${mo} months): has to refinance now.` }); }
    else if (days <= 548) { score += 20; trigger = true; reasons.push({ tone: 'good', text: `Matures ${mon(mat)} (${mo} months): inside the 18-month refinancing window.` }); }
    else if (days <= 730) { score += 10; trigger = true; reasons.push({ tone: 'good', text: `Matures ${mon(mat)} (${mo} months): refinancing talks start in the next 6 months.` }); }
    else reasons.push({ tone: 'info', text: `Matures ${mon(mat)}: no deadline soon.` });
  } else reasons.push({ tone: 'info', text: 'Maturity not stated in the filing.' });

  // 85-95¢ = the lender is getting cautious but the loan is still refinanceable: a reason to move before it gets worse.
  if (mark != null) {
    if (mark < 95) { score += 8; reasons.push({ tone: 'good', text: `Marked at ${Math.round(mark)}¢${d}: the lender is getting cautious, a reason to refinance before it gets worse.` }); }
    else reasons.push({ tone: 'info', text: `Marked at ${Math.round(mark)}¢${d}: performing.` });
    if (drop >= 3) { score += 8; trigger = true; reasons.push({ tone: 'good', text: `Marked down ${drop} points in one quarter: the lender has started to worry.` }); }
  }
  // PIK on a loan still marked near par is usually a PIK option written in at closing, not stress.
  if (s.pik && mark != null && mark < 95) { score += 3; reasons.push({ tone: 'good', text: 'Paying part of its interest in kind (added to the loan): cash is tight.' }); }
  else if (s.pik) reasons.push({ tone: 'info', text: 'Has a PIK option, but the loan is marked near par: likely written in at closing, not stress.' });

  if (tiers.includes('venture')) { score -= 10; maybe = true; reasons.push({ tone: 'maybe', text: `Venture debt (${names}): VC-backed company, a different set of lenders.` }); }
  else if (tiers.includes('big')) { score -= 10; reasons.push({ tone: 'maybe', text: `Upper-middle-market lender in the deal (${names}): the full facility is likely bigger than BDCs show, and a PE sponsor usually runs the refinancing.` }); }
  else if (tiers.length && tiers.every(t => t === 'lmm' || t === 'other')) { score += 5; reasons.push({ tone: 'good', text: `Lower-middle-market lenders only (${names}): smaller companies, but these lenders back small PE sponsors too. Check the owner.` }); }
  if (managers >= 3) reasons.push({ tone: 'info', text: `${managers} lending managers: a club deal.` });
  if (s.affiliated) { maybe = true; reasons.push({ tone: 'maybe', text: 'A lender also owns 5–25% of it: ask whether the lender-owner would welcome outside capital.' }); }
  else if (s.equity_held) reasons.push({ tone: 'info', text: 'A lender also holds equity (co-investor).' });
  if (s.country) { score -= 10; maybe = true; reasons.push({ tone: 'maybe', text: s.country === 'Outside the US' ? 'Non-US company (foreign legal form in the name).' : `Based in ${s.country}.` }); }

  // Ownership: a PE or corporate owner runs the refinancing with its own bankers and won't pay us a retainer.
  if (s.owner) { maybe = true; reasons.push({ tone: 'maybe', text: `Owned by ${s.owner} (found in search; check it's still current): the owner runs the refinancing, not management. Pitch the owner's deal partner or skip.` }); }
  else if (HOLDCO.test(s.company_name || '')) { score -= 10; reasons.push({ tone: 'maybe', text: 'Holding-company name (Buyer / Midco / Parent): likely PE-owned. Confirm the owner before calling.' }); }
  // Not finding an owner proves nothing: filings use legal names or acronyms ("TAUC" = Total Access Urgent Care, ICV Partners-owned).
  else if (s.owner_checked_at) reasons.push({ tone: 'maybe', text: 'No owner found by search, which is not proof: most BDC borrowers are PE-backed and filings often use a legal name or acronym. Confirm before calling.' });
  else reasons.push({ tone: 'info', text: 'Owner not checked yet (Find contacts checks it).' });

  for (const n of webNews(s.web, s.period && String(s.period).slice(0, 10))) { score += n.pts; if (n.tone === 'maybe') maybe = true; reasons.push({ tone: n.tone, text: n.text }); }
  if (!trigger) { reasons.push({ tone: 'maybe', text: 'No trigger: nothing forces a refinancing in the next 4–24 months.' }); return out('maybe', Math.min(score, 34), 'refi'); }
  return out(maybe || score < 35 ? 'maybe' : 'target', maybe ? Math.min(score, 34) : score, 'refi');
}
