// Daily 3 (Today page, admin only): the three numbers that move retainers, volume first.
// 1. Credit targets worked: BDC / SEC credit / UCC rows added to the pipeline today (people.source), split by task owner.
// 2. Reply queue: outreach replies nobody has answered or reviewed (target 0), plus how many were cleared today.
// 3. Calls booked today (growth_meetings).
// Quotas are team-wide and live here; change the numbers below.
import { sb, esc, $$, avatar, acIdx } from './core.js';
import { sendBatchModal, outreachSetup } from './outreach.js';
import { linkedHelperModal } from './linkedhelper.js';

export const DAILY3 = { contact: 20, calls: 1 };
const SIGNAL_SOURCES = ['BDC loan signal', 'SEC credit signal', 'UCC signal'];

// Ops day starts 2 AM Malaysia time (same as Today).
const dayStartIso = date => new Date(`${date}T02:00:00+08:00`).toISOString();
const head = q => q.then(r => (r.error ? null : r.count ?? 0), () => null);

export async function renderDaily3(el, date) {
  if (!el) return;
  const since = dayStartIso(date);
  const [added, queue, cleared, calls, bdcLeft, creditLeft] = await Promise.all([
    sb.from('people').select('id,source').in('source', SIGNAL_SOURCES).gte('created_at', since).then(r => r.data || [], () => []),
    head(sb.from('lead_intake').select('id', { count: 'exact', head: true }).is('person_id', null).is('reviewed_at', null).neq('decision', 'not_qualified')),
    head(sb.from('lead_intake').select('id', { count: 'exact', head: true }).gte('reviewed_at', since)),
    head(sb.from('growth_meetings').select('id', { count: 'exact', head: true }).gte('created_at', since)),
    head(sb.from('bdc_signals').select('id', { count: 'exact', head: true }).eq('verdict', 'target').eq('lane', 'refi').eq('status', 'new')),
    head(sb.from('credit_signals').select('id', { count: 'exact', head: true }).eq('verdict', 'target').eq('status', 'new')),
  ]);
  let owners = {};
  if (added.length) {
    const t = await sb.from('tasks').select('person_id,owner_name').in('person_id', added.map(p => p.id));
    for (const r of t.data || []) { const o = r.owner_name || 'Unassigned'; owners[o] = (owners[o] || 0) + 1; }
  }
  if (!el.isConnected) return;

  const worked = added.length, left = (bdcLeft ?? 0) + (creditLeft ?? 0);
  const days = left ? Math.ceil(left / DAILY3.contact) : 0;
  const row = (n, label, value, goal, pctDone, sub, href, cta, ok) => `
    <li class="d3Row${ok ? ' ok' : ''}">
      <span class="d3N">${n}</span>
      <div class="d3Body">
        <div class="d3Top"><b>${esc(label)}</b><span class="d3Val">${value}<em>${goal}</em></span></div>
        <span class="d3Bar"><i style="width:${Math.min(100, Math.round(pctDone))}%"></i></span>
        <small>${sub}</small>
      </div>
      <a class="btn sm${ok ? '' : ' primary'}" href="${href}">${esc(cta)}</a>
    </li>`;

  const ownerChips = Object.entries(owners).sort((a, b) => b[1] - a[1]).map(([o, c]) => `<span class="d3Who" data-ac="${acIdx(o)}">${avatar(o, 'xs')}${esc(o)} ${c}</span>`).join('');
  const qTotal = (queue ?? 0) + (cleared ?? 0);
  el.innerHTML = `<section class="card d3Card"><header><div><h2>Daily 3</h2><p>Volume first. Hit these before anything else today.</p></div><div class="row" style="gap:6px"><button type="button" class="btn sm ghost" id="d3Setup">Outreach setup</button><button type="button" class="btn sm" id="d3Lh">Export for Linked Helper</button><button type="button" class="btn sm primary" id="d3Send">Send today's batch</button></div></header>
    <ol class="d3List">
      ${row(1, 'Credit targets worked', worked, ` / ${DAILY3.contact}`, worked / DAILY3.contact * 100,
        `${ownerChips || 'Nobody yet today.'} <span class="muted">${left.toLocaleString('en-US')} BDC + credit targets untouched${days ? ` · ${days} days at ${DAILY3.contact}/day` : ''}</span>`,
        '#/pipeline/bdc', 'BDC loans →', worked >= DAILY3.contact)}
      ${row(2, 'Reply queue to zero', queue ?? '—', ' waiting', qTotal ? (cleared ?? 0) / qTotal * 100 : 100,
        `${cleared ?? 0} cleared today`, '#/pipeline/leads', 'Work replies →', queue === 0)}
      ${row(3, 'Calls booked', calls ?? 0, ` / ${DAILY3.calls}`, (calls ?? 0) / DAILY3.calls * 100,
        'Log every booked call with "Meeting booked" so it counts.', '#/pipeline/leads', 'Hot leads →', (calls ?? 0) >= DAILY3.calls)}
    </ol></section>`;
  $$('a', el).forEach(a => a.addEventListener('click', e => e.stopPropagation()));
  el.querySelector('#d3Send')?.addEventListener('click', () => sendBatchModal(() => renderDaily3(el, date)));
  el.querySelector('#d3Setup')?.addEventListener('click', outreachSetup);
  el.querySelector('#d3Lh')?.addEventListener('click', () => linkedHelperModal());
}
