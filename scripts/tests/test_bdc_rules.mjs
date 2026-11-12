// Offline tests for supabase/functions/bdc-signals/rules.js: node scripts/tests/test_bdc_rules.mjs
// Real rows from bdc_signals; add every company that ranked where it shouldn't.
import assert from 'node:assert/strict';
import { classifyBdc } from '../../supabase/functions/bdc-signals/rules.js';

const today = new Date('2026-10-12T12:00:00Z');
const lmm = [{ bdc: 'BCP INVESTMENT CORP' }];

// Global Integrated Flooring (12 Oct 2026): was No. 1 at 81. $13.2M, 73¢, matures Dec 2026, PIK, PE-owned (RFE Investment Partners).
// It's a lender's problem (loan sale lane) and under Peter's $20M minimum: never a target.
const gifs = { company_name: 'Global Integrated Flooring Systems Inc.', facility: 13163000, mark: 72.5, prev_mark: 73.1, earliest_maturity: '2026-12-31',
  pik: true, spread: 9, lenders: 1, holders: lmm, period: '2026-06-30' };
let c = classifyBdc(gifs, today);
assert.equal(c.lane, 'loan_sale'); assert.equal(c.verdict, 'maybe');
assert.equal(classifyBdc({ ...gifs, facility: 30e6, earliest_maturity: '2027-06-30' }, today).verdict, 'target');   // $30M, 8 months out: Peter's call to the lender

// Performing loan, 10 months out, lower-middle-market lender, no owner found: the refinancing target we want.
const clean = { company_name: 'Acme Widgets LLC', facility: 25e6, mark: 96, prev_mark: 97, earliest_maturity: '2027-08-15', lenders: 1, holders: [{ bdc: 'FIDUS INVESTMENT CORP' }],
  period: '2026-06-30', owner_checked_at: '2026-10-12' };
c = classifyBdc(clean, today);
assert.equal(c.lane, 'refi'); assert.equal(c.verdict, 'target');
assert.equal(classifyBdc({ ...clean, owner: 'RFE Investment Partners' }, today).verdict, 'maybe');      // PE-owned: owner runs it
assert.equal(classifyBdc({ ...clean, earliest_maturity: '2026-12-31' }, today).verdict, 'maybe');      // 2.5 months: too late
assert.equal(classifyBdc({ ...clean, mark: 80 }, today).lane, 'loan_sale');                            // stressed: lender's call
assert.equal(classifyBdc({ ...clean, nonaccrual: true }, today).lane, 'loan_sale');
// A PIK option on a loan at par is not stress
assert.ok(classifyBdc({ ...clean, pik: true }, today).reasons.some(r => /PIK option/.test(r.text)));
// Ivanti (12 Oct 2026): $63M at 50¢ but a syndicated-loan buyer holds it too: trades on bank desks, not Peter's.
assert.equal(classifyBdc({ ...gifs, company_name: 'Ivanti Software, Inc.', facility: 63e6, mark: 55, holders: [{ bdc: 'PALMER SQUARE CAPITAL BDC INC.' }, { bdc: 'BCP INVESTMENT CORP' }], lenders: 2 }, today).verdict, 'maybe');
// Datalink (12 Oct 2026): $22.7M at 72¢ maturing in 42 days, both lenders run by BC Partners. Too late to sell; one seller.
const datalink = { company_name: 'Datalink, LLC', facility: 22.7e6, mark: 72.2, earliest_maturity: '2026-11-23', pik: true, lenders: 2, period: '2026-06-30',
  holders: [{ bdc: 'BCP INVESTMENT CORP' }, { bdc: 'BC PARTNERS LENDING CORP' }] };
c = classifyBdc(datalink, today);
assert.equal(c.lane, 'loan_sale'); assert.equal(c.verdict, 'maybe');
assert.ok(c.reasons.some(r => /one seller/.test(r.text)));
assert.equal(classifyBdc({ ...datalink, earliest_maturity: '2027-06-30' }, today).verdict, 'target');   // 8 months out: sellable
// Marley Spoon / Nomad Health (12 Oct 2026): venture debt and non-US companies don't trade through Peter.
assert.equal(classifyBdc({ ...bestSaleBase(), holders: [{ bdc: 'RUNWAY GROWTH FINANCE CORP.' }] }, today).verdict, 'maybe');
assert.equal(classifyBdc({ ...bestSaleBase(), country: 'Outside the US' }, today).verdict, 'maybe');
function bestSaleBase() { return { company_name: 'X Co', facility: 30e6, mark: 70, earliest_maturity: '2027-06-30', lenders: 1, holders: [{ bdc: 'FIDUS INVESTMENT CORP' }], period: '2026-06-30' }; }
assert.equal(classifyBdc(bestSaleBase(), today).verdict, 'target');
// Scores are out of 100: the best possible row in each lane scores 100, and rescaling never flips a verdict.
const best = { company_name: 'Best Co', facility: 25e6, mark: 90, prev_mark: 95, earliest_maturity: '2027-06-30', pik: true, lenders: 1, holders: [{ bdc: 'FIDUS INVESTMENT CORP' }], period: '2026-06-30', owner_checked_at: '2026-10-12' };
assert.equal(classifyBdc(best, today).score, 100);
const bestSale = { company_name: 'Sale Co', facility: 30e6, mark: 70, prev_mark: 80, nonaccrual: true, earliest_maturity: '2027-06-30', lenders: 2, holders: [{ bdc: 'FIDUS INVESTMENT CORP' }, { bdc: 'MONROE CAPITAL CORP' }], period: '2026-06-30' };
assert.equal(classifyBdc(bestSale, today).score, 100);
// v7: company web check (news after the lenders' report)
assert.equal(classifyBdc({ ...best, web: { at: '2026-11-13', refi: { date: '2026-09-15', quote: 'q' } } }, today).verdict, 'maybe');
assert.equal(classifyBdc({ ...best, web: { at: '2026-11-13', refi: { date: '2026-03-15', quote: 'q' } } }, today).verdict, 'target');
console.log('bdc rules ok');
