// HQ → Team access (admin only): who can sign in, and set a password for anyone (edge function team-admin).
import { $, $$, esc, sb, modal, toast, opts, avatar, state, signOut } from './core.js';

const WORDS = ['harbor', 'summit', 'cedar', 'falcon', 'meadow', 'granite', 'river', 'orchard', 'beacon', 'willow', 'canyon', 'atlas'];
const easyPassword = () => {
  const w = WORDS[crypto.getRandomValues(new Uint32Array(1))[0] % WORDS.length];
  const n = String(crypto.getRandomValues(new Uint32Array(1))[0] % 9000 + 1000);
  return w[0].toUpperCase() + w.slice(1) + n;
};
const ago = v => {
  if (!v) return null; const d = (Date.now() - new Date(v)) / 864e5;
  return d < 1 ? 'today' : d < 2 ? 'yesterday' : `${Math.floor(d)} days ago`;
};
const status = m => m.last_sign_in_at ? `<span class="tag good">Signed in ${ago(m.last_sign_in_at)}</span>`
  : !m.has_login ? '<span class="tag bad">No login yet</span>'
  : !m.confirmed ? '<span class="tag warn">Invite not accepted</span>'
  : '<span class="tag">Never signed in</span>';

async function call(body) {
  const { data, error } = await sb.functions.invoke('team-admin', { body });
  if (error) { let msg = error.message; try { msg = (await error.context.json()).error || msg; } catch { } return { ok: false, error: msg }; }
  return data;
}

function passwordModal({ email = '', isNew = false, onDone }) {
  const pw = easyPassword();
  const { el } = modal({
    title: isNew ? 'Add team member' : `Set password · ${email}`, submit: 'Save password',
    body: `${isNew ? `<label class="field">Email<input class="input" name="email" type="email" required></label>
      <label class="field">Name<input class="input" name="full_name"></label>
      <label class="field">Role<select class="input" name="role">${opts([['ops', 'Ops (Today, Schedule, Resources)'], ['admin', 'Admin (everything)']], 'ops')}</select></label>` : ''}
      <label class="field">Password<span style="display:flex;gap:8px"><input class="input" name="password" value="${esc(pw)}" minlength="8" required autocomplete="off" style="flex:1"><button type="button" class="btn" data-gen>New</button></span></label>
      <p class="s muted" style="margin:0">Easy one filled in; change it if you like. It works straight away, no email is sent. Copy it before saving.</p>`,
    onSubmit: async fd => {
      const body = { action: 'set_password', email: isNew ? fd.get('email') : email, password: fd.get('password'), role: fd.get('role'), full_name: fd.get('full_name') };
      const r = await call(body);
      if (!r?.ok) { toast(r?.error || 'Failed'); return false; }
      try { await navigator.clipboard.writeText(`${String(body.email).trim().toLowerCase()} / ${body.password}`); toast('Saved. Email + password copied.'); } catch { toast('Password saved.'); }
      // A new password ends every session of that login, including this tab: sign in again instead of a confusing "Admins only".
      if (String(body.email).trim().toLowerCase() === String(state.user?.email || '').toLowerCase()) { toast('Password changed. Sign in again with it.'); setTimeout(signOut, 1500); return; }
      onDone?.();
    },
  });
  $('[data-gen]', el).onclick = () => { $('[name=password]', el).value = easyPassword(); };
}

export async function renderTeam(root) {
  root.innerHTML = `<div class="head"><div><h1>Team access</h1><p>Set a password for anyone on the team. They can also use “Email me a sign-in link” on the sign-in page, no password needed.</p></div>
    <button class="btn primary" id="tAdd">Add team member</button></div>
    <section class="card"><div class="body flush" id="tList"><div class="empty">Loading…</div></div></section>`;
  const load = async () => {
    const r = await call({ action: 'list' });
    if (root.dataset.page !== 'team') return;
    const box = $('#tList', root);
    if (!r?.ok) { box.innerHTML = `<div class="empty">${esc(r?.error || 'Could not load the team.')}</div>`; return; }
    box.innerHTML = `<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Person</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>${r.members.map(m => `
      <tr><td><span style="display:inline-flex;gap:10px;align-items:center">${avatar(m.full_name || m.email)}<span><b>${esc(m.full_name || m.email.split('@')[0])}</b><br><span class="s muted">${esc(m.email)}</span></span></span></td>
      <td>${esc(m.role)}</td><td>${status(m)}</td>
      <td class="n"><button class="btn sm" data-set="${esc(m.email)}">Set password</button></td></tr>`).join('')}</tbody></table></div>`;
    $$('[data-set]', box).forEach(b => b.onclick = () => passwordModal({ email: b.dataset.set, onDone: load }));
  };
  $('#tAdd', root).onclick = () => passwordModal({ isNew: true, onDone: load });
  load();
}
