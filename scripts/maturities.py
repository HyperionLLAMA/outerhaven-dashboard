"""Debt maturity dates read from a 10-Q / 10-K's own words (6 Nov 2026, Tengku).

The balance sheet's "debt due within 12 months" also counts revolvers and convertibles that really mature in 2029-30
(Bowman, Shutterstock, A10 were false alarms). Most filers don't tag maturity dates in XBRL (DLH doesn't), so read the
sentences instead and keep the exact quote, so every date in an email can be checked against the filing in one look.
"""
import datetime as dt
import re

MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
DATE = re.compile(r"\b(" + "|".join(MONTHS) + r")\s+(?:(\d{1,2}),\s*)?(20\d\d)\b")
CUE = re.compile(r"\b(due|matur\w*|expir\w*|terminat\w*|repayable|extended)\b", re.I)
DEBT = re.compile(r"\b(loans?|notes?|debentures?|credit agreement|revolv\w*|line of credit|facilit(?:y|ies)|borrowings?|indebtedness|bonds?)\b", re.I)
NOT_DEBT = re.compile(r"\b(leases?|warrants?|options?|awards?|vest\w*|settlement|lawsuit|contract with|receivables?)\b", re.I)  # receivable = money owed TO them


def maturities(text, today, years=5, limit=8):
    """[{date, month_only, quote}] sorted by date: debt maturities between today and `years` ahead, one per date."""
    out, seen = [], set()
    for m in DATE.finditer(text or ""):
        month, day, year = MONTHS.index(m.group(1)) + 1, m.group(2), int(m.group(3))
        try:
            d = dt.date(year, month, int(day) if day else 1)
        except ValueError:
            continue
        if d < today or d > today.replace(year=today.year + years) or d in seen:
            continue
        before = text[max(0, m.start() - 160):m.start()]
        near = before[-90:]
        if not CUE.search(near) or NOT_DEBT.search(near) or not DEBT.search(before + text[m.end():m.end() + 40]):
            continue
        a, b = max(0, m.start() - 160), min(len(text), m.end() + 60)
        a = text.find(" ", a) + 1 if a else 0
        b = text.rfind(" ", m.end(), b) if text.rfind(" ", m.end(), b) > m.end() else b
        seen.add(d)
        out.append({"date": d.isoformat(), "month_only": not day, "quote": " ".join(text[a:b].split())})
    return sorted(out, key=lambda x: x["date"])[:limit]


if __name__ == "__main__":  # self-check on real sentences from filings checked by hand on 6 Nov 2026
    today = dt.date(2026, 11, 6)
    dlh = "Arrangement Loan Balance Interest Secured term loan (a) due December 8, 2027 $ 115,000 SOFR1 + 4.1% Secured revolving line of credit (b) due December 8, 2027 $ 13,749"
    r = maturities(dlh, today)
    assert [x["date"] for x in r] == ["2027-12-08"] and "Secured term loan" in r[0]["quote"], r
    ams = "On July 22, 2026, Fifth Third and the Loan Parties entered into an amendment to the Credit Agreement which extended the maturity date to June 30, 2027. There was an aggregate of $7,075,000 due on April 9, 2026 for the Term Loan and DDTL."
    assert [x["date"] for x in maturities(ams, today)] == ["2027-06-30"]  # April 2026 is past
    ufi = ("The maturity date of the 2024 Facility is the earlier of (i) October 28, 2027 and (ii) the termination or refinancing of the 2022 Credit Agreement. "
           "Scheduled maturity dates for finance lease obligations range from November 2026 to October 2032.")
    assert [x["date"] for x in maturities(ufi, today)] == ["2027-10-28"]  # lease dates ignored
    aten = "The 2030 Notes will mature on April 1, 2030, unless earlier converted. The warrants expiring on June 30, 2030 are equity."
    assert [x["date"] for x in maturities(aten, today)] == ["2030-04-01"]  # a real date, just far away: not a 2027 hook
    sstk = "The maturity of the Revolver is in 2029."
    assert maturities(sstk, today) == []
    assert maturities("The Credit Agreement matures in October 2027 under the revolving facility.", today)[0]["month_only"] is True
    bwmn = "the Company's notes receivable included $0.5 million from BLD, with a maturity date of December 31, 2027."
    assert maturities(bwmn, today) == []  # Bowman lent this out: not its debt
    print("maturities: ok")
