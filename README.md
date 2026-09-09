# Optiflow CTRM — recap extractor

Turns a free-text trade recap into one structured deal object, running entirely on
a self-hosted open-weights model. No frontier-model API anywhere in the extraction
path.

> **Status: complete.** The extractor passes the release gate, the MCP server runs,
> the local model answers the provisional-value question using both tools, and
> three configurations are measured. Every command in the walkthrough below was run
> against a fresh clone. No number in this README was produced by anything other
> than a command in this repository, and the one figure I could not measure, the
> agent spend, says so rather than being estimated.

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

Six stages. The important design decision is the split in the middle: stage 1 is
the only one that involves a model, and stage 6 is the only one that produces a
number.

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

### The layers

The pipeline above cuts across four layers, and the dependency arrows only point
one way. This is the rule the rest of the design hangs off.

```
cli.ts      eval/       mcp/          entry points. No business logic in any of
   |          |           |           them; each is a thin shell over extract/.
   +----------+-----------+
              |
              v
          extract/                    orchestration: prompt, decode, verify
              |                       evidence, check support, validate
      +-------+-------+
      |               |
      v               v
    llm/            domain/           llm/ talks to the model and computes
  provider          PURE              nothing. domain/ computes everything and
  grammar           no I/O            has never heard of a model.
  adapters          no clock
      |             no model
      v                ^
  llama.cpp            |
                      io/             the filesystem edge, kept out of domain/
                                      so that layer stays unit-testable
```

Two consequences worth stating.

`domain/` has no dependency on `llm/`. Date resolution, unit conversion, price
evaluation, FX and question generation are all unit tested with no weights on
disk, which is why the whole suite of 219 tests runs in under a second.

`extract/` is the only place that knows both. It is where a value stops being
something a model said and becomes something the system will act on, which is why
the evidence check, the support checks and the schema validation all live there
rather than being spread around.

**The model never does arithmetic.** It does not convert barrels to tonnes,
average quotations, resolve `B/L +0/+3` into dates, or apply an FX rate. It reads
the text and reports what it saw, with the span it saw it in. Every number that
could reach an invoice is computed by pure code with unit tests. This shrinks the
hallucination surface to the one thing a language model is actually good at.

Four mechanisms carry the abstention behaviour:

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

Model selection was decided by the harness rather than asserted up front. Qwen3-8B
at Q4_K_M is the shipped choice, benchmarked against Qwen3-4B at the same
quantisation in the configuration table below. Quantisation stays at Q4_K_M or
above, because digits are where aggressive quantisation degrades first and every
field that matters here is a number.

## How do I run it?

Every command below was run against a fresh clone of this repository. Node 22 and
pnpm are the only prerequisites.

**1. Install and check.** No model needed.

```bash
pnpm install && pnpm check
```

That runs three things in order: the guard that fails the build if a
frontier-model SDK, hostname or API-key variable appears in the source or the
dependency manifest, then the TypeScript strict typecheck, then 219 unit tests.

**2. Run the evaluation against the baselines.** Still no model needed, and it
takes under a second.

```bash
pnpm eval --extractor=regex
```

This prints the whole table: per case, per outcome, per class, and the release
gate. The regex baseline fails the gate, which is the point of it.

**3. Fetch the weights.** Two models are listed in the manifest. **You only need
the first one** to run everything except the configuration comparison.

Qwen3-8B, 4.7 GB. This is the shipped model and every headline number in this
README comes from it.

```bash
curl -L -o models/Qwen3-8B-Q4_K_M.gguf https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf
```

Qwen3-4B, 2.3 GB. **Optional.** It exists only to reproduce the model-size row of
the configuration table, and it is not the shipped model.

```bash
curl -L -o models/Qwen3-4B-Q4_K_M.gguf https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf
```

If you took only the 8B, verify just that one:

```bash
pnpm model:verify --model qwen3-8b-q4km
```

With no `--model` it checks everything in the manifest, so it will report the 4B
as `MISSING` and exit non-zero if you skipped it. That is the command doing its
job rather than a broken setup, and it prints the exact `curl` line for anything
absent. Nothing else needs the 4B: the extractor, the eval, the MCP server and the
demo all default to the 8B.

`model:verify` hashes what is on disk and compares it to the manifest. The hash
there is the upstream Hugging Face LFS object id, so it can be checked against the
source rather than only against whatever this machine downloaded.

**4. Extract a recap.**

```bash
pnpm -s extract data/recap_03.txt --date 2026-08-24
```

That one is the incomplete recap, and it is the most informative to run first. It
comes back with fourteen questions, including this pair:

```
quantity.value    ambiguous  The quantity is stated as a range or an approximation.
                             What is the firm figure to contract on?
pricing.differential.value
                  absent     What is the differential? Signed, negative for a
                             discount. The recap does not state one.
```

The deal object goes to stdout as JSON and the questions go to stderr, so the
command can be piped. Use `pnpm -s`, or the package manager's banner lands in the
JSON.

`--date` is required and is not a formality. The extractor never reads the system
clock, so a laycan written without a year has nothing to resolve against unless
the caller supplies it.

**5. Run the evaluation against the model.** About fourteen minutes on an M2 Pro,
forty seconds a recap.

```bash
pnpm eval --extractor=model
```

Run from a clean checkout, this reproduced the committed report exactly: 86.6%
accuracy, 100% correct abstention, zero invented values, gate passing. Only the
latency moved, 41.0 s here against 41.4 s in the committed run.

Expect the same when you run it. The scores should match to the digit; the
latency will not, and neither will the memory figure. Nothing is wrong if they
differ.

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

Steps 2 and 5 of the walkthrough are the two commands you need. This section is
the rest of the surface, for reproducing or extending the numbers below.

`--extractor` selects what is being measured: `model`, or the `null` and `regex`
baselines. `--model` and `--scope` select a configuration; both default to the
shipped one.

```bash
pnpm eval --extractor=model --report reports/run.json
pnpm eval --extractor=model --model=qwen3-4b-q4km --scope=mandatory
pnpm eval --only 02-naphtha --extractor=regex
pnpm eval:compare reports/before.json reports/after.json
pnpm eval:configs reports/perf-8b-all.json reports/perf-4b-all.json
```

`eval:compare` prints the headline movement and every field that changed outcome
in either direction, then says whether to keep the change. A change that lifts
accuracy while adding an invented value is rejected, which is how the two rejected
prompt versions below were caught. `eval:configs` puts quality, latency and memory
for several runs side by side, which is the configuration table further down.

The table goes to stdout, progress goes to stderr, and the command exits non-zero
when the release gate fails, so it can gate a build directly. A non-zero exit from
`--extractor=regex` is therefore expected: that baseline is supposed to fail.

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

The **release gate** is the number to look at first: `confident_nonsense` on any
pricing or quantity field must be zero. It is binary and the build fails on it.

The **silent error rate** is the fraction of cases carrying at least one wrong
mandatory field that nobody was asked about. It is reported two ways, and the
distinction matters. Over all mandatory fields it saturates, because with twenty
fields a case and accuracy in the eighties almost every case has one. Restricted
to the money-critical fields it does not, and that is the version to steer by.
Both appear in every table below, labelled.

Two baselines ship alongside the model extractor and are built first: an all-null
extractor and a regex extractor. The first proves the metric cannot be gamed by
refusing everything. The second gives a floor the model has to beat.

## What were the results?

All twenty cases, from `pnpm eval`. The two baselines exist to calibrate the
metric; the Qwen3-8B column is the shipped system, and it is the configuration you
get by running `pnpm eval --extractor=model` with no other flags.

The numbers below come from `reports/model-v7-normalised.json`, which is the
canonical result. The other files under `reports/` are the earlier attempts and
the configuration runs; they are kept because the path matters, not because any of
them is the answer.

| | null baseline | regex baseline | **Qwen3-8B, shipped** |
|---|---|---|---|
| field accuracy | 0.0% | 78.7% | 86.6% |
| correct abstention | 100.0% | 84.2% | 100.0% |
| over-refusal | 100.0% | 15.2% | 8.4% |
| invented values | 0 | 3 | 0 |
| silent error rate, money fields | 0.0% | 35.0% | 10.0% |
| silent error rate, any field | 0.0% | 85.0% | 65.0% |
| p50 latency per recap | under 1 ms | under 1 ms | 41.4 s |
| release gate | pass | **fail** | **pass** |

Cases scored: 20. Mandatory fields scored: 400.

The model beats both baselines on every axis except latency. It never invents a
money-critical value, it asks about every field it refuses, and it is eight points
more accurate than the patterns. It costs forty seconds a recap against under a
millisecond, which for a message a trader types once and a desk pays an analyst to
re-key is not the binding constraint.

By case class. These are field accuracy within each class, so they do not average
to the headline: the classes hold different numbers of cases.

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
it. What follows is six measured runs, each a hypothesis kept only when the table
improved. The whole progression is committed, including the two changes that were
rejected.

**This is history, not a menu.** v7 is the only version that exists in the code;
v1 to v6 were superseded and are not selectable flags. They are here because the
route matters and because two of them were wrong.

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
exactly where they were. The hypothesis was wrong. The run is committed rather
than deleted, and its lesson is kept: the fix that eventually worked was not a
better sentence at all.

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

Measured by `pnpm model:smoke`. This is the runtime alone, not extraction: it
establishes that the model loads, decodes deterministically, honours a grammar,
and fits.

| | |
|---|---|
| model | Qwen3-8B, Q4_K_M, 4.7 GiB of weights |
| runtime | llama.cpp b10361 through node-llama-cpp 3.20.0, Metal |
| context | 8192 tokens, one sequence |
| model load | 1.1 s |
| sustained throughput | 31.7 tokens/s over a 303-token generation |
| three identical prompts | byte-identical answers |
| grammar-constrained output | parsed, enums honoured |

**One finding from the smoke test was worth acting on immediately.** Asked for the
quantity in `30,000 MT +/- 10% in seller's option` under a grammar that permitted
any string, the model returned `"30,000"` with the thousands separator intact. The
deal schema rejects that, by design, because a separator is where a parse silently
turns into a different number. The grammar now constrains numeric fields to a
plain decimal shape rather than to any string, and that was fixed before the first
eval run.

No repair retry fired across twenty cases in any of the eleven model runs, which
says the grammar plus Zod combination holds the shape without needing a fallback.

Verbatim evidence checking rejected nothing, which is weaker news than it sounds:
the model quoted real text every time, not the right text. Case 8 takes the
superseded quantity from a thread and quotes it accurately from the message.
Verbatim checking cannot catch that, which is why the support checks ask the
harder question of whether the quoted words support the specific value, and why
the thread cases exist.

### Configurations compared

`pnpm eval:configs`, four runs over the same twenty cases on an Apple M2 Pro with
16 GB. Two axes crossed: model size, and how many fields the model is asked for.
The first column is the shipped default; the rest are what it was measured against.

```bash
pnpm eval --extractor=model                                             # column 1
pnpm eval --extractor=model --model=qwen3-4b-q4km                       # column 2
pnpm eval --extractor=model --scope=mandatory                           # column 3
pnpm eval --extractor=model --model=qwen3-4b-q4km --scope=mandatory     # column 4
```

| | **8B all, shipped** | 4B all | 8B mandatory | 4B mandatory |
|---|---|---|---|---|
| **field accuracy** | 86.6% | 58.5% | **88.5%** | 63.0% |
| correct abstention | 100.0% | 100.0% | 100.0% | 100.0% |
| over-refusal | 8.4% | 35.4% | 6.0% | 31.0% |
| invented values | 0 | 0 | 0 | 0 |
| silent error, money fields | 10.0% | 5.0% | 10.0% | 5.0% |
| release gate | pass | pass | pass | pass |
| **p50 seconds per recap** | 41.7 | 23.1 | 27.2 | **15.5** |
| p95 seconds per recap | 48.7 | 25.0 | 33.8 | 18.6 |
| whole suite, seconds | 846 | 469 | 567 | 319 |
| completion tokens per recap | 1063 | 932 | 647 | 566 |
| **peak resident memory MiB** | 6181 | 3455 | 5783 | 3820 |

Prompt tokens are 1954 per recap in every configuration, because the prompt does
not change.

**On the latency figures moving between tables.** The shipped configuration is
reported at 41.4 s p50 in the results table, 41.7 s here and 41.0 s in the
walkthrough. Those are three separate runs of the same code against the same
weights, and the spread is what timing variance on a laptop looks like. The
scores did not move at all across those runs. That asymmetry is the reason the
JSON report keeps scores and timings in different blocks: one is meant to be
diffed, the other cannot be.

**Halving the model halves the memory and collapses the quality.** Qwen3-4B at the
same quantisation is 44% faster in 56% of the memory and loses 28 points of
accuracy, most of it to over-refusal at 35.4%. It still passes the release gate
and its money-field silent error rate is the lowest of the three, which is not the
compliment it looks like: it refuses so much that little wrong gets through. That
is the null baseline's failure mode reappearing in a model, and it is why accuracy
and abstention are never averaged into one number.

**Asking for fewer fields made it both faster and more accurate, on both models.**
Dropping the nineteen conditional fields cut p50 latency by 35% on the 8B and 33%
on the 4B, and raised mandatory-field accuracy by 1.9 and 4.5 points respectively.
The conditional fields were costing accuracy on the required ones, not only time,
and the effect holding across a model size makes it more likely to be real than a
single run would.

**That is not the free win it appears to be, and the eval nearly hid it.** The
summary scores mandatory fields only, so a configuration that simply abandons
nineteen fields looks strictly better. It loses `fx.rate`, which is conditionally
mandatory the moment a deal is not in USD, along with law, arbitration, inspection,
demurrage and vessel. So the shipped default stays `--scope=all`, and the real fix
is two tiers rather than one narrow pass.

### What I tried to make it faster

**Worked.** Minified JSON in the grammar, with no whitespace between tokens: on a
thirty-nine-field object that is output the model pays for and nothing reads.
Dropping the conditional fields, above. Building the grammar once per run rather
than per case.

**Did not work.** The smaller model, on quality: 44% faster and 28 points less
accurate. Compressing the system prompt, which I expected to recover an abstention
regression and which moved nothing, disproving my own diagnosis.

**Not tried, and worth it.** Two-tier extraction: a mandatory pass always, a
conditional pass only when the deal is being drafted into a contract. On these
numbers that is a 35% latency cut and a small accuracy gain, with the caveat that
`fx.rate` would have to move into the first tier. After that, speculative decoding
with the 4B drafting for the 8B, which suits this workload exactly: a long, highly
constrained output where most tokens are structural and easy to predict.

### What a real GPU budget would change

Latency here is memory-bandwidth bound, not compute bound. The 8B at Q4_K_M reads
about 4.7 GB of weights per forward pass, and the M2 Pro has roughly 200 GB/s to
work with. That sets the ceiling at 25 tokens per second end to end, which is what
was measured.

With a GPU, three things change and they are worth separating. Bandwidth is five
to ten times higher, so the same model at the same quantisation runs proportionally
faster with no other change. Batching becomes worthwhile, and this workload is
embarrassingly batchable: twenty recaps are twenty independent prompts, and the
eval suite would drop from fourteen minutes to under one. And the 16 GB ceiling
lifts, which is what actually matters for quality, because all three remaining
reasoning failures are thread cases and those are where a 30B or 70B model would be
expected to help most. I would spend the budget on capacity before speed.

### Agent spend

**Not reported.** This is a Part 4 deliverable and it is the one figure in this
write-up that is missing rather than measured. It was built with coding agents and
the cost is real, but I have no way to read it from inside the session and I am
not going to put a guess in a document whose whole claim is that its numbers came
from commands in this repository.

### The MCP demo

`pnpm mcp:demo`, five runs in each mode. The model chooses the tool calls. Every
number in the answer is computed by `src/domain/valuation.ts`.

**Read the figure below as the pipeline's output, not as the right answer.** It is
built from the extractor's own reading of the recap, and that reading has one
field wrong. The correct figure is USD 15,025,834; the gap is explained under the
table.

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

**The wrong number is the extractor's, not the agent's.** The agent passed on the
statistic `parse_recap` gave it in all five runs, which is the behaviour you want
from an agent. The statistic itself is wrong: the recap says mean of the high
quotations and the extractor read a plain mean. Priced correctly the same cargo is
USD 15,025,834, a difference of USD 39,551 on one field.

That gap is the whole argument for building the harness first. The demo output
looks entirely reasonable. Nothing in the pipeline flags it, no assumption line
mentions it, and a trader reading the invoice would have no reason to look. The
only thing that catches it is a committed expected value in
`data/eval-cases/02-naphtha-cfr-rotterdam-thread/expected.json`, which is why the
eval scores that field as wrong and why it is listed under known problems.

A full transcript of all ten runs is committed at
`reports/mcp-demo-transcript.md`.

## What are the known problems?

Grouped by what they cost, worst first. Each one that shows up in the eval names
the case, so it can be reproduced with `pnpm eval --only <case>` rather than taken
on trust.

### Wrong output the system ships today

Three money-critical fields across twenty cases come back wrong with no question
attached. All three are in forwarded threads.

- **A superseded value taken from a thread.**
  `08-naphtha-thread-quantity-amended` amends the quantity and the tolerance in a
  later message, and the extractor takes the original pair. Both are quoted
  accurately from the message, so no amount of evidence checking catches it. The
  superseded figures are written out inside the correcting message itself, which
  is exactly what makes it hard.
- **A pricing basis read one word too shallow.**
  `02-naphtha-cfr-rotterdam-thread` says "mean of the HIGH quotations" and the
  extractor reports a plain mean. The MCP demo prices the difference: USD 39,551
  on a USD 15 M cargo, from one field, with nothing else in the pipeline flagging it.
- **Threads are the hard part and remain so.** The class scores 77.5%, eleven
  points below the next worst, and holds all three failures above. Distractors, by
  contrast, turned out easy at 90.0%: a second cargo mentioned in passing is
  simpler to ignore than a correction is to apply.

### Limits of the mechanisms

- **Constrained decoding cannot make a model correct, only well-formed.** It kept
  every answer parseable across eleven full model runs and more than two hundred
  extractions, with no repair retry ever firing, and it did nothing at all about
  the four invented values. Those needed deterministic checks in code.
- **The support checks are pattern rules and will misfire.** A quantity a trader
  legitimately described as "about" would be refused, and a quotation named only
  by its publication would be dropped. They fail toward over-refusal by
  construction, which is the safe direction, but the cost is real: 8.4% of fields
  that were stated come back refused.
- **Native tool calling is unusable on this model**, at 0 of 5 completed runs. The
  grammar-constrained fallback works, but an off-the-shelf MCP client pointed at
  this server will not get through a two-step question on its own. Anything
  driving these tools needs constrained decoding on its side too.
- **The provider is single-sequence and not re-entrant.** An MCP tool handler that
  calls back into the model during generation used to corrupt both silently. It
  now throws, which is correct, but concurrent requests need a second provider and
  a second five gigabytes.

### Limits of the evaluation

The eval is the thing everything else is judged by, so its weaknesses matter more
than they look.

- **Twenty cases is small, and seventeen of them are invented.** Several classes
  hold two cases, so a class percentage moves in large steps and should be read as
  a direction rather than a measurement. The invented cases carry my assumptions
  about how traders write; the three supplied recaps are the only ground truth
  about real phrasing in the set. They were all written before any extractor was
  tuned, so at least they are not fitted to a model's habits.
- **Expected values are hand-written and encode judgement calls.** Whether
  "Augusta, Italy" or "Augusta" is the delivery place, and whether a spec
  qualifier belongs to the product field, are decisions rather than facts. They
  are written down as numbered conventions in the constraints document so a
  reviewer can disagree with the rule rather than guess at the intent. The loader
  validates them against the schema, which catches shape mistakes and not wrong
  values.
- **Headline accuracy covers mandatory fields only.** That is deliberate, and it
  means a configuration that simply abandons the conditional fields scores better
  while doing less. The mandatory-scope column of the configuration table is
  exactly that, and it is why the shipped default is not that column.

### Operational limits

- **Extraction is not incremental.** Re-reading a thread re-extracts the whole
  deal from scratch. A desk amending one field pays the full forty seconds again,
  and nothing carries the earlier answer forward.
- **The 16 GB ceiling is real, and now measured.** The 4B that fits comfortably
  loses 28 points of accuracy. The models that would most obviously help with the
  thread cases do not fit at all.
- **Reproducibility is bounded.** It holds for a fixed model file and a fixed
  runtime version, and that much is verified. Bit-identity across llama.cpp
  versions is not claimed.
- **The provisional value rests on an estimated bill of lading date.** No B/L
  exists, so the window is anchored on the first day of the laycan. The figure
  moves if the vessel loads on another day, which is why every assumption is
  printed alongside the number.
- **The agent spend is not reported.** It is a Part 4 deliverable and the only
  figure in this write-up that is missing rather than measured.

## What would I do next?

In order, with what each is worth on the numbers above.

1. **Two-tier extraction.** The mandatory fields always, the conditional ones only
   when a deal is being drafted into a contract. Measured at 35% off p50 latency
   and 1.9 points of accuracy. The reason it is not shipped today is `fx.rate`,
   which becomes mandatory the moment a deal is not in USD and would have to move
   into the first tier.
2. **Attack the thread class.** It is the only class below 85% and it holds all
   three remaining unflagged money-field errors. The untested idea is an explicit
   amendment pass that resolves the thread into a single current statement of each
   field before extraction runs, measured against the single pass rather than
   assumed better.
3. **Grow the eval set to the point where a class percentage means something.**
   Four classes hold two or four cases. Threads and mixed units deserve ten each,
   because those are where the model is weakest and where a change is hardest to
   judge from four data points.
4. **Make extraction incremental.** A desk amending one field currently pays the
   full forty seconds again. Re-extracting only the fields a new message touches is
   both faster and safer, because it leaves the rest of the deal untouched rather
   than re-deriving it.
5. **Report the agent spend.** A Part 4 deliverable I cannot read from inside the
   session.

Two things I would not do. I would not reach for a bigger model first: the
measured gap between the 8B and the 4B is 28 points, but the remaining failures
are thread reasoning rather than field reading, and a two-tier design plus an
amendment pass are cheaper experiments with a clearer mechanism. And I would not
loosen the release gate to buy accuracy. The gate is the one number a trading desk
would actually ask about.

## Repository layout

```
data/    supplied recaps, field spec, domain primer, reference CSVs
         eval-cases/  the twenty committed cases, one directory each
docs/    rules-and-constraints.md   the single source of truth for the rules
         code-style.md              conventions followed while writing the code
         tasks.md                   the implementation record, phase by phase
src/     domain/  pure. schema, dates, units, pricing, fx, valuation, questions
         io/      the filesystem edge, kept out of domain/ so it stays pure
         llm/     provider interface, two adapters, GBNF grammar builder
         extract/ orchestration, prompt, evidence and support checks
         eval/    scorer, runner, report, compare, configs, rescore, baselines
         mcp/     the two tools, the stdio server, the smoke test, the demo
reports/ every committed run, including the two that were rejected
models/  manifest.json pins the weights by hash, README.md says which to fetch;
         the .gguf files are not committed
scripts/ guard-no-frontier-api.mjs, run by `pnpm check`
```

## Where to read next

`docs/rules-and-constraints.md` is the single source of truth for what the system
must and must not do, including the six-bucket abstention taxonomy and the release
gate. `docs/tasks.md` is the implementation record: what was done in what order,
which hypotheses were rejected, and what is still open. `docs/code-style.md` is
the conventions the code follows, and the one rule worth knowing before reading
any of it is the layering rule at the top.

## Disclosure

Coding agents were used to build this repository, which the brief permits and
expects. They are not in the inference path: the built system calls a locally
hosted open-weights model and nothing else. `pnpm guard` scans the source and the
dependency manifest for frontier-model SDKs, hostnames and API-key variables and
fails the build on a hit. It also fails on any `console.*` in `src/`, because
stdout carries MCP protocol frames.
