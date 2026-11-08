// Search-API benchmark runner.
//   bun bench.ts <round1|round2> <single|agent> <runs> <provider...>
// single: one search with the raw question, reader answers from those results only.
// agent:  reader may issue up to MAX_SEARCHES of its own queries before answering.
// Score = grader says the answer matches gold AND the cited results actually support it,
// so an answer recalled from the reader model's memory does not count.
import { mkdirSync, writeFileSync } from "fs";
import { providers, type Hit } from "./providers";
import { round1, round2, round3, round4, coding, type Task } from "./tasks";

const READER = process.env.READER ?? "gpt-5.6-sol";
const GRADER = process.env.GRADER ?? "gpt-6.1-sol";
const MAX_SEARCHES = 4;
// Free tiers: Context.dev allows 1 in-flight request, Firecrawl rate-limits bursts.
const concurrency = (p: string) => (p === "context" ? 1 : p === "firecrawl" ? 2 : 3);

const [roundName = "round1", mode = "single", runsArg = "1", ...names] = process.argv.slice(2);
const ONLY = process.env.ONLY?.split(",");
const tasks = ({ round1, round2, round3, round4, coding }[roundName] ?? round1).filter((t) => !ONLY || ONLY.includes(t.id));
const runs = Number(runsArg);
const selected = names.length ? names : Object.keys(providers);

interface Msg { role: "user" | "assistant"; content: string }

async function llm(model: string, system: string, messages: Msg[]): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 2000, system, messages }),
      signal: AbortSignal.timeout(180_000),
    }).catch((e: unknown) => ({ ok: false, status: 0, text: async () => String(e) }) as const);
    if (res.ok) {
      const d = (await res.json()) as { content: { type: string; text?: string }[] };
      return d.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    }
    if (attempt >= 4) throw new Error(`llm ${model} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await Bun.sleep(2000 * 2 ** attempt);
  }
}

function json<T>(s: string): T | null {
  const m = s.match(/\{[\s\S]*\}/);
  try { return m ? (JSON.parse(m[0]) as T) : null; } catch { return null; }
}

const fmt = (hits: { id: number; hit: Hit }[]) =>
  hits.map(({ id, hit }) => `[${id}] ${hit.title}\n${hit.url}\n${hit.snippet}`).join("\n\n");

const READER_SYS = `You answer questions using ONLY the search results you are given. Never use your own memory: if the results do not state the answer, answer "UNKNOWN". Today is 2026-11-08.`;
const SINGLE_FMT = `Reply with JSON only: {"answer": "<short answer>", "sources": [<result numbers that state the answer>]}`;
const AGENT_FMT = `You have a web search tool. Each turn reply with JSON only, either
{"action": "search", "query": "<query>"}  (at most ${MAX_SEARCHES} searches in total), or
{"action": "answer", "answer": "<short answer>", "sources": [<result numbers that state the answer>]}`;

interface Answer { answer: string; sources: number[] }
interface Grade { correct: boolean; grounded: boolean; why: string }

async function grade(t: Task, a: Answer, pool: Map<number, Hit>): Promise<Grade> {
  const byId = (a.sources ?? []).map((i) => pool.get(Number(i))).filter((h): h is Hit => !!h);
  // Some readers skip the sources field in multi-turn mode; then grade grounding against everything retrieved.
  const cited = byId.length ? byId : [...pool.values()].map((h) => ({ ...h, snippet: h.snippet.slice(0, 600) }));
  const out = await llm(GRADER, "You are a strict, fair grader.", [{
    role: "user",
    content: `Question: ${t.q}\nGold answer: ${t.gold}\nCandidate answer: ${a.answer}\n\nCited search results:\n${cited.map((h) => `${h.url}\n${h.snippet}`).join("\n\n") || "(none)"}\n\n` +
      `correct = the candidate states the same fact as the gold (formatting/units/aliases may differ; extra correct detail is fine; when the gold says "both required", both are required; UNKNOWN is never correct).\n` +
      `grounded = the cited results' text actually states or directly implies the candidate's answer.\n` +
      `Reply JSON only: {"correct": true|false, "grounded": true|false, "why": "<10 words>"}`,
  }]);
  return json<Grade>(out) ?? { correct: false, grounded: false, why: "unparseable grade" };
}

interface Row { provider: string; task: string; kind: string; run: number; answer: string; correct: boolean; grounded: boolean; score: boolean; searches: number; searchMs: number[]; errors: string[]; why: string }

async function runTask(p: string, t: Task, run: number): Promise<Row> {
  const pool = new Map<number, Hit>();
  const searchMs: number[] = [];
  const errors: string[] = [];
  let nextId = 1;
  const doSearch = async (q: string) => {
    const t0 = performance.now();
    try {
      const hits = await providers[p].search(q);
      searchMs.push(performance.now() - t0);
      return hits.map((hit) => { const id = nextId++; pool.set(id, hit); return { id, hit }; });
    } catch (e) {
      searchMs.push(performance.now() - t0);
      errors.push(String(e).slice(0, 160));
      return [];
    }
  };

  let ans: Answer = { answer: "UNKNOWN", sources: [] };
  if (mode === "single") {
    const hits = await doSearch(t.q);
    const out = await llm(READER, READER_SYS, [{ role: "user", content: `Question: ${t.q}\n\nSearch results:\n${fmt(hits) || "(no results)"}\n\n${SINGLE_FMT}` }]);
    ans = json<Answer>(out) ?? ans;
  } else {
    const msgs: Msg[] = [{ role: "user", content: `Question: ${t.q}\n\n${AGENT_FMT}` }];
    for (let turn = 0; turn <= MAX_SEARCHES; turn++) {
      const out = await llm(READER, READER_SYS, msgs);
      msgs.push({ role: "assistant", content: out });
      const act = json<{ action: string; query?: string } & Answer>(out);
      if (act?.action === "search" && act.query && searchMs.length < MAX_SEARCHES) {
        const hits = await doSearch(act.query);
        const left = MAX_SEARCHES - searchMs.length;
        msgs.push({ role: "user", content: `Results for "${act.query}":\n${fmt(hits) || "(no results)"}\n\n${left ? `${left} searches left.` : "No searches left: answer now."} JSON only.` });
        continue;
      }
      if (act?.action === "answer") { ans = act; break; }
      msgs.push({ role: "user", content: "No searches left or invalid reply. Answer now with the answer JSON." });
    }
  }
  const g = await grade(t, ans, pool);
  return { provider: p, task: t.id, kind: t.kind, run, answer: String(ans.answer).slice(0, 200), correct: !!g.correct, grounded: !!g.grounded, score: !!g.correct && !!g.grounded, searches: searchMs.length, searchMs, errors, why: g.why };
}

async function pmap<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await f(items[k]); } }));
  return out;
}

const started = Date.now();
const rows = (await Promise.all(selected.map((p) => {
  const jobs = Array.from({ length: runs }, (_, r) => tasks.map((t) => ({ t, r }))).flat();
  return pmap(jobs, concurrency(p), async ({ t, r }) => {
    const row = await runTask(p, t, r).catch((e: unknown) => ({ provider: p, task: t.id, kind: t.kind, run: r, answer: "", correct: false, grounded: false, score: false, searches: 0, searchMs: [], errors: [`task: ${String(e).slice(0, 160)}`], why: "crashed" }));
    process.stderr.write(`${row.score ? "✓" : "✗"} ${p} ${t.id}\n`);
    return row;
  });
}))).flat();

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const summary = selected.map((p) => {
  const r = rows.filter((x) => x.provider === p);
  const ms = r.flatMap((x) => x.searchMs);
  const byKind = Object.fromEntries([...new Set(tasks.map((t) => t.kind))].map((k) => { const kr = r.filter((x) => x.kind === k); return [k, `${kr.filter((x) => x.score).length}/${kr.length}`]; }));
  return {
    provider: p,
    score: +(100 * r.filter((x) => x.score).length / r.length).toFixed(1),
    correct: +(100 * r.filter((x) => x.correct).length / r.length).toFixed(1),
    p50ms: Math.round(median(ms)),
    searches: ms.length,
    errors: r.reduce((a, x) => a + x.errors.length, 0),
    ...byKind,
  };
}).sort((a, b) => b.score - a.score || a.p50ms - b.p50ms);

mkdirSync("results", { recursive: true });
const file = `results/${roundName}-${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ roundName, mode, runs, reader: READER, grader: GRADER, rows, summary }, null, 2));
console.table(summary);
console.log(`saved ${file} in ${Math.round((Date.now() - started) / 1000)}s`);
