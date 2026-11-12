-- 13 Nov 2026 (Tengku): web checks on fund targets (Exa), and a "will they pay?" score on every pipeline person.
-- Additive only. The fund-web edge function writes fund_signals.web; fund-signals rules.js (RULES_VERSION 25) reads it.

-- 1. Web check result per fund vehicle: { at, pages, facts, final, first, later, aum, cost } (shape in supabase/functions/fund-web/read.js).
alter table public.fund_signals add column if not exists web jsonb;
alter table public.fund_signals add column if not exists web_checked_at timestamptz;
create index if not exists fund_signals_web_todo on public.fund_signals (score desc) where web_checked_at is null and verdict in ('target', 'maybe');

-- Monthly Exa budget in USD (13 Nov 2026, Tengku: cap it at $10). fund-web spreads it over the days left in the month.
alter table public.growth_settings add column if not exists fund_web_budget numeric not null default 10;

-- One row per fund checked (daily cap + cost log). Admins read it; only the service role writes.
create table if not exists public.fund_web_runs (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  fund_key text,
  signal_id uuid,
  pages int,
  facts int,
  cost_usd numeric
);
alter table public.fund_web_runs enable row level security;
create policy fund_web_runs_read on public.fund_web_runs for select to authenticated using (public.can_access_dashboard());

-- 2. Exa key joins the write-only key setter; status shows which keys are saved.
create or replace function public.set_contact_key(p_name text, p_value text) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.can_access_dashboard() then raise exception 'admins only'; end if;
  if p_name not in ('BRAVE_SEARCH_KEY', 'HUNTER_API_KEY', 'PLUSVIBE_API_KEY', 'PROSP_API_KEY', 'EXA_API_KEY') then raise exception 'unknown key'; end if;
  if coalesce(trim(p_value), '') = '' then raise exception 'empty key'; end if;
  insert into public.integration_secrets (key, secret_value, updated_at) values (p_name, trim(p_value), now())
  on conflict (key) do update set secret_value = excluded.secret_value, updated_at = now();
end $$;
create or replace function public.contact_keys_set() returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select case when public.can_access_dashboard() then jsonb_build_object(
    'brave', exists (select 1 from public.integration_secrets where key = 'BRAVE_SEARCH_KEY'),
    'hunter', exists (select 1 from public.integration_secrets where key = 'HUNTER_API_KEY'),
    'plusvibe', exists (select 1 from public.integration_secrets where key = 'PLUSVIBE_API_KEY'),
    'prosp', exists (select 1 from public.integration_secrets where key = 'PROSP_API_KEY'),
    'exa', exists (select 1 from public.integration_secrets where key = 'EXA_API_KEY')) else '{}'::jsonb end
$$;
grant execute on function public.set_contact_key(text, text), public.contact_keys_set() to authenticated;

-- 3. Cron: every 30 min the fund-web function checks the next best targets (it does nothing without an Exa key).
create or replace function public.invoke_fund_web() returns bigint
language plpgsql security definer set search_path to '' as $$
declare k text; rid bigint;
begin
  select secret_value into k from public.integration_secrets where key = 'FUND_CRON_SECRET';
  if k is null then raise exception 'FUND_CRON_SECRET is missing'; end if;
  select net.http_post(
    url := 'https://nfcysxqdwpdhrdpgxrlo.supabase.co/functions/v1/fund-web',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-outerhaven-cron', k),
    body := '{"action":"cron"}'::jsonb, timeout_milliseconds := 10000) into rid;
  return rid;
end $$;
revoke all on function public.invoke_fund_web() from public, anon, authenticated;
select cron.schedule('fund-web', '5,35 * * * *', 'select public.invoke_fund_web();');

-- 4. Will they pay? Demonstrated willingness, set by hand after a conversation (not a prediction):
-- 0 unknown, 1 says no / free intros only, 2 interested but resists upfront fees, 3 open to a paid scope,
-- 4 discussing budget / terms / pilot, 5 signed and paid the first invoice.
alter table public.people add column if not exists pay_score smallint check (pay_score between 0 and 5);
alter table public.people add column if not exists pay_note text;
alter table public.people add column if not exists pay_at timestamptz;
