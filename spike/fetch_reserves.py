#!/usr/bin/env python3
"""
Gold Tracker: dollar values from IMF IRFCL, for gold's share of each country's reserves.

Two monthly series per country, sector S1XS1311 (the same sector as the gold volumes):
    IRFCLDT1_IRFCL65_USD   official reserve assets, total, US dollars
    IRFCLDT1_IRFCL56_USD   of which gold, US dollars, at whatever value the country uses

Countries don't value gold the same way. The US reports it at the old official price of
$42.22/oz ($11,041 M for 261.5 M oz); Saudi Arabia, Korea and Singapore use historical cost.
So reported gold values can't be summed or divided as they are. This script derives one
gold price per month: the median dollars-per-ounce across all holders with at least 1 t
(from gold_tonnes.json). That median tracks the market price (2000-12 $273, 2015-12 $1,062,
2024-12 $2,609, 2025-12 $4,313) and the page revalues every holder's gold at it.

Same IMF API, same request style and the same cleaning rules as fetch_irfcl.py. It is a
separate script with its own log so the gold-volume request under the reliability test
stays exactly as it was.

Run from the gold-tracker folder, after fetch_irfcl.py:
    python spike/fetch_reserves.py --out data --log data/fetch_log_reserves.csv
    python spike/fetch_reserves.py --raw data/irfcl_reserves_raw.csv --out data   # no network
Exit code 0 = every check passed, 1 = something failed (see FAIL lines).
"""
import json
import statistics
import sys
from pathlib import Path

from fetch_irfcl import (ACCEPT, AGGREGATES, OZ_PER_TONNE, TOTAL_SECTOR, append_log, fetch,
                         is_dropout, is_unit_slip, month, parse_csv, pop_option, verdict)

GOLD_USD = "IRFCLDT1_IRFCL56_USD"
TOTAL_USD = "IRFCLDT1_IRFCL65_USD"
URL = f"https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.STA/IRFCL/+/*.{GOLD_USD}+{TOTAL_USD}.{TOTAL_SECTOR}.M"
US_BOOK_GOLD_MN = 261.499 * 42.2222  # 261.5 M oz at the statutory $42.22/oz = $11,041 M
MIN_TONNES_FOR_PRICE = 1.0  # tiny holdings give noisy implied prices (Chile reports ~44x)
MIN_PRICE_REPORTERS = 10
OUT = Path(__file__).resolve().parent / "out"


def to_series(rows):
    """-> {indicator: {country: {month: US$ millions}}} for the total sector."""
    out = {GOLD_USD: {}, TOTAL_USD: {}}
    for r in rows:
        ind, country, m = r.get("INDICATOR"), r.get("COUNTRY") or r.get("REF_AREA"), month(r.get("TIME_PERIOD"))
        if ind not in out or not country or not m or r.get("SECTOR", TOTAL_SECTOR) != TOTAL_SECTOR:
            continue
        try:
            v = float(r.get("OBS_VALUE"))
        except (TypeError, ValueError):
            continue
        if v < 0:
            continue
        out[ind].setdefault(country, {})[m] = v / 1e6
    return out


def screen(series, label):
    """Drop x1000 / x1,000,000 jumps and one-month dropouts, in place (same rules as the volumes)."""
    rejected = {}
    for code, s in series.items():
        ms = sorted(s)
        bad = {}
        for a, b in zip(ms, ms[1:]):
            if s[a] > 0 and s[b] > 0 and is_unit_slip(s[b] / s[a]):
                bad[b] = f"{label}: x{s[b] / s[a]:.4g} jump from {a}"
        ok = [m for m in ms if m not in bad]
        for a, b, c in zip(ok, ok[1:], ok[2:]):
            if is_dropout(s[a], s[b], s[c]):
                bad[b] = f"{label}: one-month dropout"
        if bad:
            rejected.setdefault(code, []).extend((m, round(s.pop(m), 1), why) for m, why in sorted(bad.items()))
    return rejected


def implied_prices(gold_usd, ounces):
    """Median US$ per fine troy ounce across holders, per month. -> [[month, price, n], ...]"""
    by_month = {}
    for code, s in gold_usd.items():
        if code in AGGREGATES or code not in ounces:
            continue
        for m, usd_mn in s.items():
            oz = ounces[code].get(m)
            if oz and oz / OZ_PER_TONNE >= MIN_TONNES_FOR_PRICE and usd_mn > 0:
                by_month.setdefault(m, []).append(usd_mn * 1e6 / oz)
    return [[m, round(statistics.median(p), 2), len(p)]
            for m, p in sorted(by_month.items()) if len(p) >= MIN_PRICE_REPORTERS]


def write_json(path, head, price, countries, rejected):
    """One observation per line, so git diffs show exactly which month of which country changed."""
    parts = ["{"]
    parts += [f" {json.dumps(k)}: {json.dumps(v)}," for k, v in head.items()]
    parts.append(' "price": [\n' + ",\n".join(f"  {json.dumps(r)}" for r in price) + "\n ],")
    blocks = [f"  {json.dumps(c)}: [\n" + ",\n".join(f"   {json.dumps(r)}" for r in rows) + "\n  ]"
              for c, rows in countries.items()]
    parts.append(' "countries": {\n' + ",\n".join(blocks) + "\n },")
    parts.append(f' "rejected": {json.dumps(rejected, separators=(",", ":"))}')
    parts.append("}")
    text = "\n".join(parts) + "\n"
    json.loads(text)  # never write a file the page can't parse
    path.write_text(text, encoding="utf-8")


def main(argv, run):
    raw_path, argv = pop_option(argv, "--raw")
    out_arg, argv = pop_option(argv, "--out")
    gold_arg, argv = pop_option(argv, "--gold")
    out_dir = Path(out_arg) if out_arg else OUT
    gold_path = Path(gold_arg) if gold_arg else out_dir / "gold_tonnes.json"
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
        (out_dir / "irfcl_reserves_raw.csv").write_bytes(body)
        print(f"OK   HTTP 200, {len(body) / 1e6:.1f} MB, {secs:.1f}s, {tries} {'try' if tries == 1 else 'tries'}")
    checks["fetched"] = True

    try:
        series = to_series(parse_csv(body.decode("utf-8-sig")))
    except Exception as e:  # noqa: BLE001 - report, don't crash
        print(f"FAIL could not read the response as CSV: {e}")
        checks["parsed"] = False
        return verdict(checks)
    gold_usd, total_usd = series[GOLD_USD], series[TOTAL_USD]
    both = sorted(set(gold_usd) & set(total_usd) - AGGREGATES)
    checks["parsed (50+ countries with both series)"] = len(both) >= 50
    print(f"{len(total_usd)} countries with total reserves, {len(gold_usd)} with a gold value, {len(both)} with both")

    rejected = screen(gold_usd, "gold value")
    for code, items in screen(total_usd, "total reserves").items():
        rejected.setdefault(code, []).extend(items)

    print("\n== Unit check: US gold at the statutory $42.22/oz should be ~$11,041 M ==")
    us = gold_usd.get("USA", {})
    if us:
        m = max(us)
        ok = abs(us[m] / US_BOOK_GOLD_MN - 1) < 0.01
        checks["units confirmed (US book value)"] = ok
        print(f"{'PASS' if ok else 'FAIL'} USA {m}: ${us[m]:,.1f} M gold, ${total_usd.get('USA', {}).get(m, 0):,.0f} M total reserves")
    else:
        checks["units confirmed (US book value)"] = False
        print("FAIL USA has no gold value in the response")

    print("\n== Gold price implied by reported values (median across holders) ==")
    try:
        gold = json.loads(gold_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        print(f"FAIL can't read {gold_path}: {e}")
        checks["gold volumes available"] = False
        return verdict(checks)
    ounces = {c: {m: t * OZ_PER_TONNE for m, t in rows} for c, rows in gold["countries"].items()}
    price = implied_prices(gold_usd, ounces)
    sane = bool(price) and all(200 <= p <= 20000 for _, p, _ in price)
    jumps = [(a[0], b[0]) for a, b in zip(price, price[1:]) if abs(b[1] / a[1] - 1) > 0.3]
    checks["implied price plausible ($200-20,000, no month-on-month move over 30%)"] = sane and not jumps
    for m, p, n in price[-4:]:
        print(f"  {m}  ${p:,.0f}/oz  from {n} holders")
    if jumps:
        print(f"  jumps over 30%: {jumps}")

    months = sorted({m for s in total_usd.values() for m in s})
    run.update(holders=len(both), newest_month=months[-1] if months else "")
    countries = {}
    for code in sorted(set(gold_usd) | set(total_usd)):
        if code in AGGREGATES:
            continue
        g, t = gold_usd.get(code, {}), total_usd.get(code, {})
        rows = [[m, None if m not in g else round(g[m], 1), None if m not in t else round(t[m], 1)]
                for m in sorted(set(g) | set(t))]
        if rows:
            countries[code] = rows

    print("\n== Dropped as reporting errors ==")
    for code, items in sorted(rejected.items()):
        print(f"  {code}: {len(items)} months; {'; '.join(sorted({w.split(' from ')[0] for _, _, w in items}))}")
    if not rejected:
        print("  none")

    head = {
        "source": f"IMF IRFCL, {TOTAL_USD} (official reserve assets) and {GOLD_USD} (gold), sector {TOTAL_SECTOR}",
        "request": {"url": URL, "accept": ACCEPT},
        "unit": "US dollars, millions; each row is [month, gold as reported, total official reserve assets]",
        "price_method": (f"median of reported gold value / gold volume across holders with at least "
                         f"{MIN_TONNES_FOR_PRICE:g} t, months with {MIN_PRICE_REPORTERS}+ holders; rows are [month, US$ per oz, holders]"),
    }
    write_json(out_dir / "reserves_usd.json", head, price, countries,
               {c: [[m, v, w] for m, v, w in items] for c, items in sorted(rejected.items())})
    print(f"\nWrote {out_dir / 'reserves_usd.json'}")
    return verdict(checks)


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
