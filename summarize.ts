// Builds results/summary.json from the per-round result files: totals per provider config,
// split into the general rounds (1-4) and the coding round.
import { readdirSync, readFileSync, writeFileSync } from "fs";

interface Row { provider: string; score: boolean; searchMs: number[] }
const files = readdirSync("results").filter((f) => /^(round|coding).*\.json$/.test(f));
const tally = new Map<string, { general: [number, number]; coding: [number, number]; codingMs: number[] }>();
for (const f of files) {
  const { rows } = JSON.parse(readFileSync(`results/${f}`, "utf8")) as { rows: Row[] };
  const bucket = f.startsWith("coding") ? "coding" : "general";
  for (const r of rows) {
    const t = tally.get(r.provider) ?? { general: [0, 0], coding: [0, 0], codingMs: [] };
    t[bucket][0] += r.score ? 1 : 0;
    t[bucket][1] += 1;
    if (bucket === "coding") t.codingMs.push(...r.searchMs);
    tally.set(r.provider, t);
  }
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const summary = [...tally].map(([provider, t]) => ({
  provider,
  general: `${t.general[0]}/${t.general[1]}`,
  coding: `${t.coding[0]}/${t.coding[1]}`,
  total: `${t.general[0] + t.coding[0]}/${t.general[1] + t.coding[1]}`,
  pct: +((100 * (t.general[0] + t.coding[0])) / (t.general[1] + t.coding[1])).toFixed(1),
  codingP50Ms: Math.round(median(t.codingMs)),
})).sort((a, b) => b.pct - a.pct || a.codingP50Ms - b.codingP50Ms);
writeFileSync("results/summary.json", JSON.stringify(summary, null, 2));
console.table(summary);
