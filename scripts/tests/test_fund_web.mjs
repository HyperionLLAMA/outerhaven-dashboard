// Offline tests for supabase/functions/fund-web/read.js: node scripts/tests/test_fund_web.mjs
import assert from 'node:assert/strict';
import { readResults, fundNo, amountNear, cleanName, queriesFor, scanPage, htmlText, firmName, serperQueries } from '../../supabase/functions/fund-web/read.js';

assert.equal(fundNo('Acme Ventures Fund II'), 2);
assert.equal(fundNo('Acme Fund III-A, L.P.'), 3);
assert.equal(fundNo('Acme Fund 2'), 2);
assert.equal(fundNo("Acme closed its second venture fund"), 2);
assert.equal(fundNo('Acme Ventures'), 0);
assert.equal(amountNear('Acme closed Fund II at $50 million, bringing total AUM to $120 million.', /clos/), 50e6);
assert.equal(amountNear('Acme closed Fund II at $50 million, bringing total AUM to $120 million.', /aum/i), 120e6);
assert.equal(amountNear('The firm raised US$1.2 billion.', /raised/), 1.2e9);
assert.equal(amountNear('No money here.', /clos/), null);
assert.equal(cleanName('Ground Game Venture Fund I, L.P.'), 'Ground Game Venture Fund I');
assert.equal(queriesFor({ company_name: 'Acme Ventures Fund I, LP', check_keyword: 'Acme', executives: [{ name: 'Jo Smith' }], first_sale: '2023-02-01' }).length, 2);

const s = { company_name: 'Acme Ventures Fund I, LP', check_keyword: 'Acme', fund_no: 1 };
const page = (url, text, summary, extra = {}) => ({ url, title: 'Acme news', text, summary: JSON.stringify(summary), publishedDate: '2025-06-02T00:00:00.000Z', ...extra });
const closeTxt = 'NEW YORK, June 2, 2025. Acme Ventures announced the final close of Acme Ventures Fund I at $42 million, above its $35 million target. The firm now manages $60 million in assets.';
let w = readResults(s, [page('https://news.example.com/a', closeTxt, {
  about_manager: true,
  events: [{ fund_name: 'Acme Ventures Fund I', event: 'final_close', date: 'June 2, 2025', quote: 'Acme Ventures announced the final close of Acme Ventures Fund I at $42 million, above its $35 million target.' }],
  aum_quote: 'The firm now manages $60 million in assets.',
})]);
assert.equal(w.final.amount, 42e6); assert.equal(w.final.date, '2025-06-02'); assert.equal(w.aum.amount, 60e6); assert.equal(w.later, null);

// A quote the page doesn't contain (LLM paraphrase) is dropped.
w = readResults(s, [page('https://news.example.com/b', closeTxt, { about_manager: true, events: [{ fund_name: 'Acme Ventures Fund I', event: 'final_close', quote: 'Acme closed Fund I with $90 million in commitments from LPs.' }] })]);
assert.equal(w.final, null); assert.equal(w.facts, 0);

// A page that never names the manager is ignored, even with a matching quote.
w = readResults(s, [page('https://other.example.com/c', 'Zeta Partners held the final close of Zeta Fund I at $42 million today.', { about_manager: true, events: [{ fund_name: 'Zeta Fund I', event: 'final_close', quote: 'Zeta Partners held the final close of Zeta Fund I at $42 million today.' }] })]);
assert.equal(w.final, null);

// Newer fund announced: later = the highest fund number; SEC mirrors are skipped; duplicate URLs count once.
const f2 = 'Acme Ventures has held a first close of Acme Ventures Fund II at $25 million, the firm said on Tuesday.';
w = readResults(s, [
  page('https://pr.example.com/d', f2, { about_manager: true, events: [{ fund_name: 'Acme Ventures Fund II', event: 'first_close', date: '2026-09-15', quote: f2 }] }),
  page('https://pr.example.com/d', f2, { about_manager: true, events: [] }),
  page('https://www.sec.gov/x', closeTxt, { about_manager: true, events: [{ fund_name: 'Acme Ventures Fund I', event: 'final_close', quote: 'Acme Ventures announced the final close of Acme Ventures Fund I at $42 million, above its $35 million target.' }] }),
]);
assert.equal(w.pages, 1); assert.equal(w.later.fund_no, 2); assert.equal(w.later.amount, 25e6); assert.equal(w.final, null);

// Bad summary JSON doesn't throw.
w = readResults(s, [{ url: 'https://x.example.com', text: 'Acme', summary: '{not json' }]);
assert.equal(w.facts, 0);

// Serper path: plain-code sentence scan of a fetched page, then the same readResults trust rule.
assert.equal(firmName({ company_name: 'Ground Game Venture Fund I, L.P.' }), 'Ground Game Venture');
assert.deepEqual(serperQueries({ company_name: 'Acme Ventures Fund II, LP', fund_no: 2, executives: [{ name: 'Jo Smith' }] }),
  ['"Acme Ventures" "Fund II" close', '"Acme Ventures" "Fund III"', '"Acme Ventures" "Jo Smith" fund assets under management']);
const html = `<html><head><script>var x = "Acme Fund I final close $999 million";</script></head><body><h1>Acme news</h1>
  <p>NEW YORK &ndash; Acme Ventures today announced the final close of Acme Ventures Fund I at $42 million, above its $35 million target.</p>
  <p>Acme Ventures has also held a first close of Acme Ventures Fund II at $15 million.</p><p>The firm now manages $60 million in assets.</p>
  <p>Zeta Partners closed Zeta Fund III at $500 million.</p></body></html>`;
w = readResults(s, [scanPage(s, { url: 'https://pr.example.com/x', title: 'Acme news', text: htmlText(html), date: '2025-06-02' })]);
assert.equal(w.final.amount, 42e6, 'final close from page text, script ignored');
assert.equal(w.later.fund_no, 2); assert.equal(w.later.event, 'first_close'); assert.equal(w.later.amount, 15e6);
assert.equal(w.aum.amount, 60e6);
assert.equal(w.facts, 2, 'Zeta sentence ignored (no manager name)');
// A Google snippet works the same way when the page can't be fetched.
w = readResults(s, [scanPage(s, { url: 'https://paywalled.example.com/y', title: 'Acme closes', text: 'Jun 2, 2025 ... Acme Ventures closed Acme Ventures Fund I with $42 million in commitments ...' })]);
assert.equal(w.final.amount, 42e6);
console.log('fund web ok');
