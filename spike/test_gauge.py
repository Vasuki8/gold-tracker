#!/usr/bin/env python3
"""
Do spike/changes.py and assets/app.js count a month the same way?

changes.py carries a Python port of the page's gauge (buildModel()/headline()/trendWord()) so that
the alert job can say "Speeding up" exactly when the page does. Nothing enforces that the two stay
in step except this test: it runs both on the committed data and on a few edited copies of it
(a late filer, a dropped month, a big purchase, a holder gone stale) and compares the gauges.

    python spike/test_gauge.py            # exit 0 = every case agrees

Needs Node.js for the JavaScript side (spike/gauge_js.mjs). Standard library otherwise.
"""
import copy
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "spike"))
import changes  # noqa: E402

DATA = ROOT / "data" / "gold_tonnes.json"


def js_gauge(node, path):
    out = subprocess.run([node, str(ROOT / "spike" / "gauge_js.mjs"), str(path)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def py_gauge(raw):
    g = changes.gauge(raw)
    g["pending"] = {k: round(v, 3) for k, v in g["pending"].items()}
    return g


def drop_last(raw, code, n):
    """A holder that hasn't filed its last n months yet."""
    raw["countries"][code] = raw["countries"][code][:-n]


def drop_month(raw, code, key):
    """One month missing inside a series: the change must bridge the gap."""
    raw["countries"][code] = [r for r in raw["countries"][code] if r[0] != key]


def add_month(raw, code, key, value):
    raw["countries"][code] = sorted(raw["countries"][code] + [[key, value]])


def cases(raw):
    newest = max(r[0] for rows in raw["countries"].values() for r in rows)
    y, mo = map(int, newest.split("-"))
    nxt = f"{y + (mo == 12)}-{(mo % 12) + 1:02d}"
    big = sorted(raw["countries"], key=lambda c: -raw["countries"][c][-1][1])[:12]
    tur = "TUR" if "TUR" in raw["countries"] else big[0]
    yield "committed data", raw
    c = copy.deepcopy(raw); drop_last(c, tur, 2); yield f"{tur} two months late", c
    c = copy.deepcopy(raw); [drop_last(c, code, 1) for code in big]; yield "12 largest holders a month late", c
    c = copy.deepcopy(raw); drop_month(c, tur, raw["countries"][tur][-2][0]); yield f"{tur} missing a month inside its series", c
    c = copy.deepcopy(raw); add_month(c, "POL", nxt, raw["countries"]["POL"][-1][1] + 25); yield f"Poland files {nxt} with +25 t", c
    c = copy.deepcopy(raw); drop_last(c, "USA", 8); yield "US stale (no report for 8 months)", c
    c = copy.deepcopy(raw); c["countries"] = {k: v for k, v in c["countries"].items() if k in big}; yield "only the 12 largest holders", c
    c = copy.deepcopy(raw)
    for code in list(c["countries"])[:20]:
        add_month(c, code, nxt, c["countries"][code][-1][1] - 3)
    yield f"20 holders report {nxt} with sales", c


def main():
    node = shutil.which("node")
    if not node:
        print("FAIL Node.js is needed to run the page's model (spike/gauge_js.mjs)")
        return 1
    raw = json.loads(DATA.read_text(encoding="utf-8"))
    failed = 0
    with tempfile.TemporaryDirectory() as tmp:
        for n, (title, data) in enumerate(cases(raw)):
            path = Path(tmp) / f"case{n}.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            js, py = js_gauge(node, path), py_gauge(data)
            ok = js == py
            failed += not ok
            print(f"  {'PASS' if ok else 'FAIL'}  {title}: {py['complete']} {py['word']} {py['r12']:+} t")
            if not ok:
                for k in sorted(set(js) | set(py)):
                    if js.get(k) != py.get(k):
                        print(f"        {k}: page {js.get(k)!r} vs changes.py {py.get(k)!r}")
    print("changes.py and app.js agree on every case." if not failed else f"{failed} case(s) disagree: fix changes.py or app.js so the alert matches the page.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
