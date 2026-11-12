"""SEC officer names for Credit signals targets (10 Oct 2026): who to contact at each public company.

Every 10-K and 10-Q carries two certifications signed by name: Exhibit 31.1 (principal executive officer, the CEO) and
Exhibit 31.2 (principal financial officer, the CFO). They start "I, <name>, certify that ...". This reads them from each
target's latest 10-K / 10-Q, flags an 8-K Item 5.02 (officer change) from the last 180 days, and takes the company phone and website
from the SEC company file. Sends results to the signal-contacts edge function (kind 'officers'); LinkedIn and email are found
there (Brave Search, Hunter).

Runs on GitHub Actions (.github/workflows/fund-signals.yml, mode `officers`, and daily). Needs env: SEC_IDENTITY, FUND_INGEST_KEY.
Offline test: python3 -I scripts/tests/test_officers.py
"""
import html
import os
import re
import sys
import time

import httpx

FN = os.environ.get("CONTACTS_URL", "https://nfcysxqdwpdhrdpgxrlo.supabase.co/functions/v1/signal-contacts")
KEY = os.environ.get("FUND_INGEST_KEY", "")
UA = os.environ.get("SEC_IDENTITY", "OuterHaven Advisory ops@outerhaven.example")
TITLE = re.compile(r"(interim\s+)?(chief\s+financial\s+officer|principal\s+financial\s+officer|chief\s+executive\s+officer|principal\s+executive\s+officer|"
                   r"president(\s+and\s+chief\s+executive\s+officer)?|chief\s+accounting\s+officer|treasurer|vice\s+president[,\s]+finance|"
                   r"executive\s+chairman|chairman\s+and\s+chief\s+executive\s+officer)", re.I)


def log(*a):
    print(*a, flush=True)


_last = [0.0]


def sec_get(url, as_json=False):
    """SEC fetch: identifies itself, max ~4 requests/s, retries."""
    for attempt in range(4):
        wait = 0.26 - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        try:
            r = httpx.get(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip, deflate"}, timeout=40, follow_redirects=True)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.json() if as_json else r.text
        except Exception as e:  # noqa: BLE001
            if attempt == 3:
                raise
            log("  retry", url, e)
            time.sleep(2 * (attempt + 1))


def text_of(raw):
    # ix:header = hidden inline XBRL facts and contexts, never prose (Regis tags its maturity dates there)
    t = re.sub(r"(?is)<(script|style|ix:header)\b.*?</\1>", " ", raw or "")
    t = re.sub(r"(?s)<[^>]+>", " ", t)
    return re.sub(r"\s+", " ", html.unescape(t)).strip()


NAME = re.compile(r"^[A-Z][A-Za-z'’.\-]+(?:\s+(?:[A-Z][A-Za-z'’.\-]*|de|van|von|da|di|del|la|le)){1,4}$")


def cert_name(text):
    """'I, John A. Smith, certify that ...' → 'John A. Smith' (None if it doesn't look like a person's name)."""
    m = re.search(r"\bI\s*,\s*([^,]{3,70}?)\s*,\s*(?:[^,]{0,120},\s*)?(?:hereby\s+)?certify", text)
    if not m:
        return None
    name = re.sub(r"\s+", " ", m.group(1)).strip().strip(".")
    name = re.sub(r",?\s*(Jr|Sr|II|III|IV)\.?$", "", name)
    return name if NAME.match(name) and len(name.split()) <= 5 else None


def cert_title(text, exhibit):
    """Best title: the one written under the signature (end of the exhibit), else from the exhibit number."""
    tail = text[-700:]
    hits = [m.group(0) for m in TITLE.finditer(tail)]
    if hits:
        t = re.sub(r"\s+", " ", hits[-1]).strip()
        return t[0].upper() + t[1:]
    return "Chief Financial Officer" if exhibit.endswith("31.2") else "Chief Executive Officer"


def role_of(title, exhibit):
    t = (title or "").lower()
    if "financial" in t or "treasurer" in t or "finance" in t or "accounting" in t:
        return "cfo"
    if "executive" in t or "president" in t or "chairman" in t:
        return "ceo"
    return "cfo" if exhibit.endswith("31.2") else "ceo"


def exhibits(index_html):
    """Filing index page → {'EX-31.1': url, 'EX-31.2': url} (first of each)."""
    out = {}
    for row in re.findall(r"(?is)<tr[^>]*>(.*?)</tr>", index_html or ""):
        cells = re.findall(r"(?is)<td[^>]*>(.*?)</td>", row)
        if len(cells) < 4:
            continue
        typ = text_of(cells[3]).upper()
        href = re.search(r'href="([^"]+)"', cells[2])
        if typ in ("EX-31.1", "EX-31.2", "EX-31") and href and typ not in out:
            u = href.group(1)
            out[typ] = ("https://www.sec.gov" + u) if u.startswith("/") else u
    return out


def officers(cik):
    j = sec_get(f"https://data.sec.gov/submissions/CIK{int(cik):010d}.json", as_json=True) or {}
    recent = (j.get("filings") or {}).get("recent") or {}
    rows = list(zip(recent.get("form", []), recent.get("accessionNumber", []), recent.get("filingDate", []), recent.get("items", []) or [""] * len(recent.get("form", []))))
    cert = next(((f, a, d) for f, a, d, _ in rows if f in ("10-K", "10-Q", "10-K/A")), None)
    out = {"cik": str(int(cik)), "company_name": j.get("name"), "people": [],
           "phone": (j.get("phone") or (j.get("addresses") or {}).get("business", {}).get("phone") or None),
           "website": (j.get("website") or j.get("investorWebsite") or None)}
    if out["website"]:
        w = out["website"] if out["website"].startswith("http") else "https://" + out["website"]
        out["website"], out["domain"] = w, re.sub(r"^www\.", "", httpx.URL(w).host or "") or None
    if not cert:
        return out
    form, acc, filed = cert
    base = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc.replace('-', '')}"
    ex = exhibits(sec_get(f"{base}/{acc}-index.htm"))
    seen = {}
    for typ in ("EX-31.2", "EX-31.1", "EX-31"):
        if typ not in ex:
            continue
        t = text_of(sec_get(ex[typ]))
        name = cert_name(t)
        if not name:
            continue
        title = cert_title(t, typ)
        p = {"name": name, "title": title, "role": role_of(title, typ), "source_url": ex[typ], "filed": filed, "form": form}
        if name in seen:  # one person signs both (small companies): keep one entry with both roles
            seen[name]["title"] = seen[name]["title"] if "financial" in seen[name]["title"].lower() and "executive" in seen[name]["title"].lower() else f"{seen[name]['title']} and {title}"
            continue
        seen[name] = p
    out["people"] = list(seen.values())
    docs = dict(zip(recent.get("accessionNumber", []), recent.get("primaryDocument", []) or []))
    for c in officer_changes(rows, cik)[:3]:   # read the newest 5.02 8-Ks; flag only a CEO / CFO change
        a = c["acc"]
        doc = docs.get(a)
        if not doc:
            continue
        text = text_of(sec_get(f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{a.replace('-', '')}/{doc}"))
        roles = change_roles(text)
        if roles:
            i = text.find("5.02")
            # Who left and who replaced them (interim included): the 10-Q signer is often already gone.
            out["officer_change"] = {"date": c["date"], "url": c["url"], "roles": roles, "people": change_people(text[i:i + 6000] if i >= 0 else text[:6000])}
            break
    return out


def officer_changes(rows, cik, today=None, days=180):
    """8-K Item 5.02 filings in the last `days` days, newest first, before OR after the certification.
    15 Oct 2026: Boxlight's CFO resignation 8-K (4 Aug) came BEFORE the 10-Q he still signed (14 Aug), and ASHS named an interim
    CFO the same way; checking only 8-Ks after the certification missed both."""
    import datetime as dt
    since = ((today or dt.date.today()) - dt.timedelta(days=days)).isoformat()
    return [{"acc": a, "date": d, "url": f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{a.replace('-', '')}/{a}-index.htm"}
            for f, a, d, items in rows if f in ("8-K", "8-K/A") and d >= since and "5.02" in (items or "")]


ROLE_WORDS = [("cfo", re.compile(r"chief financial officer|principal financial officer|\bCFO\b", re.I)),
              ("ceo", re.compile(r"chief executive officer|principal executive officer|\bCEO\b", re.I))]
CHANGE = re.compile(r"resign|depart|terminat|step(?:ped|s)? down|retire|separat|will not continue|appoint|(?:been|was) named|named (?:as|the|its|interim)|succeed|interim|promot|transition", re.I)


def change_roles(text):
    """Which top roles an 8-K Item 5.02 changes: a sentence naming the CFO / CEO role AND a change word. Item 5.02 also covers
    director changes and pay plans (5.02(e)): on the first full run 220 of 346 targets had a 5.02 8-K, so the bare item number
    is too noisy to warn on."""
    i = text.find("5.02")
    body = text[i:i + 6000] if i >= 0 else text[:6000]
    out = []
    for sentence in re.split(r"(?<=[.;])\s+", body):
        if not CHANGE.search(sentence):
            continue
        for role, rx in ROLE_WORDS:
            if rx.search(sentence) and role not in out:
                out.append(role)
    return out


# Same patterns as officersIn() in supabase/functions/fund-web/company.js (news); shared cases in scripts/tests/officer_cases.json
# (real 8-K Item 5.02 sentences: Atara, Powerfleet, Harmony, Digimarc, Katapult). Names need first + last.
_NAME = r"(?:(?:Mr|Ms|Mrs|Dr)\.\s+)?(?!(?:The|On|In|As|At|By|Effective|Following|Our|Its|Their|Mr|Ms|Mrs|Dr|January|February|March|April|May|June|July|August|September|October|November|December)\b)([A-Z][a-zA-Z'’-]+(?:\s+[A-Z]\.)?(?:\s+[A-Z][a-zA-Z'’-]+){1,2})(?:,\s*(?:M\.D\.|Ph\.D\.|Jr\.|Sr\.|CPA|CFA)(?=[,\s]))?"
_ROLE = r"([Cc]hief [Ff]inancial [Oo]fficer|CFO|[Pp]rincipal [Ff]inancial [Oo]fficer|[Cc]hief [Ee]xecutive [Oo]fficer|CEO|[Pp]rincipal [Ee]xecutive [Oo]fficer)"
_ART = r"(?:the Company[’']s |the company[’']s |its |our |the |their )?(?:new |permanent )?(?:(?:[A-Z][\w-]* ){1,4}and )?"
_INT = r"((?:[Ii]nterim|[Aa]cting) )?"
_GAP = r"(?:(?!\. [A-Z])[^;]){0,130}?"
_LEFT = r"(?:resigned|resigns|has resigned|will resign|departed|departs|will depart|stepped down|steps down|will step down|is stepping down|will be stepping down|retired|retires|will retire|is retiring|will be retiring|is leaving|will leave|was terminated|notified the Company of (?:his|her|their) (?:decision to )?(?:resign|retire|resignation|retirement))"
_RX = {
    "appoint": re.compile(rf"\b(?:appointed|appoints|named|names|promoted|promotes|hired|hires|elected)\s+{_NAME},?\s+(?:{_GAP}\s)?(?:to serve |to act )?(?:as|to)\s+(?:the (?:role|position) of )?{_ART}{_INT}{_ROLE}"),
    "passive": re.compile(rf"{_NAME}(?:,{_GAP},)?\s+(?:has been|was|will be|is|had been)\s+(?:appointed|named|promoted|elected)\s+(?:to serve |to act )?(?:as\s+|to\s+)?{_ART}{_INT}{_ROLE}"),
    "serve": re.compile(rf"{_NAME}(?:,{_GAP},)?\s+(?:will|to|shall)\s+(?:also\s+)?(?:serve|act|assume (?:the )?(?:duties|role)s?)\s+(?:as|of)\s+{_ART}{_INT}{_ROLE}"),
    "left": re.compile(rf"{_NAME}(?:,{_GAP},)?\s+(?:[^.]{{0,40}}?\s)?{_LEFT}[^.]{{0,80}}?{_ROLE}"),
    "follow": re.compile(rf"(?:as|to)\s+{_ART}(?:(?:[Ii]nterim|[Aa]cting) )?{_ROLE}{_GAP}\b(?:following|after|succeeding|replacing|to succeed|to replace) (?:the (?:resignation|departure|retirement|termination) of )?{_NAME}"),
    "leftOf": re.compile(rf"(?:resignation|departure|retirement|termination) of {_NAME},?\s+(?:as\s+)?{_ART}{_ROLE}"),
}
_NOT_NAME = re.compile(r"\b(Agreement|Agreements|Stockholders?|Shareholders?|Plan|Plans|Section|Sections|Securities|Exchange|Act|Report|Form|Exhibit|Employment|Separation|Release|Award|Awards|Bonus|Compensation|Equity|Incentive|Notes|Credit|Loan|Trust|Fund|Bank|Corporation|Company|Board|Committee|Directors?|Officer|Officers|Chief|Financial|Executive|President|Holdings|Group|Capital|Partners|Inc|Corp|LLC|Item|Interim|Acting|Annual|Meeting|Effective|Following|Pursuant|Under|Our|Its|The|On|In|As)\b")


def _bad_name(n):
    return bool(_NOT_NAME.search(n)) or len(n.split()) < 2


def _scan(rx, t, ni):
    """Like finditer, but a match whose 'name' isn't a person retries one character later instead of swallowing the real name."""
    pos = 0
    while True:
        m = rx.search(t, pos)
        if not m:
            return
        if _bad_name(m.group(ni)):
            pos = m.start() + 1
            continue
        yield m
        pos = m.end()


def change_people(text):
    """CEO / CFO appointments (incl. interim) and departures named in 8-K Item 5.02 text: [{name, role, event, interim}]."""
    t, out, seen = re.sub(r"\s+", " ", text or ""), [], set()

    def role_key(r):
        return "cfo" if re.search(r"financial|cfo", r, re.I) else "ceo"

    def add(name, role, event, interim):
        name = name.strip()
        if (event, name.lower(), role) in seen:
            return
        seen.add((event, name.lower(), role))
        out.append({"name": name, "role": role, "event": event, "interim": bool(interim)})
    for k in ("appoint", "passive", "serve"):
        for m in _scan(_RX[k], t, 1):
            add(m.group(1), role_key(m.group(3)), "appointed", m.group(2))
    for k in ("left", "leftOf"):
        for m in _scan(_RX[k], t, 1):
            add(m.group(1), role_key(m.group(2)), "left", False)
    for m in _scan(_RX["follow"], t, 2):
        add(m.group(2), role_key(m.group(1)), "left", False)
    return out


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
            time.sleep(3)


def main():
    if not KEY:
        sys.exit("FUND_INGEST_KEY missing")
    # Workflow mode officers with from=all re-reads every target (after a rule change); otherwise only stale ones.
    todo = post({"kind": "officers_todo", "all": os.environ.get("IN_FROM") == "all"}).get("items") or []
    log(f"{len(todo)} credit targets need SEC officers")
    batch, found, failed = [], 0, 0
    for i, it in enumerate(todo, 1):
        try:
            o = officers(it["cik"])
            o["company_name"] = o.get("company_name") or it.get("company_name")
            found += 1 if o["people"] else 0
            batch.append(o)
        except Exception as e:  # noqa: BLE001
            failed += 1
            log("  failed", it.get("cik"), it.get("company_name"), e)
        if len(batch) >= 25 or (i == len(todo) and batch):
            post({"kind": "officers", "items": batch})
            batch = []
        if i % 50 == 0:
            log(f"  {i}/{len(todo)} read, {found} with names")
    log(f"done: {len(todo)} read, {found} with named officers, {failed} failed")
    if failed > max(5, len(todo) // 5):
        sys.exit(1)


def probe(ciks):
    """Pre-send check for an outreach email (7 Nov 2026, Tengku): per company, the latest 10-Q/10-K's maturity sentences as
    they read in the filing today, who signed the certifications, and every CEO/CFO change in a 5.02 8-K this past year.
    One run annotation per company (the session can't read raw logs or reach sec.gov). Workflow mode officersprobe, from = CIKs."""
    import datetime as dt
    from maturities import maturities
    for cik in [c.strip() for c in ciks.replace(";", ",").split(",") if c.strip()]:
        try:
            o = officers(cik)
            j = sec_get(f"https://data.sec.gov/submissions/CIK{int(cik):010d}.json", as_json=True) or {}
            r = (j.get("filings") or {}).get("recent") or {}
            rows = list(zip(r.get("form", []), r.get("accessionNumber", []), r.get("filingDate", []), r.get("items", []) or [""] * len(r.get("form", []))))
            docs = dict(zip(r.get("accessionNumber", []), r.get("primaryDocument", []) or []))
            lines = [f"{o.get('company_name')} | site {o.get('website')} | phone {o.get('phone')}"]
            lines += [f"SIGNED {p['form']} {p['filed']}: {p['name']} ({p['title']})" for p in o["people"]]
            f = next(((f, a, d) for f, a, d, _ in rows if f in ("10-Q", "10-K")), None)
            if f:
                url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{f[1].replace('-', '')}/{docs.get(f[1])}"
                lines.append(f"LATEST {f[0]} filed {f[2]} {url}")
                lines += [f"MATURITY {m['date']} [{m['kind']}] {m['quote']}" for m in maturities(text_of(sec_get(url)), dt.date.today())]
            for c in officer_changes(rows, cik, days=365)[:6]:
                t = text_of(sec_get(f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{c['acc'].replace('-', '')}/{docs.get(c['acc'])}"))
                i = t.find("5.02")
                lines.append(f"8-K 5.02 {c['date']} roles={change_roles(t)}: {t[i:i + 700] if i >= 0 else t[:700]}")
            if o["people"]:
                post({"kind": "officers", "items": [o]})  # HQ's contact block gets the names too
            msg = "\n".join(lines)
        except Exception as e:  # noqa: BLE001
            msg = f"failed: {e}"
        print(f"::notice title=probe {cik}::" + msg.replace("%", "%25").replace("\r", "").replace("\n", "%0A"), flush=True)


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--probe":
        probe(sys.argv[2])
    else:
        main()
