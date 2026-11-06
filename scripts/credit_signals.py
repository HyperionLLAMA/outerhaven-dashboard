"""Credit signals: small US public companies that need private credit (Peter's lane), straight from SEC data.

Runs on GitHub Actions (.github/workflows/fund-signals.yml, mode `credit`, and inside the daily run) and posts companies to
the `fund-signals` edge function (action ingest, kind `credit`). Judging is server-side (classifyCredit in rules.js).

How a company gets on the list
  1. XBRL frames (one SEC call per accounting tag, covering every filer): debt due within 12 months, long-term debt, cash
     (latest quarter-end balance sheet), revenue (latest calendar year), public float.
     Kept if: debt due within 12 months >= $10M and more than its cash, revenue >= $20M, float <= $2B, total debt <= $750M.
     Revenue missing from the frames is read from the company's own XBRL facts (0 = pre-revenue).
  2. Full-text search (last 180 days): "forbearance agreement" (8-K / 10-Q / 10-K) and "substantial doubt" + "going concern"
     (10-K / 10-Q). Any company with a hit and revenue >= $20M (or unknown) is added, with the filing as evidence.
  3. Company profile (one call each): industry code, tickers, exchange, state, latest 10-K / 10-Q link.
Needs env: SEC_IDENTITY, FUND_INGEST_KEY (same as fund signals).
"""
import datetime as dt
import os
import sys
import time

import httpx
from edgar import search_filings, set_identity
from edgar.httprequests import download_json

from maturities import maturities
from officers import sec_get, text_of

FN = os.environ.get("FUND_SIGNALS_URL", "https://nfcysxqdwpdhrdpgxrlo.supabase.co/functions/v1/fund-signals")
KEY = os.environ.get("FUND_INGEST_KEY", "")
FRAMES = "https://data.sec.gov/api/xbrl/frames/{tax}/{tag}/USD/{period}.json"
# Term debt coming due (a real refinancing deadline). Revolvers are kept apart: lenders classify ABL / revolving lines as
# current even though they usually roll over, which made every retailer look like it had a maturity wall.
DEBT_CURRENT = ["LongTermDebtCurrent", "LongTermDebtAndCapitalLeaseObligationsCurrent", "NotesPayableCurrent",
                "ConvertibleNotesPayableCurrent", "SecuredDebtCurrent"]
REVOLVER = ["LinesOfCreditCurrent", "ShortTermBorrowings"]
DEBT_NONCURRENT = ["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations", "LongTermLineOfCredit",
                   "ConvertibleNotesPayableNoncurrent", "LongTermNotesPayable"]
CASH = ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "Cash"]
# Peter's leverage screen (8 Oct 2026): EBITDA = operating income + depreciation & amortisation (last calendar year), and
# interest expense, so a maturity can be judged against cash flow (a strong earner just refinances at its bank).
OP_INCOME = ["OperatingIncomeLoss"]
DA = ["DepreciationDepletionAndAmortization", "DepreciationAndAmortization", "DepreciationAmortizationAndAccretionNet"]
INTEREST = ["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt", "InterestPaidNet"]
# Loan type tag (3 Nov 2026, Tengku): which instruments the balance sheet reports, so the opener names the right market.
# XBRL shows the instrument, never the lender (bank vs private credit fund): that is in the 10-Q debt note.
DEBT_TYPES = {
    "Convertible notes": ["ConvertibleNotesPayable", "ConvertibleNotesPayableCurrent", "ConvertibleNotesPayableNoncurrent",
                          "ConvertibleDebtCurrent", "ConvertibleDebtNoncurrent", "ConvertibleLongTermNotesPayable"],
    "Bonds / senior notes": ["SeniorNotes", "SeniorNotesCurrent", "SeniorNotesNoncurrent", "UnsecuredDebt", "UnsecuredDebtCurrent"],
    "Revolver": ["LineOfCredit", "LinesOfCreditCurrent", "LongTermLineOfCredit"],
    "Term / secured loan": ["SecuredDebt", "SecuredDebtCurrent", "SecuredLongTermDebt", "LoansPayable", "LoansPayableCurrent",
                            "LongTermLoansPayable", "NotesPayableToBank", "NotesPayableToBankCurrent", "NotesPayableToBankNoncurrent"],
}
REVENUE = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet",
           "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueGoodsNet", "RegulatedAndUnregulatedOperatingRevenue"]


def log(*a):
    print(*a, flush=True)


def post(body):
    for attempt in range(3):
        try:
            r = httpx.post(FN, json=body, headers={"x-fund-ingest": KEY}, timeout=150)
            j = r.json()
            if r.is_success and j.get("ok"):
                return j
            raise RuntimeError(j.get("error") or f"HTTP {r.status_code}")
        except Exception as e:  # noqa: BLE001
            if attempt == 2:
                raise
            log("  retry ingest:", e)
            time.sleep(5 * (attempt + 1))


def frame(tag, period, tax="us-gaap"):
    """{cik: (value, end_date, loc)} for one tag, every filer, one period. Missing frames return {}."""
    try:
        data = download_json(FRAMES.format(tax=tax, tag=tag, period=period))
    except Exception as e:  # noqa: BLE001
        log(f"  frame {tag} {period}: none ({str(e)[:80]})")
        return {}
    out = {}
    for d in data.get("data", []):
        out[int(d["cik"])] = (float(d["val"]), d.get("end"), d.get("loc"), d.get("entityName"))
    log(f"  frame {tag} {period}: {len(out)} companies")
    return out


def best(tags, period, tax="us-gaap"):
    """Largest reported value per company across alternative tags (companies tag the same thing differently)."""
    merged = {}
    for t in tags:
        for cik, v in frame(t, period, tax).items():
            if cik not in merged or v[0] > merged[cik][0]:
                merged[cik] = v
    return merged


def quarter_periods(today):
    """Latest quarter-end at least ~75 days old (filers have had time to file), then the one before."""
    q_ends = []
    y = today.year
    for yy in (y, y - 1):
        for m, d, q in ((12, 31, 4), (9, 30, 3), (6, 30, 2), (3, 31, 1)):
            end = dt.date(yy, m, d)
            if (today - end).days >= 75:
                q_ends.append((end, f"CY{yy}Q{q}I"))
    q_ends.sort(reverse=True)
    return [p for _, p in q_ends[:2]]


STATS = {"errors": []}


def text_hits(query, forms, since, cap=1500):
    """{cik: {form, date, url}} newest hit per company from EDGAR full-text search (dates re-checked here too).
    One form per call (several forms in one call can match only one); paging retried, because edgartools' fetch_more stops at
    the first empty page (once cut 2,637 going-concern 10-Qs to 100, 5 Oct 2026). A short run sets STATS["shortfall"]."""
    out, results, totals = {}, [], {}
    today = dt.date.today()
    def paged(start, end):
        res = search_filings(query, forms=[form], start_date=start, end_date=end, limit=100)
        tries = 0
        while len(res.results) < min(res.total, cap) and tries < 4:
            more = res.fetch_more(min(res.total, cap) - len(res.results))
            if len(more.results) == len(res.results):
                tries += 1
                time.sleep(2 * tries)
            res = more
        return res

    for form in forms:
        # Full range first (complete when paging works); 30-day windows only if paging stopped early. Windows alone lost
        # results (forbearance 8-K: 66 in windows vs 123 in one search), paging alone once stopped at 100 of 2,637.
        try:
            res = paged(since, today.isoformat())
            seen = {(r.accession_number, r.document_id) for r in res.results}
            found, total = list(res.results), res.total
            if len(found) < min(total, cap):
                w_end = today
                while w_end > dt.date.fromisoformat(since):
                    w_start = max(dt.date.fromisoformat(since), w_end - dt.timedelta(days=30))
                    for r in paged(w_start.isoformat(), w_end.isoformat()).results:
                        if (r.accession_number, r.document_id) not in seen:
                            seen.add((r.accession_number, r.document_id))
                            found.append(r)
                    w_end = w_start - dt.timedelta(days=1)
            if len(found) < min(total, cap) * 0.95:
                STATS["shortfall"] = True
                STATS["errors"].append(f"search {query} {form}: got {len(found)} of {total}")
            totals[form] = {"total": total, "fetched": len(found)}
            results += found
        except Exception as e:  # noqa: BLE001
            STATS["shortfall"] = True
            log(f"  search {query} {form}: failed {e}")
            STATS["errors"].append(f"search {query} {form}: {type(e).__name__}: {str(e)[:200]}")
    STATS[f"search {query}"] = totals
    for r in results:
        if r.filed and str(r.filed) < since:
            continue
        try:
            cik = int(r.cik)
        except (TypeError, ValueError):
            continue
        acc = (r.accession_number or "").replace("-", "")
        url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc}/{r.document_id}" if r.document_id else f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}"
        hit = {"form": r.form, "date": r.filed, "url": url}
        if cik not in out or str(r.filed) > str(out[cik]["date"]):
            out[cik] = hit
    log(f"  search {query}: {totals}, {len(out)} companies")
    return out


def profile(cik):
    """Industry code, tickers, exchange, state and the latest 10-K/10-Q link from the SEC company submissions file."""
    j = download_json(f"https://data.sec.gov/submissions/CIK{cik:010d}.json")
    addr = (j.get("addresses") or {}).get("business") or {}
    recent = (j.get("filings") or {}).get("recent") or {}
    url = kind = filed = None
    for form, acc, doc, fd in zip(recent.get("form", []), recent.get("accessionNumber", []), recent.get("primaryDocument", []), recent.get("filingDate", [])):
        if form in ("10-K", "10-Q"):
            url, kind, filed = f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc.replace('-', '')}/{doc}", form, fd
            break
    return {"name": j.get("name"), "sic": j.get("sic"), "sicDesc": j.get("sicDescription"), "tickers": j.get("tickers") or [],
            "exchanges": [e for e in (j.get("exchanges") or []) if e], "state": addr.get("stateOrCountry"), "filingUrl": url,
            "filingForm": kind, "filingDate": filed}


def annual_revenue(cik):
    """Latest full-year revenue from the company's own XBRL facts (for companies the calendar-year frame missed, e.g. odd
    fiscal years). 0 = the company reports no revenue at all (pre-revenue); None = could not read it."""
    try:
        facts = (download_json(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json").get("facts") or {}).get("us-gaap") or {}
    except Exception:  # noqa: BLE001
        return None
    best_row = None
    for tag in REVENUE:
        for r in ((facts.get(tag) or {}).get("units") or {}).get("USD", []):
            if r.get("form") not in ("10-K", "10-K/A") or not r.get("start"):
                continue
            days = (dt.date.fromisoformat(r["end"]) - dt.date.fromisoformat(r["start"])).days
            if 330 <= days <= 400 and (best_row is None or r["end"] > best_row["end"]):
                best_row = r
    if best_row:
        return float(best_row["val"])
    # No 10-K yet (new listings: Lime / Neutron, Teamshares read as "pre-revenue"): annualise the latest 10-Q year-to-date.
    q = None
    for tag in REVENUE:
        for r in ((facts.get(tag) or {}).get("units") or {}).get("USD", []):
            if r.get("form") in ("10-Q", "10-Q/A") and r.get("start") and r.get("val"):
                days = (dt.date.fromisoformat(r["end"]) - dt.date.fromisoformat(r["start"])).days
                if 80 <= days <= 280 and (q is None or (r["end"], days) > (q[0]["end"], q[1])):
                    q = (r, days)
    return float(q[0]["val"]) * 365 / q[1] if q else 0.0


def credit():
    today = dt.date.today()
    run = dt.datetime.utcnow().isoformat(timespec="seconds")
    periods = quarter_periods(today)
    period, cash = None, {}
    for p in periods:  # use the newest quarter with real coverage
        cash = best(CASH, p)
        if len(cash) >= 2500:
            period = p
            break
    if not period:
        period = periods[-1]
        cash = best(CASH, period)
    log(f"credit: balance sheet period {period}")
    val = lambda m, c: m[c][0] if c in m else None
    dcur, dnon, rvl = best(DEBT_CURRENT, period), best(DEBT_NONCURRENT, period), best(REVOLVER, period)
    rev = best(REVENUE, f"CY{today.year - 1}")
    rev.update({k: v for k, v in best(REVENUE, f"CY{today.year - 2}").items() if k not in rev})
    flt = frame("EntityPublicFloat", f"CY{today.year - 1}Q2I", tax="dei")
    yr = f"CY{today.year - 1}"
    opi, dna, intx = best(OP_INCOME, yr), best(DA, yr), best(INTEREST, yr)
    dtypes = {label: best(tags, period) for label, tags in DEBT_TYPES.items()}
    debt_types = lambda c: [label for label, m in dtypes.items() if (val(m, c) or 0) > 0]
    def ebitda(c):
        o = val(opi, c)
        return None if o is None else o + (val(dna, c) or 0)

    since = (today - dt.timedelta(days=180)).isoformat()
    forb = text_hits('"forbearance agreement"', ["8-K", "10-Q", "10-K"], since)
    gc = text_hits('"substantial doubt" "going concern"', ["10-K", "10-Q"], since, cap=4000)

    cands = set()
    for c, (dc, *_rest) in dcur.items():
        ch, r, fl = val(cash, c), val(rev, c), val(flt, c)
        total = dc + (val(dnon, c) or 0)
        if dc >= 10e6 and ch is not None and dc > ch and (r or 0) >= 20e6 and (fl is None or fl <= 2e9) and total <= 750e6:
            cands.add(c)
    # Leverage screen: net debt over 7x EBITDA and interest covered under 2x (or negative EBITDA with real debt).
    lev = 0
    for c, (dn, *_rest) in dnon.items():
        total = dn + (val(dcur, c) or 0)
        e, i, r, fl = ebitda(c), val(intx, c), val(rev, c), val(flt, c)
        if total < 20e6 or total > 750e6 or (r or 0) < 20e6 or (fl is not None and fl > 2e9) or e is None:
            continue
        net = total - (val(cash, c) or 0)
        if (e <= 0 and net > 0) or (e > 0 and net / e >= 7 and (i is None or i <= 0 or e / i < 2)):
            cands.add(c)
            lev += 1
    STATS["leverage_candidates"] = lev
    # Maturity watch (7 Nov 2026 audit: 23 targets of 1,123 rows, because only distress made the list): healthy, lendable-size
    # borrowers are read too, and kept only if their filing dates a maturity 4-24 months out. That is the refinancing lane.
    watch = set()
    for c in set(dnon) | set(dcur):
        total = (val(dnon, c) or 0) + (val(dcur, c) or 0)
        e, r, fl = ebitda(c), val(rev, c), val(flt, c)
        if c not in cands and 20e6 <= total <= 300e6 and 20e6 <= (r or 0) <= 1e9 and e is not None and e > 0 and (fl is None or fl <= 2e9):
            watch.add(c)
    STATS["maturity_watch"] = len(watch)
    for c in set(forb) | set(gc):
        r = val(rev, c)
        if r is None or r >= 20e6:
            cands.add(c)
    STATS.update({"period": period, "frames": {"cash": len(cash), "debt_current": len(dcur), "revolver": len(rvl), "revenue": len(rev), "float": len(flt)},
                  "forbearance_companies": len(forb), "going_concern_companies": len(gc), "candidates": len(cands)})
    log(f"credit: {len(cands)} candidates ({sum(1 for c in cands if c in forb)} forbearance, {sum(1 for c in cands if c in gc)} going concern)")

    looked_up = 0
    for c in cands:  # text-search hits often have no calendar-year revenue frame: read their own filings
        if c not in rev:
            r = annual_revenue(c)
            looked_up += 1
            if r is not None:
                rev[c] = (r, None, None, None)
    STATS["revenue_looked_up"] = looked_up
    STATS["run"] = run

    batch, sent, kept = [], 0, 0
    for i, c in enumerate(sorted(cands | watch)):
        try:
            p = profile(c)
        except Exception as e:  # noqa: BLE001
            log(f"  profile {c}: {e}")
            if len(STATS["errors"]) < 20:
                STATS["errors"].append(f"profile {c}: {str(e)[:120]}")
            p = {"name": (dcur.get(c) or cash.get(c) or rev.get(c) or (None,) * 4)[3] or f"CIK {c}"}
        watch_only = c in watch
        sic = int(p.get("sic") or 0)
        if watch_only and (not p.get("filingUrl") or (6000 <= sic <= 6799 and sic != 6798)):  # banks / funds: not borrowers
            continue
        flags = {}
        if c in forb:
            flags["forbearance"] = forb[c]
        if c in gc:
            flags["going_concern"] = gc[c]
        # Real maturity dates + the filing's own words (6 Nov 2026): "due within 12 months" alone flagged revolvers and
        # convertibles maturing in 2029-30. Stored inside flags so no server change is needed.
        if p.get("filingUrl"):
            try:
                items = maturities(text_of(sec_get(p["filingUrl"])), today)
                flags["maturities"] = {"form": p.get("filingForm"), "filed": p.get("filingDate"), "url": p["filingUrl"], "items": items}
            except Exception as e:  # noqa: BLE001
                log(f"  maturities {c}: {e}")
        if watch_only:
            soon = [m for m in (flags.get("maturities") or {}).get("items", [])
                    if 120 <= (dt.date.fromisoformat(m["date"]) - today).days <= 730]
            if not soon:
                continue
            kept += 1
        batch.append({"cik": c, **p, "periodEnd": (dcur.get(c) or cash.get(c) or (None, None))[1], "debtCurrent": val(dcur, c),
                      "debtNoncurrent": val(dnon, c), "revolverCurrent": val(rvl, c), "cash": val(cash, c), "revenue": val(rev, c), "publicFloat": val(flt, c), "flags": flags,
                      "ebitda": ebitda(c), "interestExpense": val(intx, c), "debtTypes": debt_types(c)})
        if len(batch) >= 100:
            r = post({"action": "ingest", "kind": "credit", "items": batch, "period": period, "run": run, "stats": STATS})
            sent += len(batch)
            log(f"  sent {sent} (new {r.get('added')})")
            batch = []
    if batch or sent == 0:
        r = post({"action": "ingest", "kind": "credit", "items": batch, "period": period, "run": run, "stats": STATS})
        sent += len(batch)
        log(f"  sent {sent} (new {r.get('added')})")
    # Companies from earlier runs that no longer show a trigger get cut (kept for history, status untouched). Skipped when
    # a search came back short: missing hits would wrongly cut real targets.
    if STATS.get("shortfall"):
        log("  searches came back short: not dropping anyone this run")
    else:
        r = post({"action": "ingest", "kind": "credit_done", "run": run})
        log(f"  dropped off this run: {r.get('dropped')}")
    log(f"credit: done, {sent} companies sent ({kept} of {len(watch)} watch companies have a maturity in 4-24 months)")


if __name__ == "__main__":
    if not KEY or not os.environ.get("SEC_IDENTITY"):
        sys.exit("Set the FUND_INGEST_KEY and SEC_IDENTITY secrets in GitHub.")
    set_identity(os.environ["SEC_IDENTITY"])
    credit()
