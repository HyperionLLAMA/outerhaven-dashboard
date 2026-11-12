// Offline tests for supabase/functions/fund-web/read.js: node scripts/tests/test_fund_web.mjs
import assert from 'node:assert/strict';
import { readResults, fundNo, amountNear, cleanName, queriesFor } from '../../supabase/functions/fund-web/read.js';

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
console.log('fund web ok');
