"use strict";
/* Central bank gold tracker. Reads data/gold_tonnes.json, data/reserves_usd.json and
   data/changes.json (written daily by the scripts in spike/) and draws everything client-side:
   no build step, no libraries. The Funds panel is the exception: it loads GLD and CFTC data in
   the browser, straight from those sources (both allow it), so none of it is stored in the repo.
   Mine production: the USGS figures are in data/production_usgs.json (written monthly by
   spike/fetch_production.py); the history comes from Our World in Data, loaded by the browser. */

const DATA_URL = "data/gold_tonnes.json";
const RESERVES_URL = "data/reserves_usd.json";
const CHANGES_URL = "data/changes.json";
const PRODUCTION_URL = "data/production_usgs.json";
const JOURNAL_URL = "data/journal.json"; // the owner's trigger level and notes, edited by hand
const TIC_URL = "data/treasuries_tic.json"; // foreign official holdings of US Treasuries (monthly job)
const COFER_URL = "data/cofer_shares.json"; // currency shares of world FX reserves (monthly job)
const WGC_URL = "data/wgc_central_banks.json"; // WGC estimate of all central bank buying, typed in by hand
const CFTC_FILE = "data/cftc_gold.json"; // COMEX positions committed by the weekly job; the API below is the fallback
// Our World in Data: gold mine production in tonnes, by country, 1900 onward (USGS plus British
// Geological Survey figures). An indicator id: a new OWID dataset version may move it.
const OWID_PROD = "https://api.ourworldindata.org/v1/indicators/1131111";
const GLD_URL = "https://api.spdrgoldshares.com/api/v1/historical-archive?product=gld&exchange=NYSE&lang=en";
const CFTC_URL = `https://publicreporting.cftc.gov/resource/72hh-3qpy.json?${new URLSearchParams({
  $select: "report_date_as_yyyy_mm_dd,open_interest_all,m_money_positions_long_all,m_money_positions_short_all,"
    + "swap_positions_long_all,swap__positions_short_all,prod_merc_positions_long,prod_merc_positions_short",
  $where: "cftc_contract_market_code='088691'", // COMEX gold
  $order: "report_date_as_yyyy_mm_dd",
  $limit: "5000",
})}`;
const COVERAGE_MIN = 0.9; // a month counts once holders with 90% of the past year's activity have filed it
const STALE_MONTHS = 6; // nothing reported this long before the newest month: stale, left out of coverage
const BRIDGE_MONTHS = 3; // a change may span up to 3 missing months (dropped or unreported values)
const TOP_N = 15;
const BUY_T = 0.1; // a month with an increase of at least 0.1 t counts as a purchase
const BREADTH_T = 1; // a holder is "adding" when its 12-month change is at least +1 t ("reducing": -1 t)
const OZ_PER_TONNE = 32150.7466;
const CONTRACT_T = 100 / OZ_PER_TONNE; // one COMEX gold contract is 100 troy ounces
const DAY_MS = 86400000;

const NAMES = {
  ALB: "Albania", ARG: "Argentina", ARM: "Armenia", AUS: "Australia", AUT: "Austria", BEL: "Belgium",
  BGR: "Bulgaria", BLR: "Belarus", BOL: "Bolivia", BRA: "Brazil", CAN: "Canada", CHE: "Switzerland",
  CHL: "Chile", CHN: "China", COL: "Colombia", CRI: "Costa Rica", CYP: "Cyprus", CZE: "Czechia",
  DEU: "Germany", DNK: "Denmark", DOM: "Dominican Republic", ECU: "Ecuador", EGY: "Egypt", ESP: "Spain",
  EST: "Estonia", EZB: "ECB", FIN: "Finland", FRA: "France", GBR: "United Kingdom", GEO: "Georgia",
  GRC: "Greece", GTM: "Guatemala", HKG: "Hong Kong SAR", HND: "Honduras", HRV: "Croatia", HUN: "Hungary",
  IDN: "Indonesia", IND: "India", IRL: "Ireland", ISL: "Iceland", ITA: "Italy", JAM: "Jamaica",
  JOR: "Jordan", JPN: "Japan", KAZ: "Kazakhstan", KGZ: "Kyrgyz Republic", KHM: "Cambodia",
  KOR: "South Korea", KOS: "Kosovo", LKA: "Sri Lanka", LTU: "Lithuania", LUX: "Luxembourg", LVA: "Latvia",
  MAR: "Morocco", MDA: "Moldova", MEX: "Mexico", MKD: "North Macedonia", MLT: "Malta", MNG: "Mongolia",
  MUS: "Mauritius", MYS: "Malaysia", NIC: "Nicaragua", NLD: "Netherlands", NOR: "Norway",
  NZL: "New Zealand", PER: "Peru", PHL: "Philippines", POL: "Poland", PRT: "Portugal", PRY: "Paraguay",
  ROU: "Romania", RUS: "Russia", SAU: "Saudi Arabia", SGP: "Singapore", SLV: "El Salvador", SRB: "Serbia",
  SVK: "Slovakia", SVN: "Slovenia", SWE: "Sweden", THA: "Thailand", TUN: "Tunisia", TUR: "Turkey",
  UKR: "Ukraine", URY: "Uruguay", USA: "United States", WBG: "West Bank and Gaza", ZAF: "South Africa",
  AGO: "Angola", UZB: "Uzbekistan", GHA: "Ghana", G163: "Euro area",
};
const nameOf = (code) => NAMES[code] || code;

// IMF World Economic Outlook "advanced economies" (plus the ECB); everyone else is emerging/developing.
const ADVANCED = new Set(("AUS AUT BEL CAN CHE CYP CZE DEU DNK ESP EST EZB FIN FRA GBR GRC HKG HRV IRL ISL "
  + "ITA JPN KOR LTU LUX LVA MLT NLD NOR NZL PRT SGP SVK SVN SWE USA").split(" "));
const GROUPS = [
  { key: "emd", name: "Emerging and developing", cls: "" },
  { key: "adv", name: "Advanced economies", cls: "s2" },
];
const groupOf = (code) => (ADVANCED.has(code) ? "adv" : "emd");
// This page's own regional grouping, close to the IMF's departments.
const REGIONS = {
  Europe: "ALB AUT BEL BGR BLR CHE CYP CZE DEU DNK ESP EST EZB FIN FRA GBR GRC HRV HUN IRL ISL ITA KOS LTU LUX LVA MDA MKD MLT NLD NOR POL PRT ROU RUS SRB SVK SVN SWE TUR UKR",
  "Asia and Pacific": "AUS CHN HKG IDN IND JPN KHM KOR LKA MNG MYS NZL PHL SGP THA",
  "Middle East, N. Africa, Central Asia": "ARM EGY GEO JOR KAZ KGZ MAR SAU TUN WBG",
  Americas: "ARG BOL BRA CAN CHL COL CRI DOM ECU GTM HND JAM MEX NIC PER PRY SLV URY USA",
  "Sub-Saharan Africa": "AGO MUS ZAF",
};
const REGION_OF = Object.fromEntries(Object.entries(REGIONS).flatMap(([r, codes]) => codes.split(" ").map((c) => [c, r])));

// Fixed context markers for the trend chart. Two more are found in the data (see buildModel).
const EVENTS = [
  { k: "2019-09", text: "the Central Bank Gold Agreements expire. Since 1999 they had capped European central banks' gold sales." },
  { k: "2022-02", text: "sanctions freeze the Bank of Russia's foreign reserves." },
];

/* ---------- Months and numbers ---------- */

const idx = (k) => { const [y, m] = k.split("-").map(Number); return y * 12 + m - 1; };
const yearOf = (i) => Math.floor(i / 12);
const asDate = (i) => new Date(Date.UTC(yearOf(i), i % 12, 1));
const SHORT = new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" });
const MONTH_ONLY = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" });
const mLabel = (i) => SHORT.format(asDate(i));
const mRange = (a, b) => (yearOf(a) === yearOf(b)
  ? `${MONTH_ONLY.format(asDate(a))} – ${mLabel(b)}` : `${mLabel(a)} – ${mLabel(b)}`);

const NF0 = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
const NF1 = new Intl.NumberFormat("en", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const MINUS = "−";
const mag = (v) => (Math.abs(v) >= 100 ? NF0 : NF1).format(Math.abs(v));
const isZero = (v) => /^0(\.0)?$/.test(mag(v));
const tonnes = (v) => `${v < 0 && !isZero(v) ? MINUS : ""}${mag(v)} t`;
const signed = (v) => `${isZero(v) ? "" : v > 0 ? "+" : MINUS}${mag(v)} t`;
const pct = (v) => `${Math.round(v * 100) < 0 ? MINUS : ""}${Math.abs(Math.round(v * 100))}%`;
const pct1 = (v) => `${v < 0 ? MINUS : ""}${Math.abs(v * 100).toFixed(1)}%`;
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`;
const pts = (v) => `${v >= 0 ? "+" : MINUS}${Math.abs(v * 100).toFixed(1)} pts`;
const usd = (v) => `$${NF0.format(v)}`;
const usdMn = (mn) => (mn >= 1e6 ? `$${(mn / 1e6).toFixed(2)} tn` : mn >= 1e3 ? `$${NF0.format(mn / 1e3)} bn` : `$${NF0.format(mn)} M`);
const tickText = (v) => `${v < 0 ? MINUS : ""}${NF0.format(Math.abs(v))}`;
const pctTick = (v) => `${v < 0 ? MINUS : ""}${Math.abs(Math.round(v * 100))}%`;
const usdTick = (v) => `$${NF0.format(v)}`;
const tnTick = (mn) => (mn === 0 ? "0" : `$${(mn / 1e6).toLocaleString("en", { maximumFractionDigits: 1 })} tn`);
const count = (v) => NF0.format(v);
const signedCount = (v) => `${v > 0 ? "+" : v < 0 ? MINUS : ""}${NF0.format(Math.abs(v))}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// Days: daily and weekly series sit on the same month axis as everything else, as a fractional
// month index (15 Mar 2026 -> March 2026 + 14/31).
const DAY = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const dayIdx = (t) => {
  const d = new Date(t), y = d.getUTCFullYear(), mo = d.getUTCMonth();
  return y * 12 + mo + (d.getUTCDate() - 1) / new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
};
// Up/down tone for text: green/red, and never color alone (always a sign or an arrow).
const tone = (v, eps = 0.05) => (v > eps ? "pos" : v < -eps ? "neg" : null);
const arrow = (v, eps = 0.05) => (v > eps ? "▲" : v < -eps ? "▼" : "●");

/* ---------- DOM helpers (text always goes in as text nodes, never as HTML) ---------- */

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}
const SVGNS = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, v);
  for (const k of kids.flat()) if (k !== null && k !== undefined) e.append(k);
  return e;
}
const $ = (id) => document.getElementById(id);
const sv = (v) => h("span", { class: tone(v) }, signed(v));
const delta = (v, text, eps = 0.05) => h("span", { class: tone(v, eps) }, `${arrow(v, eps)} ${text}`);
// replaceChildren() would turn a null into the text "null", so optional pieces are filtered out first.
const put = (id, ...kids) => $(id).replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));

// The view lives in the query string (?holder=POL&range=10&cmp=POL,CHN,IND&cmode=change), so a
// link reopens the same view. Defaults are left out; replaceState, so Back isn't flooded.
const params = new URLSearchParams(location.search);
function setParam(k, v) {
  if (v === null || v === undefined || v === "" || v === 0 || v === "0") params.delete(k); else params.set(k, v);
  const q = params.toString().replace(/%2C/gi, ","); // readable lists: cmp=POL,CHN
  history.replaceState(null, "", `${location.pathname}${q ? `?${q}` : ""}${location.hash}`);
}
// A segmented control: press the button matching `value`, call onPick(value) on clicks.
function wireSeg(id, value, onPick) {
  const box = $(id);
  const press = (v) => { for (const b of box.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.v === String(v))); };
  press(value);
  box.addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    press(b.dataset.v);
    onPick(b.dataset.v);
  });
}

/* ---------- The gold model ---------- */

function buildModel(raw) {
  const holders = Object.entries(raw.countries).map(([code, rows]) => {
    const series = new Map(rows.map(([k, v]) => [idx(k), v]));
    const ms = [...series.keys()].sort((a, b) => a - b);
    return { code, name: nameOf(code), s: series, first: ms[0], last: ms.at(-1) };
  });
  const newest = Math.max(...holders.map((d) => d.last));
  const first = Math.min(...holders.map((d) => d.first));

  // Latest value at or before month i, looking back over at most BRIDGE_MONTHS gaps.
  const valueAt = (d, i) => {
    for (let j = i; j >= i - BRIDGE_MONTHS; j--) if (d.s.has(j)) return d.s.get(j);
    return undefined;
  };
  // Change attributed to month i: this month's value minus the previous available one.
  const change = (d, i) => {
    if (!d.s.has(i)) return undefined;
    for (let j = i - 1; j >= i - BRIDGE_MONTHS - 1; j--) if (d.s.has(j)) return d.s.get(i) - d.s.get(j);
    return undefined;
  };
  const sumOver = (d, a, b) => {
    let v = 0, any = false;
    for (let i = a; i <= b; i++) { const c = change(d, i); if (c !== undefined) { v += c; any = true; } }
    return any ? v : undefined;
  };

  for (const d of holders) {
    d.latest = d.s.get(d.last);
    d.d1 = change(d, d.last);
    const yearAgo = valueAt(d, d.last - 12);
    d.d12 = yearAgo === undefined ? undefined : d.latest - yearAgo;
    d.stale = newest - d.last > STALE_MONTHS;
    d.activity = 0; // how much this holder moved over its own last 12 reported months
    for (let i = d.last - 11; i <= d.last; i++) d.activity += Math.abs(change(d, i) ?? 0);
  }
  const active = holders.filter((d) => !d.stale);
  const totalActivity = active.reduce((a, d) => a + d.activity, 0);

  const months = new Map();
  for (let i = first + 1; i <= newest; i++) {
    let net = 0;
    const contrib = [];
    const group = { adv: 0, emd: 0 };
    for (const d of holders) {
      const c = change(d, i);
      if (c === undefined) continue;
      net += c;
      group[groupOf(d.code)] += c;
      if (Math.abs(c) >= 0.05) contrib.push({ d, c });
    }
    contrib.sort((a, b) => Math.abs(b.c) - Math.abs(a.c));
    const covered = active.reduce((a, d) => a + (d.s.has(i) ? d.activity : 0), 0);
    months.set(i, { i, net, group, contrib, coverage: totalActivity ? covered / totalActivity : 1 });
  }
  let complete = newest;
  while (complete > first + 12 && months.get(complete).coverage < COVERAGE_MIN) complete--;

  const sumNet = (a, b) => { let t = 0; for (let i = a; i <= b; i++) t += months.get(i)?.net ?? 0; return t; };
  const rolling12 = [];
  const groupRolling = { adv: [], emd: [] };
  for (let i = first + 12; i <= complete; i++) {
    rolling12.push({ i, v: sumNet(i - 11, i) });
    for (const g of GROUPS) {
      let t = 0;
      for (let j = i - 11; j <= i; j++) t += months.get(j).group[g.key];
      groupRolling[g.key].push({ i, v: t });
    }
  }

  const win = { from: complete - 11, to: complete };
  const byCountry = holders.map((d) => { const v = sumOver(d, win.from, win.to); return v === undefined ? null : { d, v }; })
    .filter(Boolean);
  const regions = new Map(Object.keys(REGIONS).map((r) => [r, 0]));
  for (const x of byCountry) { const r = REGION_OF[x.d.code] || "Other"; regions.set(r, (regions.get(r) || 0) + x.v); }

  const years = [];
  for (let y = yearOf(first + 1); y <= yearOf(complete); y++) {
    const a = Math.max(y * 12, first + 1), b = Math.min(y * 12 + 11, complete);
    if (a > b) continue;
    const per = holders.map((d) => ({ d, v: sumOver(d, a, b) }))
      .filter((x) => x.v !== undefined && Math.abs(x.v) >= 0.05).sort((p, q) => q.v - p.v);
    years.push({ i: y, a, b, v: sumNet(a, b), partial: b - a < 11, per });
  }

  // Momentum, each holder measured at its own latest month.
  const count = (d, a, b) => {
    let buys = 0, sells = 0;
    for (let i = a; i <= b; i++) {
      const c = change(d, i);
      if (c === undefined) continue;
      if (c >= BUY_T) buys++; else if (c <= -BUY_T) sells++;
    }
    return { buys, sells };
  };
  for (const d of holders) {
    let streak = 0;
    for (let i = d.last; i >= d.first; i--) { const c = change(d, i); if (c !== undefined && c >= BUY_T) streak++; else break; }
    d.streak = streak;
    ({ buys: d.buys12, sells: d.sells12 } = count(d, d.last - 11, d.last));
    d.lastBuy = undefined;
    for (let i = d.last; i >= d.first; i--) { const c = change(d, i); if (c !== undefined && c >= BUY_T) { d.lastBuy = i; break; } }
    const recent = count(d, d.last - 5, d.last), before = count(d, d.last - 17, d.last - 6);
    d.started = !d.stale && recent.buys > 0 && before.buys === 0 && d.first <= d.last - 17;
    d.stopped = !d.stale && recent.buys === 0 && before.buys >= 3;
    d.maxBuy = null; d.maxSell = null;
    for (const i of d.s.keys()) {
      const c = change(d, i);
      if (c === undefined) continue;
      if (!d.maxBuy || c > d.maxBuy.c) d.maxBuy = { i, c };
      if (!d.maxSell || c < d.maxSell.c) d.maxSell = { i, c };
    }
    d.peak = [...d.s.entries()].reduce((a, [i, v]) => (v >= a.v ? { i, v } : a), { i: d.first, v: -1 });
  }

  // World reported total, carrying each holder's last value forward.
  const worldTotal = new Map();
  const lastSeen = new Map();
  for (let i = first; i <= newest; i++) {
    let t = 0;
    for (const d of holders) {
      if (d.s.has(i)) lastSeen.set(d.code, d.s.get(i));
      t += lastSeen.get(d.code) ?? 0;
    }
    worldTotal.set(i, t);
  }

  // Data-found markers: when net buying took hold, and China's return to reported buying.
  const turnIdx = rolling12.findIndex((p, k) => p.v > 0 && rolling12.slice(k, k + 24).every((q) => q.v > 0));
  const marks = EVENTS.map((e) => ({ i: idx(e.k), text: `${mLabel(idx(e.k))}: ${e.text}` }));
  if (turnIdx >= 0) {
    const t = rolling12[turnIdx].i;
    marks.push({ i: t, text: `${mLabel(t)}: the 12-month total turns positive, and has stayed positive since.`, turn: true });
  }
  const chn = holders.find((d) => d.code === "CHN");
  if (chn) {
    const buys = [...chn.s.keys()].sort((a, b) => a - b).filter((i) => (change(chn, i) ?? 0) >= BUY_T);
    for (let k = buys.length - 1; k > 0; k--) {
      const gap = buys[k] - buys[k - 1];
      if (gap > 24) { marks.push({ i: buys[k], text: `${mLabel(buys[k])}: China reports its first purchase in ${gap} months.` }); break; }
    }
  }
  marks.sort((a, b) => a.i - b.i).forEach((mk, k) => { mk.n = k + 1; });

  // Breadth and concentration at each complete month: how many holders added (or cut) at least
  // BREADTH_T over the 12 months to it, and how much of the gross buying the top two did.
  const breadth = [];
  for (let i = first + 12; i <= complete; i++) {
    let buyers = 0, sellers = 0, gross = 0;
    const pos = [];
    for (const d of holders) {
      const v = sumOver(d, i - 11, i);
      if (v === undefined) continue;
      if (v >= BREADTH_T) buyers++; else if (v <= -BREADTH_T) sellers++;
      if (v > 0) { gross += v; pos.push({ d, v }); }
    }
    pos.sort((a, b) => b.v - a.v);
    const top = pos.slice(0, 2);
    breadth.push({ i, buyers, sellers, gross, top, share: gross ? top.reduce((a, x) => a + x.v, 0) / gross : 0 });
  }

  return { raw, holders, newest, first, complete, months, rolling12, groupRolling, win, byCountry, regions, years,
    worldTotal, marks, breadth, turn: turnIdx >= 0 ? rolling12[turnIdx].i : null, sumNet, valueAt, change };
}

/* ---------- The reserves model (US dollars) ---------- */

function buildReserves(rr, m) {
  if (!rr || !rr.price || !rr.countries) return null;
  const price = new Map(rr.price.map(([k, p, n]) => [idx(k), { p, n }]));
  const byCode = new Map(m.holders.map((d) => [d.code, d]));
  const list = [];
  for (const [code, rows] of Object.entries(rr.countries)) {
    const d = byCode.get(code);
    const s = new Map();
    for (const [k, g, t] of rows) {
      const i = idx(k), pr = price.get(i);
      if (t === null || !pr) continue;
      const tn = d ? d.s.get(i) : 0;
      if (tn === undefined) continue; // a gold holder with no volume this month
      if (tn > 0 && g === null) continue; // can't take out a gold value that isn't there
      const goldMkt = (tn * OZ_PER_TONNE * pr.p) / 1e6; // US$ millions at the month's implied price
      const totalAdj = t - (g || 0) + goldMkt;
      if (totalAdj <= 0 || goldMkt > totalAdj) continue;
      s.set(i, { goldMkt, totalAdj, share: goldMkt / totalAdj, rep: g, tn, price: pr.p });
    }
    if (s.size) {
      const ks = [...s.keys()];
      list.push({ code, name: nameOf(code), s, first: Math.min(...ks), last: Math.max(...ks) });
    }
  }
  if (!list.length) return null;
  const newest = Math.max(...list.map((x) => x.last));
  const active = list.filter((x) => newest - x.last <= STALE_MONTHS);
  const weight = new Map(active.map((x) => [x.code, x.s.get(x.last).totalAdj]));
  const totalW = [...weight.values()].reduce((a, b) => a + b, 0);
  const firstI = Math.min(...list.map((x) => x.first));
  const world = [];
  for (let i = firstI; i <= newest; i++) {
    let g = 0, t = 0, w = 0;
    const pr = price.get(i)?.p;
    for (const x of list) {
      let e = x.s.get(i);
      if (e) {
        w += weight.get(x.code) || 0; // coverage counts real reports only
      } else if (pr) {
        // A holder missing this month keeps its last non-gold reserves and gold tonnage for up to
        // BRIDGE_MONTHS, with the gold at this month's price; otherwise one gap (Oct 2025: a
        // gold-heavy holder missing) shows as a fake 4-point dip.
        let prev;
        for (let j = i - 1; j >= i - BRIDGE_MONTHS && !prev; j--) prev = x.s.get(j);
        if (!prev) continue;
        const goldMkt = (prev.tn * OZ_PER_TONNE * pr) / 1e6;
        e = { goldMkt, totalAdj: prev.totalAdj - prev.goldMkt + goldMkt };
      } else continue;
      g += e.goldMkt; t += e.totalAdj;
    }
    if (t > 0) world.push({ i, v: g / t, gold: g, total: t, coverage: totalW ? w / totalW : 0, price: pr });
  }
  // The world line starts once today's reporters cover 90% of reserves (China joins in 2015),
  // and ends at the latest month that is 90% reported.
  const start = world.findIndex((p) => p.coverage >= COVERAGE_MIN);
  let end = world.length - 1;
  while (end > start && world[end].coverage < COVERAGE_MIN) end--;
  const worldSeries = start < 0 ? [] : world.slice(start, end + 1);
  const complete = worldSeries.length ? worldSeries.at(-1).i : newest;

  for (const x of list) {
    const e = x.s.get(x.last);
    x.latest = e;
    x.revalued = e.tn >= 1 && e.rep !== null && Math.abs((e.rep * 1e6) / (e.tn * OZ_PER_TONNE) / e.price - 1) > 0.1;
  }
  return { list, byCode: new Map(list.map((x) => [x.code, x])), worldSeries, complete,
    price: rr.price.map(([k, p, n]) => ({ i: idx(k), v: p, n })) };
}

/* ---------- Chart plumbing ---------- */

function niceTicks(lo, hi, count) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const raw = (hi - lo) / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
  const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = a; v <= b + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { lo: a, hi: b, ticks };
}

// Renders on mount and again whenever the container's width changes. Redrawing into the same
// container (another holder, another range) retires the previous chart's observer first, or the
// old chart would keep redrawing itself on every resize.
function mountChart(container, draw) {
  container.chartObserver?.disconnect();
  container.replaceChildren();
  const tip = h("div", { class: "tt", hidden: true, "aria-hidden": "true" });
  container.append(tip);
  let lastW = 0;
  const render = () => {
    const w = Math.round(container.clientWidth);
    if (!w || w === lastW) return;
    lastW = w;
    container.querySelector("svg")?.remove();
    tip.hidden = true;
    container.prepend(draw(w, tip));
  };
  container.chartObserver = new ResizeObserver(() => requestAnimationFrame(render));
  container.chartObserver.observe(container);
  render();
}

function fillTip(tip, title, rows) {
  tip.replaceChildren(
    h("div", { class: "tt-title" }, title),
    ...rows.map((r) => (r === "sep" ? h("div", { class: "tt-sep" })
      : h("div", { class: `tt-row${r.note ? " tt-note" : ""}` }, // note: a sentence that may wrap
        r.key ? h("span", { class: `tt-key ${r.key}` }) : null,
        h("strong", {}, r.value),
        r.label ? h("span", { class: "tt-label" }, r.label) : null))),
  );
}

function placeTip(tip, container, x, y) {
  tip.hidden = false;
  const cw = container.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = x + 14;
  if (left + tw > cw) left = x - 14 - tw;
  if (left < 0) left = Math.max(0, Math.min(cw - tw, x - tw / 2));
  let top = y - th - 10;
  if (top < 0) top = y + 14;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

// Pointer and keyboard both move one "current item"; the pointer only has to be nearest.
function hoverLayer(svg, { positions, axis = "x", show, hide }) {
  svg.setAttribute("tabindex", "0");
  let cur = -1;
  const nearest = (p) => {
    let best = 0;
    for (let k = 1; k < positions.length; k++) if (Math.abs(positions[k] - p) < Math.abs(positions[best] - p)) best = k;
    return best;
  };
  const go = (k) => { cur = Math.max(0, Math.min(positions.length - 1, k)); show(cur); };
  svg.addEventListener("pointermove", (ev) => {
    const r = svg.getBoundingClientRect();
    go(nearest(axis === "x" ? ev.clientX - r.left : ev.clientY - r.top));
  });
  svg.addEventListener("pointerleave", () => { if (document.activeElement === svg) show(cur); else hide(); });
  svg.addEventListener("focus", () => go(cur < 0 ? (axis === "x" ? positions.length - 1 : 0) : cur));
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", (ev) => {
    const back = axis === "x" ? ["ArrowLeft", "ArrowUp"] : ["ArrowUp", "ArrowLeft"];
    const fwd = axis === "x" ? ["ArrowRight", "ArrowDown"] : ["ArrowDown", "ArrowRight"];
    if (back.includes(ev.key)) go(cur - 1);
    else if (fwd.includes(ev.key)) go(cur + 1);
    else if (ev.key === "Home") go(0);
    else if (ev.key === "End") go(positions.length - 1);
    else if (ev.key === "Escape") { hide(); return; }
    else return;
    ev.preventDefault();
  });
}

function yGrid(svg, yt, Y, left, right, fmt = tickText) {
  for (const v of yt.ticks) {
    svg.append(
      s("line", { x1: left, x2: right, y1: Y(v), y2: Y(v), class: v === 0 ? "baseline" : "gridline" }),
      s("text", { x: left - 8, y: Y(v), class: "tick", "text-anchor": "end", "dominant-baseline": "middle" }, fmt(v)),
    );
  }
}

function yearAxis(svg, x0, x1, X, y, centerOffset = 0) {
  if (x1 - x0 < 30) {
    // A year or two of daily data: label months (every 1, 3 or 6), with the year on January.
    const perMonth = Math.abs(X(1) - X(0));
    const every = [1, 3, 6, 12].find((n) => perMonth * n >= 44) || 12;
    for (let i = Math.ceil(x0); i <= x1; i++) {
      if (i % every) continue;
      svg.append(s("text", { x: X(i) + centerOffset, y: y + 18, class: "tick", "text-anchor": "middle" },
        i % 12 === 0 ? String(yearOf(i)) : MONTH_ONLY.format(asDate(i))));
    }
    return;
  }
  const years = [];
  for (let yr = yearOf(x0); yr <= yearOf(x1); yr++) if (yr * 12 >= x0 && yr * 12 <= x1) years.push(yr);
  if (!years.length) return;
  const perYear = Math.abs(X(12) - X(0));
  const every = [1, 2, 5, 10, 20, 50].find((n) => perYear * n >= 44) || 50; // 1900 onward on a phone: every 50
  for (const yr of years) {
    if (yr % every) continue;
    svg.append(s("text", { x: X(yr * 12) + centerOffset, y: y + 18, class: "tick", "text-anchor": "middle" }, String(yr)));
  }
}

// Rounded 4px data end, square at the baseline.
function vbarPath(x, y0, y1, w, r = 4) {
  const ht = Math.abs(y1 - y0);
  if (ht < 0.5) return "";
  r = Math.min(r, w / 2, ht);
  const e = y1 < y0 ? r : -r;
  return `M${x},${y0}V${y1 + e}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + e}V${y0}Z`;
}
function hbarPath(x0, x1, y, ht, r = 4) {
  const w = Math.abs(x1 - x0);
  if (w < 0.5) return "";
  r = Math.min(r, ht / 2, w);
  const e = x1 > x0 ? -r : r;
  return `M${x0},${y}H${x1 + e}Q${x1},${y} ${x1},${y + r}V${y + ht - r}Q${x1},${y + ht} ${x1 + e},${y + ht}H${x0}Z`;
}

/* ---------- Chart types ---------- */

function lineChart(container, opts) {
  const { points, label, height = 280, endLabel, tipRows, tipTitle = (p) => mLabel(p.i), fmtTick = tickText,
    cls = "", bands = [], marks = [], rules = [], flags = [], yMax, domain, zero = true } = opts;
  mountChart(container, (W, tip) => {
    const narrow = W < 520;
    const M = { t: marks.length ? 30 : 14, r: endLabel ? (narrow ? 60 : 72) : 16, b: 30, l: 52 };
    const pw = W - M.l - M.r, ph = height - M.t - M.b;
    // domain: a fixed x range, so charts stacked under each other line up month for month.
    const [x0, x1] = domain || [points[0].i, points.at(-1).i];
    const X = (i) => M.l + (x1 === x0 ? pw / 2 : ((i - x0) / (x1 - x0)) * pw);
    // zero: false lets a level series (a fund's tonnes) fill the height. Fine for a line, which is
    // read by its shape; bars always start at zero.
    const vs = [...points.map((p) => p.v), ...rules.map((r) => r.v)]; // a reference line must stay in view
    const yt = zero ? niceTicks(Math.min(0, ...vs), Math.max(0, ...vs, yMax ?? -Infinity), narrow ? 4 : 5)
      : niceTicks(Math.min(...vs), Math.max(...vs), narrow ? 4 : 5);
    const Y = (v) => M.t + ph - ((v - yt.lo) / (yt.hi - yt.lo)) * ph;
    const floor = Math.min(Math.max(0, yt.lo), yt.hi); // where the area under the line closes
    const svg = s("svg", { width: W, height, viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": label });
    for (const b of bands) {
      const bx0 = X(Math.max(b.from, x0)), bx1 = X(Math.min(b.to, x1));
      svg.append(s("rect", { x: bx0, y: M.t, width: Math.max(0, bx1 - bx0), height: ph, class: "band" }));
      if (b.label && bx1 - bx0 > 150) svg.append(s("text", { x: bx0 + 8, y: M.t + ph - 10, class: "band-label" }, b.label));
    }
    yGrid(svg, yt, Y, M.l, M.l + pw, fmtTick);
    yearAxis(svg, x0, x1, (i) => X(i), M.t + ph);
    // Reference lines (the owner's trigger level): a dashed hairline, labelled at the right.
    for (const r of rules) {
      if (r.v < yt.lo || r.v > yt.hi) continue;
      svg.append(s("line", { x1: M.l, x2: M.l + pw, y1: Y(r.v), y2: Y(r.v), class: "rule" }));
      if (r.label) svg.append(s("text", { x: M.l + pw - 4, y: Y(r.v) - 5, class: "rule-label", "text-anchor": "end" }, r.label));
    }
    // Numbered markers: a hairline at the month, a numbered circle above the plot. Circles that
    // would overlap slide right and keep a short leader back to their month.
    let prevCx = -Infinity;
    for (const mk of marks) {
      if (mk.i < x0 || mk.i > x1) continue;
      const x = X(mk.i), cy = 12;
      const cx = Math.max(x, prevCx + 18);
      prevCx = cx;
      svg.append(s("line", { x1: x, x2: x, y1: M.t - 4, y2: M.t + ph, class: "marker-line" }));
      if (cx !== x) svg.append(s("line", { x1: x, x2: cx, y1: M.t - 4, y2: cy + 7, class: "marker-line" }));
      svg.append(
        s("circle", { cx, cy, r: 8, class: "marker-dot" }),
        s("text", { x: cx, y: cy + 0.5, class: "marker-num", "text-anchor": "middle", "dominant-baseline": "middle" }, String(mk.n)),
      );
    }
    const d = points.map((p, k) => `${k ? "L" : "M"}${X(p.i).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
    svg.append(
      s("path", { d: `${d}L${X(points.at(-1).i).toFixed(1)},${Y(floor)}L${X(points[0].i).toFixed(1)},${Y(floor)}Z`, class: `area ${cls}` }),
      s("path", { d, class: `line ${cls}` }),
    );
    const last = points.at(-1);
    svg.append(s("circle", { cx: X(last.i), cy: Y(last.v), r: 4, class: `dot ${cls}` }));
    // Journal flags: a hollow diamond on the line at the entry's month.
    for (const f of flags) {
      if (f.i < x0 || f.i > x1) continue;
      const p = points.find((q) => q.i === f.i) || points.findLast((q) => q.i <= f.i);
      if (!p) continue;
      const x = X(p.i), y = Y(p.v);
      svg.append(s("path", { d: `M${x},${y - 8}L${x + 7},${y}L${x},${y + 8}L${x - 7},${y}Z`, class: "flag" }));
    }
    if (endLabel) {
      svg.append(s("text", { x: X(last.i) + 9, y: Y(last.v), class: "end-label", "dominant-baseline": "middle" }, endLabel(last)));
    }
    const cross = s("line", { y1: M.t, y2: M.t + ph, class: "cross", visibility: "hidden" });
    const hot = s("circle", { r: 4, class: `dot ${cls}`, visibility: "hidden" });
    svg.append(cross, hot);
    hoverLayer(svg, {
      positions: points.map((p) => X(p.i)),
      show(k) {
        const p = points[k], x = X(p.i), y = Y(p.v);
        cross.setAttribute("x1", x); cross.setAttribute("x2", x);
        hot.setAttribute("cx", x); hot.setAttribute("cy", y);
        cross.setAttribute("visibility", "visible"); hot.setAttribute("visibility", "visible");
        fillTip(tip, tipTitle(p), tipRows(p));
        placeTip(tip, container, x, y);
      },
      hide() {
        cross.setAttribute("visibility", "hidden"); hot.setAttribute("visibility", "hidden");
        tip.hidden = true;
      },
    });
    return svg;
  });
}

// Two or three series on one axis, one shared crosshair; the tooltip lists every series. Every
// series has a point for every x (same i, same order); v === null is a gap (not reported).
const has = (v) => v !== null && v !== undefined;
function multiLineChart(container, { series, label, height = 280, fmt = signed, fmtTick = tickText, tipExtra,
  tipTitle = (p) => mLabel(p.i) }) {
  mountChart(container, (W, tip) => {
    const narrow = W < 520;
    const M = { t: 14, r: narrow ? 60 : 72, b: 30, l: 52 };
    const pw = W - M.l - M.r, ph = height - M.t - M.b;
    const base = series[0].points;
    const x0 = base[0].i, x1 = base.at(-1).i;
    const X = (i) => M.l + ((i - x0) / ((x1 - x0) || 1)) * pw;
    const vs = series.flatMap((sr) => sr.points.map((p) => p.v)).filter(has);
    const yt = niceTicks(Math.min(0, ...vs), Math.max(0, ...vs), narrow ? 4 : 5);
    const Y = (v) => M.t + ph - ((v - yt.lo) / (yt.hi - yt.lo)) * ph;
    const svg = s("svg", { width: W, height, viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": label });
    yGrid(svg, yt, Y, M.l, M.l + pw, fmtTick);
    yearAxis(svg, x0, x1, (i) => X(i), M.t + ph);
    const ends = [];
    for (const sr of series) {
      let d = "", pen = false;
      for (const p of sr.points) {
        if (!has(p.v)) { pen = false; continue; }
        d += `${pen ? "L" : "M"}${X(p.i).toFixed(1)},${Y(p.v).toFixed(1)}`;
        pen = true;
      }
      svg.append(s("path", { d, class: `line ${sr.cls}` }));
      const last = sr.points.findLast((p) => has(p.v));
      if (!last) continue;
      svg.append(s("circle", { cx: X(last.i), cy: Y(last.v), r: 4, class: `dot ${sr.cls}` }));
      ends.push({ y: Y(last.v), text: fmt(last.v), x: X(last.i) });
    }
    // Direct end labels only when they don't collide; the legend and tooltip carry identity anyway.
    const clash = ends.some((a, k) => ends.some((b, j) => j > k && Math.abs(a.y - b.y) < 14 && Math.abs(a.x - b.x) < 70));
    if (!clash) for (const e of ends) svg.append(s("text", { x: e.x + 9, y: e.y, class: "end-label", "dominant-baseline": "middle" }, e.text));
    const cross = s("line", { y1: M.t, y2: M.t + ph, class: "cross", visibility: "hidden" });
    const hots = series.map((sr) => s("circle", { r: 4, class: `dot ${sr.cls}`, visibility: "hidden" }));
    svg.append(cross, ...hots);
    hoverLayer(svg, {
      positions: base.map((p) => X(p.i)),
      show(k) {
        const x = X(base[k].i);
        cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("visibility", "visible");
        const ys = [];
        series.forEach((sr, j) => {
          const p = sr.points[k];
          if (!has(p.v)) { hots[j].setAttribute("visibility", "hidden"); return; }
          ys.push(Y(p.v));
          hots[j].setAttribute("cx", x); hots[j].setAttribute("cy", Y(p.v)); hots[j].setAttribute("visibility", "visible");
        });
        fillTip(tip, tipTitle(base[k]), [
          ...series.map((sr) => ({ value: has(sr.points[k].v) ? fmt(sr.points[k].v) : "–", label: sr.name, key: sr.cls || "line" })),
          ...(tipExtra ? tipExtra(k) : []),
        ]);
        placeTip(tip, container, x, ys.length ? Math.min(...ys) : M.t);
      },
      hide() {
        cross.setAttribute("visibility", "hidden"); hots.forEach((c) => c.setAttribute("visibility", "hidden"));
        tip.hidden = true;
      },
    });
    return svg;
  });
}

function columnChart(container, { bars, label, height = 240, tipRows, tipTitle = (b) => mLabel(b.i), axis = "months", fmtTick = tickText }) {
  mountChart(container, (W, tip) => {
    const M = { t: 14, r: 8, b: 30, l: 52 };
    const pw = W - M.l - M.r, ph = height - M.t - M.b;
    const band = pw / bars.length;
    const bw = Math.max(2, Math.min(24, band - 2)); // at least a 2px surface gap between bars
    const vs = bars.map((b) => b.v);
    const yt = niceTicks(Math.min(0, ...vs), Math.max(0, ...vs), 4);
    const Y = (v) => M.t + ph - ((v - yt.lo) / (yt.hi - yt.lo)) * ph;
    const svg = s("svg", { width: W, height, viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": label });
    yGrid(svg, yt, Y, M.l, M.l + pw, fmtTick);
    const bx = (k) => M.l + band * k;
    if (axis === "years") {
      const every = [1, 2, 5, 10].find((n) => band * n >= 40) || 10;
      bars.forEach((b, k) => {
        if (b.i % every === 0 || k === bars.length - 1 && bars.length < 4) {
          svg.append(s("text", { x: bx(k) + band / 2, y: M.t + ph + 18, class: "tick", "text-anchor": "middle" }, String(b.i)));
        }
      });
    } else if (axis === "labels") {
      const every = band >= 26 ? 1 : 2; // each bar carries its own label (calendar months)
      bars.forEach((b, k) => {
        if (k % every === 0) svg.append(s("text", { x: bx(k) + band / 2, y: M.t + ph + 18, class: "tick", "text-anchor": "middle" }, b.label));
      });
    } else {
      const i0 = bars[0].i;
      yearAxis(svg, i0, bars.at(-1).i, (i) => bx(i - i0), M.t + ph, band / 2);
    }
    const marks = bars.map((b, k) => {
      const p = s("path", {
        d: vbarPath(bx(k) + (band - bw) / 2, Y(0), Y(b.v), bw),
        class: `bar ${b.v >= 0 ? "buy" : "sell"}${b.faded ? " faded" : ""}`,
      });
      svg.append(p);
      return p;
    });
    svg.append(s("line", { x1: M.l, x2: M.l + pw, y1: Y(0), y2: Y(0), class: "baseline" }));
    let on = null;
    hoverLayer(svg, {
      positions: bars.map((_, k) => bx(k) + band / 2),
      show(k) {
        on?.classList.remove("on");
        on = marks[k]; on.classList.add("on");
        const b = bars[k];
        fillTip(tip, tipTitle(b), tipRows(b));
        placeTip(tip, container, bx(k) + band / 2, Math.min(Y(b.v), Y(0)));
      },
      hide() { on?.classList.remove("on"); on = null; tip.hidden = true; },
    });
    return svg;
  });
}

function hbarChart(container, { rows, label, tipRows, splitAt, fmt = signed, neutral = false }) {
  mountChart(container, (W, tip) => {
    const narrow = W < 520;
    const rowH = 30, bh = 16, gap = splitAt ? 14 : 0;
    const longest = Math.max(...rows.map((r) => r.name.length));
    const labelW = Math.min(narrow ? Math.max(120, W * 0.4) : 240, Math.max(narrow ? 90 : 120, longest * 6.8 + 16)), valW = 62;
    const vs = rows.map((r) => r.v);
    const lo = Math.min(0, ...vs), hi = Math.max(0, ...vs);
    const left = labelW + (lo < 0 ? valW : 6), right = W - (hi > 0 ? valW : 6);
    const X = (v) => left + ((v - lo) / (hi - lo || 1)) * (right - left);
    const rowY = (k) => 4 + k * rowH + (splitAt && k >= splitAt ? gap : 0);
    const height = rowY(rows.length) + 4;
    const svg = s("svg", { width: W, height, viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": label });
    const fits = (t) => t.length * 6.8 <= labelW - 12; // rough width of 13px system-ui text
    const marks = rows.map((r, k) => {
      const y = rowY(k);
      const words = r.name.split(" ");
      if (fits(r.name) || words.length < 2) {
        svg.append(s("text", { x: labelW - 10, y: y + rowH / 2, class: "row-label", "text-anchor": "end", "dominant-baseline": "middle" }, r.name));
      } else {
        // Too long for the label column: break at the space nearest the middle, two lines.
        let cut = 1;
        for (let j = 1; j < words.length; j++) {
          if (Math.abs(words.slice(0, j).join(" ").length - r.name.length / 2) < Math.abs(words.slice(0, cut).join(" ").length - r.name.length / 2)) cut = j;
        }
        svg.append(s("text", { x: labelW - 10, y: y + rowH / 2, class: "row-label small", "text-anchor": "end" },
          s("tspan", { x: labelW - 10, dy: "-0.25em" }, words.slice(0, cut).join(" ")),
          s("tspan", { x: labelW - 10, dy: "1.15em" }, words.slice(cut).join(" "))));
      }
      const pos = r.v >= 0;
      const p = s("path", { d: hbarPath(X(0), X(r.v), y + (rowH - bh) / 2, bh), class: `bar ${neutral ? "neutral" : pos ? "buy" : "sell"}` });
      svg.append(p, s("text", {
        x: X(r.v) + (pos ? 6 : -6), y: y + rowH / 2, class: "value-label",
        "text-anchor": pos ? "start" : "end", "dominant-baseline": "middle",
      }, fmt(r.v)));
      return p;
    });
    svg.append(s("line", { x1: X(0), x2: X(0), y1: 2, y2: height - 2, class: "baseline" }));
    let on = null;
    hoverLayer(svg, {
      axis: "y",
      positions: rows.map((_, k) => rowY(k) + rowH / 2),
      show(k) {
        on?.classList.remove("on");
        on = marks[k]; on.classList.add("on");
        fillTip(tip, rows[k].name, tipRows(rows[k]));
        placeTip(tip, container, Math.max(X(rows[k].v), X(0)), rowY(k));
      },
      hide() { on?.classList.remove("on"); on = null; tip.hidden = true; },
    });
    return svg;
  });
}

// Dots on two numeric axes. The pointer picks the nearest dot within 28px (not the nearest
// column, as in the other charts), so a cloud of months reads one month at a time.
function scatterChart(container, { points, label, height = 300, fmtX = pctTick, fmtY = tickText, xLabel, yLabel, cls = () => "", tipTitle, tipRows }) {
  mountChart(container, (W, tip) => {
    const narrow = W < 520;
    const M = { t: 14, r: 16, b: 40, l: 52 };
    const pw = W - M.l - M.r, ph = height - M.t - M.b;
    const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
    const xt = niceTicks(Math.min(0, ...xs), Math.max(0, ...xs), narrow ? 4 : 6);
    const yt = niceTicks(Math.min(0, ...ys), Math.max(0, ...ys), narrow ? 4 : 5);
    const X = (v) => M.l + ((v - xt.lo) / (xt.hi - xt.lo)) * pw;
    const Y = (v) => M.t + ph - ((v - yt.lo) / (yt.hi - yt.lo)) * ph;
    const svg = s("svg", { width: W, height, viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": label });
    yGrid(svg, yt, Y, M.l, M.l + pw, fmtY);
    for (const v of xt.ticks) {
      svg.append(s("line", { x1: X(v), x2: X(v), y1: M.t, y2: M.t + ph, class: v === 0 ? "baseline" : "gridline" }),
        s("text", { x: X(v), y: M.t + ph + 18, class: "tick", "text-anchor": "middle" }, fmtX(v)));
    }
    if (xLabel) svg.append(s("text", { x: M.l + pw, y: M.t + ph + 34, class: "tick", "text-anchor": "end" }, xLabel));
    if (yLabel) svg.append(s("text", { x: M.l + 6, y: M.t + 4, class: "tick" }, yLabel));
    const dots = points.map((p) => {
      const d = s("circle", { cx: X(p.x), cy: Y(p.y), r: 4, class: `dot ${cls(p)}` });
      svg.append(d);
      return d;
    });
    let on = null;
    const hide = () => { on?.setAttribute("r", 4); on = null; tip.hidden = true; };
    svg.addEventListener("pointermove", (ev) => {
      const r = svg.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
      let best = -1, bd = 28 * 28;
      points.forEach((p, k) => { const d = (X(p.x) - mx) ** 2 + (Y(p.y) - my) ** 2; if (d < bd) { bd = d; best = k; } });
      if (best < 0) { hide(); return; }
      on?.setAttribute("r", 4);
      on = dots[best]; on.setAttribute("r", 6);
      fillTip(tip, tipTitle(points[best]), tipRows(points[best]));
      placeTip(tip, container, X(points[best].x), Y(points[best].y));
    });
    svg.addEventListener("pointerleave", hide);
    return svg;
  });
}

function sparkline(values, w = 96, ht = 24, cls = "") {
  let lo = Math.min(...values), hi = Math.max(...values);
  // Never stretch less than 5% of the level (or 10 t) over the full height: a 0.2 t revision
  // on 1,040 t must look flat, not like a cliff.
  const minSpan = Math.max(0.05 * Math.max(Math.abs(hi), Math.abs(lo)), 10);
  if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
  const X = (k) => 2 + (k / Math.max(1, values.length - 1)) * (w - 6);
  const Y = (v) => (hi === lo ? ht / 2 : 3 + (1 - (v - lo) / (hi - lo)) * (ht - 6));
  const d = values.map((v, k) => `${k ? "L" : "M"}${X(k).toFixed(1)},${Y(v).toFixed(1)}`).join("");
  return s("svg", { class: `spark ${cls}`, width: w, height: ht, viewBox: `0 0 ${w} ${ht}`, "aria-hidden": "true" },
    s("path", { d, class: "spark-line" }),
    s("circle", { cx: X(values.length - 1), cy: Y(values.at(-1)), r: 3, class: "spark-dot" }));
}

let tableSeq = 0;
function table(caption, head, rows, { scroll = false } = {}) {
  const id = `tbl-${++tableSeq}`;
  return h("div", { class: `table-wrap${scroll ? " scroll" : ""}`, tabindex: "0", role: "region", "aria-labelledby": id },
    h("table", {},
      h("caption", { id }, caption),
      h("thead", {}, h("tr", {}, head.map((c, k) => h("th", { scope: "col", class: k === 0 ? "l" : null }, c)))),
      h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c, k) => (k === 0
        ? h("th", { scope: "row", class: "l" }, c) : h("td", {}, c))))))));
}
const tableDetails = (summary, tbl) => h("details", { class: "data-table" }, h("summary", {}, summary), tbl, csvButton(tbl));

// A table as CSV. Numbers come out bare ("+1,234.5 t" -> 1234.5, "−3" -> -3) with the unit moved
// into the header, so the file opens as numbers in a spreadsheet; everything else stays text.
const NUM_CELL = /^([+−-]?)(\$?)([\d,]+(?:\.\d+)?)\s*(t|%|\/oz)?$/;
function tableCSV(tbl) {
  const rows = [...tbl.querySelectorAll("tr")].map((tr) => [...tr.children].map((c) => c.textContent.replace(/\s+/g, " ").trim()));
  const [head, ...body] = rows;
  const units = head.map((_, j) => {
    const us = new Set();
    for (const r of body) { const mt = NUM_CELL.exec(r[j] || ""); if (mt) us.add(mt[2] ? "US$" : mt[4] || ""); }
    return us.size === 1 ? [...us][0] : null;
  });
  const keep = head.map((_, j) => body.some((r) => r[j])); // drop columns with no text (sparklines)
  const cell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const out = [head.map((t, j) => (units[j] ? `${t} (${units[j]})` : t))];
  for (const r of body) {
    out.push(r.map((v, j) => {
      const mt = units[j] !== null ? NUM_CELL.exec(v) : null;
      return mt ? `${mt[1] === "+" || !mt[1] ? "" : "-"}${mt[3].replace(/,/g, "")}` : v;
    }));
  }
  return out.map((r) => r.filter((_, j) => keep[j]).map(cell).join(",")).join("\r\n");
}
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);
function downloadCSV(tbl) {
  const name = `gold-${slug(tbl.caption?.textContent || "table")}.csv`;
  const url = URL.createObjectURL(new Blob(["﻿", tableCSV(tbl)], { type: "text/csv;charset=utf-8" }));
  const a = h("a", { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function csvButton(wrap) {
  return h("button", { type: "button", class: "csv-btn", onclick: () => downloadCSV(wrap.querySelector("table")) }, "Download CSV");
}

/* ---------- Sections ---------- */

function renderFreshness(m) {
  const reportersNewest = m.holders.filter((d) => d.last === m.newest).length;
  const pending = [];
  for (let i = m.complete + 1; i <= m.newest; i++) pending.push(`${mLabel(i)} ${pct(m.months.get(i).coverage)}`);
  $("freshness").textContent = `Newest IMF month: ${mLabel(m.newest)} (${reportersNewest} of ${m.holders.length} holders so far). `
    + `Totals complete through ${mLabel(m.complete)}`
    + (pending.length ? `; still being reported: ${pending.join(", ")}.` : ".");
}

function trendWord(r12, pace) {
  const tol = Math.max(0.15 * Math.abs(r12), 20);
  const diff = pace - r12;
  if (Math.abs(diff) <= tol) return { icon: "●", text: r12 >= 0 ? "Steady pace" : "Selling at a steady pace" };
  if (r12 >= 0) return diff > 0 ? { icon: "▲", text: "Speeding up" } : { icon: "▼", text: "Slowing" };
  return diff < 0 ? { icon: "▼", text: "Selling faster" } : { icon: "▲", text: "Selling slower" };
}

function shareYearAgo(r) {
  const now = r.worldSeries.at(-1);
  const then = r.worldSeries.find((p) => p.i === now.i - 12);
  return { now, then };
}

function headline(m) {
  const c = m.complete;
  const r12 = m.sumNet(c - 11, c), prev12 = m.sumNet(c - 23, c - 12);
  const r3 = m.sumNet(c - 2, c);
  const buyers = m.byCountry.filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
  const sellers = m.byCountry.filter((x) => x.v < 0).sort((a, b) => a.v - b.v);
  const gross = buyers.reduce((a, x) => a + x.v, 0);
  const top2 = buyers.slice(0, 2);
  return { c, r12, prev12, r3, pace: r3 * 4, buyers, sellers, top2,
    share: gross ? top2.reduce((a, x) => a + x.v, 0) / gross : 0 };
}

function renderTicker(m, r) {
  const k = headline(m);
  const dot = () => h("span", { class: "sep", "aria-hidden": "true" }, "·");
  const parts = [
    h("span", {}, "Reported net buying ", h("strong", {}, signed(k.r12)), ` in the 12 months to ${mLabel(k.c)} `,
      delta(k.r12 - k.prev12, signed(k.r12 - k.prev12)), " vs prior"),
  ];
  if (r && r.worldSeries.length) {
    const { now } = shareYearAgo(r);
    parts.push(dot(), h("span", {}, "Gold ", h("strong", {}, pct1(now.v)), " of reserves"));
    if (now.price) parts.push(dot(), h("span", {}, h("strong", {}, usd(now.price)), `/oz (${mLabel(now.i)})`));
  }
  parts.push(dot(), h("span", {}, `Newest IMF month ${mLabel(m.newest)}`));
  put("ticker", parts);
}

function renderHero(m) {
  const k = headline(m);
  const d = k.r12 - k.prev12;
  put("hero",
    h("div", {},
      h("p", { class: "hero-label" }, "Net reported buying · last 12 months"),
      h("p", { class: "hero-value" }, signed(k.r12)),
      h("p", { class: "hero-asof" }, `As of ${mLabel(k.c)} · ${m.holders.length} holders · IMF IRFCL`),
      h("p", { class: "hero-sub" }, `${mRange(k.c - 11, k.c)} · prior 12 months ${signed(k.prev12)} · newest IMF month ${mLabel(m.newest)}`)),
    h("div", { class: "hero-aside" },
      h("span", { class: `pill ${d >= 0 ? "up" : "down"}` }, `${d >= 0 ? "▲" : "▼"} ${signed(d)}`, h("span", { class: "vs" }, "vs prior 12 months")),
      sparkline(m.rolling12.slice(-60).map((p) => p.v), 260, 64, k.r12 >= 0 ? "up" : "down")));
}

function stat(label, value, subs = [], cls = null) {
  return h("div", { class: "stat" },
    h("p", { class: "stat-label" }, label),
    h("p", { class: `stat-value${cls ? ` ${cls}` : ""}` }, value),
    ...subs.filter(Boolean).map((x) => h("p", { class: "stat-sub" }, x)));
}
const group = (title, ...stats) => h("div", { class: "stat-group", "data-group": title }, h("h3", { class: "stat-group-title" }, title), ...stats.filter(Boolean));

function breadthStat(m) {
  const now = m.breadth.at(-1), then = m.breadth.find((p) => p.i === now.i - 12);
  return stat("Holders adding gold", `${now.buyers} vs ${now.sellers} cutting`, [`at least ${BREADTH_T} t over 12 months`,
    then ? delta(now.buyers - then.buyers, `${signedCount(now.buyers - then.buyers)} adding vs a year earlier`, 0.5) : null]);
}

function renderStatGroups(m, r, log) {
  const k = headline(m);
  const word = trendWord(k.r12, k.pace);
  const last = m.months.get(k.c);
  const netMonths = [];
  for (let i = k.c - 11; i <= k.c; i++) netMonths.push(m.months.get(i).net);
  const buyingMonths = netMonths.filter((v) => v > 0.05).length;
  const regular = m.holders.filter((d) => !d.stale && d.buys12 >= 3).length;
  const groups = [
    group("Pace",
      stat("Last 3 months", signed(k.r3), [mRange(k.c - 2, k.c), delta(k.pace - k.r12, `${word.text} · ${signed(k.pace)} a year`, Math.max(0.15 * Math.abs(k.r12), 20))], tone(k.r3)),
      stat(`${mLabel(k.c)}`, signed(last.net), [`Biggest: ${last.contrib.slice(0, 2).map(({ d, c }) => `${d.name} ${signed(c)}`).join(", ")}`], tone(last.net)),
      stat("Months of net buying", `${buyingMonths} of 12`, [`Net selling in ${12 - buyingMonths}`]),
      triggerStat(k)),
    group("Who",
      stat("Top two share", pct(k.share), [`of gross reported buying: ${k.top2.map((x) => x.d.name).join(" and ")}`,
        h("div", { class: "meter", role: "img", "aria-label": `${pct(k.share)} share` }, h("span", { style: `width:${(k.share * 100).toFixed(1)}%` }))]),
      k.buyers[0] ? stat("Top buyer", k.buyers[0].d.name, [h("span", {}, sv(k.buyers[0].v), " over 12 months")]) : null,
      k.sellers[0] ? stat("Biggest seller", k.sellers[0].d.name, [h("span", {}, sv(k.sellers[0].v), " over 12 months")]) : null,
      stat("Regular buyers", String(regular), ["bought in 3+ of their last 12 months"]),
      breadthStat(m)),
  ];
  if (r && r.worldSeries.length) {
    const { now, then } = shareYearAgo(r);
    groups.push(group("Reserves",
      stat("Gold share of reserves", pct1(now.v), [mLabel(now.i), then ? delta(now.v - then.v, `${pts(now.v - then.v)} y/y`, 0.0005) : null]),
      now.price ? stat("Implied gold price", `${usd(now.price)}/oz`, ["median across reporting holders",
        then?.price ? delta(now.price / then.price - 1, `${pct(Math.abs(now.price / then.price - 1))} y/y`, 0.005) : null]) : null,
      stat("Gold at market value", usdMn(now.gold), [`of ${usdMn(now.total)} reported reserves`])));
  }
  const pending = [];
  for (let i = m.complete + 1; i <= m.newest; i++) pending.push(`${MONTH_ONLY.format(asDate(i))} ${pct(m.months.get(i).coverage)}`);
  const runs = log || [];
  const passed = runs.filter((x) => x.result === "pass").length;
  const lastRun = runs.at(-1);
  groups.push(group("Data",
    stat("Totals complete through", mLabel(m.complete), [pending.length ? `Still reporting: ${pending.join(", ")}` : "All months reported"]),
    runs.length ? stat("Daily checks", `${passed} of ${runs.length} passed`, [`Last: ${lastRun.run_at_utc.replace("T", " ").replace("Z", " UTC")}, ${lastRun.result}`], passed === runs.length ? "pos" : "neg") : null,
    stat("Holders", String(m.holders.length), [`${m.holders.filter((d) => d.stale).length} stale · newest month ${mLabel(m.newest)}`])));
  put("stat-groups", groups);
}

function renderRolling(m, r, years = 0) {
  const all = m.rolling12;
  const pts12 = years ? all.filter((p) => p.i > all.at(-1).i - years * 12) : all;
  renderTrendPrice(m, r, pts12[0].i, pts12.at(-1).i);
  lineChart($("chart-rolling"), {
    points: pts12,
    label: `Line chart of 12-month net reported central bank gold buying, ${mLabel(pts12[0].i)} to ${mLabel(pts12.at(-1).i)}. Latest ${signed(pts12.at(-1).v)}.`,
    endLabel: (p) => signed(p.v),
    bands: m.turn ? [{ from: pts12[0].i, to: m.turn, label: "Net selling, led by European central banks" }] : [],
    marks: m.marks,
    rules: Number.isFinite(JOURNAL?.trigger?.t) ? [{ v: JOURNAL.trigger.t, label: `Your trigger ${signed(JOURNAL.trigger.t)}` }] : [],
    flags: journalEntries(),
    tipRows: (p) => [
      { value: signed(p.v), label: "12-month net", key: "line" },
      { value: signed(m.months.get(p.i).net), label: "that month" },
      ...journalEntries().filter((e) => e.i === p.i).flatMap((e) => ["sep", { value: "◆", label: e.text, note: true }]),
    ],
  });
  const shown = m.marks.filter((mk) => mk.i >= pts12[0].i);
  const flagged = journalEntries().filter((e) => e.i >= pts12[0].i && e.i <= pts12.at(-1).i).length;
  put("marks-key", shown.map((mk) => h("li", {}, h("span", { class: "n", "aria-hidden": "true" }, String(mk.n)), h("span", {}, mk.text))),
    Number.isFinite(JOURNAL?.trigger?.t) ? h("li", {}, h("span", { class: "n key-rule", "aria-hidden": "true" }), h("span", {},
      `Dashed line: your trigger, ${signed(JOURNAL.trigger.t)} over 12 months`, flagged ? `; ◆ ${plural(flagged, "journal entry", "journal entries")}` : "", " (", h("a", { href: "#journal" }, "Journal"), ").")) : null);
  const yearly = all.filter((p) => p.i % 12 === 11 || p.i === all.at(-1).i).reverse();
  $("table-rolling").replaceChildren(tableDetails("Show as a table",
    table("12-month net reported buying, at each December and the latest month", ["Month", "12-month net"],
      yearly.map((p) => [mLabel(p.i), sv(p.v)]), { scroll: true })));
}

// The implied gold price under the trend, over exactly the same months, so the two read as one
// picture without a second y-axis on the same chart.
function renderTrendPrice(m, r, x0, x1) {
  const box = $("trend-price");
  const pp = r ? r.price.filter((p) => p.i >= x0 && p.i <= x1) : [];
  box.hidden = pp.length < 2;
  if (box.hidden) return;
  const r12 = new Map(m.rolling12.map((p) => [p.i, p.v]));
  lineChart($("chart-trend-price"), {
    points: pp,
    domain: [x0, x1],
    height: 170,
    cls: "s2",
    fmtTick: usdTick,
    endLabel: (p) => usd(p.v),
    label: `Line chart of the gold price implied by IMF data, ${mLabel(pp[0].i)} to ${mLabel(pp.at(-1).i)}, on the same months as the trend above.`,
    tipRows: (p) => [{ value: usd(p.v), label: "per ounce", key: "s2" },
      ...(r12.has(p.i) ? [{ value: signed(r12.get(p.i)), label: "12-month net buying", key: "line" }] : [])],
  });
}

function wireTrendRange(m, r) {
  const years = [0, 5, 10].includes(Number(params.get("range"))) ? Number(params.get("range")) : 0;
  if (years) renderRolling(m, r, years);
  wireSeg("trend-range", years, (v) => { renderRolling(m, r, Number(v)); setParam("range", v); });
}

// Highlight the header tab of the section in view, and keep it visible in the scrolling tab row.
function scrollSpy() {
  const nav = document.querySelector(".tabs");
  const links = [...nav.querySelectorAll("a")];
  const byId = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const a = byId.get(e.target.id);
      if (!a) continue;
      for (const x of links) x.removeAttribute("aria-current");
      a.setAttribute("aria-current", "true");
      // offsetLeft is measured from the sticky header, so subtract the tab row's own offset.
      nav.scrollTo({ left: a.offsetLeft - nav.offsetLeft - nav.clientWidth / 2 + a.clientWidth / 2, behavior: "auto" });
    }
  }, { rootMargin: "-80px 0px -65% 0px" });
  for (const id of byId.keys()) { const sec = $(id); if (sec) io.observe(sec); }
}

function yearTitle(y) { return y.partial ? `${y.i} (${mRange(y.a, y.b)}, so far)` : String(y.i); }

function renderYears(m) {
  const ys = m.years;
  const last = ys.at(-1);
  const best = ys.filter((y) => !y.partial).reduce((a, y) => (y.v > a.v ? y : a), ys[0]);
  const worst = ys.reduce((a, y) => (y.v < a.v ? y : a), ys[0]);
  $("years-sub").textContent = `Net reported change per calendar year. Biggest net buying: ${best.i} (${signed(best.v)}). Biggest net selling: ${worst.i} (${signed(worst.v)}).`
    + (last.partial ? ` ${last.i} runs to ${mLabel(last.b)} so far and is shown lighter.` : "");
  const recent = ys.filter((y) => !y.partial && y.i >= 2022 && y.i <= 2024);
  $("years-note").textContent = recent.length === 3
    ? `For scale: the World Gold Council puts all central bank buying, disclosed or not, above 1,000 t a year in 2022–24. The reported totals here average ${signed(recent.reduce((a, y) => a + y.v, 0) / 3)} a year for those three years.`
    : "";
  columnChart($("chart-years"), {
    bars: ys.map((y) => ({ i: y.i, v: y.v, faded: y.partial, y })),
    axis: "years",
    label: `Column chart of net reported central bank gold buying per calendar year, ${ys[0].i} to ${last.i}.`,
    tipTitle: (b) => yearTitle(b.y),
    tipRows: (b) => [
      { value: signed(b.v), label: "net, all holders", key: b.v >= 0 ? "buy" : "sell" },
      "sep",
      ...b.y.per.filter((x) => x.v > 0).slice(0, 3).map((x) => ({ value: signed(x.v), label: x.d.name, key: "buy" })),
      ...b.y.per.filter((x) => x.v < 0).slice(-1).map((x) => ({ value: signed(x.v), label: x.d.name, key: "sell" })),
    ],
  });
  $("table-years").replaceChildren(tableDetails("Show as a table",
    table("Net reported change per year, with the biggest buyers and sellers", ["Year", "Net change", "Biggest buyers", "Biggest sellers"],
      ys.slice().reverse().map((y) => [yearTitle(y), sv(y.v),
        y.per.filter((x) => x.v > 0).slice(0, 3).map((x) => `${x.d.name} ${signed(x.v)}`).join(", ") || "–",
        y.per.filter((x) => x.v < 0).slice(-3).reverse().map((x) => `${x.d.name} ${signed(x.v)}`).join(", ") || "–"]),
      { scroll: true })));
}

function contribRows(month, n = 3) {
  return month.contrib.slice(0, n).map(({ d, c }) => ({ value: signed(c), label: d.name, key: c >= 0 ? "buy" : "sell" }));
}

function renderMonthly(m) {
  const from = m.newest - 35;
  const bars = [];
  for (let i = from; i <= m.newest; i++) {
    const mo = m.months.get(i);
    bars.push({ i, v: mo.net, faded: i > m.complete, mo });
  }
  const pendingCount = m.newest - m.complete;
  $("monthly-sub").textContent = "Net reported change each month, all holders together."
    + (pendingCount ? ` The last ${pendingCount === 1 ? "bar is" : `${pendingCount} bars are`} lighter: those months are still being reported and are not in the totals.` : "");
  columnChart($("chart-monthly"), {
    bars,
    label: `Column chart of monthly net reported central bank gold buying, ${mLabel(from)} to ${mLabel(m.newest)}.`,
    tipRows: (b) => [
      { value: signed(b.v), label: b.faded ? `so far (${pct(b.mo.coverage)} reported)` : "net, all holders", key: b.v >= 0 ? "buy" : "sell" },
      "sep",
      ...contribRows(b.mo),
    ],
  });
  $("table-monthly").replaceChildren(tableDetails("Show as a table",
    table("Monthly net reported change and the biggest movers", ["Month", "Net change", "Status", "Biggest moves"],
      bars.slice().reverse().map((b) => [mLabel(b.i), sv(b.v), b.faded ? `${pct(b.mo.coverage)} reported` : "complete",
        b.mo.contrib.slice(0, 3).map(({ d, c }) => `${d.name} ${signed(c)}`).join(", ")]), { scroll: true })));
}

function renderWho(m) {
  const sorted = m.byCountry.slice().sort((a, b) => b.v - a.v);
  const buyers = sorted.filter((x) => x.v >= 0.5).slice(0, 8);
  const sellers = sorted.filter((x) => x.v <= -0.5).slice(-5);
  const rows = [...buyers, ...sellers].map((x) => ({ name: x.d.name, v: x.v, d: x.d }));
  $("who-sub").textContent = `Change in reported holdings, ${mRange(m.win.from, m.win.to)}: the ${buyers.length} biggest buyers and ${sellers.length} biggest sellers.`;
  hbarChart($("chart-who"), {
    rows,
    splitAt: buyers.length && sellers.length ? buyers.length : 0,
    label: `Bar chart of the biggest changes in reported gold holdings, ${mRange(m.win.from, m.win.to)}.`,
    tipRows: (r) => [
      { value: signed(r.v), label: "over the 12 months", key: r.v >= 0 ? "buy" : "sell" },
      { value: tonnes(r.d.latest), label: `held, ${mLabel(r.d.last)}` },
    ],
  });
  $("table-who").replaceChildren(tableDetails("Show all holders as a table",
    table(`Change in reported holdings, ${mRange(m.win.from, m.win.to)}`, ["Holder", "12-month change", "Held now", "As of"],
      sorted.filter((x) => Math.abs(x.v) >= 0.05).map((x) => [x.d.name, sv(x.v), tonnes(x.d.latest), mLabel(x.d.last)]),
      { scroll: true })));
}

function renderGroups(m) {
  const series = GROUPS.map((g) => ({ name: g.name, cls: g.cls, points: m.groupRolling[g.key] }));
  $("groups-legend").replaceChildren(...series.map((sr) => h("span", {}, h("i", { class: sr.cls, "aria-hidden": "true" }), sr.name)));
  multiLineChart($("chart-groups"), {
    series,
    label: "Line chart of 12-month net reported gold buying by emerging and developing economies and by advanced economies.",
    tipExtra: (k) => [{ value: signed(series[0].points[k].v + series[1].points[k].v), label: "all holders" }],
  });
  const decs = series[0].points.map((p, k) => ({ p, k })).filter(({ p }) => p.i % 12 === 11 || p.i === series[0].points.at(-1).i).reverse();
  $("table-groups").replaceChildren(tableDetails("Show as a table",
    table("12-month net reported buying by group, at each December and the latest month", ["Month", ...series.map((sr) => sr.name)],
      decs.map(({ p, k }) => [mLabel(p.i), ...series.map((sr) => sv(sr.points[k].v))]), { scroll: true })));

  const rows = [...m.regions.entries()].map(([name, v]) => ({ name, v })).sort((a, b) => b.v - a.v);
  const topIn = (region) => m.byCountry.filter((x) => (REGION_OF[x.d.code] || "Other") === region).sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 3);
  $("regions-sub").textContent = `Change in reported holdings, ${mRange(m.win.from, m.win.to)}, summed by region.`;
  hbarChart($("chart-regions"), {
    rows,
    label: `Bar chart of 12-month net reported gold buying by region, ${mRange(m.win.from, m.win.to)}.`,
    tipRows: (r) => [{ value: signed(r.v), label: "net, 12 months", key: r.v >= 0 ? "buy" : "sell" }, "sep",
      ...topIn(r.name).map((x) => ({ value: signed(x.v), label: x.d.name, key: x.v >= 0 ? "buy" : "sell" }))],
  });
}

function renderMomentum(m, select) {
  const live = m.holders.filter((d) => !d.stale);
  const streaks = live.filter((d) => d.streak >= 2).sort((a, b) => b.streak - a.streak || b.latest - a.latest).slice(0, 8);
  const started = live.filter((d) => d.started).sort((a, b) => b.latest - a.latest);
  const stopped = live.filter((d) => d.stopped).sort((a, b) => b.latest - a.latest);
  $("momentum-sub").textContent = `Each holder measured at its own latest month. A purchase is a month with an increase of at least ${BUY_T} t.`;
  const nameBtn = (d) => h("button", { type: "button", class: "holder-btn", onclick: () => select(d.code, true) }, d.name);
  const card = (title, items, row, empty) => h("div", { class: "list-card" }, h("h3", {}, title),
    items.length ? h("ul", {}, items.map((d) => h("li", {}, nameBtn(d), h("span", { class: "v" }, row(d))))) : h("p", {}, empty));
  $("momentum-lists").replaceChildren(
    card("Longest buying streaks now", streaks, (d) => `${d.streak} months`, "No holder has bought two months running."),
    card("Started buying again", started, (d) => `since ${mLabel(d.lastBuy)}`, "Nobody has restarted after a year's pause."),
    card("Stopped buying", stopped, (d) => `last ${mLabel(d.lastBuy)}`, "No regular buyer has gone quiet for 6 months."),
  );
  const regular = live.filter((d) => d.buys12 >= 3).sort((a, b) => b.buys12 - a.buys12 || (b.d12 ?? 0) - (a.d12 ?? 0));
  const tbl = table(`Regular buyers: purchases in at least 3 of their last 12 reported months (${regular.length} holders)`,
    ["Holder", "Buying months", "Selling months", "Current streak", "12-month change", "Last purchase"],
    regular.map((d) => [nameBtn(d), `${d.buys12} of 12`, String(d.sells12), d.streak ? plural(d.streak, "month") : "–",
      d.d12 === undefined ? "–" : sv(d.d12), d.lastBuy === undefined ? "–" : mLabel(d.lastBuy)]), { scroll: true });
  $("momentum-table").replaceChildren(tbl, csvButton(tbl));
}

function renderShare(m, r) {
  const ws = r.worldSeries;
  const { now, then } = shareYearAgo(r);
  const low = ws.reduce((a, p) => (p.v < a.v ? p : a), ws[0]);
  let why = "";
  if (then && then.price && now.price) {
    const dPrice = now.price / then.price - 1;
    const tNow = m.worldTotal.get(now.i), tThen = m.worldTotal.get(then.i);
    const dTonnes = tNow && tThen ? tNow / tThen - 1 : 0;
    const both = `the gold price moved ${dPrice >= 0 ? "+" : MINUS}${pct(Math.abs(dPrice))} while reported holdings moved ${dTonnes >= 0 ? "+" : MINUS}${pct1(Math.abs(dTonnes))}`;
    why = Math.abs(dPrice) > 3 * Math.abs(dTonnes) ? ` Most of that comes from the price: ${both}.` : ` Over those 12 months ${both}.`;
  }
  $("reserves-sub").textContent = `Gold valued at the market price, as a share of official reserve assets, all reporting holders together, from ${mLabel(ws[0].i)} (when China, the largest reserve holder, began reporting) to ${mLabel(now.i)}. `
    + `Low: ${pct1(low.v)} in ${mLabel(low.i)}. Now ${pct1(now.v)}` + (then ? `, ${now.v >= then.v ? "up" : "down"} from ${pct1(then.v)} a year earlier.${why}` : ".");
  lineChart($("chart-share"), {
    points: ws,
    label: `Line chart of gold's share of reported official reserves, ${mLabel(ws[0].i)} to ${mLabel(now.i)}. Latest ${pct1(now.v)}.`,
    fmtTick: pctTick,
    endLabel: (p) => pct1(p.v),
    tipRows: (p) => [
      { value: pct1(p.v), label: "gold share", key: "line" },
      { value: usdMn(p.gold), label: "gold at market" },
      { value: usdMn(p.total), label: "all reserves" },
      ...(p.price ? [{ value: usd(p.price), label: "per ounce" }] : []),
    ],
  });
  $("table-share").replaceChildren(tableDetails("Show as a table",
    table("Gold share of reported official reserves", ["Month", "Gold share", "Gold at market", "All reserves", "Price per ounce"],
      ws.slice().reverse().map((p) => [mLabel(p.i), pct1(p.v), usdMn(p.gold), usdMn(p.total), p.price ? usd(p.price) : "–"]), { scroll: true })));

  renderMix(m, r);

  const top = m.holders.slice().sort((a, b) => b.latest - a.latest).slice(0, TOP_N)
    .map((d) => r.byCode.get(d.code)).filter(Boolean).sort((a, b) => b.latest.share - a.latest.share);
  hbarChart($("chart-share-holders"), {
    rows: top.map((x) => ({ name: x.name, v: x.latest.share, x })),
    fmt: pct,
    neutral: true,
    label: "Bar chart of gold as a percentage of each large holder's official reserves.",
    tipRows: (row) => [
      { value: pct1(row.v), label: `of reserves, ${mLabel(row.x.last)}`, key: "line" },
      { value: usdMn(row.x.latest.goldMkt), label: "gold at market" },
      { value: usdMn(row.x.latest.totalAdj), label: "all reserves" },
      ...(row.x.revalued ? ["sep", { value: "Revalued", label: "reports gold at a book price" }] : []),
    ],
  });
  const pr = r.price;
  lineChart($("chart-price"), {
    points: pr,
    height: 220,
    fmtTick: usdTick,
    endLabel: (p) => usd(p.v),
    label: `Line chart of the gold price implied by IMF reserve data, ${mLabel(pr[0].i)} to ${mLabel(pr.at(-1).i)}. Latest ${usd(pr.at(-1).v)} per ounce.`,
    tipRows: (p) => [{ value: usd(p.v), label: "per ounce", key: "line" }, { value: String(p.n), label: "holders in the median" }],
  });
}

// Gold at market value next to everything else in reserves (foreign currency, SDRs, IMF
// position), both in US dollars, so "more gold" can be told apart from "less of the rest".
function renderMix(m, r) {
  const ws = r.worldSeries;
  const now = ws.at(-1), then = ws.find((p) => p.i === now.i - 12);
  const series = [
    { name: "Gold at market value", cls: "s2", points: ws.map((p) => ({ i: p.i, v: p.gold })) },
    { name: "Everything else", cls: "", points: ws.map((p) => ({ i: p.i, v: p.total - p.gold })) },
  ];
  const chg = (a, b) => `${a >= b ? "+" : MINUS}${pct1(Math.abs(a / b - 1))}`;
  $("mix-sub").textContent = `All reporting holders together, US dollars, ${mLabel(ws[0].i)} to ${mLabel(now.i)}. `
    + (then ? `Over the last 12 months gold's market value moved ${chg(now.gold, then.gold)} and everything else ${chg(now.total - now.gold, then.total - then.gold)}. ` : "")
    + "Everything else is mostly foreign-currency assets; its dollar value also moves with exchange rates, so a weaker dollar lifts it without anyone buying.";
  $("mix-legend").replaceChildren(...series.map((sr) => h("span", {}, h("i", { class: sr.cls, "aria-hidden": "true" }), sr.name)));
  multiLineChart($("chart-mix"), {
    series,
    fmt: usdMn,
    fmtTick: tnTick,
    label: `Line chart of gold at market value and all other official reserves, US dollars, ${mLabel(ws[0].i)} to ${mLabel(now.i)}.`,
    tipExtra: (k) => [{ value: pct1(ws[k].v), label: "gold share" }],
  });
  const decs = ws.filter((p) => p.i % 12 === 11 || p === now).reverse();
  $("table-mix").replaceChildren(tableDetails("Show as a table",
    table("Gold at market value and everything else in reported reserves, US$ millions", ["Month", "Gold at market (US$ M)", "Everything else (US$ M)", "Gold share"],
      decs.map((p) => [mLabel(p.i), NF0.format(p.gold), NF0.format(p.total - p.gold), pct1(p.v)]), { scroll: true })));
}

function renderBoard(m, r, select) {
  const top = m.holders.slice().sort((a, b) => b.latest - a.latest).slice(0, TOP_N);
  const total = m.holders.filter((d) => !d.stale).reduce((a, d) => a + d.latest, 0);
  $("board-sub").textContent = `The ${TOP_N} biggest holders that report to the IMF, each at its own latest month (reporting lags differ). `
    + "Uzbekistan, a large holder, does not report to this dataset and is missing.";
  const id = "board-caption";
  const head = ["Holder", "Gold", "Share", "As of", "1 month", "12 months", ...(r ? ["% of reserves"] : []), "3 years"];
  const rows = top.map((d, k) => {
    const spark = [];
    for (let i = d.last - 35; i <= d.last; i++) { const v = m.valueAt(d, i); if (v !== undefined) spark.push(v); }
    const rx = r?.byCode.get(d.code);
    return h("tr", {},
      h("th", { scope: "row", class: "l" },
        h("span", { class: "rank" }, `${k + 1}. `),
        h("button", { type: "button", class: "holder-btn", onclick: () => select(d.code, true) }, d.name)),
      h("td", {}, tonnes(d.latest)),
      h("td", {}, pct(d.latest / total)),
      h("td", { class: d.last < m.newest - 2 ? "flag" : "muted" }, d.last < m.newest - 2 ? h("span", { class: "tag", title: "Reports later than most" }, "lag") : null, " ", mLabel(d.last)),
      h("td", {}, d.d1 === undefined ? "–" : sv(d.d1)),
      h("td", {}, d.d12 === undefined ? "–" : sv(d.d12)),
      r ? h("td", {}, rx ? pct(rx.latest.share) : "–") : null,
      h("td", {}, spark.length > 1 ? sparkline(spark) : "–"));
  });
  const wrap = h("div", { class: "table-wrap", tabindex: "0", role: "region", "aria-labelledby": id },
    h("table", {},
      h("caption", { id }, "Largest reported gold holders. Select a name to see it in depth below."),
      h("thead", {}, h("tr", {}, head.map((c, k) => h("th", { scope: "col", class: k === 0 ? "l" : null }, c)))),
      h("tbody", {}, rows)));
  $("board-table").replaceChildren(wrap, csvButton(wrap));
}

// One <dt>/<dd> pair in the holder view's stats grid.
function dstat(label, value, note) {
  return h("div", {}, h("dt", {}, label), h("dd", {}, value, note ? h("small", {}, note) : null));
}

function renderCountry(m, r, code) {
  const d = m.holders.find((x) => x.code === code);
  if (!d) return;
  const ranked = m.holders.slice().sort((a, b) => b.latest - a.latest);
  const rank = ranked.indexOf(d) + 1;
  const world = m.worldTotal.get(d.last) || 0;
  const rx = r?.byCode.get(code);
  put("country-stats",
    dstat("Holds", tonnes(d.latest), `${mLabel(d.last)}${d.stale ? ", no report since" : ""}`),
    dstat("Rank", `${rank} of ${m.holders.length}`, world ? `${pct1(d.latest / world)} of all reported gold` : null),
    dstat("12-month change", d.d12 === undefined ? "–" : sv(d.d12), `${d.buys12} buying, ${d.sells12} selling months`),
    dstat("Buying streak", d.streak ? plural(d.streak, "month") : "None now", d.lastBuy !== undefined ? `last purchase ${mLabel(d.lastBuy)}` : "no purchase on record"),
    dstat("Biggest month in", d.maxBuy && d.maxBuy.c > 0 ? signed(d.maxBuy.c) : "–", d.maxBuy && d.maxBuy.c > 0 ? mLabel(d.maxBuy.i) : null),
    dstat("Biggest month out", d.maxSell && d.maxSell.c < 0 ? signed(d.maxSell.c) : "–", d.maxSell && d.maxSell.c < 0 ? mLabel(d.maxSell.i) : null),
    dstat("Peak", tonnes(d.peak.v), mLabel(d.peak.i)),
    rx ? dstat("Gold share of reserves", pct1(rx.latest.share), `${mLabel(rx.last)}${rx.revalued ? ", revalued at market" : ""}`) : null,
    minedStat(m, code),
  );

  const pts0 = [...d.s.entries()].sort((a, b) => a[0] - b[0]).map(([i, v]) => ({ i, v }));
  lineChart($("chart-country"), {
    points: pts0,
    height: 260,
    label: `Line chart of ${d.name}'s reported gold holdings, ${mLabel(pts0[0].i)} to ${mLabel(d.last)}.`,
    endLabel: (p) => tonnes(p.v),
    tipRows: (p) => {
      const c = m.change(d, p.i);
      const w = m.worldTotal.get(p.i);
      return [{ value: tonnes(p.v), label: "held", key: "line" },
        ...(c === undefined ? [] : [{ value: signed(c), label: "change" }]),
        ...(w ? [{ value: pct1(p.v / w), label: "of all reported gold" }] : [])];
    },
  });

  const yrs = [];
  for (let y = yearOf(d.first + 1); y <= yearOf(d.last); y++) {
    let v = 0, any = false;
    for (let i = y * 12; i <= y * 12 + 11; i++) { const c = m.change(d, i); if (c !== undefined) { v += c; any = true; } }
    if (any) yrs.push({ i: y, v, partial: y === yearOf(d.last) && d.last % 12 !== 11 });
  }
  if (yrs.length) {
    columnChart($("chart-country-years"), {
      bars: yrs.map((y) => ({ ...y, faded: y.partial })),
      axis: "years",
      height: 200,
      label: `Column chart of ${d.name}'s reported gold change per year.`,
      tipTitle: (b) => (b.partial ? `${b.i} (to ${mLabel(d.last)})` : String(b.i)),
      tipRows: (b) => [{ value: signed(b.v), label: "net change", key: b.v >= 0 ? "buy" : "sell" }],
    });
  } else {
    $("chart-country-years").replaceChildren(h("p", { class: "chart-note" }, "Not enough data."));
  }

  if (rx && rx.s.size > 1) {
    const sp = [...rx.s.entries()].sort((a, b) => a[0] - b[0]).map(([i, e]) => ({ i, v: e.share, e }));
    $("country-share-h").textContent = `Gold as % of ${d.name}'s reserves`;
    lineChart($("chart-country-share"), {
      points: sp,
      height: 200,
      fmtTick: pctTick,
      endLabel: (p) => pct(p.v),
      label: `Line chart of gold's share of ${d.name}'s official reserves.`,
      tipRows: (p) => [{ value: pct1(p.v), label: "of reserves", key: "line" },
        { value: usdMn(p.e.goldMkt), label: "gold at market" }, { value: usdMn(p.e.totalAdj), label: "all reserves" }],
    });
  } else {
    $("country-share-h").textContent = "Gold as % of its reserves";
    $("chart-country-share").replaceChildren(h("p", { class: "chart-note" }, `${d.name} doesn't report total reserves in this dataset.`));
  }

  $("table-country").replaceChildren(tableDetails("Show holdings as a table",
    table(`${d.name}: reported gold holdings by month, newest first`, ["Month", "Held", "Change", ...(rx ? ["% of reserves"] : [])],
      pts0.slice().reverse().map((p) => {
        const c = m.change(d, p.i);
        const e = rx?.s.get(p.i);
        return [mLabel(p.i), tonnes(p.v), c === undefined ? "–" : sv(c), ...(rx ? [e ? pct1(e.share) : "–"] : [])];
      }), { scroll: true })));
}

// ["2003-06", "2026-03"] -> "Jun 2003, Mar 2026"; a run of consecutive months -> "Mar 2026 – Sep 2026".
function monthList(keys) {
  const is = keys.map(idx).sort((a, b) => a - b);
  const consecutive = is.every((v, k) => k === 0 || v === is[k - 1] + 1);
  if (is.length > 1 && consecutive) return `${mLabel(is[0])} – ${mLabel(is.at(-1))}`;
  return is.length > 3 ? `${mLabel(is[0])} … ${mLabel(is.at(-1))}` : is.map(mLabel).join(", ");
}

function renderNotes(m, r) {
  const pending = [];
  for (let i = m.complete + 1; i <= m.newest; i++) pending.push(`${mLabel(i)}: ${pct(m.months.get(i).coverage)} reported`);
  const stale = m.holders.filter((d) => d.stale).sort((a, b) => b.latest - a.latest);
  const rejected = Object.entries(m.raw.rejected || {});
  const revalued = r ? r.list.filter((x) => x.revalued).sort((a, b) => b.latest.goldMkt - a.latest.goldMkt) : [];
  put("notes",
    h("h3", {}, "When a month counts"),
    h("p", {}, `Countries report on different schedules: most file a month or two after it ends, some (the US among them) take longer. A month enters the totals once the holders responsible for ${pct(COVERAGE_MIN)} of the past year's reported buying and selling have filed it. Weighting by activity, not by size, means a large holder that never changes (such as the US) can't hold the totals back, while a busy trader (such as Turkey) can.`),
    pending.length ? h("p", {}, `Not counted yet: ${pending.join("; ")}.`) : null,
    h("h3", {}, "What is covered"),
    h("p", {}, `IMF IRFCL line 56, gold volume, for monetary authorities plus central government, so gold held by a finance ministry (the UK's Treasury, for example) counts. ${m.holders.length} holders, ${mLabel(m.first)} to ${mLabel(m.newest)}. The euro-area total is left out because its members and the ECB are already counted. Uzbekistan does not report to IRFCL.`),
    stale.length ? h("p", {}, `No report in the last ${STALE_MONTHS} months, shown at their last figure: ${stale.map((d) => `${d.name} (${mLabel(d.last)})`).join(", ")}.`) : null,
    h("h3", {}, "Removed as reporting errors"),
    h("p", {}, "The fetch scripts drop values that can only be mistakes in national submissions: more gold than anyone holds, a jump of exactly ×1,000, or a single month far off two neighbours that agree. A change can span up to three missing months, so a dropped value doesn't hide the move around it."),
    rejected.length ? h("ul", {}, rejected.map(([code, items]) =>
      h("li", {}, `${nameOf(code)}: ${plural(items.length, "month")} (${monthList(items.map((x) => x[0]))}), ${[...new Set(items.map((x) => x[2].split(" (")[0].split(" from ")[0]))].join("; ")}`))) : null,
    h("h3", {}, "Groups, regions and momentum"),
    h("p", {}, "Advanced economies follow the IMF World Economic Outlook list, with the ECB counted as advanced; every other holder is emerging or developing. Regions are this page's own grouping, close to the IMF's: Russia and Turkey sit in Europe, Kazakhstan and Egypt in Middle East, North Africa and Central Asia."),
    h("p", {}, `A purchase is a month with an increase of at least ${BUY_T} t. "Started buying again" means a purchase in a holder's last 6 reported months after none in the 12 before; "stopped" means none in the last 6 after at least 3 in the 12 before.`),
    h("p", {}, `Breadth counts holders whose reported gold changed by at least ${BREADTH_T} t over the 12 months to each month, each holder from its own figures. Concentration is the two biggest buyers' share of gross buying (every holder with a 12-month increase, added up); it is left out where gross buying is under 25 t, since then any two buyers are nearly all of it.`),
    h("h3", {}, "Updates and alerts"),
    h("p", {}, "When the daily job finds new or revised IMF figures, spike/changes.py compares them with the previous commit and records the difference in data/changes.json. It recomputes the headline gauge before and after, the same way this page does. If a month enters the totals, the gauge's word changes or one holder moves 20 t or more in a month (or a past month is revised by 10 t or more), it opens a GitHub issue assigned to the repo owner; GitHub sends the email."),
    h("h3", {}, "Funds"),
    h("p", {}, "The Funds panel is market data, not official reserves, and it comes from two other sources, loaded by your browser when the page opens: SPDR Gold Shares' historical archive (the GLD trust's tonnes of gold, daily) and the CFTC's Commitments of Traders report for COMEX gold (weekly). Neither is copied into this repo; the GLD archive's terms don't allow redistribution. If either source is down, only that chart is missing."),
    h("h3", {}, "Mine production"),
    h("p", {}, "Yearly mine output by country. The two latest years come from the USGS Mineral Commodity Summaries (the newest year is a USGS estimate); a monthly job, separate from the daily IMF job, fetches them and commits data/production_usgs.json when they change. Earlier years, back to 1900, come from Our World in Data, which combines USGS and British Geological Survey figures; your browser loads them, because the BGS keeps copyright in its figures. For the USGS years the page uses only the USGS figures, so smaller producers are grouped as \"Other countries\". The share of mine output divides a calendar year's net reported central bank change by world mine production that year."),
    h("h3", {}, "Gold's share of reserves"),
    h("p", {}, "Countries value their gold differently, so the reported dollar values can't be used as they are. This page takes one price per month, the median dollars per ounce across all holders with at least 1 t (it tracks the market price), revalues every holder's gold at it, and replaces the reported gold value inside total reserves with that market value."),
    revalued.length ? h("p", {}, `Holders whose own value is more than 10% off that price, mostly because they use an old official price or historical cost: ${revalued.map((x) => x.name).join(", ")}. The US, for example, values its gold at the statutory $42.22 an ounce.`) : null,
    r ? h("p", {}, `The world line starts in ${mLabel(r.worldSeries[0].i)}, when today's reporters first cover ${pct(COVERAGE_MIN)} of reserves, and ends at ${mLabel(r.complete)}, the latest month that is ${pct(COVERAGE_MIN)} reported.`) : null,
    h("h3", {}, "Your trigger and journal"),
    h("p", {}, "data/journal.json is the owner's file: a trigger level (12-month net reported buying, in tonnes) and dated notes. The trend chart draws the level as a dashed line and each note as a diamond in its month; the Journal section lists the notes with the gauge as it read then and the periods when the gauge was below the line. Edit the file on GitHub to change either."),
    h("h3", {}, "Buying and the price"),
    h("p", {}, "Each complete month since net buying took hold is one dot: the implied gold price's change over the month against the reported net change in holdings. The correlation is Pearson's, on monthly figures. Months are grouped by price move at ±3%. Seasonality averages the reported change for each calendar month over whole years only."),
    h("h3", {}, "Revisions and who is late"),
    h("p", {}, "Every figure that first appeared in data/changes.json is compared with the figure the IMF shows for that holder and month now; a difference of 0.05 t or more, or a withdrawn figure, counts as a revision. The delay a holder's figures usually take is the median gap between a month's end and the day its figure first arrived, so it needs a few filings per holder before it shows. 'Filers needed' adds the missing holders in order of activity weight until the next month would reach 90%."),
    h("h3", {}, "Treasuries and reserve currencies"),
    h("p", {}, "Foreign official holdings of US Treasuries come from the US Treasury's TIC 'Major Foreign Holders' tables (monthly, US$ billions, attributed to the custodian's country, so Belgium and Luxembourg stand in for others). Reserve currency shares come from the IMF's COFER: the share of foreign exchange reserves whose currency is reported, so gold is not in them. A monthly job fetches both (scripts: spike/fetch_tic.py, spike/fetch_cofer.py; logs: data/fetch_log_tic.csv, data/fetch_log_cofer.csv), separate from the daily gold job."),
    h("h3", {}, "Reported against the World Gold Council's estimate"),
    h("p", {}, "The WGC's Gold Demand Trends estimates total central bank buying each quarter, including purchases not reported by any country, from its own research and trade data. Its figures are typed into data/wgc_central_banks.json by hand from the report pages, each the latest revision found there. 'Reported' is this page's sum of monthly net changes over the quarter; the undisclosed share is one minus reported over estimated."),
    h("h3", {}, "Reading the gauge"),
    h("p", {}, "\"Speeding up\" compares the last three months, scaled to a year, with the 12-month total; within 15% counts as steady. Gold amounts are in tonnes (1 t ≈ 32,151 fine troy ounces), money in US dollars."),
  );
}

/* ---------- Breadth and concentration ---------- */

function renderBreadth(m) {
  const b = m.breadth;
  const now = b.at(-1), then = b.find((p) => p.i === now.i - 12);
  const peak = b.reduce((a, p) => (p.buyers > a.buyers ? p : a), b[0]);
  $("breadth-sub").textContent = `Holders whose reported gold rose by at least ${BREADTH_T} t over the 12 months to each point, and holders whose gold fell by that much. `
    + `${mLabel(now.i)}: ${now.buyers} adding, ${now.sellers} cutting` + (then ? ` (a year earlier ${then.buyers} and ${then.sellers})` : "")
    + `. Most holders adding at once: ${peak.buyers}, in ${mLabel(peak.i)}. More buyers is a broader signal than the same few buying more.`;
  const series = [
    { name: "Adding gold", cls: "buy", points: b.map((p) => ({ i: p.i, v: p.buyers })) },
    { name: "Cutting gold", cls: "sell", points: b.map((p) => ({ i: p.i, v: p.sellers })) },
  ];
  $("breadth-legend").replaceChildren(...series.map((sr) => h("span", {}, h("i", { class: sr.cls, "aria-hidden": "true" }), sr.name)));
  multiLineChart($("chart-breadth"), {
    series,
    fmt: count,
    fmtTick: count,
    label: `Line chart of how many holders added or cut at least ${BREADTH_T} t of gold over 12 months, ${mLabel(b[0].i)} to ${mLabel(now.i)}.`,
    tipExtra: (k) => [{ value: signedCount(b[k].buyers - b[k].sellers), label: "adding minus cutting" }],
  });

  $("concentration-sub").textContent = `Share of all gross reported buying over 12 months done by the two biggest buyers. ${mLabel(now.i)}: ${pct(now.share)} (${now.top.map((x) => x.d.name).join(" and ")}). `
    + "When a few buyers carry the total, one of them stopping changes the picture.";
  const cs = b.filter((p) => p.gross >= 25); // with almost no buying, any two buyers are "all of it"
  lineChart($("chart-concentration"), {
    points: cs.map((p) => ({ i: p.i, v: p.share, p })),
    height: 220,
    fmtTick: pctTick,
    yMax: 1,
    endLabel: (p) => pct(p.v),
    label: `Line chart of the two biggest buyers' share of gross reported gold buying over 12 months, ${mLabel(cs[0].i)} to ${mLabel(now.i)}. Latest ${pct(now.share)}.`,
    tipRows: (q) => [{ value: pct(q.v), label: "top two's share", key: "line" }, { value: signed(q.p.gross), label: "gross buying" }, "sep",
      ...q.p.top.map((x) => ({ value: signed(x.v), label: x.d.name, key: "buy" }))],
  });
  const decs = b.filter((p) => p.i % 12 === 11 || p === now).reverse();
  $("table-breadth").replaceChildren(tableDetails("Show as a table",
    table("Breadth and concentration of reported buying, at each December and the latest month",
      ["Month", "Adding", "Cutting", "Gross buying", "Top two share", "Top two"],
      decs.map((p) => [mLabel(p.i), count(p.buyers), count(p.sellers), signed(p.gross), pct(p.share), p.top.map((x) => x.d.name).join(", ") || "–"]),
      { scroll: true })));
}

/* ---------- Updates (data/changes.json, written by spike/changes.py) ---------- */

function renderUpdates(changes) {
  const list = (changes || []).slice().reverse();
  if (!list.length) {
    $("updates-sub").textContent = "The daily job records each change it finds in the IMF figures here. None recorded yet.";
    put("updates-list");
    return;
  }
  $("updates-sub").textContent = `Each time the daily job finds new or revised IMF figures, it records what changed. ${plural(list.length, "update")} since ${DAY.format(Date.parse(`${list.at(-1).date}T00:00:00Z`))}. `
    + "It also opens a GitHub issue, which GitHub emails, when a month enters the totals, the direction changes, or a holder moves 20 t or more in a month.";
  const item = (x) => {
    const when = mLabel(idx(x.month));
    if (x.kind === "revised") return h("li", {}, h("span", {}, `${nameOf(x.code)} · ${when}`), h("span", { class: "v" }, `revised ${tonnes(x.was)} → ${tonnes(x.t)}`));
    if (x.kind === "gone") return h("li", {}, h("span", {}, `${nameOf(x.code)} · ${when}`), h("span", { class: "v" }, `withdrawn (was ${tonnes(x.was)})`));
    return h("li", {}, h("span", {}, `${nameOf(x.code)} · ${when}`),
      h("span", { class: "v" }, has(x.move) ? sv(x.move) : "first figure", ` · holds ${tonnes(x.t)}`));
  };
  const card = (e) => {
    const a = e.gauge.after, b = e.gauge.before;
    const shown = e.items.filter((x) => x.kind !== "new" || (has(x.move) && Math.abs(x.move) >= 0.05) || !has(x.move));
    const quiet = e.items.length - shown.length;
    const top = shown.slice(0, 8);
    return h("article", { class: "list-card update" },
      h("h3", {}, DAY.format(Date.parse(`${e.date}T00:00:00Z`))),
      h("p", { class: "update-tags" },
        h("span", { class: "tag" }, plural(e.counts.new, "new figure")),
        e.counts.revised ? h("span", { class: "tag" }, `${e.counts.revised} revised`) : null,
        e.counts.gone ? h("span", { class: "tag" }, `${e.counts.gone} withdrawn`) : null,
        a && b && idx(a.complete) > idx(b.complete) ? h("span", { class: "tag accent" }, `${mLabel(idx(a.complete))} now in the totals`) : null,
        a && b && a.word !== b.word ? h("span", { class: "tag accent" }, `${b.word} → ${a.word}`) : null),
      a && b ? h("p", { class: "update-gauge" }, `12-month net ${signed(b.r12)} → `, sv(a.r12), ` · totals through ${mLabel(idx(a.complete))} · ${a.word}`) : null,
      top.length ? h("ul", {}, top.map(item)) : null,
      shown.length > top.length || quiet ? h("p", { class: "update-more" },
        [shown.length > top.length ? `${plural(shown.length - top.length, "more change")}` : null,
          quiet ? `${plural(quiet, "new figure")} with no change` : null].filter(Boolean).join(" · ")) : null);
  };
  const recent = list.slice(0, 4), older = list.slice(4);
  put("updates-list", h("div", { class: "split updates" }, recent.map(card)),
    older.length ? h("details", { class: "data-table" }, h("summary", {}, `Older updates (${older.length})`), h("div", { class: "split updates" }, older.map(card))) : null);
}

/* ---------- Compare holders ---------- */

const CMP_CLS = ["", "s2", "s3"]; // three validated series colors; a fourth fails the colorblind check
function setupCompare(m) {
  const sels = ["cmp-a", "cmp-b", "cmp-c"].map($);
  const ranked = m.holders.slice().sort((a, b) => b.latest - a.latest);
  sels.forEach((sel, k) => {
    if (k) sel.append(h("option", { value: "" }, "None"));
    for (const d of ranked) sel.append(h("option", { value: d.code }, d.name));
  });
  const known = new Set(m.holders.map((d) => d.code));
  const asked = (params.get("cmp") || "").split(",").filter((c) => known.has(c));
  const codes = asked.length ? asked : m.byCountry.slice().sort((a, b) => b.v - a.v).slice(0, 3).map((x) => x.d.code);
  sels.forEach((sel, k) => { sel.value = codes[k] || (k ? "" : ranked[0].code); });
  let mode = params.get("cmode") === "change" ? "change" : "held";
  let years = [0, 5, 10].includes(Number(params.get("crange"))) ? Number(params.get("crange")) : 0;
  const pick = () => [...new Set(sels.map((x) => x.value).filter(Boolean))];
  const draw = () => renderCompare(m, pick(), mode, years);
  for (const sel of sels) sel.addEventListener("change", () => { draw(); setParam("cmp", pick().join(",")); });
  wireSeg("cmp-mode", mode, (v) => { mode = v; draw(); setParam("cmode", v === "change" ? v : null); });
  wireSeg("cmp-range", years, (v) => { years = Number(v); draw(); setParam("crange", v); });
  draw();
}

function renderCompare(m, codes, mode, years) {
  const ds = codes.map((c) => m.holders.find((d) => d.code === c)).filter(Boolean);
  const lastI = Math.max(...ds.map((d) => d.last));
  const firstI = Math.max(Math.min(...ds.map((d) => d.first)), years ? lastI - years * 12 + 1 : -Infinity);
  const series = ds.map((d, k) => {
    const points = [];
    let base;
    for (let i = firstI; i <= lastI; i++) {
      let v = i > d.last ? null : m.valueAt(d, i) ?? null;
      if (has(v) && mode === "change") { base ??= v; v -= base; }
      points.push({ i, v });
    }
    return { name: d.name, cls: CMP_CLS[k], points, d };
  });
  const lags = ds.filter((d) => d.last < lastI);
  $("cmp-sub").textContent = (mode === "change"
    ? `Change in reported holdings since ${mLabel(firstI)} (or each holder's first report after it), in tonnes.`
    : `Reported holdings in tonnes, ${mLabel(firstI)} to ${mLabel(lastI)}.`)
    + (lags.length ? ` ${lags.map((d) => `${d.name} has reported to ${mLabel(d.last)}`).join("; ")}, so its line ends earlier.` : "");
  $("cmp-legend").replaceChildren(...series.map((sr) => h("span", {}, h("i", { class: sr.cls, "aria-hidden": "true" }), sr.name)));
  const fmt = mode === "change" ? signed : tonnes;
  multiLineChart($("chart-compare"), {
    series,
    fmt,
    label: `Line chart comparing ${ds.map((d) => d.name).join(", ")}: ${mode === "change" ? "change in" : ""} reported gold holdings, ${mLabel(firstI)} to ${mLabel(lastI)}.`,
  });
  const rows = series[0].points.map((p, k) => ({ p, k })).filter(({ p }) => p.i % 12 === 11 || p.i === lastI).reverse();
  $("table-compare").replaceChildren(tableDetails("Show as a table",
    table(`${ds.map((d) => d.name).join(", ")}: ${mode === "change" ? `change since ${mLabel(firstI)}` : "reported holdings"}, at each December and the latest month`,
      ["Month", ...series.map((sr) => sr.name)],
      rows.map(({ p, k }) => [mLabel(p.i), ...series.map((sr) => (has(sr.points[k].v) ? fmt(sr.points[k].v) : "–"))]), { scroll: true })));
}

/* ---------- Funds: GLD holdings and COMEX futures, loaded in the browser ---------- */

// Just enough of a zip reader for an .xlsx file: the central directory, then each entry inflated
// with the browser's own DecompressionStream ("deflate-raw").
function zipEntries(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), dec = new TextDecoder();
  let e = buf.byteLength - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("not a zip file");
  const n = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const out = new Map();
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("damaged zip directory");
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const at = dv.getUint32(p + 42, true);
    out.set(dec.decode(u8.subarray(p + 46, p + 46 + nl)), () => {
      const start = at + 30 + dv.getUint16(at + 26, true) + dv.getUint16(at + 28, true);
      const data = u8.subarray(start, start + size);
      if (method === 0) return Promise.resolve(dec.decode(data));
      if (method !== 8) throw new Error(`unsupported zip method ${method}`);
      return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
    });
    p += 46 + nl + xl + cl;
  }
  return out;
}
const xmlText = (x) => x.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const MON = Object.fromEntries("jan feb mar apr may jun jul aug sep oct nov dec".split(" ").map((x, k) => [x, k]));
function parseDay(x) {
  const t = String(x ?? "").trim();
  const mt = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(t);
  if (mt && mt[2].toLowerCase() in MON) return Date.UTC(Number(mt[3]), MON[mt[2].toLowerCase()], Number(mt[1]));
  const n = Number(t); // an Excel date serial, in case the archive switches to real dates
  return /^\d{5}(\.\d+)?$/.test(t) && n > 30000 && n < 80000 ? Math.round((n - 25569) * DAY_MS) : null;
}

// The GLD archive: a sheet with one row per trading day; the columns are found by their header
// ("Date", "Tonnes of Gold"), not by position. -> [{t, v}] in tonnes, oldest first.
async function readGLD(buf) {
  const zip = zipEntries(buf);
  const shared = zip.has("xl/sharedStrings.xml")
    ? [...(await zip.get("xl/sharedStrings.xml")()).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((x) => xmlText(x[1])) : [];
  for (const [name, read] of zip) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
    const xml = await read();
    let cols = null;
    const rows = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = {};
      for (const c of row[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const [, col, attrs, inner = ""] = c;
        let v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (/\bt="s"/.test(attrs) && v !== undefined) v = shared[Number(v)];
        else if (/\bt="inlineStr"/.test(attrs)) v = xmlText(inner);
        if (v !== undefined) cells[col] = v;
      }
      if (!cols) {
        const e = Object.entries(cells);
        const date = e.find(([, t]) => /^date$/i.test(String(t).trim()));
        const tn = e.find(([, t]) => /^tonnes/i.test(String(t).trim()));
        if (date && tn) cols = { date: date[0], t: tn[0] };
        continue;
      }
      const t = parseDay(cells[cols.date]), v = Number(cells[cols.t]);
      if (t !== null && Number.isFinite(v) && v > 0) rows.push({ t, v });
    }
    if (rows.length > 100) return rows.sort((a, b) => a.t - b.t);
  }
  throw new Error("no sheet with a Date and a Tonnes column");
}

function readCFTC(rows) {
  const num = (x) => Number(x);
  return rows.map((r) => ({
    t: Date.parse(`${String(r.report_date_as_yyyy_mm_dd).slice(0, 10)}T00:00:00Z`),
    oi: num(r.open_interest_all),
    mm: num(r.m_money_positions_long_all) - num(r.m_money_positions_short_all),
    sd: num(r.swap_positions_long_all) - num(r.swap__positions_short_all),
    pm: num(r.prod_merc_positions_long) - num(r.prod_merc_positions_short),
  })).filter((w) => Number.isFinite(w.t) && [w.oi, w.mm, w.sd, w.pm].every(Number.isFinite)).sort((a, b) => a.t - b.t);
}

// The latest row at or before time t (rows sorted by t).
function rowAt(rows, t) {
  let lo = 0, hi = rows.length - 1, best = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid].t <= t) { best = rows[mid]; lo = mid + 1; } else hi = mid - 1; }
  return best;
}
// One point per week (the week's last row), for long ranges.
function weekly(rows) {
  const out = [];
  for (const r of rows) {
    const wk = Math.floor((r.t / DAY_MS + 3) / 7); // weeks from Monday
    if (out.length && out.at(-1).wk === wk) out[out.length - 1] = { ...r, wk }; else out.push({ ...r, wk });
  }
  return out;
}
const sinceYears = (rows, years) => (years ? rows.filter((r) => r.t > rows.at(-1).t - years * 365.25 * DAY_MS) : rows);

function renderGLD(rows, years) {
  const last = rows.at(-1);
  const back = (days) => rowAt(rows, last.t - days * DAY_MS);
  const m1 = back(30), y1 = back(365), ytd = rowAt(rows, Date.UTC(new Date(last.t).getUTCFullYear(), 0, 1) - 1);
  const peak = rows.reduce((a, r) => (r.v >= a.v ? r : a), rows[0]);
  put("gld-stats",
    dstat("Holds", tonnes(last.v), DAY.format(last.t)),
    m1 ? dstat("1 month", sv(last.v - m1.v), `since ${DAY.format(m1.t)}`) : null,
    ytd ? dstat("This year", sv(last.v - ytd.v), `since ${DAY.format(ytd.t)}`) : null,
    y1 ? dstat("12 months", sv(last.v - y1.v), `since ${DAY.format(y1.t)}`) : null,
    dstat("Peak", tonnes(peak.v), DAY.format(peak.t)));
  const shown = years === 1 ? sinceYears(rows, 1) : weekly(sinceYears(rows, years));
  const step = years === 1 ? "previous day" : "previous week";
  lineChart($("chart-gld"), {
    points: shown.map((r, k) => ({ i: dayIdx(r.t), v: r.v, t: r.t, prev: shown[k - 1]?.v })),
    height: 240,
    zero: years === 0, // the full history starts near zero anyway; 1Y and 5Y zoom in
    endLabel: (p) => tonnes(p.v),
    tipTitle: (p) => DAY.format(p.t),
    label: `Line chart of gold held by the SPDR Gold Trust, ${DAY.format(shown[0].t)} to ${DAY.format(last.t)}. Latest ${tonnes(last.v)}.`,
    tipRows: (p) => [{ value: tonnes(p.v), label: "in the trust", key: "line" },
      ...(has(p.prev) ? [{ value: signed(p.v - p.prev), label: `vs ${step}` }] : [])],
  });
  $("gld-note").textContent = "The largest gold ETF. Its holdings rise when investors buy shares faster than they sell them, and fall the other way: a daily read of Western investment demand. "
    + "Source: SPDR Gold Shares historical archive, fetched by your browser.";
}

function renderCFTC(weeks, years) {
  const last = weeks.at(-1);
  const toT = (c) => c * CONTRACT_T;
  const prev4 = rowAt(weeks, last.t - 28 * DAY_MS);
  const lower = weeks.filter((w) => w.mm < last.mm).length / weeks.length;
  put("cftc-stats",
    dstat("Managed money, net long", tonnes(toT(last.mm)), `${NF0.format(last.mm)} contracts · ${DAY.format(last.t)}`),
    prev4 ? dstat("4 weeks", sv(toT(last.mm - prev4.mm)), `since ${DAY.format(prev4.t)}`) : null,
    dstat("Versus history", `Higher than ${pct(lower)}`, `of weeks since ${yearOf(dayIdx(weeks[0].t))}`),
    dstat("Share of open interest", pct1(last.mm / last.oi), `${NF0.format(last.oi)} contracts open`));
  const shown = sinceYears(weeks, years);
  const series = [
    { name: "Managed money (funds)", cls: "", key: "mm" },
    { name: "Swap dealers (banks)", cls: "s2", key: "sd" },
    { name: "Producers and merchants", cls: "s3", key: "pm" },
  ].map((sr) => ({ ...sr, points: shown.map((w) => ({ i: dayIdx(w.t), v: toT(w[sr.key]), t: w.t })) }));
  $("cftc-legend").replaceChildren(...series.map((sr) => h("span", {}, h("i", { class: sr.cls, "aria-hidden": "true" }), sr.name)));
  multiLineChart($("chart-cftc"), {
    series,
    height: 260,
    tipTitle: (p) => `Week to ${DAY.format(p.t)}`,
    label: `Line chart of net COMEX gold futures positions in tonnes by trader type, ${DAY.format(shown[0].t)} to ${DAY.format(last.t)}.`,
  });
  $("cftc-note").textContent = "Net position = long minus short contracts, converted at 100 troy ounces a contract. Funds (managed money) are usually net long and their swings are the speculative bet; "
    + "banks and producers mostly sit on the other side. Source: CFTC Commitments of Traders, disaggregated futures only, weekly (Tuesday positions, published Friday)"
    + (weeks.fromRepo ? "; from this repo's weekly job (data/cftc_gold.json), which also opens an alert when the funds' position moves a lot." : "; loaded by your browser from the CFTC's API.");
  // The last report of each month, for the table.
  return shown.filter((w, k, a) => k === a.length - 1 || new Date(w.t).getUTCMonth() !== new Date(a[k + 1].t).getUTCMonth()).reverse();
}

async function loadFunds() {
  let gld = null, cftc = null, years = [0, 5, 1].includes(Number(params.get("frange"))) ? Number(params.get("frange")) : 0;
  const fail = (id, what, err) => { $(id).replaceChildren(h("p", { class: "chart-note error" }, `Couldn't load ${what} (${err.message || err}). The rest of the page doesn't depend on it.`)); };
  const drawFutures = () => {
    if (!cftc) return;
    const rows = renderCFTC(cftc, years);
    const gAt = (t) => (gld ? rowAt(gld, t) : null);
    $("table-funds").replaceChildren(tableDetails("Show month ends as a table",
      table("Month-end GLD holdings and net COMEX futures positions, tonnes", ["Week to", "GLD holdings", "Managed money", "Swap dealers", "Producers and merchants"],
        rows.map((w) => [DAY.format(w.t), gAt(w.t) ? tonnes(gAt(w.t).v) : "–", signed(w.mm * CONTRACT_T), signed(w.sd * CONTRACT_T), signed(w.pm * CONTRACT_T)]),
        { scroll: true })));
  };
  const draw = () => { if (gld) renderGLD(gld, years); drawFutures(); };
  wireSeg("funds-range", years, (v) => { years = Number(v); draw(); setParam("frange", v); });
  const [g, c] = await Promise.allSettled([
    (async () => {
      if (typeof DecompressionStream === "undefined") throw new Error("this browser can't unzip the archive");
      const res = await fetch(GLD_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return readGLD(await res.arrayBuffer());
    })(),
    (async () => {
      // The weekly job commits the CFTC data; the live API is the fallback when the file is missing or stale.
      try {
        const f = await getJSON(CFTC_FILE);
        const col = Object.fromEntries(f.columns.map((c, k) => [c, k]));
        const w = f.weeks.map((r) => ({ t: Date.parse(`${r[col.date]}T00:00:00Z`), oi: r[col.open_interest],
          mm: r[col.mm_long] - r[col.mm_short], sd: r[col.swap_long] - r[col.swap_short], pm: r[col.prod_long] - r[col.prod_short] }));
        if (w.length >= 100 && Date.now() - w.at(-1).t < 21 * DAY_MS) return Object.assign(w, { fromRepo: true });
      } catch { /* fall through to the live API */ }
      const res = await fetch(CFTC_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const w = readCFTC(await res.json());
      if (w.length < 100) throw new Error(`only ${w.length} weeks`);
      return w;
    })(),
  ]);
  if (g.status === "fulfilled") gld = g.value; else { fail("chart-gld", "the GLD archive from spdrgoldshares.com", g.reason); put("gld-stats"); }
  if (c.status === "fulfilled") cftc = c.value; else { fail("chart-cftc", "CFTC data from publicreporting.cftc.gov", c.reason); put("cftc-stats"); }
  $("funds-sub").textContent = "Market data, not central banks: what investors and traders hold. The GLD archive is loaded by your browser straight from the source each time the page opens (its terms don't allow storing it here); "
    + "the CFTC positions come from this repo's weekly job, with the CFTC's API as the fallback.";
  draw();
}

/* ---------- Mine production ---------- */

// Years -> { y, world, est, by: Map(code -> {v, est}), other }. The USGS file covers the two
// latest years and replaces Our World in Data for those whole years, so a year never mixes the
// two sources (OWID's latest year is an earlier USGS estimate anyway).
function buildProduction(usgs, owid) {
  const years = new Map();
  const yearRow = (y) => years.get(y) || years.set(y, { y, world: null, est: false, by: new Map(), other: null }).get(y);
  const names = new Map();
  if (owid) {
    const ents = new Map(owid.meta.dimensions.entities.values.map((e) => [e.id, e]));
    owid.data.values.forEach((v, k) => {
      const e = ents.get(owid.data.entities[k]);
      if (!e?.code || typeof v !== "number") return;
      names.set(e.code, e.name);
      const yr = yearRow(owid.data.years[k]);
      if (e.code === "OWID_WRL") yr.world = v; else yr.by.set(e.code, { v });
    });
  }
  if (usgs?.production) {
    for (const [y] of usgs.production.WLD || []) years.delete(y);
    for (const [code, rows] of Object.entries(usgs.production)) {
      for (const [y, v, e] of rows) {
        const yr = yearRow(y), est = e === "est";
        if (code === "WLD") { yr.world = v; yr.est = est; } else if (code === "OTH") yr.other = v; else yr.by.set(code, { v, est });
      }
    }
  }
  const list = [...years.values()].filter((yr) => yr.world > 0).sort((a, b) => a.y - b.y);
  if (!list.length) return null;
  return { list, byYear: new Map(list.map((yr) => [yr.y, yr])), latest: list.at(-1), edition: usgs?.edition,
    usgsYears: (usgs?.production?.WLD || []).map(([y]) => y), owid: Boolean(owid),
    name: (code) => NAMES[code] || names.get(code) || code };
}

let PROD = null; // mine production, once loaded (see loadProduction)
const prodTitle = (yr) => `${yr.y}${yr.est ? " (USGS estimate)" : ""}`;
const producers = (yr) => [...yr.by.entries()].map(([code, x]) => ({ code, ...x })).sort((a, b) => b.v - a.v);

// A holder's reported change over calendar year y: null when it isn't in the IMF data at all.
function cbYear(m, code, y) {
  const d = m.holders.find((x) => x.code === code);
  if (!d) return null;
  let v = 0, any = false;
  for (let i = y * 12; i <= y * 12 + 11; i++) { const c = m.change(d, i); if (c !== undefined) { v += c; any = true; } }
  return { d, v: any ? v : undefined };
}

// For the holder in view: what its country mines, in the latest year that lists it.
function minedStat(m, code) {
  const yr = PROD?.list.findLast((x) => x.by.has(code));
  const v = yr?.by.get(code).v;
  if (!v || v < 1) return null;
  const rank = [...yr.by.values()].filter((x) => x.v > v).length + 1;
  return dstat(`Mined in ${yr.y}`, tonnes(v), `${rank === 1 ? "Largest" : `${ordinal(rank)} largest`} producer${yr.by.get(code).est ? " · USGS estimate" : ""}`);
}

function renderSupply(m, p, owidErr) {
  const latest = p.latest;
  const cbOf = new Map(m.years.filter((y) => !y.partial).map((y) => [y.i, y]));
  const share = p.list.filter((yr) => cbOf.has(yr.y)).map((yr) => ({ i: yr.y, v: cbOf.get(yr.y).v / yr.world, cb: cbOf.get(yr.y).v, yr }));
  const lastS = share.at(-1);
  const peak = share.reduce((a, x) => (x.v > a.v ? x : a), share[0]);
  const back10 = p.byYear.get(latest.y - 10);
  const tops = producers(latest);
  const growth = back10 ? latest.world / back10.world - 1 : null;

  const low = share.reduce((a, x) => (x.v < a.v ? x : a), share[0]);
  $("supply-sub").textContent = "Gold mined each year, worldwide and by country, next to what central banks reported adding. Mine output changes slowly"
    + (share.length >= 5 ? `; reported central bank buying has not. It has ranged from ${low.v < 0 ? `net selling of ${pct(-low.v)}` : pct(low.v)} of it (${low.i}) to net buying of ${pct(peak.v)} (${peak.i}).` : ".");
  put("supply-stats",
    dstat(`Mined worldwide, ${latest.y}`, tonnes(latest.world), latest.est ? "USGS estimate" : "USGS"),
    back10 ? dstat(`Versus ${back10.y}`, delta(growth, `${pct(Math.abs(growth))}`, 0.005), `${tonnes(back10.world)} then`) : null,
    lastS ? dstat(`Central banks, ${lastS.i}`, sv(lastS.cb), `reported net, ${pct(lastS.v)} of mine output`) : null,
    share.length >= 5 ? dstat("Highest share", pct(peak.v), `${peak.i}: ${signed(peak.cb)} of ${tonnes(peak.yr.world)}`) : null,
    tops[0] ? dstat("Largest producer", p.name(tops[0].code), `${tonnes(tops[0].v)}, ${pct(tops[0].v / latest.world)} of the world's`) : null);

  // The headline row gets the share too: it is the one number here that moves with central banks.
  const pace = document.querySelector('#stat-groups [data-group="Pace"]');
  if (pace && lastS) {
    pace.querySelector(".stat.supply")?.remove();
    const st = stat("Share of mine output", pct(lastS.v), [`${lastS.i}: ${signed(lastS.cb)} reported, ${tonnes(lastS.yr.world)} mined`]);
    st.classList.add("supply");
    pace.append(st);
  }

  if (share.length) {
    $("supply-share-sub").textContent = `Net reported central bank buying in each calendar year divided by world mine production that year, ${share[0].i} to ${lastS.i}. `
      + "Below zero, central banks were net sellers. Reported buying only: the World Gold Council's estimate of all central bank buying (over 1,000 t a year in 2022–24) would be about a third of mine output."
      + (cbOf.has(latest.y + 1) ? ` Years after ${latest.y} wait for the USGS figures.` : "");
    columnChart($("chart-supply-share"), {
      bars: share.map((x) => ({ i: x.i, v: x.v, x })),
      axis: "years",
      height: 220,
      fmtTick: pctTick,
      label: `Column chart of reported central bank net gold buying as a share of world mine production, ${share[0].i} to ${lastS.i}. Latest ${pct(lastS.v)}.`,
      tipTitle: (b) => prodTitle(b.x.yr),
      tipRows: (b) => [
        { value: pct1(b.v), label: "of mine output", key: b.v >= 0 ? "buy" : "sell" },
        "sep",
        { value: signed(b.x.cb), label: "central banks, net reported" },
        { value: tonnes(b.x.yr.world), label: "mined worldwide" },
      ],
    });
  }

  const wp = p.list.map((yr) => ({ i: yr.y * 12, v: yr.world, yr }));
  $("supply-world-sub").textContent = `Tonnes a year, ${wp[0].yr.y} to ${latest.y}. The tooltip names the largest producers each year.`;
  lineChart($("chart-supply-world"), {
    points: wp,
    height: 220,
    endLabel: (q) => tonnes(q.v),
    tipTitle: (q) => prodTitle(q.yr),
    label: `Line chart of world gold mine production per year, ${wp[0].yr.y} to ${latest.y}. Latest ${tonnes(latest.world)}.`,
    tipRows: (q) => [{ value: tonnes(q.v), label: "mined worldwide", key: "line" },
      ...producers(q.yr).slice(0, 3).map((x) => ({ value: tonnes(x.v), label: p.name(x.code) }))],
  });

  // Largest producers, and what their own central bank reported doing that year.
  const cbLine = (code) => {
    const cb = cbYear(m, code, latest.y);
    if (!cb) return { value: "–", label: "central bank not in the IMF data" };
    if (cb.v === undefined) return { value: "–", label: `central bank, no ${latest.y} report` };
    return { value: signed(cb.v), label: `central bank, ${latest.y}`, key: { pos: "buy", neg: "sell" }[tone(cb.v)] };
  };
  // "Other countries" stays out of the chart (one 1,000 t bar would flatten every country) and
  // goes in the table.
  const rows = tops.slice(0, 15).map((x) => ({ name: p.name(x.code), v: x.v, x }));
  $("producers-h").textContent = `Largest producers in ${latest.y}`;
  $("producers-sub").textContent = `Tonnes mined${latest.est ? " (USGS estimates)" : ""}`
    + (latest.other ? `; all other countries together mined ${tonnes(latest.other)} (${pct(latest.other / latest.world)} of the world's).` : ".")
    + " Hover a bar for what that country's central bank reported in the same year: some buy local mine output (Kazakhstan's has first refusal on it), most don't.";
  hbarChart($("chart-producers"), {
    rows,
    neutral: true,
    fmt: tonnes,
    label: `Bar chart of gold mine production by country in ${latest.y}. Largest: ${rows[0].name}, ${tonnes(rows[0].v)}.`,
    tipRows: (r) => [{ value: tonnes(r.v), label: "mined" }, { value: pct1(r.v / latest.world), label: "of world output" },
      "sep", cbLine(r.x.code)],
  });
  if (latest.other) rows.push({ name: "Other countries", v: latest.other, x: null }); // table only
  $("table-producers").replaceChildren(tableDetails("Show producers as a table",
    table(`Largest gold producers in ${latest.y} and their central banks' reported change that year`,
      ["Producer", `Mined ${latest.y}`, "Share of world", back10 ? `Change since ${back10.y}` : "Change", `Central bank ${latest.y}`, "Central bank vs mined"],
      [...rows.map((r) => {
        const old = r.x ? back10?.by.get(r.x.code)?.v : back10?.other;
        const cb = r.x ? cbYear(m, r.x.code, latest.y) : null;
        const cbv = cb?.v;
        return [r.name, tonnes(r.v), pct1(r.v / latest.world), old === undefined || old === null ? "–" : sv(r.v - old),
          !r.x ? "–" : !cb ? "not in IMF data" : cbv === undefined ? "–" : sv(cbv),
          cbv === undefined ? "–" : pct(cbv / r.v)];
      }), ["World", tonnes(latest.world), "100.0%", back10 ? sv(latest.world - back10.world) : "–", lastS?.i === latest.y ? sv(lastS.cb) : "–",
        lastS?.i === latest.y ? pct(lastS.v) : "–"]])));

  const owidNote = owidErr ? ` Our World in Data didn't load (${owidErr.message || owidErr}), so only the USGS years are shown.` : "";
  $("supply-note").classList.toggle("error", Boolean(owidErr));
  $("supply-note").replaceChildren(h("span", {},
    `Mine output only: recycled gold, roughly a quarter of yearly supply, is not in these figures. Sources: USGS Mineral Commodity Summaries ${p.edition ?? ""} for ${p.usgsYears.join(" and ") || "the latest years"} (in this repo); `
    + `earlier years from Our World in Data (USGS and British Geological Survey figures), loaded by your browser. The World Gold Council's supply figures run higher, as it estimates more small-scale mining.${owidNote}`));
  $("table-supply").replaceChildren(tableDetails("Show years as a table",
    table("World gold mine production and reported central bank net buying per year", ["Year", "Mined worldwide", "Central banks, net reported", "Share of mine output"],
      p.list.slice().reverse().map((yr) => {
        const cb = cbOf.get(yr.y);
        return [prodTitle(yr), tonnes(yr.world), cb ? sv(cb.v) : "–", cb ? pct1(cb.v / yr.world) : "–"];
      }), { scroll: true })));
}

async function loadProduction(m, r) {
  const owidJSON = async (kind) => {
    const res = await fetch(`${OWID_PROD}.${kind}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  const [u, o] = await Promise.allSettled([
    getJSON(PRODUCTION_URL),
    Promise.all([owidJSON("data"), owidJSON("metadata")]).then(([data, meta]) => {
      if (!data.values?.length || !meta.dimensions?.entities?.values) throw new Error("unexpected format");
      return { data, meta };
    }),
  ]);
  const p = buildProduction(u.status === "fulfilled" ? u.value : null, o.status === "fulfilled" ? o.value : null);
  if (!p) {
    put("supply-stats");
    const sub = $("supply-sub");
    sub.textContent = `Couldn't load mine production (${PRODUCTION_URL}: ${u.reason?.message || "no data"}; Our World in Data: ${o.reason?.message || "no data"}). The rest of the page doesn't depend on it.`;
    sub.classList.add("chart-note", "error");
    return;
  }
  PROD = p;
  renderSupply(m, p, o.status === "rejected" ? o.reason : null);
  const sel = $("country-select");
  if (sel.value) renderCountry(m, r, sel.value); // adds "Mined in …" to the holder in view
}

/* ---------- Boot ---------- */

/* ---------- Your trigger and journal (data/journal.json, edited by hand) ---------- */

let JOURNAL = null; // set in main() before the trend and stat groups draw
const JOURNAL_EDIT = "https://github.com/Vasuki8/gold-tracker/edit/main/data/journal.json";
const dayOf = (iso) => Date.parse(`${iso}T00:00:00Z`);
const journalEntries = () => (JOURNAL?.entries || []).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date || "") && e.text)
  .map((e) => ({ ...e, i: idx(e.date.slice(0, 7)) })).sort((a, b) => a.date.localeCompare(b.date));

function triggerStat(k) {
  const t = JOURNAL?.trigger?.t;
  if (!Number.isFinite(t)) return null;
  const gap = k.r12 - t;
  return stat("Your trigger", signed(t), [
    gap >= 0 ? h("span", { class: "pos" }, `▲ ${tonnes(gap)} above it`) : h("span", { class: "neg" }, `▼ ${tonnes(-gap)} below it: re-read your case`),
    h("a", { href: "#journal" }, "Journal and trigger"),
  ]);
}

function renderJournal(m, j) {
  const sec = $("journal");
  if (!j || !Number.isFinite(j.trigger?.t)) { sec.hidden = true; return; }
  const t = j.trigger.t, k = headline(m), all = m.rolling12, now = all.at(-1);
  // Runs of months below the line, oldest first.
  const runs = [];
  for (const p of all) {
    if (p.v >= t) continue;
    const last = runs.at(-1);
    if (last && last.to === p.i - 1) { last.to = p.i; if (p.v < last.low.v) last.low = p; } else runs.push({ from: p.i, to: p.i, low: p });
  }
  const cur = runs.length && runs.at(-1).to === now.i ? runs.at(-1) : null;
  const lastRun = cur ? runs.at(-2) : runs.at(-1);
  const since = m.turn ?? all[0].i;
  const recent = all.filter((p) => p.i >= since);
  const belowRecent = recent.filter((p) => p.v < t).length;
  $("journal-sub").textContent = `Your line is ${signed(t)} of reported net buying over 12 months${j.trigger.set ? `, set ${DAY.format(dayOf(j.trigger.set))}` : ""}. `
    + `${j.trigger.why || ""} The dashed line on the trend chart is this level; the diamonds are your journal entries.`;
  put("journal-stats",
    dstat("Your trigger", signed(t), "12-month net reported buying"),
    dstat("Gauge now", signed(k.r12), cur ? `below the line since ${mLabel(cur.from)}` : `${tonnes(k.r12 - t)} above the line`),
    dstat("Last time below", lastRun ? (lastRun.from === lastRun.to ? mLabel(lastRun.from) : mRange(lastRun.from, lastRun.to)) : "never", lastRun ? `${plural(lastRun.to - lastRun.from + 1, "month")}, low ${signed(lastRun.low.v)}` : `since ${mLabel(all[0].i)}`),
    dstat("Months below the line", `${belowRecent} of ${recent.length}`, `since ${mLabel(since)}`));
  const r12 = new Map(all.map((p) => [p.i, p.v]));
  const entries = journalEntries().reverse();
  put("journal-list", entries.length ? h("ul", { class: "journal" }, entries.map((e) => {
    const at = Math.min(e.i, m.complete); // the gauge as the data reads now, at the latest complete month then
    return h("li", {},
      h("p", { class: "journal-when" }, DAY.format(dayOf(e.date)), r12.has(at) ? h("span", { class: "muted" }, ` · 12-month net to ${mLabel(at)}: ${signed(r12.get(at))}`) : null),
      h("p", {}, e.text));
  })) : h("p", { class: "chart-note" }, "No entries yet."));
  $("journal-note").replaceChildren("To change the trigger or add an entry, edit ", h("a", { href: JOURNAL_EDIT }, "data/journal.json"),
    " on GitHub (a date and a sentence per entry) and commit to main; GitHub Pages rebuilds the page within a minute. A year on, the list shows whether acting on the gauge helped.");
  $("table-journal").replaceChildren(runs.length ? tableDetails("Show the periods below the line as a table",
    table(`Periods when the 12-month net was below your trigger (${signed(t)})`, ["From", "To", "Months", "Lowest"],
      runs.slice().reverse().map((x) => [mLabel(x.from), x.to === now.i ? `${mLabel(x.to)} (now)` : mLabel(x.to), count(x.to - x.from + 1), sv(x.low.v)]))) : null);
}

/* ---------- Buying and the price ---------- */

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
function pearson(xs, ys) {
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let k = 0; k < xs.length; k++) { const dx = xs[k] - mx, dy = ys[k] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}
const rho2 = (v) => `${v >= 0 ? "+" : MINUS}${Math.abs(v).toFixed(2)}`;

function renderPrice(m, r) {
  const sec = $("price");
  const price = new Map((r?.price || []).map((p) => [p.i, p.v]));
  if (!price.size) { sec.hidden = true; return; }
  const start = Math.max(m.turn ?? m.first + 12, Math.min(...price.keys()) + 1);
  const pts = [];
  for (let i = start; i <= m.complete; i++) {
    if (!price.has(i) || !price.has(i - 1)) continue;
    pts.push({ i, x: price.get(i) / price.get(i - 1) - 1, y: m.months.get(i).net, p: price.get(i) });
  }
  if (pts.length < 24) { sec.hidden = true; return; }
  const rho = pearson(pts.map((p) => p.x), pts.map((p) => p.y));
  const buckets = [
    { name: "Price fell more than 3%", test: (x) => x <= -0.03 },
    { name: "Fell up to 3%", test: (x) => x > -0.03 && x < 0 },
    { name: "Rose up to 3%", test: (x) => x >= 0 && x < 0.03 },
    { name: "Rose more than 3%", test: (x) => x >= 0.03 },
  ].map((b) => { const inb = pts.filter((p) => b.test(p.x)); return { ...b, n: inb.length, v: mean(inb.map((p) => p.y)) }; });
  const fell = buckets[0], rose = buckets[3];
  const verdict = fell.n >= 5 && rose.n >= 5
    ? (fell.v - rose.v >= 5 ? `On average they added more in months when the price fell sharply (${signed(fell.v)}) than when it rose sharply (${signed(rose.v)}): some buying of dips.`
      : rose.v - fell.v >= 5 ? `On average they added more in months when the price rose sharply (${signed(rose.v)}) than when it fell sharply (${signed(fell.v)}): they have tended to follow the price, not fade it.`
        : `Average buying was about the same whether the price fell sharply (${signed(fell.v)}) or rose sharply (${signed(rose.v)}).`)
    : "Too few sharp moves to compare.";
  $("price-sub").textContent = `Each dot is a month since ${mLabel(start)}: how much the implied gold price moved that month (across) against how much gold central banks reported adding (up). `
    + `Correlation ${rho2(rho)} over ${pts.length} months${Math.abs(rho) < 0.15 ? ", essentially none" : Math.abs(rho) < 0.3 ? ", weak" : ""}. ${verdict}`;
  put("price-stats",
    dstat("Correlation", rho2(rho), `monthly, ${mLabel(start)} to ${mLabel(m.complete)}`),
    dstat("Price fell > 3%", signed(fell.v), `average month · ${plural(fell.n, "month")}`),
    dstat("Price rose > 3%", signed(rose.v), `average month · ${plural(rose.n, "month")}`),
    dstat("All months", signed(mean(pts.map((p) => p.y))), "average reported net change"));
  scatterChart($("chart-price-scatter"), {
    points: pts,
    label: `Scatter chart of monthly reported central bank gold buying against the month's gold price change, ${mLabel(start)} to ${mLabel(m.complete)}.`,
    xLabel: "gold price change in the month", yLabel: "net reported change, t",
    cls: (p) => (p.y >= 0 ? "buy" : "sell"),
    tipTitle: (p) => mLabel(p.i),
    tipRows: (p) => [{ value: signed(p.y), label: "reported net change", key: p.y >= 0 ? "buy" : "sell" }, { value: pct1(p.x), label: `price move, to ${usd(p.p)}/oz` }],
  });
  hbarChart($("chart-price-buckets"), {
    rows: buckets,
    label: "Bar chart of average monthly reported central bank buying, grouped by how the gold price moved that month.",
    tipRows: (b) => [{ value: signed(b.v), label: "average month", key: b.v >= 0 ? "buy" : "sell" }, { value: count(b.n), label: "months" }],
  });
  // Seasonality: the average reported change in each calendar month, over whole years only.
  const y0 = yearOf(start) + (start % 12 ? 1 : 0), y1 = yearOf(m.complete) - (m.complete % 12 === 11 ? 0 : 1);
  const season = Array.from({ length: 12 }, (_, k) => {
    const vals = [];
    for (let y = y0; y <= y1; y++) vals.push({ y, v: m.months.get(y * 12 + k).net });
    const best = vals.reduce((a, b) => (b.v > a.v ? b : a), vals[0]), worst = vals.reduce((a, b) => (b.v < a.v ? b : a), vals[0]);
    return { i: k, label: MONTH_ONLY.format(asDate(k)), v: mean(vals.map((x) => x.v)), n: vals.length, best, worst };
  });
  const top = season.reduce((a, b) => (b.v > a.v ? b : a), season[0]), low = season.reduce((a, b) => (b.v < a.v ? b : a), season[0]);
  $("season-sub").textContent = `Average reported net change by calendar month, ${y0} to ${y1}. Strongest ${top.label} (${signed(top.v)}), weakest ${low.label} (${signed(low.v)}). `
    + "A quiet month that is usually quiet is not a signal.";
  columnChart($("chart-season"), {
    bars: season, axis: "labels", height: 220,
    label: `Column chart of the average monthly reported central bank gold change by calendar month, ${y0} to ${y1}.`,
    tipTitle: (b) => `${b.label}, average of ${plural(b.n, "year")}`,
    tipRows: (b) => [{ value: signed(b.v), label: "average month", key: b.v >= 0 ? "buy" : "sell" },
      { value: signed(b.best.v), label: `most: ${b.best.y}` }, { value: signed(b.worst.v), label: `least: ${b.worst.y}` }],
  });
  $("table-price").replaceChildren(tableDetails("Show as a table",
    table(`Monthly reported change and price move, ${mLabel(start)} to ${mLabel(m.complete)}`, ["Month", "Reported net change", "Price change", "Implied price"],
      pts.slice().reverse().map((p) => [mLabel(p.i), sv(p.y), pct1(p.x), `${usd(p.p)}/oz`]), { scroll: true })));
}

/* ---------- Data quality: revisions and the reporting calendar (data/changes.json) ---------- */

const monthEnd = (key) => { const i = idx(key) + 1; return Date.UTC(yearOf(i), i % 12, 1) - DAY_MS; };
const median = (a) => { if (!a.length) return undefined; const q = a.slice().sort((x, y) => x - y), k = q.length >> 1; return q.length % 2 ? q[k] : (q[k - 1] + q[k]) / 2; };
const emptyChart = (el, text) => { el.chartObserver?.disconnect(); el.replaceChildren(text ? h("p", { class: "chart-note" }, text) : null); };

function renderQuality(m, changes) {
  const entries = (changes || []).filter((e) => e.date).slice().sort((a, b) => a.date.localeCompare(b.date));
  const byCode = new Map(m.holders.map((d) => [d.code, d]));
  // Every figure that arrived since the log began, against what the IMF shows for it now; every
  // revision the job recorded; and how long after month end each holder's figures tend to arrive.
  const firstPrint = new Map(), events = [], lags = new Map();
  for (const e of entries) {
    for (const x of e.items || []) {
      if (x.kind === "new") {
        const key = `${x.code}|${x.month}`;
        if (!firstPrint.has(key)) firstPrint.set(key, { code: x.code, month: x.month, t: x.t, date: e.date });
        const lag = Math.round((dayOf(e.date) - monthEnd(x.month)) / DAY_MS);
        if (lag >= 0 && lag < 400) lags.set(x.code, [...(lags.get(x.code) || []), lag]);
      } else if (x.kind === "revised") events.push({ code: x.code, month: x.month, was: x.was, t: x.t, date: e.date });
    }
  }
  const drift = [...firstPrint.values()].map((f) => {
    const now = byCode.get(f.code)?.s.get(idx(f.month));
    return { ...f, now, d: now === undefined ? undefined : now - f.t };
  });
  const revised = drift.filter((x) => x.d === undefined || Math.abs(x.d) >= 0.05);
  const sized = revised.filter((x) => x.d !== undefined).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  const sizes = sized.map((x) => Math.abs(x.d));
  const since = entries[0]?.date;
  $("revisions-sub").textContent = entries.length
    ? `Every figure that arrived since ${DAY.format(dayOf(since))} is compared with what the IMF shows for it now: ${plural(drift.length, "figure")} tracked, ${revised.length} later revised or withdrawn. `
      + (sizes.length ? `Typical revision ${tonnes(median(sizes))}; largest ${sv(sized[0].d).textContent} (${nameOf(sized[0].code)}, ${mLabel(idx(sized[0].month))}). ` : "")
      + "Revisions say how far to trust the newest month before it has settled."
    : "The daily job hasn't recorded an update yet, so there is nothing to compare. This fills in as figures arrive and get revised.";
  put("revisions-stats",
    dstat("Figures tracked", count(drift.length), since ? `since ${DAY.format(dayOf(since))}` : "none yet"),
    dstat("Revised since first print", drift.length ? `${count(revised.length)} (${pct(revised.length / drift.length)})` : "–", "by 0.05 t or more, or withdrawn"),
    dstat("Typical revision", sizes.length ? tonnes(median(sizes)) : "–", "median size"),
    dstat("Revision events", count(events.length), "recorded by the daily job"));
  const top = sized.slice(0, 10).map((x) => ({ name: `${nameOf(x.code)} · ${mLabel(idx(x.month))}`, v: x.d, x }));
  if (top.length) {
    hbarChart($("chart-revisions"), { rows: top, label: "Bar chart of the largest revisions since first print, tonnes.",
      tipRows: (q) => [{ value: sv(q.v).textContent, label: "since first print", key: q.v >= 0 ? "buy" : "sell" },
        { value: tonnes(q.x.t), label: `first print, ${DAY.format(dayOf(q.x.date))}` }, { value: tonnes(q.x.now), label: "now" }] });
  } else emptyChart($("chart-revisions"), "No revisions recorded yet.");
  $("table-revisions").replaceChildren(events.length ? tableDetails("Show revision events as a table",
    table("Revisions recorded by the daily job", ["Recorded", "Holder", "Month", "Was", "Now", "Change"],
      events.slice().reverse().map((x) => [DAY.format(dayOf(x.date)), nameOf(x.code), mLabel(idx(x.month)), tonnes(x.was), tonnes(x.t), sv(x.t - x.was)]), { scroll: true })) : null);

  // The calendar: who still has to file for the next month to count, and how late each usually is.
  const active = m.holders.filter((d) => !d.stale);
  const totalA = active.reduce((a, d) => a + d.activity, 0);
  const next = m.complete < m.newest ? m.complete + 1 : null;
  const missing = next === null ? [] : active.filter((d) => !d.s.has(next)).sort((a, b) => b.activity - a.activity);
  const need = [];
  let cov = next === null ? 1 : m.months.get(next).coverage;
  for (const d of missing) { if (cov >= COVERAGE_MIN) break; cov += d.activity / totalA; need.push(d); }
  const typical = (code) => median(lags.get(code) || []);
  const allLags = [...lags.values()].flat();
  const behind = active.filter((d) => m.newest - d.last >= 2).length;
  $("calendar-sub").textContent = next === null
    ? `Every month up to ${mLabel(m.newest)} is complete.`
    : `${mLabel(next)} is ${pct(m.months.get(next).coverage)} reported by activity weight and needs ${pct(COVERAGE_MIN)} to enter the totals. `
      + (need.length ? `${need.map((d) => d.name).join(", ")} ${need.length === 1 ? "alone would" : "together would"} take it over the line; ` : "")
      + `${plural(missing.length, "active holder")} still to file. Weights are each holder's buying and selling over its own last 12 months, so the US (which never changes) weighs nothing and Turkey weighs a lot.`;
  put("calendar-stats",
    dstat("Next month to complete", next === null ? "–" : mLabel(next), next === null ? "all months complete" : `${pct(m.months.get(next).coverage)} reported`),
    dstat("Filers needed", next === null ? "–" : count(need.length), need.length ? need.slice(0, 3).map((d) => d.name).join(", ") : "the line is reached"),
    dstat("Holders 2+ months behind", count(behind), `of ${active.length} active`),
    dstat("Typical delay", allLags.length ? `${Math.round(median(allLags))} days` : "learning", allLags.length ? `after month end · ${plural(allLags.length, "filing")} seen` : "measured as filings arrive"));
  if (missing.length) {
    hbarChart($("chart-calendar"), { rows: missing.slice(0, 12).map((d) => ({ name: d.name, v: d.activity / totalA, d })), neutral: true, fmt: pct1,
      label: `Bar chart of the activity weight of holders that have not yet reported ${mLabel(next)}.`,
      tipRows: (q) => [{ value: pct1(q.v), label: "share of activity weight" }, { value: mLabel(q.d.last), label: "latest report" },
        ...(typical(q.d.code) !== undefined ? [{ value: `${Math.round(typical(q.d.code))} days`, label: "usual delay after month end" }] : [])] });
  } else emptyChart($("chart-calendar"));
  $("table-calendar").replaceChildren(tableDetails("Show every active holder as a table",
    table(`Active holders (reported within ${STALE_MONTHS} months of ${mLabel(m.newest)}), by activity weight`,
      ["Holder", "Latest month", "Months behind", "Weight", ...(next === null ? [] : [`Filed ${MONTH_ONLY.format(asDate(next))}?`]), "Usual delay"],
      active.slice().sort((a, b) => b.activity - a.activity).map((d) => [d.name, mLabel(d.last), count(m.newest - d.last), pct1(d.activity / totalA),
        ...(next === null ? [] : [d.s.has(next) ? "yes" : "–"]), typical(d.code) !== undefined ? `${Math.round(typical(d.code))} days` : "–"]), { scroll: true })));
}

/* ---------- Gold against the dollar: US Treasuries (TIC) and reserve currencies (COFER) ---------- */

const bn = (v) => usdMn(v * 1000); // TIC values are US$ billions
const bnTick = (v) => (v === 0 ? "0" : `$${(v / 1000).toLocaleString("en", { maximumFractionDigits: 1 })} tn`);
const signedBn = (v) => `${isZero(v) ? "" : v > 0 ? "+" : MINUS}$${NF0.format(Math.abs(v))} bn`;
const qIdx = (q) => Number(q.slice(0, 4)) * 12 + Number(q.slice(-1)) * 3 - 1; // "2026-Q2" -> its last month
const qName = (q) => q.replace("-", " ");

function renderDollar(m, r, tic, cofer) {
  const sec = $("dollar");
  const tm = (tic?.months || []).filter((x) => Number.isFinite(x[1])).map(([k, off, tot]) => ({ i: idx(k), v: off, tot }));
  const cq = (cofer?.quarters || []).filter((x) => Number.isFinite(x[1]?.USD)).map(([q, d]) => ({ q, i: qIdx(q), ...d }));
  if (tm.length < 24 && cq.length < 8) { sec.hidden = true; return; }
  const stats = [];
  const goldOver = (from, to) => (to <= m.complete && from >= m.first ? signed(m.sumNet(from, to)) : null);
  if (tm.length >= 24) {
    const last = tm.at(-1), ago = tm.find((p) => p.i === last.i - 12), peak = tm.reduce((a, p) => (p.v >= a.v ? p : a), tm[0]);
    const freeze = tm.find((p) => p.i === idx("2022-02"));
    const d12 = ago ? last.v - ago.v : null;
    const g12 = goldOver(last.i - 11, last.i), gFreeze = freeze ? goldOver(freeze.i + 1, last.i) : null;
    stats.push(dstat("US Treasuries, foreign official", bn(last.v), `${mLabel(last.i)} · ${pct(last.v / last.tot)} of all foreign-held`),
      d12 !== null ? dstat("12 months", h("span", { class: tone(d12, 0.5) }, `${arrow(d12, 0.5)} ${signedBn(d12)}`), g12 ? `gold reported ${g12} over the same months` : null) : null,
      dstat("Peak", bn(peak.v), `${mLabel(peak.i)} · ${signedBn(last.v - peak.v)} since`),
      freeze ? dstat("Since Feb 2022", h("span", { class: tone(last.v - freeze.v, 0.5) }, `${arrow(last.v - freeze.v, 0.5)} ${signedBn(last.v - freeze.v)}`), `Russia's reserves frozen${gFreeze ? `; gold reported ${gFreeze}` : ""}`) : null);
    $("treasuries-sub").textContent = `What foreign central banks, finance ministries and sovereign funds hold in US Treasury securities, ${mLabel(tm[0].i)} to ${mLabel(last.i)} (US Treasury TIC data, attributed by custodian country). `
      + `Peak ${bn(peak.v)} in ${mLabel(peak.i)}; ${bn(last.v)} now. Flat holdings while US debt grew mean a shrinking share of it; over the same years reported gold rose.`;
    lineChart($("chart-treasuries"), {
      points: tm, height: 240, fmtTick: bnTick, endLabel: (p) => bn(p.v),
      label: `Line chart of foreign official holdings of US Treasury securities, ${mLabel(tm[0].i)} to ${mLabel(last.i)}. Latest ${bn(last.v)}.`,
      tipRows: (p) => [{ value: bn(p.v), label: "foreign official", key: "line" }, { value: bn(p.tot), label: "all foreign holders" }, { value: pct(p.v / p.tot), label: "official share" }],
    });
    const byI = new Map(tm.map((p) => [p.i, p.v]));
    const chg = tm.filter((p) => byI.has(p.i - 12)).map((p) => ({ i: p.i, v: p.v - byI.get(p.i - 12) }));
    columnChart($("chart-treasuries-change"), {
      bars: chg, height: 200, fmtTick: tickText,
      label: `Column chart of the 12-month change in foreign official holdings of US Treasuries, US$ billions, ${mLabel(chg[0].i)} to ${mLabel(chg.at(-1).i)}.`,
      tipRows: (b) => [{ value: signedBn(b.v), label: "12-month change", key: b.v >= 0 ? "buy" : "sell" },
        ...(goldOver(b.i - 11, b.i) ? [{ value: goldOver(b.i - 11, b.i), label: "gold reported, same 12 months" }] : [])],
    });
  } else $("treasuries-block").hidden = true;
  if (cq.length >= 8) {
    const last = cq.at(-1), ago = cq.find((p) => p.i === last.i - 12), first = cq[0];
    stats.push(dstat("US dollar share of FX reserves", pct1(last.USD / 100), `${qName(last.q)} · IMF COFER`),
      ago ? dstat("Dollar share, 4 quarters", h("span", { class: tone(last.USD - ago.USD, 0.05) }, `${arrow(last.USD - ago.USD, 0.05)} ${pts((last.USD - ago.USD) / 100)}`), `${pct1(ago.USD / 100)} in ${qName(ago.q)}`) : null,
      dstat(`Since ${qName(first.q)}`, pts((last.USD - first.USD) / 100), `from ${pct1(first.USD / 100)} · euro ${pct1(last.EUR / 100)}, renminbi ${pct1((last.CNY || 0) / 100)}`));
    if (r?.worldSeries?.length) {
      const g = r.worldSeries.at(-1);
      stats.push(dstat("Gold share of total reserves", pct1(g.v), `${mLabel(g.i)} · this page; COFER counts currencies only`));
    }
    $("cofer-sub").textContent = `Which currencies the world's foreign exchange reserves are held in, ${qName(first.q)} to ${qName(last.q)} (IMF COFER, shares of the reserves whose currency is reported; gold is not part of it). `
      + `The dollar: ${pct1(first.USD / 100)} then, ${pct1(last.USD / 100)} now. What left the dollar went mostly to smaller currencies and, outside this chart, to gold.`;
    const series = [
      { name: "US dollar", cls: "", key: "USD" },
      { name: "Euro", cls: "s2", key: "EUR" },
      { name: "All other currencies", cls: "s3", key: null },
    ].map((sr) => ({ ...sr, points: cq.map((p) => ({ i: p.i, v: (sr.key ? p[sr.key] : 100 - p.USD - p.EUR) / 100, q: p.q })) }));
    $("cofer-legend").replaceChildren(...series.map((sr) => h("span", {}, h("i", { class: sr.cls, "aria-hidden": "true" }), sr.name)));
    multiLineChart($("chart-cofer"), {
      series, height: 260, fmt: pct1, fmtTick: pctTick,
      tipTitle: (p) => qName(p.q),
      label: `Line chart of the US dollar, euro and other currencies' shares of world foreign exchange reserves, ${qName(first.q)} to ${qName(last.q)}.`,
      tipExtra: (k) => [{ value: pct1((cq[k].CNY || 0) / 100), label: "of which renminbi" },
        ...(Number.isFinite(cq[k].allocated) ? [{ value: bn(cq[k].allocated), label: "allocated reserves" }] : [])],
    });
  } else $("cofer-block").hidden = true;
  put("dollar-stats", stats);
  const years = [...new Set([...tm.map((p) => yearOf(p.i)), ...cq.map((p) => yearOf(p.i))])].sort((a, b) => b - a);
  const byI = new Map(tm.map((p) => [p.i, p.v]));
  const rows = years.map((y) => {
    const t = tm.findLast((p) => yearOf(p.i) === y), c = cq.findLast((p) => yearOf(p.i) === y);
    return [String(y), t ? `${MONTH_ONLY.format(asDate(t.i))}: ${bn(t.v)}` : "–", t && byI.has(t.i - 12) ? signedBn(t.v - byI.get(t.i - 12)) : "–",
      c ? pct1(c.USD / 100) : "–", c ? pct1(c.EUR / 100) : "–", c && c.CNY != null ? pct1(c.CNY / 100) : "–", (t && goldOver(t.i - 11, t.i)) || "–"];
  });
  $("table-dollar").replaceChildren(tableDetails("Show year ends as a table",
    table("Foreign official US Treasury holdings, reserve currency shares and reported gold buying, at each year's latest figure",
      ["Year", "Treasuries, foreign official", "12-month change", "US dollar share", "Euro share", "Renminbi share", "Gold reported, 12 months"], rows, { scroll: true })));
}

/* ---------- Reported vs all central bank buying (WGC estimate, data/wgc_central_banks.json) ---------- */

function renderUnreported(m, wgc) {
  const sec = $("unreported");
  const qs = Object.entries(wgc?.quarterly || {}).filter(([q, v]) => /^\d{4}-Q[1-4]$/.test(q) && Number.isFinite(v?.[0]))
    .map(([q, [v, from]]) => ({ q, i: qIdx(q), v, from })).sort((a, b) => a.i - b.i);
  const ys = Object.entries(wgc?.annual || {}).filter(([y, v]) => /^\d{4}$/.test(y) && Number.isFinite(v?.[0]))
    .map(([y, [v, from]]) => ({ y: Number(y), v, from })).sort((a, b) => a.y - b.y);
  if (!qs.length && !ys.length) { sec.hidden = true; return; }
  for (const x of qs) x.rep = x.i <= m.complete && x.i - 2 > m.first ? m.sumNet(x.i - 2, x.i) : null;
  for (const x of ys) { const yr = m.years.find((z) => z.i === x.y && !z.partial); x.rep = yr ? yr.v : null; }
  const both = qs.filter((x) => x.rep !== null), latest = both.at(-1), last4 = both.slice(-4);
  const sumW = (a) => a.reduce((t, x) => t + x.v, 0), sumR = (a) => a.reduce((t, x) => t + x.rep, 0);
  const hidden = (w, rp) => (w > 0 ? pct(Math.max(0, 1 - rp / w)) : "–");
  const latestY = ys.filter((x) => x.rep !== null).at(-1);
  $("unreported-sub").textContent = latest
    ? `The World Gold Council estimates all central bank buying, including purchases no country reports; this page counts only what reaches the IMF. ${qName(latest.q)}: WGC ${signed(latest.v)}, reported ${signed(latest.rep)}, so about ${hidden(latest.v, latest.rep)} of the quarter's buying was not disclosed by country. `
      + `Over the last ${plural(last4.length, "quarter")}: ${signed(sumW(last4))} estimated against ${signed(sumR(last4))} reported (${hidden(sumW(last4), sumR(last4))} undisclosed).`
    : "The World Gold Council's estimate of all central bank buying against what is reported to the IMF.";
  put("unreported-stats",
    latest ? dstat(`WGC estimate, ${qName(latest.q)}`, signed(latest.v), `from the ${latest.from} report`) : null,
    latest ? dstat(`Reported to the IMF, ${qName(latest.q)}`, signed(latest.rep), "this page's count") : null,
    latest ? dstat("Not disclosed by country", hidden(latest.v, latest.rep), `${qName(latest.q)} · ${hidden(sumW(last4), sumR(last4))} over the last ${last4.length} quarters`) : null,
    latestY ? dstat(`${latestY.y}, whole year`, `${signed(latestY.v)} vs ${signed(latestY.rep)}`, `WGC estimate vs reported · ${hidden(latestY.v, latestY.rep)} undisclosed`) : null);
  if (qs.length >= 4) {
    const series = [
      { name: "WGC estimate, all central banks", cls: "s2", points: qs.map((x) => ({ i: x.i, v: x.v, q: x.q })) },
      { name: "Reported to the IMF (this page)", cls: "", points: qs.map((x) => ({ i: x.i, v: x.rep, q: x.q })) },
    ];
    $("unreported-legend").replaceChildren(...series.map((sr) => h("span", {}, h("i", { class: sr.cls, "aria-hidden": "true" }), sr.name)));
    multiLineChart($("chart-unreported"), {
      series, height: 240, tipTitle: (p) => qName(p.q),
      label: `Line chart of quarterly central bank gold buying, World Gold Council estimate against the IMF-reported total, ${qName(qs[0].q)} to ${qName(qs.at(-1).q)}.`,
      tipExtra: (k) => (qs[k].rep !== null ? [{ value: hidden(qs[k].v, qs[k].rep), label: "not disclosed by country" }] : [{ value: "–", label: "quarter not yet complete in the IMF data" }]),
    });
  } else emptyChart($("chart-unreported"));
  $("unreported-note").replaceChildren(`Hand-kept: the WGC figures are typed in from its Gold Demand Trends report pages (the data tables behind them need a login), each the latest revision found there${wgc.entered ? `, last entered ${DAY.format(dayOf(wgc.entered))}` : ""}. `,
    "The WGC revises past quarters as buying comes to light, sometimes by a lot. Edit ", h("a", { href: "https://github.com/Vasuki8/gold-tracker/edit/main/data/wgc_central_banks.json" }, "data/wgc_central_banks.json"), " after each quarterly report.");
  const row = (x, name) => [name, signed(x.v), x.rep === null ? "–" : signed(x.rep), x.rep === null ? "–" : hidden(x.v, x.rep), x.from];
  $("table-unreported").replaceChildren(
    qs.length ? tableDetails("Show quarters as a table", table("Quarterly central bank buying: WGC estimate vs reported to the IMF, tonnes", ["Quarter", "WGC estimate", "Reported", "Not disclosed", "WGC figure from"],
      qs.slice().reverse().map((x) => row(x, qName(x.q))), { scroll: true })) : null,
    ys.length ? tableDetails("Show years as a table", table("Yearly central bank buying: WGC estimate vs reported to the IMF, tonnes", ["Year", "WGC estimate", "Reported", "Not disclosed", "WGC figure from"],
      ys.slice().reverse().map((x) => row(x, String(x.y))))) : null);
}

async function getJSON(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// data/fetch_log.csv -> [{run_at_utc, result, ...}]; the daily job's own record of its runs.
async function getLog(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const [head, ...rows] = (await res.text()).trim().split(/\r?\n/);
  const keys = head.split(",");
  return rows.filter(Boolean).map((line) => Object.fromEntries(line.split(",").map((v, k) => [keys[k], v])));
}

async function main() {
  let raw, rr = null, log = null, changes = null, journal = null, tic = null, cofer = null, wgc = null;
  try {
    [raw, rr, log, changes, journal, tic, cofer, wgc] = await Promise.all([getJSON(DATA_URL), getJSON(RESERVES_URL).catch(() => null),
      getLog("data/fetch_log.csv").catch(() => null), getJSON(CHANGES_URL).catch(() => null), getJSON(JOURNAL_URL).catch(() => null),
      getJSON(TIC_URL).catch(() => null), getJSON(COFER_URL).catch(() => null), getJSON(WGC_URL).catch(() => null)]);
  } catch (err) {
    const f = $("ticker");
    f.textContent = `Couldn't load ${DATA_URL} (${err.message}). If you opened this file directly, serve the folder over HTTP instead.`;
    f.classList.add("error");
    return;
  }
  const m = buildModel(raw);
  const r = buildReserves(rr, m);
  JOURNAL = journal;
  renderTicker(m, r);
  renderHero(m);
  renderStatGroups(m, r, log);
  renderFreshness(m);
  renderRolling(m, r);
  wireTrendRange(m, r);
  renderJournal(m, journal);
  renderUnreported(m, wgc);
  renderYears(m);
  renderMonthly(m);
  renderPrice(m, r);
  renderUpdates(changes);
  renderQuality(m, changes);
  renderWho(m);
  renderGroups(m);

  const sel = $("country-select");
  for (const d of m.holders.slice().sort((a, b) => b.latest - a.latest)) {
    sel.append(h("option", { value: d.code }, `${d.name} · ${tonnes(d.latest)}`));
  }
  const topBuyer = m.byCountry.slice().sort((a, b) => b.v - a.v)[0];
  const defaultHolder = topBuyer ? topBuyer.d.code : "USA";
  const select = (code, scroll) => {
    sel.value = code;
    renderCountry(m, r, code);
    setParam("holder", code === defaultHolder ? null : code);
    if (scroll) $("country").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  };
  sel.addEventListener("change", () => select(sel.value, false));
  renderMomentum(m, select);
  renderBreadth(m);
  if (r && r.worldSeries.length) renderShare(m, r);
  else $("reserves").hidden = true;
  renderDollar(m, r, tic, cofer);
  renderBoard(m, r, select);
  const asked = params.get("holder");
  select(m.holders.some((d) => d.code === asked) ? asked : defaultHolder, false);
  setupCompare(m);
  renderNotes(m, r);
  scrollSpy();
  // A shared link with #section: the page was empty when the browser tried to jump there.
  if (location.hash && $(location.hash.slice(1))) $(location.hash.slice(1)).scrollIntoView();
  loadProduction(m, r); // these two last, and not awaited: other sources must never hold up the IMF sections
  loadFunds();
}

main();
