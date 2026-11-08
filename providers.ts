// Search provider adapters. Each returns up to 10 hits normalized to url/title/snippet,
// snippets capped at SNIPPET_CHARS so every provider feeds the reader the same budget.
import { readFileSync } from "fs";

export interface Hit { url: string; title: string; snippet: string }
export interface Provider { name: string; search: (q: string) => Promise<Hit[]> }

const SNIPPET_CHARS = 1200;
const N = 10;
// One file per key (e.g. EXA_API_KEY) in this directory.
const KEYS = process.env.SEARCH_BENCH_KEYS ?? `${process.env.HOME}/.config/search-bench/keys`;
const key = (name: string) => readFileSync(`${KEYS}/${name}`, "utf8").trim();

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const texts = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map((p) => (typeof p === "string" ? p : str((p as Json)?.text) || str((p as Json)?.snippet) || str((p as Json)?.content))).filter(Boolean)
    : [];

function norm(rows: unknown, pick: (r: Json) => string): Hit[] {
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  const hits: Hit[] = [];
  for (const r of rows as Json[]) {
    const url = str(r?.url) || str(r?.link);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    hits.push({ url, title: str(r.title) || str(r.name), snippet: pick(r).slice(0, SNIPPET_CHARS) });
    if (hits.length >= N) break;
  }
  return hits;
}

// Retries 429/5xx with backoff so free-tier rate limits don't count as wrong answers.
async function call(url: string, init: RequestInit, timeoutMs = 90_000): Promise<Json> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.text();
    if (res.ok) return JSON.parse(body) as Json;
    if (attempt >= 5 || (res.status !== 429 && res.status < 500)) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    await Bun.sleep(1500 * 2 ** attempt);
  }
}
const post = (url: string, headers: Record<string, string>, body: unknown) =>
  call(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

export const providers: Record<string, Provider> = {
  exa: {
    name: "exa",
    search: async (q) => {
      const d = await post("https://api.exa.ai/search", { "x-api-key": key("EXA_API_KEY") }, { query: q, type: "auto", numResults: N, contents: { highlights: true } });
      return norm(d.results, (r) => texts(r.highlights).join("\n") || str(r.summary) || str(r.text));
    },
  },
  "exa-deep": {
    name: "exa-deep",
    search: async (q) => {
      const d = await post("https://api.exa.ai/search", { "x-api-key": key("EXA_API_KEY") }, { query: q, type: "deep", numResults: N, contents: { highlights: true } });
      return norm(d.results, (r) => texts(r.highlights).join("\n") || str(r.summary) || str(r.text));
    },
  },
  parallel: {
    name: "parallel",
    search: async (q) => {
      const d = await post("https://api.parallel.ai/v1/search", { "x-api-key": key("PARALLEL_API_KEY") }, { objective: q, search_queries: [q], mode: "basic", advanced_settings: { max_results: N } });
      return norm(d.results, (r) => texts(r.excerpts).join("\n"));
    },
  },
  "parallel-advanced": {
    name: "parallel-advanced",
    search: async (q) => {
      const d = await post("https://api.parallel.ai/v1/search", { "x-api-key": key("PARALLEL_API_KEY") }, { objective: q, search_queries: [q], mode: "advanced", advanced_settings: { max_results: N } });
      return norm(d.results, (r) => texts(r.excerpts).join("\n"));
    },
  },
  tavily: {
    name: "tavily",
    search: async (q) => {
      const d = await post("https://api.tavily.com/search", { authorization: `Bearer ${key("TAVILY_API_KEY")}` }, { query: q, search_depth: "advanced", max_results: N, chunks_per_source: 3, include_answer: false, topic: "general" });
      return norm(d.results, (r) => str(r.content));
    },
  },
  firecrawl: {
    name: "firecrawl",
    search: async (q) => {
      const d = await post("https://api.firecrawl.dev/v2/search", { authorization: `Bearer ${key("FIRECRAWL_API_KEY")}` }, { query: q, limit: N });
      const data = d.data as Json | unknown[];
      const rows = Array.isArray(data) ? data : (data as Json)?.web;
      return norm(rows, (r) => str(r.description) || str(r.snippet) || str(r.markdown));
    },
  },
  linkup: {
    name: "linkup",
    search: async (q) => {
      const d = await post("https://api.linkup.so/v1/search", { authorization: `Bearer ${key("LINKUP_API_KEY")}` }, { q, depth: "standard", outputType: "searchResults", maxResults: N });
      return norm((d.results as Json[] | undefined)?.filter((r) => r.type !== "image"), (r) => str(r.content));
    },
  },
  you: {
    name: "you",
    search: async (q) => {
      const d = await post("https://ydc-index.io/v1/search", { "X-API-Key": key("YDC_API_KEY") }, { query: q, count: N, extraction: { extraction_mode: "highlights" } });
      const res = d.results as Json;
      const rows = [...((res?.web as Json[]) ?? []), ...((res?.news as Json[]) ?? [])];
      return norm(rows, (r) => texts((r.contents as Json)?.highlights).join("\n") || texts(r.highlights).join("\n") || texts(r.snippets).join("\n") || str(r.description));
    },
  },
  tinyfish: {
    name: "tinyfish",
    search: async (q) => {
      const d = await call(`https://api.search.tinyfish.ai/?query=${encodeURIComponent(q)}`, { headers: { "X-API-Key": key("TINYFISH_API_KEY"), accept: "application/json" } });
      return norm(d.results, (r) => str(r.snippet) || str(r.description));
    },
  },
  valyu: {
    name: "valyu",
    search: async (q) => {
      const d = await post("https://api.valyu.ai/v1/search", { "x-api-key": key("VALYU_API_KEY") }, { query: q, search_type: "web", max_num_results: N, response_length: "short" });
      return norm(d.results, (r) => str(r.content) || str(r.description));
    },
  },
  jina: {
    name: "jina",
    search: async (q) => {
      const d = await call(`https://s.jina.ai/?q=${encodeURIComponent(q)}`, { headers: { authorization: `Bearer ${key("JINA_API_KEY")}`, accept: "application/json" } });
      return norm(d.data, (r) => [str(r.description), str(r.content)].filter(Boolean).join("\n"));
    },
  },
  context: {
    name: "context",
    search: async (q) => {
      const d = await post("https://api.context.dev/v1/web/search", { authorization: `Bearer ${key("CONTEXT_DEV_API_KEY")}` }, { query: q, numResults: N, highlightsOptions: { enabled: true, maxCharacters: SNIPPET_CHARS } });
      return norm(d.results, (r) => {
        const hl = texts((r.highlights as Json | undefined)?.highlights);
        return hl.join("\n") || str(r.description);
      });
    },
  },
};
