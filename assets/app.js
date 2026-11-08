"use strict";
/* Central bank gold tracker, v1 page. Reads data/gold_tonnes.json (written daily by
   spike/fetch_irfcl.py) and draws everything client-side: no build step, no libraries. */

const DATA_URL = "data/gold_tonnes.json";
const COVERAGE_MIN = 0.9; // a month counts once holders with 90% of the past year's activity have filed it
const STALE_MONTHS = 6; // nothing reported this long before the newest month: stale, left out of coverage
const BRIDGE_MONTHS = 3; // a change may span up to 3 missing months (dropped or unreported values)
const TOP_N = 15;

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
const tickText = (v) => `${v < 0 ? MINUS : ""}${NF0.format(Math.abs(v))}`;

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

/* ---------- The model ---------- */

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
    for (const d of holders) {
      const c = change(d, i);
      if (c === undefined) continue;
      net += c;
      if (Math.abs(c) >= 0.05) contrib.push({ d, c });
    }
    contrib.sort((a, b) => Math.abs(b.c) - Math.abs(a.c));
    const covered = active.reduce((a, d) => a + (d.s.has(i) ? d.activity : 0), 0);
    months.set(i, { i, net, contrib, coverage: totalActivity ? covered / totalActivity : 1 });
  }
  let complete = newest;
  while (complete > first + 12 && months.get(complete).coverage < COVERAGE_MIN) complete--;

  const sumNet = (a, b) => { let t = 0; for (let i = a; i <= b; i++) t += months.get(i)?.net ?? 0; return t; };
  const rolling12 = [];
  for (let i = first + 12; i <= complete; i++) rolling12.push({ i, v: sumNet(i - 11, i) });

  const win = { from: complete - 11, to: complete };
  const byCountry = holders.map((d) => {
    let v = 0, any = false;
    for (let i = win.from; i <= win.to; i++) {
      const c = change(d, i);
      if (c !== undefined) { v += c; any = true; }
    }
    return any ? { d, v } : null;
  }).filter(Boolean);

  return { raw, holders, newest, first, complete, months, rolling12, win, byCountry, sumNet, valueAt, change };
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

function yGrid(svg, yt, Y, left, right, zeroIsBaseline) {
  for (const v of yt.ticks) {
    svg.append(
      s("line", { x1: left, x2: right, y1: Y(v), y2: Y(v), class: v === 0 && zeroIsBaseline ? "baseline" : "gridline" }),
      s("text", { x: left - 8, y: Y(v), class: "tick", "text-anchor": "end", "dominant-baseline": "middle" }, tickText(v)),
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

function lineChart(container, { points, label, height = 280, endLabel, tipRows }) {
  mountChart(container, (W, tip) => {
    const narrow = W < 520;
    const M = { t: 14, r: endLabel ? (narrow ? 58 : 70) : 16, b: 30, l: 50 };
    const pw = W - M.l - M.r, ph = height - M.t - M.b;
    const x0 = points[0].i, x1 = points.at(-1).i;
    const X = (i) => M.l + (x1 === x0 ? pw / 2 : ((i - x0) / (x1 - x0)) * pw);
    const vs = points.map((p) => p.v);
    const yt = niceTicks(Math.min(0, ...vs), Math.max(0, ...vs), narrow ? 4 : 5);
    const Y = (v) => M.t + ph - ((v - yt.lo) / (yt.hi - yt.lo)) * ph;
    const svg = s("svg", { width: W, height, viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": label });
    yGrid(svg, yt, Y, M.l, M.l + pw, true);
    yearAxis(svg, x0, x1, (i) => X(i), M.t + ph);
    const d = points.map((p, k) => `${k ? "L" : "M"}${X(p.i).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
    svg.append(
      s("path", { d: `${d}L${X(x1).toFixed(1)},${Y(0)}L${X(x0).toFixed(1)},${Y(0)}Z`, class: "area" }),
      s("path", { d, class: "line" }),
    );
    const last = points.at(-1);
    svg.append(s("circle", { cx: X(last.i), cy: Y(last.v), r: 4, class: "dot" }));
    if (endLabel) {
      svg.append(s("text", { x: X(last.i) + 9, y: Y(last.v), class: "end-label", "dominant-baseline": "middle" }, endLabel(last)));
    }
    const cross = s("line", { y1: M.t, y2: M.t + ph, class: "cross", visibility: "hidden" });
    const hot = s("circle", { r: 4, class: "dot", visibility: "hidden" });
    svg.append(cross, hot);
    hoverLayer(svg, {
      positions: points.map((p) => X(p.i)),
      show(k) {
        const p = points[k], x = X(p.i), y = Y(p.v);
        for (const [a, v] of [["x1", x], ["x2", x]]) cross.setAttribute(a, v);
        hot.setAttribute("cx", x); hot.setAttribute("cy", y);
        cross.setAttribute("visibility", "visible"); hot.setAttribute("visibility", "visible");
        fillTip(tip, mLabel(p.i), tipRows(p));
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

function columnChart(container, { bars, label, height = 240, tipRows }) {
  mountChart(container, (W, tip) => {
    const M = { t: 14, r: 8, b: 30, l: 50 };
    const pw = W - M.l - M.r, ph = height - M.t - M.b;
    const band = pw / bars.length;
    const bw = Math.max(2, Math.min(24, band - 2)); // at least a 2px surface gap between bars
    const vs = bars.map((b) => b.v);
    const yt = niceTicks(Math.min(0, ...vs), Math.max(0, ...vs), 4);
    const Y = (v) => M.t + ph - ((v - yt.lo) / (yt.hi - yt.lo)) * ph;
    const svg = s("svg", { width: W, height, viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": label });
    yGrid(svg, yt, Y, M.l, M.l + pw, true);
    const i0 = bars[0].i;
    const bx = (k) => M.l + band * k;
    yearAxis(svg, i0, bars.at(-1).i, (i) => bx(i - i0), M.t + ph, band / 2);
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
        fillTip(tip, mLabel(b.i), tipRows(b));
        placeTip(tip, container, bx(k) + band / 2, Math.min(Y(b.v), Y(0)));
      },
      hide() { on?.classList.remove("on"); on = null; tip.hidden = true; },
    });
    return svg;
  });
}

function hbarChart(container, { rows, label, tipRows, splitAt }) {
  mountChart(container, (W, tip) => {
    const narrow = W < 520;
    const rowH = 30, bh = 16, gap = splitAt ? 14 : 0;
    const labelW = narrow ? 104 : 150, valW = 62;
    const vs = rows.map((r) => r.v);
    const lo = Math.min(0, ...vs), hi = Math.max(0, ...vs);
    const left = labelW + (lo < 0 ? valW : 6), right = W - (hi > 0 ? valW : 6);
    const X = (v) => left + ((v - lo) / (hi - lo || 1)) * (right - left);
    const rowY = (k) => 4 + k * rowH + (splitAt && k >= splitAt ? gap : 0);
    const height = rowY(rows.length) + 4;
    const svg = s("svg", { width: W, height, viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": label });
    const marks = rows.map((r, k) => {
      const y = rowY(k);
      svg.append(s("text", { x: labelW - 10, y: y + rowH / 2, class: "row-label", "text-anchor": "end", "dominant-baseline": "middle" }, r.name));
      const p = s("path", { d: hbarPath(X(0), X(r.v), y + (rowH - bh) / 2, bh), class: `bar ${r.v >= 0 ? "buy" : "sell"}` });
      const pos = r.v >= 0;
      svg.append(p, s("text", {
        x: X(r.v) + (pos ? 6 : -6), y: y + rowH / 2, class: "value-label",
        "text-anchor": pos ? "start" : "end", "dominant-baseline": "middle",
      }, signed(r.v)));
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

function sparkline(values, w = 96, ht = 24) {
  let lo = Math.min(...values), hi = Math.max(...values);
  // Never stretch less than 5% of the level (or 10 t) over the full height: a 0.2 t revision
  // on 1,040 t must look flat, not like a cliff.
  const minSpan = Math.max(0.05 * Math.max(Math.abs(hi), Math.abs(lo)), 10);
  if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
  const X = (k) => 2 + (k / Math.max(1, values.length - 1)) * (w - 6);
  const Y = (v) => (hi === lo ? ht / 2 : 3 + (1 - (v - lo) / (hi - lo)) * (ht - 6));
  const d = values.map((v, k) => `${k ? "L" : "M"}${X(k).toFixed(1)},${Y(v).toFixed(1)}`).join("");
  return s("svg", { class: "spark", width: w, height: ht, viewBox: `0 0 ${w} ${ht}`, "aria-hidden": "true" },
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

function renderGauge(m) {
  const c = m.complete;
  const r12 = m.sumNet(c - 11, c), prev12 = m.sumNet(c - 23, c - 12);
  const r3 = m.sumNet(c - 2, c), pace = r3 * 4;
  const word = trendWord(r12, pace);
  const buyers = m.byCountry.filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
  const gross = buyers.reduce((a, x) => a + x.v, 0);
  const top2 = buyers.slice(0, 2);
  const share = gross ? top2.reduce((a, x) => a + x.v, 0) / gross : 0;

  $("gauge-sub").textContent = `All holders reporting to the IMF, through ${mLabel(c)}, the latest month that is nearly fully reported.`;
  const spark = m.rolling12.slice(-36).map((p) => p.v);
  $("tiles").replaceChildren(
    h("div", { class: "tile hero" },
      h("p", { class: "tile-label" }, "Net reported buying, last 12 months"),
      h("p", { class: "tile-value" }, signed(r12)),
      h("p", { class: "tile-sub" }, mRange(c - 11, c)),
      h("p", { class: "tile-delta" }, h("strong", {}, `${r12 >= prev12 ? "▲" : "▼"} ${signed(r12 - prev12)}`),
        ` vs the 12 months before (${signed(prev12)})`),
      sparkline(spark, 200, 32)),
    h("div", { class: "tile" },
      h("p", { class: "tile-label" }, "Last 3 months"),
      h("p", { class: "tile-value" }, signed(r3)),
      h("p", { class: "tile-sub" }, `${mRange(c - 2, c)} · a pace of ${signed(pace).replace(" t", " t a year")}`),
      h("p", { class: "trend-word" }, h("span", { class: "icon", "aria-hidden": "true" }, word.icon), word.text),
      h("p", { class: "tile-sub" }, `compared with the 12-month total of ${signed(r12)}`)),
    h("div", { class: "tile" },
      h("p", { class: "tile-label" }, "Who is buying"),
      h("p", { class: "tile-value" }, pct(share)),
      h("p", { class: "tile-sub" }, `of gross reported buying came from ${top2.map((x) => x.d.name).join(" and ")}`),
      h("div", { class: "meter", role: "img", "aria-label": `${pct(share)} share` }, h("span", { style: `width:${(share * 100).toFixed(1)}%` })),
      h("ul", { class: "mini-list" }, buyers.slice(0, 4).map((x) => h("li", {},
        h("span", { class: "n" }, x.d.name), h("span", { class: "v" }, signed(x.v)))))),
  );
}

function renderRolling(m) {
  const pts = m.rolling12;
  lineChart($("chart-rolling"), {
    points: pts,
    label: `Line chart of 12-month net reported central bank gold buying, ${mLabel(pts[0].i)} to ${mLabel(pts.at(-1).i)}. Latest ${signed(pts.at(-1).v)}.`,
    endLabel: (p) => signed(p.v),
    tipRows: (p) => [
      { value: signed(p.v), label: "12-month net", key: "buy" },
      { value: signed(m.months.get(p.i).net), label: "that month" },
    ],
  });
  const yearly = pts.filter((p) => p.i % 12 === 11 || p.i === pts.at(-1).i).reverse();
  $("table-rolling").replaceChildren(tableDetails("Show as a table",
    table("12-month net reported buying, at each December and the latest month", ["Month", "12-month net"],
      yearly.map((p) => [mLabel(p.i), signed(p.v)]), { scroll: true })));
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
      bars.slice().reverse().map((b) => [mLabel(b.i), signed(b.v), b.faded ? `${pct(b.mo.coverage)} reported` : "complete",
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
      sorted.filter((x) => Math.abs(x.v) >= 0.05).map((x) => [x.d.name, signed(x.v), tonnes(x.d.latest), mLabel(x.d.last)]),
      { scroll: true })));
}

function renderBoard(m, select) {
  const top = m.holders.slice().sort((a, b) => b.latest - a.latest).slice(0, TOP_N);
  const total = m.holders.filter((d) => !d.stale).reduce((a, d) => a + d.latest, 0);
  $("board-sub").textContent = `The ${TOP_N} biggest holders that report to the IMF, each at its own latest month (reporting lags differ). `
    + `Uzbekistan, a large holder, does not report to this dataset and is missing.`;
  const id = "board-caption";
  const rows = top.map((d, k) => {
    const spark = [];
    for (let i = d.last - 35; i <= d.last; i++) { const v = m.valueAt(d, i); if (v !== undefined) spark.push(v); }
    return h("tr", {},
      h("th", { scope: "row", class: "l" },
        h("span", { class: "rank" }, `${k + 1}. `),
        h("button", { type: "button", class: "holder-btn", onclick: () => select(d.code, true) }, d.name)),
      h("td", {}, tonnes(d.latest)),
      h("td", {}, pct(d.latest / total)),
      h("td", { class: d.last < m.newest - 2 ? "flag" : "muted" }, mLabel(d.last)),
      h("td", {}, d.d1 === undefined ? "–" : signed(d.d1)),
      h("td", {}, d.d12 === undefined ? "–" : signed(d.d12)),
      h("td", {}, spark.length > 1 ? sparkline(spark) : "–"));
  });
  $("board").replaceChildren(h("div", { class: "table-wrap", tabindex: "0", role: "region", "aria-labelledby": id },
    h("table", {},
      h("caption", { id }, "Largest reported gold holders. Select a name to see its history below."),
      h("thead", {}, h("tr", {}, ["Holder", "Gold", "Share", "As of", "1 month", "12 months", "3 years"].map((c, k) =>
        h("th", { scope: "col", class: k === 0 ? "l" : null }, c)))),
      h("tbody", {}, rows))));
}

function renderCountry(m, code) {
  const d = m.holders.find((x) => x.code === code);
  if (!d) return;
  const pts = [...d.s.entries()].sort((a, b) => a[0] - b[0]).map(([i, v]) => ({ i, v }));
  const peak = pts.reduce((a, p) => (p.v >= a.v ? p : a), pts[0]);
  $("country-sub").textContent = `${tonnes(d.latest)} in ${mLabel(d.last)}`
    + (d.d12 === undefined ? "" : ` · ${signed(d.d12)} over 12 months`)
    + ` · peak ${tonnes(peak.v)} (${mLabel(peak.i)})`
    + (d.stale ? " · no report in the last 6 months" : "");
  lineChart($("chart-country"), {
    points: pts,
    height: 260,
    label: `Line chart of ${d.name}'s reported gold holdings, ${mLabel(pts[0].i)} to ${mLabel(d.last)}.`,
    endLabel: (p) => tonnes(p.v),
    tipRows: (p) => {
      const c = m.change(d, p.i);
      return [{ value: tonnes(p.v), label: "held", key: "buy" }, ...(c === undefined ? [] : [{ value: signed(c), label: "change" }])];
    },
  });
  $("table-country").replaceChildren(tableDetails("Show as a table",
    table(`${d.name}: reported gold holdings by month, newest first`, ["Month", "Held", "Change"],
      pts.slice().reverse().map((p) => { const c = m.change(d, p.i); return [mLabel(p.i), tonnes(p.v), c === undefined ? "–" : signed(c)]; }),
      { scroll: true })));
}

// ["2003-06", "2026-03"] -> "Jun 2003, Mar 2026"; a run of consecutive months -> "Mar 2026 – Sep 2026".
function monthList(keys) {
  const is = keys.map(idx).sort((a, b) => a - b);
  const consecutive = is.every((v, k) => k === 0 || v === is[k - 1] + 1);
  if (is.length > 1 && consecutive) return `${mLabel(is[0])} – ${mLabel(is.at(-1))}`;
  return is.length > 3 ? `${mLabel(is[0])} … ${mLabel(is.at(-1))}` : is.map(mLabel).join(", ");
}

function renderNotes(m) {
  const pending = [];
  for (let i = m.complete + 1; i <= m.newest; i++) pending.push(`${mLabel(i)}: ${pct(m.months.get(i).coverage)} reported`);
  const stale = m.holders.filter((d) => d.stale).sort((a, b) => b.latest - a.latest);
  const rejected = Object.entries(m.raw.rejected || {});
  $("notes").replaceChildren(
    h("h3", {}, "When a month counts"),
    h("p", {}, `Countries report on different schedules: most file a month or two after it ends, some (the US among them) take longer. A month enters the totals once the holders responsible for ${pct(COVERAGE_MIN)} of the past year's reported buying and selling have filed it. Weighting by activity, not by size, means a large holder that never changes (such as the US) can't hold the totals back, while a busy trader (such as Turkey) can.`),
    pending.length ? h("p", {}, `Not counted yet: ${pending.join("; ")}.`) : null,
    h("h3", {}, "What is covered"),
    h("p", {}, `IMF IRFCL line 56, gold volume, for monetary authorities plus central government, so gold held by a finance ministry (the UK's Treasury, for example) counts. ${m.holders.length} holders, ${mLabel(m.first)} to ${mLabel(m.newest)}. The euro-area total is left out because its members and the ECB are already counted. Uzbekistan does not report to IRFCL.`),
    stale.length ? h("p", {}, `No report in the last ${STALE_MONTHS} months, shown at their last figure: ${stale.map((d) => `${d.name} (${mLabel(d.last)})`).join(", ")}.`) : null,
    h("h3", {}, "Removed as reporting errors"),
    h("p", {}, "The fetch script drops values that can only be mistakes in national submissions: more gold than anyone holds, a jump of exactly ×1,000, or a single month far off two neighbours that agree. A change can span up to three missing months, so a dropped value doesn't hide the move around it."),
    rejected.length ? h("ul", {}, rejected.map(([code, items]) =>
      h("li", {}, `${nameOf(code)}: ${items.length} ${items.length === 1 ? "month" : "months"} (${monthList(items.map((x) => x[0]))}), ${[...new Set(items.map((x) => x[2].split(" (")[0].split(" from ")[0]))].join("; ")}`))) : null,
    h("h3", {}, "Reading the gauge"),
    h("p", {}, "\"Speeding up\" compares the last three months, scaled to a year, with the 12-month total; within 15% counts as steady. All figures are in tonnes (1 t ≈ 32,151 fine troy ounces)."),
  );
}

/* ---------- Boot ---------- */

async function main() {
  let raw;
  try {
    const res = await fetch(DATA_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
  } catch (err) {
    const f = $("freshness");
    f.textContent = `Couldn't load ${DATA_URL} (${err.message}). If you opened this file directly, serve the folder over HTTP instead.`;
    f.classList.add("error");
    return;
  }
  const m = buildModel(raw);
  renderFreshness(m);
  renderGauge(m);
  renderRolling(m);
  renderMonthly(m);
  renderWho(m);

  const sel = $("country-select");
  for (const d of m.holders.slice().sort((a, b) => b.latest - a.latest)) {
    sel.append(h("option", { value: d.code }, `${d.name} · ${tonnes(d.latest)}`));
  }
  const select = (code, scroll) => {
    sel.value = code;
    renderCountry(m, code);
    if (scroll) $("country").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  };
  sel.addEventListener("change", () => select(sel.value, false));
  renderBoard(m, select);
  const topBuyer = m.byCountry.slice().sort((a, b) => b.v - a.v)[0];
  select(topBuyer ? topBuyer.d.code : "USA", false);
  renderNotes(m);
}

main();
