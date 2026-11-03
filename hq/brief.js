// Pre-meeting brief (4 Nov 2026, Tengku: "Marco Demiroz was a disaster because we didn't focus on AI").
// Before any meeting: who they are, what they specialise in, and whether WE are specialists in it. The bigger the fund,
// the bigger the ego and the more it has to be about them; if nobody on our side matches their lane, we aren't it.
// Same engine as teasers: resource-request action 'brief' → resource-builder routine → routines/brief.md writes
// resource_jobs.payload.brief; HQ copies it onto people.brief (brief_job_id = latest asked, brief_ready_job = the one stored).
import { sb, esc, toast, modal, fmtDate } from './core.js';

const FIT = {
  strong: { sym: '✓', word: 'Strong fit', tone: 'good' },
  partial: { sym: '?', word: 'Partial fit', tone: 'warn' },
  none: { sym: '✕', word: 'Not our lane', tone: 'bad' },
};
const fitOf = b => FIT[b?.fit?.verdict] || null;
const pending = p => !!(p?.brief_job_id && p.brief_job_id !== p.brief_ready_job && !p._briefFailed);

async function errMsg(data, error) {
  if (data?.ok === false) return data.error || 'Failed';
  if (!error) return '';
  try { const j = await error.context?.json?.(); if (j?.error) return j.error; } catch { }
  return error.message || 'Failed';
}

// One line for rows and the update window.
export function briefLine(p, inModal = false) {
  if (!p || !('brief' in p)) return '';
  const f = fitOf(p.brief), btn = inModal ? ` <button type="button" class="link s" data-openbrief>${p.brief ? 'Open brief' : 'Prep brief'}</button>` : '';
  if (pending(p)) return `<div class="pBrief s muted">… Brief being written (1–3 min)${btn}</div>`;
  if (!p.brief) return inModal ? `<div class="pBrief s"><span class="muted">No pre-meeting brief yet.</span>${btn}</div>` : '';
  return `<div class="pBrief s"><span class="pFit ${f?.tone || ''}">${f ? `${f.sym} ${f.word}` : 'Brief'}</span>${p.brief.fit?.lead ? ` · <b>${esc(p.brief.fit.lead)}</b> leads` : ''}${p.brief.fit?.angle ? ` · ${esc(String(p.brief.fit.angle).slice(0, 120))}` : ''}${btn}</div>`;
}

// Copies finished briefs from resource_jobs onto people. Returns how many changed.
export async function syncBriefs(people) {
  const todo = (people || []).filter(pending);
  if (!todo.length) return 0;
  const { data } = await sb.from('resource_jobs').select('id,status,error,payload').in('id', todo.map(p => p.brief_job_id));
  let n = 0;
  for (const j of data || []) {
    const p = todo.find(x => x.brief_job_id === j.id); if (!p) continue;
    if (j.status === 'ready' && j.payload?.brief) {
      const f = { brief: j.payload.brief, brief_ready_job: j.id, brief_at: new Date().toISOString() };
      const r = await sb.from('people').update(f).eq('id', p.id);
      if (!r.error) { Object.assign(p, f); n++; }
    } else if (j.status === 'failed') { p._briefFailed = j.error || 'failed'; n++; }
  }
  return n;
}

async function requestBrief(p, opp, notes) {
  const { data, error } = await sb.functions.invoke('resource-request', { body: { action: 'brief', brief: { person_id: p.id, opportunity_id: opp?.id || null, notes } } });
  const m = await errMsg(data, error);
  if (m) { toast(m); return false; }
  toast('Writing the brief. It lands here in 1–3 minutes.');
  return true;
}

const list = (title, a) => Array.isArray(a) && a.length ? `<h4>${esc(title)}</h4><ul>${a.map(x => `<li>${esc(typeof x === 'string' ? x : x.text || JSON.stringify(x))}</li>`).join('')}</ul>` : '';

export function briefModal(p, opp, onChange) {
  const b = p.brief, f = fitOf(b), w = b?.who || {};
  const facts = [['Firm', w.firm], ['Role', w.role], ['Size', w.size], ['Stage', w.stage], ['Sector / lane', w.sector], ['Geography', w.geography]].filter(x => x[1]);
  const body = b ? `<div class="brief">
      <div class="briefFit ${f?.tone || ''}"><b>${f ? `${f.sym} ${f.word}` : 'Fit not judged'}</b>${b.fit?.score != null ? ` <span class="muted s">${esc(b.fit.score)}/100</span>` : ''}
        ${b.fit?.why ? `<p>${esc(b.fit.why)}</p>` : ''}${b.fit?.lead ? `<p class="s"><b>Who leads the call:</b> ${esc(b.fit.lead)}${b.fit.lead_why ? ` (${esc(b.fit.lead_why)})` : ''}</p>` : ''}
        ${b.fit?.angle ? `<p class="s"><b>Our angle:</b> ${esc(b.fit.angle)}</p>` : ''}</div>
      ${b.headline ? `<p class="briefHead">${esc(b.headline)}</p>` : ''}
      ${facts.length ? `<dl class="briefFacts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
      ${w.thesis ? `<p class="s"><b>Their thesis:</b> ${esc(w.thesis)}</p>` : ''}
      ${list('Recent moves', b.recent)}${list('Talk about (their world, not ours)', b.talk_about)}${list('Proof we bring', b.proof)}
      ${list('Avoid', b.avoid)}${list('Qualify on the call', b.questions)}${list('Still unknown', b.missing)}
      ${Array.isArray(b.sources) && b.sources.length ? `<h4>Sources</h4><ul class="s">${b.sources.map(s => `<li>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)} ↗</a>` : esc(s.title || '')}</li>`).join('')}</ul>` : ''}
      <p class="muted s">Written ${fmtDate(p.brief_at)}. Facts from public sources and what they told us; check anything that sounds off.</p></div>`
    : `<p>${p._briefFailed ? `<b>Last try failed:</b> ${esc(p._briefFailed)}<br>` : ''}Claude researches ${esc(p.name)}${p.company_name ? ` at ${esc(p.company_name)}` : ''}: size, thesis, recent moves, then checks it against what OuterHaven is actually specialised in and tells you who should lead the call, or that we shouldn't take it as is.</p>`;
  modal({
    title: `Brief · ${p.name}`, wide: true, submit: pending(p) ? '' : b ? 'Rewrite brief' : 'Prep brief',
    body: `${body}${pending(p) ? '<p class="muted s">… A brief is being written. Reopen in a minute.</p>' : `<label class="field" style="margin-top:12px">Anything we know that isn't online (optional)<textarea class="input" name="notes" rows="2" placeholder="e.g. raising Fund III, $400M, AI infra focus; met at SuperReturn"></textarea></label>`}`,
    async onSubmit(fd) {
      if (!(await requestBrief(p, opp, String(fd.get('notes') || '').trim()))) return false;
      onChange?.();
    },
  });
}
