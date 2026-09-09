# Rules and constraints

Single source of truth for what this project must and must not do. Derived from
`problem.md`, `data/field_spec.md` and `data/domain_primer.md`. If code and this
file disagree, this file wins and the code is a bug.

---

## 1. Hard technical constraints

| # | Constraint | Consequence |
|---|---|---|
| T1 | **No OpenAI / Anthropic / Google API anywhere in the extraction path.** | The only network calls at inference time go to a locally hosted model. CI enforces this with a dependency and source grep. Coding agents were used to *build* the system; that is allowed and is disclosed in the README. |
| T2 | **Open-weights model, self-hosted.** Qwen / Llama / Mistral family. | Model weights are pinned by file name and SHA-256, not by a mutable registry tag. |
| T3 | **Runs on one Apple M2 Pro, 16 GB unified memory.** | Practical weight budget is ~9 GB, leaving room for KV cache and the OS. Any config that will not fit is out of scope for the measured numbers. |
| T4 | **TypeScript / Node on the whole path**, including inference. | Non-TS runtimes are permitted only behind a process boundary and must be reported as such. |
| T5 | **No secrets, no external data.** | Reference data is `data/products.csv` and `data/price_quotes.csv` only. |

## 2. Determinism and reproducibility

| # | Rule |
|---|---|
| D1 | Fixed seed, `temperature = 0`, greedy sampling. Every sampling parameter is written into the run report, never left to a provider default. |
| D2 | Model file, quantisation, SHA-256, runtime version and context size are recorded in every eval report. |
| D3 | Expected outputs are committed to the repository. They are field values, not raw model transcripts. |
| D4 | No wall-clock reads inside the extractor or scorer. The current date is injected by the caller. Eval cases carry their own reference date. |
| D5 | No `Math.random()`, no unordered map iteration in anything that reaches output or the report. |
| D6 | One command runs the whole suite: `pnpm eval`. It prints a table to stdout and optionally writes a JSON report. |
| D6a | The JSON report separates a `scores` block from a `timings` block. Scores are byte-identical across runs for a fixed extractor and can be diffed to prove a change did nothing. Timings never are, so they are kept out of that diff. |
| D6b | `pnpm eval` exits non-zero when the release gate in section 4 fails, so it can gate a build directly. |
| D7 | Reproducibility is claimed only for a fixed model file plus a fixed runtime version. Cross-version bit-identity is not claimed and must not be asserted in the README. |

## 3. Business rules

Straight from `data/field_spec.md`. These are the rules the eval scores against.

| # | Rule | How it is enforced |
|---|---|---|
| B1 | **Never infer a number.** A differential, statistic or pricing period that is not stated is `null` plus a question. An industry-typical default is not an answer. | Every field is nullable in the decoding grammar itself, so abstaining is always a legal output. |
| B2 | **Amendments win.** The latest stated value for a field in a thread is the value. The earlier value belongs in the audit trail. | Dedicated eval cases on `recap_02.txt` and its variants. |
| B3 | **One recap per output.** A message may mention other deals in passing. They are not part of this deal object. | Distractor cases in the eval set. |
| B4 | **Units are not interchangeable.** Quantity in barrels with a per-tonne differential is recorded as written. Conversion happens at calculation time using `products.csv`, and the factor used is recorded. | Conversion is pure TypeScript, never the model. |
| B5 | **Not-an-Incoterm is not an Incoterm.** "delivered Rotterdam", "ex tank", "into vessel" are shorthand. Record the raw text, set `incoterm` to `null`, ask. | Enum in the grammar is the six Incoterms plus `null`. |
| B6 | **Every field carries provenance.** A source span is mandatory for every extracted value. Confidence scores are optional. | Post-decode check: the evidence span must be a verbatim substring of the input. A value whose evidence is not found is rejected. |
| B7 | **Questions are structured output too.** Every `null` mandatory field emits a question that names the field and what is missing, answerable in one line. | Scored. A `null` without a question is not a correct abstention. |
| B8 | Price is captured as a **formula**, never collapsed into a single number. Publication quote, pricing period, statistic and differential are separate fields. | Provisional value is computed downstream from the formula, not extracted. |

### Mandatory fields

A deal object is unusable if any of these is missing or invented:
`recap_date`, `buyer`, `seller`, `product`, `quantity.value`, `quantity.unit`,
`quantity.tolerance_pct`, `quantity.tolerance_option`, `delivery_term.incoterm`,
`delivery_term.place`, `delivery_window.from`, `delivery_window.to`,
`pricing.quote_code`, `pricing.statistic`, and the remaining pricing fields listed
in `data/field_spec.md`.

### Conditional fields

Capture when present, absence is not an error: `fx.rate`, `fx.basis`,
`quality_spec`, `inspection.*`, `demurrage.*`, `law`, `arbitration`, `vessel`,
`notes`. `fx` becomes mandatory when currency is not USD.

## 3a. Extraction conventions

Judgement calls that came up while writing the eval expectations. They are
written down here so the expected outputs are a rule rather than one author's
taste, and so the extractor and the reviewer can be held to the same reading.

| # | Convention |
|---|---|
| C1 | `product.as_written` holds the product identity only. Spec qualifiers on the same line go to `quality_spec`. "Gasoil 0.1% S, EN 590 equivalent, spec as per attached" splits into the two fields. |
| C2 | A half-month laycan resolves by market convention: first half is the 1st to the 15th, second half is the 16th to the last day of the month. The convention used is recorded on the result. This is a published convention, not an inference, and it is the only date expression resolved this way. |
| C3 | `pricing.period` is recorded as the recap wrote it. Parsing it into offsets happens in the domain layer at calculation time, so a period we cannot parse is a question rather than a silently altered window. |
| C4 | `fx.rate` is the number as written and `fx.basis` is the phrase around it. Direction is derived from the basis text, never assumed: "USD/AED 3.6725" and "1.0852 USD per EUR" point opposite ways and both appear in real recaps. |
| C5 | A pronoun is not a legal entity. "buyer us" names no counterparty, so `buyer` is null plus a question even when the reader can guess who is meant. |
| C6 | Stated-but-unusable terms are recorded as written and flagged `ambiguous`. "payment as usual" is what the message says; deleting it would lose the audit trail, and treating it as usable terms would be worse. |
| C7 | `B/L + 3` is the three days after the B/L date and excludes it. `B/L +0/+3` includes it. The two forms are parsed separately because the difference shifts every quotation by a day. |

## 4. Abstention scoring

The taxonomy is fixed. Every mandatory field in every case lands in exactly one bucket.

| Outcome | Meaning |
|---|---|
| `correct` | non-null, matches expected after normalisation |
| `correct_abstention` | expected `null`, produced `null`, **and** a question naming the field |
| `unflagged_abstention` | expected `null`, produced `null`, no question. Partial credit only. |
| `wrong_abstention` | expected non-null, produced `null`. Over-refusal. Annoying, not dangerous. |
| `wrong_value` | expected non-null, produced a different non-null value |
| `confident_nonsense` | expected `null`, produced a non-null value. **The one that matters.** |

**Headline metric: silent error rate.** The fraction of cases with at least one
mandatory field in `wrong_value` or `confident_nonsense` that carried no question.
This is the number that maps to a bad invoice.

**Release gate: `confident_nonsense` on a pricing or quantity field must be zero.**
A build that fails this gate is not shippable regardless of its accuracy score.

## 5. Eval set

| # | Rule |
|---|---|
| E1 | 20 cases. The three supplied recaps, variants of them, and invented ones. |
| E2 | Scoring is field-level. No whole-object string comparison, no "looks right". |
| E3 | A must-abstain subset covering at least: missing differential, missing statistic, missing laycan, non-Incoterm delivery term, ambiguous quantity, unresolvable quote code. |
| E4 | Every case carries a class label: `clean`, `thread_amendment`, `distractor`, `must_abstain`, `unit_mismatch`, `non_usd`. The report breaks the score down by class. |
| E5 | Cases are committed as `input.txt` plus `expected.json` plus `meta.json`. |

## 6. Performance and cost

Measured, not asserted. Required in the README:

- p50 and p95 end-to-end latency per recap
- tokens per second
- peak RSS
- a table comparing **at least two configurations** so the quality, latency and
  memory trade-off is visible
- what was tried to make it faster or cheaper, what worked, what did not
- what would be done next with a real GPU budget
- agent spend on this task, in dollars

## 7. MCP server

Two tools, sharing the same core library as the CLI. No parallel implementation.

- `parse_recap(text)` returns the deal object **and** the questions array.
- `get_price_quote(quote_code, date_or_period, statistic)` reads
  `data/price_quotes.csv`. Contains no model call at all. It is a lookup.

Deliverable: the local model using both tools to answer *"what is the provisional
value of the deal in recap_02.txt?"*. If tool calling is unreliable on the chosen
model, that is reported with numbers plus a fallback design, not hidden.

**Transport rule:** MCP runs on stdio. `stdout` carries protocol frames only.
All logging goes to `stderr`. A stray `console.log` breaks the server.

## 8. Priority order

Fixed by the brief. When time is short, cut from the bottom.

1. Eval harness and honest numbers
2. Extractor
3. MCP server
4. Extra configurations

## 9. Definition of done

- [ ] `pnpm eval` runs the full suite offline and prints a table
- [ ] Release gate in section 4 passes
- [ ] README contains only numbers produced by a real run on this machine
- [ ] No frontier-model API in the inference path, verified by the CI grep
- [ ] MCP server answers the `recap_02` provisional-value question end to end
- [ ] Limitations and next steps written down honestly
