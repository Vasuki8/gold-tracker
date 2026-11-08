#!/usr/bin/env python3
"""
What changed in the IMF gold data since the last commit, and is it worth an alert?

Compares the previous gold_tonnes.json (the last committed copy) with the one just fetched:
- per holder: months that are new, revised (by 0.05 t or more) or gone;
- the page's headline gauge before and after: 12-month net, last 3 months, and the word the page
  shows ("Speeding up", "Slowing", ...). This is a port of buildModel()/trendWord() in
  assets/app.js, kept to the parts the gauge needs; the two must count a month the same way.

When anything changed it appends one entry to --log (data/changes.json, one entry per line,
newest last), which the page's Updates panel reads. It then decides whether the news is worth an
alert: a month entering the totals, the gauge's word changing, or one big move. With --issue it
opens a GitHub issue for that, assigned to the repo owner, so GitHub emails them. Without --issue
it only prints what the issue would say.

    python spike/changes.py --old OLD.json --new data/gold_tonnes.json --log data/changes.json
    python spike/changes.py ... --issue            # the daily job (GITHUB_TOKEN, GITHUB_REPOSITORY)
    python spike/changes.py ... --date 2026-11-08  # backfill an entry under a given date

Standard library only. Exit code 0 = done (with or without news), 1 = the issue couldn't be opened.
"""
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_irfcl import pop_option  # noqa: E402

# Same rules as assets/app.js.
COVERAGE_MIN = 0.9
STALE_MONTHS = 6
BRIDGE_MONTHS = 3
# What counts as news on its own.
BIG_MOVE_T = 20.0      # one holder, one month
BIG_REVISION_T = 10.0  # a past month revised by this much
MIN_DIFF_T = 0.05      # smaller differences are rounding
MAX_ITEMS = 300        # per log entry; a wholesale re-submission is summarised, not listed
MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
# Display names for the alert text; the same list as NAMES in assets/app.js.
NAMES = {k: v.replace("_", " ") for k, v in (x.split(":") for x in (
    "ALB:Albania ARG:Argentina ARM:Armenia AUS:Australia AUT:Austria BEL:Belgium BGR:Bulgaria BLR:Belarus "
    "BOL:Bolivia BRA:Brazil CAN:Canada CHE:Switzerland CHL:Chile CHN:China COL:Colombia CRI:Costa_Rica "
    "CYP:Cyprus CZE:Czechia DEU:Germany DNK:Denmark DOM:Dominican_Republic ECU:Ecuador EGY:Egypt ESP:Spain "
    "EST:Estonia EZB:ECB FIN:Finland FRA:France GBR:United_Kingdom GEO:Georgia GRC:Greece GTM:Guatemala "
    "HKG:Hong_Kong_SAR HND:Honduras HRV:Croatia HUN:Hungary IDN:Indonesia IND:India IRL:Ireland ISL:Iceland "
    "ITA:Italy JAM:Jamaica JOR:Jordan JPN:Japan KAZ:Kazakhstan KGZ:Kyrgyz_Republic KHM:Cambodia "
    "KOR:South_Korea KOS:Kosovo LKA:Sri_Lanka LTU:Lithuania LUX:Luxembourg LVA:Latvia MAR:Morocco MDA:Moldova "
    "MEX:Mexico MKD:North_Macedonia MLT:Malta MNG:Mongolia MUS:Mauritius MYS:Malaysia NIC:Nicaragua "
    "NLD:Netherlands NOR:Norway NZL:New_Zealand PER:Peru PHL:Philippines POL:Poland PRT:Portugal PRY:Paraguay "
    "ROU:Romania RUS:Russia SAU:Saudi_Arabia SGP:Singapore SLV:El_Salvador SRB:Serbia SVK:Slovakia "
    "SVN:Slovenia SWE:Sweden THA:Thailand TUN:Tunisia TUR:Turkey UKR:Ukraine URY:Uruguay USA:United_States "
    "WBG:West_Bank_and_Gaza ZAF:South_Africa AGO:Angola UZB:Uzbekistan").split())}


def name(code):
    return NAMES.get(code, code)


def plural(n, one, many=None):
    return f"{n} {one if n == 1 else many or one + 's'}"


def idx(k):
    y, m = map(int, k.split("-"))
    return y * 12 + m - 1


def label(i):
    return f"{MONTHS[i % 12]} {i // 12}"


def key(i):
    return f"{i // 12}-{i % 12 + 1:02d}"


def series_of(raw):
    return {c: {idx(k): v for k, v in rows} for c, rows in raw.get("countries", {}).items()}


def change(s, i):
    """This month's value minus the previous available one, looking back over up to 3 gaps."""
    if i not in s:
        return None
    for j in range(i - 1, i - BRIDGE_MONTHS - 2, -1):
        if j in s:
            return s[i] - s[j]
    return None


def trend_word(r12, pace):
    tol = max(0.15 * abs(r12), 20)
    diff = pace - r12
    if abs(diff) <= tol:
        return "Steady pace" if r12 >= 0 else "Selling at a steady pace"
    if r12 >= 0:
        return "Speeding up" if diff > 0 else "Slowing"
    return "Selling faster" if diff < 0 else "Selling slower"


def gauge(raw):
    hs = series_of(raw)
    if not hs:
        return None
    newest = max(max(s) for s in hs.values())
    first = min(min(s) for s in hs.values())
    activity = {}
    for c, s in hs.items():
        last = max(s)
        if newest - last > STALE_MONTHS:
            continue
        activity[c] = sum(abs(change(s, i) or 0) for i in range(last - 11, last + 1))
    total = sum(activity.values())
    net, coverage = {}, {}
    for i in range(first + 1, newest + 1):
        net[i] = sum(ch for s in hs.values() if (ch := change(s, i)) is not None)
        covered = sum(a for c, a in activity.items() if i in hs[c])
        coverage[i] = covered / total if total else 1
    complete = newest
    while complete > first + 12 and coverage[complete] < COVERAGE_MIN:
        complete -= 1

    def sum_net(a, b):
        return sum(net.get(i, 0) for i in range(a, b + 1))

    r12, prev12, r3 = sum_net(complete - 11, complete), sum_net(complete - 23, complete - 12), sum_net(complete - 2, complete)
    return {"complete": key(complete), "newest": key(newest), "r12": round(r12, 1), "prev12": round(prev12, 1),
            "r3": round(r3, 1), "word": trend_word(r12, r3 * 4),
            "pending": {key(i): round(coverage[i], 3) for i in range(complete + 1, newest + 1)}}


def diff(old, new):
    """-> list of {code, month, kind: new|revised|gone, t, was, move}. 'move' is a new month's change."""
    so, sn = series_of(old), series_of(new)
    items = []
    for code in sorted(set(so) | set(sn)):
        o, n = so.get(code, {}), sn.get(code, {})
        for i in sorted(set(o) | set(n)):
            if i not in o:
                mv = change(n, i)
                items.append({"code": code, "month": key(i), "kind": "new", "t": round(n[i], 2),
                              "move": None if mv is None else round(mv, 2)})
            elif i not in n:
                items.append({"code": code, "month": key(i), "kind": "gone", "was": round(o[i], 2)})
            elif abs(n[i] - o[i]) >= MIN_DIFF_T:
                items.append({"code": code, "month": key(i), "kind": "revised", "t": round(n[i], 2), "was": round(o[i], 2)})
    return items


def news(entry):
    """The parts of an entry that deserve an alert, as short lines. Empty list = no alert."""
    b, a = entry["gauge"]["before"], entry["gauge"]["after"]
    lines = []
    if b and a and idx(a["complete"]) > idx(b["complete"]):
        lines.append(f"Totals now complete through {label(idx(a['complete']))} (were through {label(idx(b['complete']))}).")
    if b and a and a["word"] != b["word"]:
        lines.append(f"Direction changed: {b['word']} → {a['word']}.")
    for x in entry["items"]:
        if x["kind"] == "new" and x.get("move") is not None and abs(x["move"]) >= BIG_MOVE_T:
            lines.append(f"Big move: {name(x['code'])} {signed(x['move'])} in {label(idx(x['month']))}.")
        elif x["kind"] == "revised" and abs(x["t"] - x["was"]) >= BIG_REVISION_T:
            lines.append(f"Revision: {name(x['code'])} {label(idx(x['month']))} {x['was']:,.1f} → {x['t']:,.1f} t.")
    return lines


def signed(v):
    return f"{'+' if v >= 0.05 else '−' if v <= -0.05 else ''}{abs(v):,.1f} t"


def issue_text(entry, lines, page_url):
    a, b = entry["gauge"]["after"], entry["gauge"]["before"]
    head = [x for x in lines if not x.startswith(("Big move", "Revision"))]
    title_bits = [label(idx(a["complete"])) + " in the totals"] if any(x.startswith("Totals") for x in head) else []
    title_bits.append(a["word"])
    title = f"Gold reserves update: {' · '.join(title_bits)} ({signed(a['r12'])} over 12 months)"
    rows = [
        "| | Before | Now |", "|---|---:|---:|",
        f"| Totals complete through | {label(idx(b['complete']))} | {label(idx(a['complete']))} |",
        f"| Net reported buying, 12 months | {signed(b['r12'])} | {signed(a['r12'])} |",
        f"| Last 3 months | {signed(b['r3'])} | {signed(a['r3'])} |",
        f"| Gauge | {b['word']} | {a['word']} |",
    ]
    moves = sorted((x for x in entry["items"] if x["kind"] == "new" and x.get("move") not in (None, 0)),
                   key=lambda x: -abs(x["move"]))[:8]
    body = ["What triggered this alert:", "", *[f"- {x}" for x in lines], "", *rows, ""]
    if moves:
        body += ["Biggest new figures:", "", *[f"- {name(x['code'])} {label(idx(x['month']))}: {signed(x['move'])} (holds {x['t']:,.1f} t)" for x in moves], ""]
    counts = entry["counts"]
    body += [f"This update: {plural(counts['new'], 'new figure')}, {counts['revised']} revised, {counts['gone']} removed. "
             f"Pending months: {', '.join(f'{label(idx(k))} {round(v * 100)}%' for k, v in a['pending'].items()) or 'none'}.",
             "", f"Page: {page_url}", "",
             "_Opened by the daily fetch job (spike/changes.py). Reported holdings only; close this issue once read._"]
    return title, "\n".join(body)


def open_issue(title, body):
    token, repo = os.environ.get("GITHUB_TOKEN"), os.environ.get("GITHUB_REPOSITORY")
    if not token or not repo:
        print("FAIL --issue needs GITHUB_TOKEN and GITHUB_REPOSITORY")
        return False
    owner = os.environ.get("GITHUB_REPOSITORY_OWNER") or repo.split("/")[0]
    payload = json.dumps({"title": title, "body": body, "assignees": [owner]}).encode()
    req = urllib.request.Request(f"https://api.github.com/repos/{repo}/issues", data=payload, method="POST", headers={
        "Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "gold-tracker-alerts", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            url = json.loads(r.read()).get("html_url")
            print(f"OK   opened {url}")
            return True
    except urllib.error.HTTPError as e:
        print(f"FAIL GitHub answered HTTP {e.code}: {e.read()[:300].decode(errors='replace')}")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"FAIL could not reach GitHub: {e}")
    return False


def append_entry(path, entry):
    """data/changes.json: a JSON list, one entry per line, newest last."""
    entries = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    entries.append(entry)
    text = "[\n" + ",\n".join(json.dumps(e, ensure_ascii=False, separators=(",", ":")) for e in entries) + "\n]\n"
    json.loads(text)
    path.write_text(text, encoding="utf-8")


def main(argv):
    old_arg, argv = pop_option(argv, "--old")
    new_arg, argv = pop_option(argv, "--new")
    log_arg, argv = pop_option(argv, "--log")
    date_arg, argv = pop_option(argv, "--date")
    post = "--issue" in argv
    if not new_arg:
        print(__doc__)
        return 1
    new = json.loads(Path(new_arg).read_text(encoding="utf-8"))
    try:
        old = json.loads(Path(old_arg).read_text(encoding="utf-8")) if old_arg else {}
    except (OSError, ValueError):
        old = {}
    if not old.get("countries"):
        print("No previous data to compare with (first run?): nothing to report.")
        return 0

    items = diff(old, new)
    if not items:
        print("No change in the IMF gold data since the last commit.")
        return 0
    before, after = gauge(old), gauge(new)
    counts = {k: sum(1 for x in items if x["kind"] == k) for k in ("new", "revised", "gone")}
    entry = {
        "date": date_arg or datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "run": os.environ.get("GITHUB_RUN_ID", "local"),
        "counts": counts,
        "gauge": {"before": before, "after": after},
        "items": sorted(items, key=lambda x: (x["kind"] != "revised", -abs(x.get("move") or 0), x["code"], x["month"]))[:MAX_ITEMS],
    }
    print(f"Changed: {counts['new']} new, {counts['revised']} revised, {counts['gone']} removed. "
          f"Gauge {before['complete']} {before['word']} {before['r12']:+} t -> {after['complete']} {after['word']} {after['r12']:+} t")
    if log_arg:
        append_entry(Path(log_arg), entry)
        print(f"Appended to {log_arg}")

    lines = news(entry)
    if not lines:
        print("Nothing alert-worthy in this change.")
        return 0
    repo = os.environ.get("GITHUB_REPOSITORY", "Vasuki8/gold-tracker")
    owner, name = repo.split("/")
    title, body = issue_text(entry, lines, f"https://{owner.lower()}.github.io/{name}/")
    print(f"\nAlert: {title}\n{body}\n")
    if not post:
        print("(not posted: run with --issue to open it)")
        return 0
    return 0 if open_issue(title, body) else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # "−" and "→" on a Windows console
    sys.exit(main(sys.argv[1:]))
