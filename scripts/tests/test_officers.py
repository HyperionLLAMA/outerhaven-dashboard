"""Offline tests for scripts/officers.py parsers: python3 -I scripts/tests/test_officers.py"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from officers import cert_name, cert_title, exhibits, change_roles, officer_changes, role_of, text_of  # noqa: E402
import datetime as dt  # noqa: E402

cert = text_of("""<p>CERTIFICATION PURSUANT TO RULE 13a-14(a)</p><p>I, John A. Markovich, certify that:</p><p>1. I have reviewed this
quarterly report on Form 10-Q of OmniGuide Holdings, Inc.;</p><p>Date: August 14, 2026</p><p>/s/ John A. Markovich</p>
<p>John A. Markovich</p><p>Chief Financial Officer</p><p>(Principal Financial Officer)</p>""")
assert cert_name(cert) == "John A. Markovich", cert_name(cert)
assert cert_title(cert, "EX-31.2") == "Principal Financial Officer", cert_title(cert, "EX-31.2")
assert role_of(cert_title(cert, "EX-31.2"), "EX-31.2") == "cfo"
assert cert_name("I, Mary O'Neil-Smith, Chief Executive Officer of Acme Corp, certify that: ...") == "Mary O'Neil-Smith"
assert cert_name("I, Robert Allen, Jr., certify that") is None or cert_name("I, Robert Allen, Jr., certify that") in ("Robert Allen", "Jr.")
assert cert_name("I, the undersigned officer, hereby certify") is None
assert cert_name("I, Ludwig van Beethoven, hereby certify that") == "Ludwig van Beethoven"
ceo = text_of("<p>I, Ajay Patel, certify that:</p><p>/s/ Ajay Patel</p><p>President and Chief Executive Officer</p>")
assert role_of(cert_title(ceo, "EX-31.1"), "EX-31.1") == "ceo"

idx = """<table class="tableFile"><tr><th>Seq</th><th>Description</th><th>Document</th><th>Type</th><th>Size</th></tr>
<tr><td>1</td><td>10-Q</td><td><a href="/Archives/edgar/data/1/000/q.htm">q.htm</a></td><td>10-Q</td><td>1</td></tr>
<tr><td>2</td><td>CERT</td><td><a href="/Archives/edgar/data/1/000/ex311.htm">ex311.htm</a></td><td>EX-31.1</td><td>1</td></tr>
<tr><td>3</td><td>CERT</td><td><a href="/Archives/edgar/data/1/000/ex312.htm">ex312.htm</a></td><td>EX-31.2</td><td>1</td></tr></table>"""
assert exhibits(idx) == {"EX-31.1": "https://www.sec.gov/Archives/edgar/data/1/000/ex311.htm", "EX-31.2": "https://www.sec.gov/Archives/edgar/data/1/000/ex312.htm"}, exhibits(idx)
# Boxlight: CFO resignation 8-K (5.02) filed 4 Aug, BEFORE the 10-Q he signed on 14 Aug. Must still be found.
rows = [("10-Q", "0001628280-26-057056", "2026-08-14", ""), ("8-K", "0001628280-26-052735", "2026-08-04", "5.02,9.01"), ("8-K", "x", "2025-12-15", "5.02")]
oc = officer_changes(rows, 1624512, today=dt.date(2026, 10, 15))
assert [c["date"] for c in oc] == ["2026-08-04"], oc
assert officer_changes([("8-K", "y", "2026-09-01", "2.02")], 1, today=dt.date(2026, 10, 15)) == []
# Only CEO / CFO changes count; director changes and pay plans don't.
assert change_roles("Item 5.02 Departure of Directors or Certain Officers. On July 30, 2026, Ryan Zeek notified the Company of his resignation as Chief Financial Officer, effective August 29, 2026.") == ["cfo"]
assert change_roles("Item 5.02. The Board appointed Alexis N. Tirrito as interim Chief Financial Officer following the resignation of Raymond Frech.") == ["cfo"]
assert change_roles("Item 5.02. On June 1 the Board appointed Jane Doe as Interim Chief Executive Officer and principal executive officer.") == ["ceo"]
assert change_roles("Item 5.02. Mr. Smith resigned from the Board of Directors. His decision was not due to any disagreement.") == []
assert change_roles("Item 5.02. The Compensation Committee approved the 2026 annual bonus plan for the Chief Executive Officer and Chief Financial Officer.") == []
assert change_roles("Item 5.02. The Committee approved amendments to the retention agreements of the Company's named executive officers, including its Chief Executive Officer.") == []
print("officers: all tests passed")

# 13 Nov 2026: who replaced them (same cases as test_company_web.mjs)
from officers import change_people  # noqa: E402
cp = lambda t: [f"{x['event']}:{x['name']}:{x['role']}{':interim' if x['interim'] else ''}" for x in change_people(t)]  # noqa: E731
assert cp("The Board appointed Alexis N. Tirrito as interim Chief Financial Officer following the resignation of Raymond Frech.") == ["appointed:Alexis N. Tirrito:cfo:interim", "left:Raymond Frech:cfo"]
assert cp("On July 30, 2026, Ryan Zeek notified the Company of his resignation as Chief Financial Officer, effective August 29, 2026.") == ["left:Ryan Zeek:cfo"]
assert cp("Dale Strang, the Company's Chief Executive Officer, will also serve as interim principal financial officer.") == ["appointed:Dale Strang:cfo:interim"]
assert cp("The Compensation Committee approved the 2026 annual bonus plan for the Chief Executive Officer and Chief Financial Officer.") == []
print("change_people ok")
