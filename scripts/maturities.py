"""Debt maturity dates read from a 10-Q / 10-K's own words (6 Nov 2026, Tengku).

The balance sheet's "debt due within 12 months" also counts revolvers and convertibles that really mature in 2029-30
(Bowman, Shutterstock, A10 were false alarms). Most filers don't tag maturity dates in XBRL (DLH doesn't), so read the
sentences instead and keep the exact quote, so every date in an email can be checked against the filing in one look.
"""
import datetime as dt
import re

MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
DATE = re.compile(r"\b(" + "|".join(MONTHS) + r")\s+(?:(\d{1,2}),\s*)?(20\d\d)\b")
CUE = re.compile(r"\b(matur\w*|due|expir\w*|terminat\w*|repayable|extended)\b", re.I)
DEBT = re.compile(r"\b(loans?|notes?|debentures?|credit agreement|revolv\w*|line of credit|facilit(?:y|ies)|borrowings?|indebtedness|bonds?|term debt)\b", re.I)
NOT_DEBT = re.compile(r"\b(leases?|warrants?|options?|awards?|vest\w*|settlement|lawsuit|contract with)\b", re.I)
LENT_OUT = re.compile(r"\b(notes?|loans?) receivable\b|\breceivable from\b", re.I)  # money owed TO them, anywhere in the sentence
# 7 Nov 2026 audit (Tengku: "check everything"): of 12 hooks read by hand, 4 were not a maturity at all.
HEDGE = re.compile(r"\b(swaps?|hedg\w*|interest rate (?:cap|collar)s?|derivative)\b", re.I)  # Orion: a swap terminating
# Nuvera "principal payments ... due commencing June 30, 2026, through March 31, 2028", NN "interest payments due before",
# McEwen "due beginning on": payment schedules, not the date the debt has to be refinanced.
SCHEDULE = re.compile(r"\b(commenc\w*|beginning|through|installments?|interest payments?|payments? of)\b", re.I)
OLD = re.compile(r"\b(was set to|originally|previously|had been|prior to)\b", re.I)
REPLACED = re.compile(r"\b(replaced|terminated|repaid in full)\b.*\bwhich (included|provided)\b", re.I)  # Galaxy: the old Fortress loan's date  # biote "which was set to occur on"
REVOLVER = re.compile(r"\b(revolv\w*|ABL|line of credit|borrowing base|credit facility)\b", re.I)
TERM = re.compile(r"(?<!long-)(?<!short-)\b(term loans?|term debt|term facilit\w*|notes?|debentures?|bonds?)\b", re.I)  # not "LONG-TERM DEBT" headings (ESOA)
JUNK = re.compile(r"xbrli:|iso4217:|us-gaap:|\bP\dY\b")  # inline XBRL header text, not a sentence (Regis)
AMOUNT = re.compile(r"\$\s?(\d[\d,]*(?:\.\d+)?)\s*(million|billion)?", re.I)
ABBR = {"inc", "corp", "co", "no", "ltd", "llc", "n.a", "s.a", "u.s", "jr", "sr", "st", "mr", "ms", "dr", "vs", "approx"}


def sentence(text, i, j):
    """Bounds of the sentence holding text[i:j] (a full stop + space + capital, not after Inc. / N.A. / No.)."""
    a = max(0, i - 200)  # no full stop in 600 chars: a window that keeps the date in the 400-char quote, never the top of the document (Regis)
    for m in re.finditer(r"\.\s+(?=[A-Z(\"“])", text[max(0, i - 600):i]):
        word = re.search(r"([A-Za-z.]+)$", text[max(0, i - 600):i][:m.start()])
        if not word or word.group(1).lower().rstrip(".") not in ABBR:
            a = max(0, i - 600) + m.end()
    b = len(text)
    for m in re.finditer(r"\.\s+(?=[A-Z(\"“])|\.$", text[j:j + 400]):
        word = re.search(r"([A-Za-z.]+)$", text[j:j + 400][:m.start()])
        if not word or word.group(1).lower().rstrip(".") not in ABBR:
            b = j + m.start() + 1
            break
    return a, min(b, j + 400)


def amount_m(sent):
    """Largest dollar amount in the sentence, in $M. A bare number is read as thousands (how 10-Q tables state debt)."""
    best = None
    for m in AMOUNT.finditer(sent):
        v = float(m.group(1).replace(",", ""))
        v = v * 1000 if (m.group(2) or "").lower() == "billion" else v if m.group(2) else v / 1000
        best = v if best is None else max(best, v)
    return best


def maturities(text, today, years=5, limit=8):
    """[{date, month_only, quote, kind, amount_m, small}] sorted by date: debt maturities from today to `years` ahead."""
    text = " ".join((text or "").split())
    out, seen = [], set()
    for m in DATE.finditer(text):
        month, day, year = MONTHS.index(m.group(1)) + 1, m.group(2), int(m.group(3))
        try:
            d = dt.date(year, month, int(day) if day else 1)
        except ValueError:
            continue
        if d < today or d > today.replace(year=today.year + years) or d in seen:
            continue
        a, b = sentence(text, m.start(), m.end())
        sent, before = text[a:b], text[a:m.start()]
        near = before[-90:]
        if not CUE.search(near) or NOT_DEBT.search(near) or LENT_OUT.search(sent) or HEDGE.search(sent) \
                or SCHEDULE.search(before[-60:]) or OLD.search(near) or REPLACED.search(before) or not DEBT.search(sent):
            continue
        if JUNK.search(sent):
            continue
        amt = amount_m(sent)
        if amt is None and a > 0 and re.match(r"(The|This|These|Such) (loan|notes?|promissory notes?)\b", sent):  # "The loan is due on ..." names its size in the sentence before (McEwen $2.1M, Jushi $1.4M)
            pa, _ = sentence(text, max(0, a - 2), max(0, a - 2))
            amt = amount_m(text[pa:a])
        kind = "term" if TERM.search(sent) else "revolver" if REVOLVER.search(sent) else "debt"
        seen.add(d)
        out.append({"date": d.isoformat(), "month_only": not day, "quote": sent[:400], "kind": kind,
                    "amount_m": round(amt, 1) if amt is not None else None, "small": amt is not None and amt < 5})
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
    bwmn = "On September 30, 2026 and December 31, 2025, our notes receivable included $ 0.4 million and $ 0.4 million, respectively from LDG, with a maturity date of December 31, 2027."
    assert maturities(bwmn, today) == []  # Bowman lent this out: not its debt
    abl = "The ABL Revolver, secured by eligible accounts receivable and inventory, matures on October 28, 2027."
    assert [x["date"] for x in maturities(abl, today)] == ["2027-10-28"]  # an ABL backed by receivables is still their debt
    # 7 Nov 2026 audit: real quotes that were wrongly taken as maturities.
    orn = "on a portion of its variable-rate borrowings. The swap became effective on July 1, 2026 with a notional amount of $ 20 million. The swap terminates on July 1, 2027. Under the swap, the Company pays a fixed rate of 4.03 %"
    assert maturities(orn, today) == []
    nuvr = "The final maturity date of this note is June 21, 2029. Eight quarterly principal payments of $ 781,250 are due commencing June 30, 2026, through March 31, 2028, and four quarterly principal payments of $ 1,562,500"
    assert [x["date"] for x in maturities(nuvr, today)] == ["2029-06-21"]
    nnbr = "plus an applicable margin ranging from 7.75 % to 8.75 % based on our Consolidated Net Leverage Ratio. For interest payments due before April 16, 2027, we may elect to pay a portion of interest in-kind (PIK)."
    assert maturities(nnbr, today) == []
    btmd = "with repayment of the outstanding amount of the note due on maturity, which was set to occur on May 26, 2027. Pursuant to the Credit Agreement, the Company may borrow"
    assert maturities(btmd, today) == []
    mux = "On January 31, 2025, the outstanding $ 40.0 million loan was refinanced, extending the repayment of principal by 24 months, and is due beginning on January 31, 2027, with the remaining principal due later."
    assert maturities(mux, today) == []
    jush = "The consideration included $ 1,400 in aggregate promissory notes. The promissory notes bear interest at a stated rate of 10 % per annum, are payable quarterly in cash, and mature in April 2027."
    j = maturities("The consideration included $ 1,400 in aggregate promissory notes, which mature in April 2027.", today)
    assert j and j[0]["small"] is True, j  # $1.4M acquisition note: not their real debt
    glxz = "Pursuant to the terms of the Credit Agreement, the new term loan and new revolving credit facility will mature on January 6, 2028 as the merger was not completed."
    g = maturities(glxz, today)
    assert [x["date"] for x in g] == ["2028-01-06"] and g[0]["kind"] == "term", g
    klxe = "Our 2028 ABL Facility matures on March 7, 2028 and we intend to work with our existing lenders or other lenders."
    assert maturities(klxe, today)[0]["kind"] == "revolver"
    paai = "Amendment No. 4 amended the definition of \u201cMaturity Date\u201d for all of the Term Debt to the earlier of (i) December 31, 2027 or (ii) acceleration upon an event of default."
    assert [x["date"] for x in maturities(paai, today)] == ["2027-12-31"]
    j2 = maturities(jush, today)
    assert j2 and j2[0]["small"] is True, j2  # size is in the sentence before
    mux2 = "with Andes Corporation Minera S.A., in respect of $ 2.1 million in previously advanced funds. The loan is due on February 29, 2028, and bears interest at a rate of 12 % per annum."
    assert maturities(mux2, today)[0]["small"] is True
    esoa = "SHORT-TERM AND LONG-TERM DEBT Revolving Credit Facility Effective June 28, 2026, the Company renewed its $ 30.0 million revolving line of credit with United Bank, which matures on June 28, 2028."
    assert maturities(esoa, today)[0]["kind"] == "revolver"
    rgs = "rgs-20260930 0000716643 FALSE 09/30 2027 Q1 P1Y xbrli:shares iso4217:USD loan matures January 29, 2028 us-gaap:CommonStockMember"
    assert maturities(rgs, today) == []
    import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from officers import text_of  # Regis's dates sit in ix:header hidden facts: stripped, the real note sentence is quoted
    rgs_html = ('<div style="display:none"><ix:header><ix:hidden><ix:nonNumeric name="us-gaap:DebtInstrumentMaturityDate">loan matures January 29, 2028'
                '</ix:nonNumeric></ix:hidden></ix:header></div><p>' + "x " * 400 + 'Our term loan matures on January 29, 2028 under the Credit Agreement.</p>')
    r = maturities(text_of(rgs_html), today)
    assert [x["date"] for x in r] == ["2028-01-29"] and "rgs-" not in r[0]["quote"] and "January 29, 2028" in r[0]["quote"], r
    klxe2 = "We issued warrants for $ 1.0 million. Our 2028 ABL Facility matures on March 7, 2028 and we intend to refinance it."
    assert maturities(klxe2, today)[0]["small"] is False  # only "The loan / The notes ..." borrow the size from before
    glxz_old = "On January 6, 2025, the Company replaced the senior secured term loan agreement with Fortress Credit Corp., which included a term loan with a maturity date of November 13, 2026. On January 6, 2025, the Company borrowed $ 45,000,000"
    assert maturities(glxz_old, today) == []
    assert maturities("In March 2026 the Company refinanced its credit facility, and the new term loan matures on June 30, 2028.", today)  # a refinanced loan's NEW date stays
    print("maturities: ok")
