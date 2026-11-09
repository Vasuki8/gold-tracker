#!/usr/bin/env python3
"""
Gold Tracker: foreign official holdings of US Treasury securities, from the US Treasury's TIC
system ("Major Foreign Holders of Treasury Securities").

Central banks hold reserves mostly as US Treasuries and gold, so the two series side by side show
whether reported gold buying comes with a move out of Treasuries. Two plain-text files, both
tab-separated, no API key:
- mfhhis01.txt: the history, one block of 12 months per year since 2000, with a "For. Official"
  row (foreign official institutions: central banks, finance ministries, sovereign funds);
- slt_table5.txt: the latest 13 months, with an "Of Which: Foreign Official" row. It carries the
  current year and the latest revisions, so it wins where the two overlap.
Values are US$ billions at the end of each month. US government data, public domain, so the
result is committed as data/treasuries_tic.json.

Not part of the daily IMF job: a monthly workflow (.github/workflows/fetch-dollar.yml) runs it.

    python spike/fetch_tic.py --out data --log data/fetch_log_tic.csv
Exit code 0 = every check passed, 1 = something failed (see FAIL lines).
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from fetch_irfcl import append_log, fetch, pop_option, verdict

BASE = "https://ticdata.treasury.gov/resource-center/data-chart-center/tic/Documents/"
HIST_URL, CURRENT_URL = BASE + "mfhhis01.txt", BASE + "slt_table5.txt"
OUT = Path(__file__).resolve().parent / "out"
MON = {m: k + 1 for k, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split())}
OFFICIAL_RANGE_BN = (300, 10000)  # foreign official holdings were ~$600 bn in 2000, ~$4 tn in 2026


def num(x):
    x = x.strip().replace(",", "")
    try:
        return float(x)
    except ValueError:
        return None  # blank, "n.a.", "*"


def parse_history(text):
    """-> {month_key: (official_bn, total_bn)} from the year blocks of mfhhis01.txt."""
    out, prev = {}, []
    lines = text.splitlines()
    for n, line in enumerate(lines):
        cells = line.split("\t")
        if cells[0].strip() != "Country":
            continue
        years = [c.strip() for c in cells[1:13]]
        months = [c.strip() for c in lines[n - 1].split("\t")[1:13]]
        keys = [f"{y}-{MON[m]:02d}" if y.isdigit() and m in MON else None for y, m in zip(years, months)]
        rows = {}
        for look in lines[n + 1:n + 80]:
            c = look.split("\t")
            name = c[0].strip().strip('"')
            if name == "Country":
                break
            if name in ("Grand Total", "For. Official"):
                rows[name] = [num(x) for x in c[1:13]]
        for k, key in enumerate(keys):
            if key is None:
                continue
            off = rows.get("For. Official", [None] * 12)[k]
            tot = rows.get("Grand Total", [None] * 12)[k]
            if off is not None:
                out[key] = (off, tot)
        prev.append(years[0])
    return out, len(prev)


def parse_current(text):
    """-> {month_key: (official_bn, total_bn)} from slt_table5.txt (header row 'Country\\t2026-08\\t...')."""
    keys, rows = [], {}
    for line in text.splitlines():
        c = [x.strip() for x in line.split("\t")]
        if c[0] == "Country":
            keys = c[1:]
        elif c[0] in ("Grand Total", "Of Which: Foreign Official") and keys:
            rows[c[0]] = [num(x) for x in c[1:len(keys) + 1]]
    out = {}
    for k, key in enumerate(keys):
        if len(key) != 7 or key[4] != "-":
            continue
        off = rows.get("Of Which: Foreign Official", [None] * len(keys))[k]
        tot = rows.get("Grand Total", [None] * len(keys))[k]
        if off is not None:
            out[key] = (off, tot)
    return out


def main(argv, run):
    out_arg, argv = pop_option(argv, "--out")
    out_dir = Path(out_arg) if out_arg else OUT
    checks = {}
    print("== Fetching TIC major foreign holders of Treasury securities ==")
    texts = {}
    for name, url in (("history", HIST_URL), ("current", CURRENT_URL)):
        status, ctype, raw, secs, tries = fetch(url, "text/plain")
        run.update(http_status=status, tries=max(run.get("tries", 0), tries), seconds=round(run.get("seconds", 0) + secs, 1),
                   mb=round(run.get("mb", 0) + len(raw) / 1e6, 3))
        print(f"   {name}: HTTP {status}, {len(raw) / 1e3:.0f} kB, {secs:.1f} s")
        checks[f"{name} file downloaded (HTTP 200)"] = status == 200
        texts[name] = raw.decode("utf-8", errors="replace") if status == 200 else ""
    if not all(checks.values()):
        return verdict(checks)

    hist, blocks = parse_history(texts["history"])
    cur = parse_current(texts["current"])
    print(f"   history: {blocks} year blocks, {len(hist)} months; current: {len(cur)} months")
    checks["History has 20+ year blocks"] = blocks >= 20
    checks["Current table has 12+ months"] = len(cur) >= 12
    overlap = sorted(set(hist) & set(cur))
    if overlap:
        worst = max(abs(cur[k][0] / hist[k][0] - 1) for k in overlap if hist[k][0])
        print(f"   overlap {overlap[0]}..{overlap[-1]}: largest revision {worst:.1%} (the current table wins)")
    months = {**hist, **cur}
    keys = sorted(months)
    if not keys:
        checks["Any months parsed"] = False
        return verdict(checks)
    newest = keys[-1]
    today = datetime.now(timezone.utc)
    age = (today.year * 12 + today.month) - (int(newest[:4]) * 12 + int(newest[5:]))
    checks[f"Newest month {newest} is at most 4 months old"] = age <= 4
    checks["300+ months in total"] = len(keys) >= 300
    offs = [months[k][0] for k in keys]
    checks[f"Official holdings within ${OFFICIAL_RANGE_BN[0]}-{OFFICIAL_RANGE_BN[1]:,} bn every month"] = all(OFFICIAL_RANGE_BN[0] <= v <= OFFICIAL_RANGE_BN[1] for v in offs)
    checks["Official holdings never exceed the grand total"] = all(months[k][1] is None or months[k][0] <= months[k][1] * 1.001 for k in keys)
    print(f"   {keys[0]}: ${offs[0]:,.0f} bn official; {newest}: ${offs[-1]:,.0f} bn official of ${months[newest][1]:,.0f} bn foreign-held")

    out = {
        "source": "US Treasury, Treasury International Capital (TIC): Major Foreign Holders of Treasury Securities",
        "urls": {"history": HIST_URL, "current": CURRENT_URL},
        "unit": "US$ billions, holdings at end of month",
        "note": "official = foreign official institutions (central banks, finance ministries, sovereign funds); total = all foreign holders. "
                "Custodial data: securities held through third-country custodians are attributed to the custodian's country.",
        "months": [[k, months[k][0], months[k][1]] for k in keys],
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    head = json.dumps({k: v for k, v in out.items() if k != "months"}, indent=1)[:-2]
    rows = ",\n".join(f"  {json.dumps(r)}" for r in out["months"])
    path = out_dir / "treasuries_tic.json"
    path.write_text(f'{head},\n "months": [\n{rows}\n ]\n}}\n', encoding="utf-8")
    checks["Output is valid JSON"] = json.loads(path.read_text(encoding="utf-8")) == out
    run.update(holders=len(keys), newest_month=newest)
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
