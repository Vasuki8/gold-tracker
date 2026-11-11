// Runs the page's own model (assets/app.js) on a gold_tonnes.json file and prints the headline
// gauge, so spike/test_gauge.py can check that changes.py counts a month exactly as the page does.
//
//     node spike/gauge_js.mjs data/gold_tonnes.json
//
// app.js is a browser script with no exports, so it is loaded in a sandbox with just enough of
// the browser's globals for its top-level code, and its final main() call is replaced.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let code = readFileSync(join(root, "assets", "app.js"), "utf8");
if (!/\nmain\(\);\s*$/.test(code)) throw new Error("assets/app.js is expected to end with main();");
code = code.replace(/\nmain\(\);\s*$/, "\nglobalThis.__app = { buildModel, headline, trendWord };\n");
const sandbox = {
  URLSearchParams, Intl, console,
  location: { search: "", hash: "" },
  document: { getElementById: () => null },
  matchMedia: () => ({ matches: true }),
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "assets/app.js" });

const raw = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { buildModel, headline, trendWord } = sandbox.__app;
const m = buildModel(raw);
const k = headline(m);
const key = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
const pending = {};
for (let i = m.complete + 1; i <= m.newest; i++) pending[key(i)] = +m.months.get(i).coverage.toFixed(3);
console.log(JSON.stringify({
  complete: key(m.complete), newest: key(m.newest),
  r12: +k.r12.toFixed(1), prev12: +k.prev12.toFixed(1), r3: +k.r3.toFixed(1),
  word: trendWord(k.r12, k.pace).text,
  r12x: +k.x.r12.toFixed(1), prev12x: +k.x.prev12.toFixed(1), r3x: +k.x.r3.toFixed(1), pending,
}));
