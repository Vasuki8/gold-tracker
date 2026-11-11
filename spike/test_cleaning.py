#!/usr/bin/env python3
"""
Do the cleaning rules in spike/fetch_irfcl.py do what they say, and only that?

Synthetic series for each rule (a x1,000 slip that is repaired, a tiny holder's x1,000 jump that is
dropped, a Kosovo-like holder whose gold is worth more than all its reserves, the US, whose book
value keeps it, a one-month dropout), then the committed data/gold_tonnes.json: cleaning it again
must change nothing (--reclean on the committed file is a no-op).

    python spike/test_cleaning.py            # exit 0 = every check passed

Standard library only.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "spike"))
import fetch_irfcl as F  # noqa: E402

OZ = F.OZ_PER_TONNE


def months(start, n):
    y, m = map(int, start.split("-"))
    out = []
    for k in range(n):
        t = y * 12 + m - 1 + k
        out.append(f"{t // 12}-{t % 12 + 1:02d}")
    return out


def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{f': {detail}' if detail and not ok else ''}")
    return ok


def main():
    results = []
    ms = months("2025-10", 13)
    # Brazil: Feb figure, then the same figure in kilograms for eight months.
    bra = {m: 172.446344 for m in ms[:5]} | {m: 172446.344 for m in ms[5:]}
    # A tiny holder buying from 0.005 t to 5 t: x1,000, but from under 1 t, so not repaired.
    tiny = {ms[0]: 0.005, ms[1]: 5.0, ms[2]: 5.0}
    # Back to the right unit after a slip: the first correct month must be kept.
    back = {ms[0]: 100.0, ms[1]: 100000.0, ms[2]: 100.0}
    # Kosovo: new series, 160 t, no gold value of its own, $1.8 bn of reserves.
    kos = {"2026-08": 160.006, "2026-09": 146.336}
    # The US: gold worth more than its total reserves at market, but it reports a book value.
    usa = {m: 8133.46 for m in ms}
    # A one-month dropout to zero between two figures that agree.
    kaz = {ms[0]: 347.6, ms[1]: 0.0, ms[2]: 354.3}
    series = {"BRA": bra, "TNY": tiny, "BCK": back, "KOS": kos, "USA": usa, "KAZ": kaz}
    price = {m: 4200.0 for m in ms}
    totals = {"KOS": {m: (None, 1800.0) for m in ms},
              "USA": {m: (8133.46 * OZ * 42.2222 / 1e6, 255000.0) for m in ms}}
    rejected, repaired = F.screen(series, (price, totals))
    rep = dict((m, (v, u)) for m, v, u, _ in repaired.get("BRA", []))
    results.append(check("Brazil's x1,000 months are repaired, not dropped",
                         len(rep) == 8 and all(abs(u - 172.446344) < 1e-6 for _, u in rep.values()) and "BRA" not in rejected,
                         f"repaired {len(rep)}, rejected {rejected.get('BRA')}"))
    results.append(check("Brazil keeps a figure for every month", len(series["BRA"]) == 13))
    results.append(check("a tiny holder's x1,000 jump is dropped for one month only",
                         [m for m, _, _ in rejected.get("TNY", [])] == [ms[1]] and ms[2] in series["TNY"], str(rejected.get("TNY"))))
    results.append(check("the first month back in the right unit is kept",
                         "BCK" not in rejected and series["BCK"].get(ms[2]) == 100.0 and abs(series["BCK"][ms[1]] - 100.0) < 1e-9,
                         f"{rejected.get('BCK')} {series.get('BCK')}"))
    results.append(check("Kosovo's gold worth more than its reserves is dropped, whole series",
                         "KOS" not in series and len(rejected.get("KOS", [])) == 2, str(rejected.get("KOS"))))
    results.append(check("the US keeps its gold (its own valuation explains it)", "USA" not in rejected and len(series["USA"]) == 13))
    results.append(check("a one-month dropout is dropped", [m for m, _, _ in rejected.get("KAZ", [])] == [ms[1]]))
    s2 = {"KOS": {"2026-08": 160.006, "2026-09": 146.336}}  # fresh: screen() emptied `kos` in place
    rj2, _ = F.screen(s2, None)
    results.append(check("without reserves figures the total-reserves check is skipped", "KOS" in s2 and not rj2))

    # The committed file: cleaning it again changes nothing.
    path = ROOT / "data" / "gold_tonnes.json"
    written = json.loads(path.read_text(encoding="utf-8"))
    series = F.restore(written)
    rejected, repaired = F.screen(series, F.load_reserves(ROOT / "data" / "reserves_usd.json"))
    same_c = {c: [[m, round(v, 3)] for m, v in sorted(s.items())] for c, s in sorted(series.items()) if c not in F.AGGREGATES} == written["countries"]
    same_r = sorted((c, m) for c, items in rejected.items() for m, _, _ in items) == sorted((c, x[0]) for c, items in written["rejected"].items() for x in items)
    same_p = sorted((c, m) for c, items in repaired.items() for m, *_ in items) == sorted((c, x[0]) for c, items in written.get("repaired", {}).items() for x in items)
    results.append(check("re-cleaning the committed data changes no figure", same_c))
    results.append(check("re-cleaning drops and repairs the same months", same_r and same_p))
    print("Every cleaning check passed." if all(results) else f"{results.count(False)} check(s) failed.")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
