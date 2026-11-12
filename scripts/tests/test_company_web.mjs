// Offline tests for supabase/functions/fund-web/company.js: node scripts/tests/test_company_web.mjs
import assert from 'node:assert/strict';
import { brand, scanCompany, readCompany, dateOf, companyQueries } from '../../supabase/functions/fund-web/company.js';

assert.equal(brand('HYDROFARM HOLDINGS GROUP, INC.'), 'Hydrofarm');
assert.equal(brand('TAUC Management, LLC'), 'TAUC Management');
assert.equal(brand('Global Integrated Flooring Solutions, Inc.'), 'Global Integrated Flooring Solutions');
assert.match(companyQueries('Acme Widgets, Inc.')[0], /^"Acme Widgets" refinancing/);
const now = new Date('2026-11-13T00:00:00Z');
assert.equal(dateOf('3 weeks ago', now), '2026-10-23');
assert.equal(dateOf('Mar 4, 2026'), '2026-03-04');
assert.equal(dateOf('yesterday-ish'), null);

const pg = (text, date = 'Oct 1, 2026') => ({ url: 'https://www.prnewswire.com/x', date, text });
const ev = (name, text) => scanCompany(name, pg(text), now).map(f => f.event);
// refinanced
assert.deepEqual(ev('Acme Widgets, Inc.', 'Acme Widgets, Inc. today announced it has entered into a new $85 million senior secured credit facility with Siebert Bank.'), ['refinanced']);
assert.deepEqual(ev('Acme Widgets, Inc.', 'Acme Widgets completed the refinancing of its term loan, extending the maturity to 2031.'), ['refinanced']);
assert.deepEqual(ev('Acme Widgets, Inc.', 'Acme Widgets entered into an amendment and extension of its credit agreement with its lenders.'), ['refinanced']);
// adviser / sale process
assert.deepEqual(ev('Acme Widgets, Inc.', 'Acme Widgets has retained Houlihan Lokey as its financial advisor to explore options.'), ['adviser']);
assert.deepEqual(ev('Acme Widgets, Inc.', 'The board of Acme Widgets announced a review of strategic alternatives, including a sale.'), ['adviser']);
// being sold vs buying
assert.deepEqual(ev('Acme Widgets, Inc.', 'Acme Widgets has entered into a definitive agreement to be acquired by Blackstone for $400 million.'), ['sale']);
assert.deepEqual(ev('Acme Widgets, Inc.', 'Blackstone completed the acquisition of Acme Widgets in a deal valued at $400 million.'), ['sale']);
assert.deepEqual(ev('Acme Widgets, Inc.', 'Acme Widgets completed the acquisition of Beta Tools, expanding its West Coast footprint.'), []);
// company must be in the same sentence; generic debt talk doesn't count
assert.deepEqual(ev('Acme Widgets, Inc.', 'Acme Widgets reported revenue of $60 million. The company entered into a new credit facility.'), []);
assert.deepEqual(ev('Acme Widgets, Inc.', 'Acme Widgets reported higher interest expense on its credit facility.'), []);

const w = readCompany('Acme Widgets, Inc.', [pg('Acme Widgets entered into a new $50 million term loan facility.', 'Jan 5, 2026'), pg('Acme Widgets completed the refinancing of its credit facility on better terms.', '2 weeks ago')], '2026-11-13', now);
assert.equal(w.facts, 2); assert.equal(w.refi.date, '2026-10-30'); assert.equal(w.adviser, null);
console.log('company web ok');
// First live run (13 Nov 2026): "ADS Group Opco" became "ADS", which matched "roads" / "leads".
assert.equal(brand('ADS Group Opco, LLC'), 'ADS Group');
assert.deepEqual(scanCompany('Acme, Inc.', { url: 'https://x.com', text: 'Acmeco Partners entered into a new credit facility with its bank.' }), []);
console.log('short names ok');
// Same run: class-action notices and stock-tip headlines are not a sale.
assert.deepEqual(scanCompany('Microvast Holdings, Inc.', { url: 'https://x.com', text: 'If you are an investor who purchased or otherwise acquired Microvast securities during the Class Period, you have until September 21, 2026.' }), []);
assert.deepEqual(scanCompany('Postal Realty Trust, Inc.', { url: 'https://x.com', text: '5 Reasons to Buy Postal Realty Trust Stock Right Now.' }), []);
console.log('false sales ok');
