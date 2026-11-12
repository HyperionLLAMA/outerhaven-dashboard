// fund-web: checks fund targets against the open web (13 Nov 2026, Tengku). Serper (Google) first, ~$0.003 a fund: three searches,
// fetch the pages naming the manager, find the sentences in code (read.js scanPage). Exa (~$0.025 a fund) only as a fallback for
// targets where Google found nothing, and only while the budget allows. Originally Exa-only: Form D can't say whether a fund held its
// final close, for how much, whether a newer fund is already out, or the firm's total AUM. Two Exa searches per fund (its name,
// then the people on its Form D), structured summaries per page, and read.js keeps only facts quoted word for word from a page
// that names the manager. The result goes on every vehicle of the fund (fund_signals.web), then fund-signals re-judges them.
// Cron (x-outerhaven-cron = FUND_CRON_SECRET, every 30 min): action 'cron' checks the best unchecked targets (DAILY_CAP funds a
//   day; targets re-checked after RECHECK_DAYS). Admin (user JWT): action 'check' {id} = Check web now.
// Keys: SERPER_API_KEY and/or EXA_API_KEY (pasted in HQ → Fund signals → Setup, write-only). No key = nothing runs.
import { createClient } from "npm:@supabase/supabase-js@2";
import { companyQueries, readCompany, brand, has, norm, officerQuery, officersFromPages, sponsorQuery, sponsorsFromPages } from "./company.js";
import { queriesFor, summaryQuery, readResults, SCHEMA, EXCLUDE, serperQueries, scanPage, htmlText, cleanName } from "./read.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!, SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-outerhaven-cron", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const DAILY_CAP = 150;     // hard ceiling on funds a day; the monthly budget below binds first when Exa is used
const PER_RUN = 6;         // funds per 30-min run; each takes ~5-20 s (searches and page fetches in parallel)
const RECHECK_DAYS = 45;   // closes and new funds get announced; targets are looked at again after this
const DAY = 864e5;
const EST = 0.05;          // worst-case cost of one fund with Exa, used to stop before going over the budget
const SERPER_PRICE = 0.001; // per search ($50 for 50,000 credits; cheaper on bigger packs)
const EST_SERPER = 3 * SERPER_PRICE;
const PAGES = 4;
// Credit / BDC targets (company.js): 2 searches each, past year only. Separate daily cap, same monthly budget.
const CO_PER_RUN = 4, CO_DAILY_CAP = 60, CO_RECHECK_DAYS = 30, EST_CO = 3 * SERPER_PRICE;           // pages fetched per fund (those naming the manager, snippet hits first)

// Monthly budget (growth_settings.fund_web_budget, default $10, set in Fund signals → Setup), spread evenly over the days
// left so it doesn't run dry in the first week. Spend = Exa's own costDollars, logged per fund in fund_web_runs.
async function budget() {
  const cap = Number((await sb.from("growth_settings").select("fund_web_budget").eq("id", 1).maybeSingle()).data?.fund_web_budget ?? 10);
  const now = new Date(), month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), day = new Date(now); day.setUTCHours(0, 0, 0, 0);
  const rows = (await sb.from("fund_web_runs").select("cost_usd,created_at").gte("created_at", month.toISOString())).data || [];
  const spent = rows.reduce((n, r: any) => n + (Number(r.cost_usd) || 0), 0);
  const today = rows.filter((r: any) => r.created_at >= day.toISOString()).reduce((n, r: any) => n + (Number(r.cost_usd) || 0), 0);
  const daysLeft = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).getTime() / DAY - day.getTime() / DAY;
  const todayAllowance = Math.max(0, (cap - spent + today) / Math.max(1, daysLeft));
  return { cap, spent, left: cap - spent, todayLeft: Math.min(cap - spent, todayAllowance - today) };
}

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

async function exa(key: string, s: any, q: { query: string; since: string | null }) {
  const body: any = {
    query: q.query, type: "auto", numResults: 5, excludeDomains: EXCLUDE,
    contents: { text: { maxCharacters: 8000 }, summary: { query: summaryQuery(s), schema: SCHEMA } },
  };
  if (q.since) body.startPublishedDate = `${q.since}T00:00:00.000Z`;
  const r = await fetch("https://api.exa.ai/search", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body: JSON.stringify(body) });
  if (r.status === 401 || r.status === 403) throw new Error(`Exa key rejected (${r.status})`);
  if (!r.ok) throw new Error(`Exa HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  return { results: (j.results || []) as any[], cost: Number(j.costDollars?.total) || 0 };
}

async function serper(key: string, q: string, tbs?: string) {
  const r = await fetch("https://google.serper.dev/search", { method: "POST", headers: { "content-type": "application/json", "X-API-KEY": key }, body: JSON.stringify(tbs ? { q, num: 10, tbs } : { q, num: 10 }) });
  if (r.status === 401 || r.status === 403) throw new Error(`Serper key rejected (${r.status})`);
  if (!r.ok) throw new Error(`Serper HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return ((await r.json()).organic || []) as any[];
}
// A page's text, or null (blocked, paywalled, not HTML, slow). Then the Google snippet stands in for it.
async function page(url: string) {
  try {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (compatible; OuterHavenResearch/1.0)", accept: "text/html" } });
    clearTimeout(t);
    if (!r.ok || !/html|text/.test(r.headers.get("content-type") || "")) return null;
    const text = htmlText((await r.text()).slice(0, 600_000));
    return text.length > 200 ? text : null;
  } catch { return null; }
}
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
async function viaSerper(s: any, key: string) {
  const kw = String(s.check_keyword || cleanName(s.company_name)).toLowerCase();
  const hits = (await Promise.all(serperQueries(s).map(q => serper(key, q)))).flat();
  const seen = new Set<string>(), cands: any[] = [];
  for (const h of hits) {
    if (!h.link || seen.has(h.link) || EXCLUDE.includes(hostOf(h.link))) continue;
    seen.add(h.link);
    if (`${h.title} ${h.snippet}`.toLowerCase().includes(kw)) cands.push(h);
  }
  // Snippets that already read like a close / raise go first.
  cands.sort((a, b) => Number(/clos|raise|fund [ivx]+|million|billion/i.test(b.snippet || "")) - Number(/clos|raise|fund [ivx]+|million|billion/i.test(a.snippet || "")));
  const pages = await Promise.all(cands.slice(0, PAGES).map(async h => ({ h, text: await page(h.link) })));
  const results = pages.map(({ h, text }) => scanPage(s, { url: h.link, title: h.title, date: h.date, text: text || `${h.title}. ${h.snippet || ""}` }));
  return { results, cost: serperQueries(s).length * SERPER_PRICE };
}
async function viaExa(s: any, key: string) {
  const runs = await Promise.all(queriesFor(s).map(q => exa(key, s, q)));
  return { results: runs.flatMap(r => r.results), cost: runs.reduce((n, r) => n + r.cost, 0) };
}

// One fund: search, read, store on every vehicle with the same fund_key, ask fund-signals to re-judge them.
// allowExa: may fall back to Exa when Google found nothing (budget and target-only rules are the caller's).
async function checkFund(s: any, keys: { serper: string; exa: string }, allowExa: boolean) {
  let results: any[] = [], cost = 0, via = "";
  if (keys.serper) { const r = await viaSerper(s, keys.serper); results = r.results; cost += r.cost; via = "serper"; }
  let web: any = readResults(s, results);
  const found = web.final || web.first || web.later || web.aum;
  if (keys.exa && (!keys.serper || (!found && allowExa))) {
    const r = await viaExa(s, keys.exa); results = results.concat(r.results); cost += r.cost; via = via ? `${via}+exa` : "exa";
    web = readResults(s, results);
  }
  web = { ...web, via, cost: +cost.toFixed(4) };
  const ids = ((await sb.from("fund_signals").select("id").eq("fund_key", s.fund_key).eq("list", s.list)).data || []).map((x: any) => x.id);
  if (!ids.includes(s.id)) ids.push(s.id);
  // rules_version 0 = stale: if the re-judge call below fails, the fund-signals cron re-judges these within 15 minutes.
  const up = await sb.from("fund_signals").update({ web, web_checked_at: new Date().toISOString(), rules_version: 0 }).in("id", ids);
  if (up.error) throw new Error(up.error.message);
  await sb.from("fund_web_runs").insert({ fund_key: s.fund_key, signal_id: s.id, pages: web.pages, facts: web.facts, cost_usd: cost });
  const k = await secret("FUND_INGEST_SECRET");
  if (k) await fetch(`${SUPABASE_URL}/functions/v1/fund-signals`, { method: "POST", headers: { "content-type": "application/json", "x-fund-ingest": k }, body: JSON.stringify({ kind: "rejudge", ids }) }).catch(() => null);
  return web;
}

// One Credit or BDC company: Google the past year, read the pages naming it, store web, mark stale (rules_version 0) so its
// own cron re-judges it (fund-signals cron for credit, signal-contacts retryStale for BDC).
async function checkCompany(kind: "credit" | "bdc", row: any, key: string) {
  const b = norm(brand(row.company_name)), qs = companyQueries(row.company_name), oq = officerQuery(row.company_name);
  const [news, offs] = await Promise.all([Promise.all(qs.map(q => serper(key, q, "qdr:y"))).then(x => x.flat()), serper(key, oq, "qdr:y")]);
  const pick = (hits: any[], max: number) => {
    const seen = new Set<string>(), cands: any[] = [];
    for (const h of hits) {
      if (!h.link || seen.has(h.link) || EXCLUDE.includes(hostOf(h.link))) continue;
      seen.add(h.link);
      if (has(`${h.title} ${h.snippet}`, b)) cands.push(h);
    }
    return cands.slice(0, max);
  };
  const fetchAll = (cands: any[], n: number) => Promise.all(cands.map(async (h, i) => ({ url: h.link, title: h.title, date: h.date, text: (i < n ? await page(h.link) : null) || `${h.title}. ${h.snippet || ""}` })));
  // Pages beyond the first PAGES count as Google's snippet only (same-sentence rule still applies).
  const [pages, opages] = await Promise.all([fetchAll(pick(news, 12), PAGES), fetchAll(pick(offs, 8), 3)]);
  // Who holds the CEO / CFO job now (news): appointments and departures, newest first.
  const officers = officersFromPages(row.company_name, opages).slice(0, 6);
  const cost = (qs.length + 1) * SERPER_PRICE, web = { ...readCompany(row.company_name, pages), officers, via: "serper", cost };
  const table = kind === "credit" ? "credit_signals" : "bdc_signals";
  const up = await sb.from(table).update({ web, web_checked_at: new Date().toISOString(), rules_version: 0 }).eq("id", row.id);
  if (up.error) throw new Error(up.error.message);
  await sb.from("fund_web_runs").insert({ kind, fund_key: `${kind}:${row.cik || row.company_key}`, signal_id: row.id, pages: web.pages, facts: web.facts + officers.length, cost_usd: cost });
  // New / interim CEO or CFO goes onto the contact card (signal-contacts finds their LinkedIn on its next run); people who left are marked.
  const k = officers.length ? await secret("FUND_INGEST_SECRET") : "";
  if (k) await fetch(`${SUPABASE_URL}/functions/v1/signal-contacts`, { method: "POST", headers: { "content-type": "application/json", "x-fund-ingest": k },
    body: JSON.stringify({ kind: "changes", type: kind, key: kind === "credit" ? String(Number(row.cik)) : row.company_key, company_name: row.company_name, changes: officers }) }).catch(() => null);
  return web;
}
// PE-owned BDC borrower: find the owner's partner on the deal (press releases quote them), then their LinkedIn. 2 searches.
async function checkSponsor(row: any, key: string) {
  const owner = String(row.owner || ""), ok = norm(owner.replace(/,?\s+(LLC|L\.?P\.?|Inc\.?)$/i, ""));
  const hits = (await serper(key, sponsorQuery(owner, row.company_name))).filter((h: any) => h.link && has(`${h.title} ${h.snippet}`, ok) && !EXCLUDE.includes(hostOf(h.link)));
  // Page text AND Google's snippet: firm sites often render the quote with JavaScript, the snippet usually carries it.
  const pages = await Promise.all(hits.slice(0, 6).map(async (h: any, i: number) => ({ url: h.link, title: h.title, text: `${h.title}. ${h.snippet || ""}\n${(i < 4 ? await page(h.link) : null) || ""}` })));
  // Only someone quoted on THIS deal: a partner from another release (promotions, other deals) is not the deal lead.
  const best = sponsorsFromPages(row.company_name, owner, pages).find(x => x.on_deal) || null;
  let cost = SERPER_PRICE, person: any = null;
  if (best) {
    const li = (await serper(key, `"${best.name}" ${owner} site:linkedin.com/in`)).find((h: any) => /linkedin\.com\/in\//.test(h.link || "") && norm(h.title).startsWith(norm(best.name).split(" ")[0]) && norm(h.title).includes(norm(best.name).split(" ").pop()!));
    cost += SERPER_PRICE;
    person = { name: best.name, role: "sponsor", title: best.title, employer: owner, linkedin: li ? String(li.link).split("?")[0] : null, source: "news", source_url: best.url, on_deal: best.on_deal, quote: best.quote };
  }
  await sb.from("bdc_signals").update({ sponsor_checked_at: new Date().toISOString() }).eq("id", row.id);
  await sb.from("fund_web_runs").insert({ kind: "bdc", fund_key: `sponsor:${row.company_key}`, signal_id: row.id, pages: pages.length, facts: person ? 1 : 0, cost_usd: cost });
  const k = person ? await secret("FUND_INGEST_SECRET") : "";
  if (k) await fetch(`${SUPABASE_URL}/functions/v1/signal-contacts`, { method: "POST", headers: { "content-type": "application/json", "x-fund-ingest": k },
    body: JSON.stringify({ kind: "sponsor", type: "bdc", key: row.company_key, company_name: row.company_name, person }) }).catch(() => null);
  return person;
}

async function companies(key: string, budgetLeft: number) {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const done = (await sb.from("fund_web_runs").select("id", { count: "exact", head: true }).neq("kind", "fund").gte("created_at", today.toISOString())).count || 0;
  const n = Math.min(CO_PER_RUN, CO_DAILY_CAP - done, Math.floor(budgetLeft / EST_CO));
  if (n <= 0) return { skipped: done >= CO_DAILY_CAP ? "daily cap" : "budget" };
  const old = new Date(Date.now() - CO_RECHECK_DAYS * DAY).toISOString(), due = `web_checked_at.is.null,web_checked_at.lt.${old}`;
  // BDC refinancing targets and credit targets, best score first.
  const bdc = ((await sb.from("bdc_signals").select("*").eq("verdict", "target").eq("lane", "refi").or(due).order("score", { ascending: false }).limit(n)).data || []).map((r: any) => ["bdc", r]);
  const cr = ((await sb.from("credit_signals").select("*").eq("verdict", "target").or(due).order("score", { ascending: false }).limit(n)).data || []).map((r: any) => ["credit", r]);
  // Alternate BDC and credit so neither list waits for the other to finish.
  const picked = (Array.from({ length: n }, (_, i) => [bdc[i], cr[i]]).flat().filter(Boolean) as [("credit" | "bdc"), any][]).slice(0, n);
  // Plus up to 2 PE-owned refi borrowers a run: find the owner's deal partner.
  const owned = (await sb.from("bdc_signals").select("id,company_key,company_name,owner").eq("lane", "refi").not("owner", "is", null).is("sponsor_checked_at", null)
    .neq("verdict", "cut").order("score", { ascending: false }).limit(2)).data || [];
  const sponsors = await Promise.all(owned.map(async (r: any) => { try { const p = await checkSponsor(r, key); return { company: r.company_name, owner: r.owner, partner: p?.name || null, linkedin: !!p?.linkedin }; } catch (e) { return { company: r.company_name, error: String(e).slice(0, 120) }; } }));
  return { sponsors, checked: await Promise.all(picked.map(async ([k, r]) => {
    try { const w = await checkCompany(k, r, key); return { kind: k, company: r.company_name, refi: !!w.refi, adviser: !!w.adviser, sale: !!w.sale }; }
    catch (e) { return { kind: k, company: r.company_name, error: String(e instanceof Error ? e.message : e).slice(0, 160) }; }
  })) };
}

async function keysNow() { return { serper: await secret("SERPER_API_KEY"), exa: await secret("EXA_API_KEY") }; }
async function cron() {
  const keys = await keysNow();
  if (!keys.serper && !keys.exa) return { skipped: "no Serper or Exa key" };
  const est = keys.serper ? EST_SERPER : EST;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const done = (await sb.from("fund_web_runs").select("id", { count: "exact", head: true }).eq("kind", "fund").gte("created_at", today.toISOString())).count || 0;
  const b = await budget();
  if (b.todayLeft < est) return { skipped: "budget", spent: +b.spent.toFixed(2), cap: b.cap };
  const co = keys.serper ? await companies(keys.serper, b.todayLeft) : { skipped: "no Serper key" };
  if (done >= DAILY_CAP) return { skipped: "daily cap", done, companies: co };
  const old = new Date(Date.now() - RECHECK_DAYS * DAY).toISOString();
  const rows = (await sb.from("fund_signals").select("*").in("list", ["live", "fund1"]).in("verdict", ["target", "maybe"]).neq("status", "dismissed")
    .or(`web_checked_at.is.null,web_checked_at.lt.${old}`).order("score", { ascending: false }).limit(60)).data || [];
  const picked: any[] = [], fundKeys = new Set<string>();
  const n = Math.min(PER_RUN, DAILY_CAP - done, Math.floor(b.todayLeft / est));
  for (const r of rows) { if (r.fund_key && !fundKeys.has(r.fund_key)) { fundKeys.add(r.fund_key); picked.push(r); } if (picked.length >= n) break; }
  const out: any[] = [];
  let left = b.todayLeft;
  for (const s of picked) {
    // Exa fallback only for targets, and only with an Exa-sized amount of today's budget left.
    try { const w = await checkFund(s, keys, s.verdict === "target" && left >= EST); left -= w.cost; out.push({ fund: s.company_name, via: w.via, final: !!w.final, later: !!w.later, aum: w.aum?.amount || null }); }
    catch (e) { out.push({ fund: s.company_name, error: String(e instanceof Error ? e.message : e).slice(0, 160) }); if (String(e).includes("key rejected")) break; }
  }
  return { checked: out, companies: co };
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const c = req.headers.get("x-outerhaven-cron");
    if (c) {
      if (c !== await secret("FUND_CRON_SECRET")) return json({ ok: false, error: "bad cron secret" }, 401);
      // One company on demand with the cron key (spot checks from SQL): {action:'sponsor', key} / {action:'company', kind, id}.
      if (body.action === "sponsor" || body.action === "company") {
        const key = await secret("SERPER_API_KEY");
        if (!key) return json({ ok: false, error: "no Serper key" });
        if (body.action === "sponsor") {
          const row = (await sb.from("bdc_signals").select("id,company_key,company_name,owner").eq("company_key", body.key).maybeSingle()).data;
          return json({ ok: true, person: row?.owner ? await checkSponsor(row, key) : null });
        }
        const kind = body.kind === "bdc" ? "bdc" : "credit";
        const row = (await sb.from(kind === "credit" ? "credit_signals" : "bdc_signals").select("*").eq("id", body.id).maybeSingle()).data;
        return json({ ok: true, web: row ? await checkCompany(kind, row, key) : null });
      }
      return json({ ok: true, ...(await cron()) });
    }
    const user = await admin(req);
    if (!user) return json({ ok: false, error: "Admins only." }, 403);
    if (body.action === "check") {
      const keys = await keysNow();
      if (!keys.serper && !keys.exa) return json({ ok: false, error: "No Serper or Exa key yet: paste one in Fund signals → Setup." });
      const b = await budget();
      if (b.left < (keys.serper ? EST_SERPER : EST)) return json({ ok: false, error: `This month's web-check budget ($${b.cap}) is used up. Raise it in Fund signals → Setup.` });
      const s = (await sb.from("fund_signals").select("*").eq("id", body.id).maybeSingle()).data;
      if (!s) return json({ ok: false, error: "Fund not found" }, 404);
      return json({ ok: true, web: await checkFund(s, keys, b.left >= EST) });
    }
    if (body.action === "check_company") {
      const key = await secret("SERPER_API_KEY");
      if (!key) return json({ ok: false, error: "No Serper key yet: paste one in Fund signals → Setup." });
      const kind = body.kind === "bdc" ? "bdc" : "credit";
      const row = (await sb.from(kind === "credit" ? "credit_signals" : "bdc_signals").select("*").eq("id", body.id).maybeSingle()).data;
      if (!row) return json({ ok: false, error: "Company not found" }, 404);
      return json({ ok: true, web: await checkCompany(kind, row, key) });
    }
    return json({ ok: false, error: "Unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 200);
  }
});
