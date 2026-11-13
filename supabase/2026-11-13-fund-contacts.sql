-- 13 Nov 2026: LinkedIn URLs for fund GPs (the people on the Form D). signal-contacts stores them as kind 'fund', key = fund_key.
-- Contains DROP CONSTRAINT, so the Supabase connector cancels it: run it in the Supabase SQL editor.
alter table public.signal_contacts drop constraint if exists signal_contacts_kind_check;
alter table public.signal_contacts add constraint signal_contacts_kind_check check (kind in ('credit', 'bdc', 'ucc', 'fund'));
