// Pipeline → UCC signals: sizable PRIVATE companies that need private credit (Peter's lane), from state UCC lien filings
// (Connecticut, Colorado, Oregon open data + Florida federal tax liens) sized by their SBA PPP loan. Filters: state, size,
// signal, sector, recency, registry (kept in localStorage 'hq-ucc-filters'). Filled daily by scripts/ucc_signals.py on GitHub; judged
// on the server (classifyUcc in supabase/functions/ucc-signals/rules.js). Every verdict shows its reasons.
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
const GH_RUN = 'https://github.com/HyperionLLAMA/outerhaven-dashboard/actions/workflows/fund-signals.yml';
const SECTOR = { 11: 'Agriculture', 21: 'Mining, oil & gas', 22: 'Utilities', 23: 'Construction', 31: 'Manufacturing', 32: 'Manufacturing', 33: 'Manufacturing', 42: 'Wholesale', 44: 'Retail', 45: 'Retail', 48: 'Transport & logistics', 49: 'Transport & logistics', 51: 'Media & telecom', 53: 'Real estate', 54: 'Professional services', 55: 'Holding company', 56: 'Business services', 61: 'Education', 62: 'Healthcare', 71: 'Leisure', 72: 'Hospitality & food', 81: 'Other services' };
const sector = s => SECTOR[String(s.naics || '').slice(0, 2)] || '';
const CLASS = { mca: 'Merchant cash advance', rep: 'Undisclosed lender (via filing agent)', irs: 'IRS tax lien', state_tax: 'State tax / labor lien', judgment: 'Judgment lien', factoring: 'Factoring', fintech: 'Platform loan', sba: 'SBA (EIDL)', bank: 'Bank', agent: 'Agent (syndicated / private credit)', abl: 'Asset-based / commercial finance', statutory: 'Statutory lien' };
const shortName = n => { const c = String(n || '').replace(/,?\s+(inc|corp|corporation|co|company|ltd|llc|l\.l\.c\.|lp|llp|pc)\.?$/i, '').trim(); return c === c.toUpperCase() ? c.toLowerCase().replace(/\b[a-z]/g, x => x.toUpperCase()) : c; };
const ceoSearch = s => `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${shortName(s.company_name)} (CEO OR owner OR president OR CFO)`)}`;
const webSearch = s => `https://www.google.com/search?q=${encodeURIComponent(`"${shortName(s.company_name)}" ${s.city || ''} ${s.state || ''}`)}`;

async function load() {
  const [c, r] = await Promise.all([
    sb.from('ucc_signals').select('*').order('score', { ascending: false }).limit(3000),
    sb.from('ucc_signal_runs').select('*').order('created_at', { ascending: false }).limit(3),
  ]);
  if (c.error) { rows = null; return; }
  rows = (c.data || []).filter(s => s.company_key !== 'ZZTEST|CT'); runs = r.data || [];
  await loadContacts('ucc', true).catch(() => null);
}
export function uccTargetCount() { return rows ? rows.filter(s => bucket(s) === 'target').length : 0; }

export async function renderUcc(target, countCb) {
  el = target; onCount = countCb || onCount;
  if (!rows?.length) el.innerHTML = '<div class="empty">Loading UCC signals…</div>';
  await load();
  if (el.isConnected) draw();
}

// Filters (kept per browser). Geography = the company's state; registry = which state's UCC data it came from.
const SIGNALS = { mca: ['Merchant cash advance', f => f.mca_12m || f.mca_18m], rep: ['Hidden-lender filings (agent)', f => f.rep_12m || f.rep_18m],
  irs: ['IRS tax lien', f => f.irs_24m], state_tax: ['State tax / labor lien', f => f.state_tax_24m], judgment: ['Judgment lien', f => f.judgment_24m],
  refi: ['Facility up for refinancing', f => (f.refi || []).length], factoring: ['Factoring', f => f.factoring_24m], fintech: ['Platform loan', f => f.fintech_18m],
  nonbank: ['Already uses a non-bank lender', f => f.agent_active] };
const SIZES = { '': 'Any size', '10-20': '$10–20M', '20-50': '$20–50M', '50-100': '$50–100M', '100-': '$100M+', '20-': '$20M+', '50-': '$50M+' };
const RECENT = { '': 'Any time', 90: 'Last 90 days', 182: 'Last 6 months', 365: 'Last 12 months' };
const SORTS = { score: 'Score', rev: 'Revenue', new: 'Newest filing' };
const NOF = { q: '', st: '', src: '', size: '', sec: '', sig: '', rec: '', sort: 'score' };
let F = { ...NOF };
try { F = { ...NOF, ...JSON.parse(localStorage.getItem('hq-ucc-filters') || '{}') }; } catch { /* private window */ }
const saveF = () => { try { localStorage.setItem('hq-ucc-filters', JSON.stringify(F)); } catch { /* ignore */ } };
const active = () => Object.keys(NOF).filter(k => k !== 'sort' && F[k]).length;

function passes(s) {
  const f = s.facts || {}, est = s.est_revenue || 0;
  if (F.q) { const q = F.q.toLowerCase(); if (![s.company_name, s.city, s.ppp?.name].some(x => String(x || '').toLowerCase().includes(q))) return false; }
  if (F.st && s.state !== F.st) return false;
  if (F.src && !(s.sources || []).includes(F.src)) return false;
  if (F.size) { const [lo, hi] = F.size.split('-').map(x => x ? +x * 1e6 : null); if (est < lo || (hi && est >= hi)) return false; }
  if (F.sec && sector(s) !== F.sec) return false;
  if (F.sig && !SIGNALS[F.sig]?.[1](f)) return false;
  if (F.rec && !(s.latest_filing && Date.now() - Date.parse(s.latest_filing) <= +F.rec * 864e5)) return false;
  return true;
}
const sorter = { score: (a, b) => b.score - a.score || (b.est_revenue || 0) - (a.est_revenue || 0), rev: (a, b) => (b.est_revenue || 0) - (a.est_revenue || 0),
  new: (a, b) => String(b.latest_filing || '').localeCompare(String(a.latest_filing || '')) };

function selectHtml(key, label, entries) {
  return `<label class="ucF"><span>${label}</span><select class="select" data-f="${key}">${entries.map(([v, t]) => `<option value="${esc(v)}"${String(F[key]) === String(v) ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
}
const tally = fn => { const m = {}; rows.forEach(s => [].concat(fn(s)).forEach(v => { if (v) m[v] = (m[v] || 0) + 1; })); return Object.entries(m).sort((a, b) => b[1] - a[1]); };

function draw() {
  if (rows === null) { el.innerHTML = '<div class="empty">The UCC signals table isn\'t set up yet.</div>'; return; }
  const last = runs[0], st = last?.stats || {};
  const regs = tally(s => s.sources || []).map(([k]) => k).sort();
  el.innerHTML = `<div class="fs">
    <div class="fsTop"><p class="pHint" style="padding:0;margin:0;max-width:680px">Private companies with roughly $30M+ revenue whose lien filings show they need money: tax or judgment liens, stacked merchant cash advances, or a bank facility about to lapse. Sizes are 2020 estimates and loan amounts are unknown, so these mostly suit asset-based and factoring lenders. For direct lenders, start with <b>BDC loans</b> (real loan sizes).</p>
      <div class="row fsBtns"><a class="btn sm ghost" href="${GH_RUN}" target="_blank" rel="noopener">Run a scan on GitHub ↗</a><button class="btn sm ghost" id="ucHow">How it works</button><a class="btn sm ghost" href="#/rules">How we qualify</a><button class="btn sm ghost" id="ctSetup">Contacts setup</button></div></div>
    <p class="pHint">Source: ${regs.length ? regs.join(', ') : 'state'} UCC data (Florida = federal tax liens only), sized by SBA PPP loans. Refreshed daily on GitHub, free.${last ? ` Last run <b>${new Date(last.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</b>${st.filings ? ` · ${Number(st.filings).toLocaleString()} filings on sized companies read` : ''}${st.complete === false ? ' · <b style="color:var(--bad)">not every state loaded</b>' : ''}.` : ' Not run yet: on GitHub choose Run workflow, mode <b>ucc</b>.'}</p>
    <div class="ucFilters">
      <label class="ucF ucQ"><span>Search</span><input class="input" data-f="q" type="search" placeholder="Company or city" value="${esc(F.q)}"></label>
      ${selectHtml('st', 'State', [['', 'All states'], ...tally(s => s.state).map(([k, n]) => [k, `${k} (${n})`])])}
      ${selectHtml('size', 'Revenue (est.)', Object.entries(SIZES))}
      ${selectHtml('sig', 'Signal', [['', 'Any signal'], ...Object.entries(SIGNALS).map(([k, v]) => [k, v[0]])])}
      ${selectHtml('sec', 'Sector', [['', 'All sectors'], ...tally(s => sector(s)).map(([k, n]) => [k, `${k} (${n})`])])}
      ${selectHtml('rec', 'Newest filing', Object.entries(RECENT))}
      ${regs.length > 1 ? selectHtml('src', 'UCC registry', [['', 'All registries'], ...regs.map(k => [k, k])]) : ''}
      ${selectHtml('sort', 'Sort by', Object.entries(SORTS))}
      <button type="button" class="btn sm ghost ucReset" id="ucReset"${active() ? '' : ' hidden'}>Clear filters</button>
    </div>
    <div id="ucBody"></div>
  </div>`;
  $('#ucHow', el).onclick = howModal;
  $$('[data-f]', el).forEach(i => { i.oninput = i.onchange = () => { F[i.dataset.f] = i.value; saveF(); $('#ucReset', el).hidden = !active(); drawList(); }; });
  $('#ucReset', el).onclick = () => { F = { ...NOF, sort: F.sort }; saveF(); draw(); };
  drawList();
}

function drawList() {
  const body = $('#ucBody', el); if (!body) return;
  const counts = { target: 0, maybe: 0, cut: 0, added: 0, dismissed: 0 }, all = { target: 0 };
  const pass = rows.filter(passes);
  rows.forEach(s => { if (bucket(s) === 'target') all.target++; });
  counts.starred = 0; counts.flagged = 0;
  pass.forEach(s => { counts[bucket(s)]++; if (s.starred_at) counts.starred++; if (s.flagged_at) counts.flagged++; });
  onCount(all.target);
  const shown = pass.filter(s => inMarkView(view, s) ?? bucket(s) === view).sort(sorter[F.sort] || sorter.score);
  body.innerHTML = `<div class="fsViews">${[['target', 'Targets'], ['maybe', 'Maybe'], ['cut', 'Cut'], ['added', 'In pipeline'], ['dismissed', 'Dismissed'], ...MARK_VIEWS].map(([k, l]) => `<button type="button" data-view="${k}" class="${view === k ? 'on' : ''}" data-tone="${k === 'target' ? 'good' : k === 'cut' ? 'bad' : ''}">${l} <b>${counts[k]}</b></button>`).join('')}</div>
    ${active() ? `<p class="pHint" style="margin:0">${pass.length.toLocaleString()} of ${rows.length.toLocaleString()} companies match the filters.</p>` : ''}
    <div class="fsList">${shown.length ? shown.slice(0, 200).map(rowHtml).join('') : `<div class="empty">${rows.length ? (active() ? 'Nothing matches these filters.' : 'Nothing here.') : 'No companies yet. Run the scan on GitHub (mode ucc); the first run takes about 10–15 minutes.'}</div>`}</div>
    ${shown.length > 200 ? `<p class="pHint">Showing the top 200 of ${shown.length}. Narrow it with the filters.</p>` : ''}`;
  bind(shown);
}

function rowHtml(s) {
  const p = s.ppp || {};
  const facts = [
    s.est_revenue ? `Revenue <b>~${money(s.est_revenue)}</b> <span class="muted">(est.)</span>` : '',
    p.jobs ? `Jobs <b>${p.jobs}</b>` : '',
    p.amount ? `PPP loan <b>${money(p.amount)}</b>` : '',
    [sector(s), [s.city, s.state].filter(Boolean).join(', ')].filter(Boolean).map(esc).join(' · '),
  ].filter(Boolean);
  const liens = (s.liens || []).filter(l => l.class !== 'bank' || l.status === 'active').slice(0, 8);
  return `<article class="fsRow" data-tone="${toneOf(s.verdict === 'target' ? 'good' : s.verdict)}">
    <div class="fsScore"><b>${s.score}</b><span>score</span></div>
    <div class="fsMain">
      <h4>${esc(s.company_name)} <span class="fsVeh">${esc((s.sources || []).join(' · '))} UCC</span></h4>
      ${markLine(s)}
      <div class="fsFacts">${facts.map(x => `<span>${x}</span>`).join('')}</div>
      ${contactHtml('ucc', s.company_key, s)}
      ${whyBlock(s.reasons, esc)}
      ${liens.length ? `<details class="ucLiens"><summary>Filings (${(s.liens || []).length})</summary><table><tbody>${liens.map(l => `<tr><td>${esc(mon(l.filed))}</td><td>${esc(CLASS[l.class] || l.class)}</td><td>${esc(l.party)}</td><td class="muted">${l.status === 'active' ? (l.lapse && !l.lapse.startsWith('9999') ? 'lapses ' + esc(mon(l.lapse)) : 'active') : 'released'}</td></tr>`).join('')}</tbody></table></details>` : ''}
      <div class="fsPeople"><a href="${ceoSearch(s)}" target="_blank" rel="noopener">Find the owner / CEO on LinkedIn ↗</a><a href="${webSearch(s)}" target="_blank" rel="noopener">Website ↗</a></div>
    </div>
    <div class="fsAct">
      ${markBtns(s)}
      ${s.status !== 'added' ? `<button class="btn sm ${s.verdict === 'target' ? 'primary' : ''}" data-add="${s.id}">Add to pipeline</button>` : '<span class="pFlag good">In pipeline</span>'}
      <button class="btn sm" data-copy="${s.id}">Copy message</button>
      ${s.status === 'dismissed' ? `<button class="btn sm ghost" data-undo="${s.id}">Restore</button>` : s.status !== 'added' ? `<button class="btn sm ghost" data-dismiss="${s.id}">Dismiss</button>` : ''}
    </div></article>`;
}

// Peter's first message. Never mentions the liens (public, but naming them reads as surveillance); leads with the fix.
// The first message = the Prosp template (hq/outreach.js messageFor): one dated fact about their company, a small ask.
// No pitch paragraph, no "no pitch" (saying it makes people think of a pitch). Distress (marks, liens, going concern) is never named.
export function opener(s, name = '') { return messageFor('ucc', s, name); }

function bind(shown) {
  const find = id => shown.find(s => s.id === id) || rows.find(s => s.id === id);
  bindMarks(el, { table: 'ucc_signals', find, redraw: drawList });
  bindContacts(el, 'ucc', drawList);
  $('#ctSetup', el)?.addEventListener('click', contactsSetup);
  $$('[data-view]', el).forEach(b => b.onclick = () => { view = b.dataset.view; drawList(); });
  $$('[data-copy]', el).forEach(b => b.onclick = async () => {
    const t = opener(find(b.dataset.copy));
    try { await navigator.clipboard.writeText(t); toast('Message copied. Put their name in before sending.'); } catch { modal({ title: 'Message', submit: '', body: `<textarea class="input" rows="6" style="width:100%">${esc(t)}</textarea>` }); }
  });
  $$('[data-dismiss],[data-undo]', el).forEach(b => b.onclick = async () => {
    const id = b.dataset.dismiss || b.dataset.undo, st = b.dataset.dismiss ? 'dismissed' : 'new';
    if (fail(await sb.from('ucc_signals').update({ status: st, updated_at: new Date().toISOString() }).eq('id', id), 'Update')) return;
    const r = rows.find(x => x.id === id); if (r) r.status = st; drawList();
  });
  $$('[data-add]', el).forEach(b => b.onclick = () => addModal(find(b.dataset.add)));
}

function addModal(s) {
  const cp = bestPerson('ucc', s.company_key);
  modal({
    title: 'Add to pipeline', submit: 'Add',
    body: `<div class="form pForm"><p class="s muted" style="grid-column:1/-1;margin:0"><b>${esc(s.company_name)}</b>${s.city ? `, ${esc(s.city)}` : ''}. Find the owner or CEO first: <a href="${ceoSearch(s)}" target="_blank" rel="noopener">LinkedIn search ↗</a></p>
      <label class="field">Name<input class="input" name="name" required placeholder="Jane Smith" value="${esc(cp?.name || '')}"></label>
      <label class="field">Title<input class="input" name="title" value="${esc(cp ? ({ cfo: 'CFO', ceo: 'CEO' }[cp.role] || cp.title || 'CEO') : 'CEO')}"></label>
      <label class="field" style="grid-column:1/-1">LinkedIn URL (optional)<input class="input" name="li" value="${esc(cp?.linkedin || '')}"></label>
      <label class="field" style="grid-column:1/-1">First step<input class="input" name="next" value="Connect and send the message (Peter's private credit angle)"></label>
      <label class="field">Owner<select class="select" name="owner">${opts(['Peter', 'Tengku', 'Chase', 'Anaz', 'Razeen'], 'Peter')}</select></label></div>`,
    async onSubmit(fd) {
      const now = new Date().toISOString(), name = String(fd.get('name')).trim(), li = String(fd.get('li') || '').trim() || null;
      const facts = `${s.company_name} (${[s.city, s.state].filter(Boolean).join(', ')}): ${(s.reasons || []).filter(x => x.tone === 'good').map(x => x.text).join(' ')}`;
      const r = await sb.from('people').insert({ name, primary_side: 'Sell Side', relationship_type: 'Sell-side Relationship', pipeline_stage: 'To Reach Out', owner_name: String(fd.get('owner') || '').trim() || null, pipeline_active: true, waiting_on: 'us', waiting_on_since: now, company_name: s.company_name, headline: String(fd.get('title') || '').trim() || null, linkedin_url: li, has_linkedin: !!li, source: 'UCC signal', last_inbound_message: facts, created_by: state.user?.id }).select().single();
      if (fail(r, 'Add')) return false;
      await sb.from('tasks').insert({ person_id: r.data.id, action: String(fd.get('next') || '').trim() || 'Connect and send the message', owner_name: fd.get('owner'), due_date: now.slice(0, 10), created_by: state.user?.id });
      await sb.from('ucc_signals').update({ status: 'added', person_id: r.data.id, updated_at: now }).eq('id', s.id);
      s.status = 'added'; s.person_id = r.data.id;
      try { await navigator.clipboard.writeText(opener(s, name)); toast(`${name} added. Message copied with their name.`); } catch { toast(`${name} added to Pipeline → Sell side`); }
      drawList();
    },
  });
}

function howModal() {
  modal({
    title: 'How UCC signals work', submit: '', wide: true,
    body: `<div class="fsHow">
      <h4>1. Who this finds</h4><p>Private companies big enough for a private credit facility (roughly $20M+ revenue) that are paying too much for money or under cash strain. They never file with the SEC, so Credit signals can't see them.</p>
      <h4>2. Where the data comes from</h4>
      <ul><li><b>UCC filings</b>: a lender's public notice that it has a lien on a company's assets. Every state that gives the data away free is in: Connecticut and Colorado (every filing, nightly), Oregon (publishes only last month's filings, so HQ keeps its own archive and the history grows each month; older months backfilled from web archive copies) and Florida (federal tax liens only: Florida privatised its UCC registry). Last 30 months, plus bank liens about to lapse (CT, CO).</li>
      <li><b>Size</b>: filings carry no revenue, so each company is matched by name and state (same state only) to the SBA's PPP loan data (2020–21). The loan was about 2.5 months of payroll; revenue is estimated from that and the jobs reported. Only loans of $500K+ are considered.</li></ul>
      <h4>3. What counts as a signal (score)</h4><ul>
      <li><b>+20</b> stacking: 2+ filings by named merchant cash advance funders in 18 months; <b>+12</b> one in the last 12 months. Counts toward Target only at $50M+ revenue (smaller cash-advance borrowers are factoring deals).</li>
      <li><b>+15</b> 4+ liens in 18 months filed through agents that hide the lender (CSC, CT Corporation, First Corporate Solutions "as representative"). Cash-advance funders use these agents a lot, but so do equipment lessors, so 3 counts <b>+10</b> and 1 only <b>+8</b>.</li>
      <li><b>+20</b> IRS tax lien (it ranks ahead of any new lender, so usually an asset-based deal that pays the IRS off), <b>+15</b> state tax or labor-department lien, <b>+12</b> judgment lien (last 2 years).</li>
      <li><b>+15</b> a bank or agent facility filed about 5 years ago whose lien lapses in 3–12 months: often near maturity. Alone it makes a Target only at $50M+ revenue. Liens continued for decades don't count.</li>
      <li><b>+15</b> factoring, <b>+10</b> platform loans (WebBank, Shopify, PayPal), <b>+5</b> already borrows from an agent or asset-based lender.</li>
      <li><b>+20</b> estimated revenue $50M+, <b>+12</b> $30–50M; <b>+10</b> newest distress filing in the last 90 days.</li></ul>
      <p>Target = estimated revenue $30M+ and a strong signal (tax or judgment lien; cash advances only at $50M+), or $50M+ with a maturing facility. Public companies are cut (they're in Credit signals). $10–30M or weaker signals = Maybe. Lenders, public bodies, non-profits and anything under $10M are cut.</p>
      <h4>4. What it can't see</h4><ul><li>Companies organized in other states: a UCC is filed where the company is incorporated, so a Delaware LLC based in Connecticut is missed. No other state publishes UCC data free; the rest sell it (Texas full file about $1,150 one-time).</li>
      <li>Loan amounts: UCC filings don't say how much was borrowed.</li><li>Size is a 2020 estimate: check the website and LinkedIn headcount before calling.</li></ul>
      <p class="s muted">The message never mentions liens. They are public, but naming them in a first message reads as surveillance.</p></div>`,
  });
}
