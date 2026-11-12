// Pipeline → BDC loans: private companies that borrow from BDCs (public lending funds), from the SEC's BDC data sets. Each BDC lists
// every loan it holds each quarter: borrower, principal, the lender's own mark (fair value), maturity, rate, PIK. So size is a real
// number, not an estimate. Filled by scripts/bdc_signals.py on GitHub; judged on the server (classifyBdc in
// supabase/functions/bdc-signals/rules.js). Filters kept in localStorage 'hq-bdc-filters'.
import { sb, state, esc, $, $$, toast, fail, modal, opts, firstName } from './core.js';
import { messageFor } from './outreach.js';
import { whyBlock } from './kinds.js';
import { loadContacts, contactHtml, bindContacts, bestPerson, contactsSetup } from './contacts.js';
import { markBtns, markLine, bindMarks, MARK_VIEWS, inMarkView } from './marks.js';

let el = null, rows = [], runs = [], view = 'target', onCount = () => {};
const money = n => n == null ? '—' : n >= 1e9 ? '$' + +(n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? '$' + +(n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + Math.round(n / 1e3) + 'K' : '$' + Math.round(n);
const mon = v => v ? new Date(String(v).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : '';
const toneOf = t => t === 'good' ? 'good' : t === 'cut' ? 'bad' : t === 'maybe' ? 'warn' : '';
const bucket = s => s.status === 'added' ? 'added' : s.status === 'dismissed' ? 'dismissed' : s.verdict;
const GH_RUN = 'https://github.com/HyperionLLAMA/outerhaven-dashboard2/actions/workflows/fund-signals.yml';
const monthsTo = d => d ? Math.round((Date.parse(d) - Date.now()) / (30.44 * 864e5)) : null;
const whenLabel = d => { const days = Math.round((Date.parse(d) - Date.now()) / 864e5), mo = Math.round(days / 30.44); return days < 0 ? (days > -45 ? `matured ${-days} days ago` : `matured ${-mo} months ago`) : days < 45 ? `in ${days} days` : `${mo} months`; };
const shortName = n => String(n || '').replace(/,?\s+(inc|corp|corporation|co|company|ltd|limited|llc|l\.l\.c\.|lp|l\.p\.|llp|pc)\.?$/i, '').trim();
const brand = n => shortName(n).replace(/\s+(buyer|midco|bidco|topco|holdco|parent|purchaser|acquisition|acquiror|intermediate|borrower|holdings?)(\s+(i|ii|iii|iv))?$/i, '').trim();
const cfoSearch = s => `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${brand(s.company_name)} (CFO OR CEO OR "chief financial")`)}`;
const webSearch = s => `https://www.google.com/search?q=${encodeURIComponent(`"${brand(s.company_name)}" ${s.industry || ''}`)}`;
const bdcShort = n => String(n || '').replace(/,?\s+(INC|CORP|CORPORATION|LLC|LP|L\.P\.|LTD|FUND|CO)\.?$/i, '').toLowerCase().replace(/\b[a-z]/g, x => x.toUpperCase()).replace(/\bBdc\b/g, 'BDC');

async function load() {
  const [c, r] = await Promise.all([
    sb.from('bdc_signals').select('*').neq('verdict', 'cut').order('score', { ascending: false }).limit(4000),
    sb.from('bdc_signal_runs').select('*').order('created_at', { ascending: false }).limit(3),
  ]);
  if (c.error) { rows = null; return; }
  rows = c.data || []; runs = r.data || [];
  await loadContacts('bdc', true).catch(() => null);
}
export function bdcTargetCount() { return rows ? rows.filter(s => bucket(s) === 'target' && (s.lane || 'refi') === 'refi').length : 0; }

export async function renderBdc(target, countCb) {
  el = target; onCount = countCb || onCount;
  if (!rows?.length) el.innerHTML = '<div class="empty">Loading BDC loans…</div>';
  await load();
  if (el.isConnected) draw();
}

const SIGNALS = {
  due12: ['Matures within 12 months', s => { const m = monthsTo(s.earliest_maturity); return m != null && m <= 12; }],
  due18: ['Matures within 18 months', s => { const m = monthsTo(s.earliest_maturity); return m != null && m <= 18; }],
  stressed: ['Marked under 90¢', s => s.mark != null && s.mark < 90],
  falling: ['Marked down 5+ this quarter', s => s.mark != null && s.prev_mark != null && s.prev_mark - s.mark >= 5],
  nonaccrual: ['Non-accrual', s => s.nonaccrual], pik: ['Paying interest in kind', s => s.pik],
};
const SIZES = { '': 'Any size', '10-25': '$10–25M', '25-50': '$25–50M', '50-75': '$50–75M', '75-150': '$75–150M' };
const LENDERS = { '': 'Any lender', lmm: 'Lower middle market only', big: 'Includes a big platform' };
const SORTS = { score: 'Score', mat: 'Soonest maturity', mark: 'Lowest mark', size: 'Largest' };
const LANES = { refi: 'Company refinancing (outreach)', loan_sale: 'Loan sale (Peter calls the lender)', all: 'Both lanes' };
const NOF = { q: '', ind: '', size: '', sig: '', lend: '', lane: 'refi', sort: 'score' };
let F = { ...NOF };
try { F = { ...NOF, ...JSON.parse(localStorage.getItem('hq-bdc-filters') || '{}') }; } catch { /* private window */ }
const saveF = () => { try { localStorage.setItem('hq-bdc-filters', JSON.stringify(F)); } catch { /* ignore */ } };
const active = () => Object.keys(NOF).filter(k => k !== 'sort' && k !== 'lane' && F[k]).length;
// Rows judged before rules v4 have no lane: treat as refi.
const laneOf = s => s.lane || 'refi';
const isBig = s => (s.reasons || []).some(r => /Upper-middle-market lender/.test(r.text));
const isLmm = s => (s.reasons || []).some(r => /Lower-middle-market lenders only/.test(r.text));

function passes(s) {
  if (F.q) { const q = F.q.toLowerCase(); if (![s.company_name, s.industry, ...(s.holders || []).map(h => h.bdc)].some(x => String(x || '').toLowerCase().includes(q))) return false; }
  if (F.ind && s.industry !== F.ind) return false;
  if (F.size) { const [lo, hi] = F.size.split('-').map(x => +x * 1e6); if (s.facility < lo || s.facility >= hi) return false; }
  if (F.sig && !SIGNALS[F.sig]?.[1](s)) return false;
  if (F.lend === 'lmm' && !isLmm(s)) return false;
  if (F.lend === 'big' && !isBig(s)) return false;
  if (F.lane !== 'all' && laneOf(s) !== F.lane) return false;
  return true;
}
const sorter = {
  score: (a, b) => b.score - a.score || (a.earliest_maturity || '9').localeCompare(b.earliest_maturity || '9'),
  mat: (a, b) => (a.earliest_maturity || '9').localeCompare(b.earliest_maturity || '9'),
  mark: (a, b) => (a.mark ?? 999) - (b.mark ?? 999), size: (a, b) => (b.facility || 0) - (a.facility || 0),
};
function selectHtml(key, label, entries) {
  return `<label class="ucF"><span>${label}</span><select class="select" data-f="${key}">${entries.map(([v, t]) => `<option value="${esc(v)}"${String(F[key]) === String(v) ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
}
const tally = fn => { const m = {}; rows.forEach(s => { const v = fn(s); if (v) m[v] = (m[v] || 0) + 1; }); return Object.entries(m).sort((a, b) => b[1] - a[1]); };

function draw() {
  if (rows === null) { el.innerHTML = '<div class="empty">The BDC loans table isn\'t set up yet.</div>'; return; }
  const last = runs[0], st = last?.stats || {};
  el.innerHTML = `<div class="fs">
    <div class="fsTop"><p class="pHint" style="padding:0;margin:0;max-width:700px">Private companies with <b>$10–150M of debt</b> from public lending funds (BDCs), where the loan matures within 18 months or the lender has marked it down. Size, maturity and the lender's own valuation come straight from the lenders' SEC filings, not estimates.</p>
      <div class="row fsBtns"><a class="btn sm ghost" href="${GH_RUN}" target="_blank" rel="noopener">Run a scan on GitHub ↗</a><button class="btn sm ghost" id="bdHow">How it works</button><a class="btn sm ghost" href="#/rules">How we qualify</a><button class="btn sm ghost" id="ctSetup">Contacts setup</button></div></div>
    <p class="pHint">Source: the SEC's BDC data sets (every BDC's loan list, monthly). Free.${last ? ` Last run <b>${new Date(last.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</b>${st.bdcs ? ` · ${st.bdcs} BDCs, ${Number(st.borrowers || 0).toLocaleString()} borrowers read` : ''}.` : ' Not run yet: on GitHub choose Run workflow, mode <b>bdc</b>.'}</p>
    <div class="ucFilters">
      <label class="ucF ucQ"><span>Search</span><input class="input" data-f="q" type="search" placeholder="Company, industry or lender" value="${esc(F.q)}"></label>
      ${selectHtml('lane', 'Lane', Object.entries(LANES))}
      ${selectHtml('size', 'Debt', Object.entries(SIZES))}
      ${selectHtml('sig', 'Signal', [['', 'Any signal'], ...Object.entries(SIGNALS).map(([k, v]) => [k, v[0]])])}
      ${selectHtml('lend', 'Lenders', Object.entries(LENDERS))}
      ${selectHtml('ind', 'Industry', [['', 'All industries'], ...tally(s => s.industry).map(([k, n]) => [k, `${k} (${n})`])])}
      ${selectHtml('sort', 'Sort by', Object.entries(SORTS))}
      <button type="button" class="btn sm ghost ucReset" id="bdReset"${active() ? '' : ' hidden'}>Clear filters</button>
    </div>
    <div id="bdBody"></div>
  </div>`;
  $('#bdHow', el).onclick = howModal;
  $$('[data-f]', el).forEach(i => { i.oninput = i.onchange = () => { F[i.dataset.f] = i.value; saveF(); $('#bdReset', el).hidden = !active(); drawList(); }; });
  $('#bdReset', el).onclick = () => { F = { ...NOF, sort: F.sort, lane: F.lane }; saveF(); draw(); };
  drawList();
}

function drawList() {
  const body = $('#bdBody', el); if (!body) return;
  const counts = { target: 0, maybe: 0, added: 0, dismissed: 0, starred: 0, flagged: 0 };
  const pass = rows.filter(passes);
  onCount(rows.filter(s => bucket(s) === 'target' && laneOf(s) === 'refi').length);
  pass.forEach(s => { counts[bucket(s)] = (counts[bucket(s)] || 0) + 1; if (s.starred_at) counts.starred++; if (s.flagged_at) counts.flagged++; });
  const shown = pass.filter(s => inMarkView(view, s) ?? bucket(s) === view).sort(sorter[F.sort] || sorter.score);
  body.innerHTML = `<div class="fsViews">${[['target', 'Targets'], ['maybe', 'Maybe'], ['added', 'In pipeline'], ['dismissed', 'Dismissed'], ...MARK_VIEWS].map(([k, l]) => `<button type="button" data-view="${k}" class="${view === k ? 'on' : ''}" data-tone="${k === 'target' ? 'good' : ''}">${l} <b>${counts[k] || 0}</b></button>`).join('')}</div>
    ${active() ? `<p class="pHint" style="margin:0">${pass.length.toLocaleString()} of ${rows.length.toLocaleString()} companies match the filters.</p>` : ''}
    <div class="fsList">${shown.length ? shown.slice(0, 200).map(rowHtml).join('') : `<div class="empty">${rows.length ? (active() ? 'Nothing matches these filters.' : 'Nothing here.') : 'No companies yet. Run the scan on GitHub (mode bdc); it takes about 5 minutes.'}</div>`}</div>
    ${shown.length > 200 ? `<p class="pHint">Showing the top 200 of ${shown.length}. Narrow it with the filters.</p>` : ''}`;
  bind(shown);
}

function rowHtml(s) {
  const mo = monthsTo(s.earliest_maturity), drop = s.mark != null && s.prev_mark != null ? Math.round(s.prev_mark - s.mark) : 0;
  const facts = [
    `Debt <b>${money(s.facility)}</b> <span class="muted">(held by BDCs)</span>`,
    s.facility ? `EBITDA <b>~${money(s.facility / 5.5)}–${money(s.facility / 4)}</b> <span class="muted">(implied)</span>` : '',
    s.earliest_maturity ? `Matures <b>${mon(s.earliest_maturity)}</b> <span class="muted">(${whenLabel(s.earliest_maturity)})</span>` : '',
    s.mark != null ? `Mark <b>${Math.round(s.mark)}¢</b>${drop >= 3 ? ` <span class="muted">(was ${Math.round(s.prev_mark)}¢)</span>` : ''}` : '',
    s.spread ? `Spread <b>S+${(+s.spread).toFixed(2)}%</b>` : '',
    s.industry ? esc(s.industry) : '',
  ].filter(Boolean);
  const holders = s.holders || [];
  return `<article class="fsRow" data-tone="${toneOf(s.verdict === 'target' ? 'good' : s.verdict)}">
    <div class="fsScore"><b>${s.score}</b><span>score</span></div>
    <div class="fsMain">
      <h4>${esc(s.company_name)} <span class="fsVeh">${s.lenders} BDC lender${s.lenders === 1 ? '' : 's'}${s.pik ? ' · PIK' : ''}${s.nonaccrual ? ' · non-accrual' : ''}</span></h4>
      ${markLine(s)}
      <div class="fsFacts">${facts.map(x => `<span>${x}</span>`).join('')}</div>
      ${contactHtml('bdc', s.company_key, s)}
      ${whyBlock(s.reasons, esc)}
      <details class="ucLiens"><summary>Lenders (${holders.length})</summary><table><tbody>${holders.map(h => `<tr><td>${h.url ? `<a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(bdcShort(h.bdc))} ↗</a>` : esc(bdcShort(h.bdc))}</td><td>${money(h.principal)}</td><td>${h.principal ? Math.round(100 * h.fair / h.principal) + '¢' : ''}</td><td class="muted">${h.maturity ? 'matures ' + esc(mon(h.maturity)) : ''}${h.period ? ` · as of ${esc(mon(h.period))}` : ''}</td></tr>`).join('')}</tbody></table>
        ${s.sample ? `<p class="s muted" style="margin:6px 0 0">As filed: ${esc(s.sample)}</p>` : ''}</details>
      <div class="fsPeople"><a href="${cfoSearch(s)}" target="_blank" rel="noopener">Find the CFO / CEO on LinkedIn ↗</a><a href="${webSearch(s)}" target="_blank" rel="noopener">Website ↗</a></div>
    </div>
    <div class="fsAct">
      ${markBtns(s)}
      ${s.status !== 'added' ? `<button class="btn sm ${s.verdict === 'target' ? 'primary' : ''}" data-add="${s.id}">Add to pipeline</button>` : '<span class="pFlag good">In pipeline</span>'}
      <button class="btn sm" data-copy="${s.id}">Copy message</button>
      ${s.status === 'dismissed' ? `<button class="btn sm ghost" data-undo="${s.id}">Restore</button>` : s.status !== 'added' ? `<button class="btn sm ghost" data-dismiss="${s.id}">Dismiss</button>` : ''}
    </div></article>`;
}

// Peter's first message: leads with the refinancing window, never with the lender's mark (that's the lender's private view).
// The first message = the Prosp template (hq/outreach.js messageFor): one dated fact about their company, a small ask.
// No pitch paragraph, no "no pitch" (saying it makes people think of a pitch). Distress (marks, liens, going concern) is never named.
export function opener(s, name = '') { return messageFor('bdc', s, name); }

function bind(shown) {
  const find = id => shown.find(s => s.id === id) || rows.find(s => s.id === id);
  bindMarks(el, { table: 'bdc_signals', find, redraw: drawList });
  bindContacts(el, 'bdc', drawList);
  $('#ctSetup', el)?.addEventListener('click', contactsSetup);
  $$('[data-view]', el).forEach(b => b.onclick = () => { view = b.dataset.view; drawList(); });
  $$('[data-copy]', el).forEach(b => b.onclick = async () => {
    const t = opener(find(b.dataset.copy));
    try { await navigator.clipboard.writeText(t); toast('Message copied. Put their name in before sending.'); } catch { modal({ title: 'Message', submit: '', body: `<textarea class="input" rows="6" style="width:100%">${esc(t)}</textarea>` }); }
  });
  $$('[data-dismiss],[data-undo]', el).forEach(b => b.onclick = async () => {
    const id = b.dataset.dismiss || b.dataset.undo, st = b.dataset.dismiss ? 'dismissed' : 'new';
    if (fail(await sb.from('bdc_signals').update({ status: st, updated_at: new Date().toISOString() }).eq('id', id), 'Update')) return;
    const r = rows.find(x => x.id === id); if (r) r.status = st; drawList();
  });
  $$('[data-add]', el).forEach(b => b.onclick = () => addModal(find(b.dataset.add)));
}

function addModal(s) {
  const cp = bestPerson('bdc', s.company_key);
  modal({
    title: 'Add to pipeline', submit: 'Add',
    body: `<div class="form pForm"><p class="s muted" style="grid-column:1/-1;margin:0"><b>${esc(s.company_name)}</b>: ${money(s.facility)} of BDC debt${s.earliest_maturity ? `, matures ${esc(mon(s.earliest_maturity))}` : ''}. Find the CFO first: <a href="${cfoSearch(s)}" target="_blank" rel="noopener">LinkedIn search ↗</a></p>
      <label class="field">Name<input class="input" name="name" required placeholder="Jane Smith" value="${esc(cp?.name || '')}"></label>
      <label class="field">Title<input class="input" name="title" value="${esc(cp ? ({ cfo: 'CFO', ceo: 'CEO' }[cp.role] || cp.title || 'CFO') : 'CFO')}"></label>
      <label class="field" style="grid-column:1/-1">LinkedIn URL (optional)<input class="input" name="li" value="${esc(cp?.linkedin || '')}"></label>
      <label class="field" style="grid-column:1/-1">First step<input class="input" name="next" value="Connect and send the message (refinancing ahead of maturity)"></label>
      <label class="field">Owner<select class="select" name="owner">${opts(['Peter', 'Tengku', 'Chase', 'Anaz', 'Razeen'], 'Peter')}</select></label></div>`,
    async onSubmit(fd) {
      const now = new Date().toISOString(), name = String(fd.get('name')).trim(), li = String(fd.get('li') || '').trim() || null;
      const facts = `${s.company_name}: ${(s.reasons || []).filter(x => x.tone === 'good').map(x => x.text).join(' ')} Lenders: ${(s.holders || []).map(h => bdcShort(h.bdc)).join(', ')}.`;
      const r = await sb.from('people').insert({ name, primary_side: 'Sell Side', relationship_type: 'Sell-side Relationship', pipeline_stage: 'To Reach Out', owner_name: String(fd.get('owner') || '').trim() || null, pipeline_active: true, waiting_on: 'us', waiting_on_since: now, company_name: s.company_name, headline: String(fd.get('title') || '').trim() || null, linkedin_url: li, has_linkedin: !!li, source: 'BDC loan signal', last_inbound_message: facts, created_by: state.user?.id }).select().single();
      if (fail(r, 'Add')) return false;
      await sb.from('tasks').insert({ person_id: r.data.id, action: String(fd.get('next') || '').trim() || 'Connect and send the message', owner_name: fd.get('owner'), due_date: now.slice(0, 10), created_by: state.user?.id });
      await sb.from('bdc_signals').update({ status: 'added', person_id: r.data.id, updated_at: now }).eq('id', s.id);
      s.status = 'added'; s.person_id = r.data.id;
      try { await navigator.clipboard.writeText(opener(s, name)); toast(`${name} added. Message copied with their name.`); } catch { toast(`${name} added to Pipeline → Sell side`); }
      drawList();
    },
  });
}

function howModal() {
  modal({
    title: 'How BDC loans work', submit: '', wide: true,
    body: `<div class="fsHow">
      <h4>1. Who this finds</h4><p>Private companies that already borrow from private credit funds and have to refinance soon, or whose lender has started to worry. BDCs (business development companies) are the public lending funds of Ares, Golub, Main Street, Monroe and ~160 others; the law makes them list every loan they hold every quarter.</p>
      <h4>2. What the filings give us (exact, not estimated)</h4><ul>
      <li><b>Debt</b>: principal held by all BDCs together. It's a floor: the same lenders also hold pieces in private funds, so the real facility can be bigger, especially with the big platforms.</li>
      <li><b>Mark</b>: the lender's own fair value as cents on the dollar. Under 90¢ means the lender expects trouble.</li>
      <li><b>Maturity</b>, spread, PIK (interest added to the loan instead of paid), non-accrual (interest not being paid).</li>
      <li><b>EBITDA</b> is implied: debt ÷ 4–5.5× (normal senior leverage at this size).</li></ul>
      <h4>3. Size (Tengku, 8 Oct)</h4><p>Under $10M of debt is cut (not worth Peter's time). $10–75M is the core (~$2–17M EBITDA). $75–150M is the upper end. Over $150M is cut: the big banks and placement agents cover it.</p>
      <h4>4. Two lanes (rules v4, 12 Oct)</h4><ul>
      <li><b>Company refinancing</b> (default view; the only lane outreach sends): a performing loan with a deadline, so the company hires us to run the refinancing. Need: <b>+25</b> matures in 4–12 months, <b>+20</b> 12–18, <b>+10</b> 18–24; under 4 months = too late (the lender is already negotiating). <b>+8</b> marked 85–95¢ or down 3+ points this quarter (move before it gets worse).</li>
      <li><b>Loan sale</b>: marked under 85¢, non-accrual, or past due and marked down. The lender decides, not the company, so Peter calls the BDC about selling the loan. Needs Peter's <b>$20M</b> minimum. Maybe: matures in under 4 months (a sale takes 4–8 weeks, the lender is already negotiating), under 50¢ (already restructuring), a syndicated-loan buyer holds it (trades on bank desks), venture debt, or non-US. Several BDCs run by one manager count as one seller.</li>
      <li><b>Score</b> = points ÷ the lane's maximum × 100 (refinancing 64, loan sale 78): the best possible company scores 100.</li></ul>
      <h4>5. Who owns it and who lends</h4><ul>
      <li><b>Owner</b>: Find contacts also searches for a PE or corporate owner ("portfolio company of…", "acquired by…"). Owner found = Maybe in the refinancing lane: the owner runs it with its own bankers and won't pay us a retainer. No owner found scores nothing (not proof: filings use legal names or acronyms); Buyer / Midco / Parent names <b>−10</b> until checked.</li>
      <li><b>+5</b> lower-middle-market lenders only (Main Street, Monroe, Fidus…): smaller companies, but they back small PE sponsors too, so the owner check still decides. <b>−10</b> a big platform in the deal.</li>
      <li>Cut: controlled by its lender, held only by syndicated-loan buyers, public companies. Maybe: venture debt, a lender that also owns 5–25%, non-US. A PIK option on a loan marked near par is written in at closing, not stress.</li></ul>
      <p><a href="#/rules">Every rule for every list: How we qualify →</a></p>
      <h4>6. Limits</h4><ul><li>Borrower names are read from free text that every BDC formats differently; "As filed" under Lenders shows the original line.</li>
      <li>Holding-company names (Buyer, Midco, Parent) usually mean PE-owned: the decision maker is often the sponsor's deal team.</li></ul>
      <p class="s muted">The message never mentions the lender's mark: that's the lender's private view of the company.</p></div>`,
  });
}
