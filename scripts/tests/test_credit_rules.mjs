// Offline tests for classifyCredit (supabase/functions/fund-signals/rules.js): node scripts/tests/test_credit_rules.mjs
// Real rows from credit_signals on 3 Nov 2026. Rescues (negative EBITDA, >10x, interest not covered) must not outrank lendable names.
import assert from 'node:assert/strict';
import { classifyCredit } from '../../supabase/functions/fund-signals/rules.js';

const base = { period_end: new Date().toISOString().slice(0, 10), state: 'DE', sic: '5000' };
const gc = { going_concern: { form: '10-Q', date: '2026-08-14' } }, fb = { forbearance: { form: '8-K', date: '2026-08-14' } };
const ams = classifyCredit({ ...base, debt_current: 16.2e6, cash: 6.5e6, revenue: 28.1e6, ebitda: 2.1e6, interest_expense: 1.57e6, public_float: 11.9e6, flags: { ...gc, ...fb } });
const dlh = classifyCredit({ ...base, debt_current: 21.4e6, debt_noncurrent: 104.9e6, cash: 0.2e6, revenue: 344.5e6, ebitda: 34e6, interest_expense: 13.6e6, public_float: 100e6, flags: {} });
const xcf = classifyCredit({ ...base, debt_current: 124.2e6, cash: 0.33e6, revenue: 20.8e6, ebitda: -67.9e6, public_float: 95.5e6, flags: { ...gc, ...fb } });
const hyfm = classifyCredit({ ...base, debt_current: 114.4e6, cash: 6.6e6, revenue: 134.3e6, ebitda: -253.8e6, interest_expense: 12.7e6, public_float: 16e6, flags: { ...gc, ...fb } });
const agen = classifyCredit({ ...base, debt_current: 30.1e6, cash: 18.7e6, revenue: 114.2e6, ebitda: -10.2e6, interest_expense: 1.2e6, public_float: 135.4e6, flags: { ...gc, ...fb } });
const kpti = classifyCredit({ ...base, debt_current: 40.3e6, cash: 55.3e6, revenue: 146.1e6, ebitda: -90.7e6, interest_expense: 10.7e6, public_float: 200e6, flags: {} });
const celu = classifyCredit({ ...base, cash: 10.4e6, revenue: 26.6e6, ebitda: -54e6, interest_expense: 2.5e6, public_float: 50e6, flags: { ...gc, ...fb } });
const spru = classifyCredit({ ...base, debt_current: 269.6e6, debt_noncurrent: 393e6, cash: 81.5e6, revenue: 111.8e6, ebitda: 48.1e6, interest_expense: 50.9e6, public_float: 31.6e6, flags: gc });

assert.equal(ams.verdict, 'target'); assert.ok(ams.reasons.some(r => /^Lendable/.test(r.text)));
assert.equal(dlh.verdict, 'target'); assert.ok(dlh.reasons.some(r => /^Lendable/.test(r.text)));
for (const [n, r] of [['XCF', xcf], ['Hydrofarm', hyfm], ['Spruce', spru], ['Agenus (small net debt)', agen], ['Karyopharm (net cash)', kpti], ['Celularity (no debt tags)', celu]]) {
  assert.equal(r.verdict, 'maybe', `${n} is a rescue`);
  assert.ok(r.reasons.some(x => /rescue.*private credit rarely/.test(x.text)), `${n} says rescue`);
  assert.ok(r.score < ams.score, `${n} (${r.score}) below AMS (${ams.score})`);
}
console.log('credit rules ok', { ams: ams.score, dlh: dlh.score, xcf: xcf.score, hyfm: hyfm.score, spru: spru.score });
