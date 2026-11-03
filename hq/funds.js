// Pipeline → Fund signals: US funds raising right now (SEC Form D filings, pulled through Apify) and Fund I managers
// due to raise Fund II. The edge function fund-signals scans, judges with fixed rules and checks for a later fund;
// this tab shows every verdict with its reasons, and turns a target into pipeline people with one click.
import { sb, state, esc, $, $$, toast, fail, modal, opts, firstName } from './core.js';
import { whyBlock } from './kinds.js';
import { me } from './tasks.js';
import { markBtns, markLine, bindMarks, MARK_VIEWS, inMarkView } from './marks.js';

let el = null, rows = [], runs = [], cfg = null, list = 'live', view = 'target', timer = null, onCount = () => {};
let stageF = '', stratF = ''; // filters: '' = all
const STAGE = { closed: ['Closed', 'good', 'Current fund has finished raising: the next-fund pitch fits'], stuck: ['Stuck raising', 'good', 'Current fund still open 12+ months in: pitch placement on this fund'], raising: ['Still raising', 'warn', 'Current fund open under 12 months: too early to pitch'], unclear: ['Close unclear', '', 'No proof yet that the current fund has closed: confirm on the first call'] };
const STRAT = { credit: 'Private credit', real_estate: 'Real estate', infra: 'Infra / energy', venture: 'Venture', buyout: 'Buyout / PE', other: 'Other' };
const DAY = 864e5;
const GH_RUN = 'https://github.com/chasehamby123/outerhaven-dashboard/actions/workflows/fund-signals.yml';
const GH_SECRETS = 'https://github.com/chasehamby123/outerhaven-dashboard/settings/secrets/actions';
const money = n => n == null ? '—' : n >= 1e9 ? '$' + +(n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? '$' + +(n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + Math.round(n / 1e3) + 'K' : '$' + Math.round(n);
const day = v => v ? new Date(v + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const toneOf = t => t === 'good' ? 'good' : t === 'cut' ? 'bad' : t === 'maybe' ? 'warn' : '';
const liSearch = (person, s) => `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(person + ' ' + (s.check_keyword || ''))}`;

async function call(body) {
  const { data, error } = await sb.functions.invoke('fund-signals', { body });
  if (error || data?.ok === false) throw new Error(data?.error || error?.message || 'Fund signals error');
  return data;
}

// Paged so nothing is silently capped. HQ opens with everything except cut rows (~1,900 of ~17,000; loading all of them
// took ~2 min). Cut rows for one list load only when someone opens the Cut view.
async function allSignals(cutList) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from('fund_signals').select('*');
    q = cutList ? q.eq('list', cutList).eq('verdict', 'cut').eq('status', 'new') : q.or('verdict.neq.cut,status.neq.new,starred_at.not.is.null,flagged_at.not.is.null');
    const r = await q.order('score', { ascending: false }).order('id').range(from, from + 999);
    if (r.error) return { error: r.error };
    out.push(...(r.data || []));
    if ((r.data || []).length < 1000) return { data: out };
  }
}
let checks = [], cutLoaded = {}, cutCount = {};
async function load() {
  cutLoaded = {};
  const [s, r, g, c, n] = await Promise.all([
    allSignals(),
    sb.from('fund_signal_runs').select('*').order('created_at', { ascending: false }).limit(60),
    sb.from('growth_settings').select('fund_scan_enabled,fund_monthly_budget').eq('id', 1).maybeSingle(),
    sb.from('fund_data_checks').select('*').order('created_at', { ascending: false }).limit(40),
    sb.rpc('signal_target_counts'),
  ]);
  if (s.error) { rows = null; return; }
  cutCount = n.data?.funds_cut || {};
  rows = s.data || []; runs = r.data || []; cfg = g.data || { fund_scan_enabled: false, fund_monthly_budget: 10 }; checks = c.data || [];
}

// Hard-check status line: latest self-test (known cases vs live SEC data) and latest audit (every row vs the SEC index).
function checksLine() {
  const st = checks.find(c => c.kind === 'selftest'), au = checks.find(c => c.kind === 'audit');
  const when = c => new Date(c.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const bits = [];
  if (st) bits.push(st.ok ? `<span class="pFlag good">Self-test passed</span> ${when(st)}` : `<span class="pFlag bad">Self-test FAILED</span> ${when(st)}: ${esc((st.failures || []).join(' · ').slice(0, 300))}`);
  if (au) bits.push(`${au.ok ? '<span class="pFlag good">Audit</span>' : '<span class="pFlag warn">Audit</span>'} ${when(au)}: ${au.checked} rows checked against the SEC, ${au.fixed} corrected${au.errors ? `, <b>${au.errors} unreadable</b> (retried next run)` : ''}`);
  return bits.length ? `<p class="pHint">Data checks: ${bits.join(' · ')}</p>` : '<p class="pHint">Data checks: none run yet.</p>';
}

// One row per fund: feeders, parallels and -A/-B vehicles of the same fund collapse into the best-scored one.
function grouped(l) {
  const m = new Map();
  for (const s of rows.filter(x => x.list === l)) {
    const k = s.fund_key || s.id, g = m.get(k);
    if (!g) m.set(k, { ...s, vehicles: [s] });
    else { g.vehicles.push(s); if (s.score > g.score) Object.assign(g, s, { vehicles: g.vehicles }); }
  }
  // A star or flag on any vehicle shows on the fund.
  for (const g of m.values()) for (const k of ['starred', 'flagged']) {
    const v = g.vehicles.find(x => x[k + '_at']);
    if (v) { g[k + '_at'] = v[k + '_at']; g[k + '_by'] = v[k + '_by']; if (k === 'flagged') g.flag_note = v.flag_note; }
  }
  return [...m.values()];
}
const bucket = s => s.status === 'added' ? 'added' : s.status === 'dismissed' ? 'dismissed' : s.verdict;

export function fundTargetCount() { return rows ? grouped('live').concat(grouped('fund1')).filter(s => bucket(s) === 'target').length : 0; }

export async function renderFunds(target, countCb) {
  el = target; onCount = countCb || onCount;
  if (!rows?.length) el.innerHTML = '<div class="empty">Loading fund signals…</div>';
  else draw(); // show what we have, then refresh
  await load();
  if (!el.isConnected) return;
  draw();
  const running = runs.filter(r => r.status === 'running');
  if (running.length) collect(true);
}

// Ask the server to pick up finished Apify runs. Repeats every 45 s while runs are going and the tab is open.
async function collect(quiet) {
  clearTimeout(timer);
  try { const r = await call({ action: 'poll' }); if (!quiet || r.finished) { await load(); if (el?.isConnected) draw(); } if (!quiet) toast(r.finished ? `Collected ${r.finished} finished run${r.finished === 1 ? '' : 's'}` : 'Still running on Apify'); }
  catch (e) { if (!quiet) toast(e.message); }
  if (el?.isConnected && runs.some(r => r.status === 'running')) timer = setTimeout(() => collect(true), 45000);
}

function draw() {
  if (rows === null) { el.innerHTML = '<div class="empty">The fund signals tables aren\'t set up yet.</div>'; return; }
  if (view === 'cut' && !cutLoaded[list]) { loadCut(list); return; }
  const all = grouped(list).filter(s => (!stageF || s.stage === stageF) && (!stratF || s.strategy === stratF));
  const counts = { target: 0, maybe: 0, cut: 0, added: 0, dismissed: 0, starred: 0, flagged: 0 };
  all.forEach(s => { counts[bucket(s)]++; if (s.starred_at) counts.starred++; if (s.flagged_at) counts.flagged++; });
  if (!cutLoaded[list] && !stageF && !stratF) counts.cut = cutCount[list] ?? counts.cut;
  const shown = all.filter(s => inMarkView(view, s) ?? bucket(s) === view).sort((a, b) => b.score - a.score || String(b.filing_date).localeCompare(String(a.filing_date)));
  const running = runs.filter(r => r.status === 'running');
  const month = new Date(); month.setUTCDate(1); month.setUTCHours(0, 0, 0, 0);
  const spent = runs.filter(r => Date.parse(r.created_at) >= month).reduce((n, r) => n + (r.status === 'running' ? +r.cap_usd || 0 : +r.cost_usd || 0), 0);
  const gh = runs.find(r => r.params?.source === 'github');
  onCount(grouped('live').concat(grouped('fund1')).filter(s => bucket(s) === 'target').length);

  el.innerHTML = `<div class="fs">
    <div class="fsTop">
      <div class="pSeg" role="group">${[['live', 'Raising now'], ['fund1', 'Due for next fund']].map(([k, l]) => `<button type="button" data-list="${k}" class="${list === k ? 'on' : ''}">${l}<em>${grouped(k).filter(s => bucket(s) === 'target').length}</em></button>`).join('')}</div>
      <div class="row fsBtns"><a class="btn sm ghost" href="${GH_RUN}" target="_blank" rel="noopener">Run a scan on GitHub ↗</a>
        <button class="btn sm" id="fsCollect">${running.length ? `Collect results (${running.length} running)` : 'Refresh'}</button>
        <button class="btn sm ghost" id="fsHow">How it works</button><a class="btn sm ghost" href="#/rules">How we qualify</a><button class="btn sm ghost" id="fsSet">Setup</button></div>
    </div>
    ${checksLine()}
    <p class="pHint">${list === 'live' ? 'Fund IIs and IIIs that filed a Form D: they started taking investor money in the last few weeks.' : 'Fund I and Fund II managers inside the window where most file their next fund (Fund I: 12–36 months after filing, median 24; Fund II: 15–39, median 28; from a study of 500 funds filed in 2019) who have not filed it yet, under any name.'} Manager size (SEC Form ADV, or Form D totals): under $150M across all its funds is the target, $150–500M lower priority, over $500M cut.
      Source: SEC EDGAR (edgartools), scanned daily on GitHub, free. ${gh ? `Last run <b>${new Date(gh.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</b>.` : ''}${spent ? ` Apify fallback: $${spent.toFixed(2)} this month.` : ''}</p>
    ${gh ? '' : `<div class="fsBulk fsSetup"><span>Finish setup: add two secrets to GitHub so the daily scan can run.</span><button class="btn sm primary" id="fsSetup">Show me how</button></div>`}
    <div class="fsFilt">${list === 'fund1' ? `<label>Fund status<select class="select sm" id="fsStage"><option value="">Any</option>${Object.entries(STAGE).map(([k, [l]]) => `<option value="${k}" ${stageF === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
      <label>Strategy<select class="select sm" id="fsStrat"><option value="">Any</option>${Object.entries(STRAT).map(([k, l]) => `<option value="${k}" ${stratF === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${list === 'fund1' ? '<span class="muted s">Targets = the current fund has finished raising (next-fund pitch), or is still raising 12+ months in (placement on this fund; Fund Is stay in Maybe until track record is confirmed). Raising under 12 months sits in Maybe.</span>' : ''}</div>
    <div class="fsViews">${[['target', 'Targets'], ['maybe', 'Maybe'], ['cut', 'Cut'], ['added', 'In pipeline'], ['dismissed', 'Dismissed'], ...MARK_VIEWS].map(([k, l]) => `<button type="button" data-view="${k}" class="${view === k ? 'on' : ''}" data-tone="${k === 'target' ? 'good' : k === 'cut' ? 'bad' : ''}">${l} <b>${counts[k]}</b></button>`).join('')}</div>
    ${list === 'fund1' && view === 'target' && shown.some(s => !s.check_status) ? `<div class="fsBulk"><span>${shown.filter(s => !s.check_status).length} not yet checked for a next fund.</span><button class="btn sm" id="fsCheckAll">Queue them all (free, runs within the hour)</button></div>` : ''}
    <div class="fsList">${shown.length ? shown.map(rowHtml).join('') : `<div class="empty">${view === 'target' ? (all.length ? 'No targets in this list right now.' : 'Nothing scanned yet. Run a scan above; results arrive in a few minutes.') : 'Nothing here.'}</div>`}</div>
  </div>`;
  bind(shown);
}

async function loadCut(l) {
  const keep = document.querySelector('.fsList'); if (keep) keep.innerHTML = '<div class="empty">Loading cut funds…</div>';
  const r = await allSignals(l);
  if (r.error) { toast('Could not load cut funds'); view = 'target'; draw(); return; }
  const have = new Set(rows.map(x => x.id));
  rows.push(...r.data.filter(x => !have.has(x.id)));
  cutLoaded[l] = true;
  if (el?.isConnected) draw();
}

function rowHtml(s) {
  const pct = s.offering && s.sold != null ? Math.round(s.sold / s.offering * 100) : null;
  const facts = [
    s.offering ? `Target <b>${money(s.offering)}</b>` : 'Target <b>not stated</b>',
    s.sold != null ? `Raised <b>${money(s.sold)}</b>${pct != null ? ` (${pct}%)` : ''}` : '',
    s.investors != null ? `<b>${s.investors}</b> investor${s.investors === 1 ? '' : 's'}` : '',
    s.list === 'fund1' && s.next_expected ? `Next fund expected <b>~${new Date(s.next_expected + 'T12:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}</b>` : '',
    s.first_sale ? `First sale <b>${day(s.first_sale)}</b>` : '<b>No money taken yet</b>',
    [s.city, s.state].filter(Boolean).join(', '),
    // Manager size (Form ADV / Form D totals): under $150M = emerging (our target), $150-500M = lower priority, over $500M = cut.
    s.manager_total ? `Manager total <b>${money(s.manager_total)}</b> <span class="pFlag ${s.manager_total <= 150e6 ? 'good' : s.manager_total <= 500e6 ? 'warn' : 'bad'}">${s.manager_total <= 150e6 ? 'Emerging' : s.manager_total <= 500e6 ? 'Lower priority' : 'Established'}</span>` : '',
    s.adviser_crd ? `<a href="https://adviserinfo.sec.gov/firm/summary/${encodeURIComponent(s.adviser_crd)}" target="_blank" rel="noopener" title="${esc(`Matched: ${s.adviser_match || ''}${s.adviser_filed ? ` · Form ADV ${s.adviser_filed}` : ''}`)}">Adviser: ${esc(s.adviser_name || s.adviser_crd)}${s.adviser_type ? ` (${esc(s.adviser_type)})` : ''} ↗</a>` : s.adviser_checked_at ? '<span class="muted">No SEC adviser filing</span>' : '',
  ].filter(Boolean);
  const ppl = (s.executives || []).slice(0, 4);
  const chk = ['checking', 'queued'].includes(s.check_status) && s.list === 'fund1' ? '' : s.check_status === 'checking' ? '<span class="pFlag">Checking EDGAR for newer filings…</span>' : s.check_status === 'queued' ? '<span class="pFlag">Queued: GitHub checks EDGAR hourly</span>'
    : s.check_status ? `<span class="pFlag ${s.check_status === 'next' ? 'bad' : s.check_status === 'clear' ? 'good' : 'warn'}">${esc(s.check_note || '')}</span>` : '';
  return `<article class="fsRow" data-tone="${toneOf(s.verdict === 'target' ? 'good' : s.verdict)}">
    <div class="fsScore"><b>${s.score}</b><span>score</span></div>
    <div class="fsMain">
      <h4>${esc(s.company_name)}${s.vehicles.length > 1 ? ` <span class="fsVeh" title="${esc(s.vehicles.map(v => v.company_name).join('\n'))}">+${s.vehicles.length - 1} vehicle${s.vehicles.length > 2 ? 's' : ''}</span>` : ''}</h4>
      ${(s.list === 'fund1' && STAGE[s.stage]) || (s.strategy && s.strategy !== 'other') ? `<div class="mkLine">${s.list === 'fund1' && STAGE[s.stage] ? `<span class="pFlag ${STAGE[s.stage][1]}" title="${STAGE[s.stage][2]}">${STAGE[s.stage][0]}</span>` : ''}${s.strategy && s.strategy !== 'other' ? `<span class="pFlag${s.strategy === 'real_estate' ? ' warn' : s.strategy === 'credit' ? ' good' : ''}">${STRAT[s.strategy]}</span>` : ''}</div>` : ''}
      ${markLine(s)}
      <div class="fsFacts">${facts.map(f => `<span>${f}</span>`).join('')}<span class="muted">Filed ${day(s.filing_date)}${s.form_type === 'D/A' ? ' (amendment)' : ''}${s.amended_at ? ` · numbers from the ${s.amendment_url ? `<a href="${esc(s.amendment_url)}" target="_blank" rel="noopener">latest filing ↗</a>` : 'latest filing'} (${day(s.amended_at)})` : ' · numbers from the first filing'}</span></div>
      ${whyBlock(s.reasons, esc)}
      ${chk ? `<div class="fsCheck">${chk}</div>` : ''}
      <details class="fsPrep"><summary>Call prep: what to find out</summary><ol>${prep(s).map(q => `<li>${esc(q)}</li>`).join('')}</ol></details>
      ${ppl.length ? `<div class="fsPeople">${ppl.map(p => `<a href="${liSearch(p.name, s)}" target="_blank" rel="noopener" title="Search LinkedIn">${esc(p.name)} ↗</a>`).join('')}${(s.executives || []).length > 4 ? `<span class="muted">+${s.executives.length - 4} more</span>` : ''}</div>` : ''}
    </div>
    <div class="fsAct">
      ${markBtns(s)}
      ${s.status !== 'added' ? `<button class="btn sm ${s.verdict === 'target' ? 'primary' : ''}" data-add="${s.id}">Add to pipeline</button>` : '<span class="pFlag good">In pipeline</span>'}
      <button class="btn sm" data-copy="${s.id}">Copy opener</button>
      ${!['checking', 'queued'].includes(s.check_status) ? `<button class="btn sm" data-check="${s.id}">${s.check_status ? 'Re-check' : s.list === 'live' ? 'Check newer filings' : 'Check for next fund'}</button>` : ''}
      ${s.filing_url ? `<a class="btn sm ghost" href="${esc(s.filing_url)}" target="_blank" rel="noopener">Filing ↗</a>` : ''}
      ${s.status === 'dismissed' ? `<button class="btn sm ghost" data-undo="${s.id}">Restore</button>` : s.status !== 'added' ? `<button class="btn sm ghost" data-dismiss="${s.id}">Dismiss</button>` : ''}
    </div></article>`;
}

function opener(s) {
  const who = firstName((s.executives || [])[0]?.name || '') || 'there';
  const pct = s.offering && s.sold ? Math.round(s.sold / s.offering * 100) : null;
  if (s.list === 'fund1') {
    const cur = s.fund_no === 2 ? 'Fund II' : 'Fund I', nxt = s.fund_no === 2 ? 'Fund III' : 'Fund II';
    if (s.stage === 'raising' || s.stage === 'stuck') return `Hi ${who}, congrats on the progress with ${s.check_keyword} ${cur}${s.sold ? ` (${money(s.sold)} in so far)` : ''}. If it would help to widen the LP list before your final close, we introduce family offices to emerging managers. Happy to share who's active in your space right now.`;
    return `Hi ${who}, congrats on ${s.check_keyword} ${cur}${s.sold ? ` at ${money(s.sold)}` : ''}. Most managers find re-ups cover about half of the next fund, so the rest has to come from new LPs. We introduce family offices to managers at exactly this point, before ${nxt} launches, not after. Worth comparing notes on who's on your list?`;
  }
  const where = s.sold && s.offering ? `${money(s.sold)} toward ${money(s.offering)}${pct != null ? ` (${pct}%)` : ''}` : 'the raise';
  return `Hi ${who}, congrats on getting ${s.check_keyword} Fund ${ROMAN[s.fund_no] || ''} underway: ${where}. We introduce family offices and other LPs to managers at your stage. Worth a quick chat on who's still on your list?`;
}

// First-call questions a placement agent would need answered before pitching this manager to investors.
// Real returns are never in public filings for managers this size, so the track record question always comes first.
function prep(s) {
  const q = [];
  const cur = `Fund ${ROMAN[s.fund_no] || 'I'}`, nxt = `Fund ${ROMAN[(s.fund_no || 1) + 1]}`;
  if (s.list === 'fund1') {
    q.push(`${cur} returns so far: net IRR, TVPI and DPI (how much cash is back), and how much of that is realised vs marked.`);
    if (s.stage === 'raising' || s.stage === 'stuck') q.push(`What's holding up the final close of ${cur}? Which investor types passed, and why?`);
    else if (s.stage === 'unclear') q.push(`Has ${cur} held its final close? At what size?`);
    q.push(`How much of ${cur} do they expect to re-up in ${nxt}, and from whom? (The gap is our job.)`);
    const prior = (s.history || []).filter(h => h.fund_no === (s.fund_no || 1) - 1).sort((a, b) => b.sold - a.sold)[0];
    if (prior && prior.sold > 0 && prior.sold < 5e6) q.push(`Fund ${ROMAN[(s.fund_no || 1) - 1]} was only ${money(prior.sold)}: what got ${cur} to ${money(s.sold)}? (An anchor, a spin-out track record, a new partner?)`);
    if (s.investors > 0 && s.investors <= 5) q.push(`Only ${s.investors} investor${s.investors === 1 ? '' : 's'} in ${cur}: is the anchor coming back, and at what size?`);
    q.push(`${nxt} target size, first close date, and how much the GP is committing itself.`);
    q.push(`Has the team changed since ${cur}? Who left, who joined?`);
  } else {
    q.push(`Who anchors this raise, and how much is signed vs soft-circled?`);
    q.push(`Prior fund returns: net IRR, TVPI, DPI. What's realised?`);
    q.push(`What do investors push back on in meetings so far?`);
  }
  if (s.strategy === 'real_estate') q.push('Real estate is crowded: what makes them different from every other manager raising now?');
  q.push('Who helps them raise today (placement agent, IR hire, nobody)? Who pays for fundraising help: the management company, a co-GP or sponsor? (See the fee income line for what they can likely afford.)');
  return q;
}

function bind(shown) {
  const find = id => shown.find(s => s.id === id) || rows.find(s => s.id === id);
  $$('[data-list]', el).forEach(b => b.onclick = () => { list = b.dataset.list; view = 'target'; stageF = ''; draw(); });
  $$('[data-view]', el).forEach(b => b.onclick = () => { view = b.dataset.view; draw(); });
  $('#fsCollect', el).onclick = () => collect(false);
  $('#fsHow', el).onclick = howModal;
  $('#fsSet', el).onclick = settingsModal;
  $('#fsSetup', el)?.addEventListener('click', settingsModal);
  const runCheck = async (ids, btn) => {
    if (btn) btn.disabled = true;
    try { const r = await call({ action: 'queue', ids }); toast(`${r.queued} queued. GitHub checks EDGAR hourly (at :10).`); await load(); draw(); }
    catch (e) { toast(e.message); if (btn) btn.disabled = false; }
  };
  $$('[data-check]', el).forEach(b => b.onclick = () => runCheck([b.dataset.check], b));
  $('#fsCheckAll', el)?.addEventListener('click', e => runCheck(shown.filter(s => !s.check_status).map(s => s.id), e.target));
  $$('[data-copy]', el).forEach(b => b.onclick = async () => {
    const s = find(b.dataset.copy), t = opener(s);
    try { await navigator.clipboard.writeText(t); toast('Opener copied. Personalise it before sending.'); } catch { modal({ title: 'Opener', submit: '', body: `<textarea class="input" rows="6" style="width:100%">${esc(t)}</textarea>` }); }
  });
  $$('[data-dismiss],[data-undo]', el).forEach(b => b.onclick = async () => {
    const id = b.dataset.dismiss || b.dataset.undo, st = b.dataset.dismiss ? 'dismissed' : 'new';
    const s = find(id), ids = (s.vehicles || [s]).map(v => v.id);
    if (fail(await sb.from('fund_signals').update({ status: st, updated_at: new Date().toISOString() }).in('id', ids), 'Update')) return;
    rows.filter(r => ids.includes(r.id)).forEach(r => r.status = st); draw();
  });
  $$('[data-add]', el).forEach(b => b.onclick = () => addModal(find(b.dataset.add)));
  bindMarks(el, { table: 'fund_signals', find, rawFind: id => rows.find(r => r.id === id), idsOf: s => (s.vehicles || [s]).map(v => v.id), redraw: draw });
  $('#fsStage', el)?.addEventListener('change', e => { stageF = e.target.value; draw(); });
  $('#fsStrat', el)?.addEventListener('change', e => { stratF = e.target.value; draw(); });
}

// Each chosen person becomes a Sell Side relationship (a fund raising money is a client with something to sell to investors).
function addModal(s) {
  const ppl = s.executives || [];
  modal({
    title: 'Add to pipeline', submit: 'Add',
    body: `<div class="form pForm"><p class="s muted" style="grid-column:1/-1;margin:0"><b>${esc(s.company_name)}</b>. Each person you tick becomes a sell-side relationship with a task to find them on LinkedIn.</p>
      ${ppl.length ? `<div class="field" style="grid-column:1/-1">People<div class="pTasks">${ppl.map((p, i) => `<label><input type="checkbox" name="p" value="${i}" ${i < 2 ? 'checked' : ''}> <span>${esc(p.name)}</span><em class="muted s">${esc(p.title || '')}</em></label>`).join('')}</div></div>`
        : '<label class="field" style="grid-column:1/-1">Name<input class="input" name="manual" required placeholder="No people in the filing: who did you find?"></label>'}
      <label class="field" style="grid-column:1/-1">First step<input class="input" name="next" value="Find on LinkedIn and send the connection note"></label>
      <label class="field">Owner<select class="select" name="owner">${opts(['Tengku', 'Chase', 'Peter', 'Anaz', 'Razeen'], me())}</select></label></div>`,
    async onSubmit(fd) {
      const chosen = ppl.length ? fd.getAll('p').map(i => ppl[+i]) : [{ name: String(fd.get('manual')).trim(), title: '' }];
      if (!chosen.length) { toast('Tick at least one person'); return false; }
      const now = new Date().toISOString(), fundLine = `${s.company_name}${s.offering ? ` · ${money(s.offering)} target` : ''}${s.sold != null ? `, ${money(s.sold)} raised` : ''}`;
      let first = null;
      for (const p of chosen) {
        const r = await sb.from('people').insert({ name: p.name, primary_side: 'Sell Side', relationship_type: 'Sell-side Relationship', pipeline_stage: 'To Reach Out', owner_name: String(fd.get('owner') || '').trim() || null, pipeline_active: true, waiting_on: 'us', waiting_on_since: now, company_name: s.company_name, headline: p.title || null, source: 'Form D', last_inbound_message: `Form D signal: ${fundLine}. ${(s.reasons || []).filter(x => x.tone === 'good').map(x => x.text).join('. ')}`, created_by: state.user?.id }).select().single();
        if (fail(r, 'Add ' + p.name)) return false;
        first = first || r.data.id;
        await sb.from('tasks').insert({ person_id: r.data.id, action: String(fd.get('next') || '').trim() || 'Find on LinkedIn', owner_name: fd.get('owner'), due_date: now.slice(0, 10), created_by: state.user?.id });
      }
      const ids = (s.vehicles || [s]).map(v => v.id);
      await sb.from('fund_signals').update({ status: 'added', person_id: first, updated_at: now }).in('id', ids);
      rows.filter(r => ids.includes(r.id)).forEach(r => { r.status = 'added'; r.person_id = first; });
      toast(`${chosen.length} added to Pipeline → Sell side`); draw();
    },
  });
}

function settingsModal() {
  const { el: m } = modal({
    title: 'Fund signals setup', submit: '', wide: true,
    body: `<div class="fsHow">
      <p>The scan runs on GitHub (free) with edgartools, reading Form D filings straight from the SEC. It needs two secrets in the repo. Do this once:</p>
      <ol>
        <li>Open <a href="${GH_SECRETS}" target="_blank" rel="noopener">GitHub → repo Settings → Secrets → Actions ↗</a> and click <b>New repository secret</b>.</li>
        <li>Name <b>FUND_INGEST_KEY</b>, value: <button type="button" class="btn sm" id="fsKey">Copy the key</button> then paste it.</li>
        <li>New secret again. Name <b>SEC_IDENTITY</b>, value: a name and email, e.g. <code>OuterHaven Advisory you@yourdomain.com</code>. The SEC asks every tool to identify itself; it's never shown publicly.</li>
        <li>Open <a href="${GH_RUN}" target="_blank" rel="noopener">Actions → Fund signals ↗</a>, click <b>Run workflow</b>. Mode <b>daily</b> for a quick test, or <b>fund1</b> / <b>live</b> with dates for a backfill.</li>
      </ol>
      <h4>Reliable schedule</h4>
      <p>GitHub's own timer is best-effort and skips most runs (Oct 3–5: about 6 of 25 a day, hours late). HQ's database starts the runs on time instead (daily 09:40 MYT, checks hourly at :10) once it has a GitHub token that may start workflows. Paste it once:</p>
      <ol>
        <li>Who: the repo owner (Chase) makes a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token ↗</a>: repository <b>outerhaven-dashboard</b> only, permission <b>Actions: Read and write</b>, expiry 1 year. (Anyone else with push access can use a <a href="https://github.com/settings/tokens/new?scopes=repo,workflow&description=OuterHaven%20HQ%20dispatch" target="_blank" rel="noopener">classic token ↗</a> with <b>repo</b> + <b>workflow</b>.)</li>
        <li>Paste it here: <input type="password" id="fsGhTok" placeholder="github_pat_… or ghp_…" autocomplete="off" style="width:min(100%,320px)"> <button type="button" class="btn sm primary" id="fsGhSave">Save</button> <button type="button" class="btn sm ghost" id="fsGhClear">Remove</button></li>
      </ol>
      <p id="fsGhStatus" class="s muted">Checking…</p>
      <p class="s muted">The key only lets GitHub add filings and check results to this tab. If it leaks, tell Claude to rotate FUND_INGEST_SECRET and paste the new one.</p></div>`,
  });
  const ghStatus = async () => {
    const { data, error } = await sb.rpc('github_dispatch_status');
    const el = $('#fsGhStatus', m); if (!el) return;
    if (error) { el.textContent = 'Status unavailable: ' + error.message; return; }
    const last = (data.recent || [])[0];
    const ans = r => r.status_code === 204 ? 'started' : r.status_code ? `GitHub said ${r.status_code}${r.status_code === 401 || r.status_code === 403 || r.status_code === 404 ? ' (token can\'t start workflows: check its repo and Actions permission)' : ''}` : 'waiting for GitHub';
    el.textContent = !data.token_set ? 'No token yet: runs depend on GitHub\'s unreliable timer.'
      : last ? `Token saved. Last run started from HQ: ${last.mode}, ${new Date(last.created_at).toLocaleString()}: ${ans(last)}.` : 'Token saved. The first run starts at the next :10.';
  };
  ghStatus();
  $('#fsGhSave', m).onclick = async () => {
    const v = $('#fsGhTok', m).value.trim();
    if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(v)) { toast('That doesn\'t look like a GitHub token.'); return; }
    const { error } = await sb.rpc('set_github_dispatch_token', { p_value: v });
    $('#fsGhTok', m).value = '';
    if (error) { toast('Could not save: ' + error.message); return; }
    toast('Saved. Runs now start from HQ on time.'); ghStatus();
  };
  $('#fsGhClear', m).onclick = async () => {
    const { error } = await sb.rpc('set_github_dispatch_token', { p_value: '' });
    if (error) { toast('Could not remove: ' + error.message); return; } toast('Token removed.'); ghStatus();
  };
  $('#fsKey', m).onclick = async () => {
    const { data, error } = await sb.rpc('fund_ingest_key');
    if (error || !data) { toast('Could not get the key: ' + (error?.message || 'not set up')); return; }
    try { await navigator.clipboard.writeText(data); toast('Key copied. Paste it into GitHub.'); } catch { toast('Copy failed. Allow clipboard access and try again.'); }
  };
}

function howModal() {
  modal({
    title: 'How fund signals work', submit: '', wide: true,
    body: `<div class="fsHow">
      <h4>1. Where the data comes from</h4>
      <p>Every US private fund must file a <b>Form D</b> with the SEC within 15 days of taking its first investor's money, and amend it each year while it keeps raising. HQ reads them straight from the SEC with edgartools (open source), on a free daily GitHub job. Only pooled investment funds are kept.</p>
      <h4>2. The two lists</h4>
      <p><b>Raising now:</b> filings with "II" or "III" in the fund name, financial services only. <b>Due for next fund:</b> Fund I and Fund II filings from 12–39 months ago, scanned one quarter at a time.</p>
      <h4>3. Automatic cuts (a fund is cut if any one applies)</h4>
      <ul><li>A single-deal vehicle: SPV, co-invest, "a series of", splitter, continuation fund.</li>
      <li>A big brand or wealth platform (Apollo, Ares, a16z, iCapital, CAIS…): they have their own fundraising team.</li>
      <li>Sales commissions or finder's fees above $0: they already pay someone to raise.</li>
      <li>Raising now: target under $50M or over $250M, 60%+ already raised, or Fund IV and up.</li>
      <li>Fund I list: Fund I under $10M or over $75M, or a later fund already filed.</li></ul>
      <h4>4. "Maybe" (needs a human look)</h4>
      <ul><li>Target size "Indefinite", so % raised can't be worked out.</li><li>Non-US manager, or no named people on the filing.</li>
      <li>Due for next fund: the current fund is <b>still raising</b> under 12 months in (too early to pitch; at 12+ months it becomes a placement target), it closed under 60% of target, or 5 or fewer investors carry a $15M+ fund.</li></ul>
      <h4>5. Score (higher = call first)</h4>
      <p><b>Raising now:</b> +20 stuck (under 30% raised 6+ months in), +20 Fund II, +12 Fund III, +15 filed before taking money or under 30% raised, +12 started in the last 6 weeks.</p>
      <p><b>Due for next fund:</b> +12 closed (raised the target, or no filing for 13+ months; a target equal to the amount raised only proves it closed, since managers reset the target at close), +12 oversubscribed, +15 in the pre-launch window (next fund expected from a 50/50 blend of their own pace between funds and the market median), +8 the fund is 1.3x+ the size of the last one (−5 if smaller), +6 average cheque $1M+ (family-office-sized), +15 checked with no next fund, +5 fee income $400K+ a year (−8 under).</p>
      <p><b>Both:</b> emerging manager (all funds under $150M) +20 / +12, $150–500M −15, private credit +8, real estate −15, Rule 506(c) +8.</p>
      <p>Full criteria, with questions for Peter: the "OuterHaven Deal Screening Criteria" doc.</p>
      <h4>6. The next-fund check</h4>
      <p>Pulls every later filing by the same fund (by its SEC company number), and runs an SEC full-text search for later Form Ds under the manager's name (e.g. "Ground Game"). A later fund with a higher number = cut ("already filed Fund II"). It also searches every person named on the filing: a later pooled fund under any name with the same people (e.g. a Fund I followed by a "Frontier Fund" with the same partners) also counts as the next fund. A newer amendment of the same fund (same SEC company number) updates how much it has raised. Different firms that share a word are ignored unless the name matches.</p>
      <h4>7. What it can't see</h4>
      <ul><li>Funds that raise without filing, or file under a different name.</li><li>Whether the people are still active or reachable: check LinkedIn before messaging.</li><li>Funds whose target is "Indefinite" can't be ranked on % raised.</li></ul>
      <p class="s muted">Placement for a success fee on fund capital needs a US broker-dealer (or a partner who is one). Sort that before signing a mandate.</p></div>`,
  });
}
