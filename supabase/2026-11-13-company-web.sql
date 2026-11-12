-- 13 Nov 2026: company web check (Serper) for Credit and BDC targets: already refinanced, adviser hired, being sold.
-- Written by fund-web (cron, after the fund checks); judged by classifyCredit (fund-signals/rules.js) and classifyBdc (bdc-signals/rules.js).
alter table public.credit_signals add column if not exists web jsonb, add column if not exists web_checked_at timestamptz;
alter table public.bdc_signals add column if not exists web jsonb, add column if not exists web_checked_at timestamptz;
-- fund_web_runs logs both: kind 'fund' | 'credit' | 'bdc' (separate daily caps, one monthly budget).
alter table public.fund_web_runs add column if not exists kind text not null default 'fund';
