// fund-web: checks fund targets against the open web with Exa (13 Nov 2026, Tengku). Form D can't say whether a fund held its
// final close, for how much, whether a newer fund is already out, or the firm's total AUM. Two Exa searches per fund (its name,
// then the people on its Form D), structured summaries per page, and read.js keeps only facts quoted word for word from a page
// that names the manager. The result goes on every vehicle of the fund (fund_signals.web), then fund-signals re-judges them.
// Cron (x-outerhaven-cron = FUND_CRON_SECRET, every 30 min): action 'cron' checks the best unchecked targets (DAILY_CAP funds a
//   day; targets re-checked after RECHECK_DAYS). Admin (user JWT): action 'check' {id} = Check web now.
// Key: EXA_API_KEY (pasted in HQ → Fund signals → Setup, write-only). No key = nothing runs.
import { createClient } from "npm:@supabase/supabase-js@2";
import { queriesFor, summaryQuery, readResults, SCHEMA, EXCLUDE } from "./read.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!, SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-outerhaven-cron", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });
const DAILY_CAP = 40;      // funds a day by the cron: ~2 searches x 5 pages with summaries each (roughly $0.03-0.05 a fund)
const PER_RUN = 4;         // funds per 30-min run; each takes ~10-25 s (two searches in parallel)
const RECHECK_DAYS = 45;   // closes and new funds get announced; targets are looked at again after this
const DAY = 864e5;

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

// One fund: search, read, store on every vehicle with the same fund_key, ask fund-signals to re-judge them.
async function checkFund(s: any, key: string) {
  const runs = await Promise.all(queriesFor(s).map(q => exa(key, s, q)));
  const results = runs.flatMap(r => r.results), cost = runs.reduce((n, r) => n + r.cost, 0);
  const web = { ...readResults(s, results), cost: +cost.toFixed(4) };
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

async function cron() {
  const key = await secret("EXA_API_KEY");
  if (!key) return { skipped: "no Exa key" };
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const done = (await sb.from("fund_web_runs").select("id", { count: "exact", head: true }).gte("created_at", today.toISOString())).count || 0;
  if (done >= DAILY_CAP) return { skipped: "daily cap", done };
  const old = new Date(Date.now() - RECHECK_DAYS * DAY).toISOString();
  const rows = (await sb.from("fund_signals").select("*").in("list", ["live", "fund1"]).in("verdict", ["target", "maybe"]).neq("status", "dismissed")
    .or(`web_checked_at.is.null,web_checked_at.lt.${old}`).order("score", { ascending: false }).limit(60)).data || [];
  const picked: any[] = [], keys = new Set<string>();
  for (const r of rows) { if (r.fund_key && !keys.has(r.fund_key)) { keys.add(r.fund_key); picked.push(r); } if (picked.length >= Math.min(PER_RUN, DAILY_CAP - done)) break; }
  const out: any[] = [];
  for (const s of picked) {
    try { const w = await checkFund(s, key); out.push({ fund: s.company_name, final: !!w.final, later: !!w.later, aum: w.aum?.amount || null }); }
    catch (e) { out.push({ fund: s.company_name, error: String(e instanceof Error ? e.message : e).slice(0, 160) }); if (String(e).includes("key rejected")) break; }
  }
  return { checked: out };
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const c = req.headers.get("x-outerhaven-cron");
    if (c) {
      if (c !== await secret("FUND_CRON_SECRET")) return json({ ok: false, error: "bad cron secret" }, 401);
      return json({ ok: true, ...(await cron()) });
    }
    const user = await admin(req);
    if (!user) return json({ ok: false, error: "Admins only." }, 403);
    if (body.action === "check") {
      const key = await secret("EXA_API_KEY");
      if (!key) return json({ ok: false, error: "No Exa key yet: paste it in Fund signals → Setup." });
      const s = (await sb.from("fund_signals").select("*").eq("id", body.id).maybeSingle()).data;
      if (!s) return json({ ok: false, error: "Fund not found" }, 404);
      return json({ ok: true, web: await checkFund(s, key) });
    }
    return json({ ok: false, error: "Unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 200);
  }
});
