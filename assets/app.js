"use strict";
/* Central bank gold tracker. Reads data/gold_tonnes.json and data/reserves_usd.json (written
   daily by spike/fetch_irfcl.py and spike/fetch_reserves.py) and draws everything client-side:
   no build step, no libraries. */

const DATA_URL = "data/gold_tonnes.json";
const RESERVES_URL = "data/reserves_usd.json";
const COVERAGE_MIN = 0.9; // a month counts once holders with 90% of the past year's activity have filed it
const STALE_MONTHS = 6; // nothing reported this long before the newest month: stale, left out of coverage
const BRIDGE_MONTHS = 3; // a change may span up to 3 missing months (dropped or unreported values)
const TOP_N = 15;
const BUY_T = 0.1; // a month with an increase of at least 0.1 t counts as a purchase
const OZ_PER_TONNE = 32150.7466;

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
  AGO: "Angola", UZB: "Uzbekistan", G163: "Euro area",
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
const pct = (v) => `${Math.round(v * 100)}%`;
const pct1 = (v) => `${(v * 100).toFixed(1)}%`;
const pts = (v) => `${v >= 0 ? "+" : MINUS}${Math.abs(v * 100).toFixed(1)} pts`;
const usd = (v) => `$${NF0.format(v)}`;
const usdMn = (mn) => (mn >= 1e6 ? `$${(mn / 1e6).toFixed(2)} tn` : mn >= 1e3 ? `$${NF0.format(mn / 1e3)} bn` : `$${NF0.format(mn)} M`);
const tickText = (v) => `${v < 0 ? MINUS : ""}${NF0.format(Math.abs(v))}`;
const pctTick = (v) => `${Math.round(v * 100)}%`;
const usdTick = (v) => `$${NF0.format(v)}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
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

  return { raw, holders, newest, first, complete, months, rolling12, groupRolling, win, byCountry, regions, years,
    worldTotal, marks, turn: turnIdx >= 0 ? rolling12[turnIdx].i : null, sumNet, valueAt, change };
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

// Renders on mount and again whenever the container's width changes.
function mountChart(container, draw) {
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
  new ResizeObserver(() => requestAnimationFrame(render)).observe(container);
  render();
}

function fillTip(tip, title, rows) {
  tip.replaceChildren(
    h("div", { class: "tt-title" }, title),
    ...rows.map((r) => (r === "sep" ? h("div", { class: "tt-sep" })
      : h("div", { class: "tt-row" },
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
  const years = [];
  for (let yr = yearOf(x0); yr <= yearOf(x1); yr++) if (yr * 12 >= x0 && yr * 12 <= x1) years.push(yr);
  if (!years.length) return;
  const perYear = Math.abs(X(12) - X(0));
  const every = [1, 2, 5, 10].find((n) => perYear * n >= 44) || 10;
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
    cls = "", bands = [], marks = [], yMax } = opts;
  mountChart(container, (W, tip) => {
    const narrow = W < 520;
    const M = { t: marks.length ? 30 : 14, r: endLabel ? (narrow ? 60 : 72) : 16, b: 30, l: 52 };
    const pw = W - M.l - M.r, ph = height - M.t - M.b;
    const x0 = points[0].i, x1 = points.at(-1).i;
    const X = (i) => M.l + (x1 === x0 ? pw / 2 : ((i - x0) / (x1 - x0)) * pw);
    const vs = points.map((p) => p.v);
    const yt = niceTicks(Math.min(0, ...vs), Math.max(0, ...vs, yMax ?? -Infinity), narrow ? 4 : 5);
    const Y = (v) => M.t + ph - ((v - yt.lo) / (yt.hi - yt.lo)) * ph;
    const svg = s("svg", { width: W, height, viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": label });
    for (const b of bands) {
      const bx0 = X(Math.max(b.from, x0)), bx1 = X(Math.min(b.to, x1));
      svg.append(s("rect", { x: bx0, y: M.t, width: Math.max(0, bx1 - bx0), height: ph, class: "band" }));
      if (b.label && bx1 - bx0 > 150) svg.append(s("text", { x: bx0 + 8, y: M.t + ph - 10, class: "band-label" }, b.label));
    }
    yGrid(svg, yt, Y, M.l, M.l + pw, fmtTick);
    yearAxis(svg, x0, x1, (i) => X(i), M.t + ph);
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
      s("path", { d: `${d}L${X(x1).toFixed(1)},${Y(0)}L${X(x0).toFixed(1)},${Y(0)}Z`, class: `area ${cls}` }),
      s("path", { d, class: `line ${cls}` }),
    );
    const last = points.at(-1);
    svg.append(s("circle", { cx: X(last.i), cy: Y(last.v), r: 4, class: `dot ${cls}` }));
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

// Two or more series on one axis, one shared crosshair; the tooltip lists every series.
function multiLineChart(container, { series, label, height = 280, fmt = signed, fmtTick = tickText, tipExtra }) {
  mountChart(container, (W, tip) => {
    const narrow = W < 520;
    const M = { t: 14, r: narrow ? 60 : 72, b: 30, l: 52 };
    const pw = W - M.l - M.r, ph = height - M.t - M.b;
    const base = series[0].points;
    const x0 = base[0].i, x1 = base.at(-1).i;
    const X = (i) => M.l + ((i - x0) / Math.max(1, x1 - x0)) * pw;
    const vs = series.flatMap((sr) => sr.points.map((p) => p.v));
    const yt = niceTicks(Math.min(0, ...vs), Math.max(0, ...vs), narrow ? 4 : 5);
    const Y = (v) => M.t + ph - ((v - yt.lo) / (yt.hi - yt.lo)) * ph;
    const svg = s("svg", { width: W, height, viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": label });
    yGrid(svg, yt, Y, M.l, M.l + pw, fmtTick);
    yearAxis(svg, x0, x1, (i) => X(i), M.t + ph);
    const ends = [];
    for (const sr of series) {
      const d = sr.points.map((p, k) => `${k ? "L" : "M"}${X(p.i).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
      svg.append(s("path", { d, class: `line ${sr.cls}` }));
      const last = sr.points.at(-1);
      svg.append(s("circle", { cx: X(last.i), cy: Y(last.v), r: 4, class: `dot ${sr.cls}` }));
      ends.push({ y: Y(last.v), text: fmt(last.v), x: X(last.i) });
    }
    // Direct end labels only when they don't collide; the legend and tooltip carry identity anyway.
    const clash = ends.some((a, k) => ends.some((b, j) => j > k && Math.abs(a.y - b.y) < 14));
    if (!clash) for (const e of ends) svg.append(s("text", { x: e.x + 9, y: e.y, class: "end-label", "dominant-baseline": "middle" }, e.text));
    const cross = s("line", { y1: M.t, y2: M.t + ph, class: "cross", visibility: "hidden" });
    const hots = series.map((sr) => s("circle", { r: 4, class: `dot ${sr.cls}`, visibility: "hidden" }));
    svg.append(cross, ...hots);
    hoverLayer(svg, {
      positions: base.map((p) => X(p.i)),
      show(k) {
        const x = X(base[k].i);
        cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("visibility", "visible");
        series.forEach((sr, j) => { const p = sr.points[k]; hots[j].setAttribute("cx", x); hots[j].setAttribute("cy", Y(p.v)); hots[j].setAttribute("visibility", "visible"); });
        fillTip(tip, mLabel(base[k].i), [
          ...series.map((sr) => ({ value: fmt(sr.points[k].v), label: sr.name, key: sr.cls || "buy" })),
          ...(tipExtra ? tipExtra(k) : []),
        ]);
        placeTip(tip, container, x, Math.min(...series.map((sr) => Y(sr.points[k].v))));
      },
      hide() {
        cross.setAttribute("visibility", "hidden"); hots.forEach((c) => c.setAttribute("visibility", "hidden"));
        tip.hidden = true;
      },
    });
    return svg;
  });
}

function columnChart(container, { bars, label, height = 240, tipRows, tipTitle = (b) => mLabel(b.i), axis = "months" }) {
  mountChart(container, (W, tip) => {
    const M = { t: 14, r: 8, b: 30, l: 52 };
    const pw = W - M.l - M.r, ph = height - M.t - M.b;
    const band = pw / bars.length;
    const bw = Math.max(2, Math.min(24, band - 2)); // at least a 2px surface gap between bars
    const vs = bars.map((b) => b.v);
    const yt = niceTicks(Math.min(0, ...vs), Math.max(0, ...vs), 4);
    const Y = (v) => M.t + ph - ((v - yt.lo) / (yt.hi - yt.lo)) * ph;
    const svg = s("svg", { width: W, height, viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": label });
    yGrid(svg, yt, Y, M.l, M.l + pw);
    const bx = (k) => M.l + band * k;
    if (axis === "years") {
      const every = [1, 2, 5, 10].find((n) => band * n >= 40) || 10;
      bars.forEach((b, k) => {
        if (b.i % every === 0 || k === bars.length - 1 && bars.length < 4) {
          svg.append(s("text", { x: bx(k) + band / 2, y: M.t + ph + 18, class: "tick", "text-anchor": "middle" }, String(b.i)));
        }
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
const tableDetails = (summary, tbl) => h("details", { class: "data-table" }, h("summary", {}, summary), tbl);

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
const group = (title, ...stats) => h("div", { class: "stat-group" }, h("h3", { class: "stat-group-title" }, title), ...stats.filter(Boolean));

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
      stat("Months of net buying", `${buyingMonths} of 12`, [`Net selling in ${12 - buyingMonths}`])),
    group("Who",
      stat("Top two share", pct(k.share), [`of gross reported buying: ${k.top2.map((x) => x.d.name).join(" and ")}`,
        h("div", { class: "meter", role: "img", "aria-label": `${pct(k.share)} share` }, h("span", { style: `width:${(k.share * 100).toFixed(1)}%` }))]),
      k.buyers[0] ? stat("Top buyer", k.buyers[0].d.name, [h("span", {}, sv(k.buyers[0].v), " over 12 months")]) : null,
      k.sellers[0] ? stat("Biggest seller", k.sellers[0].d.name, [h("span", {}, sv(k.sellers[0].v), " over 12 months")]) : null,
      stat("Regular buyers", String(regular), ["bought in 3+ of their last 12 months"])),
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

function renderRolling(m, years = 0) {
  const all = m.rolling12;
  const pts12 = years ? all.filter((p) => p.i > all.at(-1).i - years * 12) : all;
  lineChart($("chart-rolling"), {
    points: pts12,
    label: `Line chart of 12-month net reported central bank gold buying, ${mLabel(pts12[0].i)} to ${mLabel(pts12.at(-1).i)}. Latest ${signed(pts12.at(-1).v)}.`,
    endLabel: (p) => signed(p.v),
    bands: m.turn ? [{ from: pts12[0].i, to: m.turn, label: "Net selling, led by European central banks" }] : [],
    marks: m.marks,
    tipRows: (p) => [
      { value: signed(p.v), label: "12-month net", key: "buy" },
      { value: signed(m.months.get(p.i).net), label: "that month" },
    ],
  });
  const shown = m.marks.filter((mk) => mk.i >= pts12[0].i);
  put("marks-key", shown.map((mk) => h("li", {}, h("span", { class: "n", "aria-hidden": "true" }, String(mk.n)), h("span", {}, mk.text))));
  const yearly = all.filter((p) => p.i % 12 === 11 || p.i === all.at(-1).i).reverse();
  $("table-rolling").replaceChildren(tableDetails("Show as a table",
    table("12-month net reported buying, at each December and the latest month", ["Month", "12-month net"],
      yearly.map((p) => [mLabel(p.i), sv(p.v)]), { scroll: true })));
}

function wireTrendRange(m) {
  const box = $("trend-range");
  box.addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    for (const x of box.querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
    renderRolling(m, Number(b.dataset.years));
  });
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
  $("momentum-table").replaceChildren(table(`Regular buyers: purchases in at least 3 of their last 12 reported months (${regular.length} holders)`,
    ["Holder", "Buying months", "Selling months", "Current streak", "12-month change", "Last purchase"],
    regular.map((d) => [nameBtn(d), `${d.buys12} of 12`, String(d.sells12), d.streak ? plural(d.streak, "month") : "–",
      d.d12 === undefined ? "–" : sv(d.d12), d.lastBuy === undefined ? "–" : mLabel(d.lastBuy)]), { scroll: true }));
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
      { value: pct1(p.v), label: "gold share", key: "buy" },
      { value: usdMn(p.gold), label: "gold at market" },
      { value: usdMn(p.total), label: "all reserves" },
      ...(p.price ? [{ value: usd(p.price), label: "per ounce" }] : []),
    ],
  });
  $("table-share").replaceChildren(tableDetails("Show as a table",
    table("Gold share of reported official reserves", ["Month", "Gold share", "Gold at market", "All reserves", "Price per ounce"],
      ws.slice().reverse().map((p) => [mLabel(p.i), pct1(p.v), usdMn(p.gold), usdMn(p.total), p.price ? usd(p.price) : "–"]), { scroll: true })));

  const top = m.holders.slice().sort((a, b) => b.latest - a.latest).slice(0, TOP_N)
    .map((d) => r.byCode.get(d.code)).filter(Boolean).sort((a, b) => b.latest.share - a.latest.share);
  hbarChart($("chart-share-holders"), {
    rows: top.map((x) => ({ name: x.name, v: x.latest.share, x })),
    fmt: pct,
    neutral: true,
    label: "Bar chart of gold as a percentage of each large holder's official reserves.",
    tipRows: (row) => [
      { value: pct1(row.v), label: `of reserves, ${mLabel(row.x.last)}`, key: "buy" },
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
    tipRows: (p) => [{ value: usd(p.v), label: "per ounce", key: "buy" }, { value: String(p.n), label: "holders in the median" }],
  });
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
  $("board-table").replaceChildren(h("div", { class: "table-wrap", tabindex: "0", role: "region", "aria-labelledby": id },
    h("table", {},
      h("caption", { id }, "Largest reported gold holders. Select a name to see it in depth below."),
      h("thead", {}, h("tr", {}, head.map((c, k) => h("th", { scope: "col", class: k === 0 ? "l" : null }, c)))),
      h("tbody", {}, rows))));
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
      return [{ value: tonnes(p.v), label: "held", key: "buy" },
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
      tipRows: (p) => [{ value: pct1(p.v), label: "of reserves", key: "buy" },
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
    h("h3", {}, "Gold's share of reserves"),
    h("p", {}, "Countries value their gold differently, so the reported dollar values can't be used as they are. This page takes one price per month, the median dollars per ounce across all holders with at least 1 t (it tracks the market price), revalues every holder's gold at it, and replaces the reported gold value inside total reserves with that market value."),
    revalued.length ? h("p", {}, `Holders whose own value is more than 10% off that price, mostly because they use an old official price or historical cost: ${revalued.map((x) => x.name).join(", ")}. The US, for example, values its gold at the statutory $42.22 an ounce.`) : null,
    r ? h("p", {}, `The world line starts in ${mLabel(r.worldSeries[0].i)}, when today's reporters first cover ${pct(COVERAGE_MIN)} of reserves, and ends at ${mLabel(r.complete)}, the latest month that is ${pct(COVERAGE_MIN)} reported.`) : null,
    h("h3", {}, "Reading the gauge"),
    h("p", {}, "\"Speeding up\" compares the last three months, scaled to a year, with the 12-month total; within 15% counts as steady. Gold amounts are in tonnes (1 t ≈ 32,151 fine troy ounces), money in US dollars."),
  );
}

/* ---------- Boot ---------- */

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
  let raw, rr = null, log = null;
  try {
    [raw, rr, log] = await Promise.all([getJSON(DATA_URL), getJSON(RESERVES_URL).catch(() => null), getLog("data/fetch_log.csv").catch(() => null)]);
  } catch (err) {
    const f = $("ticker");
    f.textContent = `Couldn't load ${DATA_URL} (${err.message}). If you opened this file directly, serve the folder over HTTP instead.`;
    f.classList.add("error");
    return;
  }
  const m = buildModel(raw);
  const r = buildReserves(rr, m);
  renderTicker(m, r);
  renderHero(m);
  renderStatGroups(m, r, log);
  renderFreshness(m);
  renderRolling(m);
  wireTrendRange(m);
  renderYears(m);
  renderMonthly(m);
  renderWho(m);
  renderGroups(m);

  const sel = $("country-select");
  for (const d of m.holders.slice().sort((a, b) => b.latest - a.latest)) {
    sel.append(h("option", { value: d.code }, `${d.name} · ${tonnes(d.latest)}`));
  }
  const select = (code, scroll) => {
    sel.value = code;
    renderCountry(m, r, code);
    if (scroll) $("country").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  };
  sel.addEventListener("change", () => select(sel.value, false));
  renderMomentum(m, select);
  if (r && r.worldSeries.length) renderShare(m, r);
  else $("reserves").hidden = true;
  renderBoard(m, r, select);
  const topBuyer = m.byCountry.slice().sort((a, b) => b.v - a.v)[0];
  select(topBuyer ? topBuyer.d.code : "USA", false);
  renderNotes(m, r);
  scrollSpy();
}

main();
