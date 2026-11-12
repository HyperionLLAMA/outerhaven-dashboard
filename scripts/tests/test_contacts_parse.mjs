// Offline tests for supabase/functions/signal-contacts/parse.js: node scripts/tests/test_contacts_parse.mjs
import assert from 'node:assert/strict';
import { brand, profileFrom, websiteFrom, mergePeople, roleOf, sameCompany } from '../../supabase/functions/signal-contacts/parse.js';

assert.equal(brand('OmniGuide Holdings, Inc.'), 'OmniGuide');
assert.equal(brand('AMBA Buyer, Inc.'), 'AMBA');
assert.equal(brand('Global Integrated Flooring Systems Inc.'), 'Global Integrated Flooring Systems');
assert.equal(roleOf('Chief Financial Officer'), 'cfo');
assert.equal(roleOf('President & CEO'), 'ceo');

const p = profileFrom({ url: 'https://www.linkedin.com/in/robert-allen-123?trk=x', title: 'Robert Allen - Chief Financial Officer - OmniGuide | LinkedIn', description: 'Experience: OmniGuide · Location: Boston' }, 'OmniGuide Holdings, Inc.');
assert.deepEqual(p, { name: 'Robert Allen', title: 'Chief Financial Officer', role: 'cfo', employer: 'OmniGuide', linkedin: 'https://www.linkedin.com/in/robert-allen-123' });
// Wrong company: rejected
assert.equal(profileFrom({ url: 'https://www.linkedin.com/in/jane', title: 'Jane Doe - CFO - Acme Corp | LinkedIn', description: 'Acme' }, 'OmniGuide Holdings'), null);
// Not a finance / top role: rejected
assert.equal(profileFrom({ url: 'https://www.linkedin.com/in/joe', title: 'Joe Bloggs - Sales Manager - OmniGuide | LinkedIn', description: 'OmniGuide sales' }, 'OmniGuide'), null);
// Company page, not a person: rejected
assert.equal(profileFrom({ url: 'https://www.linkedin.com/company/omniguide', title: 'OmniGuide | LinkedIn', description: '' }, 'OmniGuide'), null);
// Credentials stripped from the name
assert.equal(profileFrom({ url: 'https://linkedin.com/in/a', title: 'Mary Smith, CPA – VP Finance – Marquis Software | LinkedIn', description: 'Marquis Software' }, 'Marquis Software Solutions Inc').name, 'Mary Smith');

assert.deepEqual(websiteFrom([{ url: 'https://www.zoominfo.com/c/omniguide/1' }, { url: 'https://www.omni-guide.com/about' }], 'OmniGuide Holdings, Inc.'), { website: 'https://omni-guide.com', domain: 'omni-guide.com' });
assert.equal(websiteFrom([{ url: 'https://www.bloomberg.com/x' }], 'OmniGuide'), null);

const m = mergePeople([{ name: 'Robert Allen', role: 'cfo', status: 'confirmed', email: 'r@x.com' }, { name: 'Old CEO', role: 'ceo', status: 'wrong' }],
  [{ name: 'Robert Allen', role: 'cfo', linkedin: 'https://linkedin.com/in/ra', title: 'CFO' }, { name: 'New CEO', role: 'ceo' }]);
assert.equal(m[0].name, 'Robert Allen'); assert.equal(m[0].email, 'r@x.com'); assert.equal(m[0].linkedin, 'https://linkedin.com/in/ra');
assert.equal(m[m.length - 1].name, 'Old CEO');
// Real false positives from the first live run (10 Oct 2026)
assert.equal(profileFrom({ url: 'https://www.linkedin.com/in/em', title: 'Essence Montgomery - Finance Manager - Acme | LinkedIn', description: 'Acme' }, 'Essence Communications Inc.'), null);
assert.equal(profileFrom({ url: 'https://www.linkedin.com/in/fg', title: 'Fidel Gbesso - Global CFO - Contoso | LinkedIn', description: 'Global CFO at Contoso' }, 'Global Integrated Flooring Systems Inc.'), null);
assert.equal(profileFrom({ url: 'https://www.linkedin.com/in/co', title: 'Chris Ortega - Fractional CFO for SMBs ($1M–$50M) | LinkedIn', description: 'ORL' }, 'ORL Holdco, Inc.'), null);
assert.equal(profileFrom({ url: 'https://www.linkedin.com/in/jw', title: 'John Watson - Chief Financial Officer - Global Integrated Flooring Systems | LinkedIn', description: '' }, 'Global Integrated Flooring Systems Inc.').name, 'John Watson');
assert.equal(websiteFrom([{ url: 'https://www.orl.bc.ca/' }], 'ORL Holdco, Inc.'), null);
assert.ok(profileFrom({ url: 'https://linkedin.com/in/cw', title: 'Caroline Wanga - President/CEO✨Mela-Preneur✨Thought Innovator - Essence Communications | LinkedIn', description: '' }, 'Essence Communications Inc.').title.length <= 60);
assert.equal(profileFrom({ url: 'https://www.linkedin.com/in/em2', title: 'Essence Montgomery - Finance Manager | LinkedIn', description: 'Essence Montgomery. Finance Manager at Contoso.' }, 'Essence Communications Inc.'), null);

// Real misses from the 10 Oct 2026 BDC lookups (Brave results), all must be rejected:
const R = (title, description = '') => ({ url: 'https://www.linkedin.com/in/x', title, description });
assert.equal(profileFrom(R('Jack C. - Vice President at Colonnade Advisors LLC', 'Experience: Colonnade Advisors LLC'), 'Colonnade Parent, Inc.'), null); // other firm + VP
assert.equal(profileFrom(R('Derek Spies - Colonnade Advisors LLC | LinkedIn', 'Experience: Colonnade Advisors LLC'), 'Colonnade Parent, Inc.'), null);
assert.equal(profileFrom(R('Jessica MacDonald - Venbrook | LinkedIn', 'We’re excited to welcome Kenneth Ward as Chief Financial Officer'), 'Venbrook Buyer, LLC'), null); // role is someone else's
assert.equal(profileFrom(R('Rosie Wang - Corporate Travel Management (CTM) Group | LinkedIn', 'CFO (Chief Financial Officer) Owns financial strategy'), 'CTM Group, Inc.'), null);
assert.equal(profileFrom(R('Kenneth Kelly - Chairman & CEO at First Independence ...'), 'Independence Buyer, Inc.'), null);
assert.equal(profileFrom(R('Martha Brown - CFO at Independence Bank of Georgia'), 'Independence Buyer, Inc.'), null);
assert.equal(profileFrom(R('Brian McCarthy - Founder and CEO of Rising Tide Consulting'), 'Rising Tide Holdings, Inc.'), null);
assert.equal(profileFrom(R('Danny Dang - Chief Financial Officer at Thisbowl Fishbowl'), 'Fishbowl Solutions, LLC'), null);
assert.equal(profileFrom(R('John David King - Former CEO at Fishbowl'), 'Fishbowl Solutions, LLC'), null);
assert.equal(profileFrom(R('Ed Fishback - CEO at Marquis Software Develoment, Inc.'), 'Marquis Software Solutions Inc'), null);
assert.equal(profileFrom(R('Gina Cocking - Founder & CEO, Dark Sky Data', 'Colonnade'), 'Colonnade Parent, Inc.'), null);
// ...and these must still match:
assert.equal(profileFrom(R('Sylvia Byrd - Chief Financial Officer | LinkedIn', 'Experience: OmniGuide · Location: Boston'), 'OmniGuide Holdings, Inc.').role, 'cfo');
assert.equal(profileFrom(R('Patrick Hooper - President & CEO at Trimlite LLC'), 'Trimlite Buyer LLC').role, 'ceo');
assert.equal(profileFrom(R('Leslie Wachsman - Chief Financial Officer - SCA Buyer'), 'SCA Buyer, LLC').title, 'Chief Financial Officer');
assert.equal(profileFrom(R('Kostas Antonetsis - CHIEF FINANCIAL OFFICER - Essence Communications'), 'Essence Communications Inc.').role, 'cfo');
assert.equal(profileFrom(R('Ana Ruiz - VP Finance at Marquis Software'), 'Marquis Software Solutions Inc').role, 'cfo');
assert.equal(profileFrom(R('Steve Fogg - Chief Financial Officer - Marquis Companies'), 'Marquis Software Solutions Inc'), null); // senior care, not software
assert.equal(profileFrom(R('Caitriona Circosta - Chief Financial Officer at Essence ...'), 'Essence Communications Inc.').role, 'cfo');
// SEC officer searched by name: a title without a role is fine
assert.equal(profileFrom(R('Jane Roe - Hydrofarm | LinkedIn'), 'HYDROFARM HOLDINGS GROUP, INC.', true).name, 'Jane Roe');
assert.equal(sameCompany('Venbrook Companies', 'Venbrook Buyer, LLC'), true);
assert.equal(sameCompany('Venbrook Insurance ...', 'Venbrook Buyer, LLC'), false); // extra word = can't tell, skip
console.log('contacts parse: all tests passed');

// Ownership (12 Oct 2026)
import { ownerFrom } from '../../supabase/functions/signal-contacts/parse.js';
const gifs = 'Global Integrated Flooring Systems Inc.';
assert.deepEqual(ownerFrom([{ url: 'https://cfn.news/x', title: 'Haworth Flooring Division, Hi-Tech Data Floors & Camino Systems Unite', description: 'Global Integrated Flooring Solutions is a portfolio company of RFE Investment Partners and Cornerstone Capital Partners.' }], gifs),
  { owner: 'RFE Investment Partners', url: 'https://cfn.news/x' });
assert.equal(ownerFrom([{ title: 'Acme Widgets acquired by Big Corp', description: 'unrelated' }], gifs), null);                  // another company
assert.equal(ownerFrom([{ title: 'Integrated Flooring news', description: 'Global Integrated Flooring acquired by Global Integrated Flooring Systems' }], gifs), null);  // itself
assert.equal(ownerFrom([{ title: 'Marquis Software', description: 'Marquis Software Solutions, a Pamlico Capital portfolio company, today announced' }], 'Marquis Software Solutions Inc').owner, 'Pamlico Capital');
assert.equal(ownerFrom([{ title: 'About us', description: 'Integrated Flooring has been family-owned since 1985.' }], gifs), null);
// Total Access Urgent Care (12 Oct 2026): owner named first.
assert.equal(ownerFrom([{ url: 'https://pe.wire/x', title: 'ICV Partners Makes Majority Investment in Total Access Urgent Care', description: 'ICV Partners announced a majority investment in Total Access Urgent Care in partnership with management.' }], 'Total Access Urgent Care, LLC').owner, 'ICV Partners');
assert.equal(ownerFrom([{ title: 'Pamlico Capital acquires Marquis Software Solutions', description: '' }], 'Marquis Software Solutions Inc').owner, 'Pamlico Capital');
assert.equal(ownerFrom([{ title: 'Marquis Software acquires Widget Co', description: '' }], 'Marquis Software Solutions Inc'), null);   // the company buying, not bought
assert.equal(ownerFrom([{ title: 'Shore Capital Completes Recapitalization in Acme Dental', description: '' }], 'Acme Dental LLC').owner, 'Shore Capital');
assert.equal(ownerFrom([{ title: 'Total Access Urgent Care Acquired By ICV Partners', description: '' }], 'Total Access Urgent Care, LLC').owner, 'ICV Partners');
// PCS Software (12 Oct 2026, live run): the law firm's page named Willkie as owner. Real owner: LLR Partners.
assert.equal(ownerFrom([{ url: 'https://www.willkie.com/news/2022/09/pcs-software-to-llr-partners', title: 'Willkie Advises Capstreet Group in Sale of Majority Stake in PCS Software to LLR Partners | Willkie Farr & Gallagher LLP',
  description: 'On September 21, LLR Partners announced its growth investment in PCS Software, a transportation management platform and portfolio company of Willkie client Capstreet Group, which remains a minority shareholder in the business.' }], 'PCS Software, Inc.').owner, 'LLR Partners');
// Ready Education (live run): a Crunchbase page title came back as the owner.
assert.equal(ownerFrom([{ url: 'https://www.crunchbase.com/organization/oohlala-mobile', title: 'Ready Education - Crunchbase Company Profile & Funding', description: 'Crunchbase Company Profile & Funding acquired by nobody' }], 'Ready Education'), null);
// Live run 12 Oct 2026: a lender, a data site across a full stop, and a one-word name matched on an unrelated page.
assert.equal(ownerFrom([{ title: 'Nova Farms secures $40M facility backed by Chicago Atlantic', description: '' }], 'Nova Farms, LLC', ['CHICAGO ATLANTIC BDC, INC.']), null);
assert.equal(ownerFrom([{ title: 'Mergr. Eastport Holdings acquired', description: 'Eastport Holdings acquired by Mergr. Eastport Holdings' }], 'Eastport Holdings, LLC'), null);
assert.equal(ownerFrom([{ title: 'Ensysce Biosciences acquires asset', description: 'Ensysce Biosciences has acquired rights. Shares fell in leisure trading.' }], 'Leisure, Company'), null);
assert.equal(ownerFrom([{ title: 'QED Investors Exits QED Technologies stake', description: '' }], 'QED Technologies International, Inc.'), null);
assert.equal(ownerFrom([{ title: 'Platinum Equity Portfolio Company HC Companies acquires Pro Cal', description: 'HC Companies, a portfolio company of Platinum Equity Portfolio Company HC Companies' }], 'The HC Companies, Inc.')?.owner, 'Platinum Equity');
assert.equal(ownerFrom([{ title: 'Muenster Milling', description: 'PrevPreviousKainos Capital acquires Muenster Milling Company' }], 'MUENSTER MILLING COMPANY, LLC')?.owner, 'Kainos Capital');
assert.equal(ownerFrom([{ title: 'x', description: 'QED was acquired by ComplyAdvantage.Read more about regtech' }], 'QED Technologies International, Inc.')?.owner, 'ComplyAdvantage');  // name cleaned (the fact itself can still be wrong)
// Claridge (12 Oct 2026 spot check): pages shorten the name and say "invests in"; WhiteHorse is the lender.
assert.equal(ownerFrom([{ title: 'Skylark Private Equity Partners and WhiteHorse Capital invests in Claridge Products', description: '' }], 'Claridge Products and Equipment, LLC', ['WHITEHORSE FINANCE, INC.'])?.owner, 'Skylark Private Equity Partners');
assert.equal(ownerFrom([{ title: 'Claridge Products Acquired by Skylark Private Equity', description: '' }], 'Claridge Products and Equipment, LLC')?.owner, 'Skylark Private Equity');
console.log('ownership: ok');

// 13 Nov 2026: who holds the job now
{
  const { applyChanges, elsewhereFrom } = await import('../../supabase/functions/signal-contacts/parse.js');
  const sec = [{ name: 'Raymond Frech', role: 'cfo', source: 'sec' }, { name: 'Dale Strang', role: 'ceo', source: 'sec' }];
  let p = applyChanges(sec, [{ name: 'Alexis N. Tirrito', role: 'cfo', event: 'appointed', interim: true }, { name: 'Raymond Frech', role: 'cfo', event: 'left' }], { src: '8k', date: '2026-08-04', url: 'u' });
  assert.equal(p[0].name, 'Alexis N. Tirrito'); assert.equal(p[0].title, 'Interim CFO');
  assert.ok(p.find(x => x.name === 'Raymond Frech').left); assert.equal(p[p.length - 1].name, 'Raymond Frech');
  // CEO covering as interim CFO: same person, takes the CFO role
  p = applyChanges(sec, [{ name: 'Dale Strang', role: 'cfo', event: 'appointed', interim: true }, { name: 'Raymond Frech', role: 'cfo', event: 'left' }], { src: 'news', date: '2026-09-01' });
  assert.equal(p[0].name, 'Dale Strang'); assert.equal(p[0].role, 'cfo'); assert.match(p[0].title, /Interim CFO/);
  // An older departure never overrides a newer appointment of the same person
  p = applyChanges([{ name: 'Jane Doe', role: 'cfo', appointed: { date: '2026-10-01' } }], [{ name: 'Jane Doe', role: 'cfo', event: 'left', date: '2025-01-01' }], { src: 'news' });
  assert.ok(!p[0].left);
  const r = [{ url: 'https://www.linkedin.com/in/rfrech', title: 'Raymond Frech - CFO at Globex Corp | LinkedIn', description: '' }];
  assert.deepEqual(elsewhereFrom(r, 'Raymond Frech', 'Acme Widgets, Inc.'), { employer: 'Globex Corp', linkedin: 'https://www.linkedin.com/in/rfrech' });
  assert.equal(elsewhereFrom([{ ...r[0], title: 'Raymond Frech - CFO at Acme Widgets | LinkedIn' }], 'Raymond Frech', 'Acme Widgets, Inc.'), null);
  console.log('job changes ok');
}
