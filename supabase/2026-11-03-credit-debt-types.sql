-- Loan type tag on credit signals (instruments from XBRL: convertible notes, bonds / senior notes, revolver, term / secured loan).
alter table public.credit_signals add column if not exists debt_types text[];
