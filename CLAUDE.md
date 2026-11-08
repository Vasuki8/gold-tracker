# Gold Tracker

**Status (2026-11-08):** v1 live. Repo: https://github.com/Vasuki8/gold-tracker (public). Page: https://vasuki8.github.io/gold-tracker/ (GitHub Pages, branch `main`, root). The daily job ran for the first time by hand on 2026-11-08 and passed; the two-week reliability test is under way. Brainstorming continues in regular Claude chat, building happens here in Claude Code.
- Pushing from this machine works through Git Credential Manager. The `gh` CLI is not logged in, so repo settings and manual workflow runs go through the GitHub web UI (the built-in browser pane is signed in) or need `gh auth login` first.
- Commits by the workflow's `GITHUB_TOKEN` do trigger the Pages rebuild, so new data reaches the live page without extra steps.

## Layout
- `spike/fetch_irfcl.py`: fetch + clean, standard library only. `--out DIR` (the workflow uses `data/`), `--log FILE` (one CSV row per run).
- `.github/workflows/fetch-irfcl.yml`: daily at 06:23 UTC plus manual runs. Appends to `data/fetch_log.csv` every run (the reliability record); commits `data/gold_tonnes.json` only when the run passed and the data changed; keeps the raw IMF CSV as a 30-day artifact; a failed run fails the job so GitHub emails the owner.
- `data/gold_tonnes.json`: committed data, no timestamp inside, so git history shows only real IMF revisions. Seeded from the 2026-11-08 response.
- `index.html`, `assets/app.js`, `assets/style.css`: the page. Plain JS drawing SVG, no build step, no libraries. Served from the repo root by GitHub Pages (`.nojekyll` skips Jekyll). Local preview: `python -m http.server 8765` in the repo root (opening the file directly can't load the JSON).

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

## How the page counts a month
- A holder's change in month m = its value at m minus its previous available value, looking back up to 3 months (so a dropped error value doesn't hide the move around it).
- Each active holder (reported within 6 months of the newest month) gets an *activity* weight: the sum of its absolute monthly changes over its own last 12 reported months. Month m enters the totals once holders with 90% of total activity have reported it. Weighting by holdings instead would let the US (26% of all gold, never changes, reports last) delay every total by months; by activity it weighs nothing, and Turkey (big swings) weighs a lot.
- First run (data of 2026-11-08): totals complete through Aug 2026 (Sep 62% reported, because Turkey hadn't filed). +320 t net in the 12 months to Aug 2026, +308 t in the 12 months before; last 3 months +159 t, about +634 t a year, so "speeding up". Poland and China are 56% of gross reported buying.

## Architecture direction
- No server and no database. A scheduled GitHub Actions job fetches the data, commits JSON files, and rebuilds a static site (GitHub Pages or Cloudflare Pages).
- Git history records each revision of the data ("git scraping"). This matters because the IMF and central banks revise figures after publishing.
- The same scheduled job compares new data with the last commit and sends the alerts.
- Pick one unit (tonnes) and convert on arrival; 1 tonne ≈ 32,150.75 fine troy ounces.

## Rule of thumb
Every data source is something that can break. Limit scope by number of sources, not features. Don't add a second source until the first one runs end to end without manual steps.

## Riskiest assumption
That the v1 source (IMF API or WGC download) can be fetched reliably by a script.
**Status:** live fetches work from this machine and from GitHub's runners (2026-11-08). Reliability over weeks is being tested (see Next step).

## Next step
1. Two-week reliability test, 2026-11-08 to about 2026-11-22: the daily job (06:23 UTC) runs about 14 times; count `fail` / `crash` rows and `tries` > 1 in `data/fetch_log.csv`. One success doesn't prove reliability: the SDMX 2.1 URL another project used recently already fails, so the IMF API is still moving. Run 1 (manual, 2026-11-08 08:44 UTC): pass, HTTP 200, 1 try, 0.8 s, 2.77 MB, and it already picked up new IMF months that had appeared since the morning's fetch.
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
