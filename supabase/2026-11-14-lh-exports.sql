-- Linked Helper hand-off (14 Nov 2026, Tengku): HQ exports LinkedIn profile URLs per lane, split A / B, for Linked Helper campaigns.
-- One row per company exported, so the same company never goes out twice (also skipped if Prosp already has it).
-- status / replied_at are filled later by the results import (Linked Helper's CSV export), matched on linkedin_url.
create table if not exists public.lh_exports (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                    -- credit | bdc | fund
  key text not null,                     -- cik / company_key / fund_key
  lane text not null,                    -- credit | rescue | funds
  company_name text,
  person_name text,
  title text,
  linkedin_url text not null,
  hook text,                             -- the one dated fact (deadline line), when there is one
  sender text not null,                  -- whose LinkedIn account sends it
  version text not null check (version in ('A', 'B')),
  batch_id uuid not null,
  status text not null default 'exported' check (status in ('exported', 'sent', 'replied', 'skipped')),
  replied_at timestamptz,
  exported_by text,
  created_at timestamptz not null default now(),
  unique (kind, key)
);
create index if not exists lh_exports_li on public.lh_exports (linkedin_url);
alter table public.lh_exports enable row level security;
create policy lh_exports_admin on public.lh_exports for all to authenticated
  using (public.can_access_dashboard()) with check (public.can_access_dashboard());
