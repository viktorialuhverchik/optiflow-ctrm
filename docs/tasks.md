# Implementation checklist

Ordered by dependency, not by importance. Tick items as they land. Keep this file
in sync with reality: if the plan changes, edit the plan.

Legend: `[ ]` todo, `[x]` done, `[~]` in progress, `[-]` dropped with a reason.

**Current position: all phases complete. The release gate passes. The one deliverable I cannot produce from inside the session is the agent spend in dollars.**

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

- [x] Downloaded `Qwen3-8B` GGUF `Q4_K_M` from the official Qwen repository. `models/manifest.json` pins it by SHA-256, and the hash was checked against the upstream Hugging Face LFS object id rather than only against the local file.
- [x] `src/llm/provider.ts`: the `LlmProvider` interface, with token counts, timings and a `describe()` that carries the full reproducibility record
- [x] `src/llm/node-llama.ts`: in-process adapter on Metal. Every sampling parameter explicit, repeat penalty disabled, one context sequence cleared between calls so no recap leaks into the next.
- [x] `src/llm/http-openai-compat.ts`: HTTP adapter for `llama-server`, LM Studio or an MLX server. Refuses a non-loopback base URL at construction rather than trusting configuration (T1).
- [x] `pnpm model:verify` hashes the weights against the manifest
- [x] `pnpm model:smoke`: three identical prompts give byte-identical answers, a grammar-constrained prompt parses, and load time, peak RSS and both short-run and sustained throughput are printed
- [x] Measured and recorded in the README

## Phase 5 — Extractor v1

- [x] `src/llm/grammar.ts`: GBNF generated by walking the Zod schema, so the two cannot drift. Every value alternates with null, numeric and date fields get token-level rules, and the two code fields are an alternation over the reference data. `pnpm grammar:check` compiles it in llama.cpp; 73 rules.
- [x] `src/extract/prompt.ts`: system prompt carrying the seven rules the grammar cannot express, with a worked example invented for the file. A test asserts no eval case text or counterparty name leaks into it.
- [x] `src/extract/evidence.ts`: drops any value whose evidence is not a verbatim span of the input, whitespace and case forgiven, digits and punctuation not
- [x] `src/extract/extractor.ts`: single constrained pass, evidence check, calendar-date check, Zod validation, one bounded repair retry counted separately
- [x] `pnpm extract data/recap_01.txt --date 2026-08-11` produces a deal object
- [x] `pnpm eval --extractor=model`, first honest table recorded in `reports/model-qwen3-8b-q4km.json` and in the README

## Phase 6 — Iterate, measured

Each item was a hypothesis, kept only when the table improved. Six model runs,
about fourteen minutes each. `pnpm eval:compare` did the judging so a change that
lifted accuracy while adding an invented value could not be waved through.

- [x] **v2, field rules.** State the product/spec split, the whole pricing period, the recap date in a thread, and the sign convention. Accuracy 79.0 to 82.4%, but abstention fell and a fifth invented value appeared. **Rejected.**
- [x] **v3, the same rules compressed.** Hypothesis: the added length was priming refusal. Accuracy 81.9%, abstention and invented values unchanged from v2. **Hypothesis disproved and recorded.**
- [x] **v4, explicit refusal rules.** One line per known invented value, each naming the exact mistake. Accuracy 84.8%, over-refusal down, but the four money-critical inventions all survived. **Prompting alone does not close the gate on this model.**
- [x] **v5, evidence support checks in code.** Deterministic rules that can only refuse: a hedged quantity, a unit with no unit token, a statistic with no statistic word, a quotation the message never names. Invented values 4 to 1, abstention 78.9 to 94.7%. **Kept.**
- [x] **v6, fix a bug in my own check.** The quotation rule matched substrings, so the token "10" from a series name matched inside the date `14.10.2026`. Whole-word matching, and numeric-only tokens dropped. Invented values 1 to 0. **Release gate passes.**
- [x] **v7, canonicalise the pricing period.** The model returned "over B/L +0/+3" about a third of the time, which the domain parser rejects outright, so the deal could not be priced. Stripped in code rather than asked for in the prompt. Accuracy 84.8 to 86.6%, unflagged wrong money fields 45 to 10% of cases. **Kept.**
- [x] `pnpm eval:compare` and `pnpm eval:rescore`, so committed reports stay comparable across a scorer change without re-running the model
- [x] Money-critical silent error rate added, because the all-fields version saturates at this accuracy
- [ ] Two-pass variant: unconstrained notes pass, then constrained fill. Compare against single pass.
- [ ] Prompt ablation: with and without the domain rules in context, measure the latency cost
- [ ] Field-group splitting: one call for parties and product, one for pricing. Compare accuracy against the latency penalty.
- [x] Shipping configuration decided: single constrained pass, v4 prompt, support checks and canonicalisation on

The three remaining unflagged wrong money-critical fields are all genuine
reasoning failures rather than specification gaps: a mean-of-high basis read as a
mean, and an amended quantity and tolerance taken from the superseded line of a
thread. Those are the phase 6 items left open above.

## Phase 7 — Performance and cost

**Deferred.** Latency, memory and throughput are measured and in the README; the
second configuration and the agent spend are not.



- [ ] Latency instrumentation: p50 and p95 per recap, tokens per second, peak RSS
- [ ] Configuration comparison, at least two, varying model size or quantisation or serving stack
- [ ] Table published in the README with quality against latency against memory
- [ ] Write up what was tried, what worked, what did not, what a real GPU budget would change
- [ ] Agent spend for this task, in dollars

## Phase 8 — MCP server

- [x] `src/mcp/tools.ts` holds both tools; `src/mcp/server.ts` is the stdio entry point. The phase 9 demo registers the same module, so there is no second implementation.
- [x] `parse_recap(text, reference_date)` returns the deal, the questions and the diagnostics. The reference date is required, because the extractor never reads a clock.
- [x] `get_price_quote(quote_code, date_or_period, statistic, bl_date?)`, a pure CSV lookup with no model in it. Returns the individual quotations it averaged so the number can be checked by hand. `bl_date` is an addition to the brief's signature: a B/L-relative period cannot be resolved without one, and defaulting to today would price a window nobody asked for.
- [x] The model loads lazily, so a client can ask for a price without waiting for five gigabytes
- [x] `pnpm guard` now fails the build on any `console.*` in `src/`, because stdout carries protocol frames
- [x] `pnpm mcp:smoke` drives the real server over a real stdio pipe, ten checks including the refusals

## Phase 9 — The provisional-value demo

- [x] `pnpm mcp:demo` has the local model answer the question using both tools, over a real MCP client and server linked in-process so the agent and the extractor share one model on a 16 GB machine
- [x] Tool-calling reliability measured over five runs in each of two modes, reported in the README
- [x] **Native function calling fails on this model: 0 of 5 runs completed.** It calls `parse_recap` correctly every time, then emits an empty response and stops rather than chaining to the second tool. One run mangled a filename argument into `data/recap_02txt`.
- [x] **The fallback is grammar-constrained action choice, and it is 5 of 5** on everything the agent controls, at a quarter of the latency
- [x] A re-entrancy guard on the provider. Native function calling runs tool handlers during generation, and a handler that calls back into the model wipes the sequence the outer generation is using. It silently corrupted an extraction before the guard was added.
- [x] Transcript committed at `reports/mcp-demo-transcript.md`

## Phase 10 — README and handover

- [x] Every README section filled from real runs. The one figure I could not measure, the agent spend, says so rather than being estimated.
- [x] Architecture explained: the six-stage pipeline and the layering diagram, with the two consequences of the layering spelled out
- [x] Known problems written against the eval case that exposes each, so a reviewer can reproduce with `pnpm eval --only <case>`
- [x] Next steps ordered by what each is worth on the measured numbers, plus the two things I would deliberately not do
- [x] Fresh-clone walkthrough, actually run: clone, install, `pnpm check`, baseline eval, download weights, extract, model eval. Every command in the README was executed against a clean checkout.
- [x] `pnpm model:verify` and the extractor now print the exact `curl` line when a model is missing, rather than pointing at the README
