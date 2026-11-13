// signal-contacts: who to contact at each Credit / BDC / UCC target, and how (10 Oct 2026).
// Ingest (header x-fund-ingest = FUND_INGEST_SECRET, from scripts/officers.py on GitHub):
//   kind 'officers_todo' → credit targets whose SEC officers are missing or older than 30 days
//   kind 'officers' {items: [{cik, company_name, people, phone, website, officer_change}]} → stored (SEC = exact names)
// Cron (header x-outerhaven-cron = LINKEDIN_CRON_SECRET, every 30 min): action 'cron' looks up the next targets (DAILY_CAP a day);
//   action 'owners' {limit} = owner checks only for unchecked BDC refi targets (1 Brave query each, outside DAILY_CAP).
// Admin (user JWT): action 'lookup' {kind, key} = Find contacts now; 'email' {kind, key, name} = work email (Apify, Hunter fallback);
//   'mark' {kind, key, name, status: 'confirmed'|'wrong'|null}.
// Keys (pasted in HQ, write-only): BRAVE_SEARCH_KEY (LinkedIn + website), APIFY_TOKEN + HUNTER_API_KEY (work email). Missing key = that step is skipped.
import { createClient } from "npm:@supabase/supabase-js@2";
import { brand, searchName, profileFrom, websiteFrom, mergePeople, ownerFrom, applyChanges, elsewhereFrom, personProfile, fromSerper } from "./parse.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!, SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-fund-ingest, x-outerhaven-cron", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const DAILY_CAP = 120;   // companies looked up per day by the cron (~2-3 Brave queries each)
const PER_RUN = 6;       // per 30-min cron run: ~3 queries x 1.1 s each, well inside the function time limit
const TABLE: Record<string, string> = { credit: "credit_signals", bdc: "bdc_signals", ucc: "ucc_signals" };
const KEYCOL: Record<string, string> = { credit: "cik", bdc: "company_key", ucc: "company_key" };

async function secret(key: string) {
  const r = await sb.from("integration_secrets").select("secret_value").eq("key", key).maybeSingle();
  return (r.data?.secret_value as string) || "";
}
async function admin(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const u = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: { user } } = await u.auth.getUser();
  if (!user) return null;
  return (await u.rpc("dashboard_role")).data === "admin" ? user : null;
}
const getRow = async (kind: string, key: string) => (await sb.from("signal_contacts").select("*").eq("kind", kind).eq("key", key).maybeSingle()).data;
async function save(kind: string, key: string, patch: Record<string, unknown>) {
  const r = await sb.from("signal_contacts").upsert({ kind, key, ...patch, updated_at: new Date().toISOString() }, { onConflict: "kind,key" });
  if (r.error) throw new Error(r.error.message);
}

// Brave's free plan allows 1 query per second: space calls 1.1 s apart and retry a 429 once.
let lastBrave = 0;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function brave(q: string, key: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const wait = 1100 - (Date.now() - lastBrave); if (wait > 0) await sleep(wait);
    lastBrave = Date.now();
    const r = await fetch(`https://api.search.brave.com/res/v1/web/search?count=10&q=${encodeURIComponent(q)}`, { headers: { Accept: "application/json", "X-Subscription-Token": key } });
    if (r.status === 429 && attempt === 0) { await sleep(1600); continue; }
    if (r.status === 429) throw new Error("Brave rate limit");
    if (!r.ok) throw new Error(`Brave HTTP ${r.status}`);
    return ((await r.json())?.web?.results || []) as any[];
  }
  return [];
}

// Google via Serper (13 Nov 2026): finds LinkedIn profiles Brave misses. $0.001 a search; key SERPER_API_KEY (Fund signals → Setup).
async function serper(q: string, key: string) {
  const r = await fetch("https://google.serper.dev/search", { method: "POST", headers: { "content-type": "application/json", "X-API-KEY": key }, body: JSON.stringify({ q, num: 10 }) });
  if (!r.ok) return [];
  return (((await r.json())?.organic || []) as any[]).map(fromSerper);
}

// Re-judge BDC rows after their owner changed (rules live in the bdc-signals function).
async function rejudgeBdc(keys: string[]) {
  const k = await secret("FUND_INGEST_SECRET");
  if (!k || !keys.length) return false;
  const r = await fetch(`${SUPABASE_URL}/functions/v1/bdc-signals`, { method: "POST", headers: { "content-type": "application/json", "x-fund-ingest": k }, body: JSON.stringify({ kind: "rejudge", keys }) }).catch(() => null);
  return !!r?.ok;
}

// Safety net: BDC rows left stale (rules_version 0) because a per-company re-judge failed get re-judged in one call.
async function retryStale() {
  const stale = ((await sb.from("bdc_signals").select("company_key").eq("rules_version", 0).limit(50)).data || []).map((x: any) => x.company_key);
  if (stale.length) await rejudgeBdc(stale);
  return stale.length;
}

// BDC borrowers: who owns it. A PE or corporate owner runs the refinancing, so the rules drop it to Maybe (bdc-signals rules v4).
async function checkOwner(key: string, company: string, bk: string) {
  const b = brand(company), alt = searchName(company), name = alt && alt !== b.toLowerCase() ? alt : b;
  const lenders = (((await sb.from("bdc_signals").select("holders").eq("company_key", key).maybeSingle()).data?.holders || []) as any[]).map(h => String(h.bdc || ''));
  // Unquoted distinctive words: a quoted phrase like "claridge equipment" never appears on a page (names are shortened).
  const own = ownerFrom(await brave(`${name === b ? `"${b}"` : name} ("portfolio company" OR "acquired by" OR "backed by" OR "investment from" OR "majority investment" OR "invests in")`, bk), company, lenders);
  // rules_version 0 = stale until bdc-signals re-judges it (a failed re-judge stays visible instead of leaving an old verdict).
  const up = await sb.from("bdc_signals").update({ owner: own?.owner || null, owner_url: own?.url || null, owner_checked_at: new Date().toISOString(), rules_version: 0 }).eq("company_key", key);
  if (up.error) throw new Error(up.error.message);
  await rejudgeBdc([key]);
  return own;
}

// Owner checks only (1 search per company, outside the contacts quota): refi targets not checked yet, best first.
async function owners(limit = 20) {
  const bk = await secret("BRAVE_SEARCH_KEY");
  if (!bk) return { skipped: "no Brave key" };
  const rows = (await sb.from("bdc_signals").select("company_key,company_name").eq("lane", "refi").eq("verdict", "target").is("owner_checked_at", null)
    .order("score", { ascending: false }).limit(Math.min(limit, 40))).data || [];
  const found: string[] = [];
  for (const r of rows as any[]) {
    try { const o = await checkOwner(r.company_key, r.company_name, bk); if (o) found.push(`${r.company_name}: ${o.owner}`); }
    catch (e) { if (String(e).includes("rate limit")) break; }
  }
  return { checked: rows.length, found, stale: await retryStale() };
}

// Find contacts for one company: LinkedIn profiles of the CFO / CEO and the company website.
async function lookup(kind: string, key: string, name?: string) {
  const bk = await secret("BRAVE_SEARCH_KEY");
  const row = await getRow(kind, key);
  let company = name || row?.company_name;
  if (!company) company = (await sb.from(TABLE[kind]).select("company_name").eq(KEYCOL[kind], key).maybeSingle()).data?.company_name;
  if (!company) throw new Error("Company not found");
  if (!bk) { await save(kind, key, { company_name: company, lookup_note: "No Brave Search key yet (HQ → Contacts setup)." }); return { ok: false, note: "no key" }; }
  // A new search replaces earlier unconfirmed search finds; SEC names and anyone the team marked stay.
  const NAMED = ["sec", "8k", "news", "manual"];
  const b = brand(company), people = (row?.people || []).filter((p: any) => NAMED.includes(p.source) || p.status);
  const found: any[] = [];
  // Named officers (SEC signers, 8-K / news appointees): search each by name for their LinkedIn. Otherwise search the company for roles.
  // People marked as left are skipped. A profile under the name that now shows another employer = "LinkedIn shows <X>" (13 Nov 2026).
  const named = people.filter((p: any) => NAMED.includes(p.source) && !p.linkedin && !p.left).slice(0, 3);
  const sk = await secret("SERPER_API_KEY");
  const same = (x: any, p: any) => x && x.name.split(" ").pop()!.toLowerCase() === String(p.name).split(" ").pop()!.toLowerCase();
  for (const p of named) {
    let res = await brave(`"${p.name}" "${b}" site:linkedin.com/in`, bk);
    let hit = res.map(r => profileFrom(r, company, true)).find(x => same(x, p));
    // Brave missed: Google (Serper) indexes far more LinkedIn profiles.
    if (!hit && sk) { const g = await serper(`"${p.name}" ${b} site:linkedin.com/in`, sk); hit = g.map(r => profileFrom(r, company, true)).find(x => same(x, p)); if (!hit) res = res.concat(g); }
    const away = hit ? null : elsewhereFrom(res, p.name, company);
    found.push({ ...p, ...(hit ? { linkedin: hit.linkedin } : {}), ...(away ? { li_elsewhere: away } : {}), li_checked: new Date().toISOString() });
  }
  const alt = searchName(company), loose = alt && alt !== b.toLowerCase();
  if (!named.length) {
    const roles = `(CFO OR "Chief Financial Officer" OR "VP Finance" OR CEO OR President) site:linkedin.com/in`;
    let res = await brave(`"${b}" ${roles}`, bk);
    // Legal name found nothing: retry with the distinctive words only (trading names differ in filler words).
    if (!res.some(r => profileFrom(r, company)) && loose) res = await brave(`"${alt}" ${roles}`, bk);
    if (!res.some(r => profileFrom(r, company)) && sk) res = await serper(`"${b}" (CFO OR "Chief Financial Officer" OR CEO OR President) site:linkedin.com/in`, sk);
    const seen = new Set<string>();
    for (const r of res) { const p = profileFrom(r, company); if (p && !seen.has(p.name)) { seen.add(p.name); found.push({ ...p, source: "search", source_url: p.linkedin }); } }
  }
  if (kind === "bdc") await checkOwner(key, company, bk);
  let site = row?.domain ? null : websiteFrom(await brave(`"${b}" official website`, bk), company);
  const note = found.some(p => p.linkedin) ? null : named.length ? "Named officers found, no LinkedIn match." : "No CFO / CEO profile found in search.";
  await save(kind, key, { company_name: company, people: mergePeople(people, found.slice(0, 4)), ...(site ? { website: site.website, domain: site.domain } : {}), looked_up_at: new Date().toISOString(), lookup_note: note });
  return { ok: true, found: found.length, domain: site?.domain || row?.domain || null };
}

// Apify overpowered/email-finder (12 Oct 2026): checks 10 name patterns against the company's mail server.
// $0.045 a person (10 x $0.0045) on the paid Apify account; cap $0.10 (at $0.05 the 10th row tipped it into ABORTED, so the dataset
// is read whatever the status). ~20-30 s. Only "Okay to Send" + "Accepted" = valid. All 10 rejected can be a filtering gateway
// (Proofpoint rejected every pattern at unifi.com), so Hunter is still tried after it when a key is saved.
async function apifyEmail(domain: string, first: string, last: string) {
  const token = await secret("APIFY_TOKEN");
  if (!token) return null;
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` }, api = "https://api.apify.com/v2";
  const r = await fetch(`${api}/acts/overpowered~email-finder/runs?timeout=100&maxTotalChargeUsd=0.10&waitForFinish=60`, { method: "POST", headers, body: JSON.stringify({ name: first, surname: last, domain }) });
  let run = (await r.json().catch(() => ({})))?.data;
  if (!r.ok || !run?.id) return null;   // Hunter fallback below
  if (["READY", "RUNNING"].includes(run.status)) run = (await (await fetch(`${api}/actor-runs/${run.id}?waitForFinish=60`, { headers })).json().catch(() => ({})))?.data || run;
  const items = ((await (await fetch(`${api}/datasets/${run.defaultDatasetId}/items?clean=true&format=json`, { headers })).json().catch(() => [])) || []) as any[];
  if (!Array.isArray(items) || !items.length) return null;
  const hit = items.find(i => /okay to send/i.test(i?.validation_status || "") && /accepted/i.test(i?.validation_analysis || ""));
  if (hit) return { email: hit.email, score: 100, status: "valid", src: "apify" };
  // Catch-all or unknown: keep the best guess but never as valid (outreach won't email it unless the score passes).
  const maybe = items.find(i => !/do not send/i.test(i?.validation_status || ""));
  return maybe ? { email: maybe.email, score: 50, status: String(maybe.validation_analysis || maybe.validation_status || "unknown").toLowerCase(), src: "apify" } : { email: null, score: null, status: "not_found", src: "apify" };
}

async function hunterEmail(domain: string, first: string, last: string, hk: string) {
  const r = await fetch(`https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(last)}&api_key=${hk}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.errors?.[0]?.details || `Hunter HTTP ${r.status}`);
  const d = j?.data || {};
  return { email: d.email || null, score: d.score ?? null, status: d.verification?.status || null, src: "hunter" };
}

// Work email for one named person at the company's domain (on demand). Apify first; Hunter only when Apify has no valid mailbox.
async function email(kind: string, key: string, name: string, role = "", typed = "") {
  let row = await getRow(kind, key);
  // A domain typed by the team (search finds no website for acronym domains like ashs.com) is saved on the company.
  const dom = String(typed || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[\/?#].*$/, "");
  if (dom && !row?.domain) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(dom)) throw new Error("That doesn't look like a domain (e.g. acme.com).");
    await save(kind, key, { domain: dom, website: `https://${dom}` }); row = await getRow(kind, key);
  }
  if (!row?.domain) throw new Error("No company website found yet. Type the company's email domain.");
  const parts = String(name).replace(/[,.]/g, " ").trim().split(/\s+/).filter(w => !/^(jr|sr|ii|iii|iv)$/i.test(w));
  const first = parts[0], last = parts[parts.length - 1];
  let d: any = await apifyEmail(row.domain, first, last);
  const hk = await secret("HUNTER_API_KEY");
  if (d?.status !== "valid" && hk) d = await hunterEmail(row.domain, first, last, hk).then(h => h.email || !d ? h : d, e => d || Promise.reject(e));
  if (!d) throw new Error("No Apify token or Hunter key saved.");
  const found = { email: d.email || null, email_score: d.score ?? null, email_status: d.status || null, email_src: d.src, email_checked: new Date().toISOString() };
  // A name the team typed in ("Someone else") is added first, marked confirmed: a person chose it.
  const known = (row.people || []).some((p: any) => p.name === name);
  const people = known ? (row.people || []).map((p: any) => p.name === name ? { ...p, ...found } : p)
    : [{ name, role: role || "other", title: null, source: "manual", status: "confirmed", ...found }, ...(row.people || [])];
  await save(kind, key, { people });
  return { ok: true, email: d.email || null, score: d.score ?? null, status: d.status || null, src: d.src };
}

// Fund GPs (13 Nov 2026, Tengku: "we need their LinkedIn URL"): the people named on the Form D, searched by name + firm on Google
// (Serper; Brave if no Serper key). Stored as signal_contacts kind 'fund', key = fund_key (one row per fund, not per vehicle).
const firmOf = (n: string) => String(n || "").replace(/\([^)]*\)/g, " ").replace(/,?\s*\b(l\.?\s?p\.?|llc|l\.?l\.?c\.?|ltd|inc|scsp)\b\.?/gi, " ")
  .replace(/\s+(?:fund\s+)?(?:[IVX]{1,4}|\d{1,2})(?:-[A-Z0-9]+)?\b.*$/i, "").replace(/\s+fund\b.*$/i, "").replace(/[,\s]+$/, "").replace(/\s+/g, " ").trim();
async function lookupFund(fundKey: string) {
  const s = (await sb.from("fund_signals").select("company_name,executives,check_keyword").eq("fund_key", fundKey).order("score", { ascending: false }).limit(1).maybeSingle()).data;
  if (!s) throw new Error("Fund not found");
  const sk = await secret("SERPER_API_KEY"), bk = sk ? "" : await secret("BRAVE_SEARCH_KEY");
  if (!sk && !bk) return { ok: false, note: "no key" };
  const firm = firmOf(s.company_name) || s.check_keyword || s.company_name;
  const row = await getRow("fund", fundKey), now = new Date().toISOString();
  const people = await Promise.all(((s.executives || []) as any[]).filter(p => p?.name).slice(0, 3).map(async (p: any) => {
    const old = (row?.people || []).find((o: any) => o.name === p.name);
    if (old?.linkedin || old?.status) return old;
    const q = `"${p.name}" ${firm} site:linkedin.com/in`;
    const res = sk ? await serper(q, sk) : await brave(q, bk);
    const hit = personProfile(res, p.name, firm);
    return { name: p.name, role: "gp", title: hit?.title || p.title || null, linkedin: hit?.linkedin || null, source: "formd", li_checked: now };
  }));
  await save("fund", fundKey, { company_name: s.company_name, people, looked_up_at: now, lookup_note: people.some(p => p.linkedin) ? null : "No LinkedIn match for the Form D names." });
  return { ok: true, found: people.filter(p => p.linkedin).length };
}
// Up to n fund targets a run (best score first, each fund once).
async function funds(n = 8) {
  const done = new Set(((await sb.from("signal_contacts").select("key").eq("kind", "fund").not("looked_up_at", "is", null)).data || []).map((r: any) => r.key));
  const rows = (await sb.from("fund_signals").select("fund_key,score").eq("verdict", "target").in("status", ["new", "added"]).not("fund_key", "is", null).order("score", { ascending: false }).limit(2000)).data || [];
  const todo = [...new Set((rows as any[]).map(r => r.fund_key))].filter(k => !done.has(k)).slice(0, n);
  // The table only takes kind 'fund' after supabase/2026-11-13-fund-contacts.sql; until then, spend nothing on searches.
  if (todo.length) { const t = await sb.from("signal_contacts").upsert({ kind: "fund", key: todo[0] }, { onConflict: "kind,key" }); if (t.error) return { funds_error: "run supabase/2026-11-13-fund-contacts.sql: " + t.error.message.slice(0, 80) }; }
  let found = 0;
  for (const k of todo) { try { found += (await lookupFund(k)).found || 0; } catch (e) { await save("fund", k, { looked_up_at: new Date().toISOString(), lookup_note: String((e as Error).message || e) }).catch(() => null); } }
  return { funds_looked_up: todo.length, fund_profiles: found };
}

async function cron() {
  const bk = await secret("BRAVE_SEARCH_KEY");
  if (!bk) return { skipped: "no Brave key" };
  const since = new Date(Date.now() - 864e5).toISOString();
  const today = (await sb.from("signal_contacts").select("key", { count: "exact", head: true }).in("kind", ["credit", "bdc", "ucc"]).gte("looked_up_at", since)).count || 0;   // fund lookups (Serper) don't use the Brave quota
  if (today >= DAILY_CAP) return { skipped: "daily cap", stale: await retryStale() };
  const done = new Set(((await sb.from("signal_contacts").select("kind,key,looked_up_at").not("looked_up_at", "is", null)).data || []).map((r: any) => `${r.kind}:${r.key}`));
  // Order: BDC and credit targets alternately (best first in each, so both outreach lanes fill), then UCC; nothing already looked up.
  const lists: Record<string, [string, string, string][]> = {};
  for (const kind of ["bdc", "credit", "ucc"]) {
    // Credit: Rescue-lane companies too (13 Nov 2026), after every refinancing target.
    let q = sb.from(TABLE[kind]).select(`${KEYCOL[kind]},company_name,score,verdict${kind === "bdc" ? ",owner_checked_at" : ""}`).in("verdict", kind === "credit" ? ["target", "rescue"] : ["target"]).in("status", ["new", "added"]);
    if (kind === "bdc") q = q.eq("lane", "refi");   // loan-sale targets are pitched to the lender, not the company
    const rows = ((await q.order("score", { ascending: false }).limit(1000)).data || []).sort((a: any, b: any) => Number(a.verdict !== "target") - Number(b.verdict !== "target"));
    // BDC: anyone not owner-checked yet goes again (owner check added 12 Oct 2026), even if contacts were found before.
    lists[kind] = (rows as any[]).filter(r => kind === "bdc" ? !r.owner_checked_at : !done.has(`${kind}:${r[KEYCOL[kind]]}`))
      .map(r => [kind, String(r[KEYCOL[kind]]), r.company_name] as [string, string, string]);
  }
  // First: companies where a new CFO / CEO came in (8-K or news) and nobody searched their LinkedIn yet.
  const fresh = ((await sb.from("signal_contacts").select("kind,key,company_name,people").in("kind", ["credit", "bdc"]).limit(3000)).data || [])
    .filter((r: any) => (r.people || []).some((p: any) => ["8k", "news"].includes(p.source) && !p.linkedin && !p.li_checked && !p.left))
    .map((r: any) => [r.kind, String(r.key), r.company_name] as [string, string, string]);
  const todo: [string, string, string][] = [...fresh];
  for (let i = 0; i < Math.max(lists.bdc.length, lists.credit.length); i++) { if (lists.bdc[i]) todo.push(lists.bdc[i]); if (lists.credit[i]) todo.push(lists.credit[i]); }
  todo.push(...lists.ucc);
  let n = 0;
  for (const [kind, key, name] of todo.slice(0, Math.min(PER_RUN, DAILY_CAP - today))) {
    try { await lookup(kind, key, name); n++; } catch (e) {
      if (String(e).includes("rate limit")) break;
      await save(kind, key, { company_name: name, looked_up_at: new Date().toISOString(), lookup_note: String((e as Error).message || e) });
      if (kind === "bdc") await sb.from("bdc_signals").update({ owner_checked_at: new Date().toISOString() }).eq("company_key", key);   // don't retry it every run
    }
  }
  const f = await funds().catch(e => ({ funds_error: String(e).slice(0, 120) }));
  return { looked_up: n, left: Math.max(0, todo.length - n), stale: await retryStale(), ...f };
}

async function ingest(body: any) {
  if (body.kind === "officers_todo") {
    const rows = (await sb.from("credit_signals").select("cik,company_name").in("verdict", ["target", "rescue", "maybe"]).in("status", ["new", "added"]).limit(2000)).data || [];
    const cut = body.all ? Infinity : Date.now() - 14 * 864e5;   // officers change often at distressed companies: re-read every 2 weeks
    const have = new Map(((await sb.from("signal_contacts").select("key,sec_checked_at").eq("kind", "credit")).data || []).map((r: any) => [r.key, r.sec_checked_at]));
    return { items: (rows as any[]).filter(r => { const t = have.get(String(r.cik)); return !t || Date.parse(t) < cut; }).map(r => ({ cik: String(r.cik), company_name: r.company_name })) };
  }
  if (body.kind === "officers") {
    let n = 0;
    for (const it of (Array.isArray(body.items) ? body.items : []).slice(0, 300)) {
      if (!it?.cik) continue;
      const key = String(Number(it.cik)), row = await getRow("credit", key);
      const sec = (it.people || []).filter((p: any) => p?.name).map((p: any) => ({ ...p, source: "sec" }));
      // SEC names replace older SEC names (officers change); people found by search or marked by the team stay.
      const kept = (row?.people || []).filter((p: any) => p.source !== "sec" || p.status || sec.some((s: any) => s.name === p.name));
      const oc = it.officer_change, merged = mergePeople(kept, sec);
      const people = oc?.people?.length ? applyChanges(merged, oc.people, { src: "8k", date: oc.date, url: oc.url }) : merged;
      await save("credit", key, { company_name: it.company_name || row?.company_name || null, people, phone: it.phone || row?.phone || null,
        website: it.website || row?.website || null, domain: it.domain || row?.domain || null, officer_change: it.officer_change || null, sec_checked_at: new Date().toISOString() });
      n++;
    }
    return { stored: n };
  }
  // CEO / CFO changes found in news by fund-web (company.js officersIn): {type, key, company_name, changes[{name, role, event, interim, date, url}]}.
  if (body.kind === "changes") {
    const t = String(body.type || ""), k = String(body.key || "");
    if (!TABLE[t] || !k) throw new Error("type and key needed");
    const row = await getRow(t, k);
    await save(t, k, { company_name: row?.company_name || body.company_name || null, people: applyChanges(row?.people || [], body.changes || [], { src: "news" }) });
    return { stored: (body.changes || []).length };
  }
  // PE owner's deal partner for a BDC borrower (fund-web checkSponsor): {type, key, company_name, person}.
  if (body.kind === "sponsor") {
    const t = String(body.type || "bdc"), k = String(body.key || ""), row = await getRow(t, k);
    if (!body.person?.name) return { stored: 0 };
    await save(t, k, { company_name: row?.company_name || body.company_name || null, people: mergePeople(row?.people || [], [body.person]) });
    return { stored: 1 };
  }
  // Same email check as the card's "Find email", for Claude's pre-send checks from SQL (7 Nov 2026; no admin login there).
  if (body.kind === "email") {
    const t = String(body.type || "credit"), k = String(body.key || ""), d = String(body.domain || "").trim().toLowerCase();
    if (d) await save(t, k, { domain: d, website: `https://${d}` });   // a checked domain replaces a wrong one (Paradium had a merch shop)
    return await email(String(body.type || "credit"), String(body.key || ""), String(body.name || "").trim(), String(body.role || ""));
  }
  throw new Error("Unknown ingest kind");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const ingestKey = req.headers.get("x-fund-ingest"), cronKey = req.headers.get("x-outerhaven-cron");
    if (ingestKey) {
      const want = await secret("FUND_INGEST_SECRET");
      if (!want || ingestKey !== want) return json({ ok: false, error: "Bad ingest key." }, 401);
      return json({ ok: true, ...(await ingest(body)) });
    }
    if (cronKey) {
      const want = await secret("LINKEDIN_CRON_SECRET");
      if (!want || cronKey !== want) return json({ ok: false, error: "Bad cron key." }, 401);
      return json({ ok: true, ...(body.action === "owners" ? await owners(Number(body.limit) || 20) : await cron()) });
    }
    const user = await admin(req);
    if (!user) return json({ ok: false, error: "Admins only." }, 403);
    const kind = String(body.kind || ""), key = String(body.key || "");
    if (kind === "fund" && key && body.action === "lookup") return json(await lookupFund(key));
    if (!TABLE[kind] || !key) return json({ ok: false, error: "kind and key needed" }, 400);
    if (body.action === "lookup") return json(await lookup(kind, key));
    if (body.action === "email") return json(await email(kind, key, String(body.name || "").trim(), String(body.role || ""), String(body.domain || "")));
    if (body.action === "mark") {
      const row = await getRow(kind, key); if (!row) return json({ ok: false, error: "No contacts stored" }, 404);
      const who = (user.email || "").split("@")[0];
      await save(kind, key, { people: (row.people || []).map((p: any) => p.name === body.name ? { ...p, status: body.status || null, by: who, at: new Date().toISOString() } : p) });
      return json({ ok: true });
    }
    return json({ ok: false, error: "Unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
