# Optiflow CTRM

Our client cannot use public models. Their LLM runs on their own hardware, and every AI feature in the CTRM has to work on a self-hosted open-weights model that is weaker than the frontier ones. The interesting engineering is therefore not "call an API and parse the answer" — it is getting reliable, measurable, affordable behaviour out of a limited local model, and knowing when it must refuse to answer.

A recap is the short free-text message (Telegram, WhatsApp, email) in which a trader and a counterparty fix the terms of a deal. It is the entry point of the whole deal lifecycle: everything downstream — contract, pricing, logistics, invoice, P&L — is built on the fields in that message. Today the client re-types recaps into Excel by hand.

Read `data/domain_primer.md` first. It is deliberately part of the task.

## What you get

| File                    | What it is                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `data/domain_primer.md` | the domain in 10 minutes: recap, Incoterms, Platts/Argus pricing, B/L+N dating, tolerance, units |
| `data/field_spec.md`    | the canonical field list your output must cover, with types and rules                            |
| `data/recap_01.txt`     | a clean recap                                                                                    |
| `data/recap_02.txt`     | a messy one: forwarded email thread                                                              |
| `data/recap_03.txt`     | an incomplete one                                                                                |
| `data/price_quotes.csv` | synthetic Platts/Argus daily quotations                                                          |
| `data/products.csv`     | product reference with barrel-per-tonne conversion factors                                       |

## The task

### Part 1 — Extractor

A small service or CLI: raw recap text in, one JSON deal object out, conforming to a schema you design from `data/field_spec.md`. You own the schema — the field list tells you what has to be covered, not how to model it.

### Part 2 — It must run on a self-hosted model

The extraction path must run on **open-weights models you host yourself** (Qwen, Llama, Mistral, whatever you can actually run). No OpenAI / Anthropic / Google API anywhere in the extraction path.

Say in your write-up how you enforce the output shape (JSON-schema-constrained decoding, grammar, function calling, retry-and-repair, something else) and why you chose that mechanism over the alternatives.

### Part 3 — Eval harness

This is the part we care about most.

- 15–20 cases. The three recaps we give you, variants of them, and cases you invent.
- Field-level scoring, not "looks right". One command runs the whole suite and prints a table.
- Deterministic and reproducible: fixed seeds, pinned model version, committed expected outputs.
- **A must-abstain set.** Some cases are missing a mandatory field or are genuinely ambiguous. The correct behaviour is `null` plus a specific question back to the trader — never an invented number. A hallucinated price differential is a money-losing bug in this business. Score abstention explicitly: correct abstention, wrong abstention, and the one that matters, confident nonsense.

### Part 4 — Performance and cost

Measured numbers, not adjectives. At minimum:

- p50 / p95 end-to-end latency per recap, tokens/s, peak VRAM (or RAM).
- A table comparing **at least two configurations** — quality vs latency vs memory. Different model size, different quantisation, different serving stack, different prompt strategy: your choice, but the trade-off has to be visible.
- What you tried in order to make it faster or cheaper, what worked, what did not, and what you would do next with a real GPU budget.
- Agent spend on this task, in dollars.

### Part 5 — One minimal MCP server

Expose two tools:

- `parse_recap(text)` — your extractor.
- `get_price_quote(quote_code, date_or_period, statistic)` — reads `data/price_quotes.csv`.

Then show your local model using both tools to answer one question: **"what is the provisional value of the deal in `recap_02.txt`?"** That needs the quantity (mind the units), the mean of the quotations over the pricing period, the differential, and the agreed FX.

If tool calling turns out to be unreliable on the model you chose, I want that reported with numbers and a fallback design — not hidden.

## Priority order

In priority order: eval harness and honest numbers first, extractor second, MCP server third, extra configurations last.

The final repository should make it possible for a reviewer to:, with a `README.md` that a reviewer can follow: how to run the service, how to run the eval, what the numbers were, what you would do next.
