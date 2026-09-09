# Implementation checklist

Ordered by dependency, not by importance. Tick items as they land. Keep this file
in sync with reality: if the plan changes, edit the plan.

Legend: `[ ]` todo, `[x]` done, `[~]` in progress, `[-]` dropped with a reason.

**Current position: phases 0 to 3 complete. Phase 4, the local model runtime, is next.**

Guiding decision: **the eval harness is built in phase 2, before the extractor
exists.** It first scores a stub, then a deliberately dumb baseline. That way,
when a real model arrives, every change to prompt, grammar or model is measured
rather than guessed at.

---

## Phase 0 — Scaffolding

- [x] `git init`, `.gitignore` covering `node_modules/`, `dist/`, `models/`
- [x] `docs/rules-and-constraints.md`
- [x] `docs/code-style.md`
- [x] `docs/tasks.md`
- [x] `pnpm init`, TypeScript with the strict flags from the code style doc
- [x] `vitest` configured
- [x] Scripts wired so far: `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm guard`, `pnpm check`. `pnpm extract`, `pnpm eval` and `pnpm mcp` land in phases 5, 2 and 8.
- [x] Guard script `scripts/guard-no-frontier-api.mjs`: scans `src/` and the dependency manifest for frontier-model SDKs, hostnames and API-key env vars, exits non-zero on a hit. Verified in both directions.
- [x] First README skeleton with the required section headings and no numbers

## Phase 1 — Domain model, pure and testable without a model

Nothing here touches an LLM. All of it is unit tested.

- [x] `src/domain/result.ts`: `Result` type and the domain error codes. Expected failures are values, exceptions are for programmer errors.
- [x] `src/domain/brands.ts`: branded `IsoDate`, `QuoteCode`, `ProductCode`, `DecimalString` with validating constructors
- [x] `src/domain/csv.ts`: minimal RFC-4180 reader, quoted fields and CRLF handled, ragged rows rejected
- [x] `src/domain/schema.ts`: Zod deal schema built from `data/field_spec.md`, every field in a `Field<T>` envelope, every value nullable, plus the `MANDATORY_FIELDS` and `MONEY_CRITICAL_FIELDS` registries
- [x] `src/domain/references.ts`: parse and validate `products.csv` and `price_quotes.csv`, resolve codes, window quotations. `src/io/reference-files.ts` holds the filesystem edge so the domain layer stays pure.
- [x] `src/domain/dates.ts`: `DD.MM.YYYY`, long forms, `02-06 September 2026`, cross-month and cross-year laycans, `second half of October` with the convention recorded
- [x] `src/domain/units.ts`: MT and BBL conversion via `products.csv`, factor recorded, price and quantity proven to convert in opposite directions
- [x] `src/domain/pricing.ts`: parse `B/L +0/+3` and friends, resolve against a B/L date, evaluate the formula in `decimal.js`, return the quotations used
- [x] `src/domain/fx.ts`: directional pair parsing, the USD/AED peg, refusal for any other currency with no stated rate. Added to the plan during phase 1: the primer specifies the peg and the phase 9 demo needs the conversion.
- [x] `src/domain/questions.ts`: one-line questions per null mandatory field, absent and ambiguous worded differently, deterministic order
- [x] Unit tests including the awkward cases: barrels quantity with a per-tonne differential, non-USD with the pegged AED, a pricing window that runs past the end of the quotes CSV, a window whose only days are a weekend, `B/L + 3` excluding the B/L date itself
- [x] `pnpm check` green: guard, typecheck, 97 tests

## Phase 2 — Eval harness, before any model exists

- [x] `src/extract/types.ts`: the `Extractor` interface the runner depends on, and nothing else
- [x] `src/eval/score.ts`: field-level scorer implementing the six-bucket taxonomy in the constraints doc
- [x] Scorer unit tests: one per bucket, plus the assertion that a `null` without a question scores `unflagged_abstention` rather than `correct_abstention`, and that an over-refusal never counts as a silent error
- [x] `src/eval/runner.ts`: loads cases, runs an injected extractor, aggregates, no model dependency. A crashing extractor scores as a failure instead of stopping the suite.
- [x] `src/eval/report.ts` and `table.ts`: table to stdout plus a JSON report. The `scores` block is byte-identical across runs and the `timings` block is kept separate so it does not pollute that diff.
- [x] Case format fixed: `input.txt`, `expected.json`, `meta.json`, under `data/eval-cases/`. The loader rejects an unknown field path, a missing mandatory expectation and a JSON number where a decimal string belongs.
- [x] **Baseline A, null extractor**: returns null for everything with a question for each. Scores 100% abstention, 0% accuracy, 0 silent errors, gate passes. Proves the metric cannot be gamed by refusing everything.
- [x] **Baseline B, regex extractor**: crude patterns, no model. More accurate than the null baseline and unsafe with it, tripping the gate on one invented quantity. That contrast is the point.
- [x] `pnpm eval --extractor=null` and `--extractor=regex` both produce a table, and the command exits non-zero when the gate fails
- [x] `src/eval/harness.test.ts`: end-to-end guard asserting both baselines keep the properties they exist to demonstrate

## Phase 3 — The 20 eval cases

Three supplied recaps plus seventeen invented. Written before tuning the extractor,
so the cases are not fitted to the model's habits.

- [x] Cases 01 to 03: the supplied recaps, hand-written expectations, written during phase 2 to exercise the harness on real text
- [x] Class `clean` (3 more): CIF ULSD by email, FOB VLSFO by Telegram, FOB fuel oil by WhatsApp. Barrels moved to the `unit_mismatch` class instead, because every quotation we hold is per tonne, so a barrels quantity is a mixed-unit deal by construction.
- [x] Class `thread_amendment` (3): laycan and differential both corrected, quantity and tolerance option amended, and an amendment that is withdrawn in the next message
- [x] Class `distractor` (2): two numbered deals in one message where only one is agreed, and a recap followed by market chatter carrying a real differential and a real demurrage rate for other cargoes
- [x] Class `unit_mismatch` (2): barrels quantity with a per-tonne differential, and tonnes with a per-barrel differential written out in prose
- [x] Class `non_usd` (2): EUR priced off a published fixing with no rate to extract, AED at the stated peg with the parties reversed
- [x] Class `must_abstain` (5): differential to be agreed, statistic omitted, laycan and quantity unit both unstated, "delivered Rotterdam" as a non-Incoterm, and a quotation we hold no series for
- [x] Every `expected.json` validated by the loader, plus integrity tests: expected codes must exist in the reference data, expected dates must be real calendar dates, every case class must be covered, and every money-critical field must have at least one case that expects a refusal
- [x] Baselines re-run over all twenty cases, per-class breakdown sane

## Phase 4 — Local model runtime

- [ ] Download `Qwen3-8B` GGUF `Q4_K_M`, record path and SHA-256 in `models/manifest.json`
- [ ] `src/llm/provider.ts`: the `LlmProvider` interface, complete with token counts and timings
- [ ] `src/llm/node-llama.ts`: in-process adapter, explicit seed, `temperature 0`, fixed context size
- [ ] `src/llm/openai-compat.ts`: HTTP adapter for `llama-server`, LM Studio or an MLX server, for the configuration comparison
- [ ] Smoke test: one prompt, deterministic output across three runs, timings logged
- [ ] Measure and record: load time, peak RSS, tokens per second

## Phase 5 — Extractor v1

- [ ] `src/llm/grammar.ts`: Zod to JSON Schema to GBNF, restricted to the subset the runtime supports, with a test asserting the grammar accepts an all-null object
- [ ] `src/extract/prompt.ts`: system prompt carrying the domain rules, few-shot examples drawn from cases *outside* the eval set
- [ ] `src/extract/evidence.ts`: reject any value whose evidence span is not a verbatim substring of the input
- [ ] `src/extract/extractor.ts`: single constrained pass, Zod validation, one bounded repair retry that is counted separately in the report
- [ ] `pnpm extract data/recap_01.txt` produces a deal object
- [ ] `pnpm eval` against the real model, first honest table recorded

## Phase 6 — Iterate, measured

Each item is a hypothesis. Keep it only if the eval table improves. Record the
before and after numbers in the README, including the changes that did not work.

- [ ] Drive `confident_nonsense` on pricing and quantity to zero. This is the release gate.
- [ ] Two-pass variant: unconstrained notes pass, then constrained fill. Compare against single pass.
- [ ] Thread handling for `recap_02`: does newest-first ordering or an explicit amendment step beat plain concatenation
- [ ] Prompt ablation: with and without the domain primer in context, measure the latency cost
- [ ] Field-group splitting: one call for parties and product, one for pricing. Compare accuracy against the latency penalty.
- [ ] Decide the shipping configuration and write down why

## Phase 7 — Performance and cost

- [ ] Latency instrumentation: p50 and p95 per recap, tokens per second, peak RSS
- [ ] Configuration comparison, at least two, varying model size or quantisation or serving stack
- [ ] Table published in the README with quality against latency against memory
- [ ] Write up what was tried, what worked, what did not, what a real GPU budget would change
- [ ] Agent spend for this task, in dollars

## Phase 8 — MCP server

- [ ] `src/mcp/server.ts` over stdio, sharing `extract/` and `domain/`, no duplicated logic
- [ ] `parse_recap(text)` returning both the deal and the questions
- [ ] `get_price_quote(quote_code, date_or_period, statistic)`, a pure CSV lookup with no model call
- [ ] Verify nothing writes to stdout except protocol frames
- [ ] Manual smoke test through an MCP client

## Phase 9 — The provisional-value demo

- [ ] Local model calls both tools to answer "what is the provisional value of the deal in `recap_02.txt`?"
- [ ] Measure tool-calling reliability over repeated runs and report the success rate
- [ ] If unreliable, build and document the fallback: constrained decoding of the tool call, or a fixed orchestration with the model used only for extraction
- [ ] Transcript committed

## Phase 10 — README and handover

- [ ] Every README section filled from real runs, no invented numbers
- [ ] Architecture explained, layering diagram included
- [ ] Known problems and failure cases written honestly, with the eval cases that expose them
- [ ] Next steps
- [ ] Fresh-clone walkthrough: install, run the extractor, run the eval, see the table
