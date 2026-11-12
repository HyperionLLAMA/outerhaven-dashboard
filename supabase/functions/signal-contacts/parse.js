// Pure helpers for signal-contacts (tested offline: node scripts/tests/test_contacts_parse.mjs).

// Company name → the brand people actually use ("OmniGuide Holdings, Inc." → "OmniGuide").
export const brand = n => String(n || '')
  .replace(/\s*\(.*?\)\s*/g, ' ')
  .replace(/,?\s+(incorporated|inc|corp|corporation|co|ltd|llc|l\.l\.c|plc|lp|l\.p|holdings?|group|buyer|midco|bidco|topco|holdco|parent|intermediate|acquisition|borrower|merger sub|us|usa)\.?\b/gi, ' ')
  .replace(/[,.]+$/, '').replace(/\s+/g, ' ').trim();

const ROLE = [
  ['cfo', /\b(cfo|chief financial officer|vp,? finance|vice president,? finance|head of finance|finance director|treasurer|controller)\b/i],
  ['ceo', /\b(ceo|chief executive officer|(?<!vice[ -])president|founder|co-founder|owner|managing director)\b/i],
];
export const roleOf = t => (ROLE.find(([, re]) => re.test(t || '')) || ['other'])[0];

// Words that don't make a company a different company ("Venbrook Companies" = Venbrook, "Acme Holdings, Inc." = Acme).
const FILLER = new Set('inc incorporated llc l.l.c ltd lp llp plc co corp corporation company companies group holdings holding the and of us usa america americas international global services solutions systems technologies technology industries enterprises brands products buyer midco bidco topco holdco parent intermediate acquisition borrower'.split(' '));
const words = s => String(s || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9&]+/g, ' ').trim().split(' ').filter(Boolean);
const distinct = s => words(s).filter(w => !FILLER.has(w) && w !== '&');
// Looser search name: the distinctive words only. Filings use legal names ("Global Integrated Flooring Systems") that differ from the
// trading name ("Global Integrated Flooring Solutions") only in filler words, so an exact-name search finds nothing.
export const searchName = n => distinct(brand(n)).join(' ');

// Does the employer named on a LinkedIn profile mean this company? Every distinctive word of the brand must be in it, and it
// must not add distinctive words the company's own name doesn't have ("Colonnade Advisors" is not "Colonnade Parent",
// "First Independence Bank" is not "Independence Buyer", "Corporate Travel Management (CTM) Group" is not "CTM Group").
export function sameCompany(employer, company) {
  const raw = String(employer || '').trim();
  const cut = /(\.\.\.|…)$/.test(raw), glued = /\w(\.\.\.|…)$/.test(raw);  // "Essence ..." vs "Essen..." (last word cut off)
  let e = distinct(raw.replace(/\s*(\.\.\.|…)$/, '')); if (glued) e = e.slice(0, -1);
  const own = new Set(distinct(company)), b = distinct(brand(company));
  if (!b.length || !e.length) return false;
  // No words the company's own name doesn't have ("Marquis Software Development" is not "Marquis Software Solutions"), and every
  // distinctive brand word ("Marquis Companies" is not "Marquis Software"); a title cut off by LinkedIn ("CFO at Essence ...")
  // only has to start the same way.
  if (!e.every(w => own.has(w))) return false;
  return cut ? e.every((w, i) => b[i] === w || own.has(w)) && e[0] === b[0] : b.every(w => e.includes(w));
}

// The employer a LinkedIn search result names: "Name - CFO at Acme", "Name - CFO - Acme", "Name - Acme", or "Experience: Acme ·".
function employerOf(parts, desc) {
  for (const p of parts.slice(1)) {
    const at = p.match(/\b(?:at|@)\s+(.+)$/i); if (at) return at[1].trim();
    if (roleOf(p) === 'other') return p.trim();
  }
  const ex = desc.match(/Experience:\s*([^·|]+)/i); return ex ? ex[1].trim() : '';
}

// One Brave web result for a LinkedIn profile → { name, title, linkedin } if it belongs to this company and a finance / top role.
// LinkedIn titles look like "Robert Allen - Chief Financial Officer - OmniGuide | LinkedIn" or "Robert Allen – OmniGuide | LinkedIn".
// The role must be in the person's own title: snippets are often posts about someone else ("We welcome Kenneth Ward as CFO").
// named = true for SEC officers searched by name (the role is already known from the filing, so a title without one is fine).
export function profileFrom(r, company, named = false) {
  const url = String(r?.url || '');
  if (!/^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\//i.test(url)) return null;
  const title = String(r.title || '').replace(/\s*\|\s*LinkedIn\s*$/i, '').replace(/[^\x20-\x7EÀ-ɏ–—’]+/g, ' ').replace(/\s+/g, ' ').trim();
  const desc = String(r.description || '').replace(/<[^>]+>/g, '').replace(/&#x27;|&#39;/g, "'");
  const parts = title.split(/\s+[-–—|]\s+/);
  const rest = parts.slice(1).join(' ');
  if (/\b(former|ex-|previously|retired|fractional|freelance|consultant|outsourced|part-time cfo|cfo services|advisor to|for smbs?)\b/i.test(rest)) return null;
  const emp = employerOf(parts, desc), employer = emp.replace(/\s*(\.\.\.|…)$/, '').trim();
  if (!sameCompany(emp, company)) return null;
  const name = (parts[0] || '').replace(/,.*$/, '').replace(/\b(MBA|CPA|CFA|PhD|Jr\.?|Sr\.?)\b/g, '').replace(/\s+/g, ' ').trim();
  if (!/^[A-Z][\p{L}'.-]+(\s+[A-Z][\p{L}'.-]*){1,3}$/u.test(name)) return null;
  const roleSeg = parts.slice(1).find(p => roleOf(p) !== 'other');
  const role = roleSeg ? roleOf(roleSeg) : named ? 'named' : 'other';
  if (role === 'other') return null;
  const raw = roleSeg ? roleSeg.replace(/\s+(?:at|@)\s+.+$/i, '').trim() : '';
  const jobTitle = raw.length > 60 ? raw.slice(0, 58).trim() + '…' : raw;
  return { name, title: jobTitle, role, employer: employer.slice(0, 60), linkedin: url.split('?')[0] };
}

// Directory / data sites that are never the company's own website.
const NOT_SITE = /(linkedin|zoominfo|bloomberg|crunchbase|dnb|pitchbook|rocketreach|apollo\.io|signalhire|lusha|facebook|instagram|twitter|x\.com|youtube|wikipedia|glassdoor|indeed|yelp|bbb\.org|mapquest|opencorporates|sec\.gov|prnewswire|businesswire|globenewswire|craft\.co|owler|cbinsights|manta|buzzfile|yahoo|reuters|wsj|forbes|google|amazon|bizapedia|corporationwiki|govtribe|sam\.gov|privco|growjo|leadiq|contactout)\./i;
export function websiteFrom(results, company) {
  const words = brand(company).toLowerCase().split(' ').filter(w => w.length >= 3);
  for (const r of results || []) {
    let host = '';
    try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch { continue; }
    if (NOT_SITE.test(host) || !/\.(com|net|io|co|us|org|biz|ai|health|tech)$/.test(host)) continue;
    const flat = host.replace(/\.[a-z]+$/, '').replace(/[^a-z0-9]/g, ''), all = words.join('').replace(/[^a-z0-9]/g, '');
    if ((all.length >= 4 && flat.includes(all)) || words.some(w => w.length >= 5 && flat.includes(w.replace(/[^a-z0-9]/g, '')))) return { website: `https://${host}`, domain: host };
  }
  return null;
}

// Merge newly found people into the stored list: same person (name match) keeps what humans set (status, email, linkedin).
const nk = n => String(n || '').toLowerCase().replace(/[^a-z]/g, '');
export function mergePeople(old, found) {
  const out = [...(old || [])];
  for (const p of found) {
    const i = out.findIndex(o => nk(o.name) === nk(p.name));
    if (i < 0) out.push(p);
    else out[i] = { ...p, ...Object.fromEntries(Object.entries(out[i]).filter(([, v]) => v != null && v !== '')) };
  }
  const rank = p => (p.left ? 8 : 0) + (p.status === 'wrong' ? 9 : 0) + (p.appointed ? -0.75 : 0) + (p.status === 'confirmed' ? -2 : 0) + (p.role === 'cfo' ? 0 : p.role === 'ceo' ? 1 : p.role === 'sponsor' ? 1.5 : 2) + (p.source === 'sec' ? -0.5 : 0);
  return out.sort((a, b) => rank(a) - rank(b)).slice(0, 8);
}

// Who owns a private company, from web search results (12 Oct 2026, after Global Integrated Flooring ranked No. 1 as if founder-run
// while it was an RFE Investment Partners portfolio company). Returns { owner, url } or null. A result only counts if it names this
// company (its distinctive words), and the owner must not be the company itself ("XYZ, acquired by Acme" when we are Acme).
const ci = re => re.replace(/[a-z]/g, c => `[${c}${c.toUpperCase()}]`);   // plain words and (?:a|b) groups only, no [..] classes
const ORG = "[A-Z][A-Za-z0-9&.'’-]*(?:\\s+(?:&\\s+)?[A-Z][A-Za-z0-9&.'’-]*){0,5}";
const OWNER_RES = [
  new RegExp(`${ci('portfolio compan(?:y|ies) of')} (${ORG})`),
  new RegExp(`\\b(?:an?|the|An?|The) (${ORG}) ${ci('portfolio company')}`),
  new RegExp(`\\b${ci('(?:acquired by|backed by|recapitali(?:s|z)ed by|(?:majority |minority |growth |strategic )?investment (?:from|by)|sold to)')} (${ORG})`),
  // Owner first: "ICV Partners makes majority investment in Total Access Urgent Care", "Pamlico Capital acquires Marquis".
  // Headlines are Title Case, so the verbs match any case (ci); the owner's name still has to be capitalised.
  new RegExp(`(${ORG}(?:\\s+and\\s+${ORG})?) ${ci('(?:makes|made|announces|announced|completes|completed|closes|invests|invested)(?: an?| its| in)? (?:majority |minority |growth |strategic |significant )?(?:investment|recapitali(?:s|z)ation) in')}`),
  new RegExp(`(${ORG}(?:\\s+and\\s+${ORG})?) ${ci('(?:acquires|acquired|has acquired|completes (?:the )?acquisition of|invests in|invested in)')}`),
];
// Never an owner: data sites and law firms ("portfolio company of Willkie client Capstreet Group" is Willkie's client, not Willkie).
const NOT_OWNER = /\b(crunchbase|pitchbook|linkedin|zoominfo|bloomberg|wikipedia|mergr|owler|cbinsights|privco|profile|funding|news|llp|law|attorneys?)\b/i;
// lenders = the company's own lenders (BDC names): "backed by Chicago Atlantic" names the lender, not the owner.
export function ownerFrom(results, company, lenders = []) {
  const need = distinct(brand(company));
  if (!need.length) return null;
  // Pages shorten names ("Claridge Products" for Claridge Products and Equipment): the first distinctive word plus half the rest.
  const named = ws => ws.has(need[0]) && need.filter(w => ws.has(w)).length >= Math.ceil(need.length / 2);
  for (const r of results || []) {
    // Page furniture glued onto words ("PrevPreviousKainos Capital", "ComplyAdvantage.Read more") becomes a sentence break.
    const text = `${r?.title || ''}. ${r?.description || ''}`.replace(/<[^>]+>/g, '').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/\b(?:Prev(?:ious)?|Next)+(?=[A-Z])/g, '. ').replace(/([a-z])\.(?=[A-Z])/g, '$1. ');
    const have = new Set(words(text));
    if (!named(have)) continue;
    for (const re of OWNER_RES) for (const hit of text.matchAll(new RegExp(re.source, 'g'))) {
      if (/^\s+clients?\b/i.test(text.slice(hit.index + hit[0].length))) continue;   // "Willkie client Capstreet": an adviser
      // The company must be named in the same sentence as the ownership phrase (a page about "leisure" isn't about Leisure Co).
      const from = text.lastIndexOf('. ', hit.index) + 1, to = text.indexOf('. ', hit.index + hit[0].length);
      const sentence = new Set(words(text.slice(from, to < 0 ? undefined : to)));
      if (!named(sentence)) continue;
      // "Skylark Private Equity and WhiteHorse Capital invest in…": each name on its own (WhiteHorse is the lender).
      for (const part of hit[1].split(/\.\s|\s+(?:Portfolio|Exits?|Announces|Acquires)\b/)[0].split(/\s+and\s+/)) {
        const owner = part.replace(/[.,;:]+$/, '').replace(/\s+(in|on|to|for|since|which|LLC|L\.?P\.?)$/i, '').trim();
        const first = distinct(owner)[0];
        // Sharing a distinctive word = a namesake or the company itself ("QED Investors" is not QED Technologies' owner).
        if (owner.length >= 3 && !NOT_OWNER.test(owner) && !sameCompany(owner, company) && !distinct(owner).some(w => need.includes(w))
          && !lenders.some(l => distinct(l)[0] === first)) return { owner, url: String(r.url || '') };
      }
    }
  }
  return null;
}

// Who holds the job now (13 Nov 2026): CEO / CFO changes from an 8-K Item 5.02 (officers.py change_people) or news
// (fund-web company.js officersIn). Appointees are added (or an existing person takes the role, e.g. CEO as interim CFO);
// people who left are kept but marked, so they drop to the bottom and never go into a batch. meta = { src: '8k'|'news', date, url }.
export function applyChanges(people, changes, meta) {
  // Same person when first and last names match: "Paul Lalljie" (8-K) = "Paul S. Lalljie" (10-Q signature).
  const fl = n => { const w = String(n || '').toLowerCase().replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter(x => x.length > 1); return w.length ? `${w[0]} ${w[w.length - 1]}` : ''; };
  const out = (people || []).map(p => ({ ...p })), find = n => out.find(p => fl(p.name) === fl(n));
  for (const c of changes || []) {
    if (!c?.name) continue;
    const d = c.date || meta.date || null, url = c.url || meta.url || null, p = find(c.name);
    if (c.event === 'left') { if (p && !p.left && !(p.appointed && (p.appointed.date || '') > (d || ''))) p.left = { date: d, src: meta.src, url, role: c.role }; continue; }
    const title = `${c.interim ? 'Interim ' : ''}${c.role === 'cfo' ? 'CFO' : 'CEO'}`;
    const appointed = { date: d, src: meta.src, url, interim: !!c.interim, role: c.role };
    if (p) { if ((p.left?.date || '') > (d || '')) continue; delete p.left; p.appointed = appointed; if (c.role === 'cfo' || p.role !== 'cfo') { p.title = p.role && p.role !== c.role ? `${p.title || p.role.toUpperCase()} and ${title}` : title; p.role = c.role; } }
    else out.push({ name: c.name, role: c.role, title, source: meta.src, source_url: url, appointed });
  }
  return mergePeople(out, []);
}

// A named officer's LinkedIn that now shows another employer: probably left (a hint, not proof; titles go stale too).
export function elsewhereFrom(results, name, company) {
  const want = String(name || '').toLowerCase().replace(/\b[a-z]\.\s*/g, '').split(/\s+/).filter(Boolean);
  for (const r of results || []) {
    const url = String(r?.url || '');
    if (!/^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\//i.test(url)) continue;
    const title = String(r.title || '').replace(/\s*\|\s*LinkedIn\s*$/i, '').trim(), parts = title.split(/\s+[-–—|]\s+/);
    const got = (parts[0] || '').toLowerCase().replace(/,.*$/, '').split(/\s+/);
    if (!want.length || got[0] !== want[0] || got[got.length - 1] !== want[want.length - 1]) continue;
    const emp = employerOf(parts, String(r.description || '')).replace(/\s*(\.\.\.|…)$/, '').trim();
    if (emp && !sameCompany(emp, company) && !/\b(former|ex-|previously)\b/i.test(title)) return { employer: emp.slice(0, 60), linkedin: url.split('?')[0] };
  }
  return null;
}
