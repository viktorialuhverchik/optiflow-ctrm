# Optiflow CTRM — recap extractor

Turns a free-text trade recap into one structured deal object, running entirely on
a self-hosted open-weights model. No frontier-model API anywhere in the extraction
path.

> **Status: phases 0 to 6, 8 and 9 of `docs/tasks.md` are complete.** The extractor
> passes the release gate, the MCP server runs, and the local model answers the
> provisional-value question using both tools. Phase 7, the second configuration
> and the agent spend, is deferred and is the main gap. No number appears in this
> README that was not produced by a command in this repository.

---

## What is this?

A physical oil-products deal begins as a recap: a short message on Telegram,
WhatsApp or email in which a trader and a counterparty fix the commercial terms.
Everything downstream is built on it, including the contract, the pricing, the
nomination, the invoice and the P&L. Today the client re-types recaps into Excel
by hand.

This repository extracts that message into a validated JSON deal object, and,
more importantly, **knows when it must not answer**. A recap that says "price tbc
as per our call" has no differential. The correct output is `null` plus a specific
question back to the trader. A system that instead invents a plausible discount
produces a provisional invoice that is quietly wrong, and that error surfaces in a
dispute rather than in a test.

The engineering problem is not parsing. It is getting measurable, trustworthy
behaviour out of a model that is meaningfully weaker than a frontier one, and
knowing the difference between a mistake the harness catches and a confident
mistake that reaches an invoice.

## How does it work?

Four stages. The important design decision is the split in the middle.

```
recap text
   |
   v
[1] prompt + grammar-constrained decode   llm/      the model reads text and
   |                                                reports values with spans
   v
[2] verbatim evidence check               extract/  is the quote in the message?
   |
   v
[3] canonicalisation                      domain/   "over B/L +0/+3" -> "B/L +0/+3"
   |
   v
[4] calendar and schema validation        extract/  shape is not correctness
   |
   v
[5] evidence support checks               extract/  do those words support THIS
   |                                                value? refuse-only rules
   v
[6] resolve and compute                   domain/   pure TypeScript does all
   |                                                arithmetic and lookups
   v
deal object + questions
```

**The model never does arithmetic.** It does not convert barrels to tonnes,
average quotations, resolve `B/L +0/+3` into dates, or apply an FX rate. It reads
the text and reports what it saw, with the span it saw it in. Every number that
could reach an invoice is computed by pure code with unit tests. This shrinks the
hallucination surface to the one thing a language model is actually good at.

Three mechanisms carry the abstention behaviour:

1. **Every field is nullable in the decoding grammar itself.** If the grammar has
   no legal path to "not stated", constrained decoding forces the model, token by
   token, into inventing a differential. Abstaining has to be a legal parse.
2. **Evidence spans are mandatory and checked.** A value whose quoted evidence is
   not a verbatim substring of the recap is rejected. This turns a large class of
   confident nonsense into a detectable failure, with no second model call.
3. **A null mandatory field must carry a question.** A silent null is scored as a
   worse outcome than a null with a question that names the field.
4. **Deterministic refuse-only checks sit after the model.** Four rules ask
   whether the quoted evidence supports the specific value rather than merely
   existing in the message. They took invented values from four to zero, after
   four explicit prompt instructions had failed to. Stage 5 above.

Full rules in [`docs/rules-and-constraints.md`](docs/rules-and-constraints.md).

## Technology choices

| Choice | Why | Main alternative and the trade-off |
|---|---|---|
| **TypeScript on Node 22** | The whole path stays in one language, inference included. | Python has the better structured-generation ecosystem, Outlines and XGrammar in particular. That would mean a process boundary. |
| **node-llama-cpp v3** for inference | Runs GGUF in-process with prebuilt Metal binaries. Exposes GBNF grammars, seed, temperature and context size directly, so the eval controls every knob. No daemon. The model is pinned by file hash. | Ollama is easier but hides sampling defaults and mutates model tags. LM Studio is pleasant but a GUI is a poor reproducibility dependency. Running `llama-server` is a good option that costs a managed process; it is supported here as a second adapter. |
| **Grammar-constrained decoding** | Guarantees the output shape at the token level rather than hoping for it. | Function calling on a 7B to 14B open model is chat-template dependent and produces well-formed calls with wrong arguments, which is exactly the failure being targeted. JSON mode guarantees parseable JSON and nothing about the fields. Retry-and-repair as the primary mechanism is nondeterministic and tends to repair toward plausible rather than correct; it is kept only as one bounded fallback, and it is counted in the report. |
| **Zod as the single schema source** | One definition drives the grammar, the runtime validation, the MCP tool signatures and the eval expectation loader. | Hand-written JSON Schema drifts from the TypeScript types. |
| **decimal.js** | Differentials, tonnages and tolerances end up on invoices. Floats do not belong there. | Native `number` is faster and wrong. |
| **A provider interface with two adapters** | The eval harness has to swap models to be worth anything. | Hard-coding one runtime makes the configuration comparison in Part 4 impossible. |
| **Bespoke eval runner, `vitest` for units** | The eval output is a scored table and a JSON report, not pass or fail. | Running the eval inside `vitest` conflates model measurement with regression testing. |

Model selection is decided by the harness, not asserted up front. The starting
candidate is Qwen3-8B at Q4_K_M, roughly 5 GB of weights, chosen to leave headroom
for a long context on a 16 GB machine. Contenders benchmarked against it are
listed in `docs/tasks.md` phase 7. Quantisation stays at Q4_K_M or above, because
digits are where aggressive quantisation degrades first and every field that
matters here is a number.

## How do I run it?

Node 22 and pnpm are the prerequisites.

```bash
pnpm install && pnpm check
```

`pnpm check` runs three things in order: the guard that fails the build if a
frontier-model SDK, hostname or API-key variable appears in the source or the
dependency manifest, then the TypeScript strict typecheck, then the unit suite.
None of it needs a model.

To run the model, fetch the weights and check them against the manifest:

```bash
curl -L -o models/Qwen3-8B-Q4_K_M.gguf https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf
```

```bash
pnpm model:verify && pnpm model:smoke
```

Then extract a recap:

```bash
pnpm -s extract data/recap_01.txt --date 2026-08-11
```

The deal object goes to stdout as JSON, and the questions back to the trader go
to stderr, so the command can be piped. Use `pnpm -s` rather than `pnpm`, or the
package manager's own banner lands in the JSON.

`--date` is required and is not a formality. The extractor never reads the system
clock, so a laycan written without a year has nothing to resolve against unless
the caller supplies it.

The weights are not committed. `models/manifest.json` is, and it pins the file by
SHA-256. The hash there is the upstream Hugging Face LFS object id, so it can be
checked against the source rather than only against whatever this machine
downloaded.

### The MCP server

```bash
pnpm mcp
```

Two tools over stdio. `parse_recap(text, reference_date)` returns the deal, the
questions and the diagnostics. `get_price_quote(quote_code, date_or_period,
statistic, bl_date)` averages a published quotation and returns the individual
rows it used, so the number can be checked by hand. It contains no model at all,
and the model loads lazily so a client can ask for a price without waiting for
five gigabytes.

```bash
pnpm mcp:smoke            # drives the real server over a real stdio pipe
pnpm mcp:smoke --with-model
```

`bl_date` is an addition to the signature in the brief. A B/L-relative period
cannot be resolved without a bill of lading date, and defaulting to today would
price a window nobody asked for, so the tool refuses instead.

### The provisional-value demo

```bash
pnpm mcp:demo --runs 5
```

The local model answers "what is the provisional value of the deal in
recap_02.txt?" by calling both tools. The MCP client and server are linked
in-process rather than over a pipe, so the agent and the extractor share one
model instead of loading two on a 16 GB machine. It is the same server object and
the same registered tools that `pnpm mcp` exposes.

## How do I run the evaluation?

```bash
pnpm eval --extractor=model
```

`--extractor` selects what is being measured: `model`, or the `null` and `regex`
baselines. The same flag runs the configuration comparison in phase 7. Other
options:

```bash
pnpm eval --extractor=model --report reports/run.json
pnpm eval --only 02-naphtha --extractor=regex
pnpm eval:compare reports/before.json reports/after.json
```

`eval:compare` prints the headline movement and every field that changed outcome
in either direction, then says whether to keep the change. A change that lifts
accuracy while adding an invented value is rejected, which is how the rejected
runs in the table below were caught.

The table goes to stdout, progress goes to stderr, and the command exits non-zero
when the release gate fails, so it can gate a build directly.

Cases live in `data/eval-cases/`, one directory each, holding the recap, a flat
map of expected field values, and a metadata file with the case class and the
reference date. Expected values are a flat map rather than a whole deal object
because that is what a reviewer can read in a diff. The loader rejects an unknown
field path, a mandatory field with no stated expectation, and a JSON number where
a decimal string belongs.

The JSON report separates a `scores` block from a `timings` block. Scores are
byte-identical across runs for a fixed extractor, so two reports can be diffed to
prove a change did nothing. Timings never are.

Each mandatory field in each case lands in exactly one of six buckets:

| Outcome | Meaning |
|---|---|
| `correct` | matches the expected value |
| `correct_abstention` | expected null, produced null, with a question naming the field |
| `unflagged_abstention` | expected null, produced null, no question |
| `wrong_abstention` | expected a value, refused. Over-refusal. |
| `wrong_value` | produced a different value |
| `confident_nonsense` | expected null, produced a number. **The one that costs money.** |

Headline metric is the **silent error rate**: the fraction of cases with at least
one wrong mandatory field that carried no question. The release gate is
`confident_nonsense` on any pricing or quantity field being zero.

Two baselines ship alongside the model extractor and are built first: an all-null
extractor and a regex extractor. The first proves the metric cannot be gamed by
refusing everything. The second gives a floor the model has to beat.

## What were the results?

All twenty cases, from `pnpm eval`. The two baselines exist to calibrate the
metric; the model column is the system under test.

| | null baseline | regex baseline | Qwen3-8B |
|---|---|---|---|
| field accuracy | 0.0% | 78.7% | 86.6% |
| correct abstention | 100.0% | 84.2% | 100.0% |
| over-refusal | 100.0% | 15.2% | 8.4% |
| invented values | 0 | 3 | 0 |
| silent error rate, money fields | 0.0% | 35.0% | 10.0% |
| silent error rate, any field | 0.0% | 85.0% | 65.0% |
| p50 latency per recap | under 1 ms | under 1 ms | 41.4 s |
| release gate | pass | **fail** | **pass** |

Cases scored: 20. Mandatory fields scored: 400. Every report is committed under
`reports/`.

The model beats both baselines on every axis except latency. It never invents a
money-critical value, it asks about every field it refuses, and it is eight points
more accurate than the patterns. It costs forty seconds a recap against under a
millisecond, which for a message a trader types once and a desk pays an analyst to
re-key is not the binding constraint.

By case class:

| class | regex | Qwen3-8B |
|---|---|---|
| clean | 87.5% | 88.8% |
| distractor | 85.0% | 90.0% |
| must_abstain | 78.2% | 88.1% |
| non_usd | 90.0% | 95.0% |
| thread_amendment | 56.3% | 77.5% |
| unit_mismatch | 90.0% | 85.0% |

### How it got there

The first working version did not beat the regex baseline and was less safe than
it. Phase 6 was six measured runs, each a hypothesis kept only when the table
improved. The whole progression is committed, including the two changes that were
rejected.

| run | what changed | accuracy | abstention | invented | silent money | gate |
|---|---|---|---|---|---|---|
| v1 | first working extractor | 79.0% | 78.9% | 4 | 75.0% | fail |
| v2 | field rules in the prompt | 82.4% | 73.7% | 5 | 75.0% | fail |
| v3 | the same rules compressed | 81.9% | 73.7% | 5 | 55.0% | fail |
| v4 | explicit refusal rules | 84.8% | 78.9% | 4 | 50.0% | fail |
| v5 | evidence support checks in code | 84.8% | 94.7% | 1 | 45.0% | fail |
| v6 | fixed a bug in my own check | 84.8% | 100.0% | 0 | 45.0% | **pass** |
| v7 | canonicalise the pricing period | 86.6% | 100.0% | 0 | 10.0% | **pass** |

**The central finding is that prompting could not close the gate.** v4 put one
line in the system prompt for each of the four known invented values, naming the
exact mistake. Accuracy improved and all four inventions survived unchanged. The
model's prior toward supplying the obvious industry default is stronger than an
instruction telling it not to, and on a model this size that is not something a
better sentence fixes.

What worked was moving the guarantee into code. `src/extract/support.ts` holds
four deterministic rules that ask whether the quoted evidence supports the
specific value, rather than merely existing in the message: a quantity qualified
by "about" or written as a cargo range is not firm, a quantity with no unit token
beside it has no unit, a pricing basis with no statistic word in it has no
statistic, and a quotation code whose series name the message never mentions is
wrong. Every rule can only move a field toward refusal. None can invent one.
Invented values went from four to zero and correct abstention from 78.9% to 100%.

Two other things are worth recording because they were wrong.

**v3 disproved my own diagnosis.** When v2 lifted accuracy but cost abstention, I
assumed the extra prompt length was priming refusal, and compressed it. Accuracy
moved half a point and the abstention loss and the extra invented value stayed
exactly where they were. The hypothesis was wrong, and the run is committed rather
than deleted.

**v6 was a bug in the check I had just written.** The quotation rule matched
substrings, so the token "10" from "Platts CIF NWE ULSD 10 ppm" matched inside the
date `14.10.2026` and vouched for a series the message never named. Whole-word
matching and dropping numeric-only tokens took the last invented value out. The
regression test is in `src/extract/support.test.ts`.

**v7 was a real defect the eval nearly scored as cosmetic.** The model returned
"over B/L +0/+3" about a third of the time. The domain period parser is anchored,
so the leading word made the period unparseable, which means no pricing window and
no invoice. The prompt already asked for it to be dropped and the model did so
unreliably. Stripping it in code lifted accuracy 1.8 points and cut the
money-field silent error rate from 45% to 10%.

**The metric cannot be gamed by refusing.** The null baseline returns null for
every field with a question attached. It scores a perfect abstention rate and a
perfect silent error rate, and it is worthless, because its accuracy is zero and
its over-refusal is total. No single headline number would have shown that, which
is why accuracy and abstention are reported separately and never averaged.

**The silent error rate is reported two ways because the broad one saturates.**
With twenty mandatory fields a case and accuracy in the eighties, almost every
case carries at least one unflagged wrong field, so the all-fields number sits at
65% and separates a good extractor from a very good one poorly. The money-fields
version, at 10%, is the number that maps to a bad invoice and the one to steer by
now that the gate passes.

**Three unflagged wrong money-critical fields remain, and none is a specification
gap.** A mean-of-high pricing basis read as a plain mean, and an amended quantity
and tolerance taken from the superseded line of a forwarded thread. Both are
reasoning failures on the hardest cases in the set, and both are open items in
`docs/tasks.md`.

### The model runtime

Measured by `pnpm model:smoke` on an Apple M2 Pro with 16 GB of unified memory.
This is the runtime alone, not extraction: it establishes that the model loads,
decodes deterministically, honours a grammar, and fits.

| | |
|---|---|
| model | Qwen3-8B, Q4_K_M, 4.7 GiB of weights |
| runtime | llama.cpp b10361 through node-llama-cpp 3.20.0, Metal |
| context | 8192 tokens, one sequence |
| model load | 1.1 s |
| peak resident memory | 6189 MiB |
| sustained throughput | 31.7 tokens/s over a 303-token generation |
| short-prompt throughput | 10.1 tokens/s over a 14-token generation |
| three identical prompts | byte-identical answers |
| grammar-constrained output | parsed, enums honoured |

The two throughput figures are both real and they measure different things. A
fourteen-token answer is mostly first-token latency and prompt processing, so its
rate is not throughput. Extraction output is closer to the long generation than
the short one, but the recap in the prompt is longer than anything here, so
neither number predicts end-to-end latency. That gets measured directly at phase 7.

Peak memory leaves room on a 16 GB machine, which is what makes the 8B the
sensible starting point rather than the 14B.

**One finding already worth acting on.** Asked for the quantity in
`30,000 MT +/- 10% in seller's option` under a grammar that permits any string,
the model returned `"30,000"` with the thousands separator intact. The deal
schema rejects that, by design, because a separator is where a parse silently
turns into a different number. The grammar has to constrain the numeric fields to
a plain decimal shape rather than to any string. That was fixed in the grammar
before the first eval run, and it is exactly the kind of thing the smoke test
exists to surface early.

End-to-end extraction, measured by the final eval run over twenty recaps:

| | |
|---|---|
| p50 latency per recap | 41.4 s |
| p95 latency per recap | 49.2 s |
| whole suite | 14 min 5 s |
| prompt tokens per recap | roughly 1600 |
| completion tokens per recap | roughly 1100 |
| repair retries fired | 0 |

Forty seconds a recap is the honest cost of asking for thirty-nine fields, each
with an evidence span, in one constrained pass. The all-null object alone is
2.5 KB of minified JSON. Cutting it is a phase 7 question.

No repair retry fired across twenty cases in any of the seven runs, which says the
grammar plus Zod combination holds the shape without needing a fallback.

Verbatim evidence checking rejected nothing, which is weaker news than it sounds:
the model quoted real text every time, not the right text. Case 8 takes the
superseded quantity from a thread and quotes it accurately from the message.
Verbatim checking cannot catch that, which is why the support checks ask the
harder question of whether the quoted words support the specific value, and why
the thread cases exist.

The configuration comparison and agent spend are filled in at phase 7.

### The MCP demo

`pnpm mcp:demo`, five runs in each mode. The model chooses the tool calls. Every
number in the answer is computed by `src/domain/valuation.ts`.

```
component                                    value
----------------------  --------------------------
quotation               ARGUS_CIF_NWE_NAPHTHA mean
pricing window              2026-09-11..2026-09-15
quotation average                  598.2633 USD/MT
differential                           8.00 USD/MT
unit price                         606.2633 USD/MT
quantity as agreed                      220000 BBL
quantity as priced                      24719.1 MT
provisional value, USD                 14986283.82
provisional value, EUR                 13809697.59
```

Every assumption is printed with it, because an estimate with no stated basis is
indistinguishable from an invented number once it is on an invoice. No bill of
lading exists, so the window is anchored on the first day of the laycan. The
quantity was agreed in barrels and the price is per tonne, converted at the factor
from `products.csv`. Three of the five days in the window published.

**Tool-calling reliability**, five runs each:

| behaviour | native | grammar |
|---|---|---|
| called `parse_recap` | 5/5 | 5/5 |
| called `get_price_quote` | 0/5 | 5/5 |
| passed on the quotation code it was given | 0/5 | 5/5 |
| passed on the statistic it was given | 0/5 | 5/5 |
| supplied a B/L date estimate | 0/5 | 5/5 |
| completed both calls and stopped | 0/5 | 5/5 |
| mean seconds per run | 30.8 | 7.4 |

**Native function calling does not work on this model.** It calls `parse_recap`
correctly every time, receives the deal, and then emits an empty response and
stops rather than chaining to the second tool. One run mangled a filename
argument into `data/recap_02txt`, dropping the dot, which is unconstrained
argument generation failing in the most ordinary way possible.

**The fallback is the same mechanism as the extractor.** The next action is
decoded under a grammar built from the two tool schemas, so the tool name is one
of three literals and every argument is constrained to its type or its enum. It
is 5 of 5 on everything the agent controls, at a quarter of the latency. A local
model of this size can drive tools reliably; it cannot be trusted to invent the
call format while it does so.

**The one wrong number in the answer is the extractor's, not the agent's.** The
agent passed on the statistic `parse_recap` gave it in all five runs. That
statistic is wrong: the recap says mean of the high quotations and the extractor
read a plain mean. Priced correctly the same cargo is USD 15,025,834, a difference
of USD 39,551 on one field. Nothing else in the pipeline would have caught it. The
eval scores it as wrong, which is the entire argument for building the harness
first.

A full transcript of all ten runs is committed at
`reports/mcp-demo-transcript.md`.

## What are the known problems?

Written from the design as it stands. Rewritten with observed failures once the
eval runs.

- **Constrained decoding cannot make a model correct, only well-formed.** It kept
  every answer parseable across seven runs and 140 extractions with no repair
  retry, and it did nothing at all about the four invented values. Those needed
  deterministic checks in code.
- **The support checks are pattern rules and will misfire.** A quantity legitimately
  described as "about" would be refused, and a quotation named only by its
  publication would be dropped. They fail toward over-refusal by construction,
  which is the safe direction, but the over-refusal cost is real and currently
  8.4%.
- **Evidence checking catches invented values, not misattributed ones.** Case 8
  takes the superseded quantity from a forwarded thread and quotes it accurately.
  No amount of evidence checking catches that, and it is one of the three
  remaining unflagged money-field errors.
- **Threads are the hard part, and remain so.** At 77.5% they are eleven points
  below the next worst class, and both of the model's remaining reasoning failures
  are in them. Distractors turned out not to be hard: the model scores 90.0% there.
- **Reproducibility is bounded.** It holds for a fixed model file and a fixed
  runtime version. Bit-identity across llama.cpp versions is not claimed.
- **Twenty cases is small.** Several classes hold two cases, so a class
  percentage moves in large steps and should be read as a direction rather than a
  measurement. The cases were written before any extractor was tuned, so at least
  they are not fitted to a model's habits.
- **Seventeen of the twenty cases are invented**, which means they carry the
  assumptions of whoever wrote them about how traders write. The three supplied
  recaps are the only ground truth about real phrasing in the set.
- **Expected values encode judgement calls.** Whether "Augusta, Italy" or
  "Augusta" is the delivery place, and whether a spec qualifier belongs to the
  product field, are decisions rather than facts. They are written down as rules
  in the constraints doc so a reviewer can disagree with the rule rather than
  guess at the intent.
- **The 16 GB ceiling is real.** It rules out the model sizes that would most
  obviously help, and there is no comparison table yet to show what is being
  given up. Phase 7 is deferred, so the second configuration and the agent spend
  are the biggest gaps in this write-up.
- **Native tool calling is unusable on this model**, at 0 of 5 completed runs. The
  grammar-constrained fallback works, but it means an off-the-shelf MCP client
  pointed at this server will not get through the two-step question on its own.
  Anything driving these tools needs constrained decoding on its side too.
- **The provider is single-sequence and not re-entrant.** An MCP tool handler that
  calls back into the model during generation used to corrupt both silently. It
  now throws, which is correct, but it means concurrent requests need a second
  provider and a second five gigabytes.
- **The provisional value rests on an estimated bill of lading date.** No B/L
  exists, so the window is anchored on the first day of the laycan. The figure
  moves if the vessel loads on another day, which is why every assumption is
  printed with the number.
- **Expected outputs are hand-written**, so they carry human error. The loader
  validates them against the schema, which catches shape mistakes but not wrong values.

## What would I do next?

Filled in properly once there are numbers. The current plan, in order:

1. Attack the thread class directly. It is the only class below 85% and it holds
   both remaining reasoning failures. The untested idea is an explicit amendment
   pass over the thread before extraction, measured against the single pass.
2. Cut the forty-second latency. Thirty-nine fields with an evidence span each is
   most of the cost, and field-group splitting or a shorter evidence budget are
   both worth a measured run.
3. Do phase 7: a second configuration, so the quality against latency against
   memory trade-off is visible rather than asserted. A 4B model at the same
   quantisation and the 8B at a longer context are the two obvious runs.
4. Expand the eval set where the per-class breakdown is thin. Four classes hold two
   or four cases, so a class percentage moves in large steps.
5. Report the agent spend for building this, which is a Part 4 deliverable I
   cannot read from inside the session.

## Repository layout

```
data/    supplied recaps, field spec, domain primer, reference CSVs
docs/    rules-and-constraints.md   the single source of truth
         code-style.md              conventions followed while writing the code
         tasks.md                   the implementation checklist, kept current
src/     domain/  pure. schema, dates, units, pricing, fx, normalise, questions
         io/      the filesystem edge, kept out of domain/ so it stays pure
         llm/     provider interface, two adapters, GBNF grammar builder
         extract/ orchestration, prompt, evidence and support checks
         eval/    scorer, runner, report, compare, rescore, baselines
         mcp/     the two-tool server (phase 8)
reports/ every committed eval run, including the rejected ones
models/  manifest.json pins the weights by hash; the .gguf files are not committed
scripts/ guard-no-frontier-api.mjs, run by `pnpm check`
```

## Disclosure

Coding agents were used to build this repository, which the brief permits and
expects. They are not in the inference path: the built system calls a locally
hosted open-weights model and nothing else. A guard script greps the source and
the dependency tree for frontier-model SDKs and fails the build on a hit.
