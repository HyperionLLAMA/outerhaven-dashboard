# Offline: python3 -I scripts/tests/test_credit_debt.py  (13 Nov 2026: debt figure fallbacks in credit_signals.py)
import datetime as dt
import os
import sys
import types
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
for m in ["edgar", "edgar.httprequests"]:   # the scan's SEC client isn't needed offline
    sys.modules.setdefault(m, types.ModuleType(m))
sys.modules["edgar"].search_filings = sys.modules["edgar"].set_identity = lambda *a, **k: None
sys.modules["edgar.httprequests"].download_json = lambda *a, **k: {}
import credit_signals as cs  # noqa: E402

T = dt.date(2026, 11, 13)
# TerrAscend-style: only LongTermDebt tagged; the newest balance sheet wins over the 10-K
f = {"LongTermDebt": {"units": {"USD": [{"form": "10-Q", "end": "2026-09-30", "val": 218e6}, {"form": "10-K", "end": "2025-12-31", "val": 260e6}]}},
     "LongTermDebtCurrent": {"units": {"USD": [{"form": "10-Q", "end": "2026-09-30", "val": 5e6}]}}}
assert cs.latest_debt(f, T) == 218e6
# current + non-current split beats a smaller total tag on the same date
f2 = {"LongTermDebtCurrent": {"units": {"USD": [{"form": "10-Q", "end": "2026-06-30", "val": 30e6}]}},
      "LongTermDebtNoncurrent": {"units": {"USD": [{"form": "10-Q", "end": "2026-06-30", "val": 60e6}]}},
      "NotesPayable": {"units": {"USD": [{"form": "10-Q", "end": "2026-06-30", "val": 70e6}]}}}
assert cs.latest_debt(f2, T) == 90e6
assert cs.latest_debt({"NotesPayable": {"units": {"USD": [{"form": "10-K", "end": "2024-12-31", "val": 9e6}]}}}, T) is None   # too old
assert cs.latest_debt(None, T) is None
print("credit debt fallbacks ok")
