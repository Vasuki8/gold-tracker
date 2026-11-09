#!/usr/bin/env python3
"""
Gold Tracker: COMEX gold futures positions by trader type, from the CFTC's Commitments of Traders
(disaggregated, futures only), weekly since 2006. US government data, committed as
data/cftc_gold.json so the page has it even when the CFTC's API is down, and so a weekly job can
open an alert when the funds' bet moves a lot.

One request to the CFTC's Socrata API (dataset 72hh-3qpy, contract code 088691 = COMEX gold),
about 1,050 weekly rows. Positions are in contracts of 100 troy ounces, as of Tuesday, published
on Friday. Not part of the daily IMF job: .github/workflows/fetch-cftc.yml runs it on Saturdays.

    python spike/fetch_cftc.py --out data --log data/fetch_log_cftc.csv
    python spike/fetch_cftc.py ... --old PREVIOUS.json --issue    # the weekly job: alert on big moves
Without --issue the alert text is only printed. Exit code 0 = every check passed (and the issue,
if any, was opened), 1 = something failed (see FAIL lines).
"""
import json
import os
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

from fetch_irfcl import append_log, fetch, pop_option, verdict

CODE = "088691"  # COMEX gold
FIELDS = ["report_date_as_yyyy_mm_dd", "open_interest_all", "m_money_positions_long_all", "m_money_positions_short_all",
          "swap_positions_long_all", "swap__positions_short_all", "prod_merc_positions_long", "prod_merc_positions_short",
          "other_rept_positions_long", "other_rept_positions_short", "nonrept_positions_long_all", "nonrept_positions_short_all"]
COLUMNS = ["date", "open_interest", "mm_long", "mm_short", "swap_long", "swap_short", "prod_long", "prod_short",
           "other_long", "other_short", "nonrept_long", "nonrept_short"]
URL = "https://publicreporting.cftc.gov/resource/72hh-3qpy.json?" + urllib.parse.urlencode({
    "$select": ",".join(FIELDS), "$where": f"cftc_contract_market_code='{CODE}'",
    "$order": "report_date_as_yyyy_mm_dd", "$limit": "5000"})
OUT = Path(__file__).resolve().parent / "out"
OZ_PER_TONNE = 32150.7466
CONTRACT_T = 100 / OZ_PER_TONNE
# What counts as news on its own.
BIG_WEEK_CONTRACTS = 25000   # funds' net position moved this much in a week (about 78 t)
MAX_AGE_DAYS = 14            # the newest Tuesday should be within two weeks of the run


def tonnes(contracts):
    return f"{contracts * CONTRACT_T:,.0f} t"


def signed_t(contracts):
    v = contracts * CONTRACT_T
    return f"{'+' if v >= 0.5 else '−' if v <= -0.5 else ''}{abs(v):,.0f} t"


def rows_from(payload):
    out = []
    for r in payload:
        try:
            date = str(r["report_date_as_yyyy_mm_dd"])[:10]
            vals = [int(float(r[f])) for f in FIELDS[1:]]
        except (KeyError, TypeError, ValueError):
            continue
        datetime.strptime(date, "%Y-%m-%d")
        out.append([date, *vals])
    out.sort()
    return out


def net(row, kind):
    k = COLUMNS.index(f"{kind}_long")
    return row[k] - row[k + 1]


def news(old_rows, rows):
    """Alert lines for the weeks that are new since the last commit. Empty = nothing to say."""
    known = {r[0] for r in old_rows}
    fresh = [r for r in rows if r[0] not in known]
    if not fresh or len(rows) < 60:
        return []
    lines = []
    prev = rows[rows.index(fresh[0]) - 1] if rows.index(fresh[0]) > 0 else None
    last = rows[-1]
    mm_now = net(last, "mm")
    if prev:
        d = mm_now - net(prev, "mm")
        if abs(d) >= BIG_WEEK_CONTRACTS:
            lines.append(f"Big move: managed money (funds) net position {signed_t(d)} in the week to {last[0]} "
                         f"({d:+,} contracts), now {tonnes(mm_now)} net {'long' if mm_now >= 0 else 'short'}.")
        if (mm_now >= 0) != (net(prev, 'mm') >= 0):
            lines.append(f"Funds flipped to net {'long' if mm_now >= 0 else 'short'} in the week to {last[0]}.")
    year = [net(r, "mm") for r in rows[-52:-1]]
    if year and mm_now > max(year):
        lines.append(f"Funds' net long is the highest in a year: {tonnes(mm_now)} ({mm_now:,} contracts) in the week to {last[0]}.")
    elif year and mm_now < min(year):
        lines.append(f"Funds' net long is the lowest in a year: {tonnes(mm_now)} ({mm_now:,} contracts) in the week to {last[0]}.")
    return lines


def issue_text(rows, lines, page_url):
    last = rows[-1]
    w4 = rows[-5] if len(rows) >= 5 else rows[0]
    mm, sd, pm = net(last, "mm"), net(last, "swap"), net(last, "prod")
    title = f"Gold futures update: funds net {'long' if mm >= 0 else 'short'} {tonnes(abs(mm))} ({signed_t(mm - net(w4, 'mm'))} in 4 weeks)"
    body = ["What triggered this alert:", "", *[f"- {x}" for x in lines], "",
            f"| Week to {last[0]} | Net position | 4-week change |", "|---|---:|---:|",
            f"| Managed money (funds) | {signed_t(mm)} | {signed_t(mm - net(w4, 'mm'))} |",
            f"| Swap dealers (banks) | {signed_t(sd)} | {signed_t(sd - net(w4, 'swap'))} |",
            f"| Producers and merchants | {signed_t(pm)} | {signed_t(pm - net(w4, 'prod'))} |",
            f"| Open interest | {tonnes(last[1])} | {signed_t(last[1] - w4[1])} |", "",
            "Net position = long minus short contracts of 100 troy ounces, Tuesday positions, published Friday.", "",
            f"Page: {page_url}#funds", "",
            "_Opened by the weekly CFTC job (spike/fetch_cftc.py). Market positioning, not official reserves; close this issue once read._"]
    return title, "\n".join(body)


def main(argv, run):
    out_arg, argv = pop_option(argv, "--out")
    old_arg, argv = pop_option(argv, "--old")
    post = "--issue" in argv
    out_dir = Path(out_arg) if out_arg else OUT
    checks = {}
    print("== Fetching CFTC Commitments of Traders, COMEX gold, disaggregated futures only ==")
    status, ctype, raw, secs, tries = fetch(URL, "application/json")
    run.update(http_status=status, tries=tries, seconds=round(secs, 1), mb=round(len(raw) / 1e6, 2))
    print(f"   HTTP {status}, {ctype}, {len(raw) / 1e6:.2f} MB, {secs:.1f} s")
    checks["CFTC data downloaded (HTTP 200)"] = status == 200
    if status != 200:
        print(f"   body: {raw[:200]!r}")
        return verdict(checks)
    try:
        payload = json.loads(raw)
    except ValueError:
        checks["Response is JSON"] = False
        return verdict(checks)
    rows = rows_from(payload)
    print(f"   {len(rows)} weeks, {rows[0][0] if rows else '-'} to {rows[-1][0] if rows else '-'}")
    checks["900+ weekly rows"] = len(rows) >= 900
    checks["Every row parsed (no row dropped)"] = len(rows) == len(payload)
    checks["Dates are unique"] = len({r[0] for r in rows}) == len(rows)
    if rows:
        age = (datetime.now(timezone.utc) - datetime.strptime(rows[-1][0], "%Y-%m-%d").replace(tzinfo=timezone.utc)).days
        checks[f"Newest week {rows[-1][0]} is at most {MAX_AGE_DAYS} days old"] = age <= MAX_AGE_DAYS
        checks["Positions are non-negative"] = all(v >= 0 for r in rows for v in r[1:])
        checks["Long and short positions never exceed open interest"] = all(max(r[2:]) <= r[1] for r in rows)
        mm = net(rows[-1], "mm")
        print(f"   latest: funds net {mm:+,} contracts ({signed_t(mm)}), open interest {rows[-1][1]:,} contracts")
    if not all(checks.values()):
        return verdict(checks)

    out = {
        "source": "CFTC Commitments of Traders, disaggregated futures only, COMEX gold (contract code 088691)",
        "url": URL,
        "unit": "contracts of 100 troy ounces, positions as of Tuesday; mm = managed money, swap = swap dealers, prod = producers and merchants, "
                "other = other reportables, nonrept = non-reportable",
        "columns": COLUMNS,
        "weeks": rows,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    head = json.dumps({k: v for k, v in out.items() if k != "weeks"}, indent=1)[:-2]
    body = ",\n".join(f"  {json.dumps(r)}" for r in rows)
    path = out_dir / "cftc_gold.json"
    path.write_text(f'{head},\n "weeks": [\n{body}\n ]\n}}\n', encoding="utf-8")
    checks["Output is valid JSON"] = json.loads(path.read_text(encoding="utf-8")) == out
    run.update(holders=len(rows), newest_month=rows[-1][0])
    print(f"\nWrote {path}")

    if old_arg:
        try:
            old_rows = json.loads(Path(old_arg).read_text(encoding="utf-8")).get("weeks", [])
        except (OSError, ValueError):
            old_rows = []
        lines = news(old_rows, rows)
        if not lines:
            print("Nothing alert-worthy in the new weeks." if old_rows else "No previous data to compare with.")
        else:
            repo = os.environ.get("GITHUB_REPOSITORY", "Vasuki8/gold-tracker")
            owner, name = repo.split("/")
            title, text = issue_text(rows, lines, f"https://{owner.lower()}.github.io/{name}/")
            print(f"\nAlert: {title}\n{text}\n")
            if post:
                sys.path.insert(0, str(Path(__file__).resolve().parent))
                from changes import open_issue
                checks["Alert issue opened"] = open_issue(title, text)
            else:
                print("(not posted: run with --issue to open it)")
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
