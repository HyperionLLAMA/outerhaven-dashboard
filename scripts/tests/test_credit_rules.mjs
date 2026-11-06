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
  assert.equal(r.verdict, 'cut', `${n} is a rescue`);
  assert.ok(r.tags.some(t => t === 'burning_cash' || t === 'over_levered'), `${n} tagged unfinanceable`);
  assert.ok(r.reasons.some(x => /rescue.*private credit rarely/.test(x.text)), `${n} says rescue`);
  assert.ok(r.score < ams.score, `${n} (${r.score}) below AMS (${ams.score})`);
}
assert.ok(ams.tags.includes('lendable') && dlh.tags.includes('lendable'));
// Too big (4 Nov 2026): INNOVATE $616M debt, Universal Logistics $1.56B revenue.
const vate = classifyCredit({ ...base, debt_current: 553.9e6, debt_noncurrent: 62.1e6, cash: 87.8e6, revenue: 1246e6, ebitda: 59.1e6, interest_expense: 30e6, public_float: 100e6, flags: gc });
assert.equal(vate.verdict, 'cut'); assert.ok(vate.tags.includes('too_big'));
// Numbers we can't trust stay Maybe with a tag: 1847 Holdings interest covered 60.9x, Evofem no debt figure.
const lbra = classifyCredit({ ...base, debt_current: 22.8e6, cash: 0.4e6, revenue: 48.3e6, ebitda: 5.4e6, interest_expense: 0.09e6, public_float: 10e6, flags: gc });
const evfm = classifyCredit({ ...base, cash: 0.3e6, revenue: 20.2e6, ebitda: 3.4e6, interest_expense: 2.4e6, public_float: 10e6, flags: gc });
for (const r of [lbra, evfm]) { assert.equal(r.verdict, 'maybe'); assert.ok(r.tags.includes('check_data')); }
console.log('credit rules ok', { ams: ams.score, dlh: dlh.score, xcf: xcf.score, hyfm: hyfm.score, spru: spru.score });
// 7 Nov 2026 audit. Real maturity dates beat the balance sheet; no debt figure never reads as "bank will refinance";
// a sub-$10M loan is cut; EBITDA $5M+ can pay a retainer.
const inMonths = m => new Date(Date.now() + m * 30.44 * 864e5).toISOString().slice(0, 10);
const mat = (...ms) => ({ maturities: { form: '10-Q', items: ms.map(m => ({ date: inMonths(m), quote: 'due' })) } });
const healthy = { ...base, debt_noncurrent: 120e6, cash: 10e6, revenue: 150e6, ebitda: 25e6, interest_expense: 8e6, public_float: 200e6 };
const due9 = classifyCredit({ ...healthy, flags: mat(9, 40) });
assert.equal(due9.verdict, 'target'); assert.ok(due9.tags.includes('lane_refi') && due9.tags.includes('can_pay'));
assert.equal(classifyCredit({ ...healthy, flags: mat(40) }).verdict, 'maybe', 'no maturity in 2 years = no trigger');
assert.equal(classifyCredit({ ...healthy, flags: mat(2) }).verdict, 'maybe', 'under 4 months = too late');
const ssk = classifyCredit({ ...healthy, debt_current: 158e6, cash: 133e6, flags: mat(36) });
assert.equal(ssk.verdict, 'maybe', 'Shutterstock: current on the balance sheet, filing says 2029');
assert.ok(!evfm.tags.includes('bank_refi'), 'Evofem: no debt figure is not net cash');
const mtex = classifyCredit({ ...base, debt_current: 0.27e6, debt_noncurrent: 2.75e6, cash: 6.5e6, revenue: 108e6, ebitda: 0.67e6, public_float: 9.9e6, flags: gc });
assert.equal(mtex.verdict, 'cut'); assert.ok(mtex.tags.includes('small_loan'));
assert.ok(ams.tags.includes('lane_rescue'));
console.log('audit cases ok', { due9: due9.score });
