#!/usr/bin/env python3
"""
Gold Tracker: world gold mine production by country, from the USGS Mineral Commodity Summaries.

The USGS publishes the summaries once a year (late January, revised a few times after) with a
data release on ScienceBase. Its "Commodity Salient U.S. and World Statistics" CSV has, for
gold, mine production for the two latest years: the top producers by name, "Other countries"
and a rounded world total, in metric tons. The latest year is marked "Estimated".

This script finds the newest edition by itself (it searches ScienceBase for this year's title,
then last year's, ...), so the yearly release needs no change here. USGS data are public
domain, so the result is committed as data/production_usgs.json.

The page's long history (1900 onward, every producing country) comes from Our World in Data,
which combines the USGS figures with the British Geological Survey's. BGS keeps copyright in
its figures, so that part is not copied into the repo: the browser loads it, like the Funds
panel. For the years this file covers, the page uses this file.

Not part of the daily IMF job. A monthly workflow (.github/workflows/fetch-production.yml) runs
it and commits the file only when it changed. Log columns are shared with the IMF scripts:
"holders" is the number of producers listed by name, "newest_month" the newest year.

Run from the gold-tracker folder:
    python spike/fetch_production.py --out data --log data/fetch_log_production.csv
    python spike/fetch_production.py --raw path/to/MCS2026_Commodities_Data.csv --out data   # no network
Exit code 0 = every check passed, 1 = something failed (see FAIL lines).
"""
import csv
import io
import json
import re
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

from fetch_irfcl import append_log, fetch, pop_option, verdict

SEARCH = "https://www.sciencebase.gov/catalog/items"
TITLE = "Mineral Commodity Summaries {y} Data Release - Commodity Salient U.S. and World Statistics"
CSV_NAME = "MCS{y}_Commodities_Data.csv"
OUT = Path(__file__).resolve().parent / "out"
WORLD_RANGE_T = (2000, 5000)  # world mine output has been 2,300-3,700 t a year since 1995

# USGS country names -> ISO 3166 alpha-3, the codes the IMF data and Our World in Data use.
# A name not listed here fails the run, so a new producer in the table is never dropped quietly.
ISO3 = {
    "Argentina": "ARG", "Australia": "AUS", "Brazil": "BRA", "Burkina Faso": "BFA", "Canada": "CAN",
    "Chile": "CHL", "China": "CHN", "Colombia": "COL", "Cote d'Ivoire": "CIV", "Côte d'Ivoire": "CIV",
    "Dominican Republic": "DOM", "Ecuador": "ECU", "Egypt": "EGY", "Ghana": "GHA", "Guinea": "GIN",
    "Guyana": "GUY", "Indonesia": "IDN", "Kazakhstan": "KAZ", "Kyrgyzstan": "KGZ", "Mali": "MLI",
    "Mauritania": "MRT", "Mexico": "MEX", "Mongolia": "MNG", "Papua New Guinea": "PNG", "Peru": "PER",
    "Philippines": "PHL", "Russia": "RUS", "Saudi Arabia": "SAU", "South Africa": "ZAF", "Sudan": "SDN",
    "Suriname": "SUR", "Tanzania": "TZA", "Turkey": "TUR", "Türkiye": "TUR", "United States": "USA",
    "Uzbekistan": "UZB", "Zimbabwe": "ZWE",
}
OTHER, WORLD = "Other countries", "World total"


def find_edition(today):
    """-> (year, item_url, csv_url, http_status, tries, seconds), newest edition first; or None."""
    last = None
    for y in range(today.year + 1, today.year - 3, -1):
        title = TITLE.format(y=y)
        q = urllib.parse.urlencode({"q": f'"{title}"', "format": "json", "fields": "title,files", "max": 20})
        status, _, body, secs, tries = fetch(f"{SEARCH}?{q}", "application/json")
        last = (status, tries, secs)
        if status != 200:
            print(f"   search for {y}: HTTP {status} {body[:120]!r}")
            continue
        for item in json.loads(body).get("items", []):
            if item.get("title", "").strip() != title:
                continue
            for f in item.get("files", []):
                if f.get("name") == CSV_NAME.format(y=y):
                    return y, item.get("link", {}).get("url", ""), f["url"], status, tries, secs
        print(f"   no {y} edition yet")
    return None, "", "", *(last or (None, 0, 0.0))


def decode(raw):
    """The CSV has been cp1252 (an em dash in "Salient Statistics—United States"); allow UTF-8 too."""
    for enc in ("utf-8-sig", "cp1252"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            pass
    return raw.decode("utf-8", errors="replace")


def gold_rows(text):
    """-> {name: {year: (tonnes, estimated)}} from the gold world mine production table."""
    out = {}
    for r in csv.DictReader(io.StringIO(text)):
        if not (r.get("Commodity") or "").lower().startswith("gold"):
            continue
        if not (r.get("Section") or "").startswith("World Mine Production") or r.get("Statistics") != "Production":
            continue
        unit = (r.get("Unit") or "").lower()
        if unit not in ("metric tons", "metric tonnes"):
            raise ValueError(f"unexpected unit {r.get('Unit')!r} for {r.get('Country')}")
        try:
            year, value = int(r["Year"]), float((r.get("Value") or "").replace(",", ""))
        except ValueError:
            continue  # "W" (withheld) or blank
        out.setdefault(r["Country"].strip(), {})[year] = (value, "estimated" in (r.get("Notes") or "").lower())
    return out


def main(argv, run):
    raw_path, argv = pop_option(argv, "--raw")
    out_arg, argv = pop_option(argv, "--out")
    out_dir = Path(out_arg) if out_arg else OUT
    checks = {}

    if raw_path:
        raw = Path(raw_path).read_bytes()
        m = re.search(r"MCS(\d{4})", Path(raw_path).name)
        edition, item_url, csv_url = (int(m.group(1)) if m else None), "", ""
        print(f"== Reading saved CSV {raw_path} ({len(raw) / 1e6:.2f} MB) ==")
    else:
        print("== Finding the newest USGS Mineral Commodity Summaries data release ==")
        edition, item_url, csv_url, status, tries, secs = find_edition(datetime.now(timezone.utc))
        run.update(http_status=status, tries=tries, seconds=round(secs, 1))
        checks["Found a data release"] = bool(csv_url)
        if not csv_url:
            return verdict(checks)
        print(f"   edition {edition}: {item_url}")
        status, ctype, raw, secs, tries = fetch(csv_url, "text/csv")
        # tries > 1 means a request had to be retried, as in the IMF logs (not the number of requests).
        run.update(http_status=status, tries=max(run["tries"], tries), seconds=round(run["seconds"] + secs, 1),
                   mb=round(len(raw) / 1e6, 2))
        print(f"   CSV: HTTP {status}, {ctype}, {len(raw) / 1e6:.2f} MB, {secs:.1f} s")
        checks["CSV downloaded (HTTP 200)"] = status == 200
        if status != 200:
            return verdict(checks)
        thisyear = datetime.now(timezone.utc).year
        checks[f"Edition is recent ({edition} >= {thisyear - 1})"] = edition >= thisyear - 1

    rows = gold_rows(decode(raw))
    world, other = rows.pop(WORLD, {}), rows.pop(OTHER, {})
    unknown = sorted(n for n in rows if n not in ISO3)
    years = sorted(world)
    print(f"\n== Gold, world mine production: {len(rows)} producers by name, years {years} ==")
    checks["World total for two years"] = len(years) >= 2
    checks["Every producer name is mapped to a country code" + (f" (unknown: {', '.join(unknown)})" if unknown else "")] = not unknown
    checks["China is listed"] = "China" in rows
    for y in years:
        w = world[y][0]
        listed = sum(s[y][0] for s in rows.values() if y in s) + other.get(y, (0, False))[0]
        print(f"   {y}: world {w:,.0f} t, producers + other {listed:,.0f} t{' (estimated)' if world[y][1] else ''}")
        checks[f"{y} world total is {WORLD_RANGE_T[0]:,}-{WORLD_RANGE_T[1]:,} t"] = WORLD_RANGE_T[0] <= w <= WORLD_RANGE_T[1]
        # USGS rounds the world total (to 10 or 100 t); the parts must still add up to it.
        checks[f"{y} producers + other within 3% of the world total"] = abs(listed / w - 1) <= 0.03
    if unknown:
        return verdict(checks)

    newest = years[-1] if years else None
    for name, s in sorted(rows.items(), key=lambda kv: -kv[1].get(newest, (0, 0))[0]):
        print(f"   {ISO3[name]} {name:16} " + "  ".join(f"{y}: {s[y][0]:6,.0f} t" for y in years if y in s))
    run.update(holders=len(rows), newest_month=str(newest))

    def pack(s):
        num = lambda v: int(v) if v.is_integer() else v  # noqa: E731
        return [[y, num(s[y][0]), "est"] if s[y][1] else [y, num(s[y][0])] for y in sorted(s)]
    out = {
        "source": f"USGS Mineral Commodity Summaries {edition}, gold, world mine production (data release)",
        "edition": edition,
        "item": item_url,
        "csv": csv_url,
        "unit": "tonnes",
        "note": "WLD = world total (rounded by USGS), OTH = other countries. \"est\" = estimated by USGS.",
        "production": {"WLD": pack(world), "OTH": pack(other),
                       **{ISO3[n]: pack(s) for n, s in sorted(rows.items(), key=lambda kv: ISO3[kv[0]])}},
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    # One producer per line, so a revision shows as a one-line diff.
    head = json.dumps({k: v for k, v in out.items() if k != "production"}, indent=1)[:-2]  # drop "\n}"
    prod = ",\n".join(f'  "{c}": {json.dumps(v)}' for c, v in out["production"].items())
    path = out_dir / "production_usgs.json"
    path.write_text(f'{head},\n "production": {{\n{prod}\n }}\n}}\n', encoding="utf-8")
    checks["Output is valid JSON"] = json.loads(path.read_text(encoding="utf-8")) == out
    print(f"\nWrote {out_dir / 'production_usgs.json'}")
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
