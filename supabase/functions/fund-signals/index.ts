// Fund signals: finds US funds raising money right now (Form D filings) and Fund I managers due to raise Fund II.
// Main source since Oct 2026: the GitHub Actions job scripts/fund_signals.py (edgartools, SEC direct) posting to
// action ingest (x-fund-ingest). Apify (logiover/sec-edgar-form-d-scraper) remains as a fallback: scan {list}, check {ids}, poll, reclassify.
// Cron (x-outerhaven-cron): poll + re-judge on rules change (+ Apify weekly scan only if fund_scan_enabled).
// Rules live in rules.js; every verdict stores its reasons.
import { createClient } from "npm:@supabase/supabase-js@2";
import { normalize, classify, readCheck, money, RULES_VERSION, normalizeCredit, classifyCredit, CREDIT_RULES_VERSION, formDTotal, managerHistory } from "./rules.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const ACTOR = "logiover~sec-edgar-form-d-scraper";
const APIFY = "https://api.apify.com/v2";
const DAY = 864e5;

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

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
  const role = await u.rpc("dashboard_role");
  return role.data === "admin" ? user : null;
}
async function settings() {
  const r = await sb.from("growth_settings").select("fund_scan_enabled,fund_monthly_budget").eq("id", 1).maybeSingle();
  return { enabled: r.data?.fund_scan_enabled === true, budget: Number(r.data?.fund_monthly_budget) || 10 };
}
// Spent this month = real cost of finished runs + the cap of runs still going (worst case).
async function spend() {
  const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  const r = await sb.from("fund_signal_runs").select("status,cost_usd,cap_usd").gte("created_at", start.toISOString());
  return (r.data || []).reduce((n, x: any) => n + (x.status === "running" ? Number(x.cap_usd) || 0 : Number(x.cost_usd) || 0), 0);
}

async function apify(path: string, init: RequestInit = {}) {
  const token = await secret("APIFY_TOKEN");
  if (!token) throw new Error("No Apify token saved (HQ → Growth → Scraper).");
  const res = await fetch(`${APIFY}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`, init);
  const body = await res.text();
  if (!res.ok) throw new Error(`Apify ${res.status}: ${body.slice(0, 200)}`);
  return JSON.parse(body);
}
async function startRun(kind: string, input: Record<string, unknown>, cap: number, params: Record<string, unknown>, by: string | null) {
  const r = await apify(`/acts/${ACTOR}/runs?maxTotalChargeUsd=${cap}&timeout=3600`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ formType: "D", proxyConfiguration: { useApifyProxy: true }, ...input }) });
  const ins = await sb.from("fund_signal_runs").insert({ kind, apify_run_id: r.data.id, dataset_id: r.data.defaultDatasetId, params: { ...params, input }, cap_usd: cap, created_by: by }).select("id").single();
  if (ins.error) throw new Error(ins.error.message);
  return ins.data.id;
}

// ---- Scans ----
// live: funds that filed in the window with II or III in the name. fund1: Fund I filings from 3–4 years ago, split
// into 3-month windows so one slow run can't cut the list short.
async function scan(list: string, from: string | undefined, to: string | undefined, by: string | null) {
  const s = await settings(), now = Date.now();
  const plan: { input: Record<string, unknown>; cap: number }[] = [];
  if (list === "live") {
    const f = from || iso(now - 30 * DAY), t = to || iso(now);
    for (const keyword of ["II", "III"]) plan.push({ input: { dateFrom: f, dateTo: t, keyword, industry: "Banking & Financial Services", minAmount: 25000000, maxResults: 300 }, cap: 1.2 });
  } else if (list === "fund1") {
    const t0 = from ? Date.parse(from) : now - 48 * 30.44 * DAY, t1 = to ? Date.parse(to) : now - 36 * 30.44 * DAY;
    for (let a = t0; a < t1; a += 91 * DAY) plan.push({ input: { dateFrom: iso(a), dateTo: iso(Math.min(a + 90 * DAY, t1)), keyword: "I", industry: "Banking & Financial Services", minAmount: 10000000, maxResults: 250 }, cap: 1 });
  } else throw new Error("Unknown list");
  const need = plan.reduce((n, p) => n + p.cap, 0), used = await spend();
  if (used + need > s.budget) throw new Error(`This scan can cost up to $${need.toFixed(2)} and only $${Math.max(0, s.budget - used).toFixed(2)} of the $${s.budget} monthly fund-signals budget is left. Raise it in the tab's settings.`);
  const ids = [];
  for (const p of plan) ids.push(await startRun(list === "live" ? "scan_live" : "scan_fund1", p.input, p.cap, { list }, by));
  return { started: ids.length, max_cost: need };
}

// ---- Fund II checks: every later filing (D and D/A) under the manager's name since the original filing ----
async function check(ids: string[], by: string | null) {
  const r = await sb.from("fund_signals").select("*").in("id", ids.slice(0, 40));
  const byMgr = new Map<string, any[]>();
  for (const s of r.data || []) { if (!s.check_keyword) continue; const k = s.manager_key; byMgr.set(k, [...(byMgr.get(k) || []), s]); }
  const cap = 0.3, need = byMgr.size * cap, used = await spend(), { budget } = await settings();
  if (used + need > budget) throw new Error(`Checks can cost up to $${need.toFixed(2)}; only $${Math.max(0, budget - used).toFixed(2)} of the monthly budget is left.`);
  let started = 0;
  for (const [, group] of byMgr) {
    const s = group[0], from = s.filing_date ? iso(Date.parse(s.filing_date) + DAY) : iso(Date.now() - 4 * 365 * DAY);
    try {
      await startRun("check", { dateFrom: from, dateTo: iso(Date.now()), keyword: s.check_keyword, formType: "D_AND_DA", maxResults: 80 }, cap, { keyword: s.check_keyword, manager_key: s.manager_key, signal_ids: group.map((x: any) => x.id) }, by);
      await sb.from("fund_signals").update({ check_status: "checking", updated_at: new Date().toISOString() }).in("id", group.map((x: any) => x.id));
      started++;
    } catch (e) { await sb.from("fund_signals").update({ check_status: "error", check_note: String(e instanceof Error ? e.message : e).slice(0, 300) }).in("id", group.map((x: any) => x.id)); }
  }
  return { started };
}

// Each row is judged with its manager's own funds (stored rows with the same manager_key + earlier funds the adviser job
// found on EDGAR), so timing can use the manager's own pace, and the step-up between funds can be scored.
const HIST_COLS = "id,manager_key,company_name,fund_no,cik,first_sale,filing_date,sold,offering,investors,executives,city";
async function peersOf(rows: any[]) {
  const keys = [...new Set(rows.filter(r => (r.list === "fund1" || r.list === "live") && r.manager_key).map(r => r.manager_key))];
  const out: any[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    for (let from = 0; ; from += 1000) {
      const r = await sb.from("fund_signals").select(HIST_COLS).in("manager_key", keys.slice(i, i + 100)).range(from, from + 999);
      out.push(...(r.data || []));
      if ((r.data || []).length < 1000) break;
    }
  }
  const by = new Map<string, any[]>();
  for (const p of out) by.set(p.manager_key, [...(by.get(p.manager_key) || []), p]);
  return by;
}
async function judge(rows: any[]) {
  const peers = await peersOf(rows);
  const now = new Date().toISOString();
  const out = rows.map(s => {
    const history = s.list === "fund1" || s.list === "live" ? managerHistory(s, peers.get(s.manager_key) || []) : null;
    const c = classify({ ...s, history });
    // Only the judged columns (+ the NOT NULL keys the upsert needs), so a check result, star or note saved meanwhile is never overwritten.
    return { id: s.id, accession: s.accession, list: s.list, company_name: s.company_name, verdict: c.verdict, score: c.score, reasons: c.reasons, stage: c.stage, strategy: c.strategy, next_expected: c.next_expected,
      history, rules_version: RULES_VERSION, updated_at: now };
  });
  // Upserted 500 at a time (19 Oct 2026): one update call per row took ~3 hours for 16K rows at 1,500 a run.
  for (let i = 0; i < out.length; i += 500) {
    const r = await sb.from("fund_signals").upsert(out.slice(i, i + 500), { onConflict: "id" });
    if (r.error) throw new Error(`re-judge write failed: ${r.error.message}`);
  }
}
// Re-judge every stale row, a page at a time (PostgREST returns at most 1,000 rows per call), best first, inside a time budget.
async function judgeStale(budgetMs = 100_000) {
  const t0 = Date.now(); let n = 0;
  while (Date.now() - t0 < budgetMs) {
    const page = (await sb.from("fund_signals").select("*").lt("rules_version", RULES_VERSION).order("score", { ascending: false }).limit(1000)).data || [];
    if (!page.length) break;
    await judge(page); n += page.length;
  }
  return n;
}

// ---- Storing results (shared by Apify runs and the GitHub edgartools job) ----
async function ingestScan(list: string, items: any[]) {
  const seen = new Set<string>();
  const rows = items.filter(it => it.companyName).map(it => normalize(it, list)).filter(r => !seen.has(r.accession) && seen.add(r.accession));
  if (!rows.length) return 0;
  const accs = rows.map(r => r.accession);
  const existing = new Set(((await sb.from("fund_signals").select("accession").in("accession", accs)).data || []).map((x: any) => x.accession));
  // New filings are inserted; known ones get fresh numbers but keep their status, check and notes.
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const fresh = chunk.filter(r => !existing.has(r.accession)), known = chunk.filter(r => existing.has(r.accession));
    if (fresh.length) { const ins = await sb.from("fund_signals").insert(fresh); if (ins.error) throw new Error(ins.error.message); }
    await Promise.all(known.map(r => { const { accession, list: _l, ...rest } = r; return sb.from("fund_signals").update({ ...rest, updated_at: new Date().toISOString() }).eq("accession", accession); }));
  }
  await judge((await sb.from("fund_signals").select("*").in("accession", accs)).data || []);
  return rows.filter(r => !existing.has(r.accession)).length;
}
async function ingestCheck(ids: string[], items: any[], error: string | null, at = new Date().toISOString()) {
  const sigs = (await sb.from("fund_signals").select("*").in("id", ids)).data || [];
  for (const s of sigs) {
    if (error) { await sb.from("fund_signals").update({ check_status: "error", check_note: error, checked_at: at }).eq("id", s.id); continue; }
    const c = readCheck(s, items), patch: any = { check_status: c.status, check_note: c.note, later: c.later, later_count: c.funds_since, checked_at: at };
    if (c.latest) {
      if (c.latest.sold != null) patch.sold = c.latest.sold;
      if (c.latest.form === "D/A" && c.latest.date && (!s.amended_at || c.latest.date > s.amended_at)) patch.amended_at = c.latest.date;
      if (c.latest.offering != null) patch.offering = c.latest.offering;
      const off = patch.offering ?? s.offering, sold = patch.sold ?? s.sold;
      if (Date.now() - Date.parse(c.latest.date) < 400 * DAY && (!off || sold / off < 0.6)) patch.still_raising = `${money(sold)}${off ? ` of ${money(off)}` : ''} as of ${c.latest.date}`;
    }
    await sb.from("fund_signals").update(patch).eq("id", s.id);
  }
  await judge((await sb.from("fund_signals").select("*").in("id", ids)).data || []);
}

// ---- Credit signals (scripts/credit_signals.py): one row per company (CIK); numbers refresh, status/notes stay ----
async function judgeCredit(rows: any[]) {
  for (let i = 0; i < rows.length; i += 20) await Promise.all(rows.slice(i, i + 20).map(s => {
    const c = classifyCredit(s);
    return sb.from("credit_signals").update({ verdict: c.verdict, score: c.score, reasons: c.reasons, tags: c.tags, rules_version: CREDIT_RULES_VERSION }).eq("id", s.id);
  }));
}
async function ingestCredit(items: any[], params: any) {
  const seen = new Set<string>();
  const rows = items.filter(it => it && it.cik && it.name).map(normalizeCredit).filter(r => !seen.has(r.cik) && seen.add(r.cik))
    .map(r => ({ ...r, last_run: params.run || null, on_latest: true }));
  if (!rows.length) return 0;
  const ciks = rows.map(r => r.cik);
  const existing = new Set(((await sb.from("credit_signals").select("cik").in("cik", ciks)).data || []).map((x: any) => x.cik));
  const fresh = rows.filter(r => !existing.has(r.cik)), known = rows.filter(r => existing.has(r.cik));
  if (fresh.length) { const ins = await sb.from("credit_signals").insert(fresh); if (ins.error) throw new Error(ins.error.message); }
  await Promise.all(known.map(r => sb.from("credit_signals").update({ ...r, updated_at: new Date().toISOString() }).eq("cik", r.cik)));
  await judgeCredit((await sb.from("credit_signals").select("*").in("cik", ciks)).data || []);
  await sb.from("credit_signal_runs").insert({ items: rows.length, added: fresh.length, params });
  return fresh.length;
}

// GitHub job (x-fund-ingest = FUND_INGEST_SECRET). Each call is logged as a run with cost 0.
async function ingest(body: any) {
  const now = new Date().toISOString();
  const logRun = (kind: string, items: number, added: number, params: any, error: string | null = null) =>
    sb.from("fund_signal_runs").insert({ kind, status: error ? "failed" : "done", items, added, cost_usd: 0, cap_usd: 0, params: { source: "github", ...params }, error, finished_at: now });
  if (body.kind === "todo") {
    const cols = "id,manager_key,check_keyword,cik,filing_date,fund_no,company_name,executives";
    const queued = (await sb.from("fund_signals").select(cols).eq("check_status", "queued").limit(300)).data || [];
    // Targets first, then maybes (often "size unknown": the latest amendment can settle it).
    const fresh = [...((await sb.from("fund_signals").select(cols).eq("list", "fund1").eq("verdict", "target").is("check_status", null).limit(300)).data || []),
      ...((await sb.from("fund_signals").select(cols).eq("list", "fund1").eq("verdict", "maybe").is("check_status", null).limit(300)).data || [])];
    const stale = (await sb.from("fund_signals").select(cols).eq("list", "fund1").eq("verdict", "target").eq("check_status", "clear").lt("checked_at", new Date(Date.now() - 30 * DAY).toISOString()).limit(30)).data || [];
    const stuck = (await sb.from("fund_signals").select(cols).eq("check_status", "checking").lt("updated_at", new Date(Date.now() - 6 * 3600e3).toISOString()).limit(30)).data || [];
    // Checks that failed (an SEC filing couldn't be read) are retried after an hour.
    const failed = (await sb.from("fund_signals").select(cols).eq("check_status", "error").lt("updated_at", new Date(Date.now() - 3600e3).toISOString()).limit(60)).data || [];
    const all = [...queued, ...stuck, ...failed, ...fresh, ...stale].filter((x, i, a) => a.findIndex(y => y.id === x.id) === i).slice(0, 300);
    if (all.length) await sb.from("fund_signals").update({ check_status: "checking", updated_at: now }).in("id", all.map(x => x.id));
    return { signals: all };
  }
  // ---- Cadence study (scripts/fund_signals.py --mode study1/study2) ----
  if (body.kind === "study_add") {
    const fundNo = Number(body.fund_no) || 1, cohort = String(body.cohort || "");
    const rows = (Array.isArray(body.items) ? body.items.slice(0, 200) : []).filter((it: any) => it.companyName).map((it: any) => {
      const n = normalize(it, "fund1");
      return { cohort, accession: `${cohort}:${n.accession}`, company_name: n.company_name, cik: n.cik, fund_no: fundNo, manager_key: n.manager_key, check_keyword: n.check_keyword,
        filing_date: n.filing_date, offering: n.offering, sold: n.sold, state: n.state, executives: n.executives };
    });
    if (rows.length) { const r = await sb.from("fund_gap_study").upsert(rows, { onConflict: "accession", ignoreDuplicates: true }); if (r.error) throw new Error(r.error.message); }
    return { added: rows.length };
  }
  if (body.kind === "study_todo") {
    const r = await sb.from("fund_gap_study").select("id,company_name,cik,fund_no,manager_key,check_keyword,filing_date,executives").eq("cohort", String(body.cohort || "")).is("status", null).limit(1000);
    return { rows: r.data || [] };
  }
  if (body.kind === "study_check") {
    const row = (await sb.from("fund_gap_study").select("*").eq("id", body.id).maybeSingle()).data;
    if (!row) throw new Error("study row not found");
    if (body.error) { await sb.from("fund_gap_study").update({ status: "error", note: String(body.error).slice(0, 300), checked_at: now }).eq("id", row.id); return { status: "error" }; }
    const c = readCheck(row, Array.isArray(body.items) ? body.items.slice(0, 800) : []);
    const nx = c.status === "next" ? (c.later || []).find((x: any) => !x.unconfirmed && !x.other_manager) : null;
    const gap = nx?.date && row.filing_date ? Math.round((Date.parse(nx.date) - Date.parse(row.filing_date)) / (30.44 * DAY) * 10) / 10 : null;
    await sb.from("fund_gap_study").update({ status: c.status, note: c.note, later: c.later, later_count: c.funds_since, next_name: nx?.name || null, next_date: nx?.date || null,
      next_renamed: nx ? !!nx.renamed : null, gap_months: gap, checked_at: now }).eq("id", row.id);
    return { status: c.status, gap_months: gap };
  }
  // ---- Hard data checks (scripts/fund_signals.py selftest / audit) ----
  if (body.kind === "audit_todo") {
    // Every list row a person could act on: skip deal vehicles and big brands (cut for reasons numbers can't change).
    const out: any[] = [];
    for (let from = 0; ; from += 1000) {
      const r = await sb.from("fund_signals").select("id,cik,filing_date,amended_at,company_name,reasons").in("list", ["live", "fund1"]).not("cik", "is", null).range(from, from + 999);
      if (r.error) throw new Error(r.error.message);
      for (const x of r.data || []) if (!(x.reasons || []).some((y: any) => /Single-deal vehicle|Big brand/.test(y.text || ""))) out.push({ id: x.id, cik: x.cik, filing_date: x.filing_date, amended_at: x.amended_at, company_name: x.company_name });
      if ((r.data || []).length < 1000) break;
    }
    return { rows: out };
  }
  if (body.kind === "audit_fix") {
    const a = body.amendment || {}, off = Number(String(a.offering ?? "").replace(/[$,\s]/g, ""));
    const patch: any = { amended_at: a.date || null, amendment_url: a.url || null, updated_at: now };
    if (a.offering != null) { patch.offering = Number.isFinite(off) && String(a.offering).trim() !== "" ? off : null; patch.offering_text = patch.offering == null ? a.offering : null; }
    if (a.sold != null && a.sold !== "") patch.sold = Number(a.sold);
    if (a.investors != null && a.investors !== "") patch.investors = Number(a.investors);
    if (a.firstSale) patch.first_sale = String(a.firstSale).slice(0, 10);
    const r = await sb.from("fund_signals").update(patch).eq("id", body.id);
    if (r.error) throw new Error(r.error.message);
    await judge((await sb.from("fund_signals").select("*").eq("id", body.id)).data || []);
    return { fixed: 1 };
  }
  if (body.kind === "data_check") {
    const r = await sb.from("fund_data_checks").insert({ kind: String(body.check || "audit"), ok: !!body.ok, checked: body.checked || 0, stale: body.stale || 0,
      fixed: body.fixed || 0, errors: body.errors || 0, failures: Array.isArray(body.failures) ? body.failures.slice(0, 50) : [] });
    if (r.error) throw new Error(r.error.message);
    return { logged: true };
  }
  if (body.kind === "requeue") {
    // Re-check every Fund I target / maybe already checked (e.g. after the check learned to search people's names).
    const r = await sb.from("fund_signals").update({ check_status: "queued", updated_at: now }).eq("list", "fund1").in("check_status", ["clear", "unsure", "error"]).neq("verdict", "cut").select("id");
    if (r.error) throw new Error(r.error.message);
    return { queued: (r.data || []).length };
  }
  // ---- Adviser size (scripts/adviser_aum.py): Form ADV totals per fund lead ----
  if (body.kind === "adviser_todo") {
    const out: any[] = [];
    for (let from = 0; ; from += 1000) {
      const r = await sb.from("fund_signals").select("id,list,fund_no,cik,company_name,manager_key,check_keyword,executives,executives_text,state,city,adviser_checked_at,manager_formd_total,prior_checked:prior_funds").in("list", ["live", "fund1"]).neq("verdict", "cut").range(from, from + 999);
      if (r.error) throw new Error(r.error.message);
      // Checked = earlier funds found. An empty lookup is retried: a Fund II always has a Fund I somewhere (21 Oct 2026).
      out.push(...(r.data || []).map((x: any) => ({ ...x, prior_checked: Array.isArray(x.prior_checked) && x.prior_checked.length > 0 })));
      if ((r.data || []).length < 1000) break;
    }
    return { rows: out };
  }
  if (body.kind === "adviser") {
    const rows = (Array.isArray(body.rows) ? body.rows.slice(0, 300) : []).filter((x: any) => x && x.id);
    if (!rows.length) return { updated: 0 };
    const sigs = (await sb.from("fund_signals").select("id,manager_key,company_name,executives,city,manager_formd_total,manager_formd_funds,prior_funds").in("id", rows.map((x: any) => x.id))).data || [];
    const keys = [...new Set(sigs.map((x: any) => x.manager_key).filter(Boolean))];
    const peers: any[] = [];
    for (let i = 0; i < keys.length; i += 100) peers.push(...((await sb.from("fund_signals").select("id,manager_key,company_name,fund_no,sold,executives,city").in("manager_key", keys.slice(i, i + 100))).data || []));
    const num = (v: any) => v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
    await Promise.all(rows.map(async (a: any) => {
      const s = sigs.find((x: any) => x.id === a.id); if (!s) return;
      // Earlier funds found on EDGAR by the GitHub job (extras): same manager name AND a shared named person, judged by formDTotal.
      const extras = Array.isArray(a.extras) ? a.extras.slice(0, 40).filter((it: any) => it && it.companyName).map((it: any) => ({ id: `x:${it.accessionNumber || it.companyName}`, ...normalize(it, "fund1") })) : null;
      // No lookup this run: still count the earlier funds found before (21 Oct 2026: Fund II totals left out Fund I).
      const stored = (s.prior_funds || []).map((x: any, i: number) => ({ id: `p:${i}`, ...x }));
      const got = formDTotal(s, extras ? [...peers, ...extras] : [...peers, ...stored]);
      // Without an EDGAR lookup this run, keep the larger total found before (a daily run never shrinks it).
      const keep = !extras && (Number(s.manager_formd_total) || 0) > got.total;
      const fd = keep ? { total: Number(s.manager_formd_total), funds: s.manager_formd_funds || got.funds } : got;
      const raum = num(a.adviser_raum), gav = num(a.adviser_pf_gav), adv = Math.max(raum || 0, gav || 0);
      const total = Math.max(adv, fd.total);
      const src = !total ? null : adv >= fd.total
        ? `${raum && raum >= (gav || 0) ? "assets under management" : "private fund assets"} on ${a.adviser_name}'s Form ADV`
        : `Form D raises across ${fd.funds} fund${fd.funds === 1 ? "" : "s"}`;
      await sb.from("fund_signals").update({ adviser_crd: a.adviser_crd || null, adviser_name: a.adviser_name || null, adviser_type: a.adviser_type || null,
        adviser_raum: raum, adviser_pf_gav: gav, adviser_pf_count: num(a.adviser_pf_count), adviser_match: a.adviser_match || null,
        adviser_filed: a.adviser_filed || null, adviser_checked_at: now, manager_total: total || null, manager_total_src: src,
        manager_formd_total: fd.total || null, manager_formd_funds: fd.funds || null,
        // Earlier funds found on EDGAR, kept for the manager history (own pace, step-up). Only when this run looked them up.
        ...(extras ? { prior_funds: extras.map((x: any) => ({ company_name: x.company_name, manager_key: x.manager_key, fund_no: x.fund_no, cik: x.cik, first_sale: x.first_sale,
          filing_date: x.filing_date, sold: x.sold, offering: x.offering, investors: x.investors, executives: x.executives, city: x.city })) } : {}) }).eq("id", a.id);
    }));
    await judge((await sb.from("fund_signals").select("*").in("id", rows.map((x: any) => x.id))).data || []);
    return { updated: rows.length };
  }
  if (body.kind === "credit") {
    const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
    return { added: await ingestCredit(items, { period: body.period || null, run: body.run || null, source: "github", stats: body.stats || null }) };
  }
  if (body.kind === "credit_done") {
    // End of a full run: rows this run didn't send no longer show a trigger. Cut them (kept, status untouched).
    if (!body.run) throw new Error("run missing");
    const gone = (await sb.from("credit_signals").select("*").or(`last_run.is.null,last_run.neq."${body.run}"`).eq("on_latest", true)).data || [];
    if (gone.length) {
      await sb.from("credit_signals").update({ on_latest: false }).in("id", gone.map((g: any) => g.id));
      await judgeCredit(gone.map((g: any) => ({ ...g, on_latest: false })));
    }
    return { dropped: gone.length };
  }
  if (body.kind === "scan") {
    const list = body.list === "live" ? "live" : "fund1", items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
    const added = await ingestScan(list, items);
    await logRun(list === "live" ? "scan_live" : "scan_fund1", items.length, added, { list, from: body.from, to: body.to });
    return { added };
  }
  if (body.kind === "check" || body.kind === "check_error") {
    const ids = (body.signal_ids || []).slice(0, 40), items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
    await ingestCheck(ids, items, body.kind === "check_error" ? String(body.error || "Check failed").slice(0, 300) : null);
    await logRun("check", items.length, 0, { signal_ids: ids }, body.kind === "check_error" ? String(body.error || "") : null);
    return { checked: ids.length };
  }
  throw new Error("Unknown ingest kind");
}

// ---- Poll: collect finished runs, store, judge ----
async function poll() {
  const runs = (await sb.from("fund_signal_runs").select("*").eq("status", "running").order("created_at").limit(20)).data || [];
  let finished = 0;
  for (const run of runs) {
    let info: any;
    try { info = (await apify(`/actor-runs/${run.apify_run_id}`)).data; } catch (e) { continue; }
    const age = Date.now() - Date.parse(run.created_at);
    if (["READY", "RUNNING"].includes(info.status)) {
      if (age < 2 * 3600e3) continue;
      try { await apify(`/actor-runs/${run.apify_run_id}/abort`, { method: "POST" }); } catch { }
    }
    let items: any[] = [];
    try { items = await apify(`/datasets/${run.dataset_id}/items?clean=true&format=json&limit=1000`); } catch { }
    const ok = info.status === "SUCCEEDED" || items.length > 0;
    const out: any = { status: ok ? "done" : "failed", items: items.length, cost_usd: Number(info.usageTotalUsd) || 0, finished_at: new Date().toISOString(), error: ok ? (info.status === "SUCCEEDED" ? null : `Run ${info.status}; kept the ${items.length} results it found`) : `Run ${info.status}` };
    if (run.kind === "check") await ingestCheck(run.params?.signal_ids || [], items, ok ? null : out.error, out.finished_at);
    else if (ok) out.added = await ingestScan(run.kind === "scan_live" ? "live" : "fund1", items);
    await sb.from("fund_signal_runs").update(out).eq("id", run.id);
    finished++;
  }
  return { checked: runs.length, finished };
}

// Weekly (cron, switch on): last week's live filings, the Fund I week that just turned 3.5 years old, and a Fund II
// check on new Fund I targets.
async function weekly() {
  const s = await settings(); if (!s.enabled) return { weekly: "off" };
  const last = await sb.from("fund_signal_runs").select("created_at").in("kind", ["scan_live"]).is("created_by", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (last.data && Date.now() - Date.parse(last.data.created_at) < 6.5 * DAY) return { weekly: "not due" };
  const now = Date.now(), out: any = {};
  try { out.live = await scan("live", iso(now - 8 * DAY), iso(now), null); } catch (e) { out.live = String(e); }
  const c = now - 42 * 30.44 * DAY;
  try { out.fund1 = await scan("fund1", iso(c - 7 * DAY), iso(c), null); } catch (e) { out.fund1 = String(e); }
  const todo = (await sb.from("fund_signals").select("id").eq("list", "fund1").eq("verdict", "target").is("check_status", null).limit(20)).data || [];
  if (todo.length) { try { out.checks = await check(todo.map((x: any) => x.id), null); } catch (e) { out.checks = String(e); } }
  return out;
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const ingestKey = req.headers.get("x-fund-ingest");
    if (ingestKey) {
      const want = await secret("FUND_INGEST_SECRET");
      if (!want || ingestKey !== want) return json({ ok: false, error: "Bad ingest key. Copy it again from HQ → Pipeline → Fund signals → Setup." }, 401);
      return json({ ok: true, ...(await ingest(body)) });
    }
    const cron = req.headers.get("x-outerhaven-cron");
    if (cron) {
      if (cron !== await secret("FUND_CRON_SECRET")) return json({ ok: false, error: "bad cron secret" }, 401);
      const p = await poll();
      const stale = await judgeStale();
      const staleCredit = (await sb.from("credit_signals").select("*").lt("rules_version", CREDIT_RULES_VERSION).limit(500)).data || [];
      if (staleCredit.length) await judgeCredit(staleCredit);
      return json({ ok: true, poll: p, rejudged: stale + staleCredit.length, weekly: await weekly() });
    }
    const user = await admin(req);
    if (!user) return json({ ok: false, error: "Admins only." }, 403);
    if (body.action === "scan") return json({ ok: true, ...(await scan(body.list, body.from, body.to, user.id)) });
    if (body.action === "queue") {
      const ids = (body.ids || []).slice(0, 200);
      const r = await sb.from("fund_signals").update({ check_status: "queued", updated_at: new Date().toISOString() }).in("id", ids).or("check_status.is.null,check_status.neq.checking").select("id");
      if (r.error) throw new Error(r.error.message);
      await judge((await sb.from("fund_signals").select("*").in("id", ids)).data || []);
      return json({ ok: true, queued: (r.data || []).length });
    }
    if (body.action === "check") return json({ ok: true, ...(await check(body.ids || [], user.id)) });
    if (body.action === "poll") return json({ ok: true, ...(await poll()) });
    if (body.action === "reclassify") {
      const rows = (await sb.from("fund_signals").select("*").limit(5000)).data || [];
      await judge(rows); return json({ ok: true, judged: rows.length });
    }
    if (body.action === "status") { const s = await settings(); return json({ ok: true, ...s, spent: await spend() }); }
    return json({ ok: false, error: "Unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 200);
  }
});
