// Pipeline: every live opportunity and relationship on one screen, who holds the ball, and what has gone quiet.
// Reads opportunities / people / tasks / lead_intake (the same tables the old board uses), so both stay in step.
import { sb, state, esc, $, $$, toast, fail, modal, opts, avatar, firstName, fmtDate, num } from './core.js';
import { teaserModal } from './teasers.js';
import { renderFunds, fundTargetCount } from './funds.js';
import { renderCredit, creditTargetCount } from './credit.js';
import { renderUcc, uccTargetCount } from './ucc.js';
import { renderBdc, bdcTargetCount } from './bdc.js';
import { ROTATION, REACH, MET_FROM, CADENCE, meName, teamName, isMet, nextSender, touchDue, touchFields, pickOwner } from './leadowner.js';
import { briefModal, syncBriefs, briefLine } from './brief.js';

const BUY = [REACH, 'New Relationship', 'Diligence Call Complete', 'NDA Signed + Thesis Captured', 'Relevant Deal Identified', 'Interest Meeting Held', 'Buyer Interest Confirmed', 'Engagement Active', 'Closed'];
const SELL = [REACH, 'New Relationship', 'Diligence Call Complete', 'NDA Signed + Buy-Side Thesis Shared', 'Opportunity Received', 'Initial Interest Identified', 'Buy-Side Interest Confirmed', 'Engagement Active', 'Closed'];
// 'Both' = banks / advisers who are also capital (an IB with family offices). They are tracked as relationships on their own
// board; any actual deal under them is a Sell or Buy side deal with the full stage list.
const BOTH = [REACH, 'New Relationship', 'Diligence Call Complete', 'NDA Signed + Thesis Captured', 'Engagement Active', 'Closed'];
const stagesFor = side => side === 'Buy Side' ? BUY : side === 'Both' ? BOTH : SELL;
const SIDES = ['Sell Side', 'Buy Side', 'Both'];
const relType = sd => sd === 'Buy Side' ? 'Buy-side Relationship' : sd === 'Both' ? 'Sell + Buy-side Relationship' : 'Sell-side Relationship';
const sideShort = sd => sd === 'Buy Side' ? 'Buy' : sd === 'Both' ? 'Both' : 'Sell';
// An unknown or empty stage counts as New Relationship (index 1); To Reach Out is only ever set on purpose.
const stageIdx = (side, stage) => { const at = stagesFor(side).indexOf(stage); return at < 0 ? 1 : at; };
const nextStage = i => { const st = stagesFor(i.side), at = stageIdx(i.side, i.stage); return at < st.length - 1 ? st[at + 1] : null; };
const hasDms = i => !!(i.person?.linkedin_url || i.person?.last_inbound_message);
const SEV = { bad: 3, warn: 2, info: 1 };
const DAY = 864e5;
// How urgent a LinkedIn reply is. Someone asking for a call or handing over contact details is a meeting waiting to happen.
const NO_RE = /\b(not (for me|our market|a fit|interested|quite a fit)|no thanks|done with|unsubscribe|remove me|not relevant)\b/i;
const HOT_RE = /\b(call|meeting|meet|chat|zoom|teams|whatsapp|calendar|schedule|available|catch up|speak|connect this week|drop me an email|email me|send me)\b|@[a-z0-9-]+\.[a-z]|\+\d[\d\s-]{7,}/i;
const DEAL_RE = /\b(raise|raising|capital raising|investor for|mandate|deal|teaser|deck|acquisition|concession|project|EV|enterprise value)\b/i;
export function leadHeat(l) {
  const t = String(l.reply_text || '');
  if (NO_RE.test(t)) return { score: -10, label: 'Looks like a no', tone: '' };
  let s = 0; const hot = HOT_RE.test(t), deal = DEAL_RE.test(t);
  if (hot) s += 5; if (deal) s += 3; if (l.decision === 'qualified_sell_side') s += 2; if (l.decision?.startsWith('qualified')) s += 1;
  const age = daysSince(l.created_at); if (age <= 10) s += 2; else if (age > 35) s -= 1;
  return { score: s, label: hot ? 'Wants to talk' : deal ? 'Has a deal' : '', tone: hot ? 'bad' : deal ? 'warn' : '' };
}

let lastMove = null; // the last one-click / drag move, so a mis-click is one tap to undo
let root, D = null, loadedAt = 0, side = 'Sell Side', flt = null, showAllLeads = false, tab = 'need';
const COL_CAP = 4, openCols = new Set(); // board columns show the 4 most urgent cards; "Show N more" expands one column

const todayIso = () => new Date().toISOString().slice(0, 10);
const daysSince = ts => ts ? Math.max(0, Math.floor((Date.now() - Date.parse(ts)) / DAY)) : null;
const money = n => !n ? '' : n >= 1e9 ? '$' + +(n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? '$' + +(n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + Math.round(n / 1e3) + 'K' : '$' + n;
const slug = u => String(u || '').replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop().toLowerCase();

// ---- Data ----
async function fetchCore() {
  const [o, p, t] = await Promise.all([
    sb.from('opportunities').select('*'),
    sb.from('people').select('*'),
    sb.from('tasks').select('*').eq('completed', false),
  ]);
  if (o.error || p.error || t.error) { console.error(o.error || p.error || t.error); return null; }
  return { opps: o.data || [], people: p.data || [], tasks: t.data || [] };
}
async function fetchAll() {
  const [core, l, a, io] = await Promise.all([
    fetchCore(),
    sb.from('lead_intake').select('id,name,headline,company_name,reply_text,decision,confidence,reason,sell_side_kind,suggested_next_step,source_account,campaign_name,linkedin_url,created_at,person_id,reviewed_at').is('person_id', null).is('reviewed_at', null).order('created_at', { ascending: false }).limit(300),
    sb.from('daily_ops_accounts').select('owner_name,linkedin_url'),
    sb.from('inbox_owners').select('account_name,responder'),
  ]);
  if (!core) return null;
  syncBriefs(core.people).then(n => { if (n) reload(); }); // finished briefs → people.brief
  // One row per person: a lead who replied twice is one lead (newest reply shown, all rows stamped together).
  const groups = new Map();
  for (const x of (l.data || []).filter(x => x.decision !== 'not_qualified')) {
    const k = slug(x.linkedin_url) || x.id, g = groups.get(k);
    if (g) { g.ids.push(x.id); g.replies++; if (x.decision.startsWith('qualified') && !g.decision.startsWith('qualified')) g.decision = x.decision; }
    else groups.set(k, { ...x, ids: [x.id], replies: 1 });
  }
  const d = { ...core, leads: [...groups.values()], accts: a.data || [], responders: io.data || [] };
  await backfillOwners(d);
  return d;
}

// The person who answers an account's inbox is who the lead talks to before the first meeting.
function responderFor(sourceAccount, d = D) {
  const s = slug(sourceAccount), a = d?.accts.find(x => s && slug(x.linkedin_url) === s);
  if (!a) return '';
  const r = d.responders.find(x => teamName(x.account_name) === teamName(a.owner_name) || x.account_name === a.owner_name);
  return teamName(r?.responder) || teamName(a.owner_name);
}
// Every live person gets a sticky owner once: their open task's owner if that's a team member, else the inbox responder of the
// account they came in on, else round robin. Silently does nothing until the owner_name column exists.
let backfilled = false;
async function backfillOwners(d) {
  if (backfilled) return; backfilled = true;
  const todo = d.people.filter(p => p.pipeline_active !== false && !p.owner_name && 'owner_name' in p);
  if (!todo.length) return;
  const load = Object.fromEntries(ROTATION.map(r => [r, d.people.filter(p => teamName(p.owner_name) === r && !p.met_at).length]));
  for (const p of todo) {
    const t = d.tasks.find(t => t.person_id === p.id && teamName(t.owner_name));
    let o = teamName(t?.owner_name) || responderFor(p.source_account, d);
    if (!o) { o = ROTATION.slice().sort((a, b) => load[a] - load[b])[0]; load[o]++; }
    const r = await sb.from('people').update({ owner_name: o }).eq('id', p.id);
    if (r.error) return; // column missing or no rights: try again next session
    p.owner_name = o;
  }
}

// ---- The model: one "item" per live deal, plus one per live relationship that has no deal yet ----
function buildItems({ opps, people, tasks }) {
  const today = todayIso();
  const liveOpps = opps.filter(o => o.pipeline_active !== false);
  const oppsByPerson = {}; liveOpps.forEach(o => { if (o.person_id) (oppsByPerson[o.person_id] ||= []).push(o); });
  const pById = Object.fromEntries(people.map(p => [p.id, p]));
  const tasksFor = (oppId, personId, single) => tasks.filter(t => (oppId && t.opportunity_id === oppId) || (!t.opportunity_id && personId && t.person_id === personId && (single || !oppId)));
  const items = [];
  for (const o of liveOpps) {
    const p = pById[o.person_id];
    const single = p && (oppsByPerson[p.id] || []).length === 1;
    items.push(mk({ kind: 'deal', id: o.id, name: o.title, sub: p?.name || '', side: o.side === 'Both' ? 'Sell Side' : o.side, stage: o.pipeline_stage || o.stage, ball: o.waiting_on, since: o.waiting_on_since || o.updated_at, updated: o.updated_at, next: o.next_step, owner: o.next_step_owner || o.owner_name, due: o.due_date, size: o.opportunity_size, raise: num(o.revenue_raise_amount), tasks: tasksFor(o.id, p?.id, single), row: o, person: p }, today));
  }
  for (const p of people) {
    if (p.pipeline_active === false || (oppsByPerson[p.id] || []).length) continue;
    items.push(mk({ kind: 'rel', id: p.id, name: p.name, sub: [p.company_name || p.relationship_type].filter(Boolean).join(' · '), side: p.primary_side === 'Buy Side' ? 'Buy Side' : p.primary_side === 'Both' ? 'Both' : 'Sell Side', stage: p.pipeline_stage, ball: p.waiting_on, since: p.waiting_on_since || p.updated_at, updated: p.updated_at, next: null, tasks: tasksFor(null, p.id, false), row: p, person: p, raise: 0 }, today));
  }
  return items;
}
function mk(i, today) {
  const t0 = i.tasks.slice().sort((a, b) => String(a.due_date || '9').localeCompare(String(b.due_date || '9')))[0];
  i.nextText = i.next || t0?.action || '';
  i.due = i.due || t0?.due_date || null;
  i.owner = i.owner || t0?.owner_name || '';
  i.days = daysSince(i.since) ?? 0;
  i.closed = i.stage === 'Closed';
  i.ball = i.ball === 'us' || i.ball === 'them' ? i.ball : null;
  // Ownership: one sticky owner before the first meeting, then follow-ups rotate (leadowner.js).
  const st = stagesFor(i.side), p = i.person;
  i.reach = i.stage === REACH;
  i.met = isMet(p, stageIdx(i.side, i.stage), st.indexOf(MET_FROM));
  i.leadOwner = teamName(p?.owner_name) || p?.owner_name || '';
  i.nextBy = i.met && p ? nextSender(p) : i.leadOwner || teamName(i.owner) || '';
  const f = [], add = (code, sev, text) => f.push({ code, sev, text });
  if (!i.closed && i.reach) {
    add('reach', i.days >= 3 ? 'warn' : 'info', `Not contacted yet · ${i.days}d`);
  } else if (!i.closed) {
    const td = i.met && p && i.ball !== 'us' ? touchDue(p) : null;
    if (i.ball === 'us') add('us', i.days >= 7 ? 'bad' : i.days >= 3 ? 'warn' : 'info', `Our move · ${i.days}d`);
    else if (td) { if (td.left <= 0) add('touch', -td.left >= td.gap ? 'bad' : 'warn', `Follow-up due · ${i.nextBy}'s turn`); }
    else if (i.ball === 'them') add('them', i.days >= 14 ? 'bad' : i.days >= 7 ? 'warn' : 'info', i.days >= 7 ? `Chase · waiting ${i.days}d` : `Their move · ${i.days}d`);
    else add('noball', 'warn', 'Nobody owns the next move');
    if (!i.nextText && !td) add('nonext', 'warn', 'No next step');
    if (!i.met && p && !p.brief && 'brief' in p) add('nobrief', 'warn', 'No pre-meeting brief');
    const od = i.tasks.filter(t => t.due_date && t.due_date < today);
    if (od.length) add('overdue', 'bad', `${od.length} overdue task${od.length > 1 ? 's' : ''}`);
    const idle = daysSince(i.updated);
    if (idle >= 21) add('stale', 'warn', `No movement in ${idle}d`);
  }
  i.flags = f.sort((a, b) => SEV[b.sev] - SEV[a.sev]);
  i.sev = f.length ? Math.max(...f.map(x => SEV[x.sev])) : 0;
  i.has = code => f.some(x => x.code === code);
  const me = meName();
  i.mine = !!me && !i.closed && (i.met ? i.has('touch') && i.nextBy === me : i.nextBy === me && (i.reach || i.ball === 'us'));
  return i;
}
const byHeat = (a, b) => b.sev - a.sev || b.days - a.days;

// Shared with the nav badge: how many things are red right now.
export async function refreshPipelineBadge() {
  const a = document.querySelector('.nav a[data-page="pipeline"]'); if (!a) return;
  const core = await fetchCore(); if (!core) return;
  const red = buildItems(core).filter(i => i.sev >= 3).length;
  let b = a.querySelector('.badge'); if (!b) { b = document.createElement('span'); a.appendChild(b); }
  b.className = 'badge' + (red ? ' hot' : ''); b.textContent = red || ''; b.title = red ? `${red} need action now` : '';
  if (!red) b.remove();
}

// ---- Render ----
// Tab counts for the signal tabs straight from the database, so they show before a tab is opened.
let sigCounts = {}, sigAt = 0;
async function refreshSigCounts() {
  if (Date.now() - sigAt < 60000) return;
  sigAt = Date.now();
  const { data } = await sb.rpc('signal_target_counts');
  if (!data) return;
  sigCounts = data;
  for (const k of ['funds', 'credit', 'bdc', 'ucc']) { const em = root?.querySelector(`[data-tab="${k}"] em`); if (em && em.textContent === '0') em.textContent = data[k] ?? 0; }
}

export async function renderPipeline(r, sub) {
  root = r;
  refreshSigCounts();
  if (['reach', 'leads', 'funds', 'credit', 'bdc', 'ucc'].includes(sub) && tab !== sub) { tab = sub; flt = null; history.replaceState(null, '', '#/pipeline'); }
  const fresh = D && Date.now() - loadedAt < 8000;
  if (!D) root.innerHTML = '<div class="empty">Loading pipeline…</div>';
  if (!fresh) {
    const d = await fetchAll();
    if (root.dataset.page !== 'pipeline') return;
    if (!d) { root.innerHTML = '<div class="empty">Could not load the pipeline. Try Refresh.</div>'; return; }
    D = d; loadedAt = Date.now();
  }
  draw();
}
const reload = async () => { D = await fetchAll() || D; loadedAt = Date.now(); if (root?.dataset.page === 'pipeline') draw(); refreshPipelineBadge(); };

function draw() {
  const all = buildItems(D), live = all.filter(i => !i.closed), today = todayIso();
  const liveDeals = live.filter(i => i.kind === 'deal');
  const k = {
    us: live.filter(i => i.ball === 'us'),
    them: live.filter(i => i.ball === 'them' && i.days >= 7),
    nonext: live.filter(i => i.has('nonext') || i.has('noball')),
    overdue: live.filter(i => i.has('overdue')),
    mine: live.filter(i => i.mine),
  };
  const reach = live.filter(i => i.reach).sort((a, b) => b.days - a.days);
  const leads = D.leads.slice().sort((a, b) => leadHeat(b).score - leadHeat(a).score || String(b.created_at).localeCompare(String(a.created_at)));
  const qualified = leads.filter(l => l.decision.startsWith('qualified')).length;
  const raise = liveDeals.reduce((n, i) => n + i.raise, 0);
  const kpi = (f, label, n, sev) => `<button type="button" class="pChip pf ${flt === f ? 'on' : ''}" data-f="${f}" data-sev="${n ? sev : ''}"><b>${n}</b>${label}</button>`;

  let need = live.filter(i => i.sev >= 2 && !i.reach); // To Reach Out has its own tab
  if (flt === 'us') need = k.us; else if (flt === 'them') need = k.them; else if (flt === 'nonext') need = k.nonext; else if (flt === 'overdue') need = k.overdue; else if (flt === 'mine') need = k.mine;
  need = need.slice().sort(byHeat);
  const parked = [...D.opps.filter(o => o.pipeline_active === false).map(o => ({ kind: 'deal', id: o.id, name: o.title, sub: o.side })), ...D.people.filter(p => p.pipeline_active === false && !D.opps.some(o => o.person_id === p.id && o.pipeline_active !== false)).map(p => ({ kind: 'rel', id: p.id, name: p.name, sub: p.primary_side || '' }))];

  const inFlt = new Set((flt && flt !== 'leads' ? need : []).map(i => i.kind + ':' + i.id));
  const tabs = [['need', flt && flt !== 'leads' ? { us: 'Our move', them: 'Chase them', nonext: 'No next step', overdue: 'Overdue', mine: 'My turn' }[flt] : 'Needs you', need.length], ['reach', 'To reach out', reach.length], ['leads', 'LinkedIn leads', leads.length], ['funds', 'Fund signals', fundTargetCount() || sigCounts.funds || 0], ['credit', 'Credit signals', creditTargetCount() || sigCounts.credit || 0], ['bdc', 'BDC loans', bdcTargetCount() || sigCounts.bdc || 0], ['ucc', 'UCC signals', uccTargetCount() || sigCounts.ucc || 0], ...(parked.length ? [['parked', 'Parked', parked.length]] : [])];
  const panel = tab === 'funds' ? '<div id="fsPanel"></div>' : tab === 'credit' ? '<div id="crPanel"></div>' : tab === 'bdc' ? '<div id="bdPanel"></div>' : tab === 'ucc' ? '<div id="ucPanel"></div>' : tab === 'leads'
    ? `<p class="pHint">${qualified} qualified${leads.length - qualified ? `, ${leads.length - qualified} still to review` : ''}. Add them before they go cold.</p>
      <div class="pList">${leads.length ? leads.slice(0, showAllLeads ? 300 : 8).map(leadHtml).join('') : '<div class="empty">Inbox is clear.</div>'}</div>
      ${leads.length > 8 ? `<footer class="pMore"><button class="btn sm" data-more>${showAllLeads ? 'Show fewer' : `Show all ${leads.length}`}</button></footer>` : ''}`
    : tab === 'reach'
      ? `<p class="pHint">Targets nobody has spoken to yet. Each one has one owner until the first meeting, so they hear from the same person. Hit “Reached out” once the first message is sent.</p>
      <div class="pList">${reach.length ? reach.map(rowHtml).join('') : '<div class="empty">Nobody waiting to be contacted.</div>'}</div>`
    : tab === 'parked'
      ? `<div class="pList">${parked.map(x => `<div class="pRow" data-sev="0"><span class="pDot"></span><div class="pMain"><div class="pTitle">${esc(x.name)}</div><div class="pSub">${esc(x.sub)}</div></div><div class="pAct"><button class="btn sm" data-react="${x.kind}:${x.id}">Reactivate</button></div></div>`).join('')}</div>`
      : `<p class="pHint">${flt && flt !== 'leads' ? 'Filtered. Matching cards are highlighted on the board.' : 'Waiting on us 3+ days, on them 7+ days, or missing a next step. Most urgent first.'}${flt ? ' <button class="link s" data-clear>Clear filter</button>' : ''}</p>
      <div class="pList">${need.length ? need.map(rowHtml).join('') : '<div class="empty">Nothing is stuck. Every live item has a next move and is on time.</div>'}</div>`;
  root.innerHTML = `<div class="pipe">
    <div class="pTop">
      <div class="pTitleRow"><h1>Pipeline</h1><span class="muted s">${liveDeals.length} deal${liveDeals.length === 1 ? '' : 's'} · ${live.length - liveDeals.length} relationships${raise ? ` · <b class="pRaise">${money(raise)}</b> in play` : ''}</span></div>
      <div class="row"><button class="btn sm" id="pRefresh">Refresh</button><button class="btn sm" id="pAddPerson">Add person</button><button class="btn sm primary" id="pAddDeal">Add deal</button></div>
    </div>
    <div class="pChips">
      ${meName() ? kpi('mine', 'my turn', k.mine.length, 'warn') : ''}${kpi('us', 'our move', k.us.length, 'bad')}${kpi('them', 'to chase', k.them.length, 'warn')}${kpi('nonext', 'no next step', k.nonext.length, 'warn')}${kpi('overdue', 'overdue', k.overdue.length, 'bad')}${kpi('leads', 'leads waiting', qualified, 'warn')}
    </div>
    <section class="card pSec pBoardCard ${inFlt.size ? 'filtering' : ''}"><header><div class="pSeg" role="group">${SIDES.map(s => `<button type="button" data-side="${s}" class="${side === s ? 'on' : ''}">${s}<em>${live.filter(i => i.side === s).length}</em></button>`).join('')}</div>
      <p>${lastMove ? `<span class="pUndo">Moved ${esc(lastMove.name)} <button type="button" class="link s" data-undo>Undo</button></span>` : `${side === 'Both' ? 'Banks and advisers who are also capital. ' : ''}Drag a card to change its stage, or click it to update.`}</p></header>
      <div class="pBoard">${boardHtml(live, inFlt)}</div></section>
    <section class="card pSec" id="pNeed"><header class="pTabs">${tabs.map(([k, l, n]) => `<button type="button" data-tab="${k}" class="${tab === k ? 'on' : ''}">${esc(l)}<em>${n}</em></button>`).join('')}</header>
      ${panel}</section>
  </div>`;
  bind(all);
  if (tab === 'funds') renderFunds($('#fsPanel'), n => { const em = $('[data-tab="funds"] em', root); if (em) em.textContent = n; });
  if (tab === 'bdc') renderBdc($('#bdPanel'), n => { const em = $('[data-tab="bdc"] em', root); if (em) em.textContent = n; });
  if (tab === 'ucc') renderUcc($('#ucPanel'), n => { const em = $('[data-tab="ucc"] em', root); if (em) em.textContent = n; });
  if (tab === 'credit') renderCredit($('#crPanel'), n => { const em = $('[data-tab="credit"] em', root); if (em) em.textContent = n; });
}

const flagChip = f => `<span class="pFlag ${f.sev}">${esc(f.text)}</span>`;
// Who this lead talks to: the sticky owner before the first meeting, whoever's turn it is after it.
const whoHtml = i => i.met && i.person
  ? `<span class="pOwn" title="After the first meeting follow-ups rotate ${ROTATION.join(' → ')}">${avatar(i.nextBy, 'xs')}Next touch: ${esc(i.nextBy)}</span>`
  : i.leadOwner ? `<span class="pOwn" title="Owns this lead until the first meeting">${avatar(i.leadOwner, 'xs')}Owner: ${esc(i.leadOwner)}</span>` : '';
function rowHtml(i) {
  const act = i.reach ? `<button class="btn sm primary" data-q="reached" data-k="${i.kind}:${i.id}">Reached out</button>`
    : i.has('touch') ? `<button class="btn sm primary" data-q="chased" data-k="${i.kind}:${i.id}" title="Logs the touch and passes the next one on">Sent follow-up</button>`
    : i.ball === 'us' ? `<button class="btn sm primary" data-q="followed" data-k="${i.kind}:${i.id}">Followed up</button>`
    : i.ball === 'them' ? `<button class="btn sm" data-q="replied" data-k="${i.kind}:${i.id}">They replied</button><button class="btn sm" data-q="chased" data-k="${i.kind}:${i.id}">Chased again</button>`
      : `<button class="btn sm" data-q="us" data-k="${i.kind}:${i.id}">Our move</button><button class="btn sm" data-q="them" data-k="${i.kind}:${i.id}">Their move</button>`;
  return `<div class="pRow" data-sev="${i.sev}"><span class="pDot"></span>
    <div class="pMain"><div class="pTitle">${esc(i.name)}</div><div class="pSub">${esc(i.stage || 'No stage')} · ${i.kind === 'deal' ? 'Deal' : 'Relationship'} · ${sideShort(i.side)}${i.sub ? ' · ' + esc(i.sub) : ''}</div>
      <div class="pFlags">${i.flags.filter(f => f.sev !== 'info' && f.code !== 'nonext').map(flagChip).join('')}</div>
      <div class="pNext">${i.nextText ? `<b>Next:</b> ${esc(i.nextText)}${i.due ? ` <span class="muted">· due ${fmtDate(i.due)}</span>` : ''}` : i.reach ? '<i>Send the first message</i>' : i.met && i.person ? `<i>Stay in touch every ${CADENCE[Math.min(i.person?.touch_count || 0, CADENCE.length - 1)]}d</i>` : '<i>No next step set</i>'}${whoHtml(i) ? ` ${whoHtml(i)}` : i.owner ? ` <span class="pOwn">${avatar(i.owner, 'xs')}${esc(firstName(i.owner))}</span>` : ''}</div>
      ${i.person ? briefLine(i.person) : ''}</div>
    <div class="pAct">${act}${i.person ? `<button class="btn sm" data-brief="${i.kind}:${i.id}">Brief</button>` : ''}${!i.reach && nextStage(i) ? `<button class="btn sm" data-adv="${i.kind}:${i.id}" title="Move to ${esc(nextStage(i))}">Next stage →</button>` : ''}${hasDms(i) ? `<button class="btn sm ghost" data-dm="${i.kind}:${i.id}">DMs</button>` : ''}<button class="btn sm ghost" data-upd="${i.kind}:${i.id}">Update</button></div></div>`;
}
function boardHtml(live, inFlt = new Set()) {
  const st = stagesFor(side).filter(x => x !== 'Closed'), items = live.filter(i => i.side === side);
  const cols = st.map((name, idx) => ({ name, items: items.filter(i => stageIdx(side, i.stage) === idx).sort(byHeat) }));
  const tpl = cols.map(c => c.items.length ? 'minmax(250px,1fr)' : 'minmax(120px,150px)').join(' ');
  return `<div class="pGrid" style="grid-template-columns:${tpl}">${cols.map((c, idx) => {
    const hot = c.items.filter(i => i.sev >= 3).length, total = c.items.reduce((n, i) => n + i.raise, 0);
    return `<div class="pCol ${c.items.length ? '' : 'none'}" data-drop="${esc(c.name)}"><h3><span class="n">${idx + 1}</span>${esc(c.name)}</h3>
      <div class="pColSum"><b>${c.items.length}</b>${hot ? `<span class="pFlag bad">${hot} red</span>` : ''}${total ? `<span class="s muted">${money(total)}</span>` : ''}</div>
      ${boardCards(c, idx, inFlt)}</div>`;
  }).join('')}</div>`;
}
// Cap each column so one busy stage can't make the page endless. A filter that matches hidden cards opens the column.
function boardCards(c, idx, inFlt) {
  if (!c.items.length) return '<div class="pEmpty">Empty</div>';
  const key = side + ':' + idx, hiddenHit = c.items.slice(COL_CAP).some(i => inFlt.has(i.kind + ':' + i.id));
  const open = openCols.has(key) || hiddenHit || c.items.length <= COL_CAP + 1; // never hide just one card
  const shown = open ? c.items : c.items.slice(0, COL_CAP);
  return shown.map(i => cardHtml(i, inFlt.has(i.kind + ':' + i.id))).join('')
    + (c.items.length > COL_CAP + 1 ? `<button type="button" class="pColMore" data-col="${key}">${open ? 'Show fewer' : `Show ${c.items.length - COL_CAP} more`}</button>` : '');
}
function cardHtml(i, hit) {
  const tone = i.ball === 'us' ? (i.days >= 7 ? 'bad' : i.days >= 3 ? 'warn' : '') : i.ball === 'them' ? (i.days >= 14 ? 'bad' : i.days >= 7 ? 'warn' : '') : 'warn';
  const tone2 = i.reach ? (i.days >= 3 ? 'warn' : '') : i.has('touch') ? i.flags.find(f => f.code === 'touch').sev : i.met && i.person && i.ball !== 'us' ? '' : tone;
  const extra = i.flags.filter(f => f.sev !== 'info' && !['us', 'them', 'noball', 'nonext', 'reach', 'touch'].includes(f.code));
  const td = i.met && i.person && !i.nextText ? touchDue(i.person) : null;
  const nextTxt = i.nextText || (td ? (td.left > 0 ? `Next touch in ${td.left}d` : 'Send a follow-up now') : i.reach ? 'Send the first message' : '');
  const nx = nextStage(i), key = `${i.kind}:${i.id}`, size = i.raise ? money(i.raise) : i.size || '';
  const ballTxt = i.reach ? 'Not contacted' : i.has('touch') ? 'Follow-up due' : i.ball === 'us' ? 'Our move' : i.ball === 'them' ? 'Their move' : 'Nobody owns it';
  const tip = [i.sub, ...extra.map(f => f.text)].filter(Boolean).join(' · '); // detail lives in the tooltip and the click-through modal
  return `<div role="button" tabindex="0" draggable="true" class="pCard pk ${hit ? 'hit' : ''}" data-sev="${i.sev}" data-upd="${key}" data-drag="${key}"${tip ? ` title="${esc(tip)}"` : ''}>
    <div class="pcHead"><b class="pcName">${esc(i.name)}</b>${size ? `<span class="pcSize">${esc(size)}</span>` : ''}</div>
    <div class="pkMeta"><span class="pkBall" data-tone="${tone2}">${ballTxt} · ${i.days}d</span>${extra.length ? `<span class="pkExtra ${extra[0].sev}">${extra.length > 1 ? `${extra.length} flags` : esc(extra[0].text)}</span>` : ''}<span class="pcAct">${hasDms(i) ? `<button type="button" class="pcLink" data-dm="${key}">DMs</button>` : ''}${nx ? `<button type="button" class="pkAdv" data-adv="${key}" title="Move to ${esc(nx)}" aria-label="Move to ${esc(nx)}">→</button>` : ''}</span></div>
    <div class="pkRow"><p class="pkNext ${nextTxt ? '' : 'none'}">${nextTxt ? esc(nextTxt) : 'No next step set'}</p>
    ${cardWho(i)}</div></div>`;
}
function cardWho(i) {
  const n = i.nextBy || i.owner, tip = i.met && i.person ? `Next follow-up: ${n} (rotation ${ROTATION.join(' → ')})` : n ? `Owner until the first meeting: ${n}` : 'No owner';
  return `<span class="pkOwn" title="${esc(tip)}">${n ? avatar(n, 'xs') + esc(firstName(n)) + (i.met && i.person ? ' <em class="pkTurn">next</em>' : '') : '<span class="muted">No owner</span>'}</span>`;
}
function leadHtml(l) {
  const q = l.decision.startsWith('qualified'), sd = l.decision === 'qualified_buy_side' ? 'Buy Side' : l.decision === 'qualified_sell_side' ? 'Sell Side' : '';
  const age = daysSince(l.created_at);
  const h = leadHeat(l);
  return `<div class="pRow" data-sev="${h.score < 0 ? 0 : h.label === 'Wants to talk' ? 3 : q && age >= 3 ? 2 : 0}"><span class="pDot"></span>
    <div class="pMain"><div class="pTitle">${l.linkedin_url ? `<a href="${esc(l.linkedin_url)}" target="_blank" rel="noopener">${esc(l.name || 'Unknown')} ↗</a>` : esc(l.name || 'Unknown')} </div><div class="pFlags">${h.label ? `<span class="pFlag ${h.tone}">${h.label}</span>` : ''}${q ? `<span class="pFlag good">${sd} · qualified</span>` : '<span class="pFlag">Needs review</span>'}<span class="pFlag ${age >= 7 ? 'bad' : age >= 3 ? 'warn' : ''}">${age}d in inbox</span>${l.replies > 1 ? `<span class="pFlag">${l.replies} replies</span>` : ''}</div>
      <div class="pSub">${esc([l.headline, l.company_name].filter(Boolean).join(' · '))}</div>
      ${l.reply_text ? `<div class="pNext"><b>Said:</b> “${esc(String(l.reply_text).slice(0, 160))}${l.reply_text.length > 160 ? '…' : ''}” <button class="link s" data-ldm="${l.id}">Open full DMs</button></div>` : ''}
      ${l.suggested_next_step ? `<div class="pNext muted">Suggested: ${esc(l.suggested_next_step)}</div>` : ''}</div>
    <div class="pAct"><button class="btn sm ${sd === 'Sell Side' ? 'primary' : ''}" data-lead="sell:${l.id}">Add as sell side</button><button class="btn sm ${sd === 'Buy Side' ? 'primary' : ''}" data-lead="buy:${l.id}">Add as buy side</button><button class="btn sm" data-lead="both:${l.id}">Both</button><button class="btn sm ghost" data-teaser="${l.id}">Make teaser</button><button class="btn sm ghost" data-lead="no:${l.id}">Not a fit</button></div></div>`;
}

function bind(all) {
  const find = key => { const [kind, id] = key.split(':'); return all.find(i => i.kind === kind && i.id === id); };
  $('#pRefresh').onclick = async () => { await reload(); toast('Refreshed'); };
  $('#pAddPerson').onclick = addPersonModal; $('#pAddDeal').onclick = addDealModal;
  $$('.pf', root).forEach(b => b.onclick = () => {
    if (b.dataset.f === 'leads') { tab = 'leads'; flt = null; draw(); $('#pNeed').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    flt = flt === b.dataset.f ? null : b.dataset.f; tab = 'need'; draw();
  });
  $$('[data-tab]', root).forEach(b => b.onclick = () => { tab = b.dataset.tab; draw(); });
  $('[data-clear]', root)?.addEventListener('click', () => { flt = null; draw(); });
  $$('[data-side]', root).forEach(b => b.onclick = () => { side = b.dataset.side; draw(); });
  $('[data-more]', root)?.addEventListener('click', () => { showAllLeads = !showAllLeads; draw(); });
  $$('[data-col]', root).forEach(b => b.onclick = () => { const k = b.dataset.col; openCols.has(k) ? openCols.delete(k) : openCols.add(k); draw(); });
  $$('[data-upd]', root).forEach(b => { const open = () => { const i = find(b.dataset.upd); if (i) updateModal(i); }; b.onclick = open; b.onkeydown = e => { if (e.target === b && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } }; });
  // Drag and drop between stage columns (desktop). Phones use the update window.
  let dragKey = null;
  $$('[data-drag]', root).forEach(c => {
    c.ondragstart = e => { dragKey = c.dataset.drag; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragKey); };
    c.ondragend = () => { c.classList.remove('dragging'); $$('.pCol.dropOk', root).forEach(x => x.classList.remove('dropOk')); };
  });
  $$('[data-drop]', root).forEach(col => {
    col.ondragover = e => { if (!dragKey) return; e.preventDefault(); col.classList.add('dropOk'); };
    col.ondragleave = e => { if (!col.contains(e.relatedTarget)) col.classList.remove('dropOk'); };
    col.ondrop = async e => {
      e.preventDefault(); col.classList.remove('dropOk');
      const i = find(dragKey || e.dataTransfer.getData('text/plain')); dragKey = null;
      if (i && await setStage(i, col.dataset.drop)) await reload();
    };
  });
  $('[data-undo]', root)?.addEventListener('click', async () => {
    const m = lastMove; lastMove = null; const i = find(m.key);
    if (i && await setStage(i, m.from)) { lastMove = null; toast(`${m.name} back to ${m.from}`); }
    await reload();
  });
  $$('[data-adv]', root).forEach(b => b.onclick = async e => { e.stopPropagation(); const i = find(b.dataset.adv); if (!i) return; b.disabled = true; if (await advance(i)) await reload(); else b.disabled = false; });
  $$('[data-dm]', root).forEach(b => b.onclick = e => { e.stopPropagation(); const i = find(b.dataset.dm); if (i) dmModal({ name: i.person?.name || i.name, url: i.person?.linkedin_url, personId: i.person?.id, fallback: i.person?.last_inbound_message }); });
  $$('[data-teaser]', root).forEach(b => b.onclick = () => { const l = D.leads.find(x => x.id === b.dataset.teaser); if (l) teaserModal({ lead_intake_id: l.id, lead_name: l.name, lead_company: l.company_name, linkedin_url: l.linkedin_url }); });
  $$('[data-ldm]', root).forEach(b => b.onclick = () => { const l = D.leads.find(x => x.id === b.dataset.ldm); if (l) dmModal({ name: l.name, url: l.linkedin_url, leadId: l.id, fallback: l.reply_text }); });
  $$('[data-q]', root).forEach(b => b.onclick = async () => {
    const i = find(b.dataset.k); if (!i) return; b.disabled = true;
    const q = b.dataset.q, now = new Date().toISOString();
    const ball = q === 'followed' || q === 'them' || q === 'chased' || q === 'reached' ? 'them' : 'us';
    const touch = ['followed', 'chased', 'reached'].includes(q);
    if (await patchBall(i, ball, now, touch, q === 'reached')) {
      const nx = i.met && i.person ? nextSender({ ...i.person, ...touchFields(i.person, true, now) }) : '';
      toast(q === 'reached' ? `${i.name} → New Relationship. ${i.leadOwner || 'The owner'} keeps it until the first meeting.` : touch && nx ? `Logged. Next follow-up is ${nx}'s.` : { followed: 'Logged. Ball is with them.', chased: 'Chase logged. Clock restarted.', replied: 'Ball is with us now.', us: 'Marked our move.', them: 'Marked their move.' }[q]);
      await reload();
    } else b.disabled = false;
  });
  $$('[data-brief]', root).forEach(b => b.onclick = e => { e.stopPropagation(); const i = find(b.dataset.brief); if (i?.person) briefModal(i.person, i.kind === 'deal' ? i.row : null, reload); });
  $$('[data-react]', root).forEach(b => b.onclick = async () => {
    const [kind, id] = b.dataset.react.split(':');
    const r = await sb.from(kind === 'deal' ? 'opportunities' : 'people').update({ pipeline_active: true, updated_at: new Date().toISOString() }).eq('id', id);
    if (!fail(r, 'Reactivate')) { toast('Back on the board'); await reload(); }
  });
  $$('[data-lead]', root).forEach(b => b.onclick = async () => {
    const [act, id] = b.dataset.lead.split(':'), l = D.leads.find(x => x.id === id); if (!l) return; b.disabled = true;
    const ok = act === 'no' ? await rejectLead(l) : await promoteLead(l, act === 'buy' ? 'Buy Side' : act === 'both' ? 'Both' : 'Sell Side');
    if (ok) await reload(); else b.disabled = false;
  });
}

// ---- Writes ----
const nowIso = () => new Date().toISOString();
// touch = a message went out (counts in the rotation); reached = the first message to a To Reach Out target.
async function patchBall(i, ball, now = nowIso(), touch = false, reached = false) {
  const f = { waiting_on: ball, waiting_on_since: now, updated_at: now };
  const pf = { ...f, ...(touch && i.person ? touchFields(i.person, i.met, now) : {}), ...(reached ? { pipeline_stage: 'New Relationship' } : {}) };
  if (i.kind === 'deal') {
    if (fail(await sb.from('opportunities').update(reached ? { ...f, pipeline_stage: 'New Relationship', stage: 'New Relationship' } : f).eq('id', i.id), 'Update')) return false;
    if (i.person && i.row.person_id) await sb.from('people').update(pf).eq('id', i.row.person_id); // keep the old board's person row in step
    await logActivity(i.id, reached ? 'First message sent' : ball === 'them' ? `Followed up${touch && pf.last_touch_by ? ' (' + pf.last_touch_by + ')' : ''}, waiting on them` : 'Reply received, our move');
  } else if (fail(await sb.from('people').update(pf).eq('id', i.id), 'Update')) return false;
  return true;
}
async function logActivity(oppId, action) { await sb.from('activity').insert({ opportunity_id: oppId, action, actor_id: state.user?.id || null }); }

// The lead keeps talking to whoever answers that inbox; no known account = the least-loaded person in the rotation.
async function ownerFor(l) { return responderFor(l.source_account) || await pickOwner(); }
// First meeting happened when a person reaches MET_FROM or beyond: stamp met_at once, which starts the rotation.
// Moving back before it clears the stamp (it was a mis-click), so the lead goes back to its one owner.
const metPatch = (side, stage, p) => { const after = stageIdx(side, stage) >= stagesFor(side).indexOf(MET_FROM); return !p?.met_at && after ? { met_at: nowIso() } : p?.met_at && !after ? { met_at: null } : {}; };
async function promoteLead(l, sd) {
  const owner = await ownerFor(l);
  const now = nowIso(), key = slug(l.linkedin_url), lname = String(l.name || '').trim().toLowerCase();
  let p = D.people.find(x => (key && slug(x.linkedin_url) === key) || (lname && x.name.trim().toLowerCase() === lname));
  if (!p) {
    const r = await sb.from('people').insert({
      name: l.name || 'Unknown', relationship_type: relType(sd), primary_side: sd, pipeline_stage: 'New Relationship', pipeline_active: true,
      waiting_on: 'us', waiting_on_since: l.created_at, linkedin_url: l.linkedin_url, has_linkedin: !!l.linkedin_url, company_name: l.company_name, headline: l.headline, sell_side_kind: l.sell_side_kind || 'multi_deal', source: 'LinkedIn',
      source_campaign: l.campaign_name, source_account: l.source_account, owner_name: owner, qualification_confidence: l.confidence, qualification_reason: l.reason, last_inbound_message: l.reply_text, created_by: state.user?.id,
    }).select().single();
    if (fail(r, 'Add lead')) return false; p = r.data;
  } else if (p.pipeline_active === false || p.pipeline_stage === REACH) await sb.from('people').update({ pipeline_active: true, waiting_on: 'us', waiting_on_since: l.created_at, updated_at: now, ...(p.pipeline_stage === REACH ? { pipeline_stage: 'New Relationship' } : {}) }).eq('id', p.id);
  const t = await sb.from('tasks').insert({ person_id: p.id, action: l.suggested_next_step || 'Reply and qualify', owner_name: teamName(p.owner_name) || owner, due_date: todayIso(), created_by: state.user?.id });
  if (fail(t, 'Add task')) return false;
  const u = { person_id: p.id, reviewed_at: now, reviewed_by: state.user?.id };
  if (l.decision === 'needs_review' && sd !== 'Both') u.decision = sd === 'Buy Side' ? 'qualified_buy_side' : 'qualified_sell_side';
  if (fail(await sb.from('lead_intake').update(u).in('id', l.ids || [l.id]), 'Update lead')) return false;
  toast(`${l.name || 'Lead'} added${sd === 'Both' ? ' as sell + buy side' : ` to the ${sd.toLowerCase()} pipeline`}`); return true;
}
async function rejectLead(l) {
  if (fail(await sb.from('lead_intake').update({ decision: 'not_qualified', reviewed_at: nowIso(), reviewed_by: state.user?.id }).in('id', l.ids || [l.id]), 'Update lead')) return false;
  toast('Marked not a fit'); return true;
}

// One click forward. The update window still lets you set any stage (or go back).
const advance = i => setStage(i, nextStage(i));
async function setStage(i, nx) {
  if (!nx || nx === i.stage) return false;
  const now = nowIso();
  if (i.kind === 'deal') {
    if (fail(await sb.from('opportunities').update({ pipeline_stage: nx, stage: nx, updated_at: now }).eq('id', i.id), 'Move')) return false;
    await logActivity(i.id, `Stage: ${i.stage || '—'} → ${nx}`);
    const mp = metPatch(i.side, nx, i.person); if (i.person && mp.met_at) await sb.from('people').update(mp).eq('id', i.person.id);
  } else if (fail(await sb.from('people').update({ pipeline_stage: nx, updated_at: now, ...metPatch(i.side, nx, i.person) }).eq('id', i.id), 'Move')) return false;
  toast(metPatch(i.side, nx, i.person).met_at ? `${i.name} → ${nx}. Follow-ups now rotate ${ROTATION.join(' → ')}.` : `${i.name} → ${nx}`);
  lastMove = { key: `${i.kind}:${i.id}`, from: i.stage || 'New Relationship', name: i.name };
  return true;
}

// Everything they've sent us: every reply the LinkedIn tool logged (full text), plus any thread saved with the HQ extension.
async function dmModal({ name, url, personId, leadId, fallback }) {
  const s = slug(url);
  const { el } = modal({ title: name || 'Messages', submit: '', wide: true, body: '<div class="empty">Loading messages…</div>' });
  const ors = [s && `linkedin_url.ilike.%${s}%`, personId && `person_id.eq.${personId}`, leadId && `id.eq.${leadId}`].filter(Boolean).join(',');
  const [li, cv] = await Promise.all([
    ors ? sb.from('lead_intake').select('id,reply_text,created_at,campaign_name,source_account,reason,confidence,headline,company_name,raw_payload,linkedin_url').or(ors).order('created_at', { ascending: true }).limit(50) : { data: [] },
    s ? sb.from('dm_conversations').select('*').ilike('prospect_url', `%${s}%`).order('captured_at', { ascending: false }).limit(3) : { data: [] },
  ]);
  const rows = (li.data || []).filter((r, idx, a) => a.findIndex(x => (x.reply_text || '') === (r.reply_text || '')) === idx);
  const acct = u => { const a = D?.accts.find(x => slug(x.linkedin_url) === slug(u)); return a ? a.owner_name : ''; };
  const prof = rows.map(r => r.raw_payload?.eventData?.profileInfo).find(Boolean) || {};
  const bubble = (who, at, text, mine) => `<div class="pMsg ${mine ? 'me' : ''}"><div class="pMsgMeta">${esc(who)}${at ? ' · ' + esc(at) : ''}</div><div class="pMsgText">${esc(text)}</div></div>`;
  const threads = (cv.data || []).map(c => `<div class="dmBlock"><h4>Full thread saved from LinkedIn${c.account_name ? ' · ' + esc(c.account_name) : ''} <span class="muted s">${fmtDate(c.captured_at)}</span></h4>
    <div class="dmThread">${(c.messages || []).map(m => bubble(m.from === 'us' ? (c.account_name || 'Us') : (m.name || name), m.at, m.text, m.from === 'us')).join('')}</div></div>`).join('');
  const replies = rows.length ? `<div class="dmBlock"><h4>Their replies <span class="muted s">${rows.length} logged by the outreach tool</span></h4>
    <div class="dmThread">${rows.map(r => bubble(name || 'Them', `${new Date(r.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${r.source_account ? ' · to ' + (acct(r.source_account) || 'our account') : ''}${r.campaign_name ? ' · ' + r.campaign_name : ''}`, String(r.reply_text || '').replace(/^A lead has replied\s*/i, '').replace(/^\s*Re:\s*/i, ''), false)).join('')}</div>
    ${rows.at(-1)?.reason ? `<p class="s muted" style="margin:10px 0 0"><b>Why it was qualified:</b> ${esc(rows.at(-1).reason)}${rows.at(-1).confidence != null ? ` (${Math.round(rows.at(-1).confidence * 100)}%)` : ''}</p>` : ''}</div>`
    : fallback ? `<div class="dmBlock"><h4>Last message</h4><div class="dmThread">${bubble(name || 'Them', '', fallback, false)}</div></div>` : '';
  const about = [prof.jobTitle && prof.company ? `${prof.jobTitle}, ${prof.company}` : prof.headline, prof.email, prof.websiteUrl].filter(Boolean);
  $('.body', el).innerHTML = `<div class="dmHead">${about.length ? `<div class="s muted">${about.map(esc).join(' · ')}</div>` : ''}
      <div class="row">${url ? `<a class="btn sm primary" href="${esc(url)}" target="_blank" rel="noopener">Open their LinkedIn ↗</a>` : ''}<button type="button" class="btn sm" id="dmTeaser">Make a teaser from this</button></div></div>
    ${threads}${replies || '<div class="empty">No messages logged for this person yet.</div>'}
    ${threads ? '' : '<p class="s muted" style="margin:12px 0 0">Our side of the conversation is not logged by the outreach tool. Save the chat with the HQ button in LinkedIn (browser extension) to see the full two-way thread here.</p>'}`;
  $('#dmTeaser', el).onclick = () => {
    const conv = (cv.data || [])[0];
    const text = conv?.messages?.length ? conv.messages.map(m => `${m.from === 'us' ? (conv.account_name || 'Us') : (m.name || name || 'Them')}: ${m.text}`).join('\n\n')
      : rows.length ? rows.map(r => `${name || 'Them'}: ${String(r.reply_text || '').replace(/^A lead has replied\s*(Re:)?\s*/i, '')}`).join('\n\n') : (fallback || '');
    $('[data-x]', el).click();
    setTimeout(() => teaserModal({ lead_intake_id: leadId || '', person_id: personId || '', lead_name: name, lead_company: rows.at(-1)?.company_name || '', linkedin_url: url || '', text }), 50);
  };
}

// ---- Modals ----
// Will they pay? (13 Nov 2026) Demonstrated willingness from what they said or did, never a guess. Feeds the "who paid, who
// didn't, why" learning: the score per signal source tells us which lists produce paying clients.
const PAY = [['', '— not discussed yet —'], ['0', '0 · Unknown'], ['1', '1 · No, or free intros only'], ['2', '2 · Interested, resists upfront fees'],
  ['3', '3 · Open to a paid scope'], ['4', '4 · Discussing budget, terms or a pilot'], ['5', '5 · Signed and paid']];
function updateModal(i) {
  const st = stagesFor(i.side), open = i.tasks;
  const who = state.user?.email ? firstName(state.user.email.split('@')[0]) : '';
  modal({
    title: i.name, submit: 'Save', wide: false,
    body: `<div class="form pForm">
      <p class="muted s" style="grid-column:1/-1;margin:0">${esc(i.sub || '')} ${i.kind === 'deal' ? '· Deal' : '· Relationship'} · ${i.side}</p>
      ${i.kind === 'rel' ? `<label class="field">Side<select class="select" name="side">${opts([['Sell Side', 'Sell side'], ['Buy Side', 'Buy side'], ['Both', 'Both']], i.side)}</select></label>` : ''}
      <label class="field">Stage<select class="select" name="stage">${opts(st, st.includes(i.stage) ? i.stage : st[0])}</select></label>
      <label class="field">Who is next<select class="select" name="ball">${opts([['us', 'Us (we owe a move)'], ['them', 'Them (we are waiting)'], ['', 'Nobody yet']], i.ball || '')}</select></label>
      ${i.person && 'owner_name' in i.person ? `<label class="field">Lead owner<select class="select" name="lowner">${opts([['', '— none —'], ...['Tengku', 'Anaz', 'Chase', 'Peter', 'Razeen'].map(n => [n, n])], teamName(i.person.owner_name) || i.person.owner_name || '')}</select></label>
      <p class="muted s" style="margin:0;align-self:end">${i.met ? `Met. Follow-ups rotate ${ROTATION.join(' → ')}; next is <b>${esc(i.nextBy)}</b>.` : 'Talks to this one person until the first meeting.'}</p>` : ''}
      ${i.person ? `<div style="grid-column:1/-1">${briefLine(i.person, true)}</div>
      <label class="field">Will they pay?<select class="select" name="pay">${opts(PAY, i.person.pay_score == null ? '' : String(i.person.pay_score))}</select></label>
      <label class="field">What they said about fees<input class="input" name="paynote" value="${esc(i.person.pay_note || '')}" placeholder="e.g. only success fee, asked for terms"></label>` : ''}
      ${open.length ? `<div class="field" style="grid-column:1/-1">Open tasks, tick what is done<div class="pTasks">${open.map(t => `<label><input type="checkbox" name="done" value="${t.id}"> <span>${esc(t.action)}</span><em class="muted s">${t.owner_name ? esc(firstName(t.owner_name)) : ''}${t.due_date ? ' · ' + fmtDate(t.due_date) : ''}${t.due_date && t.due_date < todayIso() ? ' · overdue' : ''}</em></label>`).join('')}</div></div>` : ''}
      <label class="field" style="grid-column:1/-1">Add the next step<input class="input" name="next" placeholder="${open.length ? 'Another step (optional)' : 'What is the next move?'}"></label>
      <label class="field">Owner<input class="input" name="owner" value="${esc(i.owner || who)}"></label>
      <label class="field">Due<input class="input" type="date" name="due"></label>
      <label class="row s" style="grid-column:1/-1"><input type="checkbox" name="park"> Take this off the board (park it)</label></div>`,
    async onSubmit(fd) {
      const now = nowIso(), ball = fd.get('ball') || null, stage = fd.get('stage'), next = String(fd.get('next') || '').trim();
      const done = fd.getAll('done'), park = fd.get('park') === 'on';
      const base = { updated_at: now }, ballChanged = (ball || null) !== (i.ball || null);
      const pExtra = { ...(fd.has('lowner') && (fd.get('lowner') || null) !== (i.person?.owner_name || null) ? { owner_name: fd.get('lowner') || null } : {}), ...metPatch(i.side, stage, i.person) };
      if (fd.has('pay')) {
        const pay = fd.get('pay') === '' ? null : +fd.get('pay'), note = String(fd.get('paynote') || '').trim() || null;
        if (pay !== (i.person?.pay_score ?? null)) Object.assign(pExtra, { pay_score: pay, pay_at: now });
        if (note !== (i.person?.pay_note || null)) pExtra.pay_note = note;
      }
      if (ballChanged) { base.waiting_on = ball; base.waiting_on_since = now; }
      if (park) base.pipeline_active = false;
      for (const id of done) if (fail(await sb.from('tasks').update({ completed: true, updated_at: now }).eq('id', id), 'Complete task')) return false;
      if (next) {
        const t = await sb.from('tasks').insert({ person_id: i.person?.id || null, opportunity_id: i.kind === 'deal' ? i.id : null, action: next, owner_name: String(fd.get('owner') || '').trim() || null, due_date: fd.get('due') || null, created_by: state.user?.id });
        if (fail(t, 'Add next step')) return false;
      }
      if (i.kind === 'deal') {
        const f = { ...base, pipeline_stage: stage, stage };
        if (next) { f.next_step = next; f.next_step_owner = String(fd.get('owner') || '').trim() || null; f.due_date = fd.get('due') || null; }
        if (fail(await sb.from('opportunities').update(f).eq('id', i.id), 'Save')) return false;
        if (i.row.person_id && (ballChanged || Object.keys(pExtra).length)) await sb.from('people').update({ ...(ballChanged ? { waiting_on: ball, waiting_on_since: now } : {}), ...pExtra, updated_at: now }).eq('id', i.row.person_id);
        if (stage !== i.stage) await logActivity(i.id, `Stage: ${i.stage || '—'} → ${stage}`);
        else if (ballChanged) await logActivity(i.id, ball === 'them' ? 'Waiting on them' : ball === 'us' ? 'Our move' : 'Ball cleared');
      } else if (fail(await sb.from('people').update({ ...base, ...pExtra, pipeline_stage: stage, primary_side: fd.get('side') || i.side, relationship_type: fd.get('side') && fd.get('side') !== i.side ? relType(fd.get('side')) : i.row.relationship_type }).eq('id', i.id), 'Save')) return false;
      toast('Saved'); reload();
    },
  });
  const f = $('.modal'), sd = $('[name=side]', f), stg = $('[name=stage]', f);
  $('[data-openbrief]', f)?.addEventListener('click', () => { $('[data-x]', f).click(); briefModal(i.person, i.kind === 'deal' ? i.row : null, reload); });
  if (sd) sd.onchange = () => { const l = stagesFor(sd.value); stg.innerHTML = opts(l, l.includes(stg.value) ? stg.value : l[0]); };
}

function addPersonModal() {
  modal({
    title: 'Add person', submit: 'Add to pipeline',
    body: `<div class="form pForm"><label class="field">Name<input class="input" name="name" required></label>
      <label class="field">Side<select class="select" name="side">${opts([['Sell Side', 'Sell side'], ['Buy Side', 'Buy side'], ['Both', 'Both (e.g. an IB with family offices)']])}</select></label>
      <label class="field">Company or type<input class="input" name="co" placeholder="Family office, developer…"></label>
      <label class="field">LinkedIn URL<input class="input" name="li"></label>
      <label class="field" style="grid-column:1/-1">Next step<input class="input" name="next" placeholder="Reply and qualify"></label>
      <label class="field">Stage<select class="select" name="stage">${opts([[REACH, 'To reach out (not contacted yet)'], ['New Relationship', 'New relationship (we are talking)']], 'New Relationship')}</select></label>
      <label class="field">Owner<select class="select" name="owner">${opts([['', 'Round robin'], ...['Tengku', 'Anaz', 'Chase', 'Peter', 'Razeen'].map(n => [n, n])], meName())}</select></label>
      <label class="field">Who is next<select class="select" name="ball">${opts([['us', 'Us'], ['them', 'Them']])}</select></label></div>`,
    async onSubmit(fd) {
      const now = nowIso(), sd = fd.get('side'), owner = fd.get('owner') || await pickOwner();
      const r = await sb.from('people').insert({ name: String(fd.get('name')).trim(), primary_side: sd, relationship_type: relType(sd), company_name: fd.get('co') || null, linkedin_url: fd.get('li') || null, has_linkedin: !!fd.get('li'), pipeline_stage: fd.get('stage') || 'New Relationship', owner_name: owner, pipeline_active: true, waiting_on: fd.get('ball'), waiting_on_since: now, created_by: state.user?.id }).select().single();
      if (fail(r, 'Add person')) return false;
      if (fd.get('next')) await sb.from('tasks').insert({ person_id: r.data.id, action: String(fd.get('next')).trim(), owner_name: owner, due_date: todayIso(), created_by: state.user?.id });
      toast('Added'); reload();
    },
  });
}
function addDealModal() {
  const people = D.people.filter(p => p.pipeline_active !== false).sort((a, b) => a.name.localeCompare(b.name));
  modal({
    title: 'Add deal', submit: 'Add to pipeline',
    body: `<div class="form pForm"><label class="field" style="grid-column:1/-1">Deal name<input class="input" name="title" required></label>
      <label class="field">Side<select class="select" name="side">${opts(['Sell Side', 'Buy Side'])}</select></label>
      <label class="field">Stage<select class="select" name="stage">${opts(SELL, 'Opportunity Received')}</select></label>
      <label class="field">Contact<select class="select" name="person">${opts([['', '— none —'], ...people.map(p => [p.id, p.name])])}</select></label>
      <label class="field">Raise / deal size (USD)<input class="input" name="raise" inputmode="decimal" placeholder="25,000,000"></label>
      <label class="field">Owner<input class="input" name="owner" value="${esc(firstName((state.user?.email || '').split('@')[0]))}"></label>
      <label class="field">Who is next<select class="select" name="ball">${opts([['us', 'Us'], ['them', 'Them']])}</select></label>
      <label class="field" style="grid-column:1/-1">Next step<input class="input" name="next"></label>
      <label class="field">Due<input class="input" type="date" name="due"></label></div>`,
    async onSubmit(fd, form) {
      const now = nowIso(), stage = fd.get('stage'), raise = num(fd.get('raise'));
      const r = await sb.from('opportunities').insert({ title: String(fd.get('title')).trim(), side: fd.get('side'), stage, pipeline_stage: stage, pipeline_active: true, person_id: fd.get('person') || null, owner_name: String(fd.get('owner') || '').trim() || null, waiting_on: fd.get('ball'), waiting_on_since: now, next_step: fd.get('next') || null, next_step_owner: String(fd.get('owner') || '').trim() || null, due_date: fd.get('due') || null, revenue_raise_amount: raise || null, opportunity_size: raise ? money(raise) : null, created_by: state.user?.id }).select().single();
      if (fail(r, 'Add deal')) return false;
      if (fd.get('next')) await sb.from('tasks').insert({ person_id: fd.get('person') || null, opportunity_id: r.data.id, action: String(fd.get('next')).trim(), owner_name: String(fd.get('owner') || '').trim() || null, due_date: fd.get('due') || null, created_by: state.user?.id });
      await logActivity(r.data.id, 'Created in HQ');
      toast('Added'); D = null; loadedAt = 0; refreshPipelineBadge();
    },
  });
  // Stage list follows the side.
  const f = $('.modal'), sd = $('[name=side]', f), stg = $('[name=stage]', f);
  sd.onchange = () => { const l = stagesFor(sd.value); stg.innerHTML = opts(l, sd.value === 'Buy Side' ? 'Relevant Deal Identified' : 'Opportunity Received'); };
}

// Overview card: the people who replied to outreach and are still waiting on us, hottest first.
let rqHtml = '';
export async function renderReplyQueue(el) {
  if (rqHtml && !el.innerHTML) el.innerHTML = rqHtml;
  const r = await sb.from('lead_intake').select('id,name,headline,company_name,reply_text,decision,created_at,source_account,linkedin_url').is('person_id', null).is('reviewed_at', null).neq('decision', 'not_qualified').order('created_at', { ascending: false }).limit(300);
  if (r.error || !el.isConnected) return;
  const seen = new Set(), list = (r.data || []).filter(l => { const k = slug(l.linkedin_url) || l.id; if (seen.has(k)) return false; seen.add(k); return true; })
    .map(l => ({ l, h: leadHeat(l) })).filter(x => x.h.score >= 0).sort((a, b) => b.h.score - a.h.score || String(b.l.created_at).localeCompare(String(a.l.created_at)));
  const hot = list.filter(x => x.h.label === 'Wants to talk').length, acct = u => { const s = slug(u); return s.startsWith('peter') ? 'Peter' : s.startsWith('chase') ? 'Chase' : s.startsWith('tengku') ? 'Tengku' : s ? s.split('-')[0] : '—'; };
  el.innerHTML = `<section class="card rqCard"><header><div><h2>Waiting on our reply</h2><p>${list.length} people answered our outreach and haven't heard back${hot ? ` · <b class="rqHot">${hot} asked for a call</b>` : ''}. Hottest first.</p></div><a class="btn sm primary" href="#/pipeline/leads">Work them in Pipeline →</a></header>
    ${list.length ? `<ul class="rqList">${list.slice(0, 8).map(({ l, h }) => `<li><span class="rqName">${l.linkedin_url ? `<a href="${esc(l.linkedin_url)}" target="_blank" rel="noopener">${esc(l.name || 'Unknown')} ↗</a>` : esc(l.name || 'Unknown')}<small>${esc(l.company_name || l.headline || '')}</small></span>
      <span class="rqWhy">${h.label ? `<b class="pFlag ${h.tone}">${h.label}</b>` : ''}<span>“${esc(String(l.reply_text || '').replace(/^A lead has replied\s*(Re:)?\s*/i, '').slice(0, 90))}…”</span></span>
      <span class="rqMeta">${esc(acct(l.source_account))}'s account<b class="${daysSince(l.created_at) >= 7 ? 'bad' : ''}">${daysSince(l.created_at)}d waiting</b></span></li>`).join('')}</ul>${list.length > 8 ? `<div class="rqMore"><a href="#/pipeline/leads">+ ${list.length - 8} more in Pipeline → LinkedIn leads</a></div>` : ''}` : '<div class="empty">Nobody is waiting on a reply.</div>'}</section>`;
  rqHtml = el.innerHTML;
}
