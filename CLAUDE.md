# OuterHaven dashboard: notes for Claude

Read this first in any session on this repo. It is the hand-off from the sessions that built HQ (Sept 2026).

## What this repo is
- **Public site**: `index.html`, `firm.html`, `advisory.html`, `industries.html`, `team/`. Strategic-advisory look
  (Moelis / Houlihan Lokey): serif headings, navy/charcoal, generous whitespace. Styles in `finance-firm.css` and
  `headline-partner-platform.css` (type tokens `--fs-*`, `--serif`, `--sans`).
- **HQ** (internal app): `hq.html` + `hq/*.js` (ES modules, no build step) + `hq/app.css`. Pages: Overview, Today,
  Schedule, Pipeline, Growth (scraper, posts, experiments, insights, meetings, sheet), Resources.
- **Legacy**: everything else at the root (`originator-*`, `pipeline*`, `daily-ops-*`, `shared.html`). Don't extend it.
- Hosting: Vercel static deploy from `main` (https://www.outerhaven.group; apex 308s to www; https://outerhaven-dashboard.vercel.app still works). `.vercelignore` keeps
  `.claude`, `routines`, `supabase`, `sheets` off the site. Pushing to `main` deploys.

## Access (already set up; don't ask the user to redo it)
- **GitHub**: chasehamby123/outerhaven-dashboard, public. The Claude GitHub App is installed, so push to `main` works.
- **Supabase**: project `nfcysxqdwpdhrdpgxrlo`, via the Supabase connector (`execute_sql`, `apply_migration`,
  `deploy_edge_function`). Publishable key is in `hq/core.js`.
- **Notion, Google Drive**: connectors on Tengku's account.
- **Apify**: token in `public.integration_secrets` (`APIFY_TOKEN`). Never print it.
- The session sandbox can't reach supabase.co or api.apify.com directly; go through the connectors (or
  `extensions.http` from SQL for testing edge functions).

## Roles
`dashboard_access` table → `dashboard_role()`: `admin` (Tengku, Chase, Peter, Anaz) sees everything; `ops` sees
Today, Schedule, Resources (no one holds it right now, the role still exists). RLS helpers: `can_access_daily_ops()` (admin or ops), `can_access_dashboard()` (admin).

## Data you'll touch
- `daily_ops_accounts` (owner_name = first name: Sara, Dev, Sahid, Tengku, Razeen, Peter, Chase, Reza, Anaz).
- `daily_ops_weekly_posts`: the weekly posting template. `sync_daily_ops_today()` turns it into today's
  `daily_ops_schedule` rows (post 60 min, then 15-min reply block except Sara; Sara's 30-min comment block before the
  first post; posts run back to back). Ops day rolls over at 2 AM GMT+8. Edited by HQ → Schedule (drag and drop).
- `daily_ops_creation_blocks`: the weekend post creation batch (HQ → Schedule, slider → Post creation, `hq/creation.js`).
  Block = day + start + account + creatives × minutes_per (end derived). `sync_daily_ops_today()` adds today's blocks to
  Today as 'create:<id>' tasks. Migration: `supabase/2026-10-02-creation-schedule.sql`.
- Team tasks (`team_tasks`, `hq/tasks.js`): everyone's own once / daily / weekdays / weekly tasks (Today → Add task, or
  Schedule → Team tasks). `sync_team_tasks()` (called by HQ after `sync_daily_ops_today`) upserts today's occurrences into
  `daily_ops_schedule` (auto_key 'task:<id>', `assignee`, auto_generated=false so the posting sync never deletes them);
  stale untouched ones are deleted client-side. `daily_ops_schedule.assignee`: null/posting rows = Anaz (trigger).
  Today has a "Team today" switcher in the side rail (below the hero on narrow screens; never above the hero, the % ring stays the hero; `hq-today-who`); nav badge and
  whip count only your own tasks. Chase has a daily "Reply in X's inbox" task per account except Anaz.
  Note: the Supabase connector cancels migrations containing DROP/DELETE/UPDATE; ask the user to run those in the SQL editor.
- `daily_ops_posts`: scraped LinkedIn posts. `post_key` comes from a trigger. `is_repost` is set by trigger; reshares
  are boosts, never the account's own post. `tags` / `metrics` jsonb hold HQ tagging and `no_resource`.
- Comments from our own accounts never count. `daily_ops_post_comments.is_team` is set by trigger;
  `daily_ops_posts.external_comment_count` (audience), `team_comment_count`, and `unreplied_count` (audience comments
  no team account answered) are kept current by `recount_post_comments()`. `commenter_count` is LinkedIn's raw total
  (includes ours); only use it as a fallback before a thread is scraped. Reply quota: 20 comments/account/day.
- `growth_settings` (id 1): scraper on/off (`scrape_enabled`), `scrape_hour`, `monthly_budget`, resource cap and
  Drive folder.
- Scraper (v9: comment threads run one Apify run per post inside a 120 s budget, unfinished runs are aborted and stay pending; a thread costs ~$0.60-1.30 and the log now records real per-run cost; account pool: `APIFY_TOKEN` = slot 1 capped by the HQ budget, extras `APIFY_TOKEN_2..9` added write-only in HQ → Growth → Scraper → Apify accounts via RPC `set_apify_token`, each run goes to the account with most credit left, extras use up to their own plan limit; `monthly_budget` caps slot 1 only; HQ shows spend summed across the whole pool from live `status_only` reads, and the per-run cost in the log is the pool delta between consecutive runs because the run object's `usageTotalUsd` is ~$0.0001 and Apify's account usage trails a finished run by minutes): edge function `daily-ops-linkedin-auto` (Apify actors atomus/linkedin-posts-scraper-pro and
  comments-scraper-pro), pg_cron every 30 min, runs once a day after `scrape_hour` MYT. Log:
  `daily_ops_linkedin_auto_log`. The user turned it off on 28 Sept; only they turn it back on.
  **v10 (11 Oct 2026):** the atomus actors give FREE Apify plans 10 results a month, then return one row `{type:"error",
  error_kind:"free_tier_limit"}`. From 6 Oct every run went to a free pool account (most credit left), skipped that row and logged
  "ok, 0 posts". Now paid plans go first (`pick` sorts by `paid`, from users/me `plan.id`), an all-error dataset throws `ActorRefused`
  (account marked, next one tried, refusals logged as `refused_accounts`), and the cron accepts `{"force":"posts"}` with the cron key for
  a catch-up run. Only `chasehamby` (APIFY_TOKEN, STARTER) can actually run these actors; the 8 free accounts are useless for them.
- Google Sheet "OuterHaven LinkedIn Accounts KPI" (id `1RGhFmIzQDCulzW6EVlFpVl8mmWEn_QU7rbSnzq1I01g`): HQ reads it via
  gviz CSV; `sheets/outerhaven-kpi-autofill.gs` (Apps Script) fills scraped columns from RPC `sheet_post_stats`.

## Overview: "Did the posts go out?" (`hq/postcheck.js`)
- Top card on Overview. Scheduled post tasks for the ops day (last night's until tonight's first slot starts) checked two
  ways: ticked on Today vs found by the scraper (`daily_ops_posts`, own post, same `work_date`). If finished slots can't be
  verified (scraper off / no posts run since), a popup shows once per ops day per browser (localStorage `hq-postcheck-<day>`)
  with "Check LinkedIn now" = one manual posts run (~$0.18). It never turns the scraper on.

- Second card on Overview: "Waiting on our reply" (`renderReplyQueue` in pipeline.js): top 8 unanswered outreach replies by `leadHeat`, links to `#/pipeline/leads` (opens the LinkedIn leads tab).
- HQ checks `/hq/main.js` ETag every 5 min and shows an "HQ has been updated · Reload" bar, because people leave the tab open for days.

## Pipeline (HQ → Pipeline, `hq/pipeline.js`, admin only)
- Reads `opportunities`, `people`, `tasks`, `lead_intake` (same tables as the old `shared.html` board; both stay in sync).
  Item = live deal (`pipeline_active`), or a live person with no live deal. Ball = `waiting_on` ('us'/'them'/null), clock = `waiting_on_since`.
- Flags: ours 3d warn / 7d red; theirs 7d warn / 14d red; nobody owns the move; no next step; overdue task; no movement 21d.
  Layout: slim header + filter chips, stage board first, then one tabbed card (Needs you | LinkedIn leads | Parked). Chips filter the list and highlight matching board cards. Nav badge = red items. Stage board per side (stage lists mirror `pipeline.js` at the root); third tab **Both** = `people.primary_side='Both'` (IBs that are also capital), relationships only with a short stage list (deals can't be Both: `opportunities.side` check).
- Leads panel: `lead_intake` rows with no `person_id`, not reviewed, not `not_qualified`. "Add as sell/buy side" inserts/reuses a
  `people` row, adds a task (owner from the lead's `source_account` profile slug) and stamps the lead. Quick actions ("Next stage →" on cards and rows moves one stage; "DMs" opens every logged reply from `lead_intake` plus any extension-saved `dm_conversations` thread) write
  `waiting_on`/`waiting_on_since` to the deal and its person. Old board is linked in the nav as "Old pipeline board".
- Leads are ranked by `leadHeat()` (pipeline.js): asks for a call / gives contact = "Wants to talk", deal words = "Has a deal", polite no = "Looks like a no". Chase's inbox tasks on Today show unanswered outreach replies per account (by `source_account` slug).
- Outbound reality (Oct 2026): Peter, Tengku, Chase run campaigns in Prosp (replies arrive in `lead_intake` via webhook; sends are not tracked); the other 6 accounts are manual in AdsPower.

## Lead owners, round robin, To Reach Out, pre-meeting briefs (4 Nov 2026, Tengku; `hq/leadowner.js`, `hq/brief.js`)
- Every lead is an eventual customer, so we follow up forever. **Before the first meeting** a lead talks to ONE person:
  `people.owner_name` (sticky). LinkedIn leads → the inbox responder of the account they came in on (`inbox_owners`); signal
  adds → the owner picked in the Add modal; Add person → picked, or round robin = `pickOwner()` (fewest live pre-meeting leads).
  `backfillOwners()` in pipeline.js gives every ownerless live person one on first load (task owner > responder > round robin).
- **After the first meeting** (`met_at`, stamped when a person reaches `MET_FROM` = Diligence Call Complete or later, or by stage
  alone) follow-up touches rotate `ROTATION` = Tengku → Anaz → Chase, per touch: `nextSender()` = the one after `last_touch_by`.
  Cadence `CADENCE` = 3, 7, 14, 30 days, then 30 forever (`touch_count` counts post-meeting touches). Flag `touch` "Follow-up due ·
  X's turn" replaces the old "their move" flag for met people; "Sent follow-up" logs the touch. Chip **My turn** = your touches due
  + your pre-meeting leads where it's our move.
- **To Reach Out** = new first stage on every side (before New Relationship): targets nobody has spoken to yet. Signal "Add to
  pipeline" (funds/credit/bdc/ucc) lands there; own tab in the Needs-you card; never red, never in Needs you; "Reached out" moves it
  to New Relationship. Unknown/empty stages still count as New Relationship (`stageIdx`). The outreach edge function still inserts
  at New Relationship (those were already sent).
- **Pre-meeting brief** (Marco Demiroz went badly: nobody focused on AI). "Brief" on rows / "Prep brief" in the update window →
  `resource-request` action `brief` (builds payload: person, deal, replies, DM thread; sets `people.brief_job_id`) → routine →
  `routines/brief.md` (lanes table = what OuterHaven is actually specialised in; size raises the bar; verdict strong / partial /
  none + who leads + angle) → `resource_jobs.payload.brief`; `syncBriefs()` copies it onto `people.brief` (`brief_ready_job`).
  Flag "No pre-meeting brief" (warn) on un-met people. Update the lanes table in brief.md when the team or offer changes.
- **Moving cards (4 Nov 2026, Tengku couldn't undo a mis-click on Sonia):** drag a board card onto any column (`data-drag` / `data-drop`,
  desktop; phones use the update window), and the last one-click / drag move shows "Moved X · Undo" in the board header (`lastMove`).
  All moves go through `setStage()`. Moving a person back before `MET_FROM` clears `met_at` (mis-click), so they return to their owner.
  The update window now redraws the board after Save (before, it only cleared the cache, so a saved move looked like it hadn't worked).
- Migration `supabase/2026-11-04-lead-owners-rotation-brief.sql` (columns only; the To Reach Out stage move is an UPDATE the user runs).

## Deals (sidebar page `#/deals`, `hq/deals.js` `renderDealsPage`, admin only; 7 Oct 2026)
- Deals PROVIDED to us (mandates, teasers, CIMs from sponsors / banks / introducers) for Peter to review. Not outbound targets.
  Table `deals` (codename, source, type, ask_text/ask_amount (USD only, `parseAsk`), valuation, structure, fee terms, summary,
  doc_links [{label,url}], NDA, status To review / Need info / Interested / Shopping to buyers / Passed / Closed, peter_verdict
  Fit / Maybe / Pass + peter_notes + next_step). Verdict moves status (Fit → Interested, Pass → Passed, Maybe → Need info).
  Seeded from the Sell Side `opportunities` (linked by `opportunity_id`). RLS admin. Migration `supabase/2026-10-07-deals.sql`.
  Own sidebar page (Peter asked for a page, not a tab), larger type (`.dealsPage` CSS); nav badge = deals to review
  (`refreshDealsBadge`); old `#/pipeline/deals` redirects to `#/deals`. NDA deals use codenames (never the Mauritius brand).
- **Add a deal = upload their teaser** (7 Oct 2026, Chase: "too many questions"): drop zone at the top of the form, `hq/deal-import.js`
  (port of the originator portal's PDF intelligence: pdf.js + tesseract OCR from jsdelivr, all in the browser, no cost) fills codename,
  type, ask (raise only, never project value/valuation), sector, geography, financials, summary, and attaches the PDF. Only codename,
  type, ask, from, owner, summary show; the rest is under "More details". A new deal added from a PDF auto-fires "Write with Claude"
  with the PDF text (`writeWithClaude(d, docText, quiet)`).
- **Teasers on deals:** "View teaser" opens the branded A4 teaser popup (`openTeaserPage` in teasers.js: edit in place, Save edits →
  `deals.teaser_html`, Download PDF). Source order: saved edits > Claude's teaser (`deals.teaser`) > drafted instantly from the deal's
  fields (`autoTeaser`: headline, highlights, financials, use of funds, timeline, ideal investor, contact). Each card shows how many of the
  8 teaser facts are filled (`NEEDS`). "Write with Claude" sends a deal brief to resource-request action `teaser` (same routine),
  stores `teaser_job_id`, and HQ copies `payload.teaser` onto the deal when the job is ready. Uploaded teasers/CIMs go to the private
  bucket `deal-docs` (`<deal id>/<ts>-<file>`, doc_links `{label, path}`) and open in a popup through a 1-hour signed link; Drive/Docs
  links open as /preview.
- **Their teaser first (10 Oct 2026, Tengku: rewrites came out thinner than their own teaser):** a deal with their document on file
  (`theirDoc`: label/path like teaser/CIM/deck, else first PDF) shows **Their teaser** as the main button; ours is a secondary
  "Our anonymised version" or "Make anonymised version". Import no longer auto-fires Claude. A Claude write always reads their full PDF
  (re-extracted from `deal-docs` with deal-import.js) and never wipes the current teaser: `teaser_job_id` = latest job asked for,
  `teaser_ready_job` = job the stored teaser came from; HQ copies a finished job only when they differ. "Rebuild from deal fields" is
  hidden when their document exists. Migration `supabase/2026-10-10-deals-teaser-ready.sql`.

## Fund signals (Pipeline → Fund signals tab, `hq/funds.js`, admin only)
- Finds US funds raising now (Form D, II/III in the name, pooled fund, $50–250M, <60% sold, no sales commissions) and Fund I / Fund II
  managers inside the next-fund window who haven't filed their next fund under any name (list `fund1` holds both; `fund_no` tells them apart).
- Windows come from the cadence study (`fund_gap_study`, cohorts `fund1-2019-v2` / `fund2-2019-v2`, rows keyed `<cohort>:<accession>`;
  next fund = first later fund by the same people 9+ months on, shorter gaps are parallel vehicles): Fund I → next median 24 months
  (middle half 16–35, 53% ever raise again), Fund II → next median 28 (19–37, 63%). Window: Fund I 12–36 months, Fund II 15–39; the scan
  default is filings 39–12 months old, daily adds those turning 12 months.
- **Source: GitHub Actions** `.github/workflows/fund-signals.yml` runs `scripts/fund_signals.py` (edgartools, SEC direct, free):
  daily 01:40 UTC (new II/III filings, the Fund I window turning 3.5 years, checks) and hourly :10 (checks: queued + unchecked Fund I targets, up to 300 per run). Check confirms "same manager" by a shared named person; name-only = "unsure" (Maybe). Backfills:
  Actions → Fund signals → Run workflow (mode live/fund1 + dates). Repo secrets: `FUND_INGEST_KEY` (= `FUND_INGEST_SECRET`, admins copy it
  in the tab's Setup via RPC `fund_ingest_key()`) and `SEC_IDENTITY` (name + email). The user sets both; never set them yourself.
  The sandbox and the DB can't reach sec.gov (blocked), so test the parser offline (`edgar.offerings.exempt.formd.FormD.from_xml`).
- Python only fetches and maps to the item shape; edge function `fund-signals` (verify_jwt=false) action `ingest` (header `x-fund-ingest`)
  stores and judges with `supabase/functions/fund-signals/rules.js` (pure JS; every verdict stores `reasons`; bump `RULES_VERSION` and the
  15-min cron re-judges every stale row in one run: pages of 1,000, upserted 500 at a time, judged columns only, 100 s budget; before 19 Oct
  it was one update per row, 1,500 a run, ~3 hours for a rules bump). Check = same CIK later filings (amendment numbers) + EFTS full-text search on the manager name (higher fund
  number = cut). HQ "Check" queues (`action: queue`); the hourly job picks queued up. Deploy index.ts + rules.js together.
  The check also searches every named person on the Fund I filing (`person_filings`): a later pooled fund under ANY name naming the same
  people = "next" (strong: 2+ shared people, same city, or a one-person filing; else "unsure"). Names with >60 filings are skipped.
  EDGAR full-text search quirk: several forms in one `search_filings` call only matches one form (D + D/A returned only D/As), so
  always search one form per call (`efts()` in fund_signals.py, `text_hits` in credit_signals.py). Debug any name with workflow mode
  `probe` (from = names separated by ;); results come back as a run annotation (`gh api .../check-runs/<job id>/annotations`), since
  raw logs are on blob storage the sandbox can't reach. `gh api` can dispatch the workflow from the session. Mode `recheck` re-queues
  every checked Fund I target, then checks.
- **Reliable runs (6 Oct 2026):** GitHub's cron is best-effort (Oct 3-5: ~6 of ~25 scheduled runs a day, hours late). pg_cron jobs
  `fund-signals-daily-dispatch` (01:40 UTC) and `fund-signals-check-dispatch` (:10 hourly) call `dispatch_fund_workflow(mode)`, which
  POSTs workflow_dispatch to GitHub with `integration_secrets.GITHUB_DISPATCH_TOKEN` (no token = no-op). Admin pastes it in Fund signals →
  Setup (RPC `set_github_dispatch_token`, write-only; never enter it for the user); `github_dispatch_status()` shows token + last answers
  (204 = started). Log: `fund_dispatch_log`. Once dispatches return 204, drop the `schedule:` block from the workflow (duplicates).
  Migration `supabase/2026-10-06-github-dispatch.sql`.
- **Data accuracy rules (5 Oct 2026, after Tengku caught Eventide $0 vs $64.65M and Hartbeat $0 vs $28M):** numbers come from the
  newest D/A (`with_latest` at scan, `amended_at` / `amendment_url` shown in HQ); every SEC call goes through `sec()` retries; an
  unreadable filing is recorded, never treated as "no data" (scan → `fund_data_checks` failures; check → status error, retried hourly).
  Hard checks in `fund_data_checks`: `selftest` (KNOWN cases in fund_signals.py vs live SEC data, run first in daily; failure = red
  GitHub run) and `audit` (every non-vehicle row re-verified against the SEC filing index, stale rows fixed; after daily/fund1/live).
  Add every hand-caught error to KNOWN. HQ shows the latest self-test and audit above the list.
- **Lanes + track record (8 Oct 2026, Peter call; RULES_VERSION 14):** `classify()` now sets `stage` for the next-fund list: 'raising'
  (`still_raising` and the last filing <13 months old), 'closed' (raised >=95% of target, or no filing for 13+ months while known: open
  offerings must re-file yearly, Rule 503), else 'unclear'. Still raising = maybe ("too early for a next-fund pitch"); the old +30 for
  still raising is gone (it put every still-raising Fund I at the top). Track-record proxies (real returns are never public at this size):
  hit target +12, >=80% +5, closed under 60% = maybe -10 (Peter: weak Fund I is hard to place), filled within 12 months +6, <=5
  investors = maybe -8 (anchor-only), >=25 investors +6. Ability to pay: 2% fee under $400K/yr -8, else +5. Next fund ask line: 1.5-2x,
  of which 0.9-1.4x of Fund I must be new money (re-ups ~60%). `strategy` from the name (`strategyOf`): real estate -15 (Peter: crowded,
  hardest to get paid), credit +8. Weights recalibrated so targets spread (window 15, clear 15, emerging 12 on fund1 / 20 on live).
  HQ: Fund status + Strategy filters, status/strategy chips, "Call prep" questions per card (`prep()`), openers by stage.
  The cron re-judges stale rows best-score first. Migration `supabase/2026-10-08-fund-lanes-marks.sql`.
- **Stuck raising (14 Oct 2026, Tengku; RULES_VERSION 17-18):** stage 'stuck' = 'raising' and 12+ months since the first sale. Lane =
  placement on the CURRENT fund (+15), not a next-fund pitch (timing, track record and next-fund ask are skipped). First close done
  and under 60% raised +10; >=60% raised -10 info; nothing raised = maybe -10; open 2+ years under 30% = maybe -10. Raising under
  12 months stays maybe. Fund I stuck = maybe (no fund track record; ask for attributable deals), Fund II stuck = target.
  HQ chip "Stuck raising". Test: `node scripts/tests/test_fund_rules.mjs`.
- **Live raises vs the previous fund (19 Oct 2026, Tengku on Future Labs Capital Fund II; RULES_VERSION 19):** mid-raise is when a GP wants
  help most, so motivation isn't the filter; placeability is. Live rows now get `history` too (index.ts judges live + fund1; `offering`
  added to HIST_COLS, history entries and stored `prior_funds`). Previous fund closed under 60% of its target = maybe −10; 12+ months in
  and under half of what the previous fund raised = maybe −10 ("its own investors aren't re-upping"); already past it = +5.
- **Live stalls + out-of-order numbers (19 Oct 2026, Tengku on Schutte Capital II at #1 with 4% in 50 months; RULES_VERSION 20):** live
  raise open 2+ years under 30% = maybe −15 (the stuck +20 now only applies 6–24 months); a higher-numbered fund by the same people
  that started first (Schutte III 2021, II 2022) = maybe −10 "parallel vehicles, not a new fund". Tests in test_fund_rules.mjs.
- **Ability to pay, stated on every card (21 Oct 2026, Tengku after HI Mark Capital: $6M Fund I, couldn't pay $15K upfront; RULES_VERSION 21):**
  `payOf(base, ageMonths)` in rules.js = fee income (2%, 1.5% if 5+ years old) and 25% of it per month for fundraising help → offer
  tier: $12.5K+/month retainer, $4–12.5K milestones, under $4K success fee only. Next-fund list keeps its old points (−8 under $400K fees,
  +5 above); live list states it as info only (base = max(manager_total, earlier funds' sold + this fund's sold)), so no score changes there.
- **Earlier funds fixed (21 Oct 2026, Tengku: Fund IIs with no Fund I and a manager total = Fund II alone; RULES_VERSION 22):** audit found
  ~half of non-cut Fund II+ rows with no earlier fund. Causes + fixes: (1) live Fund IIs were never looked up (`need_hist` was fund1-only)
  → now every Fund II+; (2) a lookup with any unreadable filing stored a partial/empty list for good → `manager_funds` returns None (retry);
  `adviser_todo` treats an empty `prior_funds` as unchecked, so it is retried each adviser run; (3) a Fund I Form D naming no people
  failed the shared-person test (DBDK) → `twinName()`: same name minus the fund number (8+ chars or 2+ words) counts when either
  filing names no people; both naming different people stay apart (Nudel); (4) the adviser ingest recomputed the Form D total without
  the stored `prior_funds` → it now counts them. Tests in test_fund_rules.mjs.
  **Second pass (22 Oct 2026, after the first run: still 351 / 76 with no earlier fund, 217 / 53 never found anything):** the search used
  the one-word `check_keyword` ("Portal", "Alliance", "Collab"), which hits 150+ filings and was skipped as too generic. `manager_funds(s)`
  now searches `full_name()` (company name minus fund number and suffix: "Portal Ventures") first, then the keyword, then the people on the
  filing (`fs.person_filings`, start None, cap 8) for a Fund I under another name; `adviser_todo` sends `executives`. `formDTotal` counts a
  differently named fund when it shares a named person (RULES_VERSION 23). Tests: test_full_name.py, test_fund_rules.mjs.
- **Rules audit (8 Oct 2026, RULES_VERSION 15 / CREDIT_RULES_VERSION 4):** judge() attaches `history` = `managerHistory(s, peers)` (stored rows
  with the same manager_key + `prior_funds`, the earlier funds `scripts/adviser_aum.py` found on EDGAR; now fetched for every Fund II on
  the next-fund list, `adviser_todo` returns `prior_checked`). Timing: next fund expected at a 50/50 blend of the manager's own gap
  (previous fund to this one, 9-72 months) and the cohort median (one own gap is noisy); stored as `next_expected`; pre-launch window =
  12 months before to 9 after (+15), earlier = maybe. Step-up vs previous fund: 1.3x+ +8, smaller = maybe -5, previous fund under $5M =
  info "ask what drove the jump" (no Fund II track-record points). Raised = target to the dollar (78 of 273 targets) = target reset at
  close: proves closed, NOT "hit target" (only oversubscribed gets +12). "Filled within 12 months" removed (amended_at is the yearly
  re-file, not the close). Investor count replaced by average cheque ($1M+ +6; <=5 investors = neutral info + anchor question). Strategy
  also reads adviser_name; "income" alone = credit only without real estate words. Live list: stuck +40 -> +20.
  Credit: `scripts/credit_signals.py` pulls last-year EBITDA (OperatingIncomeLoss + D&A) and interest expense; leverage screen
  (net debt >= 7x EBITDA and cover < 2x = trigger +25; negative EBITDA with net debt = trigger +10; >= 5x +8; strong cash flow < 3x and
  cover >= 4x = -15 "bank will refinance") also adds candidates; revenue $20-200M +10 (Peter's sweet spot), $200M-1B +3; balance sheet
  older than 270 days -5. Migration `supabase/2026-10-08-fund-history.sql`.
- **Stars and flags (all three signal tabs, `hq/marks.js`):** shared per row (`starred_by/at`, `flagged_by/at`, `flag_note`), views
  "★ Starred" / "⚑ Flagged". Fund marks apply to every vehicle of the fund; marked cut rows load with the first page.
- **Load speed (8 Oct 2026):** HQ loads every fund_signals row EXCEPT cut ones (`or('verdict.neq.cut,status.neq.new')`, ~1,900 of ~17,000;
  loading all took ~2 min). Cut rows for a list load when the Cut view opens (`loadCut`); its count comes from RPC `signal_target_counts()`
  (also gives Pipeline's Fund/Credit/UCC tab counts before a tab is opened). Migration `supabase/2026-10-08-signal-counts.sql`.
- Apify actor `logiover/sec-edgar-form-d-scraper` is a fallback only (it silently returned a partial list on 2 Oct 2026); weekly Apify
  scan stays off (`growth_settings.fund_scan_enabled`), budget `fund_monthly_budget`.
- Tables `fund_signals` (one row per filing, `fund_key` groups feeder/parallel vehicles) and `fund_signal_runs` (`params.source='github'`
  for GitHub calls). Migrations: `supabase/2026-10-02-fund-signals.sql`, `supabase/2026-10-02-fund-signals-github.sql`.
- **Manager size (6 Oct 2026, Tengku's rule):** all the manager's funds together under $150M = the target (+20), $150–500M = keep,
  lower priority (−15), over $500M = cut. `scripts/adviser_aum.py` (workflow mode `adviser`, also in daily; `adviserprobe` debugs a name)
  loads the SEC's monthly adviser files (ia*.zip + ia*-exempt.zip: Form ADV 5.F(2)(c) RAUM, total gross assets of private funds, count)
  and ties each non-cut fund to its adviser: a Form D entity name = the adviser's name, or one of its IAPD other names (strong), else
  adviser name starts with the manager name + same state. Ingest kinds `adviser_todo` / `adviser` → `fund_signals.adviser_*`,
  `manager_total` = max(adviser RAUM or private fund assets, Form D raises across the manager's funds via `formDTotal()` in rules.js),
  `manager_total_src`. Solomon Hess (Form ADV $1.08B) was the case that started it. Migration `supabase/2026-10-06-fund-adviser-size.sql`.
- "Add to pipeline" creates Sell Side `people` (source 'Form D') + a task. Fund placement for a success fee needs a US broker-dealer.

## Credit signals (Pipeline → Credit signals tab, `hq/credit.js`, admin only)
- Small US public companies that need private credit (Peter's 35-year lane). `scripts/credit_signals.py` (GitHub workflow mode `credit`,
  also run by the daily job): XBRL frames for every filer (debt due within 12 months, long-term debt, cash at the latest quarter-end with
  ≥2,500 filers, last calendar year revenue, dei EntityPublicFloat), EFTS full text last 180 days ("forbearance agreement" 8-K/10-Q/10-K,
  "substantial doubt" "going concern" 10-K/10-Q), then the submissions JSON per candidate (SIC, tickers, state, latest 10-K/10-Q).
- Posts to `fund-signals` ingest kind `credit` → table `credit_signals` (one row per CIK; numbers refresh, status/notes kept; runs logged in
  `credit_signal_runs`). Judged by `classifyCredit()` in rules.js (`CREDIT_RULES_VERSION`; the 15-min cron re-judges old versions).
  Target = a trigger (debt due within 12 months > cash, forbearance, or going concern) and no cut (bank/insurer/fund SIC 6000–6799
  except REIT 6798, revenue < $20M, debt > $750M, float > $2B). Contact = CFO via LinkedIn search link; "Add to pipeline" asks for the
  CFO's name, creates a Sell Side person (source 'SEC credit signal') + task owned by Peter, copies the opener. Revenue the frames miss is read from
  companyfacts (0 = pre-revenue = cut); revolvers (`revolver_current`) are never a trigger; each run ends with ingest kind
  `credit_done`, which sets `on_latest=false` (cut) on rows that run didn't send; tickers ending in Q (Chapter 11) are cut. Migration:
  `supabase/2026-10-02-credit-signals.sql`.

- **Real maturity dates (6 Nov 2026, Tengku; `scripts/maturities.py`, self-check `python3 -I scripts/maturities.py`):** the balance sheet's
  "due within 12 months" also counts revolvers / convertibles that mature in 2029-30 (Bowman, Shutterstock, A10 were false alarms
  when checked by hand). Most filers don't tag maturity dates in XBRL (DLH doesn't), so the credit scan reads the latest 10-Q / 10-K
  text: a month-date near a cue (due / matur / expir / extended) and a debt word, not leases / warrants / receivables, between today
  and +5 years; one quote per date. Stored in `credit_signals.flags.maturities` {form, filed, url, items[{date, month_only, quote}]}
  (inside flags, so no server change). HQ card: ▲ "Matures <date>" + the quotes, or ✕ "No debt maturity in the next 2 years" (not a
  refinancing hook). Email hooks come from these quotes, checked against the filing before any send (Tengku's rule).
- **List audit (7 Nov 2026, Tengku: 23 targets of 1,123):** ~780 cuts are right (241 SPACs, ~150 pre-revenue biotech, banks). The real
  gap was the universe: only distressed companies were scanned. Now a **maturity watch** also reads every healthy lendable-size filer
  ($20-300M debt, $20M-1B revenue, EBITDA > 0, float <= $2B) and keeps it only if its filing dates a maturity 4-24 months out.
  CREDIT_RULES_VERSION 9: dated maturity = trigger (+25 / +20 / +10 at 12 / 18 / 24 months; under 4 = Maybe); balance-sheet "due" with
  every filing maturity 2+ years out = Maybe; no debt figure no longer reads as net cash ("bank will refinance"); under $10M debt = cut
  (`small_loan`); EBITDA $5M+ = `can_pay` +5; lanes as tags `lane_refi` / `lane_rescue`. New listings with no 10-K annualise the latest
  10-Q (Lime / Neutron read as pre-revenue). Tests in test_credit_rules.mjs. Deploy fund-signals (index.ts + rules.js) for v9.
- **Hand check of 12 hooks (same day; 4 were not maturities: Orion's swap, Nuvera's amortisation schedule, NN's PIK election date, Jushi's
  $1.4M acquisition note; biote's date was superseded):** `maturities.py` now reads whole sentences and skips swaps / hedges, payment
  schedules (commencing / beginning / through / interest payments), superseded dates (was set to / originally / previously); each item
  has `kind` (term | revolver | debt), `amount_m` (largest $ in the sentence; bare numbers = thousands) and `small` (< $5M, ignored).
  CREDIT_RULES_VERSION 10: term / notes maturity = trigger; a revolver / ABL maturity only at net debt 3x+ (+10); regulated utilities
  (SIC 4900-4949, 4961, 4991) cut; strong cash flow (< 3x, cover 4x+, no distress) = Maybe "its bank refinances it, so it won't pay us".
  **Deploys:** `.github/workflows/deploy-functions.yml` deploys every changed function on push to main once an admin adds the repo secret
  `SUPABASE_ACCESS_TOKEN` (never set it yourself); flags follow the deployed verify_jwt (resource-request keeps JWT on).

## BDC loans (Pipeline → BDC loans tab, `hq/bdc.js`, admin only; 8 Oct 2026)
- The main private-company credit lane (UCC is now secondary). Private companies that borrow from BDCs, from the SEC's **BDC data sets**
  (every BDC's schedule of investments, XBRL, `https://www.sec.gov/files/datastandardsinnovation/data/business-development-company-bdc-data-sets/`
  `YYYY_MM_bdc.zip` monthly from 2026, `YYYYqN_bdc.zip` before; `soi.tsv` inside; empty months ship an empty table). Real loan sizes,
  the lender's own mark (fair value / principal), maturity, spread, PIK, non-accrual. Fair value / cost columns are labelled
  "Initial fair value of Investment" / "Adjusted cost basis" in the 2026 files (FIELDS in the script maps both label years).
- `scripts/bdc_signals.py` (workflow mode `bdc`; `bdcdry` = dry run with samples as annotations; `bdcprobe` = raw zip look; also runs in the
  daily job on Mondays): last 6 monthly zips, each BDC's latest quarter + the one before (mark change). Borrower name is parsed from the free-text
  "Investment, Identifier Axis" (163 different formats): walk back from a legal suffix, else first non-vocabulary segment; then a vote across BDC
  families drops industry words glued in front ("Insurance AMBA Buyer" → "AMBA Buyer"), but never drops a real word unless the short form is
  distinctive and used by 3+ families ("GrapeTree Medical Staffing" ≠ "Medical Staffing"). Group key = `key_of()` (no suffix, no Buyer/Midco/
  Holdings). Unfunded commitments, warrants/equity, CLO/CMBS tranches are skipped. Offline test: `python3 -I scripts/tests/test_bdc_names.py`
  (real strings; add every bad name you find). Raw logs are unreadable from the session: failures come back as a `bdc failed` annotation.
- Edge function `bdc-signals` (verify_jwt=false; ingest `x-fund-ingest`, kinds `bdc` / `bdc_done`; admin action `rejudge`) → `bdc_signals`
  (one row per company_key; status/person/notes/marks kept) + `bdc_signal_runs`. Rules: `classifyBdc()` in `supabase/functions/bdc-signals/rules.js`
  (`BDC_RULES_VERSION`; deploy index.ts + rules.js together). Size (Tengku): debt held by BDCs < $10M cut, $10–75M core, $75–150M upper end,
  > $150M cut (it's a floor: lenders also hold pieces off-BDC). Triggers and lanes: see rules v4 below. Lender tiers by BDC name (big
  platform −10, lower-middle-market only +5, venture = maybe, syndicated-only / controlled / public = cut). Opener never mentions the mark.
  Migration `supabase/2026-10-08-bdc-signals.sql` (also adds `bdc` to `signal_target_counts()`).
- **Rules v4: two lanes + ownership (12 Oct 2026; Tengku: Global Integrated Flooring was No. 1 at 81, a $13M loan at 73¢ maturing in
  11 weeks, PE-owned by RFE Investment Partners).** `classifyBdc` returns `lane`, stored in `bdc_signals.lane`:
  `refi` = performing loan with a deadline, the company hires us (default HQ view; the ONLY lane Daily 3, Send today's batch and the
  contacts cron use). Distress no longer scores here; matures 4–12 mo +25, 12–18 +20, 18–24 +10, under 4 months = too late (Maybe),
  marked 85–95¢ or down 3+ this quarter +8, PIK only counts below 95¢ (a PIK option at par is written in at closing).
  `loan_sale` = marked < 85¢, non-accrual, or past due and marked down: the lender decides, Peter calls the BDC about selling the loan;
  needs Peter's $20M minimum; < 50¢ or any syndicated-loan holder = Maybe. Ownership: `signal-contacts` lookup runs one Brave query
  per BDC company (`ownerFrom()` in parse.js: "portfolio company of X", "acquired by X"…) → `bdc_signals.owner/owner_url/owner_checked_at`,
  then asks `bdc-signals` (ingest kind `rejudge` {keys}) to re-judge; owner found = refi Maybe. The contacts cron re-checks refi targets
  with no `owner_checked_at`; Send today's batch only takes owner-checked BDC rows. Contact search retries with `searchName()` (distinctive
  words only) because filings use legal names ("…Systems") that differ from trading names ("…Solutions"). HQ: Lane select in the BDC tab.
  Tests: `node scripts/tests/test_bdc_rules.mjs` (add every company that ranks where it shouldn't), ownership cases in test_contacts_parse.mjs.
  Migration `supabase/2026-10-12-bdc-lanes-owner.sql` (`signal_target_counts().bdc` = refi only, `bdc_sale` = loan-sale targets).
- **Rules v5 (same day; Datalink: $22.7M at 72¢ maturing in 42 days, both lenders BC Partners):** under 4 months to maturity = Maybe in the
  loan-sale lane too (a sale takes 4–8 weeks); lenders count by manager (`familyOf()`, alias list in rules.js), not by BDC; venture debt and
  non-US = loan-sale Maybe. Score = points ÷ `MAX[lane]` × 100 (refi 69, loan sale 78); verdicts use the points, so rescaling changes no
  verdict or order. Update `MAX` whenever a rule's points change (test: best possible row scores 100).
- **Rules v6 + owner checks (same day; TAUC Management = Total Access Urgent Care, ICV Partners-owned since Feb 2021, the filing uses the
  acronym so search found nothing):** no owner found scores 0 and shows a Check line (refi max 64). `ownerFrom` also reads owner-first
  headlines ("ICV Partners Makes Majority Investment in…", "X acquires…"; verbs case-insensitive via `ci()`). `signal-contacts` cron action
  `owners` {limit ≤ 40} = owner checks only for unchecked refi targets, 1 Brave query each, outside the contacts DAILY_CAP.
  Owner parser guards (all from the first live run, each a test in test_contacts_parse.mjs): the company must be named in the SAME
  sentence as the ownership phrase; an owner sharing a distinctive word with the company is a namesake ("QED Investors"); the company's
  own BDC lenders are never its owner ("backed by Chicago Atlantic"); "X client Y" = an adviser; data sites / law firms (Crunchbase,
  Mergr, LLP…) never; glued page junk ("PrevPrevious", ".Read") is a sentence break. First full run: 114 refi targets checked, 56 owners
  found, 58 left; spot-check ~90% right. A changed owner sets `rules_version` 0 (stale) until bdc-signals re-judges it; `retryStale()`
  re-judges stale rows at the end of every owners / cron run (fire-and-forget re-judges failed on cold starts: 26 of 114 the first time),
  and Send today's batch skips `rules_version` 0. Hand-verified owners (TAUC = ICV Partners) are set in SQL with the source URL.
  BDC name parser: ", Company <Name>" is Varagon's label, not a suffix ("Leisure, Company" was really Taymax Group, L.P.); the stored
  row keeps the bad name until the next bdc run.
  Second pass (same day, after spot checks found Ej2 = Flashpoint/Audax, 2KDirect = iPromote/Cohere, Claridge = Skylark all marked "no owner"):
  pages shorten names, so a page counts if it has the first distinctive word + half the rest (`named()`); the owner query is unquoted
  distinctive words (the quoted phrase "claridge equipment" never appears); "X and Y invest(s) in" splits into X and Y (Y was the lender).
  Hand-verified in SQL: Ej2 → Audax, 2KDirect → Cohere Capital, Nephron → none (family-owned; Kayne Anderson was a lender, a false positive).
  Spot checks: ~3 in 10 "no owner found" were PE-backed before this pass. Known gap: credit investors read as owners ("investment from Kayne").
- Known gaps: ~55% of borrowers have no maturity in the data (some BDCs put it only in custom tags); names from single-lender rows can keep a
  stray word; BDC debt understates the full facility for big-platform deals.
- **UCC rules v4 (same day):** demoted. Size floor $30M est. revenue for Target; merchant cash advances count toward Target only at $50M+
  (smaller ones are factoring deals); IRS +20 (it primes a new lender), state tax +15, judgment +12. HQ copy points to BDC loans for direct lenders.

## UCC signals (Pipeline → UCC signals tab, `hq/ucc.js`, admin only; 7 Oct 2026)
- Sizable PRIVATE companies that need private credit (Peter's lane; Credit signals only sees SEC filers). `scripts/ucc_signals.py`
  (GitHub workflow mode `ucc`, also in daily) reads free state UCC open data: Connecticut `data.ct.gov` xfev-8smz (one table) and
  Colorado `data.colorado.gov` wffy-3uut (filings) + 8upq-58vz (debtors) + ap62-sav4 (secured parties); last 30 months of filings plus
  liens lapsing in 3–12 months. UCC filings sit in the state of ORGANIZATION, so Delaware entities are missed.
  Also (added 7 Oct 2026): **Oregon** `data.oregon.gov` snfi-f79b = LAST MONTH only (party rows DB/SP, lien_type UCC/IRS/…; EFS skipped);
  every run stores it in `ucc_filing_archive` (service-only table; edge kinds `archive_put` / `archive_get`, RPC `ucc_archive_months`) so
  history grows, and older months are backfilled once from Wayback Machine copies of the CSV. **Florida** = federal tax liens only (its UCC
  registry is privatised): free SFTP `sftp.floridados.gov` (user Public, password published by the state), quarterly full `doc/quarterly/flr`
  + daily `doc/flr/{filings,debtors}`, fixed-width (layout dos.sunbiz.org/data-definitions/lien.html), paramiko. No other free states
  (checked 7 Oct 2026: Vermont promises a free weekly bulk but no download found; West Virginia = paid subscription). Cheapest paid:
  **California master unload $100 + weekly data downloads FREE** (SOS fee schedule; bizfile Online → BE & UCC Bulk Orders, needs a
  logged-in account the user creates), Texas master $1,150 one-time (+ $65 daily updates), ND / WI / WA $500, IL $2,500 + $200/week,
  Ohio = cost + 10% by statute (ask). Loaders for bought files get written once a real file is in hand (formats differ). `--only FL,OR` (workflow `from`) runs a subset (never drops companies); mode `uccprobe` = dry run that
  reports counts as run annotations.
- HQ filters (UCC tab): search, state, revenue band, signal, sector, newest filing, registry, sort; kept in localStorage `hq-ucc-filters`.
- Size: every business debtor is matched by `biz_key()` name + same state (strict; name-only matches across states were wrong) to the
  SBA PPP file (`public_150k_plus_240930.csv`, 450 MB, cached by actions/cache, loans ≥ $500K). Revenue est = avg(loan × 15, jobs × $180K).
  SEC `company_tickers.json` names mark public companies (cut).
- Secured party classes in the script (order matters): irs, state_tax, local_tax (ignored), sba, fintech, equipment (incl. LEAF / Med One
  "Capital Funding" lessors), mca (NAMED funders only), rep ("as representative" via CSC / CT Corp / First Corporate Solutions /
  Middesk: hides the lender; cash-advance funders AND lessors use it, so weak unless 4+ in 18 months), factoring, agent, abl, bank.
  Refi window = bank/agent/abl lien on its FIRST lapse (filed ~5 years earlier) in 3–12 months; decades-old continued liens don't count.
- Edge function `ucc-signals` (verify_jwt=false; ingest `x-fund-ingest` = FUND_INGEST_SECRET, kinds `ucc` / `ucc_done`; admin action
  `rejudge`) → `ucc_signals` (one row per company_key = name_key|state; status/person/notes kept) + `ucc_signal_runs`. Judged by
  `classifyUcc()` in `supabase/functions/ucc-signals/rules.js` (bump `UCC_RULES_VERSION`; `ucc_done` re-judges stale rows; deploy index.ts
  + rules.js together). Target = est revenue ≥ $20M + strong signal (named MCA, 4+ agent filings, IRS/state tax/judgment lien), or
  ≥ $50M + maturing facility. Opener never mentions liens. First runs 7 Oct 2026: ~1,100 sized companies with a trigger, ~170 targets.
- Migration `supabase/2026-10-07-ucc-signals.sql`.

## Resources (lead magnets)
- HQ → Resources: queue of posts needing a resource, library (generated + manual links), Generate form.
- Generate → edge function `resource-request` (daily cap, fires the routine) → Claude Code routine
  "OuterHaven resource builder" (created by Tengku at claude.ai/code/routines, API trigger, custom environment
  allowing api.apify.com, the supabase.co host, media.licdn.com) → follows `routines/resource-builder.md` and
  `.claude/skills/lead-magnet-resource-builder/SKILL.md` → writes back to `resource_jobs`.
- Routine URL/token live in `integration_secrets` (`ROUTINE_FIRE_URL`, `ROUTINE_FIRE_TOKEN`), set by an admin in
  HQ → Resources → Generate → Settings. Output folder: Drive "OuterHaven Lead Magnets".
- Posts auto-link to resources by caption similarity (trigger `auto_link_resource` on `daily_ops_posts`).
- Weekly Claude analysis uses the same routine: `resource_jobs.kind = 'analysis'` (pg_cron `weekly-growth-analysis`,
  Mondays 02:05 UTC, or Growth → Insights → Run analysis now). Instructions: `routines/weekly-analysis.md`. It writes
  `daily_ops_posts.ai_tags` (creative + caption factors; hand tags in `tags` win) and a row in `growth_reports`.

## Deal teasers (Resources → Deal teasers, `hq/teasers.js`)
- One-page anonymised teaser from what a lead told us. Start from Resources → Deal teasers, Pipeline → LinkedIn leads
  ("Make teaser") or a lead's DMs window. `resource-request` action `teaser` inserts a `resource_jobs` row (kind 'resource',
  format 'pdf', `payload.type = 'teaser'`, caption = the lead's messages) and fires the same routine. The routine reaches
  `routines/teaser-builder.md` via a redirect at the top of the repo skill (the saved routine prompt didn't change).
  Output: `payload.teaser` JSON (+ Drive PDF in "OuterHaven Teasers" when possible). HQ renders it as an editable A4 page
  and downloads a PDF client-side (html2pdf.js from cdnjs). Teasers count toward the daily Claude job cap.

## DM tests and meetings
- `dm_tests` → `dm_variants` (A/B/…) → `dm_events` (one row per tap: sent / replied). Meetings live in
  `growth_meetings` (with `dm_variant_id` / `post_id`). `dm_variant_stats` view gives per-version totals.
- Today shows the running DM test (tap + Sent / + Reply / Meeting booked) and a "Meeting booked" button.
  Growth → DM tests compares versions; a winner needs 30+ sends per version and p < 0.05.
- Browser extension v2 (no sign-in): `hq/outerhaven-hq-extension.zip` is a public TEMPLATE with `__OHQ_CAPTURE_KEY__` in
  background.js. HQ → Growth → DM tests "Download" (dms.js `downloadExtension`) fetches it, gets the key from admin-only RPC
  `extension_capture_key()` (secret `EXT_CAPTURE_KEY`), injects it with JSZip and downloads a connected copy. `dm-capture`
  (verify_jwt=false) accepts `x-capture-key` or a user JWT; with the key, `booked_by` (team name) and `account` come from the
  extension's pickers (remembered per browser profile). Rotate by changing EXT_CAPTURE_KEY (old zips stop working).
- Browser extension `extension/outerhaven-capture` (MV3; zipped to `hq/outerhaven-hq-extension.zip` for download):
  HQ button on LinkedIn chats → `dm-capture` edge function → `dm_conversations` (one row per thread, re-save updates,
  opening message fuzzy-matched to a DM version via `match_dm_variant`, "meeting booked" creates a growth_meetings row).
  `dm_variant_stats` counts saved conversations as sends/replies. Re-zip after editing the extension.

## Inbox accountability + outbound (5 Oct 2026; `hq/inbox.js`, `supabase/2026-10-05-inbox-tracking.sql`)
- **Extension v2.1 "Sync inbox"** (HQ pill on linkedin.com/messaging): scrolls the conversation LIST only (never opens/sends), reads name,
  preview ("You:" prefix = we spoke last), time, unread, then POSTs `dm-capture` action `inbox_sync` (x-capture-key) → `inbox_threads`
  (one row per account+thread_key, `name_key` via trigger/`ohq_name_key`), `inbox_syncs` (log; first sync per account = baseline, so
  "new conversations" ignore it). Parser has a classic-selector pass and a generic anchor fallback.
  **v2.5 (15 Oct 2026, tested on a real saved page from Chase's inbox):** list items no longer contain `/messaging/thread/` links, so rows
  without a link are keyed `name:<lowercased name>` (thread_url null); the open chat still keys by the thread id in the URL, and
  `reply_outcomes` also matches on `name_key`. LinkedIn renders ~10 items and keeps empty placeholders below; "Load more conversations" is skipped.
  The manifest has a fixed `key` (ID ohpkiflfhhdchkofpolafncldooanccb) so AdsPower updates replace the extension instead of installing a copy.
  Never commit a saved LinkedIn page as a fixture: the repo is public and it holds real inbox content.
- **Responder** per inbox: `inbox_owners` (seed: Peter/Chase/Tengku → Chase, everyone else → Anaz; admin edits it in the Overview card).
- **Missed commenters** `missed_commenters(p_days)`: audience comment (scraper) with no team reply, and the author's name not in that inbox's threads.
  Verdict: missed (inbox synced after the comment) / unverified (synced before) / unsynced / in_inbox (not missed). Needs the comment scraper on.
- Dismissals `inbox_dismissals` ("Not needed"): thread refs include the day of the last message, so a new message brings the thread back.
- RPCs (ops + admin): `inbox_state`, `inbox_waiting`, `missed_commenters`, `needle_metrics(p_days)`. Admin only: `prosp_key_set`, `set_prosp_key`.
- HQ: Overview cards "Inbox accountability" and "What moves the needle"; Today card "Needs a reply" (responder = person viewed); Growth → Outbound tab.
- **Prosp** (Peter/Chase/Tengku): edge function `prosp-sync` (verify_jwt=false; admin JWT or `x-outerhaven-cron`) → `prosp_stats` (+ `prosp_sync_runs`);
  pg_cron `prosp-sync` every 6h; key `PROSP_API_KEY` pasted in HQ → Growth → Outbound (write-only; never enter it for the user). API response shapes
  are unverified: statuses are stored raw (`prosp_stats.statuses`) and mapped to stages by regex in the function; tune `STAGES` after seeing real values.
  Webhooks (Connection Sent / Message Sent / Connection Accepted) would be the exact alternative. Source: `supabase/functions/prosp-sync/index.ts`.
- Known smell: `prosp-reply` has its webhook token hardcoded in source.

## HQ chat button (6 Oct 2026; `hq/chat.js`, `supabase/functions/hq-chat`, `routines/chat.md`, `supabase/2026-10-06-chat.sql`)
- Floating button bottom right on every HQ page (admin + ops). Each person has their own tabs (`chat_threads`) and permanent history
  (`chat_messages`; closing a tab only sets `archived`, History reopens it; RLS = own rows only; browser never writes messages).
- Send → edge function `hq-chat` (verify_jwt=false, checks the user's JWT + role) → inserts user message + 'working' assistant placeholder +
  a `resource_jobs` row (`payload.type='chat'`, hidden from Resources by `isResource`; fired_at stays null so it doesn't use the resource cap)
  → fires the same routine as resource-request. The skill redirects to `routines/chat.md`; the routine writes the answer into the placeholder.
  Replies render as rich markdown plus chart artifacts (`hq/chatmd.js`: ```chart / ```stats fenced JSON, drawn as SVG with `--viz1..5` tokens, no orange; Table toggle + Expand; spec in `routines/chat.md` §5). Panel has a wide mode. Chat UI uses ink/mist tokens only (`--inv`), never brass.
  Replies take 1–2 min. Limits: one answer at a time per tab, 3 chats at once, `growth_settings.chat_daily_cap` (40) messages/person/day.
  `chat_sweep()` turns replies stuck >20 min into errors.
- Policy (Tengku, 6 Oct): mostly ask. The routine's DB access is read-only in chat; any change goes to a branch `chat/<date>-<slug>` with a
  GitHub compare link, never main, never live (no migrations applied, no deploys). Ops role = ask only (`payload.access`).
  Untested end to end against the live routine: first real message is the test.

## Team access + sign-in (7 Oct 2026; `hq/team.js`, `supabase/functions/team-admin`)
- Sign-in page has "Email me a sign-in link instead" (magic link, `signInWithOtp`, only for emails in `dashboard_access`; lands on /hq.html).
- HQ → Team access (admin only): lists `dashboard_access` admin/ops rows with login status; "Set password" / "Add team member" call
  edge function `team-admin` (verify_jwt=false, checks admin JWT): creates or updates the auth user with the admin-typed password,
  confirms the email, adds the access row. No email is sent. The admin types the password; Claude never does.

## Reply assist, track record, post scoring (9 Oct 2026; Tengku)
- **Sync inbox tasks**: 9 daily team tasks "Sync inbox: <name>" (assignee Tengku, `supabase/2026-10-09-sync-inbox-tasks.sql`). Manual click only:
  never auto-sync on a timer (LinkedIn would see scripted page opens at fixed times; Tengku rejected it).
- **Reply assist** (Tengku: no Claude API, same engine as HQ chat): extension v2.4 "Draft a reply" (draft only, never types or sends) → edge function
  `reply-assist` (`x-capture-key`; action draft → `reply_drafts` row status 'working' + `resource_jobs` row `payload.type='reply'` → fires the
  resource-builder routine; action status = poll every 4 s; a finished draft stays tied to its chat). `input.source` = where the lead came from,
  matched by profile slug then exact name: their comments on our posts (post caption + the post's linked lead magnet), Prosp campaign replies
  (`lead_intake`, profile bio from `raw_payload.eventData.profileInfo`; Prosp is on Peter/Tengku/Chase only, the other 6 send by hand so their
  "campaign" is our opener in the chat), our opener + matching DM test version. The routine (`routines/reply.md`)
  works out source, the LEAD's background (`lead_type`: owner_operator / sponsor_or_fund / adviser_or_banker / investor / service_provider / other;
  advisers = deal-flow partners) and stage, then picks a play (`approach`): **hostage rule first** (lead magnet asked for and our questions
  unanswered → `hostage_ask`, no link; answered → `deliver`; pushback twice → send anyway), else qualify / book / nurture / close_out / holding.
  Learning loop: views `reply_outcomes` (replied = later draft on the same chat or inbox sync shows them last after the draft) and
  `reply_approach_stats`; the routine prefers the play with the best reply rate per lead type at 20+ results; HQ → Growth → Reply assist shows it.
  Personas (`reply_personas`) are only the facts about OUR account a draft may claim, written by Claude (`supabase/2026-10-09-reply-personas.sql`;
  Sara/Dev/Sahid/Reza: no title/employer on file, no booking link). Cap `reply_daily_cap`, 4 at once, `reply_sweep()` errors drafts stuck 15 min.
  Reply jobs count against the routine's daily limit. `set_anthropic_key` / `anthropic_key_set` from the first version are unused.
- **Track record** (`#/record`, `hq/record.js`, admin): RPC `track_record(from,to)` per person per day (planned/done/skipped/open/`no_record` = nobody opened HQ that day).
- **Playbook** (Growth → Playbook, `hq/playbook.js`, engine `hq/scoring.js`, test `node hq/scoring-test.mjs`): each post vs its own account's median, factor effects shrunk toward 0 (K=3),
  predictor, library. SQL twin: view `post_scores`. Directional until ~100 tagged posts; link meetings to posts so "converted" counts.
- Migrations: `2026-10-09-sync-inbox-tasks.sql`, `-reply-record-scores.sql`, `-reply-routine.sql`, `-reply-personas.sql`, `-reply-outcomes.sql` (`-anthropic-key.sql` unused).

## Daily 3 (Today, admin only; 10 Oct 2026, `hq/daily3.js`)
- Card under the Today hero: (1) credit targets worked today = `people` rows with source BDC loan / SEC credit / UCC signal created since the
  2 AM ops-day start, split by their task owner, vs `DAILY3.contact` (20), plus untouched BDC + credit targets and days of backlog; (2) reply
  queue = `lead_intake` unreviewed, not not_qualified (goal 0) + cleared today (`reviewed_at`); (3) calls booked = `growth_meetings` today vs
  `DAILY3.calls` (1). Quotas are constants at the top of daily3.js. Tengku's rule: volume first, no new scrapers/rules for 30 days.

## Reason labels, rules page, colour-blind mode (10 Oct 2026; `hq/kinds.js`, `hq/rules.js`)
- Server rules tag anything that raises the score `good`, which coloured distress (going concern, forbearance, PIK, low marks) green.
  HQ now relabels every reason client-side by text (`kindOf()` in kinds.js): **Need** (deadline, why we call), **Risk** (distress, harder
  for Peter's lenders), **Fit**, **Check** (maybe), **Cut**, Info. Each shows symbol + word (▲ ⚠ ✓ ? ✕), never colour alone. Legend above
  every signal list. If you add a reason in a rules.js, check `kindOf` labels it right (RISK / NEED regexes).
  Cards show it compactly (`whyBlock`, Tengku: "too much going on"): one ▲ Need line + one ⚠ Risk line of headlines (text before the
  first ': '), full reasons grouped by label behind "Why · N reasons". Neutral score box, one primary action, quiet secondaries.
  No per-line chips and no legend bar on the cards; the legend lives on #/rules.
- **How we qualify** page (`#/rules`, sidebar): every rule for BDC / Credit / UCC / Fund signals with points, plus the focus order.
  Hand-written from the rules files: change it in the same commit as any rule change. BDC "How it works" modal points fixed to match rules.js.
- **Colour-blind safe** toggle under the theme switch (`html[data-cb="on"]`, localStorage `hq-cb`): good = blue, bad = orange,
  warn = amber, need = purple, for light / dark / tan. Tengku is red-green colour-blind: never rely on red vs green alone.

## Signal contacts (10 Oct 2026; `hq/contacts.js`, `supabase/functions/signal-contacts`, `scripts/officers.py`)
- Contact block on every Credit / BDC / UCC card: CFO / CEO name, LinkedIn, work email (copy), company phone + website, officer-change
  warning. Table `signal_contacts` (kind credit|bdc|ucc + key: cik / company_key; `people` jsonb). Migration `supabase/2026-10-10-signal-contacts.sql`.
- Public companies: `scripts/officers.py` (workflow mode `officers`, also daily after credit) reads the "I, <name>, certify" lines in
  Exhibits 31.1 (CEO) / 31.2 (CFO) of the latest 10-K/10-Q, flags an 8-K Item 5.02 filed after it, takes phone/website from the SEC
  company file → ingest kinds `officers_todo` / `officers` (x-fund-ingest). Offline test: `python3 -I scripts/tests/test_officers.py`.
- LinkedIn + website: Brave Search API (`BRAVE_SEARCH_KEY`) in the edge function; pg_cron `signal-contacts` every 30 min looks up 6
  targets per run, 120/day (BDC best first, then credit, then UCC). SEC-named people are searched by name; others by company + role,
  parsed from LinkedIn result titles (`parse.js`, test `node scripts/tests/test_contacts_parse.mjs`). Search finds are unconfirmed
  until someone clicks ✓ Right / ✕ Wrong (action `mark`). Never Google scraping or AI Overviews (Tengku asked; wrong names, CAPTCHAs).
  Matching rules (10 Oct, after ~half the first BDC finds were wrong): the role must be in the person's OWN LinkedIn title (snippets are
  often posts about someone else); the employer on the profile (`employerOf`: "at X", a non-role title segment, or "Experience: X") must
  pass `sameCompany()` = every distinctive brand word present and no distinctive word the company's name lacks (FILLER words ignored), so
  "Colonnade Advisors" ≠ Colonnade Parent and "Marquis Companies" ≠ Marquis Software; "Vice President" is not a CEO; former / fractional
  / consultant rejected. Stored `employer` shows in the batch window. Add every bad match to `scripts/tests/test_contacts_parse.mjs`.
- Email (12 Oct 2026): Apify actor `overpowered/email-finder` on `APIFY_TOKEN` first (10 name patterns checked against the mail server,
  $0.045 a person, ~25 s; only "Okay to Send"+"Accepted" = valid; run cap $0.10 because $0.05 aborted on the 10th row; the dataset is read
  whatever the run status). Hunter (`HUNTER_API_KEY`, 50/month) only when Apify finds no valid mailbox. On click only ("Find email", or automatically in the batch); needs
  the domain from the lookup. All-rejected can be a filtering gateway (Proofpoint at unifi.com rejected every pattern). `email_src` = apify|hunter.
  **Send today's batch finds emails itself** (12 Oct, Tengku): rows whose person has no email and was never searched (`email_checked`) are
  let into the batch when the company has a domain; the window runs `findEmail()` (contacts.js) 4 at a time, Send stays disabled until
  done, and a row that would go email-only with no confirmed email is unticked and locked. Cards and the batch window always state
  LinkedIn ✓ found / ✕ not found / … not searched yet, and email ✓ confirmed / ? unconfirmed (never emailed) / ✕ none found.
- **"+ Email for someone else"** (15 Oct 2026, Tengku wanted to test with a name not in the filing): on any card with a domain; type a
  name + role → action `email` with a name not on the card adds them first (`source: 'manual'`, status confirmed) with the result.
  Shown on every card; with no domain on file the modal asks for it (saved on the company; acronym domains like ashs.com are never found by search).
- **Officer changes (15 Oct 2026, Boxlight + ASHS):** distressed companies lose CFOs. The resignation 8-K often comes BEFORE the 10-Q the
  leaving officer still signs, so `officer_change()` in officers.py flags any 8-K Item 5.02 in the last 180 days (before or after the
  certification), then reads up to 3 of those 8-Ks and keeps only a CEO / CFO departure or appointment (`change_roles()`, stored as
  `officer_change.roles`; bare 5.02 flagged 220 of 346, with roles 101: 62 CFO, 50 CEO). SEC officers are re-read every 14 days (was 30);
  workflow mode `officers` with from=`all` re-reads every target.
- **New CFO + debt** (29 Oct 2026, Tengku): Credit tab view = targets whose `officer_change.roles` has 'cfo' (`cfoChanged()` in contacts.js;
  62 of 323 targets that day). Send today's batch puts them first among credit picks.
- Keys pasted by an admin in any signal tab → "Contacts setup" (RPC `set_contact_key`, write-only; never enter them for the user).
- "Add to pipeline" pre-fills name, title and LinkedIn from the best person.

## Scoreboard + sidebar groups (10 Oct 2026; `hq/scoreboard.js`, `supabase/2026-10-10-team-names.sql`)
- `#/score` (admin): Daily 3 outcomes only. Weekdays hit, 7-day team grid vs `DAILY3` targets (✓ / ✕ symbols, not colour alone),
  per person (targets by task owner, replies cleared by `reviewed_by`, calls by `growth_meetings.created_by`, mapped with RPC
  `team_user_names()`), 30-day funnel. Vanity metrics (posts, likes) stay under Growth on purpose.
- Sidebar grouped: Overview | Daily work (Today, Scoreboard, Schedule) | Deals (Pipeline, Deals, How we qualify) | Marketing (Growth,
  Resources) | Team (Track record, Team access, old board). Bigger nav text for Peter. Keep new pages inside a group.

## Omnichannel outreach (10 Oct 2026; `hq/outreach.js`, `supabase/functions/outreach`, `supabase/2026-10-10-outreach.sql`)
- Today → Daily 3 → **Send today's batch**: picks `bdc_per_day` BDC targets (soonest maturity) + `credit_per_day` lendable credit targets
  (EBITDA > 0, revenue >= $20M, no going concern) that have a contact with LinkedIn or a valid email (Hunter valid / score >= min), not yet
  enrolled. A person unticks bad rows and clicks Send (the one human gate Tengku agreed to). Edge function `outreach` action `send`:
  people + task (counts in Daily 3), Prosp `POST /api/v1/leads` (api_key in body, list_id + campaign_id per account in
  `outreach_settings.prosp`), PlusVibe `POST https://api.plusvibe.ai/api/v1/lead/add` (x-api-key, workspace_id, campaign_id,
  custom_variables). What we send changed on 11 Oct (see "Prosp fields + personalisation" below). Copy lives in the
  Prosp / PlusVibe campaigns. Results in `outreach_enrollments` (one per company).
- Replies: PlusVibe webhook `?hook=plusvibe&token=` (RPC `plusvibe_webhook_url()`) → `lead_intake` (source 'plusvibe') + Prosp
  `/leads/campaign/delete`. Prosp replies already land in lead_intake (prosp-reply); pg_cron `outreach-cron` every 20 min matches them by
  LinkedIn slug → PlusVibe `/lead/update/status` COMPLETED, and pulls Prosp `/campaigns/analytics` daily → `outreach_daily`.
- Keys (PROSP_API_KEY, PLUSVIBE_API_KEY) via Daily 3 → Outreach setup (RPC `set_contact_key`, write-only). Scoreboard counts sends.
- Untested against the live Prosp / PlusVibe APIs until keys + campaign IDs exist: first real batch is the test; check `outreach_enrollments.*_error`.
- **LinkedIn first** (Tengku, 10 Oct): with a LinkedIn profile, Prosp gets them on send day and the email is stored (`email_payload`,
  `plusvibe_status='scheduled'`, `email_due_at` = + `outreach_settings.email_delay_days`, default 3); the cron sends it to PlusVibe only if
  no LinkedIn reply came in. No LinkedIn = email right away. `{{company}}` (Prosp) / `{{company_name}}` (PlusVibe) get `cleanName()`
  ("HYDROFARM HOLDINGS GROUP, INC." → "Hydrofarm"). `{{deadline}}` = `deadlineOf()`: "a loan maturing in March 2027" (BDC earliest_maturity), "debt coming due by June 2027" (credit debt_current, period_end + 1y), else null since 11 Oct (no date = plain message). PlusVibe campaign "Private credit – Q4 (HQ)": 3 steps, step 1 A/B (Tengku vs Claude).
  Migration `supabase/2026-10-10-outreach-linkedin-first.sql`.
- The batch window sends the exact person shown (`items[].person`); the Send button counts ticked rows.
- **Prosp fields + personalisation (11 Oct 2026, v7; `supabase/2026-10-11-outreach-variants.sql`):** Prosp's message uses `{{First name}}` = its
  STANDARD field `firstName` (seen in Prosp's own `api/contacts/get-contacts`: firstName, lastName, name, jobTitle, company, email, phoneNumber,
  websiteUrl; anything else lands in `custom_columns`). We now send those + one custom field `deadline`. No opener, no need (Tengku: "no pitch"
  makes people think of a pitch). Prosp fills headline/photo itself when the campaign's "Visit profile" step runs.
  Personalisation = one true dated fact about THEIR company (`deadlineOf`, null when no future date; past maturities = probably extended, sorted
  last). Variants: `dated` (account's campaign) / `plain` (`prosp[].plain_campaign_id`, same copy minus the deadline line) / `email_only`.
  Dated leads split by `outreach_settings.test_split`; undated go plain or email only. `outreach_enrollments.variant` + `deadline`; HQ picks the
  variant and previews each person's exact message (`li_template_dated` / `li_template_plain` = copies of the Prosp steps, edit in Outreach
  setup; Prosp has no API to read campaign copy). Setup shows reply rate per variant (needs ~100 sends a side). Card "Copy message" =
  `messageFor()` (same template). Status `stopped` = withdrawn send (re-sendable; the 3 test sends of 10 Oct are stopped).
- Open items (11 Oct, user to do in Prosp): Peter's sender shows Disconnected in "private credit signals"; delete the 3 test rows in list
  "HQ – private credit"; optionally duplicate the campaign minus the "Noticed…" line as the plain campaign and pick it in Outreach setup.
- Hunter: one key, 50 lookups/month, now only the fallback behind Apify. Don't build rotation across extra free accounts (Tengku floated it; it breaks Hunter's terms).

## Post formats, format tests, breakdowns (11 Oct 2026; `hq/formats.js`, `hq/formattest.js`, `supabase/2026-10-11-post-formats.sql`)
- `post_formats`: our names mapped to what LinkedIn shows (`linkedin_type`) + page shape for documents. **Presentation = landscape
  document, PDF carousel = portrait or square document** (our definition; editable in Schedule → Formats; two document formats must
  not overlap in shape or the scraper can't tell them apart).
- Planned format of a slot on a date = `post_plan` row (one-off override or format test: `experiment_id` + `arm`) ?? the weekly slot's
  `daily_ops_weekly_posts.format_key`. Set in Schedule (slot modal: every-week format + one-off for the next 4 dates). Shown on Today
  post tasks (format, how to make it, ★ test arm), Schedule blocks (`*` = next date differs), Post creation ("Make these for the next 7
  days"), Overview post check (✓ Right format / ✕ Wrong format).
- Scraper v11 (`daily-ops-linkedin-auto`): `linkedin_type`, `image_count`, every image / the PDF saved (`creative_paths`), PDF pages +
  orientation from MediaBox (`doc_pages`, `doc_orientation`), caption counts (`text_features`), then `matchSlots()`: each own post takes
  the closest free post slot of its account within 4 h (closest pairs first) → `slot_weekly_id`, `slot_date`, `planned_format`,
  `detected_format`, `format_check` (match / mismatch / unknown / unplanned), `experiment_id/arm`. Free actions (cron key):
  `{"action":"save_creatives","days":14}`, `{"action":"match_slots"}`.
- **posted_at fix (v11):** when an account reshares its OWN old post, the actor's posted_at is the reshare time (Sahid's 3-week-old post
  showed as last night's). Own posts now take the time from the post id (LinkedIn ids are snowflakes: ms = id >> 22). 18 rows repaired.
- Format tests (Growth → Post experiments → New format test): account + format per arm, posts per arm; books the next free slots as
  post_plan rows (same account on both arms alternates A/B). Results count only `format_check = 'match'` posts, each vs its own
  account's 60-day median (accounts differ too much to compare raw); missed / wrong-format slots are listed and can be replaced
  ("Book N replacements"). Under 4 counted posts per arm = directional.
- Breakdowns: `.claude/skills/post-breakdown/SKILL.md` (fixed JSON of cover / pages / copy parts) → `daily_ops_posts.breakdown`, run by
  the weekly analysis (`routines/weekly-analysis.md` §2), which gets signed links to every slide in `payload.slides` (resource-request v5).
  Insights uses the measured format (hand tag > `detected_format` > Claude's guess). Document-post PDF extraction is untested live
  (no document posts yet): the PDF link keys tried are doc.pdf_url / url / document_url / manifest_url.
- **Recreate JSON** (`daily_ops_posts.recreate`, skill part B, `supabase/2026-10-11-post-recreate.sql`): the literal copy of the creative for
  GPT image: canvas, palette, fonts, every page as back-to-front layers (exact text, % boxes, font size/weight/hex, images, shapes, charts) and a
  standalone prompt per page + `gpt_image_pitfalls`. HQ: Growth → Posts → click a creative → Copy JSON for GPT image / Copy page N prompt /
  Copy breakdown.
- **Archetype** (breakdown v2, 13 Oct 2026): the recipe a creative copies, separate from the format. Format = what LinkedIn shows
  (measured); archetype = what the creative pretends to be (`fake_doc_viewer` = one image dressed as an open PDF with a contents page and a
  "Comment WORD" button; first seen on Felizitas Grein Groth's ROOM post, ~1K followers, 279 comments). List in the skill; ranked as the
  "Archetype" element in Playbook. Never add an archetype as a post_formats row: formats must be tellable apart by the scraper.
- **Playbook rebuilt + swipe file (14 Oct 2026; Tengku: Insights "too messy, can't derive anything", Playbook "useless metrics")**:
  Insights tab removed (`#/growth/insights` opens Playbook; its raw-median factor cards contradicted the account-normalised numbers).
  `hq/playbook.js` = one decision page: Do this week (▲ Keep / ▼ Stop = strongest element each side with 4+ posts, "No" values skipped;
  ? Test next = `growth_reports.next_tests[0]`, Book this test → `editExperiment`), Archetypes (ours from `breakdown.archetype` vs saved),
  Swipe file, Evidence folded (elements ranked + best/worst posts). Score-a-draft, recipe and the factor table were dropped.
  Swipe file (`hq/swipe.js`, `supabase/2026-10-14-swipe-file.sql`): `swipe_posts` + private bucket `swipe`; "Break down a post" uploads
  screenshots + caption + numbers, then resource-request action `breakdown` (admin; counts toward the daily Claude cap) fires the routine →
  `routines/breakdown.md` (skill redirect) writes `breakdown` / `recreate` / `archetype` / status. HQ polls every 20 s while queued.
  `ARCHETYPES` in swipe.js mirrors the skill list. The ROOM post is seeded (no screenshot: the sandbox can't upload to storage).
  Growth over time: `swipe_posts.posted_at` + `snapshots` [{at, reactions, comments, reposts}] (appended by "Update numbers", never
  overwritten); Open shows hours since posted + comments per hour, the text before "…see more" (`feedHook`: first paragraph, ≤210 chars)
  and the full caption with its line breaks. `image_paths` may hold a full https URL (the ROOM creative lives at
  `supabase/seed/swipe-room-felizitas.jpg`, served from raw.githubusercontent). The connector cancels UPDATE/DELETE from execute_sql too:
  the ROOM row was re-inserted with growth data. Same post saved twice (`postKey` = author + first 60 letters of the caption) shows as ONE
  row (copy with most readings / an image wins; Open → "Remove N extra copies"), and saving it again adds a reading to the existing row.
  Rows open on click (image included); the table shows the comment trajectory (279 (16 h) → 638 (35 h)).
  Second swipe post (14 Oct): Remo Duzkale's Claude Opus 5 + Fable 5 posts → archetype `launch_slide`, labelled "Presentation slide" (Tengku's "presentation format"; NOT the
  Presentation post_format, which is a landscape PDF document) (image `supabase/seed/swipe-opus5-remo.png`).
  Third: his "97+ Off-Market Mandates" post → `screenshot_proof` ("Proof screenshot"). Breakdown cover has `layout` (title_top_visual_below /
  full_bleed_art_text_over / document_viewer / …), ranked as "Cover layout" and shown under the archetype. Layouts were added by re-inserting
  the three earlier rows (UPDATE is blocked); newest copy wins the dedupe, old copies are hidden.
  `feedHook` = first 3 lines (blank counts) or ~210 chars; matches both saved posts' real "…more" cut.
  Weekly analysis re-does our breakdowns without an archetype (v1).
  **Must keep** (14 Oct, after a remix of the Opus 5 slide came out as a beige clipboard checklist with no launch, number or audience):
  `RECIPES` in swipe.js = per archetype, the rules that make it work + what may change. Open shows "✓ Must keep"; "Copy prompt for our
  version" (`remixPrompt`) = rules + swap slots + the original prompt as look reference; "Copy exact-copy prompt" = the literal original.
  **Anatomy** (same day, Tengku: "you need to know why each works"): `breakdown.anatomy` = zones (where / what / why), hierarchy (title,
  subtitle, accent words), colour (base, accent, borrowed, why), finish (polished vs raw and why), inner images, thumbnail test. Shown in
  Open as "How it's built" and fed into "Copy prompt for our version". Cross-post patterns live in the skill (big name on top + audience
  under it, top 30% carries it, polished title + raw/dense proof, on-topic inner images, one accent, meaningful art, 4:5). The 5 saved
  posts were re-inserted with anatomy (UPDATE blocked); older copies are hidden duplicates. 15 Oct: `anatomy.caption` / `anatomy.engagement` (what + why per caption choice and engagement
  mechanic: two-line hook, keyword = topic word, contents in caption, price anchors, connect/repost asks) added the same way. Only 8 of 51 own posts had a breakdown on 14 Oct.
- **Post types in Playbook (19 Oct 2026, Tengku: lead magnet posts and credibility posts have different jobs; he handles the credibility ones):**
  engine posts carry `kind` ('lm' | 'cred' | 'vid' | null): hand / Claude "Lead magnet" tag > the schedule slot's content code
  (`kindOfCode()` in insights.js, shared with schedule.js; data.js loads `daily_ops_weekly_posts` id → content_code) > breakdown naming a
  lead magnet. Playbook switches Lead magnet / Credibility / All (default lead magnets) and never pools them; untyped posts (scraped before
  slot matching) only show under All. Element labels were reworded for people ("List lines 5+" → "Bullet / numbered lines in caption: 5 or more").
- **Elements, ranked** (Growth → Playbook; `elementsOf()` / `elementEffects()` in scoring.js, tested in `node hq/scoring-test.mjs`): flattens
  measured format + `text_features` (bucketed) + `breakdown` into element values and scores each like a factor (lift vs own account,
  shrunk K=3). ▲/▼ symbols carry direction.
- **Guide** (`#/guide/<section>`, `hq/guide.js`, ops too): the team tutorial for this workflow (post, make, specs, plan, test, learn, gpt,
  fix). Linked from Today format lines, the format test modal and Post creation. Update it with any change to this workflow.

## Rules
- Mandates are under NDA. The US$108M Mauritius branded villas deal is shown anonymised; never name the brand.
- Never enter passwords, API keys or tokens for the user, even with permission. Point them to the HQ field.
- UI (redesigned 30 Sept): navy ink on cool mist, brass (`--brass`) as the one brand accent, serif page titles, and a
  colour per account (`--c1`…`--c12`, mapped in `acIdx()` in `hq/core.js`; use `avatar()` / `acctChip()` / `data-ac`).
  Light/dark/tan via tokens in `hq/app.css`; every colour is a token. No pill-shaped primary buttons, no decorative gradients.
- Today is about today only (week history lives on Overview; Today only keeps one red line for unfinished earlier-this-week tasks, expandable to Done now / Skip). Opening it with today's slots already ended and unticked shows, once per ops day per browser (localStorage `hq-whip-day`), `hq/whip.js`, a pixel
  knight whipping a slave sprite with CRACK! / "Work harder!" (user asked for it; shown to everyone incl. ops). Nav badge
  on Today = tasks left (red = overdue). Must work at 390px wide with no
  horizontal page scroll.
- Migrations: additive, saved under `supabase/` and applied with `apply_migration`.
- Testing HQ locally: `python3 -m http.server 8765`, open `hq.html?mock` (admin), `?mock=ops` (Anaz),
  `?mock=noconn`. `hq/mock.js` fakes Supabase and only loads on localhost. Playwright Chromium is at
  `/opt/pw-browsers/chromium`.
- The user (Tengku) wants short answers, pushback when warranted, and finished work rather than options.
