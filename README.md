# Optiflow CTRM — recap extractor

Turns a free-text trade recap into one structured JSON deal object, running
entirely on a self-hosted open-weights model. No frontier-model API anywhere in
the extraction path.

The hard part is not parsing. It is knowing when to refuse. A recap that says
"price tbc as per our call" states no differential, and the correct output is
`null` plus a question back to the trader. A system that invents a plausible
discount instead produces a provisional invoice that is quietly wrong, and that
surfaces in a dispute rather than in a test.

**Status:** complete and passing its release gate. Every number below came from a
command in this repository; the one figure that is missing rather than measured
says so.

---

## Setup

Node 22 and pnpm are the only prerequisites. Tested on an Apple M2 Pro with 16 GB;
Metal is used if present and llama.cpp falls back to CPU if not.

```bash
git clone https://github.com/viktorialuhverchik/optiflow-ctrm.git
cd optiflow-ctrm
corepack enable          # if you do not already have pnpm
pnpm install
```

`package.json` pins the pnpm version, and the install builds the native
llama.cpp binding for your machine.

Everything except the model itself works from here.

```bash
pnpm check
```

That runs the guard, the TypeScript strict typecheck and 219 unit tests, in about
a second, with no model on disk.

### Getting the model

Two models are listed in `models/manifest.json`. **Only the first is required.**

```bash
curl -L -o models/Qwen3-8B-Q4_K_M.gguf \
  https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf
pnpm model:verify --model qwen3-8b-q4km
```

Qwen3-8B at Q4_K_M, 4.7 GB. This is the shipped model and every headline number
comes from it.

The second, Qwen3-4B at 2.3 GB, is **optional** and only reproduces one column of
the configuration table. If you skip it, `pnpm model:verify` with no `--model`
will report it as `MISSING` and exit non-zero. That is the command doing its job,
not a broken setup.

```bash
curl -L -o models/Qwen3-4B-Q4_K_M.gguf \
  https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf
```

The `.gguf` files are not committed. The manifest is, and it pins each by SHA-256.
Those hashes are the upstream Hugging Face LFS object ids, so they can be checked
against the source rather than only against a local copy.

Confirm the model runs:

```bash
pnpm model:smoke
```

It loads the model, sends the same prompt three times, checks the answers are
byte-identical, and checks a grammar-constrained answer parses. On an M2 Pro it
sustains about 32 tokens/s. Load time and peak memory vary a lot between runs
depending on page cache, so do not read much into those two lines; the figures
worth comparing are in the configuration table, measured over a whole suite.

## Using it

Extract a recap:

```bash
pnpm -s extract data/recap_03.txt --date 2026-08-24
```

Start with that one. It is the incomplete recap, and it comes back with fourteen
questions rather than a full deal, which is the behaviour the whole project is
about.

The deal object goes to **stdout** as JSON and the questions go to **stderr**, so
the command pipes cleanly. Use `pnpm -s`, or pnpm's own banner lands in the JSON.

`--date` is required and is not a formality: the extractor never reads the system
clock, so a laycan written without a year has nothing to resolve against.

| Option | |
|---|---|
| `--date <YYYY-MM-DD>` | required, unless the file is an eval case |
| `--json` | deal object only, no questions table |
| `--model <id>` | from `models/manifest.json` |
| `--context <n>` | context size override |

Expect about 40 seconds per recap.

## Evaluating it

```bash
pnpm eval --extractor=regex     # no model, under a second
pnpm eval --extractor=model     # the real thing, about 14 minutes
```

Both print the full table: per case, per outcome, per class, the release gate and
the resource cost. The command **exits non-zero when the gate fails**, so it can
gate a build. A non-zero exit from `--extractor=regex` is therefore expected.

| Option | |
|---|---|
| `--extractor <null\|regex\|model>` | default `null`, which refuses everything by design |
| `--model <id>` `--scope <all\|mandatory>` | select a configuration |
| `--only <substring>` | run one case, e.g. `--only 08-naphtha` |
| `--report <file>` | also write the JSON report |
| `--quiet` | no per-case progress |

Two more tools, for comparing runs:

```bash
pnpm eval:compare reports/model-v4-refusal.json reports/model-v7-normalised.json
pnpm eval:configs reports/perf-8b-all.json reports/perf-4b-all.json
```

`eval:compare` prints every field that changed outcome in either direction and
says whether to keep the change; it rejects anything that lifts accuracy while
adding an invented value. `eval:configs` puts quality, latency and memory for
several runs side by side.

### The eval set

Twenty cases in `data/eval-cases/`, one directory each, holding the recap, a flat
map of expected field values and a metadata file with the case class. Three are
the supplied recaps; seventeen are invented. Six classes: `clean`,
`thread_amendment`, `distractor`, `unit_mismatch`, `non_usd`, `must_abstain`.

Every mandatory field in every case lands in exactly one of six buckets:

| Outcome | Meaning |
|---|---|
| `correct` | matches the expected value |
| `correct_abstention` | expected null, produced null, with a question naming the field |
| `unflagged_abstention` | expected null, produced null, no question |
| `wrong_abstention` | expected a value, refused. Over-refusal. |
| `wrong_value` | produced a different value |
| `confident_nonsense` | expected null, produced a value. **The one that costs money.** |

**The release gate** is the number to read first: `confident_nonsense` on any
pricing or quantity field must be zero. It is binary and the build fails on it.

**The silent error rate** is the fraction of cases with a wrong mandatory field
nobody was asked about. It is reported twice. Over all mandatory fields it
saturates; restricted to money-critical fields it does not, and that is the
version to steer by.

## The MCP server

```bash
pnpm mcp                        # stdio
pnpm mcp:smoke                  # drives it over a real pipe, 8 checks
pnpm mcp:smoke --with-model     # adds a parse_recap call
pnpm mcp:demo --runs 5          # the provisional-value question
```

`parse_recap(text, reference_date)` returns the deal, the questions and the
diagnostics. `get_price_quote(quote_code, date_or_period, statistic, bl_date)`
averages a published quotation and returns the rows it used. It has no model in
it, and the model loads lazily so a client can ask for a price without waiting
for 4.7 GB.

`bl_date` is an addition to the signature in the brief: a B/L-relative period
cannot be resolved without a bill of lading date, and defaulting to today would
price a window nobody asked for.

## How does it work?

Six stages. Stage 1 is the only one that involves a model; stage 6 is the only one
that produces a number.

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
text and reports what it saw with the span it saw it in. Every number that could
reach an invoice is computed by pure code with unit tests.

`domain/` has no dependency on `llm/`, which is why the whole test suite runs in
under a second with no weights on disk. `extract/` is the only layer that knows
both, and it is where a value stops being something a model said and becomes
something the system will act on.

Four mechanisms carry the abstention behaviour:

1. **Every field is nullable in the grammar itself.** With no legal path to "not
   stated", constrained decoding forces the model token by token into inventing a
   differential. Abstaining has to be a legal parse.
2. **Evidence spans are mandatory and checked** against the source text.
3. **A null mandatory field must carry a question.** A silent null scores worse
   than a null with a question naming the field.
4. **Deterministic refuse-only checks sit after the model.** Four rules in
   `src/extract/support.ts` ask whether the quoted evidence supports *this* value
   rather than merely existing in the message.

Full rules in [`docs/rules-and-constraints.md`](docs/rules-and-constraints.md).

## Technology choices

| Choice | Why | Alternative and trade-off |
|---|---|---|
| **TypeScript, Node 22** | The whole path in one language, inference included. | Python has the better structured-generation ecosystem. That means a process boundary. |
| **node-llama-cpp** | GGUF in-process on Metal. Exposes GBNF grammars, seed, temperature and context directly, so the eval controls every knob. No daemon; the model is pinned by hash. | Ollama is easier but hides sampling defaults and mutates tags. LM Studio is a GUI dependency. `llama-server` is good and costs a managed process; supported as a second adapter. |
| **Grammar-constrained decoding** | Guarantees the shape at the token level rather than hoping for it. | Function calling on an 8B is chat-template dependent and emits well-formed calls with wrong arguments. JSON mode guarantees parseable JSON and nothing about the fields. Retry-and-repair repairs toward plausible rather than correct; kept only as one bounded fallback, and counted. |
| **Zod as the single schema** | One definition drives the grammar, the validation, the MCP tool signatures and the eval loader. | Hand-written JSON Schema drifts from the types. |
| **decimal.js** | Differentials and tonnages end up on invoices. | Native `number` is faster and wrong. |
| **Bespoke eval runner** | The output is a scored table and a JSON report, not pass or fail. | Running it in `vitest` conflates measurement with regression testing. |

Model selection was decided by the harness, not asserted up front. Quantisation
stays at Q4_K_M or above, because digits degrade first and every field that
matters here is a number.

## Results

All twenty cases. The baselines calibrate the metric; the Qwen3-8B column is the
shipped system, and it is what `pnpm eval --extractor=model` gives you with no
other flags. Canonical report: `reports/model-v7-normalised.json`.

| | null | regex | **Qwen3-8B** |
|---|---|---|---|
| field accuracy | 0.0% | 78.7% | **86.6%** |
| correct abstention | 100.0% | 84.2% | **100.0%** |
| over-refusal | 100.0% | 15.2% | 8.4% |
| invented values | 0 | 3 | **0** |
| silent error, money fields | 0.0% | 35.0% | 10.0% |
| silent error, any field | 0.0% | 85.0% | 65.0% |
| p50 per recap | under 1 ms | under 1 ms | 41.4 s |
| release gate | pass | **fail** | **pass** |

The model beats both baselines on every axis except latency. By class:

| class | regex | Qwen3-8B |
|---|---|---|
| clean | 87.5% | 88.8% |
| distractor | 85.0% | 90.0% |
| must_abstain | 78.2% | 88.1% |
| non_usd | 90.0% | 95.0% |
| thread_amendment | 56.3% | **77.5%** |
| unit_mismatch | 90.0% | 85.0% |

**The metric cannot be gamed by refusing.** The null baseline returns null for
every field with a question attached. It scores a perfect abstention rate and a
perfect silent error rate and is worthless, because its accuracy is zero. No
single headline number would show that, which is why accuracy and abstention are
reported separately and never averaged.

### How it got there

The first working version scored 79.0% with four invented values and did not beat
the regex baseline. What follows is history, not a menu: only the last version
exists in the code.

| | change | accuracy | invented | gate |
|---|---|---|---|---|
| v1 | first working extractor | 79.0% | 4 | fail |
| v2 | field rules in the prompt | 82.4% | 5 | fail |
| v3 | the same rules compressed | 81.9% | 5 | fail |
| v4 | explicit refusal rules | 84.8% | 4 | fail |
| v5 | evidence support checks in code | 84.8% | 1 | fail |
| v6 | fixed a bug in my own check | 84.8% | 0 | **pass** |
| v7 | canonicalise the pricing period | **86.6%** | 0 | **pass** |

**Prompting could not close the gate.** v4 put one line in the system prompt for
each of the four known invented values, naming the exact mistake. Accuracy
improved and all four survived unchanged. The model's prior toward supplying the
obvious industry default is stronger than an instruction telling it not to.

**What worked was moving the guarantee into code.** Four deterministic rules ask
whether the quoted evidence supports the specific value: a quantity qualified by
"about" is not firm, a quantity with no unit token beside it has no unit, a
pricing basis with no statistic word in it has no statistic, and a quotation code
whose series name the message never mentions is wrong. Every rule can only refuse.
Invented values went from four to zero, abstention from 78.9% to 100%.

Two of those steps were my own mistakes, and both runs are committed rather than
deleted. v3 disproved my diagnosis that prompt length was priming refusal. v6 was
a bug in the check I had just written: substring matching let the token "10" from
a quotation name match inside the date `14.10.2026`.

### Configurations

Four runs, two axes crossed. Column one is the shipped default.

```bash
pnpm eval --extractor=model                                          # 1
pnpm eval --extractor=model --model=qwen3-4b-q4km                    # 2
pnpm eval --extractor=model --scope=mandatory                        # 3
pnpm eval --extractor=model --model=qwen3-4b-q4km --scope=mandatory  # 4
```

| | **8B all** | 4B all | 8B mandatory | 4B mandatory |
|---|---|---|---|---|
| field accuracy | **86.6%** | 58.5% | 88.5% | 63.0% |
| over-refusal | 8.4% | 35.4% | 6.0% | 31.0% |
| invented values | 0 | 0 | 0 | 0 |
| p50 seconds | 41.7 | 23.1 | 27.2 | **15.5** |
| peak memory MiB | 6181 | **3455** | 5783 | 3820 |

**Halving the model halves the memory and collapses the quality.** The 4B loses
28 points, almost all to over-refusal. It still passes the gate and has the lowest
money-field silent error rate, which is not a compliment: it refuses so much that
little wrong gets through.

**Asking for fewer fields made it faster and more accurate, on both models.**
Dropping the nineteen conditional fields cut p50 by 35% on the 8B and 33% on the
4B. But it is not the free win it looks like, and the summary nearly hid that: it
scores mandatory fields only, so a configuration that abandons nineteen fields
scores better while doing less. It drops `fx.rate`, which becomes mandatory the
moment a deal is not in USD. So the default stays `--scope=all`.

The same configuration is reported at 41.4 s and 41.7 s p50 in the two tables
above. Those are separate runs; the spread is laptop timing variance and the
scores did not move. That is why the JSON report keeps scores and timings in
different blocks.

### Performance

**Worked:** minified JSON in the grammar, dropping conditional fields, building
the grammar once per run. **Did not work:** the smaller model, on quality;
compressing the prompt. **Not tried and worth it:** two-tier extraction, then
speculative decoding with the 4B drafting for the 8B.

**With a GPU budget:** latency here is memory-bandwidth bound, not compute bound.
The 8B reads 4.7 GB per forward pass against roughly 200 GB/s, which sets the
25 tokens/s ceiling that was measured. A GPU raises bandwidth, makes batching
worthwhile (twenty recaps are twenty independent prompts; the suite would drop
from fourteen minutes to under one), and lifts the 16 GB ceiling. I would spend
the budget on capacity before speed, because all three remaining failures are
thread cases.

**Agent spend: not reported.** It is a Part 4 deliverable and the only figure here
that is missing rather than measured. I have no way to read it from inside the
session and will not put a guess in a document whose whole claim is that its
numbers came from commands in this repository.

### The MCP demo

`pnpm mcp:demo` has the model answer "what is the provisional value of the deal in
recap_02.txt?" using both tools. Five runs in each of two modes:

| behaviour | native | grammar |
|---|---|---|
| called `parse_recap` | 5/5 | 5/5 |
| called `get_price_quote` | 0/5 | 5/5 |
| passed on the arguments it was given | 0/5 | 5/5 |
| completed both calls and stopped | 0/5 | 5/5 |
| mean seconds per run | 30.8 | 7.4 |

**Native function calling does not work on this model.** It calls the first tool
correctly every time, then emits an empty response and stops rather than chaining.
One run mangled a filename argument into `data/recap_02txt`.

**The fallback is the same mechanism as the extractor:** the next action is
decoded under a grammar built from the tool schemas. 5 of 5 at a quarter of the
latency. A local model this size can drive tools reliably; it cannot be trusted to
invent the call format while it does so.

The answer comes out at USD 14,986,284 with every assumption printed beside it.
**Read that as the pipeline's output, not the right answer:** the extractor read
the pricing basis as a plain mean where the recap says mean of the high
quotations. Correctly priced it is USD 15,025,834. That USD 39,551 gap, on one
field, with nothing else in the pipeline flagging it, is the argument for building
the harness first. Transcript: `reports/mcp-demo-transcript.md`.

## Known problems

### Wrong output it ships today

Three money-critical fields across twenty cases come back wrong with no question
attached. All three are in forwarded threads. Reproduce with
`pnpm eval --only <case>`.

- **A superseded value taken from a thread.** `08-naphtha-thread-quantity-amended`
  amends the quantity and tolerance in a later message; the extractor takes the
  original pair. Both are quoted accurately, so no evidence checking catches it.
- **A pricing basis read one word too shallow.**
  `02-naphtha-cfr-rotterdam-thread`, described above. USD 39,551.
- **Threads are the hard part.** The class scores 77.5%, eleven points below the
  next worst, and holds all three failures. Distractors turned out easy at 90.0%.

### Limits of the mechanisms

- **Constrained decoding cannot make a model correct, only well-formed.** It kept
  every answer parseable across eleven model runs with no repair retry ever
  firing, and did nothing about the four invented values.
- **The support checks are pattern rules and will misfire.** A quantity a trader
  legitimately described as "about" would be refused. They fail toward
  over-refusal by construction, which is the safe direction; the cost is 8.4%.
- **Native tool calling is unusable here**, so an off-the-shelf MCP client will
  not get through a two-step question on its own.
- **The provider is single-sequence and not re-entrant.** A tool handler calling
  back into the model during generation used to corrupt both silently. It now
  throws; concurrent requests need a second provider and a second 4.7 GB.

### Limits of the evaluation

- **Twenty cases is small and seventeen are invented.** Several classes hold two
  cases, so a class percentage is a direction, not a measurement. The invented
  cases carry my assumptions about how traders write. All were written before any
  extractor was tuned, so at least they are not fitted to a model's habits.
- **Expected values are hand-written and encode judgement calls.** Whether
  "Augusta, Italy" or "Augusta" is the delivery place is a decision, not a fact.
  They are written down as numbered conventions in the constraints doc so a
  reviewer can disagree with the rule rather than guess at the intent.
- **Headline accuracy covers mandatory fields only**, which is why a
  fields-abandoning configuration scores better while doing less.

### Operational

- **Extraction is not incremental.** Amending one field costs the full 40 seconds.
- **Reproducibility is bounded**, and verified: a clean checkout reproduced the
  committed scores exactly, with only latency differing. Bit-identity across
  llama.cpp versions is not claimed.
- **The provisional value rests on an estimated B/L date**, anchored on the first
  day of the laycan, which is why the assumptions are printed with the figure.

## What next

1. **Two-tier extraction.** Mandatory fields always, conditional ones only when
   drafting a contract. Measured at 35% off latency and 1.9 points of accuracy;
   `fx.rate` has to move into the first tier first.
2. **Attack the thread class.** It holds all three remaining errors. The untested
   idea is an amendment pass that resolves a thread into one current statement of
   each field before extraction, measured against the single pass.
3. **Grow the eval set** until a class percentage means something. Threads and
   mixed units deserve ten cases each.
4. **Make extraction incremental**, re-extracting only the fields a new message
   touches.
5. **Report the agent spend.**

Two things I would not do. I would not reach for a bigger model first: the
remaining failures are thread reasoning rather than field reading, and the two
experiments above are cheaper with a clearer mechanism. And I would not loosen the
release gate to buy accuracy.

## Layout

```
data/     supplied recaps, field spec, domain primer, reference CSVs
          eval-cases/  the twenty committed cases
docs/     rules-and-constraints.md  what the system must and must not do
          code-style.md             conventions, starting with the layering rule
          tasks.md                  the implementation record, phase by phase
src/      domain/   pure. schema, dates, units, pricing, fx, valuation, questions
          io/       the filesystem edge, kept out of domain/
          llm/      provider interface, two adapters, GBNF grammar builder
          extract/  orchestration, prompt, evidence and support checks
          eval/     scorer, runner, report, compare, configs, baselines
          mcp/      the two tools, stdio server, smoke test, demo
reports/  every committed run, including the two that were rejected
models/   manifest.json pins the weights by hash; README.md says which to fetch
scripts/  guard-no-frontier-api.mjs, run by `pnpm check`
```

## Disclosure

Coding agents were used to build this repository, which the brief permits and
expects. They are not in the inference path: the built system calls a locally
hosted open-weights model and nothing else. `pnpm guard` scans the source and the
dependency manifest for frontier-model SDKs, hostnames and API-key variables and
fails the build on a hit. It also fails on any `console.*` in `src/`, because
stdout carries MCP protocol frames.
