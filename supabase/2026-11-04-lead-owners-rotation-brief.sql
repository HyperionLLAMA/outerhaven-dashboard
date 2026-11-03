-- Lead owners, round-robin follow-ups, To Reach Out stage, pre-meeting briefs (4 Nov 2026, Tengku).
-- Before the first meeting a lead talks to ONE person (owner_name, sticky).
-- After the first meeting (met_at) follow-up touches rotate Tengku -> Anaz -> Chase (last_touch_by decides who is next).
-- brief = the pre-meeting brief JSON the routine writes (routines/brief.md); HQ copies it from resource_jobs.payload.brief.
alter table public.people add column if not exists owner_name text;
alter table public.people add column if not exists met_at timestamptz;
alter table public.people add column if not exists last_touch_by text;
alter table public.people add column if not exists last_touch_at timestamptz;
alter table public.people add column if not exists touch_count integer not null default 0;
alter table public.people add column if not exists brief jsonb;
alter table public.people add column if not exists brief_job_id uuid;
alter table public.people add column if not exists brief_ready_job uuid;
alter table public.people add column if not exists brief_at timestamptz;

-- Run once by hand (the connector cancels UPDATEs): signal targets nobody has spoken to yet move to the new first stage.
-- update public.people set pipeline_stage = 'To Reach Out'
-- where pipeline_stage = 'New Relationship' and source in ('Form D','BDC loan signal','SEC credit signal','UCC signal');
