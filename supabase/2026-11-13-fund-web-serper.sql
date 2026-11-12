-- 13 Nov 2026 (Tengku): Serper (Google results) as the cheap first pass for fund web checks; Exa becomes the fallback.
create or replace function public.set_contact_key(p_name text, p_value text) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.can_access_dashboard() then raise exception 'admins only'; end if;
  if p_name not in ('BRAVE_SEARCH_KEY', 'HUNTER_API_KEY', 'PLUSVIBE_API_KEY', 'PROSP_API_KEY', 'EXA_API_KEY', 'SERPER_API_KEY') then raise exception 'unknown key'; end if;
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
    'exa', exists (select 1 from public.integration_secrets where key = 'EXA_API_KEY'),
    'serper', exists (select 1 from public.integration_secrets where key = 'SERPER_API_KEY')) else '{}'::jsonb end
$$;
grant execute on function public.set_contact_key(text, text), public.contact_keys_set() to authenticated;
