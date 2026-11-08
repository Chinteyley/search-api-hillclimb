# search-api-hillclimb

We needed one web search API to use as the default for our coding agents, so we tested 10 of them by hill climbing. Every provider got the same questions, the weakest dropped out each round, and the next round was harder. The last round is the one that matters most to us: 36 hard, English-only coding questions of the kind we look up mid-task.

Run on **2026-11-08**, using each provider's free tier.

## Result

**Exa was the only provider with a perfect score, and it was also among the fastest.** The top five are within 3 answers of each other out of 182, so speed and price separate them more than accuracy does.

| # | Provider (config) | Score | Coding round | Search p50* | List price / 1k searches |
|---|---|---|---|---|---|
| 1 | **Exa** (`type=auto`) | **182/182** | 36/36 | 1.2s | $7 |
| 2 | **Parallel** (`mode=basic`) | 180/182 | 36/36 | 1.5s | $5 |
| 3 | **Tavily** (`search_depth=advanced`) | 180/182 | 34/36 | 2.5s | $16 |
| 4 | **Context.dev** (search + highlights) | 181/182 | 36/36 | 6.3s | ~$4.40 |
| 5 | **You.com** (`highlights`) | 94/96 | 36/36 | 1.0s | $5 |
| | Exa deep (`type=deep`) | 122/122 | 36/36 | 3.3s | $12 |
| | Parallel advanced (`mode=advanced`) | 121/122 | 36/36 | 2.4s | $5 |
| | Valyu (`search_type=web`) | 179/182 | 35/36 | 4.3s | ~$6.25 |
| | Linkup (`depth=standard`) | 92/96 | 35/36 | 1.5s | $5 |
| | Firecrawl (`/v2/search`) | 90/96 | 34/36 | 0.9s | $5 |
| | TinyFish | 55/60 | 34/36 | 2.3s | free (rate-limited) |
| | Jina (`s.jina.ai`) | 49/60 | 33/36 | 17.5s | token-based |

\* Median time per search in the coding round, the only round where every provider received new queries. Repeated queries in earlier rounds were served from provider caches, so those times are not comparable. Totals differ between providers because the bottom of the field was dropped after rounds 1 and 2. Prices come from the providers' pricing pages and may change.

**Choosing one:** Exa as the default. Parallel is the cheaper alternative with nearly the same accuracy. Tavily is just as accurate on general questions, but slower, the most expensive, and it returned stale package versions twice. Context.dev is very accurate, but its free plan allows one request at a time and its searches took about 6s. You.com is the fastest and scored 36/36 on coding, but it was dropped before the two hardest general rounds.

## Method

- **Search only.** Each provider returns up to 10 results. Every snippet is capped at 1,200 characters, so all providers fill the same context budget.
- **Grounded scoring.** A reader model answers **only** from the search results, citing result numbers, or says `UNKNOWN`. A grader model scores an answer as passing only when it is **correct** and the cited results **actually state it**. An answer the reader knew from its own training does not count.
- **Two modes.** In `single` mode the model makes one search with the question as written. In `agent` mode it writes its own queries, up to 4 searches.
- **Rounds:**
  1. Qualifier, 24 questions: config defaults from docs, obscure facts, 2-step lookups. All 10 providers, single mode. Jina and TinyFish dropped out.
  2. 18 questions: releases from the last 4 months, multi-hop questions, exact values from docs. Single and agent modes. You.com, Linkup and Firecrawl dropped out.
  3. 23 questions: exact release dates, values from RFCs and specs, puzzle-style lookups. Single mode run twice, plus agent mode.
  4. 17 questions on our stack (Next.js 16, Expo SDK 58, React Native, Bun, TanStack, Tailwind 4) and long-tail facts about Cambodia. Single mode.
  5. **Coding:** 36 questions, all 12 configs, single mode. Topics: Next.js 16, React 19, the React Native New Architecture, Expo/EAS, Bun, TypeScript 5.8, Node.js, Postgres 18, Drizzle, Zod 4, Tailwind 4, TanStack Query 5, Zustand 5, pnpm 10, Vite, GitHub Actions, Docker, git, uv, Rust and Go, plus 4 checks of the latest npm version.
- **Gold answers** for latest versions and release dates come from npm, GitHub releases, nodejs.org, endoflife.date and expo.dev, read on the day of the test.
- **Models:** rounds 1–3 used `gpt-5.6-sol` as reader and `gpt-6.1-sol` as grader. The GPT quota ran out partway through round 4, so round 4 and the coding round used `deepseek-v4.1` for both. Within a round, every provider had the same models.

## Caveats

- **Gold answers we got wrong, then fixed:** the Redis 7 default for `hash-max-listpack-entries` is 512, not 128. Expo SDK 58 was released on 2026-10-15, not on the date its npm package was first published. The Docker question's gold answer over-specified `target=<path>`, and that question was rerun for every provider. None of these fixes changed the ranking.
- **Discarded runs, not included here:**
  - Early smoke runs, and a round 1 run where free-tier rate limits (429s) were scored as wrong answers. Retries and per-provider concurrency limits fixed that.
  - Round 4 runs that crashed when the LLM quota ran out.
  - DeepSeek agent-mode runs, where the reader often answered from memory without searching, so the results said nothing about the providers.
- **Not tested:** Perplexity, which needs paid credits before it issues a key, and Brave, whose account sign-in was blocked.
- **No repeats on most rounds.** Each config ran once, except round 3 single mode, which ran twice. The questions were written by us. Differences of 1–2 answers are noise.
- **Rate limits hurt in practice.** Context.dev's free plan allows 1 request at a time, Firecrawl throttles bursts, and Jina used up its free 10M tokens during the test.

## Run it

```sh
bun install   # no dependencies beyond Bun
# one file per key, e.g. ~/.config/search-bench/keys/EXA_API_KEY
# (override the directory with SEARCH_BENCH_KEYS)
export ANTHROPIC_BASE_URL=... ANTHROPIC_AUTH_TOKEN=...   # any Messages-API-compatible endpoint
READER=deepseek-v4.1 GRADER=deepseek-v4.1 bun bench.ts coding single 1 exa parallel tavily
bun summarize.ts   # rebuilds results/summary.json
```

`providers.ts` has one adapter per provider, `tasks.ts` has every question with its gold answer, and `results/*.json` holds every graded answer with the grader's reason.
