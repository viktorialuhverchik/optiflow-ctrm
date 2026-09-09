# Optiflow CTRM — recap extractor

Turns a free-text trade recap into one structured deal object, running entirely on
a self-hosted open-weights model. No frontier-model API anywhere in the extraction
path.

> **Status: phases 0 to 3 of `docs/tasks.md` are complete.** The domain layer, the
> eval harness and the full twenty-case set are built and tested. The numbers
> below are from real runs of the two baselines over all twenty cases. No model is
> wired up yet, so there are no model results and no performance comparison. No
> number appears in this README that was not produced by a command in this
> repository.

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
[1] prompt + grammar-constrained decode      llm/      the model reads text
   |                                                   and reports spans
   v
[2] evidence verification                    extract/  every value must quote
   |                                                   a verbatim source span
   v
[3] Zod validation                           extract/  shape is not correctness
   |
   v
[4] normalise, resolve, compute              domain/   pure TypeScript does all
   |                                                   arithmetic and lookups
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

Extraction is not wired up yet. Model download, the CLI and the MCP server are
documented here at phase 5 of `docs/tasks.md`.

What runs today is the domain layer and its checks. Node 22 and pnpm are the only
prerequisites.

```bash
pnpm install && pnpm check
```

`pnpm check` runs three things in order: the guard that fails the build if a
frontier-model SDK, hostname or API-key variable appears in the source or the
dependency manifest, then the TypeScript strict typecheck, then the unit suite.

## How do I run the evaluation?

```bash
pnpm eval --extractor=regex
```

`--extractor` selects what is being measured. Today that is `null` or `regex`, the
two baselines. The model extractor joins them at phase 5 and the flag is how the
comparison in Part 4 will be run. Other options:

```bash
pnpm eval --extractor=null --report reports/null.json
pnpm eval --only 02-naphtha --extractor=regex
```

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

**No model results yet.** What follows is the two baselines over all twenty cases,
from `pnpm eval`. They exist to calibrate the metric, not to be useful.

| | null baseline | regex baseline |
|---|---|---|
| field accuracy | 0.0% | 78.7% |
| correct abstention | 100.0% | 84.2% |
| over-refusal | 100.0% | 15.2% |
| confident nonsense, fields | 0 | 3 |
| silent error rate | 0.0% | 85.0% |
| release gate | pass | **fail** |

Cases scored: 20. Mandatory fields scored: 400.

The regex baseline broken down by case class:

| class | cases | accuracy | abstention | over-refusal | invented | silent err |
|---|---|---|---|---|---|---|
| clean | 4 | 87.5% | 0.0% | 5.0% | 0 | 100.0% |
| distractor | 2 | 85.0% | 0.0% | 7.5% | 0 | 100.0% |
| must_abstain | 6 | 78.2% | 84.2% | 13.9% | 3 | 83.3% |
| non_usd | 2 | 90.0% | 0.0% | 5.0% | 0 | 100.0% |
| thread_amendment | 4 | 56.3% | 0.0% | 41.3% | 0 | 50.0% |
| unit_mismatch | 2 | 90.0% | 0.0% | 5.0% | 0 | 100.0% |

Two things this already establishes.

**The metric cannot be gamed by refusing.** The null baseline returns null for
every field with a question attached. It scores a perfect abstention rate and a
perfect silent error rate, and it is worthless, because its accuracy is zero and
its over-refusal is total. No single headline number would have shown that, which
is why accuracy and abstention are reported separately and never averaged.

**The gate catches the failure it was built for.** The regex baseline is
substantially more accurate and substantially more dangerous. Given the line
"we take 2-3 cargoes of about 5,000 mt each", it reports a firm quantity of 5000.
Nothing about that output looks wrong. It is one field, it trips the release gate,
and in production it is a provisional invoice for the wrong tonnage.

That is the contrast the two baselines exist to draw, and it is the bar the local
model has to clear: beat the regex accuracy while keeping the null baseline's
safety.

**The per-class breakdown already says where the difficulty is.** Threads score
worst by a wide margin, at just over half the accuracy of the clean cases, and the
gap is over-refusal rather than wrong values: a reader that cannot follow an
amendment chain ends up with nothing rather than with the wrong thing. Clean,
mixed-unit and non-USD recaps are close to solved by patterns alone. Field
extraction is not the hard part of this problem, and a model that only improves
the clean cases is not worth its memory.

Two of the three invented values come from a word belonging to a different part of
the sentence. The statistic pattern finds "Low" inside "Ultra Low Sulphur Diesel"
and reports a low-of-the-day pricing basis nobody agreed. The Incoterm pattern
finds "CIF" inside the quotation name "Platts CIF NWE ULSD 10 ppm" and calls a
delivered-Rotterdam cargo CIF. Both are left in the baseline deliberately, because
a language model reading the same text can make exactly these mistakes, and the
cases that catch them are the reason the set exists.

Performance numbers, the configuration comparison and agent spend are filled in at
phase 7, once there is a model to measure.

## What are the known problems?

Written from the design as it stands. Rewritten with observed failures once the
eval runs.

- **Constrained decoding cannot make a model correct, only well-formed.** A tight
  grammar can also degrade quality by forcing a token the model would not have
  chosen. The planned mitigation is a two-pass variant, measured against the
  single pass rather than assumed better.
- **Evidence-span checking catches invented values, not misattributed ones.** A
  differential copied from the wrong line of a forwarded thread quotes a real
  span and passes the check. Thread cases in the eval set exist to size this.
- **Threads and distractors are the hard part, not field extraction.** `recap_02`
  carries both an amendment and a second cargo mentioned in passing. This is where
  a small model is expected to fail, and where model choice will actually be decided.
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
  obviously help, and the comparison table will show what is being given up.
- **Expected outputs are hand-written**, so they carry human error. The loader
  validates them against the schema, which catches shape mistakes but not wrong values.

## What would I do next?

Filled in properly once there are numbers. The current plan, in order:

1. Close the release gate on `confident_nonsense`, before anything else.
2. Decide the shipping model from the comparison table rather than by reputation.
3. Measure tool-calling reliability for the MCP demo, and ship the fallback design
   if the success rate is poor. Report the number either way.
4. Expand the eval set where the per-class breakdown is thin.

## Repository layout

```
data/    supplied recaps, field spec, domain primer, reference CSVs
docs/    rules-and-constraints.md   the single source of truth
         code-style.md              conventions followed while writing the code
         tasks.md                   the implementation checklist, kept current
src/     domain/  pure. schema, dates, units, pricing, fx, questions, references
         io/      the filesystem edge, kept out of domain/ so it stays pure
         llm/     provider interface and adapters, grammar compilation
         extract/ orchestration, evidence verification
         eval/    scorer, runner, report, cases
         mcp/     the two-tool server
scripts/ guard-no-frontier-api.mjs, run by `pnpm check`
```

## Disclosure

Coding agents were used to build this repository, which the brief permits and
expects. They are not in the inference path: the built system calls a locally
hosted open-weights model and nothing else. A guard script greps the source and
the dependency tree for frontier-model SDKs and fails the build on a hit.
