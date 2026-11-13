// Export for Linked Helper (14 Nov 2026, Tengku). HQ finds and filters targets; this hands their LinkedIn URLs to Linked Helper.
// Pick a lane and whose account sends it (any name, nothing fixed), tick the rows, download a CSV per version (A / B).
// Linked Helper's own "LH CSV" is checksum-locked (an edited or added column = file rejected), so we hand over plain profile URLs.
// Every exported company is logged in lh_exports (never exported twice, also skipped if Prosp already has it);
// the results import (later) matches Linked Helper's export back on linkedin_url to score A vs B.
import { sb, esc, $, $$, toast, modal, state } from './core.js';
import { loadContacts, contactOf, cfoChanged } from './contacts.js';
import { cleanName, deadlineOf } from './outreach.js';

const LANES = { credit: 'Private credit (refinancing)', rescue: 'Rescue (distressed)', funds: 'Funds (GPs)' };
const SENDER_DEFAULT = { credit: 'Tengku', rescue: 'Tengku', funds: 'Anaz' };   // only the first suggestion; any name works
const TEAM = ['Tengku', 'Peter', 'Chase', 'Anaz', 'Razeen', 'Sara', 'Dev', 'Sahid', 'Reza'];
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

// A person we can message on LinkedIn: has a profile, isn't marked wrong, hasn't left, isn't the PE owner.
const liPerson = (kind, key) => (contactOf(kind, key)?.people || []).find(p => p.linkedin && p.status !== 'wrong' && !p.left && p.role !== 'sponsor') || null;

async function rowsFor(lane) {
  const [ex, en] = await Promise.all([sb.from('lh_exports').select('kind,key'), sb.from('outreach_enrollments').select('kind,key')]);
  const done = new Set([...(ex.data || []), ...(en.data || [])].map(e => `${e.kind}:${e.key}`));
  const out = [];
  const add = (kind, key, s, score) => { if (done.has(`${kind}:${key}`)) return; const p = liPerson(kind, key); if (p) out.push({ kind, key, s, p, score, hook: kind === 'fund' ? null : deadlineOf(kind, s) }); };
  if (lane === 'funds') {
    await loadContacts('fund', true);
    const r = await sb.from('fund_signals').select('id,fund_key,company_name,score,list').eq('verdict', 'target').eq('status', 'new').order('score', { ascending: false }).limit(3000);
    const best = new Map(); for (const s of r.data || []) { const k = s.fund_key || String(s.id); if (!best.has(k)) best.set(k, s); }
    for (const [k, s] of best) add('fund', k, s, s.score);
  } else {
    await Promise.all([loadContacts('credit', true), loadContacts('bdc', true)]);
    const cr = await sb.from('credit_signals').select('*').eq('verdict', lane === 'rescue' ? 'rescue' : 'target').eq('status', 'new').limit(2000);
    for (const s of cr.data || []) { const k = String(Number(s.cik)); add('credit', k, s, s.score + (cfoChanged(k) ? 10 : 0)); }   // new CFO first
    if (lane === 'credit') {
      const bd = await sb.from('bdc_signals').select('*').eq('verdict', 'target').eq('lane', 'refi').eq('status', 'new').not('owner_checked_at', 'is', null).neq('rules_version', 0).limit(2000);
      for (const s of bd.data || []) add('bdc', s.company_key, s, s.score);
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

const csvCell = v => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
export function toCsv(list, withVars) {
  const head = withVars ? ['profile_url', 'first_name', 'last_name', 'company', 'title', 'hook'] : ['profile_url'];
  const line = x => { const [first, ...rest] = String(x.p.name || '').trim().split(/\s+/);
    return (withVars ? [x.p.linkedin, first, rest.join(' '), cleanName(x.s.company_name), x.p.title || '', x.hook || ''] : [x.p.linkedin]).map(csvCell).join(','); };
  return [head.join(','), ...list.map(line)].join('\n') + '\n';
}
function download(name, text) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export async function linkedHelperModal(onDone) {
  let lane = store.get('hq-lh-lane') || 'credit', list = [];
  const sender = () => store.get(`hq-lh-sender-${lane}`) || SENDER_DEFAULT[lane];
  const { el } = modal({
    title: 'Export for Linked Helper', submit: 'Download', wide: true,
    body: `<div class="form pForm">
      <label class="field">Lane<select class="select" name="lane">${Object.entries(LANES).map(([k, l]) => `<option value="${k}" ${k === lane ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field">Sent from (whose LinkedIn)<input class="input" name="sender" list="lhTeam" value="${esc(sender())}" required><datalist id="lhTeam">${TEAM.map(n => `<option value="${n}">`).join('')}</datalist></label>
      <label class="field">How many<input class="input" name="n" type="number" min="1" max="500" value="${store.get('hq-lh-n') || 50}"></label>
      <label class="field"><span><input type="checkbox" name="ab" ${store.get('hq-lh-ab') === '0' ? '' : 'checked'}> Split into A and B (two files, one per campaign)</span></label>
      <label class="field" style="grid-column:1/-1"><span><input type="checkbox" name="vars" ${store.get('hq-lh-vars') === '1' ? 'checked' : ''}> Add first name, company and hook columns (only with Linked Helper's custom-variables plug-in)</span></label>
      <div id="lhList" style="grid-column:1/-1"><div class="empty">Loading…</div></div></div>`,
    async onSubmit(fd) {
      const picked = fd.getAll('pick').map(Number).map(i => list[i]).filter(Boolean);
      const who = String(fd.get('sender') || '').trim();
      if (!picked.length || !who) { toast(who ? 'Nothing ticked' : 'Say whose account sends it'); return false; }
      const ab = !!fd.get('ab'), vars = !!fd.get('vars'), batch = crypto.randomUUID();
      picked.forEach((x, i) => x.v = ab && i % 2 ? 'B' : 'A');   // alternate down the score order, so A and B get the same quality
      const r = await sb.from('lh_exports').insert(picked.map(x => ({ kind: x.kind, key: x.key, lane, company_name: x.s.company_name, person_name: x.p.name, title: x.p.title || null,
        linkedin_url: x.p.linkedin, hook: x.hook, sender: who, version: x.v, batch_id: batch, exported_by: state.user?.email || null })));
      if (r.error) { toast(r.error.message); return false; }
      const day = new Date().toISOString().slice(0, 10), tag = `${lane}-${who.toLowerCase()}-${day}`;
      for (const v of ab ? ['A', 'B'] : ['A']) download(`lh-${tag}${ab ? '-' + v : ''}.csv`, toCsv(picked.filter(x => x.v === v), vars));
      store.set(`hq-lh-sender-${lane}`, who); store.set('hq-lh-ab', ab ? '1' : '0'); store.set('hq-lh-vars', vars ? '1' : '0');
      toast(`${picked.length} exported${ab ? ` (${picked.filter(x => x.v === 'A').length} A, ${picked.filter(x => x.v === 'B').length} B)` : ''}. In Linked Helper: open the campaign → Add → upload the file.`);
      onDone?.();
    },
  });
  const box = $('#lhList', el), nIn = $('[name=n]', el), btn = $('button[type=submit]', el);
  const recount = () => { const n = $$('[name=pick]:checked', el).length; btn.textContent = n ? `Download ${n}` : 'Nothing ticked'; btn.disabled = !n; };
  const draw = () => {
    const n = Math.max(1, Number(nIn.value) || 50);
    box.innerHTML = list.length ? `<p class="s muted" style="margin:0 0 8px">${list.length} ready with a LinkedIn profile (not exported before, not in Prosp). Best score first. Untick anyone who looks wrong.</p>
      <table class="tbl obTbl"><thead><tr><th></th><th>Company</th><th>Person</th><th>Hook</th><th>LinkedIn</th></tr></thead><tbody>
      ${list.map((x, i) => `<tr><td><input type="checkbox" name="pick" value="${i}" ${i < n ? 'checked' : ''} aria-label="Export ${esc(x.s.company_name)}"></td>
        <td><b>${esc(cleanName(x.s.company_name))}</b><br><span class="s muted">${x.kind === 'bdc' ? 'BDC' : x.kind === 'fund' ? 'Fund' : 'Public'} · score ${x.s.score}</span></td>
        <td>${esc(x.p.name)}<br><span class="s muted">${esc(x.p.title || (x.p.role || '').toUpperCase())}${x.p.status === 'confirmed' ? ' · confirmed' : x.p.source === 'sec' ? ' · SEC' : ''}</span></td>
        <td class="s">${x.hook ? esc(x.hook) : '<span class="muted">none</span>'}</td>
        <td><a href="${esc(x.p.linkedin)}" target="_blank" rel="noopener">✓ Open ↗</a></td></tr>`).join('')}</tbody></table>`
      : `<div class="empty">Nobody ready in this lane: no target with a LinkedIn profile that hasn't been exported. Profiles fill in as the contact lookup runs.</div>`;
    $$('[name=pick]', el).forEach(b => b.addEventListener('change', recount)); recount();
  };
  const load = async () => { box.innerHTML = '<div class="empty">Loading…</div>'; list = await rowsFor(lane); draw(); };
  $('[name=lane]', el).addEventListener('change', e => { lane = e.target.value; store.set('hq-lh-lane', lane); $('[name=sender]', el).value = sender(); load(); });
  nIn.addEventListener('change', () => { store.set('hq-lh-n', nIn.value); draw(); });
  load();
}
