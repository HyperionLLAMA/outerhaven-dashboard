// Pipeline → Credit signals: small US public companies that need private credit (Peter's lane).
// Filled daily by the GitHub edgartools job (scripts/credit_signals.py) from SEC data; judged on the server
// (classifyCredit in supabase/functions/fund-signals/rules.js). Every verdict shows its reasons.
import { sb, state, esc, $, $$, toast, fail, modal, opts, firstName, fmtDate } from './core.js';
import { messageFor } from './outreach.js';
import { whyBlock } from './kinds.js';
import { loadContacts, contactHtml, bindContacts, bestPerson, contactsSetup, cfoChanged } from './contacts.js';
import { markBtns, markLine, bindMarks, MARK_VIEWS, inMarkView } from './marks.js';
import { me } from './tasks.js';

let el = null, rows = [], runs = [], view = 'target', tag = '', onCount = () => {};
// Lender-fit tags from classifyCredit (rules.js CREDIT_TAGS). Symbol + word, never colour alone.
const TAGS = { lendable: ['✓', 'Lendable'], stretched: ['⚠', 'Highly levered'], bank_refi: ['•', 'Bank will refinance'], check_data: ['?', 'Check the numbers'],
  burning_cash: ['✕', 'Burning cash'], over_levered: ['✕', 'Over-levered'], too_big: ['✕', 'Too big'], too_small: ['✕', 'Too small'], not_borrower: ['✕', 'Not a borrower'], chapter_11: ['✕', 'In Chapter 11'], non_us: ['?', 'Non-US'],
  lane_refi: ['▲', 'Refinancing'], lane_rescue: ['⚠', 'Rescue'], can_pay: ['✓', 'Can pay a retainer'], small_loan: ['✕', 'Loan too small'] };
const tagTxt = k => TAGS[k] ? `${TAGS[k][0]} ${TAGS[k][1]}` : k;
const money = n => n == null ? '—' : Math.abs(n) >= 1e9 ? '$' + +(n / 1e9).toFixed(1) + 'B' : Math.abs(n) >= 1e6 ? '$' + +(n / 1e6).toFixed(1) + 'M' : Math.abs(n) >= 1e3 ? '$' + Math.round(n / 1e3) + 'K' : '$' + Math.round(n);
const day = v => v ? new Date(String(v).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const toneOf = t => t === 'good' ? 'good' : t === 'cut' ? 'bad' : t === 'maybe' ? 'warn' : '';
const bucket = s => s.status === 'added' ? 'added' : s.status === 'dismissed' ? 'dismissed' : s.verdict;
const GH_RUN = 'https://github.com/HyperionLLAMA/outerhaven-dashboard/actions/workflows/fund-signals.yml';
const cfoSearch = s => `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent('CFO ' + s.company_name.replace(/,?\s+(inc|corp|corporation|co|ltd|llc|plc|holdings)\.?$/i, ''))}`;

async function load() {
  const [c, r] = await Promise.all([
    sb.from('credit_signals').select('*').order('score', { ascending: false }).limit(2000),
    sb.from('credit_signal_runs').select('*').order('created_at', { ascending: false }).limit(5),
  ]);
  if (c.error) { rows = null; return; }
  rows = c.data || []; runs = r.data || [];
  await loadContacts('credit', true).catch(() => null);
}
export function creditTargetCount() { return rows ? rows.filter(s => bucket(s) === 'target').length : 0; }

export async function renderCredit(target, countCb) {
  el = target; onCount = countCb || onCount;
  if (!rows?.length) el.innerHTML = '<div class="empty">Loading credit signals…</div>';
  await load();
  if (el.isConnected) draw();
}

function draw() {
  if (rows === null) { el.innerHTML = '<div class="empty">The credit signals table isn\'t set up yet.</div>'; return; }
  const counts = { target: 0, newcfo: 0, maybe: 0, cut: 0, added: 0, dismissed: 0, starred: 0, flagged: 0 };
  const newCfo = s => bucket(s) === 'target' && cfoChanged(String(Number(s.cik)));
  rows.forEach(s => { counts[bucket(s)]++; if (newCfo(s)) counts.newcfo++; if (s.starred_at) counts.starred++; if (s.flagged_at) counts.flagged++; });
  const inView = rows.filter(s => view === 'newcfo' ? newCfo(s) : inMarkView(view, s) ?? bucket(s) === view);
  const tagCounts = {}; inView.forEach(s => (s.tags || []).forEach(t => tagCounts[t] = (tagCounts[t] || 0) + 1));
  if (tag && !tagCounts[tag]) tag = '';
  const shown = inView.filter(s => !tag || (s.tags || []).includes(tag)).sort((a, b) => b.score - a.score);
  const last = runs[0];
  onCount(counts.target);
  el.innerHTML = `<div class="fs">
    <div class="fsTop"><p class="pHint" style="padding:0;margin:0;max-width:640px">Small US public companies with debt they must refinance, a lender losing patience, or a going-concern warning. For Peter: private credit is their natural next lender.</p>
      <div class="row fsBtns"><a class="btn sm ghost" href="${GH_RUN}" target="_blank" rel="noopener">Run a scan on GitHub ↗</a><button class="btn sm ghost" id="crHow">How it works</button><a class="btn sm ghost" href="#/rules">How we qualify</a><button class="btn sm ghost" id="ctSetup">Contacts setup</button></div></div>
    <p class="pHint">Source: SEC XBRL financials and full-text search (edgartools), refreshed daily on GitHub, free.${last ? ` Last run <b>${new Date(last.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</b>${last.params?.period ? ` · balance sheets ${esc(last.params.period)}` : ''}.` : ' Not run yet: on GitHub choose Run workflow, mode <b>credit</b>.'}</p>
    <div class="fsViews">${[['target', 'Targets'], ['newcfo', 'New CFO + debt'], ['maybe', 'Maybe'], ['cut', 'Cut'], ['added', 'In pipeline'], ['dismissed', 'Dismissed'], ...MARK_VIEWS].map(([k, l]) => `<button type="button" data-view="${k}" class="${view === k ? 'on' : ''}" data-tone="${k === 'target' ? 'good' : k === 'cut' ? 'bad' : ''}">${l} <b>${counts[k]}</b></button>`).join('')}</div>
    ${Object.keys(tagCounts).length ? `<div class="fsViews" aria-label="Filter by lender fit"><button type="button" data-tag="" class="${tag ? '' : 'on'}">All <b>${inView.length}</b></button>${Object.keys(TAGS).filter(k => tagCounts[k]).map(k => `<button type="button" data-tag="${k}" class="${tag === k ? 'on' : ''}">${esc(tagTxt(k))} <b>${tagCounts[k]}</b></button>`).join('')}</div>` : ''}
    <div class="fsList">${shown.length ? shown.slice(0, 200).map(rowHtml).join('') : `<div class="empty">${rows.length ? 'Nothing here.' : 'No companies yet. Run the credit scan on GitHub (mode credit); it takes about 5–10 minutes.'}</div>`}</div>
    ${shown.length > 200 ? `<p class="pHint">Showing the top 200 of ${shown.length}.</p>` : ''}
  </div>`;
  bind(shown);
}

// Real maturity dates read from the filing's own words (scripts/maturities.py, 6 Nov 2026). "Due in 12 months" on the
// balance sheet also counts revolvers / convertibles that mature in 2029-30, so the email hook comes from this, never from it.
function maturityHtml(m) {
  if (!m) return '';
  const it = (m.items || []).filter(x => !x.small), soon = it.filter(x => (Date.parse(x.date) - Date.now()) / 864e5 <= 730);
  const kindTxt = x => x.kind === 'revolver' ? ' (revolver)' : x.kind === 'term' ? ' (term debt)' : '';
  const when = x => new Date(x.date + 'T12:00:00Z').toLocaleDateString('en-GB', x.month_only ? { month: 'long', year: 'numeric' } : { day: 'numeric', month: 'long', year: 'numeric' });
  const src = `${esc(m.form || 'filing')}${m.filed ? ` filed ${fmtDate(m.filed)}` : ''}`;
  if (!soon.length) return `<p class="fsMat none">✕ <b>No debt maturity in the next 2 years</b> in the latest ${src}${it.length ? `: first is ${esc(when(it[0]))}` : ''}. The "due in 12 months" is likely a revolver or convertible booking. Not a refinancing hook.</p>`;
  return `<div class="fsMat"><b>▲ Matures ${esc(when(soon[0]))}${kindTxt(soon[0])}</b> <span class="muted s">· from the <a href="${esc(m.url)}" target="_blank" rel="noopener">${src} ↗</a>, check the quote before using it</span>
    <ul>${soon.slice(0, 3).map(x => `<li><b>${esc(when(x))}${kindTxt(x)}</b>: “${esc(x.quote)}”</li>`).join('')}</ul></div>`;
}

function rowHtml(s) {
  const f = s.flags || {}, total = (s.debt_current || 0) + (s.debt_noncurrent || 0);
  const facts = [
    s.debt_current != null ? `Due in 12 months <b>${money(s.debt_current)}</b>` : '',
    s.cash != null ? `Cash <b>${money(s.cash)}</b>` : '',
    total ? `Total debt <b>${money(total)}</b>` : '',
    s.ebitda != null ? `EBITDA <b>${money(s.ebitda)}</b>${s.ebitda > 0 ? ` (net debt <b>${(Math.max(0, total - (s.cash || 0)) / s.ebitda).toFixed(1)}x</b>)` : ''}` : '',
    s.ebitda > 0 && s.interest_expense > 0 ? `Interest covered <b>${(s.ebitda / s.interest_expense).toFixed(1)}x</b>` : '',
    s.revenue != null ? `Revenue <b>${money(s.revenue)}</b>` : '',
    s.public_float != null ? `Float <b>${money(s.public_float)}</b>` : '',
    [s.sic_desc, s.state].filter(Boolean).map(esc).join(' · '),
  ].filter(Boolean);
  // Loan type (XBRL instrument tags) → the market phrase for the opener. XBRL never names the lender: check the 10-Q.
  const dt = s.debt_types || [];
  const market = !s.debt_types ? '' : !dt.length ? 'Debt type not tagged: read the debt note in the 10-Q.'
    : dt.some(t => /Convertible|Bonds/.test(t)) ? 'Opener: compare against <b>the private credit market</b>.'
    : 'Opener: compare against <b>the non-bank market</b> (if the 10-Q names a credit fund as lender: <b>the wider private credit market</b>).';
  if (dt.length) facts.unshift(`Debt <b>${dt.map(esc).join(' · ')}</b>`);
  if ((s.tags || []).length) facts.unshift(`Lender fit <b>${s.tags.map(t => esc(tagTxt(t))).join(' · ')}</b>`);
  const ev = [f.forbearance && `<a href="${esc(f.forbearance.url)}" target="_blank" rel="noopener">Forbearance (${esc(f.forbearance.form)}) ↗</a>`,
    f.going_concern && `<a href="${esc(f.going_concern.url)}" target="_blank" rel="noopener">Going concern (${esc(f.going_concern.form)}) ↗</a>`,
    s.filing_url && `<a href="${esc(s.filing_url)}" target="_blank" rel="noopener">Latest 10-K/10-Q ↗</a>`].filter(Boolean);
  return `<article class="fsRow" data-tone="${toneOf(s.verdict === 'target' ? 'good' : s.verdict)}">
    <div class="fsScore"><b>${s.score}</b><span>score</span></div>
    <div class="fsMain">
      <h4>${esc(s.company_name)}${s.tickers ? ` <span class="fsVeh">${esc(s.tickers)}${s.exchange ? ' · ' + esc(s.exchange) : ''}</span>` : ''}</h4>
      ${markLine(s)}
      <div class="fsFacts">${facts.map(x => `<span>${x}</span>`).join('')}</div>
      ${maturityHtml(f.maturities)}
      ${market ? `<p class="pHint">${market}</p>` : ''}
      ${contactHtml('credit', String(Number(s.cik)), s)}
      ${whyBlock(s.reasons, esc)}
      <div class="fsPeople"><a href="${cfoSearch(s)}" target="_blank" rel="noopener">Find the CFO on LinkedIn ↗</a>${ev.join('')}</div>
    </div>
    <div class="fsAct">
      ${markBtns(s)}
      ${s.status !== 'added' ? `<button class="btn sm ${s.verdict === 'target' ? 'primary' : ''}" data-add="${s.id}">Add to pipeline</button>` : '<span class="pFlag good">In pipeline</span>'}
      <button class="btn sm" data-copy="${s.id}">Copy message</button>
      ${s.status === 'dismissed' ? `<button class="btn sm ghost" data-undo="${s.id}">Restore</button>` : s.status !== 'added' ? `<button class="btn sm ghost" data-dismiss="${s.id}">Dismiss</button>` : ''}
    </div></article>`;
}

// First message from Peter's side, using the numbers from their own filing. Personalise before sending.
// The first message = the Prosp template (hq/outreach.js messageFor): one dated fact about their company, a small ask.
// No pitch paragraph, no "no pitch" (saying it makes people think of a pitch). Distress (marks, liens, going concern) is never named.
export function opener(s, name = '') { return messageFor('credit', s, name); }

function bind(shown) {
  const find = id => shown.find(s => s.id === id) || rows.find(s => s.id === id);
  bindMarks(el, { table: 'credit_signals', find, redraw: draw });
  bindContacts(el, 'credit', draw);
  $('#ctSetup', el)?.addEventListener('click', contactsSetup);
  $$('[data-view]', el).forEach(b => b.onclick = () => { view = b.dataset.view; draw(); });
  $$('[data-tag]', el).forEach(b => b.onclick = () => { tag = b.dataset.tag; draw(); });
  $('#crHow', el).onclick = howModal;
  $$('[data-copy]', el).forEach(b => b.onclick = async () => {
    const t = opener(find(b.dataset.copy));
    try { await navigator.clipboard.writeText(t); toast('Message copied. Put the CFO\'s name in before sending.'); } catch { modal({ title: 'Message', submit: '', body: `<textarea class="input" rows="6" style="width:100%">${esc(t)}</textarea>` }); }
  });
  $$('[data-dismiss],[data-undo]', el).forEach(b => b.onclick = async () => {
    const id = b.dataset.dismiss || b.dataset.undo, st = b.dataset.dismiss ? 'dismissed' : 'new';
    if (fail(await sb.from('credit_signals').update({ status: st, updated_at: new Date().toISOString() }).eq('id', id), 'Update')) return;
    const r = rows.find(x => x.id === id); if (r) r.status = st; draw();
  });
  $$('[data-add]', el).forEach(b => b.onclick = () => addModal(find(b.dataset.add)));
}

// The company becomes a sell-side relationship (a borrower is a client with something to place with lenders).
function addModal(s) {
  const cp = bestPerson('credit', String(Number(s.cik)));
  modal({
    title: 'Add to pipeline', submit: 'Add',
    body: `<div class="form pForm"><p class="s muted" style="grid-column:1/-1;margin:0"><b>${esc(s.company_name)}</b>. Find the CFO first: <a href="${cfoSearch(s)}" target="_blank" rel="noopener">LinkedIn search ↗</a></p>
      <label class="field">CFO name<input class="input" name="name" required placeholder="Jane Smith" value="${esc(cp?.name || '')}"></label>
      <label class="field">LinkedIn URL (optional)<input class="input" name="li" value="${esc(cp?.linkedin || '')}"></label>
      <label class="field" style="grid-column:1/-1">First step<input class="input" name="next" value="Connect with the CFO and send the message (Peter's private credit angle)"></label>
      <label class="field">Owner<select class="select" name="owner">${opts(['Peter', 'Tengku', 'Chase', 'Anaz', 'Razeen'], 'Peter')}</select></label></div>`,
    async onSubmit(fd) {
      const now = new Date().toISOString(), name = String(fd.get('name')).trim(), li = String(fd.get('li') || '').trim() || null;
      const facts = `${s.company_name}${s.tickers ? ` (${s.tickers})` : ''}: ${(s.reasons || []).filter(x => x.tone === 'good').map(x => x.text).join('. ')}`;
      const r = await sb.from('people').insert({ name, primary_side: 'Sell Side', relationship_type: 'Sell-side Relationship', pipeline_stage: 'To Reach Out', owner_name: String(fd.get('owner') || '').trim() || null, pipeline_active: true, waiting_on: 'us', waiting_on_since: now, company_name: s.company_name, headline: 'CFO', linkedin_url: li, has_linkedin: !!li, source: 'SEC credit signal', last_inbound_message: facts, created_by: state.user?.id }).select().single();
      if (fail(r, 'Add')) return false;
      await sb.from('tasks').insert({ person_id: r.data.id, action: String(fd.get('next') || '').trim() || 'Connect with the CFO', owner_name: fd.get('owner'), due_date: now.slice(0, 10), created_by: state.user?.id });
      await sb.from('credit_signals').update({ status: 'added', person_id: r.data.id, updated_at: now }).eq('id', s.id);
      s.status = 'added'; s.person_id = r.data.id;
      try { await navigator.clipboard.writeText(opener(s, name)); toast(`${name} added. Message copied with their name.`); } catch { toast(`${name} added to Pipeline → Sell side`); }
      draw();
    },
  });
}

function howModal() {
  modal({
    title: 'How credit signals work', submit: '', wide: true,
    body: `<div class="fsHow">
      <h4>1. Who this finds</h4><p>US public companies that are too small for the bond market and need a new lender soon: Peter's private credit lane.</p>
      <h4>2. Where the data comes from</h4>
      <ul><li><b>Balance sheets for every public company</b> (SEC XBRL data, one pull per line item): debt due within 12 months, long-term debt, cash, last year's revenue, public float.</li>
      <li><b>Full-text search of filings from the last 180 days</b>: "forbearance agreement" (8-K, 10-Q, 10-K) and "substantial doubt … going concern" (10-K, 10-Q).</li>
      <li><b>Company profile</b>: industry, ticker, exchange, state, latest 10-K/10-Q link.</li></ul>
      <h4>3. Cuts</h4><ul><li>Banks, insurers and funds.</li><li>Revenue under $20M: no cash flow to lend against (most pre-revenue biotech).</li><li>Over $750M of debt, or public float over $2B: banks and bonds cover them.</li></ul>
      <h4>4. Score (higher = call first)</h4><ul><li><b>+40</b> debt due within 12 months is more than its cash: must refinance.</li><li><b>+35</b> lender forbearance agreement.</li><li><b>+20</b> going-concern warning.</li><li><b>+15</b> debt due within 12 months over half its cash.</li><li><b>+10</b> public float under $300M.</li><li><b>+8</b> total debt $20–300M.</li></ul>
      <p>A company needs at least one trigger (refinancing deadline, forbearance or going-concern) to be a Target; otherwise it's a Maybe.</p>
      <h4>5. What it can't see</h4><ul><li>Debt terms (rate, covenants, exact maturity date): read the debt note in the 10-K before calling.</li><li>Whether they already have a refinancing lined up: check the latest 8-K.</li><li>Companies that tag debt with their own custom XBRL names.</li></ul>
      <p class="s muted">Arranging a loan is usually not a securities transaction, but placing notes or bonds can be. Check with counsel before charging a success fee on a public company's financing.</p></div>`,
  });
}
