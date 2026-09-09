# Code style

Rules I follow in this repository. Project-specific, not a TypeScript tutorial.
Read `docs/rules-and-constraints.md` first for the *what*. This is the *how*.

---

## 1. The layering rule

This is the most important rule in the file. Three layers, dependencies point one way.

```
domain/    pure. no I/O, no LLM, no clock, no fs. arithmetic and rules live here.
llm/       talks to the model. returns spans and literals. computes nothing.
extract/   orchestrates: prompt -> constrained decode -> verify -> normalise.
```

`cli.ts`, `mcp/`, and `eval/` are thin entry points over `extract/`. They contain
no business logic. If a rule from the constraints doc appears in two entry points,
it belongs in `domain/`.

**The model never does arithmetic.** No unit conversion, no date maths, no
averaging quotations, no currency conversion. It reads text and reports what it
saw. Every number that reaches an invoice is computed by code we can unit test.

## 2. Strictness

`tsconfig.json` is non-negotiable:

```jsonc
"strict": true,
"noUncheckedIndexedAccess": true,   // csv rows and regex groups are the reason
"exactOptionalPropertyTypes": true,
"noImplicitOverride": true,
"noFallthroughCasesInSwitch": true,
"verbatimModuleSyntax": true,
"isolatedModules": true
```

No `any`. No non-null assertion `!`. No `as` except inside a function that has
just validated the value. `@ts-expect-error` needs a comment saying why and is
never used to silence a real type error.

## 3. Types

**Zod is the single source of truth.** Define the schema, infer the type. Never
hand-write an interface that duplicates a schema.

```ts
export const Quantity = z.object({ ... });
export type Quantity = z.infer<typeof Quantity>;
```

Use `interface` only for behaviour contracts with multiple implementations, such
as `LlmProvider`. Use `type` for data.

**Brand the identifiers that must not be mixed up.** These are all strings and
swapping two of them is a silent, expensive bug:

```ts
type QuoteCode   = string & { readonly __brand: 'QuoteCode' };
type ProductCode = string & { readonly __brand: 'ProductCode' };
type IsoDate     = string & { readonly __brand: 'IsoDate' };   // YYYY-MM-DD
```

Construct them only through a validating function that checks the value against
the reference CSV or the date format. No casts at call sites.

Discriminated unions over optional-field soup. Every union carries a literal
`kind` or `status` field, and every `switch` over one ends in an exhaustiveness
check that fails to compile when a variant is added.

## 4. Null handling

This project has a specific meaning for `null` and it must not blur.

- `null` means **"the recap does not state this"**. It is a real, correct answer.
- `undefined` never appears in output. It is not serialisable to the same meaning
  and it disappears from JSON silently.
- Never write `?? defaultValue` on a business field. Defaulting a missing
  differential to zero is the exact bug this system exists to prevent. `??` is
  allowed only on presentation concerns such as a log label.
- Every extracted field is wrapped in an envelope, so absence is always explicit
  and always traceable:

```ts
type Field<T> = {
  value: T | null;
  evidence: string | null;          // verbatim substring of the source text
  status: 'stated' | 'absent' | 'ambiguous';
};
```

`status` is not derivable from `value`, and the distinction drives the question
text: absent asks for the value, ambiguous asks the trader to disambiguate.

## 5. Money and quantities

`decimal.js` for every monetary and quantity value. No `number` arithmetic on
anything that reaches an invoice. Parse from string, keep as `Decimal`, serialise
back to string.

```ts
// wrong: 0.1 + 0.2, tonne/barrel factors, percentage tolerances
// right: new Decimal(raw).mul(factor)
```

`number` is fine for latencies, counts and scores. Nothing else.

Conversion factors always come from `data/products.csv`, never from a constant in
the code, and the factor used is recorded on the output so an invoice can be audited.

## 6. Errors

Two kinds, handled differently.

**Expected failures** are values, not exceptions. Unresolvable quote code, evidence
span not found, schema validation failure after decoding. These use a `Result`:

```ts
type Result<T, E = ExtractionError> =
  | { ok: true;  value: T }
  | { ok: false; error: E };
```

**Programmer errors** throw. A missing reference file, an impossible switch branch,
a broken invariant. Throwing is correct there because the process should stop.

Never `catch` without either handling or rethrowing with context. Never swallow an
error to return a partial deal object. A partial deal that looks complete is worse
than a failure.

Errors carry structured context, not a formatted string:
`{ code: 'QUOTE_CODE_UNRESOLVED', quoteCode, caseId }`.

## 7. Functions

Pure by default. Dependencies are injected as parameters, never imported for
their side effects.

```ts
// clock, filesystem and model are all parameters
export function resolvePricingPeriod(spec: PeriodSpec, blDate: IsoDate): DateRange
export async function extract(text: string, deps: ExtractDeps): Promise<Result<Deal>>
```

No module-level side effects, no top-level `await`, no singletons. The eval harness
runs many configurations in one process and a module-level cached model breaks it.

**The model provider is not re-entrant.** It holds one context sequence, so one
generation at a time. An MCP tool handler that calls back into the model while a
generation is in flight wipes the sequence that generation is using, and both
sides silently produce garbage. The provider throws on re-entry rather than
allowing it; gather what a tool needs before generation starts, or load a second
provider.

Functions do one thing. A function that both parses and computes gets split, because
the parse half needs a golden test and the compute half needs a property test.

Prefer early returns over nesting. Keep nesting at two levels.

## 8. Naming

- Files `kebab-case.ts`. Types and schemas `PascalCase`. Values `camelCase`.
- Say what it is in domain terms: `differentialPerMt`, not `diff` or `val2`.
- Booleans read as assertions: `hasEvidence`, `isMandatory`, `requiresFx`.
- Prefix nothing with `I`. No Hungarian notation.
- Reserve `parse` for text to structure, `resolve` for lookup against reference
  data, `normalise` for canonicalising an already-parsed value, and `evaluate`
  for arithmetic. Using them consistently makes the layering visible in call sites.
- Test files sit next to the source: `pricing.ts`, `pricing.test.ts`.

## 9. Validation

Validate at the boundary, then trust the type inside.

Four boundaries in this system, each with a Zod parse:

1. Model output after constrained decoding.
2. Reference CSV rows on load.
3. MCP tool arguments.
4. Eval case files, `expected.json` included. A malformed expectation must fail
   loudly rather than quietly scoring everything as wrong.

Grammar-constrained decoding is not validation. It guarantees shape, not
correctness, and the grammar only covers the JSON Schema subset the runtime
supports. Always parse the decoded output with Zod as well.

## 10. Determinism

- No `Date.now()`, no `new Date()` without an argument, outside the entry points.
  Time enters as an injected `IsoDate`.
- No `Math.random()` anywhere.
- Sort before serialising anything that is compared or committed. Object key
  order in `expected.json` and in reports must be stable.
- Every sampling parameter is set explicitly. Never rely on a provider default,
  because the default changes between versions and silently invalidates a report.

## 11. Testing

Two distinct things, not to be confused.

**Unit tests** (`vitest`) cover pure `domain/` code: date resolution, unit
conversion, formula evaluation, question generation, the scorer itself. They never
load a model. They are fast, and they run in CI.

**The eval harness** measures model behaviour. It is not a unit test suite and does
not live in `vitest`, because its output is a scored table and a JSON report rather
than pass or fail.

The scorer needs its own unit tests. A scorer bug produces confident, wrong
conclusions about the whole system, which is the same failure mode we are trying
to eliminate in the extractor.

Golden fixtures over inline literals for anything longer than a couple of lines.

## 12. Logging

- **`stdout` is reserved.** In MCP stdio mode it carries protocol frames. All
  logging goes to `stderr`, on every path, including the CLI. One stray
  `console.log` in shared code breaks the MCP server, and it breaks it in a way
  that looks like a client bug. `pnpm guard` fails the build on any `console.*`
  in `src/`; entry points write with `process.stdout.write` deliberately.
- Structured JSONL to stderr, one object per line, never interpolated prose.
- Log the model call: prompt token count, completion token count, wall time,
  whether a repair retry fired. Those fields feed the performance table directly,
  so they are instrumentation, not debugging output.
- Never log full recap text at info level. It is commercially sensitive.

## 13. Comments

Comment the *why*, especially where a rule from the constraints doc is being
enforced, and link it:

```ts
// B5: trader shorthand such as "delivered Rotterdam" is not an Incoterm.
// Record the raw text and ask, do not map it to DAP.
```

No commented-out code. No `TODO` without an owner and a matching entry in
`docs/tasks.md`.

## 14. Dependencies

Small and justified. Every dependency added gets a line in the README saying why.

Runtime: `zod`, `decimal.js`, `node-llama-cpp`. Planned:
`@modelcontextprotocol/sdk` (phase 8). Tooling: `typescript`, `tsx`, `vitest`.

Argument parsing uses `node:util` `parseArgs` and the report table is thirty
lines in `src/eval/table.ts`, so `commander` and `cli-table3` were dropped from
the plan rather than added. CSV parsing is likewise hand-rolled: the two
reference files are ours and read once.

Adding a heavy framework needs a reason stronger than convenience, because the
whole point of the exercise is a system that runs on one laptop.
