#!/usr/bin/env python3
"""
Gold Tracker: the currency composition of the world's foreign exchange reserves, from the IMF's
COFER dataset (Currency Composition of Official Foreign Exchange Reserves), quarterly since 1999.

The gold share on the page says how much of reserves is gold; COFER says what the rest is made
of. Its "allocated reserves" are the reserves whose currency is reported to the IMF (all of them
since 2025, when unallocated reserves reached zero). Shares are percent of allocated reserves;
gold is not in COFER at all, so the shares are of foreign exchange only.

Same IMF SDMX 3.0 API as the gold data, one request for the world aggregate (COUNTRY G001):
every currency, shares and US-dollar values, quarterly. IMF data, committed as
data/cofer_shares.json. Not part of the daily IMF job: a monthly workflow
(.github/workflows/fetch-dollar.yml) runs it, so a COFER problem never touches the reliability
count of the gold fetch.

    python spike/fetch_cofer.py --out data --log data/fetch_log_cofer.csv
    python spike/fetch_cofer.py --raw spike/out/cofer_raw.csv --out data   # no network
Exit code 0 = every check passed, 1 = something failed (see FAIL lines).
"""
import csv
import io
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from fetch_irfcl import ACCEPT, append_log, fetch, pop_option, verdict

URL = "https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.STA/COFER/+/G001.*.*.*.Q"
OUT = Path(__file__).resolve().parent / "out"
CURRENCIES = {"CI_USD": "USD", "CI_EUR": "EUR", "CI_JPY": "JPY", "CI_GBP": "GBP", "CI_CNY": "CNY",
              "CI_AUD": "AUD", "CI_CAD": "CAD", "CI_CHF": "CHF", "CI_OTHC": "OTH"}
USD_SHARE_RANGE = (40, 80)  # 71% in 1999, 57% in 2026


def quarter_index(q):
    return int(q[:4]) * 4 + int(q[-1]) - 1


def main(argv, run):
    raw_path, argv = pop_option(argv, "--raw")
    out_arg, argv = pop_option(argv, "--out")
    out_dir = Path(out_arg) if out_arg else OUT
    checks = {}
    if raw_path:
        text = Path(raw_path).read_text(encoding="utf-8")
        print(f"== Reading saved COFER response {raw_path} ==")
    else:
        print("== Fetching IMF COFER, world aggregate, quarterly ==")
        status, ctype, raw, secs, tries = fetch(URL, ACCEPT)
        run.update(http_status=status, tries=tries, seconds=round(secs, 1), mb=round(len(raw) / 1e6, 2))
        print(f"   HTTP {status}, {ctype}, {len(raw) / 1e6:.2f} MB, {secs:.1f} s")
        checks["COFER downloaded (HTTP 200)"] = status == 200
        if status != 200:
            print(f"   body: {raw[:200]!r}")
            return verdict(checks)
        text = raw.decode("utf-8-sig", errors="replace")
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / "cofer_raw.csv").write_text(text, encoding="utf-8")  # for --raw re-runs; not committed

    share, value = {}, {}
    for r in csv.DictReader(io.StringIO(text)):
        if r.get("COUNTRY") != "G001" or r.get("FREQUENCY") != "Q" or not r.get("OBS_VALUE"):
            continue
        q, cur, ind, kind = r["TIME_PERIOD"], r["FXR_CURRENCY"], r["INDICATOR"], r["TYPE_OF_TRANSFORMATION"]
        v = float(r["OBS_VALUE"])
        if kind == "SHRO_PT" and ind == "AFXRA" and cur in CURRENCIES:
            share.setdefault(q, {})[CURRENCIES[cur]] = round(v, 2)
        elif kind == "NV_USD" and cur == "CI_T" and ind in ("AFXRA", "UFXRA", "TFXRA"):
            value.setdefault(q, {})[ind] = round(v / 1e9, 1)  # US$ -> billions
    quarters = sorted(set(share) | set(value), key=quarter_index)
    print(f"   {len(quarters)} quarters, {quarters[0] if quarters else '-'} to {quarters[-1] if quarters else '-'}")
    checks["100+ quarters"] = len(quarters) >= 100
    if not quarters:
        return verdict(checks)
    newest = quarters[-1]
    today = datetime.now(timezone.utc)
    age = (today.year * 4 + (today.month - 1) // 3) - quarter_index(newest)
    checks[f"Newest quarter {newest} is at most 2 quarters old"] = age <= 2
    usd = [share[q].get("USD") for q in quarters if q in share and "USD" in share[q]]
    checks[f"US dollar share within {USD_SHARE_RANGE[0]}-{USD_SHARE_RANGE[1]}% every quarter"] = bool(usd) and all(USD_SHARE_RANGE[0] <= v <= USD_SHARE_RANGE[1] for v in usd)
    last = share.get(newest, {})
    total_share = sum(last.values())
    checks[f"Shares add up to 100% in {newest} ({total_share:.1f}%)"] = abs(total_share - 100) <= 1
    vals = value.get(newest, {})
    checks["Allocated reserves never exceed total reserves"] = all(
        value[q].get("AFXRA", 0) <= value[q].get("TFXRA", float("inf")) * 1.001 for q in quarters if q in value)
    print(f"   {newest}: USD {last.get('USD')}%, EUR {last.get('EUR')}%, CNY {last.get('CNY')}%; "
          f"allocated ${vals.get('AFXRA', 0):,.0f} bn of ${vals.get('TFXRA', 0):,.0f} bn")

    out = {
        "source": "IMF, Currency Composition of Official Foreign Exchange Reserves (COFER), world aggregate",
        "request": {"url": URL, "accept": ACCEPT},
        "unit": "share: percent of allocated foreign exchange reserves (gold excluded); allocated/unallocated/total: US$ billions",
        "note": "OTH = all other currencies. CNY appears from 2016 Q4, AUD and CAD from 2012 Q4. Unallocated reserves are reserves "
                "whose currency breakdown was not reported; they reached zero in 2025.",
        "quarters": [[q, {**{c: share.get(q, {}).get(c) for c in sorted(set(CURRENCIES.values()))},
                          "allocated": value.get(q, {}).get("AFXRA"), "unallocated": value.get(q, {}).get("UFXRA"),
                          "total": value.get(q, {}).get("TFXRA")}] for q in quarters],
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    head = json.dumps({k: v for k, v in out.items() if k != "quarters"}, indent=1)[:-2]
    rows = ",\n".join(f"  {json.dumps(r)}" for r in out["quarters"])
    path = out_dir / "cofer_shares.json"
    path.write_text(f'{head},\n "quarters": [\n{rows}\n ]\n}}\n', encoding="utf-8")
    checks["Output is valid JSON"] = json.loads(path.read_text(encoding="utf-8")) == out
    run.update(holders=len(quarters), newest_month=newest)
    print(f"\nWrote {path}")
    return verdict(checks)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    log_arg, args = pop_option(sys.argv[1:], "--log")
    run, code = {}, 1
    try:
        code = main(args, run)
    except Exception:
        run["result"] = "crash"
        raise
    finally:
        if log_arg:
            append_log(Path(log_arg), run, code)
    sys.exit(code)
