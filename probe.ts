import { providers } from "./providers";
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(providers);
await Promise.all(names.map(async (n) => {
  const t = performance.now();
  try {
    const hits = await providers[n].search("SQLite SQLITE_MAX_VARIABLE_NUMBER default value");
    const avg = hits.length ? Math.round(hits.reduce((a, h) => a + h.snippet.length, 0) / hits.length) : 0;
    console.log(n.padEnd(18), `${hits.length} hits`, `avgSnippet=${avg}`, `${Math.round(performance.now() - t)}ms`, "|", hits[0]?.url, "|", hits[0]?.snippet.slice(0, 90).replace(/\s+/g, " "));
  } catch (e) { console.log(n.padEnd(18), "ERR", String(e).slice(0, 250)); }
}));
