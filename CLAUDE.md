# Gold Tracker

**Status (2026-11-08):** v1 live. Repo: https://github.com/Vasuki8/gold-tracker (public). Page: https://vasuki8.github.io/gold-tracker/ (GitHub Pages, branch `main`, root). The daily job ran for the first time by hand on 2026-11-08 and passed; the two-week reliability test is under way. Brainstorming continues in regular Claude chat, building happens here in Claude Code.
- Pushing from this machine works through Git Credential Manager. The `gh` CLI is not logged in, so repo settings and manual workflow runs go through the GitHub web UI (the built-in browser pane is signed in) or need `gh auth login` first.
- Commits by the workflow's `GITHUB_TOKEN` do trigger the Pages rebuild, so new data reaches the live page without extra steps.

## Layout
- `spike/fetch_irfcl.py`: gold volumes, fetch + clean, standard library only. `--out DIR` (the workflow uses `data/`), `--log FILE` (one CSV row per run).
- `spike/fetch_reserves.py` (added 2026-11-08): total official reserve assets (`IRFCLDT1_IRFCL65_USD`) and gold value (`IRFCLDT1_IRFCL56_USD`) in US dollars, one request (`+` joins the two indicators; `,` gets HTTP 403). Imports helpers from `fetch_irfcl.py`, same cleaning rules, needs `gold_tonnes.json` to derive the price. Separate script with its own log so the gold-volume request under the reliability test is unchanged.
- `.github/workflows/fetch-irfcl.yml`: daily at 06:23 UTC plus manual runs. Two fetch steps; each appends to its own log (`data/fetch_log.csv`, `data/fetch_log_reserves.csv`); each data file is committed only when its own step passed and the data changed; raw IMF CSVs kept as 30-day artifacts; any failed step fails the job so GitHub emails the owner.
- `data/gold_tonnes.json`, `data/reserves_usd.json`: committed data, no timestamps inside, so git history shows only real IMF revisions. The reserves file is one observation per line for readable diffs. The runner's output matched a local run byte for byte (Python 3.12 vs 3.14).
- `index.html`, `assets/app.js`, `assets/style.css`: the page. Plain JS drawing SVG, no build step, no libraries. Served from the repo root by GitHub Pages (`.nojekyll` skips Jekyll). Local preview: `python -m http.server 8765` in the repo root (opening the file directly can't load the JSON). The page still works if `reserves_usd.json` is missing (the reserves section and column hide).

## What it is
A personal project (the owner is the only user) that tracks gold accumulation and selling by central banks and large institutions. No audience, no monetization, no need to differentiate from existing sites (WGC Goldhub, Trading Economics).

**Purpose (owner, 2026-11-08):** one input among several for the owner's investment decisions in general, not only gold: track big gold transactions and their trend. Working assumption: that makes it a slow macro gauge, so monthly data is the right speed and daily sources (ETF holdings, price) drop in priority. Still open: which decisions it feeds (gold or miners exposure, a view on the dollar and US Treasuries, general risk appetite). That decides whether anything beyond IRFCL is needed.

## Key framing
Central bank gold trades are private, so individual transactions can't be seen. The product tracks *reported holdings* and how they change, with a delay. A large share of central bank buying is never reported (WGC: over 1,000 tonnes a year in 2022–24, much of it not traced to any country; in Q3 2026 central banks added a net 321 t, and about 63% of that activity was not disclosed at country level).

## Data sources (how often they update)
| Source | What it shows | How often |
|---|---|---|
| IMF IRFCL (replaced International Financial Statistics, now retired) | Official gold reserves for each country | Monthly, 1–2 months late |
| Central banks' own releases (China's PBoC, Poland's NBP, Turkey's CBRT…) | Their own holdings | Monthly or weekly, sooner than the IMF |
| World Gold Council (Goldhub) | Compiled stats, plus estimates of unreported buying | Monthly / quarterly |
| Gold ETF disclosures (GLD, IAU) | Tonnes held by each fund | Daily |
| CFTC Commitments of Traders | Futures positions | Weekly |
| COMEX and London (LBMA) vault data | Metal in exchange and London vaults | Daily / monthly |
| Customs data (Switzerland, UK, Hong Kong) | Physical shipments between countries | Monthly |
| SEC 13F | Funds' stakes in gold ETFs and miners | Quarterly, 45 days late |

## Scope in layers
- **v1 Ledger:** reserves for the top ~15 central banks, monthly change, leaderboard of buyers and sellers, chart for each country. **One data source only.** Updates itself, no manual steps.
- **v2 Daily movement:** GLD/IAU daily holdings, plus an alert to the owner (email or Telegram) when new central bank data lands.
- **v3 Detective work:** CFTC positioning; Swiss exports vs. China's reported reserves ("the gap").
- **Parked:** 13F, LBMA vaults, user accounts, anything real-time.
- **v1 page layout (confirmed by the owner 2026-11-08):** headline numbers first, because the tracker is one slow macro input: (1) reported net central bank buying, rolling 3 and 12 months, and whether it is speeding up or slowing; (2) who is buying (concentration: Poland and China lead in 2026); then the 12-month trend since 2000, monthly bars, buyers and sellers, the top-15 holders table, and one chart per holder. Still to do: (3) an alert when the direction flips. v2 daily ETF data drops in priority under the working assumption in Purpose.
- **v1 coverage (settled 2026-11-08):** top 15 holders *that report to IRFCL* (includes the ECB), Uzbekistan noted as missing. No second source.
- **Hosting (owner, 2026-11-08):** public GitHub repo + GitHub Pages.
- **Depth added (owner asked, 2026-11-08):** year-by-year totals with top buyers/sellers and context markers on the trend; emerging vs advanced economies and regions; momentum (streaks, started/stopped, regular buyers); gold as a share of reserves (world line, largest holders, implied price); one holder in depth (rank, streak, biggest months, yearly changes, gold share of its reserves). Page order: gauge, trend, years, months, who, groups, momentum, share of reserves, largest holders, one holder, method.

## How the page counts a month
- A holder's change in month m = its value at m minus its previous available value, looking back up to 3 months (so a dropped error value doesn't hide the move around it).
- Each active holder (reported within 6 months of the newest month) gets an *activity* weight: the sum of its absolute monthly changes over its own last 12 reported months. Month m enters the totals once holders with 90% of total activity have reported it. Weighting by holdings instead would let the US (26% of all gold, never changes, reports last) delay every total by months; by activity it weighs nothing, and Turkey (big swings) weighs a lot.
- Groups: advanced = IMF WEO advanced-economy list plus the ECB; everyone else emerging/developing. Regions are the page's own grouping (Russia and Turkey in Europe; Kazakhstan and Egypt in Middle East, N. Africa, Central Asia). Momentum: a purchase is a month up at least 0.1 t; "started again" = a purchase in the last 6 reported months after none in the 12 before; "stopped" = none in the last 6 after 3+ in the 12 before.
- Trend markers: two fixed (Sep 2019 CBGA expiry, Feb 2022 Bank of Russia reserves frozen) and two found in the data (Dec 2009, when the 12-month total turned positive for good; Nov 2022, China's first reported purchase in 38 months). The shaded band before Dec 2009 is the net-selling era.
- First run (data of 2026-11-08): totals complete through Aug 2026 (Sep 62% reported, because Turkey hadn't filed). +320 t net in the 12 months to Aug 2026, +308 t in the 12 months before; last 3 months +159 t, about +634 t a year, so "speeding up". Poland and China are 56% of gross reported buying.

## Architecture direction
- No server and no database. A scheduled GitHub Actions job fetches the data, commits JSON files, and rebuilds a static site (GitHub Pages or Cloudflare Pages).
- Git history records each revision of the data ("git scraping"). This matters because the IMF and central banks revise figures after publishing.
- The same scheduled job compares new data with the last commit and sends the alerts.
- Pick one unit (tonnes) and convert on arrival; 1 tonne ≈ 32,150.75 fine troy ounces.

## Gold share of reserves (findings 2026-11-08)
- **Reported gold values can't be used as they are.** The US reports its gold at the statutory $42.22/oz ($11,041 M for 261.5 M oz; its total reserves show as $252.7 bn); Saudi Arabia, Korea and Singapore use historical cost; Chile's value is ~44x market (probably a unit error on a tiny holding). The fetch script's US tripwire checks that $11,041 M figure.
- **The market price comes from the data itself:** the median US$/oz across holders with 1 t or more, for months with 10+ holders. It tracks the market (2000-12 $273, 2015-12 $1,062, 2024-12 $2,609, 2025-12 $4,313, 2026-02 $5,211 from 66 holders, 2026-07 $4,050). Every holder's gold is revalued at it, and the reported gold value inside total reserves is swapped for that market value. No second source needed.
- **The world line starts Jun 2015,** when China (the largest reserve holder) first appears; before that coverage of today's reserves is ~70% and adding China would show as a fake drop. It ends at the latest month with 90% of reserves reported (Jul 2026 on 2026-11-08). A holder missing a month inside the line keeps its last non-gold reserves and tonnage for up to 3 months (an Oct 2025 gap otherwise made a fake 4-point dip).
- Result: gold was 8.5% of reported reserves in Jul 2015, 21.2% in Jul 2025 and 24.8% in Jul 2026 (peak 29.2% in Feb 2026). The rise is mostly price: +23% in price vs +0.9% in reported tonnes over the last 12 months. Largest holders: Germany 82%, US 81%, China 9%, Poland 31% (its stated target is 30%).

## Rule of thumb
Every data source is something that can break. Limit scope by number of sources, not features. Don't add a second source until the first one runs end to end without manual steps.

## Riskiest assumption
That the v1 source (IMF API or WGC download) can be fetched reliably by a script.
**Status:** live fetches work from this machine and from GitHub's runners (2026-11-08). Reliability over weeks is being tested (see Next step).

## Next step
1. Two-week reliability test, 2026-11-08 to about 2026-11-22: the daily job (06:23 UTC) runs about 14 times; count `fail` / `crash` rows and `tries` > 1 in `data/fetch_log.csv`. One success doesn't prove reliability: the SDMX 2.1 URL another project used recently already fails, so the IMF API is still moving. Run 1 (manual, 2026-11-08 08:44 UTC): pass, HTTP 200, 1 try, 0.8 s, 2.77 MB, and it already picked up new IMF months that had appeared since the morning's fetch.
   The reserves fetch (added 2026-11-08, run 2 onward) has its own log, `data/fetch_log_reserves.csv`; count it separately.
2. After the test: the direction-flip alert (v1 item 3), from the same job.

## Spike findings (2026-11-08, first live run)
- **Endpoint.** IFS and the old `dataservices.imf.org` API are gone. Gold is IRFCL line 56, indicator `IRFCLDT1_IRFCL56V_FTO`, monthly. Only SDMX 3.0 works: `https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.STA/IRFCL/+/*.IRFCLDT1_IRFCL56V_FTO.*.M` with `Accept: application/vnd.sdmx.data+csv;version=2.0.0`. No API key. One request returns every country (2.8 MB, under 1 s). The SDMX 2.1 URL answers 403 / 404.
- **Units.** `OBS_VALUE` is fine troy ounces. `SCALE=6` on every row is a display hint, not a multiplier (US = 261,499,000 oz = 8,133.5 t). The script checks the US figure on every run as a tripwire.
- **Sector.** Use `S1XS1311` (monetary authorities + central government) only; every country has it for every month. The UK's gold is held by the Treasury (`S1311`), so a central-bank-only series shows the UK at 0 t.
- **Coverage.** 87 holders plus the euro-area aggregate (`G163`, skip it), 1999-12 to 2026-10. Present: US, Germany, Italy, France, China, Russia, Switzerland, India, Japan, Turkey, Poland, Netherlands, ECB (`EZB`), Portugal, Kazakhstan, Saudi Arabia, UK. Missing: Uzbekistan.
- **Ragged reporting.** Countries lag differently: in Nov 2026 most are at September, the US at July, the UK and Netherlands at October. The leaderboard must use each country's own latest month and show which month that is. Some series are stale (Brazil once its errors are dropped, Canada since 2019, New Zealand since 2024).
- **Unit errors in national submissions.** Angola (whole series) and Brazil (x1000 from 2026-03) report more gold than anyone holds. The script drops values above 9,000 t and month-on-month jumps of exactly x1000 or x1,000,000, and lists what it dropped. A "jump over 25%" rule was wrong: it flags real moves (Hungary x10 in Oct 2018; Norway and Canada selling to zero).
- **One-month dropouts.** Some submissions have a single month far off two neighbours that agree within 5%, e.g. Kazakhstan 2026-03 = 0 t between 347.6 t and 354.3 t, which would show as a fake 460 t sale and re-buy. The script drops these (15 values across 11 holders; all are zeros or spikes that snap back). Turkey's 2026-03 drop (822 → 694 → 732 t) doesn't snap back and is kept as real.
- **WGC.** Goldhub's country holdings table re-publishes the IMF figures, so it adds nothing as a second copy (only backfill for countries IRFCL lacks, such as Uzbekistan). Its quarterly Gold Demand Trends estimate of *total* central bank buying, including unreported purchases, is different: the only public measure of the undisclosed share. A candidate later source, quarterly.
- **Tooling.** Claude's sandboxes can't reach api.imf.org. Live runs happen on this machine or on GitHub's runners. `python spike/fetch_irfcl.py --raw spike/out/irfcl_gold_raw.csv` re-runs on the saved response without the network.

## Open questions
- Which investment decisions does this feed? Test: if reported central bank buying halved, what would the owner do differently? The tracker should show the number that would trigger that.
- What should this project teach the owner? (data pipelines / charts and design / the gold market itself / a particular language) That decides the tech stack. The spike is Python, standard library only.
