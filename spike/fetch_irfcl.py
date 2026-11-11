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
  above any real holding). An exact x1,000 slip from a holder's last good figure is
  rescaled and listed as repaired; anything else impossible is dropped and listed.
- Kosovo's first two months (2026-08/09) read 146-160 t, gold worth some $20 bn against
  total reserves of $1.8 bn. Values like that are dropped by comparing with the
  holder's total reserves in reserves_usd.json (the last committed copy).

Run from the gold-tracker folder:
    python spike/fetch_irfcl.py                    # focus country: Poland
    python spike/fetch_irfcl.py CHN                # any ISO 3-letter code
    python spike/fetch_irfcl.py --raw spike/out/irfcl_gold_raw.csv
                                                   # re-read a saved response, no network
    python spike/fetch_irfcl.py --out data --log data/fetch_log.csv
                                                   # what the daily GitHub Actions job runs
    python spike/fetch_irfcl.py --reclean data/gold_tonnes.json --out data
                                                   # re-apply the cleaning rules to a written file
                                                   # (after a rule change), no network
--reserves FILE (default data/reserves_usd.json, if present) gives the total-reserves check
its dollar figures; without it that one check is skipped and says so.

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
MIN_REPAIR_T = 1.0  # a x1,000 slip is repaired only from a figure this large (a jump to >= 1,000 t can't be real)
OWN_PRICE_FLOOR = 35.0  # US$/oz: the lowest official gold price any holder has used (the US carries $42.22)
PRICE_LOOKBACK, TOTAL_LOOKBACK = 6, 3  # months back to find a price / a total-reserves figure
ROOT = Path(__file__).resolve().parent.parent
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


def slip_factor(ratio):
    """The unit slip a month-on-month ratio shows: 1e3 or 1e6 (or 1e-3, 1e-6) when the ratio is
    within 1% of it, else None. Real moves can be large (Hungary x10 in Oct 2018, Norway and Canada
    to zero), but not this."""
    for p in (1e3, 1e6):
        if abs(ratio / p - 1) < 0.01:
            return p
        if abs(ratio * p - 1) < 0.01:
            return 1 / p
    return None


def is_unit_slip(ratio):
    return slip_factor(ratio) is not None


def is_dropout(before, value, after):
    """One month far off both neighbours, which agree with each other within 5%: a gap filled
    with zero or a typo (Kazakhstan 2026-03 = 0 t between 347.6 t and 354.3 t). Real sales
    don't snap back the next month like that (Norway and Canada stayed at zero)."""
    if before <= 0 or after <= 0:
        return False
    # 0.501, not 0.5: a value of exactly half its neighbours (Belarus 2005-01, 3.1 t between 6.2 and
    # 6.2) must not be decided by rounding, or --reclean on the 3-decimal file would disagree with a fetch.
    return abs(after / before - 1) < 0.05 and abs(value / ((before + after) / 2) - 1) > 0.501


def months_back(m, n):
    """'2026-03', 2 -> ['2026-03', '2026-02', '2026-01']."""
    y, mo = map(int, m.split("-"))
    out = []
    for k in range(n + 1):
        t = y * 12 + mo - 1 - k
        out.append(f"{t // 12}-{t % 12 + 1:02d}")
    return out


def load_reserves(path):
    """reserves_usd.json -> (price {month: US$/oz}, {code: {month: (gold_usd_mn or None, total_usd_mn)}}).
    None if the file is missing or unreadable: the total-reserves check is then skipped."""
    try:
        d = json.loads(Path(path).read_text(encoding="utf-8"))
        price = {m: p for m, p, _ in d["price"]}
        totals = {c: {m: (g, t) for m, g, t in rows if t} for c, rows in d["countries"].items()}
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return price, totals


def over_reserves(code, m, tonnes, reserves):
    """Gold worth more than all of the holder's reserves: tonnes at the month's market price (the
    median price in reserves_usd.json) above its total reserve assets, unless its own valuation
    explains it. A holder that reports a gold value of at least OWN_PRICE_FLOOR an ounce keeps its
    figure (the US carries 8,133 t at $42.22, so its total reserves are smaller than its gold's
    market value). Kosovo's 146 t (2026-09), with no gold value and $1.8 bn of reserves, is dropped."""
    if not reserves:
        return None
    price, totals = reserves
    p = next((price[k] for k in months_back(m, PRICE_LOOKBACK) if k in price), None)
    row = next((totals[code][k] for k in months_back(m, TOTAL_LOOKBACK) if k in totals.get(code, {})), None)
    if p is None or row is None or tonnes <= 0:
        return None
    gold_usd, total_usd = row
    market = tonnes * OZ_PER_TONNE * p / 1e6
    if market <= total_usd:
        return None
    if gold_usd and gold_usd * 1e6 / (tonnes * OZ_PER_TONNE) >= OWN_PRICE_FLOOR:
        return None
    return f"worth more than its total reserves (${market / 1e3:,.1f} bn at ${p:,.0f}/oz vs ${total_usd / 1e3:,.1f} bn)"


def screen(series, reserves=None):
    """Clean reporting errors, in place. Returns (rejected, repaired):
    rejected {country: [(month, tonnes, reason)]}: values that can only be errors, removed;
    repaired {country: [(month, reported, used, reason)]}: exact x1,000 slips, rescaled and kept.
    Brazil reported 172,446 t from 2026-03, its 172.446 t of February times 1,000: a figure in
    kilograms, not tonnes. Dropping it would leave Brazil unreported since February."""
    rejected, repaired = {}, {}
    for code, s in series.items():
        if code in AGGREGATES:
            continue
        bad, fixed = {}, []
        last = None  # the last value kept (after any repair); a slip is measured against it
        prev = None  # the previous month's value if it was kept, else None
        for m in sorted(s):
            v = s[m]
            f = slip_factor(v / last) if last and last >= MIN_REPAIR_T and v > 0 else None
            if f and v / f <= MAX_PLAUSIBLE_T:
                s[m] = v / f
                fixed.append((m, v, s[m], f"{'x' if f > 1 else '/'}{max(f, 1 / f):,.0f} unit slip"))
                last = prev = s[m]
                continue
            why = "more than anyone holds" if v > MAX_PLAUSIBLE_T else None
            if not why and prev and v > 0 and is_unit_slip(v / prev):
                why = f"x{v / prev:.4g} jump"
            if not why:
                why = over_reserves(code, m, v, reserves)
            if why:
                bad[m] = why
                prev = None
                continue
            last = prev = v
        ok = [m for m in sorted(s) if m not in bad]
        for a, b, c in zip(ok, ok[1:], ok[2:]):
            if is_dropout(s[a], s[b], s[c]):
                bad[b] = f"one-month dropout ({s[b]:.1f} t between {s[a]:.1f} and {s[c]:.1f})"
        if bad:
            rejected[code] = [(m, s.pop(m), why) for m, why in sorted(bad.items())]
        if fixed:
            repaired[code] = fixed
    for code in [c for c, s in series.items() if not s]:
        del series[code]
    return rejected, repaired


def restore(written):
    """A written gold_tonnes.json -> the series as reported (kept, dropped and repaired values back
    at what the IMF sent), so the cleaning can be re-run on it without the network."""
    series = {c: {m: v for m, v in rows} for c, rows in {**written.get("countries", {}), **written.get("aggregates", {})}.items()}
    for c, items in written.get("rejected", {}).items():
        for m, v, _ in items:
            series.setdefault(c, {})[m] = v
    for c, items in written.get("repaired", {}).items():
        for m, reported, _, _ in items:
            series.setdefault(c, {})[m] = reported
    return series


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
    reclean_path, argv = pop_option(argv, "--reclean")
    res_arg, argv = pop_option(argv, "--reserves")
    out_arg, argv = pop_option(argv, "--out")
    out_dir = Path(out_arg) if out_arg else OUT
    focus = (argv[0] if argv else "POL").upper()
    out_dir.mkdir(parents=True, exist_ok=True)
    checks = {}

    print("== Fetch ==")
    if reclean_path:
        written = json.loads(Path(reclean_path).read_text(encoding="utf-8"))
        run.update(http_status="reclean")
        print(f"OK   read {reclean_path}, cleaning it again, no network")
        checks["fetched"] = checks["parsed"] = True
        # A reason's numbers come from rounded values here; where the reason is the same kind,
        # keep the written text, so the file matches what a fetch of the same data would write.
        old = {(c, m): why for c, items in written.get("rejected", {}).items() for m, _, why in items}
        return clean_and_write(restore(written), [], run, checks, out_dir, focus, res_arg, old)
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
    return clean_and_write(series, no_total, run, checks, out_dir, focus, res_arg)


def clean_and_write(series, no_total, run, checks, out_dir, focus, res_arg, old_reasons=None):
    if no_total:
        print(f"NOTE no {TOTAL_SECTOR} series for: {', '.join(no_total)} (left out)")
    res_path = Path(res_arg) if res_arg else ROOT / "data" / "reserves_usd.json"
    reserves = load_reserves(res_path)
    if not reserves:
        print(f"NOTE no reserves figures at {res_path}: the total-reserves check is skipped this run")
    rejected, repaired = screen(series, reserves)
    kind = lambda why: why.split(" (")[0]  # noqa: E731
    for code, items in rejected.items():
        for k, (m, v, why) in enumerate(items):
            was = (old_reasons or {}).get((code, m))
            if was and kind(was) == kind(why):
                items[k] = (m, v, was)
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
    print("\n== Repaired (exact x1,000 unit slips, rescaled) ==")
    for code, items in sorted(repaired.items()):
        print(f"  {code}: {len(items)} months ({items[0][0]} to {items[-1][0]}), "
              f"{items[0][1]:,.1f} reported, {items[0][2]:,.3f} t used")
    if not repaired:
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
        "repaired": {c: [[m, round(v, 3), round(u, 3), why] for m, v, u, why in items] for c, items in sorted(repaired.items())},
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
