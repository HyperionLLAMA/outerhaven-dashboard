// Offline tests for supabase/functions/fund-signals/rules.js: node scripts/tests/test_fund_rules.mjs
import assert from 'node:assert/strict';
import { classify, strategyOf } from '../../supabase/functions/fund-signals/rules.js';

const now = Date.parse('2026-10-14');
const ago = m => new Date(now - m * 30.44 * 864e5).toISOString().slice(0, 10);
const fund = (o) => ({ list: 'fund1', fund_no: 1, company_name: 'Acme Credit Fund I, LP', state: 'NY', executives: [{ name: 'Jo Smith' }],
  offering: 40e6, check_status: 'clear', still_raising: 'D/A filed', filing_date: ago(14), amended_at: ago(2), ...o });

// Fund II stuck: 14 months in, first close done, 30% raised -> placement target on this fund.
let r = classify(fund({ fund_no: 2, company_name: 'Acme Credit Fund II, LP', first_sale: ago(14), sold: 12e6 }), now);
assert.equal(r.stage, 'stuck'); assert.equal(r.verdict, 'target');
assert.ok(r.reasons.some(x => /pitch placement on this fund/.test(x.text)));
assert.ok(!r.reasons.some(x => /Likely Fund II|pre-launch/.test(x.text)), 'no next-fund pitch while stuck');

// Fund I stuck: no fund track record -> maybe until attributable deals are confirmed.
r = classify(fund({ first_sale: ago(14), sold: 12e6 }), now);
assert.equal(r.stage, 'stuck'); assert.equal(r.verdict, 'maybe');

// Under 12 months: still the old "too early" maybe.
r = classify(fund({ first_sale: ago(8), filing_date: ago(8), sold: 12e6 }), now);
assert.equal(r.stage, 'raising'); assert.equal(r.verdict, 'maybe');

// Stuck with nothing raised: no first close -> maybe.
r = classify(fund({ first_sale: ago(14), sold: 0 }), now);
assert.equal(r.stage, 'stuck'); assert.equal(r.verdict, 'maybe');

// Live raise, stuck, weak Fund I and little re-up (Future Labs Capital Fund II, 19 Oct 2026) -> maybe, not target.
const fl = { list: 'live', fund_no: 2, company_name: 'Future Labs Capital Fund II, L.P.', state: 'NY', executives: [{ name: 'Jo Smith' }],
  offering: 65e6, sold: 6.5e6, first_sale: ago(19), filing_date: ago(1), investors: 25 };
r = classify({ ...fl, history: [{ name: 'Future Labs Capital Fund I, L.P.', fund_no: 1, first: ago(64), sold: 22.6e6, offering: 65e6 }] }, now);
assert.equal(r.verdict, 'maybe'); assert.ok(r.reasons.some(x => /re-upping/.test(x.text))); assert.ok(r.reasons.some(x => /35% of its/.test(x.text)));
// Same raise without history: unchanged (target).
assert.equal(classify(fl, now).verdict, 'target');
// Investors coming back: Fund II already past Fund I.
r = classify({ ...fl, sold: 25e6, history: [{ name: 'Future Labs Capital Fund I, L.P.', fund_no: 1, first: ago(64), sold: 22.6e6, offering: 25e6 }] }, now);
assert.ok(r.reasons.some(x => /coming back/.test(x.text)));

console.log('fund rules ok');

// Schutte Capital (19 Oct 2026): II opened 2022 with 4% raised, III opened 2021 with 17%. Both are maybe, not top targets.
const sch = [{ name: 'Schutte Capital III LP', fund_no: 3, first: '2021-03-22', sold: 16.7e6, offering: 100e6 }, { name: 'Schutte Capital II LP', fund_no: 2, first: '2022-08-10', sold: 3.6e6, offering: 100e6 }];
const schBase = { list: 'live', state: 'CO', executives: [{ name: 'Daniel Schutte' }], offering: 100e6, filing_date: '2026-07-27', history: sch };
r = classify({ ...schBase, fund_no: 2, company_name: 'Schutte Capital II LP', first_sale: '2022-08-10', sold: 3.6e6 }, now);
assert.equal(r.verdict, 'maybe'); assert.ok(r.reasons.some(x => /out of order/.test(x.text))); assert.ok(r.reasons.some(x => /stalled/.test(x.text)));
r = classify({ ...schBase, fund_no: 3, company_name: 'Schutte Capital III LP', first_sale: '2021-03-22', sold: 16.7e6 }, now);
assert.equal(r.verdict, 'maybe'); assert.ok(!r.reasons.some(x => /out of order/.test(x.text)));
console.log('schutte ok');

// HI Mark Capital (21 Oct 2026): Fund II raising, Fund I $6M -> ~$120K fees, couldn't pay $15K upfront. Stated, no points.
const hm = { list: 'live', fund_no: 2, company_name: 'HI Mark Capital Fund II, LP', state: 'SC', executives: [{ name: 'Herbert Drayton' }],
  offering: 75e6, sold: 0, filing_date: ago(1) };
const hmR = classify({ ...hm, history: [{ name: 'HI Mark Capital Fund I, LP', fund_no: 1, first: ago(54), sold: 6e6, offering: 6e6 }] }, now);
assert.ok(hmR.reasons.some(x => /Fee income about \$120K.*\$3K\/month.*success fee only/.test(x.text)), 'HI Mark pay line');
assert.equal(hmR.score, classify(hm, now).score, 'pay line on live rows adds no points');
// Retainer-ready: $30M+ under management.
assert.ok(classify({ ...hm, manager_total: 40e6 }, now).reasons.some(x => /retainer-ready/.test(x.text)));
console.log('pay ok');

// Earlier funds (21 Oct 2026, Tengku: Fund IIs showing no Fund I and a manager total of just Fund II).
import { managerHistory, formDTotal } from '../../supabase/functions/fund-signals/rules.js';
// DBDK: Fund I's Form D names no people, so the shared-person test dropped it. Same name minus the number = same manager.
const dbdk = { id: 'a', company_name: 'DBDK Venture Fund II, L.P.', manager_key: 'dbdk venture', fund_no: 2, executives: [{ name: 'Meredith McPherron' }], first_sale: '2024-08-15', sold: 28.75e6 };
const dbdk1 = { company_name: 'DBDK VENTURE FUND I, L.P.', manager_key: 'dbdk venture', fund_no: 1, executives: [], first_sale: '2021-02-18', sold: 10e6 };
assert.ok(managerHistory({ ...dbdk, prior_funds: [dbdk1] }, [dbdk]).some(h => h.fund_no === 1), 'DBDK Fund I linked');
assert.equal(formDTotal(dbdk, [dbdk, dbdk1]).total, 38.75e6, 'manager total counts Fund I');
// Same name but both filings name different people: still two managers (Nudel Holdings).
const nud = { id: 'n', company_name: 'Nudel Holdings II, LLC', manager_key: 'nudel', fund_no: 2, executives: [{ name: 'Paul Jaminet' }], filing_date: '2023-07-28' };
assert.ok(!managerHistory({ ...nud, prior_funds: [{ company_name: 'Nudel Holdings, LLC', manager_key: 'nudel', fund_no: 0, executives: [{ name: 'Richard Thoms' }], first_sale: '2020-09-11', sold: 4.5e6 }] }, [nud]).some(h => h.fund_no === 0), 'different people stay apart');
// Short generic names never match on name alone.
const sh = { id: 's', company_name: 'Surf II LP', manager_key: 'surf', fund_no: 2, executives: [] };
assert.ok(!managerHistory({ ...sh, prior_funds: [{ company_name: 'Surf I LP', manager_key: 'surf', fund_no: 1, executives: [], first_sale: '2020-01-01', sold: 1e6 }] }, [sh]).some(h => h.fund_no === 1), 'short name not matched');
console.log('earlier funds ok');
// Renamed Fund I found by searching people (22 Oct 2026): counts in the total when it shares a named person.
const rb = { id: 'r', company_name: 'Roers Income Fund II, LLC', manager_key: 'roers income', fund_no: 2, executives: [{ name: 'Brian Roers' }], sold: 74.6e6 };
assert.equal(formDTotal(rb, [rb, { company_name: 'Roers Multifamily Fund, LLC', manager_key: 'roers multifamily', fund_no: 0, executives: [{ name: 'Brian Roers' }], sold: 20e6 }]).total, 94.6e6);
assert.equal(formDTotal(rb, [rb, { company_name: 'Other Fund I', manager_key: 'other', fund_no: 1, executives: [{ name: 'Jo Smith' }], sold: 20e6 }]).total, 74.6e6, 'strangers never add up');
console.log('renamed ok');

// Credit funds that sat in 'other' until 2 Nov 2026.
for (const n of ['EAM Litigation Finance Fund I LP', 'Whiskey Capital Secured Financing Fund II, L.P.', 'TCW Rescue Financing Fund III LP',
  'HPS Special Situations Opportunity Fund II, L.P.', 'LivBrook Distress Fund I, LP', 'Sona Capital Solutions II SCSp', 'ECM Yield Fund II, LLC',
  'Silver Point Distressed Opportunity Institutional Partners II, L.P.', 'OC Trade Finance I LP'])
  assert.equal(strategyOf({ company_name: n }), 'credit', n);
for (const [n, want] of [['Plug & Play Financial Services Fund I, L.P.', 'other'], ['HO Fund II, a series of Socially Financed, LP', 'other'],
  ['Five Point Natural Gas Yield Fund I LP', 'infra'], ['Acme Multifamily Income Fund II', 'real_estate'], ['Acme Ventures Fund II', 'venture'], ['KING STREET REAL ESTATE SPECIAL SITUATIONS (EUROPE) FUND II, L.P.', 'real_estate']])
  assert.equal(strategyOf({ company_name: n }), want, n);
console.log('strategy ok');
