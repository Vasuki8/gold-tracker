#!/usr/bin/env python3
"""
Gold Tracker spike: can a script pull official gold reserves from the IMF?

Source: IMF IRFCL (International Reserves and Foreign Currency Liquidity),
line 56 "Gold (including gold deposits and, if appropriate, gold swapped)",
monthly. IRFCL replaces IFS, which the IMF retired with the old API.

What the first live run (2026-11-08) established:
- Only the SDMX 3.0 endpoint works. The 2.1 one answers 403 / 404.
- OBS_VALUE is in fine troy ounces. SCALE=6 on every row is a display hint
  ("show in millions"), not a multiplier: US = 261,499,000 oz = 8,133.5 t.
- SECTOR S1XS1311 (monetary authorities + central government) exists for every
  country and covers every month. Use only that: the UK's gold sits with the
  Treasury (S1311), so the central-bank-only series (S1X) shows the UK at zero.
- G163 is the euro-area aggregate, not a holder. EZB is the ECB.
- National submissions contain unit errors (Brazil x1000 from 2026-03, Angola
  above any real holding). They are dropped automatically and listed.

Run from the gold-tracker folder:
    python spike/fetch_irfcl.py                    # focus country: Poland
    python spike/fetch_irfcl.py CHN                # any ISO 3-letter code
    python spike/fetch_irfcl.py --raw spike/out/irfcl_gold_raw.csv
                                                   # re-read a saved response, no network
    python spike/fetch_irfcl.py --out data --log data/fetch_log.csv
                                                   # what the daily GitHub Actions job runs

Standard library only, Python 3.8+. Writes to --out (default spike/out/):
    irfcl_gold_raw.csv   exactly what the IMF sent back
    gold_tonnes.json     every country's monthly series in tonnes, errors removed.
                         No timestamp inside, so the file only changes when the
                         IMF data does and git history shows real revisions.
--log FILE appends one CSV row per run (pass / fail / crash, HTTP status, tries,
seconds, size, newest month): the record for the reliability test.
Exit code 0 = the riskiest assumption held on this run, 1 = it didn't.
"""
import csv
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

INDICATOR = "IRFCLDT1_IRFCL56V_FTO"  # IRFCL line 56, gold volume, fine troy ounces
URL = f"https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.STA/IRFCL/+/*.{INDICATOR}.*.M"
ACCEPT = "application/vnd.sdmx.data+csv;version=2.0.0"
TOTAL_SECTOR = "S1XS1311"  # monetary authorities + central government
AGGREGATES = {"G163"}  # euro area total: not a holder, skipped in checks and rankings
OZ_PER_TONNE = 32150.7466
US_ANCHOR_T = 8133.46  # 261.5M oz; the US figure has not changed in decades
MAX_PLAUSIBLE_T = 9000  # more than anyone holds
OUT = Path(__file__).resolve().parent / "out"

# Candidate top holders. Not a ranking: the point is to see which ones IRFCL is missing.
BIG_HOLDERS = {
    "USA": "United States", "DEU": "Germany", "ITA": "Italy", "FRA": "France",
    "RUS": "Russia", "CHN": "China", "CHE": "Switzerland", "IND": "India",
    "JPN": "Japan", "NLD": "Netherlands", "TUR": "Turkey", "POL": "Poland",
    "PRT": "Portugal", "UZB": "Uzbekistan", "SAU": "Saudi Arabia",
    "GBR": "United Kingdom", "KAZ": "Kazakhstan", "EZB": "ECB",
}


def fetch(url, accept, tries=3):
    """GET with retries on network errors, 429 and 5xx. Returns (status, ctype, body, secs, tries)."""
    req = urllib.request.Request(url, headers={
        "Accept": accept, "User-Agent": "gold-tracker-spike/0.2 (personal project)"})
    err = ""
    for attempt in range(1, tries + 1):
        start = time.time()
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.status, r.headers.get("Content-Type", ""), r.read(), time.time() - start, attempt
        except urllib.error.HTTPError as e:
            body = e.read()
            if e.code != 429 and e.code < 500:
                return e.code, e.headers.get("Content-Type", ""), body, time.time() - start, attempt
            err = f"HTTP {e.code}"
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            err = str(getattr(e, "reason", e))
        if attempt < tries:
            print(f"   try {attempt} failed ({err}); retrying in {5 * attempt}s")
            time.sleep(5 * attempt)
    return None, "", err.encode(), 0.0, tries


def parse_csv(text):
    reader = csv.reader(io.StringIO(text))
    header = [h.split(":")[0].strip().upper() for h in next(reader)]
    return [dict(zip(header, values)) for values in reader]


def month(period):
    """'2026-M08', '2026M08', '2026-08' -> '2026-08'. Anything else -> None."""
    parts = (period or "").replace("M", "-").replace("--", "-").split("-")
    if len(parts) == 2 and len(parts[0]) == 4 and parts[1].isdigit() and 1 <= int(parts[1]) <= 12:
        return f"{parts[0]}-{int(parts[1]):02d}"
    return None


def to_tonnes(rows):
    """-> ({country: {month: tonnes}} for the total sector only, countries lacking that sector)."""
    series, seen = {}, set()
    for r in rows:
        country, m = r.get("COUNTRY") or r.get("REF_AREA"), month(r.get("TIME_PERIOD"))
        if not country or not m:
            continue
        seen.add(country)
        if r.get("SECTOR", TOTAL_SECTOR) != TOTAL_SECTOR:
            continue
        try:
            ounces = float(r.get("OBS_VALUE"))
        except (TypeError, ValueError):
            continue
        series.setdefault(country, {})[m] = ounces / OZ_PER_TONNE
    return series, sorted(seen - set(series))


def is_unit_slip(ratio):
    """A month-on-month ratio within 1% of x1000 or x1,000,000 (either way) is a unit error.
    Real moves can be large (Hungary x10 in Oct 2018, Norway and Canada to zero), but not this."""
    return any(abs(ratio / p - 1) < 0.01 or abs(ratio * p - 1) < 0.01 for p in (1e3, 1e6))


def is_dropout(before, value, after):
    """One month far off both neighbours, which agree with each other within 5%: a gap filled
    with zero or a typo (Kazakhstan 2026-03 = 0 t between 347.6 t and 354.3 t). Real sales
    don't snap back the next month like that (Norway and Canada stayed at zero)."""
    if before <= 0 or after <= 0:
        return False
    return abs(after / before - 1) < 0.05 and abs(value / ((before + after) / 2) - 1) > 0.5


def screen(series):
    """Remove values that can only be reporting errors, in place. Returns {country: [(month, tonnes, reason)]}."""
    rejected = {}
    for code, s in series.items():
        if code in AGGREGATES:
            continue
        ms = sorted(s)
        bad = {m: "more than anyone holds" for m in ms if s[m] > MAX_PLAUSIBLE_T}
        for a, b in zip(ms, ms[1:]):
            if s[a] > 0 and s[b] > 0 and b not in bad and is_unit_slip(s[b] / s[a]):
                bad[b] = f"x{s[b] / s[a]:.4g} jump from {a}"
        ok = [m for m in ms if m not in bad]
        for a, b, c in zip(ok, ok[1:], ok[2:]):
            if is_dropout(s[a], s[b], s[c]):
                bad[b] = f"one-month dropout ({s[b]:.1f} t between {s[a]:.1f} and {s[c]:.1f})"
        if bad:
            rejected[code] = [(m, s.pop(m), why) for m, why in sorted(bad.items())]
    for code in [c for c, s in series.items() if not s]:
        del series[code]
    return rejected


def months_between(a, b):
    ya, ma = map(int, a.split("-"))
    yb, mb = map(int, b.split("-"))
    return (yb - ya) * 12 + (mb - ma)


def last_change(s):
    ms = sorted(s)
    return (ms[-1], s[ms[-1]], s[ms[-1]] - s[ms[-2]] if len(ms) > 1 else None)


def pop_option(argv, name):
    """('--out', ['--out', 'data', 'CHN']) -> ('data', ['CHN']). Missing option -> (None, argv)."""
    if name not in argv:
        return None, argv
    i = argv.index(name)
    return argv[i + 1], argv[:i] + argv[i + 2:]


LOG_FIELDS = ["run_at_utc", "result", "http_status", "tries", "seconds", "mb",
              "holders", "newest_month", "github_run_id"]


def append_log(path, run, code):
    """One row per run. Written even when the run fails or crashes, so failures get counted."""
    row = dict(run)
    row.setdefault("result", "pass" if code == 0 else "fail")
    row["run_at_utc"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    row["github_run_id"] = os.environ.get("GITHUB_RUN_ID", "local")
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=LOG_FIELDS, extrasaction="ignore", lineterminator="\n")
        if new:
            w.writeheader()
        w.writerow(row)


def main(argv, run):
    raw_path, argv = pop_option(argv, "--raw")
    out_arg, argv = pop_option(argv, "--out")
    out_dir = Path(out_arg) if out_arg else OUT
    focus = (argv[0] if argv else "POL").upper()
    out_dir.mkdir(parents=True, exist_ok=True)
    checks = {}

    print("== Fetch ==")
    if raw_path:
        body = Path(raw_path).read_bytes()
        run.update(http_status="raw-file", mb=f"{len(body) / 1e6:.2f}")
        print(f"OK   read {raw_path} ({len(body) / 1e6:.1f} MB), no network")
    else:
        status, ctype, body, secs, tries = fetch(URL, ACCEPT)
        run.update(http_status=status or "none", tries=tries, seconds=f"{secs:.1f}")
        if status != 200:
            print(f"FAIL {status or 'no response'}: {body[:300].decode(errors='replace')}")
            checks["fetched"] = False
            return verdict(checks)
        run["mb"] = f"{len(body) / 1e6:.2f}"
        (out_dir / "irfcl_gold_raw.csv").write_bytes(body)
        print(f"OK   HTTP 200, {len(body) / 1e6:.1f} MB, {secs:.1f}s, "
              f"{tries} {'try' if tries == 1 else 'tries'}, {ctype or 'no content-type'}")
    checks["fetched"] = True

    try:
        rows = parse_csv(body.decode("utf-8-sig"))
    except Exception as e:  # noqa: BLE001 - a spike should report, not crash
        print(f"FAIL could not read the response as CSV: {e}")
        checks["parsed"] = False
        return verdict(checks)
    series, no_total = to_tonnes(rows)
    checks["parsed"] = bool(series)
    if not series:
        print(f"Parsed {len(rows)} rows but none were usable. Columns: {sorted(rows[0]) if rows else 'none'}")
        return verdict(checks)
    if no_total:
        print(f"NOTE no {TOTAL_SECTOR} series for: {', '.join(no_total)} (left out)")

    rejected = screen(series)
    holders = {c: s for c, s in series.items() if c not in AGGREGATES}
    today = datetime.now(timezone.utc).strftime("%Y-%m")
    print("\n== Coverage ==")
    all_months = sorted({m for s in holders.values() for m in s})
    run.update(holders=len(holders), newest_month=all_months[-1])
    print(f"{len(holders)} holders (plus {len(series) - len(holders)} aggregate), "
          f"{sum(len(s) for s in holders.values()):,} monthly observations, {all_months[0]} to {all_months[-1]}")
    latest = {}
    for c, s in holders.items():
        latest.setdefault(max(s), []).append(c)
    recent = sorted(latest, reverse=True)
    print("Latest month reported, by country count: "
          + ", ".join(f"{m}: {len(latest[m])}" for m in recent[:4]))
    stale = [f"{c} ({m})" for m in recent if months_between(m, today) > 6 for c in sorted(latest[m])]
    if stale:
        print("Stale (nothing in the last 6 months): " + ", ".join(stale))

    print("\n== Unit check: United States should be ~8,133 t ==")
    us = holders.get("USA")
    if us:
        us_month, us_t, _ = last_change(us)
        ok = abs(us_t / US_ANCHOR_T - 1) < 0.01
        checks["units confirmed (US anchor)"] = ok
        print(f"{'PASS' if ok else 'FAIL'} USA {us_month}: {us_t:,.1f} t")
    else:
        print("WARN USA not in the data, so units can't be confirmed against the anchor.")

    print("\n== Dropped as reporting errors in national submissions ==")
    for code, items in sorted(rejected.items()):
        whole = code not in series
        reasons = sorted({why.split(" from ")[0] for _, _, why in items})
        print(f"  {code}: {len(items)} months ({items[0][0]} to {items[-1][0]})"
              f"{', whole series' if whole else ''}; {'; '.join(reasons)}")
    if not rejected:
        print("  none")

    print(f"\n== Focus: {BIG_HOLDERS.get(focus, focus)} ({focus}), last 13 months ==")
    s = holders.get(focus)
    checks[f"{focus} present"] = bool(s)
    if s:
        months = sorted(s)[-13:]
        prev = None
        for m in months:
            delta = "" if prev is None else f"  {s[m] - prev:+7.1f}"
            print(f"  {m}  {s[m]:8.1f} t{delta}")
            prev = s[m]
        lag = months_between(max(s), today)
        checks[f"{focus} data no more than 4 months old"] = lag <= 4
        print(f"  {len(months) - 1}-month change: {s[months[-1]] - s[months[0]]:+.1f} t. "
              f"Latest point is {lag} months before {today}.")
    else:
        print("  Not in the data. Try another code, e.g. CHN, TUR, IND, CZE.")

    print("\n== Big holders: latest figure and its monthly change (each country's own latest month) ==")
    missing = []
    by_latest = sorted(BIG_HOLDERS.items(), key=lambda kv: -last_change(holders[kv[0]])[1] if kv[0] in holders else 0)
    for code, name in by_latest:
        if code not in holders:
            missing.append(f"{code} {name}")
            continue
        m, t, d = last_change(holders[code])
        print(f"  {code} {name:15} {t:8.1f} t  {m}  {'' if d is None else f'{d:+6.1f} t'}")
    print("  MISSING: " + (", ".join(missing) if missing else "none"))

    out = {
        "source": f"IMF IRFCL line 56, gold volume ({INDICATOR}), sector {TOTAL_SECTOR}",
        "request": {"url": URL, "accept": ACCEPT},
        "unit": "tonnes",
        "countries": {c: [[m, round(v, 3)] for m, v in sorted(s.items())] for c, s in sorted(holders.items())},
        "aggregates": {c: [[m, round(v, 3)] for m, v in sorted(s.items())]
                       for c, s in sorted(series.items()) if c in AGGREGATES},
        "rejected": {c: [[m, round(v, 3), why] for m, v, why in items] for c, items in sorted(rejected.items())},
    }
    (out_dir / "gold_tonnes.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"\nWrote {out_dir / 'gold_tonnes.json'}")
    return verdict(checks)


def verdict(checks):
    print("\n== Verdict ==")
    for name, ok in checks.items():
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    ok = all(checks.values())
    print("Riskiest assumption held on this run." if ok else "Riskiest assumption NOT confirmed. See FAIL lines.")
    return 0 if ok else 1


if __name__ == "__main__":
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
