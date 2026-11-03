// Lead ownership + round-robin follow-ups (4 Nov 2026, Tengku).
// Before the first meeting: one sticky owner (people.owner_name), so the lead keeps talking to the same person.
// After the first meeting (people.met_at, or the stage is past New Relationship): every follow-up touch rotates through
// ROTATION, so nothing waits on one person. Follow up forever: CADENCE gaps after the meeting, then monthly for good.
import { sb, state } from './core.js';

export const ROTATION = ['Tengku', 'Anaz', 'Chase'];
export const CADENCE = [3, 7, 14, 30]; // days between touches after the first meeting; the last gap repeats forever
export const REACH = 'To Reach Out';
export const MET_FROM = 'Diligence Call Complete'; // reaching this stage = the first meeting happened
const TEAM = ['Tengku', 'Anaz', 'Chase', 'Peter', 'Razeen'];

// The signed-in person's first name ("chasehamby@…" → Chase).
export function meName() {
  const e = String(state.user?.email || '').toLowerCase();
  return TEAM.find(n => e.startsWith(n.toLowerCase())) || '';
}
export const teamName = n => { const k = String(n || '').trim().split(/\s+/)[0].toLowerCase(); return TEAM.find(t => t.toLowerCase() === k) || ''; };

export const isMet = (p, stageIdx, metIdx) => !!(p?.met_at || (stageIdx >= 0 && metIdx >= 0 && stageIdx >= metIdx));

// Whose turn is the next follow-up after the meeting. The one after whoever touched it last; first touch = the one after the owner.
export function nextSender(p) {
  const last = teamName(p?.last_touch_by), own = teamName(p?.owner_name);
  const from = ROTATION.indexOf(last) >= 0 ? ROTATION.indexOf(last) : ROTATION.indexOf(own);
  return ROTATION[(from + 1) % ROTATION.length];
}
// Days until the next post-meeting touch is due (negative = overdue), and how long the current gap is.
export function touchDue(p) {
  const gap = CADENCE[Math.min(p?.touch_count || 0, CADENCE.length - 1)];
  const since = p?.last_touch_at || p?.met_at;
  if (!since) return { gap, left: 0 };
  return { gap, left: gap - Math.floor((Date.now() - Date.parse(since)) / 864e5) };
}

// New lead, no obvious person: whoever in the rotation owns the fewest live pre-meeting leads.
export async function pickOwner() {
  const { data } = await sb.from('people').select('owner_name').neq('pipeline_active', false).is('met_at', null).not('owner_name', 'is', null);
  const n = Object.fromEntries(ROTATION.map(r => [r, 0]));
  for (const r of data || []) { const t = teamName(r.owner_name); if (t in n) n[t]++; }
  return ROTATION.slice().sort((a, b) => n[a] - n[b])[0];
}

// A touch someone just made (Followed up / Chased again / Reached out). Counts toward the cadence only after the meeting.
export function touchFields(p, met, now = new Date().toISOString()) {
  const me = meName() || teamName(p?.owner_name) || null;
  return { last_touch_by: me, last_touch_at: now, touch_count: (p?.touch_count || 0) + (met ? 1 : 0) };
}
