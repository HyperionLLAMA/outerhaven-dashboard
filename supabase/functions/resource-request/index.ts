// Queues a lead-magnet resource and starts the "OuterHaven resource builder" Claude Code routine.
// The routine runs on the owner's Claude subscription; it reads the job from resource_jobs,
// builds the resource with the lead-magnet-resource-builder skill and writes the result back.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
const text = (v: unknown, max = 20000) => typeof v === "string" ? v.trim().slice(0, max) : "";
const FORMATS = ["notion", "pdf", "list"], POSTERS = ["Peter Plaut", "Tengku Harris", "Chase Hamby", "Anaz Azlan"];
const FIRE_PREFIX = "https://api.anthropic.com/v1/claude_code/routines/";

async function caller(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const userSb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: { user } } = await userSb.auth.getUser();
  if (!user) return null;
  const role = await userSb.rpc("dashboard_role");
  if (role.error || !["admin", "ops"].includes(role.data)) return null;
  return { id: user.id, email: user.email || "", role: role.data as string };
}

async function secrets() {
  const { data } = await sb.from("integration_secrets").select("key,secret_value").in("key", ["ROUTINE_FIRE_URL", "ROUTINE_FIRE_TOKEN"]);
  const m = Object.fromEntries((data || []).map(r => [r.key, r.secret_value]));
  return { url: m.ROUTINE_FIRE_URL as string | undefined, token: m.ROUTINE_FIRE_TOKEN as string | undefined };
}

async function usedToday() {
  const now = new Date(), myt = new Date(now.getTime() + 8 * 3600e3);
  const start = new Date(Date.UTC(myt.getUTCFullYear(), myt.getUTCMonth(), myt.getUTCDate()) - 8 * 3600e3).toISOString();
  const { count } = await sb.from("resource_jobs").select("id", { count: "exact", head: true }).eq("kind", "resource").neq("status", "cancelled").gte("fired_at", start);
  return count || 0;
}

async function fire(jobId: string) {
  const { url, token } = await secrets();
  if (!url || !token) throw new Error("The resource builder isn't connected yet. An admin needs to paste the routine URL and token in Resources → Settings.");
  if (!url.startsWith(FIRE_PREFIX) || !url.endsWith("/fire")) throw new Error("The saved routine URL doesn't look right. It should start with " + FIRE_PREFIX + " and end with /fire.");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`, "anthropic-beta": "experimental-cc-routine-2026-04-01",
      "anthropic-version": "2023-06-01", "content-type": "application/json",
    },
    body: JSON.stringify({ text: `resource_job_id: ${jobId}` }),
  });
  const body = await res.text();
  if (!res.ok) {
    let msg = body.slice(0, 300);
    try { msg = JSON.parse(body)?.error?.message || msg; } catch { }
    throw new Error(res.status === 401 ? "Claude rejected the routine token. Generate a new one and paste it in Settings." : res.status === 429 ? "Claude's daily routine limit is used up for today. Try again tomorrow." : `Claude returned ${res.status}: ${msg}`);
  }
  const data = JSON.parse(body);
  return data.claude_code_session_url as string | undefined;
}

async function fireAndRecord(jobId: string) {
  try {
    const session = await fire(jobId);
    await sb.from("resource_jobs").update({ session_url: session || null, fired_at: new Date().toISOString(), status: "queued", error: null, progress: "Waiting for Claude to start" }).eq("id", jobId);
    return { ok: true, id: jobId, session_url: session };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // fired_at cleared so a failed fire doesn't use up the daily cap
    await sb.from("resource_jobs").update({ status: "failed", error: msg, fired_at: null, finished_at: new Date().toISOString() }).eq("id", jobId);
    return { ok: false, id: jobId, error: msg };
  }
}

// Weekly growth analysis: same routine, job kind 'analysis'. Started by pg_cron (shared secret) or an admin.
async function startAnalysis(by: string) {
  const myt = new Date(Date.now() + 8 * 3600e3), dow = (myt.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(myt.getUTCFullYear(), myt.getUTCMonth(), myt.getUTCDate() - dow)).toISOString().slice(0, 10);
  const open = await sb.from("resource_jobs").select("id").eq("kind", "analysis").in("status", ["queued", "building"]).gte("created_at", new Date(Date.now() - 3 * 3600e3).toISOString()).limit(1);
  if (open.data?.length) return { ok: false, error: "An analysis is already running." };
  // The routine can't read the private bucket: hand it week-long signed links to the saved creatives (last 8 weeks).
  const since = new Date(Date.now() - 56 * 864e5).toISOString();
  const { data: posts } = await sb.from("daily_ops_posts").select("id,creative_path,creative_paths").eq("is_repost", false).gte("posted_at", since).not("creative_path", "is", null).neq("creative_path", "unavailable").limit(200);
  const creatives: Record<string, string> = {}, slides: Record<string, string[]> = {};
  for (const p of posts || []) {
    const { data } = await sb.storage.from("growth-assets").createSignedUrl(p.creative_path, 7 * 86400); if (data?.signedUrl) creatives[p.id] = data.signedUrl;
    // Every saved image / slide / PDF of the post (scraper v11), in order, so the breakdown sees the whole creative.
    const all = (Array.isArray(p.creative_paths) ? p.creative_paths : []).map((x: any) => x?.path).filter(Boolean);
    if (all.length > 1 || all.some((x: string) => x.endsWith(".pdf"))) {
      const s = await sb.storage.from("growth-assets").createSignedUrls(all, 7 * 86400);
      slides[p.id] = (s.data || []).map((x: any) => x.signedUrl).filter(Boolean);
    }
  }
  const { data: row, error } = await sb.from("resource_jobs").insert({ kind: "analysis", format: "analysis", topic: `Weekly growth analysis · week of ${monday}`, requested_by: by, fired_at: new Date().toISOString(), payload: { week_start: monday, creatives, slides } }).select("id").single();
  if (error) return { ok: false, error: error.message };
  return await fireAndRecord(row.id);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const cron = req.headers.get("x-outerhaven-cron");
  if (cron) {
    const { data: sec } = await sb.from("integration_secrets").select("secret_value").eq("key", "LINKEDIN_CRON_SECRET").maybeSingle();
    if (!sec?.secret_value || cron !== sec.secret_value) return json({ ok: false, error: "unauthorized" }, 401);
    const { data: st } = await sb.from("growth_settings").select("analysis_enabled").eq("id", 1).single();
    if (st && st.analysis_enabled === false) return json({ ok: true, ran: false, reason: "analysis_disabled" });
    return json(await startAnalysis("weekly schedule"));
  }
  const who = await caller(req);
  if (!who) return json({ ok: false, error: "Sign in with a team account." }, 401);
  let body: any = {}; try { body = await req.json(); } catch { }

  const { data: settings } = await sb.from("growth_settings").select("resource_daily_cap").eq("id", 1).single();
  const cap = Number(settings?.resource_daily_cap ?? 6);
  const underCap = async () => (await usedToday()) < cap;

  if (body.action === "analysis") {
    if (who.role !== "admin") return json({ ok: false, error: "Only admins can start the analysis." }, 403);
    return json(await startAnalysis(who.email));
  }

  if (body.action === "retry") {
    if (who.role !== "admin") return json({ ok: false, error: "Only admins can retry." }, 403);
    if (!(await underCap())) return json({ ok: false, error: `Today's limit of ${cap} resources is reached.` }, 429);
    await sb.from("resource_jobs").update({ status: "queued", error: null, output_url: null, started_at: null, finished_at: null }).eq("id", text(body.id, 64));
    return json(await fireAndRecord(text(body.id, 64)));
  }

  // Deal teaser from what a lead told us (their replies / DMs). Same routine; the skill hands it to routines/teaser-builder.md.
  if (body.action === "teaser") {
    const t = body.teaser || {};
    const source = text(t.source_text, 20000);
    if (source.length < 40) return json({ ok: false, error: "Paste or pick the lead's messages first (at least a couple of sentences)." }, 400);
    const contact = POSTERS.find(n => n === text(t.contact, 40)) || "Chase Hamby";
    if (!(await underCap())) return json({ ok: false, error: `Today's limit of ${cap} Claude jobs is reached. An admin can raise it in Resources → Settings.` }, 429);
    const codename = text(t.codename, 80);
    const row = {
      created_by: who.id, requested_by: who.email, kind: "resource", format: "pdf", poster: contact, brand: "OuterHaven Advisory",
      topic: `Teaser: ${codename || text(t.lead_name, 80) || "new opportunity"}`, caption: source, notes: text(t.notes, 6000) || null,
      fired_at: new Date().toISOString(),
      payload: {
        type: "teaser", codename: codename || null, anonymise: t.anonymise !== false, side: text(t.side, 20) || "sell",
        lead_name: text(t.lead_name, 120) || null, lead_company: text(t.lead_company, 160) || null, linkedin_url: text(t.linkedin_url, 300) || null,
        lead_intake_id: text(t.lead_intake_id, 64) || null, person_id: text(t.person_id, 64) || null, opportunity_id: text(t.opportunity_id, 64) || null,
      },
    };
    const { data: ins, error: e2 } = await sb.from("resource_jobs").insert(row).select("id").single();
    if (e2) return json({ ok: false, error: e2.message }, 500);
    return json(await fireAndRecord(ins.id));
  }

  // Pre-meeting brief (4 Nov 2026): research the lead and judge whether OuterHaven is a specialist in their lane.
  // Same routine; the skill hands it to routines/brief.md, which writes payload.brief. HQ copies it onto people.brief.
  if (body.action === "brief") {
    const b = body.brief || {};
    const { data: p } = await sb.from("people").select("*").eq("id", text(b.person_id, 64)).maybeSingle();
    if (!p) return json({ ok: false, error: "Person not found." }, 404);
    if (!(await underCap())) return json({ ok: false, error: `Today's limit of ${cap} Claude jobs is reached. An admin can raise it in Resources → Settings.` }, 429);
    const oppId = text(b.opportunity_id, 64);
    const { data: opp } = oppId ? await sb.from("opportunities").select("*").eq("id", oppId).maybeSingle() : { data: null };
    const slug = String(p.linkedin_url || "").replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop() || "";
    const ors = [`person_id.eq.${p.id}`, slug && `linkedin_url.ilike.%${slug}%`].filter(Boolean).join(",");
    const { data: replies } = await sb.from("lead_intake").select("reply_text,created_at,campaign_name,source_account,headline,company_name").or(ors).order("created_at").limit(12);
    const { data: threads } = slug ? await sb.from("dm_conversations").select("account_name,messages,captured_at").ilike("prospect_url", `%${slug}%`).order("captured_at", { ascending: false }).limit(1) : { data: [] };
    const row = {
      created_by: who.id, requested_by: who.email, kind: "resource", format: "other", poster: "Tengku Harris", brand: "OuterHaven Advisory",
      topic: `Brief: ${p.name}${p.company_name ? " · " + p.company_name : ""}`, caption: p.last_inbound_message || "", notes: text(b.notes, 4000) || null,
      fired_at: new Date().toISOString(),
      payload: {
        type: "brief", person_id: p.id, opportunity_id: opp?.id || null,
        person: { name: p.name, company_name: p.company_name, headline: p.headline, linkedin_url: p.linkedin_url, side: p.primary_side, stage: p.pipeline_stage,
          source: p.source, source_account: p.source_account, thesis: p.thesis, notes: p.notes, interest_deal_size: p.interest_deal_size,
          interest_opportunity: p.interest_opportunity, qualification_reason: p.qualification_reason, last_inbound_message: p.last_inbound_message, owner_name: p.owner_name },
        opportunity: opp ? { title: opp.title, side: opp.side, stage: opp.pipeline_stage || opp.stage, size: opp.opportunity_size, raise: opp.revenue_raise_amount,
          sector: opp.sector, geography: opp.geography, transaction_type: opp.transaction_type, notes: opp.notes } : null,
        replies: replies || [], thread: threads?.[0] || null,
      },
    };
    const { data: ins, error: e4 } = await sb.from("resource_jobs").insert(row).select("id").single();
    if (e4) return json({ ok: false, error: e4.message }, 500);
    await sb.from("people").update({ brief_job_id: ins.id }).eq("id", p.id);
    return json(await fireAndRecord(ins.id));
  }

  // Swipe file breakdown (14 Oct 2026): someone else's post, saved in Growth → Playbook. Same routine; the skill hands it to
  // routines/breakdown.md, which writes breakdown / recreate / archetype onto the swipe_posts row.
  if (body.action === "breakdown") {
    if (who.role !== "admin") return json({ ok: false, error: "Only admins can break down posts." }, 403);
    const { data: sw } = await sb.from("swipe_posts").select("*").eq("id", text(body.swipe_id, 64)).maybeSingle();
    if (!sw) return json({ ok: false, error: "Saved post not found." }, 404);
    const paths = (Array.isArray(sw.image_paths) ? sw.image_paths : []).filter((p: unknown) => typeof p === "string");
    if (!paths.length && !sw.caption) return json({ ok: false, error: "Add a screenshot or the caption first." }, 400);
    if (!(await underCap())) return json({ ok: false, error: `Today's limit of ${cap} Claude jobs is reached. An admin can raise it in Resources → Settings.` }, 429);
    // The routine can't read the private bucket: week-long signed links, in order.
    // A full https path is a public image (seeded rows): passed as is.
    const signed: string[] = [];
    for (const p of paths) { const u = /^https:\/\//.test(p) ? p : (await sb.storage.from("swipe").createSignedUrl(p, 7 * 86400)).data?.signedUrl; if (u) signed.push(u); }
    const row = {
      created_by: who.id, requested_by: who.email, kind: "resource", format: "other", poster: "Tengku Harris",
      topic: `Breakdown: ${sw.author || "saved post"}`, caption: sw.caption || "", fired_at: new Date().toISOString(),
      payload: { type: "breakdown", swipe_id: sw.id, images: signed, author: sw.author, author_followers: sw.author_followers,
        reactions: sw.reactions, comments: sw.comments, reposts: sw.reposts, hours_live: sw.hours_live, posted_at: sw.posted_at, snapshots: sw.snapshots, url: sw.url, note: sw.note },
    };
    const { data: ins, error: e3 } = await sb.from("resource_jobs").insert(row).select("id").single();
    if (e3) return json({ ok: false, error: e3.message }, 500);
    await sb.from("swipe_posts").update({ status: "queued", job_id: ins.id, error: null }).eq("id", sw.id);
    const r = await fireAndRecord(ins.id);
    if (!r.ok) await sb.from("swipe_posts").update({ status: "failed", error: r.error }).eq("id", sw.id);
    return json(r);
  }

  if (body.action !== "create") return json({ ok: false, error: "unknown action" }, 400);
  const j = body.job || {};
  const job: Record<string, unknown> = {
    created_by: who.id, requested_by: who.email,
    format: text(j.format, 10), poster: text(j.poster, 40), topic: text(j.topic, 300), caption: text(j.caption),
    brand: text(j.brand, 120) || "OuterHaven Advisory", list_brief: text(j.list_brief, 4000) || null, notes: text(j.notes) || null,
    creative_path: text(j.creative_path, 300) || null, creative_url: text(j.creative_url, 2000) || null,
    post_id: text(j.post_id, 64) || null, client: j.client && typeof j.client === "object" ? j.client : null,
  };
  if (!FORMATS.includes(job.format as string)) return json({ ok: false, error: "Pick Notion, PDF or List." }, 400);
  if (!POSTERS.includes(job.poster as string)) return json({ ok: false, error: "Pick whose account the post runs on." }, 400);
  if (!job.topic || !job.caption) return json({ ok: false, error: "Topic and caption are required." }, 400);
  if (job.format === "list" && !job.list_brief) return json({ ok: false, error: "Describe the list: who or what to scrape, and how many rows." }, 400);
  if (!(await underCap())) return json({ ok: false, error: `Today's limit of ${cap} resources is reached. An admin can raise it in Settings.` }, 429);

  // The routine can't read the private bucket, so hand it a week-long signed link to the creative.
  if (job.creative_path) {
    const { data } = await sb.storage.from("growth-assets").createSignedUrl(job.creative_path as string, 7 * 86400);
    if (data?.signedUrl) job.creative_url = data.signedUrl;
  }
  job.fired_at = new Date().toISOString(); // reserve a slot so parallel clicks can't overshoot the cap
  const { data: row, error } = await sb.from("resource_jobs").insert(job).select("id").single();
  if (error) return json({ ok: false, error: error.message }, 500);
  return json(await fireAndRecord(row.id));
});
