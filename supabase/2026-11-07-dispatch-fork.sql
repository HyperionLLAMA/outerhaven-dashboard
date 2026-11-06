-- 7 Nov 2026: the repo moved to Tengku's fork (HyperionLLAMA/outerhaven-dashboard), so pg_cron dispatches go there.
-- Already applied in the DB; saved here so the repo matches it. The dispatch token must have access to the fork.
create or replace function public.dispatch_fund_workflow(p_mode text)
 returns bigint
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare tok text; rid bigint;
begin
  select secret_value into tok from public.integration_secrets where key = 'GITHUB_DISPATCH_TOKEN';
  if coalesce(tok, '') = '' then return null; end if;
  -- 7 Nov 2026: the repo moved to Tengku's account (fork of chasehamby123/outerhaven-dashboard)
  select net.http_post(
    url := 'https://api.github.com/repos/HyperionLLAMA/outerhaven-dashboard/actions/workflows/fund-signals.yml/dispatches',
    body := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('mode', p_mode)),
    headers := jsonb_build_object('Authorization', 'Bearer ' || tok, 'Accept', 'application/vnd.github+json',
                                  'User-Agent', 'outerhaven-hq', 'X-GitHub-Api-Version', '2022-11-28', 'Content-Type', 'application/json')
  ) into rid;
  insert into public.fund_dispatch_log (mode, request_id) values (p_mode, rid);
  return rid;
end $function$;
