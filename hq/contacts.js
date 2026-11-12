// Contact line on Credit / BDC / UCC signal cards (10 Oct 2026): who to contact and how.
// Data: signal_contacts (one row per kind + key), filled by scripts/officers.py (SEC names for public companies) and the
// signal-contacts edge function (LinkedIn + website via Brave Search, email via Apify, Hunter fallback). See supabase/functions/signal-contacts.
import { sb, esc, $$, toast, modal, state } from './core.js';

const cache = { credit: null, bdc: null, ucc: null }, loading = {};
const FN = 'signal-contacts';

export function loadContacts(kind, fresh = false) {
  if (cache[kind] && !fresh) return Promise.resolve(cache[kind]);
  return loading[kind] ||= (async () => {
    const out = new Map();
    for (let from = 0; ; from += 1000) {
      const r = await sb.from('signal_contacts').select('*').eq('kind', kind).range(from, from + 999);
      if (r.error) break;
      (r.data || []).forEach(x => out.set(x.key, x));
      if ((r.data || []).length < 1000) break;
    }
    cache[kind] = out; loading[kind] = null; return out;
  })();
}
const get = (kind, key) => cache[kind]?.get(String(key)) || null;
export const contactOf = get;
// New CFO (8-K Item 5.02 in the last 180 days, officers.py) on a credit target: a CFO who inherited debt coming due (29 Oct 2026).
export const cfoChanged = key => (get('credit', key)?.officer_change?.roles || []).includes('cfo');
const live = c => (c?.people || []).filter(p => p.status !== 'wrong' && !p.left);
// Never batch someone who left; the owner's deal partner is shown but outreach goes to the company's own CFO / CEO.
export const bestPerson = (kind, key) => live(get(kind, key)).filter(p => p.role !== 'sponsor')[0] || null;
const SRC = { '8k': '8-K', news: 'news', sec: 'SEC' };

const ROLE = { cfo: 'CFO', ceo: 'CEO', sponsor: 'Owner', other: 'Exec' };
function personHtml(kind, key, p, c) {
  const enc = encodeURIComponent(p.name);
  const src = p.source === 'sec' ? `<a class="ctSrc" href="${esc(p.source_url || '#')}" target="_blank" rel="noopener" title="Signed the ${esc(p.form || '10-K/10-Q')} certification filed ${esc(p.filed || '')}">SEC</a>` : '';
  const email = p.email
    ? `<button type="button" class="ctLink" data-ctcopy="${esc(p.email)}" title="Copy · ${p.email_src === 'apify' ? 'mail server check' : 'Hunter score ' + (p.email_score ?? '?')}${p.email_status ? ' · ' + esc(p.email_status) : ''}">${p.email_status === 'valid' ? '✓ ' : '? '}${esc(p.email)}</button>`
    : c?.domain ? `<button type="button" class="ctLink muted" data-ctemail="${enc}" title="${p.email_checked ? 'Searched ' + esc(String(p.email_checked).slice(0, 10)) + '. Click to try again' : 'Find their work email (~$0.05)'}">${p.email_checked ? '✕ No email found' : 'Find email'}</button>` : '';
  const li = p.linkedin ? `<a class="ctLink" href="${esc(p.linkedin)}" target="_blank" rel="noopener">✓ LinkedIn ↗</a>`
    : `<span class="ctMiss">${c?.looked_up_at ? '✕ No LinkedIn found' : '… LinkedIn not searched yet'}</span>`;
  const check = p.status === 'confirmed' ? '<span class="ctOk" title="Confirmed by the team">✓ confirmed</span>'
    : p.source === 'sec' ? '' : `<button type="button" class="ctLink muted" data-ctmark="${enc}" data-st="confirmed" title="This is the right person">✓ Right</button><button type="button" class="ctLink muted" data-ctmark="${enc}" data-st="wrong" title="Wrong person or left the company">✕ Wrong</button>`;
  // Who holds the job now: new / interim appointees (8-K or news), LinkedIn showing another employer, the owner's deal partner.
  const isNew = p.appointed ? `<a class="ctSrc" href="${esc(p.appointed.url || '#')}" target="_blank" rel="noopener" title="Appointed ${esc(p.appointed.date || '')} (${esc(SRC[p.appointed.src] || p.appointed.src)})">${p.appointed.interim ? 'Interim' : 'New'} · ${esc(SRC[p.appointed.src] || '')} ${esc((p.appointed.date || '').slice(0, 7))}</a>` : '';
  const away = p.li_elsewhere ? `<a class="ctWarn" href="${esc(p.li_elsewhere.linkedin)}" target="_blank" rel="noopener" title="Their LinkedIn shows another employer: they may have left">⚠ LinkedIn shows ${esc(p.li_elsewhere.employer)}</a>` : '';
  const sponsor = p.role === 'sponsor' ? `<span class="ctSrc" title="${esc(p.quote || '')}">${esc(p.title || 'Partner')}, ${esc(p.employer || '')}${p.on_deal ? '' : ' (deal not named)'}</span>` : '';
  return `<div class="ctPerson"><span class="ctRole">${ROLE[p.role] || 'Exec'}</span><b>${esc(p.name)}</b>${src}${isNew}${sponsor}${away}
    ${li}${email}${check}</div>`;
}

// The contact block for one card. key: credit = cik, bdc / ucc = company_key.
export function contactHtml(kind, key, s) {
  if (!cache[kind]) return `<div class="ct" data-ctkey="${esc(key)}"><span class="ctNone">Loading contacts…</span></div>`;
  const c = get(kind, key), all = live(c), people = [...all.filter(p => p.role !== 'sponsor').slice(0, 2), ...all.filter(p => p.role === 'sponsor').slice(0, 1)];
  const gone = (c?.people || []).filter(p => p.left).map(p => `<a class="ctWarn" href="${esc(p.left.url || '#')}" target="_blank" rel="noopener">✕ ${esc(p.name)} left${p.left.date ? ' ' + esc(p.left.date.slice(0, 7)) : ''} (${esc(SRC[p.left.src] || p.left.src || '')}): don't message</a>`).join('');
  const extra = [c?.phone ? `<a class="ctLink" href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '', c?.website ? `<a class="ctLink" href="${esc(c.website)}" target="_blank" rel="noopener">${esc(c.domain || 'Website')} ↗</a>` : ''].filter(Boolean).join('');
  const change = c?.officer_change ? `<a class="ctWarn" href="${esc(c.officer_change.url)}" target="_blank" rel="noopener">⚠ ${esc((c.officer_change.roles || []).map(r => r.toUpperCase()).join(' and ') || 'Officer')} change filed ${esc(c.officer_change.date)} (8-K): the names may be out of date</a>` : '';
  const action = (people.length && c?.looked_up_at ? '' : `<button type="button" class="ctLink muted" data-ctlookup="${esc(key)}">${c?.looked_up_at ? 'Search again' : people.length ? 'Find LinkedIn' : 'Find contacts'}</button>`)
    + `<button type="button" class="ctLink muted" data-ctother title="Type any name: finds and checks their work email">+ Email for someone else</button>`;
  const none = !people.length ? `<span class="ctNone">${esc(c?.lookup_note || (c?.looked_up_at ? 'No CFO / CEO found.' : 'No contact yet.'))}</span>` : '';
  return `<div class="ct" data-ctkey="${esc(key)}">${people.map(p => personHtml(kind, key, p, c)).join('')}${none || extra || action || change || gone ? `<div class="ctMeta">${none}${extra}${action}${change}${gone}</div>` : ''}</div>`;
}

async function call(body) {
  const { data, error } = await sb.functions.invoke(FN, { body });
  if (error || data?.ok === false) throw new Error(data?.error || error?.message || 'Failed');
  return data;
}
// Find one person's work email (Apify, Hunter fallback) and refresh the cache. Returns the stored person.
export async function findEmail(kind, key, name, role, domain) {
  const r = await call({ action: 'email', kind, key, name, role, domain });
  await refresh(kind, key);
  return { ...r, person: live(get(kind, key)).find(p => p.name === name) || null };
}
async function refresh(kind, key) {
  const r = await sb.from('signal_contacts').select('*').eq('kind', kind).eq('key', String(key)).maybeSingle();
  if (r.data) { cache[kind] ||= new Map(); cache[kind].set(String(key), r.data); }
}

export function bindContacts(root, kind, redraw) {
  const keyOf = b => b.closest('[data-ctkey]')?.dataset.ctkey;
  $$('[data-ctcopy]', root).forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.ctcopy); toast('Email copied'); } catch { toast(b.dataset.ctcopy); } });
  $$('[data-ctlookup]', root).forEach(b => b.onclick = async () => {
    const key = keyOf(b); b.disabled = true; b.textContent = 'Searching…';
    try { const r = await call({ action: 'lookup', kind, key }); await refresh(kind, key); toast(r.note === 'no key' ? 'Add the Brave Search key first (Contacts setup)' : r.found ? `Found ${r.found}` : 'Nothing found'); }
    catch (e) { toast(e.message); }
    redraw();
  });
  $$('[data-ctemail]', root).forEach(b => b.onclick = async () => {
    const key = keyOf(b), name = decodeURIComponent(b.dataset.ctemail); b.disabled = true; b.textContent = 'Finding…';
    try { const r = await findEmail(kind, key, name); toast(r.email ? `${r.email} (${r.status === 'valid' ? 'confirmed by the mail server' : 'unconfirmed: not emailed'})` : 'No email found'); }
    catch (e) { toast(e.message); }
    redraw();
  });
  $$('[data-ctother]', root).forEach(b => b.onclick = () => {
    const key = keyOf(b), dom = get(kind, key)?.domain;
    modal({
      title: dom ? `Find an email at ${dom}` : 'Find a work email', submit: 'Find email',
      body: `<div class="form">${dom ? '' : '<label class="field">Company email domain<input class="input" name="domain" required autocomplete="off" placeholder="acme.com"><span class="s muted">No website found for this company yet. Type the part after the @ (saved on the card).</span></label>'}
        <label class="field">Full name<input class="input" name="name" required autocomplete="off" placeholder="First Last"></label>
        <label class="field">Role<select class="input" name="role"><option value="cfo">CFO</option><option value="ceo">CEO</option><option value="other">Other</option></select></label>
        <p class="s muted" style="margin:0">Also try the name they use publicly (e.g. a married name): each name is a separate check. Tries 10 name patterns against the company's mail server (~$0.05), Hunter if none is confirmed. Takes ~30 s. The person is saved on this card.</p></div>`,
      async onSubmit(fd) {
        const name = String(fd.get('name') || '').trim(); if (name.split(/\s+/).length < 2) { toast('Type first and last name'); return false; }
        toast('Checking the mail server…');
        try { const r = await findEmail(kind, key, name, String(fd.get('role')), dom ? '' : String(fd.get('domain') || '').trim()); toast(r.email ? `${r.email} (${r.status === 'valid' ? 'confirmed by the mail server' : 'unconfirmed: not emailed'})` : `No email found for ${name}`); }
        catch (e) { toast(e.message); }
        redraw();
      },
    });
  });
  $$('[data-ctmark]', root).forEach(b => b.onclick = async () => {
    const key = keyOf(b);
    try { await call({ action: 'mark', kind, key, name: decodeURIComponent(b.dataset.ctmark), status: b.dataset.st }); await refresh(kind, key); }
    catch (e) { toast(e.message); }
    redraw();
  });
}

// Admin: paste the Brave Search and Hunter keys (write-only; nobody can read them back from HQ).
export async function contactsSetup() {
  const { data: set } = await sb.rpc('contact_keys_set');
  modal({
    title: 'Contacts setup', submit: 'Save',
    body: `<div class="form pForm">
      <p class="s muted" style="grid-column:1/-1;margin:0">Public companies get their CFO and CEO from SEC filings automatically (free). For LinkedIn profiles, websites and private companies, add a <a href="https://api-dashboard.search.brave.com/" target="_blank" rel="noopener">Brave Search API</a> key. Work emails use the Apify account already saved (about $0.05 a person); a <a href="https://hunter.io/api-keys" target="_blank" rel="noopener">Hunter</a> key is an optional fallback. Keys are stored write-only.</p>
      <label class="field">Brave Search key ${set?.brave ? '<em class="ctOk">✓ saved</em>' : ''}<input class="input" name="brave" type="password" autocomplete="off" placeholder="${set?.brave ? 'Saved. Paste to replace' : 'Paste key'}"></label>
      <label class="field">Hunter key ${set?.hunter ? '<em class="ctOk">✓ saved</em>' : ''}<input class="input" name="hunter" type="password" autocomplete="off" placeholder="${set?.hunter ? 'Saved. Paste to replace' : 'Paste key'}"></label>
      <p class="s muted" style="grid-column:1/-1;margin:0">With the Brave key saved, HQ looks up ~120 targets a day on its own (best BDC targets first). "Send today's batch" finds the email of everyone in the batch on its own; "Find email" on a card does one person. Apify checks the mail server (~$0.05 a person), Hunter only if that finds no confirmed mailbox.</p></div>`,
    async onSubmit(fd) {
      for (const [field, name] of [['brave', 'BRAVE_SEARCH_KEY'], ['hunter', 'HUNTER_API_KEY']]) {
        const v = String(fd.get(field) || '').trim();
        if (v) { const r = await sb.rpc('set_contact_key', { p_name: name, p_value: v }); if (r.error) { toast(r.error.message); return false; } }
      }
      toast('Saved');
    },
  });
}
export const isAdmin = () => state.role === 'admin';
