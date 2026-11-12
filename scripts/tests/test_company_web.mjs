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
{
  const { officersIn, officersFromPages } = await import('../../supabase/functions/fund-web/company.js');
  const o = t => officersIn(t).map(x => `${x.event}:${x.name}:${x.role}${x.interim ? ':interim' : ''}`);
  assert.deepEqual(o('The Board appointed Alexis N. Tirrito as interim Chief Financial Officer following the resignation of Raymond Frech.'), ['appointed:Alexis N. Tirrito:cfo:interim', 'left:Raymond Frech:cfo']);
  assert.deepEqual(o('On July 30, 2026, Ryan Zeek notified the Company of his resignation as Chief Financial Officer, effective August 29, 2026.'), ['left:Ryan Zeek:cfo']);
  assert.deepEqual(o('Acme Widgets announced that Jane Doe has been appointed Chief Financial Officer, effective immediately.'), ['appointed:Jane Doe:cfo']);
  assert.deepEqual(o('Dale Strang, the Company\'s Chief Executive Officer, will also serve as interim principal financial officer.'), ['appointed:Dale Strang:cfo:interim']);
  assert.deepEqual(o('Acme Widgets names Maria Lopez CFO.'), []);   // no "as": too loose to trust
  assert.deepEqual(o('Acme Widgets names Maria Lopez as CFO.'), ['appointed:Maria Lopez:cfo']);
  assert.deepEqual(o('John Smith stepped down as Chief Executive Officer of Acme Widgets.'), ['left:John Smith:ceo']);
  assert.deepEqual(o('The Board of Directors approved the bonus plan for the Chief Executive Officer.'), []);
  const ps = officersFromPages('Acme Widgets, Inc.', [{ url: 'https://www.businesswire.com/a', title: 'Acme Widgets Appoints New CFO', date: 'Oct 2, 2026', text: 'The company appointed Jane Doe as Chief Financial Officer. Other news follows.' }]);
  assert.equal(ps[0].name, 'Jane Doe'); assert.equal(ps[0].date, '2026-10-02');
  console.log('officers ok');
}
{
  const { officersFromPages } = await import('../../supabase/functions/fund-web/company.js');
  const pg = text => [{ url: 'https://x.com/a', title: 'Exec moves', date: 'Oct 2, 2026', text }];
  assert.equal(officersFromPages('Acme Widgets, Inc.', pg('Jane Doe, formerly of Acme Widgets, was named Chief Financial Officer of Globex.')).length, 0);
  assert.equal(officersFromPages('Acme Widgets, Inc.', pg('Acme Widgets alum Jane Doe has been appointed Chief Financial Officer of Globex Corp.')).length, 0);
  assert.equal(officersFromPages('Acme Widgets, Inc.', pg('Jane Doe has been appointed Chief Financial Officer of Acme Widgets.')).length, 1);
  console.log('other-company jobs ok');
}
{
  const { sponsorsIn, sponsorsFromPages } = await import('../../supabase/functions/fund-web/company.js');
  assert.deepEqual(sponsorsIn('"We are excited to partner with management," said Jane Doe, a Partner at Audax Private Equity.', 'Audax Private Equity').map(x => x.name), ['Jane Doe']);
  assert.deepEqual(sponsorsIn('ICV Partners Principal John Roe will join the board.', 'ICV Partners').map(x => x.title + ':' + x.name), ['Principal:John Roe']);
  assert.deepEqual(sponsorsIn('The Board of Directors at ICV Partners approved it.', 'ICV Partners'), []);
  const ps = sponsorsFromPages('Total Access Urgent Care', 'ICV Partners', [{ url: 'https://x.com', title: 'ICV Partners invests in Total Access Urgent Care', text: 'ICV Partners has made a majority investment. "Strong team," said Jane Doe, Managing Director at ICV Partners.' }]);
  assert.equal(ps[0].name, 'Jane Doe'); assert.equal(ps[0].on_deal, true);
  console.log('sponsors ok');
}
{
  const { sponsorsIn, sponsorsFromPages } = await import('../../supabase/functions/fund-web/company.js');
  // PCS Software / LLR Partners (13 Nov 2026 live check): the three ways releases and deal sites write it
  assert.equal(sponsorsIn('said Michael Pantilione, Partner at LLR Partners.', 'LLR Partners')[0].name, 'Michael Pantilione');
  assert.equal(sponsorsIn('with our technology," Michael Pantilione, LLR Partners Partner.', 'LLR Partners')[0].name, 'Michael Pantilione');
  assert.equal(sponsorsIn('said Kevin Johnson, Principal, Capstreet.', 'Capstreet')[0].name, 'Kevin Johnson');
  assert.equal(sponsorsFromPages('Prisma Graphic, LLC', 'CenterGate Capital', [{ url: 'https://www.centergatecapital.com/post/centergate-capital-partners-with-prisma', title: 'CenterGate Capital partners with Prisma', text: 'said Jeff Kovick, Managing Director at CenterGate Capital.' }])[0].on_deal, true);
  console.log('sponsor forms ok');
}
{
  // Real 8-K Item 5.02 sentences, shared with scripts/tests/test_officers.py
  const { officersIn } = await import('../../supabase/functions/fund-web/company.js');
  const fs = await import('node:fs'), cases = JSON.parse(fs.readFileSync(new URL('./officer_cases.json', import.meta.url)));
  for (const [t, want] of cases) assert.deepEqual(officersIn(t).map(x => `${x.event}:${x.name}:${x.role}${x.interim ? ':interim' : ''}`).sort(), [...want].sort(), t.slice(0, 60));
  console.log('8-K cases ok');
}
