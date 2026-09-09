/**
 * The model extractor: prompt, constrained decode, verify, validate.
 *
 * Four stages, and the order matters. The grammar guarantees the shape at decode
 * time. Evidence verification drops values the message cannot support. Zod
 * catches what a grammar cannot express, such as a date that has the right shape
 * but is not a real day. Only then does the domain layer see the object.
 *
 * The repair retry is a fallback, not a mechanism. It fires at most once, it is
 * counted separately in the report, and a run where it fires often means the
 * grammar or the prompt is wrong rather than that the retry is working.
 */
import { isIsoDate } from '../domain/brands.js';
import { normalisePricingPeriod } from '../domain/normalise.js';
import { generateQuestions, type Unresolvable } from '../domain/questions.js';
import type { ReferenceData } from '../domain/references.js';
import { ALL_FIELDS, DealSchema, emptyDeal, getField, type Deal } from '../domain/schema.js';
import { buildDealGrammar, type GrammarScope } from '../llm/grammar.js';
import type { LlmProvider } from '../llm/provider.js';
import { describeAsDetail } from '../llm/provider.js';
import { verifyEvidence, type EvidenceRejection } from './evidence.js';
import { checkEvidenceSupport } from './support.js';
import { PROMPT_VERSION, SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';
import type {
  ExtractionOutput,
  ExtractionRequest,
  Extractor,
  ExtractorConfig,
} from './types.js';

export type ModelExtractorOptions = {
  readonly provider: LlmProvider;
  readonly referenceData: ReferenceData;
  /**
   * The all-null object alone is about 2.5 KB minified, and a fully stated deal
   * is larger. A cap below what the object needs truncates mid-object and the
   * whole case fails, so this is generous on purpose.
   */
  readonly maxTokens?: number;
  readonly maxRepairAttempts?: number;
  /**
   * `mandatory` asks the model for the twenty required fields only, leaving the
   * conditional ones absent. Roughly half the output tokens. Measured in phase 7.
   */
  readonly scope?: GrammarScope;
  /** Debug hook. Never logs full recap text at info level (code-style §12). */
  readonly onRaw?: (caseId: string, raw: string) => void;
};

const DATE_FIELDS = ['recap_date', 'delivery_window.from', 'delivery_window.to'] as const;

export function createModelExtractor(options: ModelExtractorOptions): Extractor {
  const { provider, referenceData } = options;
  const maxTokens = options.maxTokens ?? 3000;
  const maxRepairAttempts = options.maxRepairAttempts ?? 1;

  // Built once. It depends only on the schema and the reference codes, and
  // rebuilding it per case would add nothing but latency.
  const scope: GrammarScope = options.scope ?? 'all';
  const grammarSource = buildDealGrammar(
    { productCodes: referenceData.productCodes, quoteCodes: referenceData.quoteCodes },
    { scope },
  );

  const config: ExtractorConfig = {
    name: 'model',
    kind: 'model',
    detail: {
      ...describeAsDetail(provider.describe()),
      max_tokens: maxTokens,
      max_repair_attempts: maxRepairAttempts,
      grammar_rules: grammarSource.split('\n').length,
      grammar: 'gbnf, generated from the deal schema',
      field_scope: scope,
      prompt_version: PROMPT_VERSION,
      support_checks: 'on',
    },
  };

  return {
    config,
    async extract(request: ExtractionRequest): Promise<ExtractionOutput> {
      const started = performance.now();
      const user = buildUserPrompt(request.text, request.referenceDate, referenceData);

      let repairAttempts = 0;
      let promptTokens = 0;
      let completionTokens = 0;
      let deal: Deal | null = null;
      let lastError = '';
      let repairNote = '';

      while (deal === null) {
        const result = await provider.complete({
          system: SYSTEM_PROMPT,
          user: repairNote === '' ? user : `${user}\n\n${repairNote}`,
          maxTokens,
          grammar: { kind: 'gbnf', source: grammarSource },
        });
        promptTokens += result.promptTokens;
        completionTokens += result.completionTokens;
        options.onRaw?.(request.caseId, result.text);

        const parsed = parseDeal(result.text);
        if (parsed.ok) {
          deal = parsed.deal;
          break;
        }

        lastError = parsed.error;
        if (repairAttempts >= maxRepairAttempts) break;
        repairAttempts += 1;
        repairNote = [
          'Your previous answer could not be used:',
          lastError,
          'Answer again. Where you are unsure of a value, use null rather than guessing.',
        ].join('\n');
      }

      if (deal === null) {
        // Refusing to hand back a partial object. A deal that looks complete and
        // is not is worse than a failure (code-style §6).
        throw new Error(`could not decode a deal object: ${lastError}`);
      }

      const checked = verifyEvidence(deal, request.text);
      const canonical = canonicalise(checked.deal);
      const dated = dropImpossibleDates(canonical);
      // Prompting could not close the release gate: see the note at the top of
      // support.ts. These checks are deterministic and can only refuse.
      const supported = checkEvidenceSupport(dated.deal, request.text, referenceData);
      const unresolvable = findUnresolvableCodes(supported.deal, referenceData);

      return {
        deal: supported.deal,
        questions: generateQuestions(supported.deal, unresolvable),
        diagnostics: {
          durationMs: performance.now() - started,
          promptTokens,
          completionTokens,
          repairAttempts,
          evidenceRejections: [
            ...checked.rejections.map(describeRejection),
            ...dated.rejections,
            ...supported.failures.map((failure) => `${failure.field}: ${failure.rule}`),
          ],
          unresolvedCodes: unresolvable.map((entry) => entry.field),
        },
      };
    },
  };
}

function describeRejection(rejection: EvidenceRejection): string {
  return `${rejection.field}: ${rejection.reason}`;
}

type ParseOutcome = { ok: true; deal: Deal } | { ok: false; error: string };

function mergeIntoEmpty(decoded: unknown): unknown {
  if (typeof decoded !== 'object' || decoded === null) return decoded;
  const merge = (base: Record<string, unknown>, patch: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(patch)) {
      const existing = base[key];
      if (
        typeof value === 'object' &&
        value !== null &&
        typeof existing === 'object' &&
        existing !== null &&
        !('status' in value)
      ) {
        merge(existing as Record<string, unknown>, value as Record<string, unknown>);
      } else {
        base[key] = value;
      }
    }
  };
  const base = emptyDeal() as unknown as Record<string, unknown>;
  merge(base, decoded as Record<string, unknown>);
  return base;
}

function parseDeal(raw: string): ParseOutcome {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `the answer was not valid JSON: ${String(error)}` };
  }
  // A mandatory-scope grammar omits the conditional fields entirely, so the
  // decoded object is a subset of the schema. Fill the gaps as absent rather
  // than relaxing the schema: downstream code should never have to ask whether
  // a field exists, only whether it has a value.
  const result = DealSchema.safeParse(mergeIntoEmpty(json));
  if (!result.success) {
    const first = result.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    return { ok: false, error: first.join('; ') };
  }
  return { ok: true, deal: result.data };
}

/**
 * Canonicalise the values the model copied.
 *
 * Runs after evidence verification so the check compares the model's own words
 * against the message, and before validation so the domain layer only ever sees
 * canonical forms.
 */
function canonicalise(deal: Deal): Deal {
  const period = getField(deal, 'pricing.period');
  if (period === null || typeof period.value !== 'string') return deal;
  const normalised = normalisePricingPeriod(period.value);
  if (normalised === period.value) return deal;
  const copy = structuredClone(deal);
  copy.pricing.period = { ...copy.pricing.period, value: normalised };
  return copy;
}

/**
 * The grammar guarantees `YYYY-MM-DD`, not that the day exists. `2026-02-30`
 * decodes cleanly and would then flow into a laycan. Drop it and ask.
 */
function dropImpossibleDates(deal: Deal): { deal: Deal; rejections: string[] } {
  const rejections: string[] = [];
  const copy = structuredClone(deal) as unknown as Record<string, unknown>;

  for (const path of DATE_FIELDS) {
    const entry = getField(deal, path);
    if (entry === null || typeof entry.value !== 'string') continue;
    if (isIsoDate(entry.value)) continue;
    rejections.push(`${path}: not a real calendar date`);
    const segments = path.split('.');
    let node = copy;
    for (const segment of segments.slice(0, -1)) node = node[segment] as Record<string, unknown>;
    node[segments[segments.length - 1] as string] = {
      value: null,
      evidence: null,
      status: 'ambiguous',
    };
  }

  return { deal: copy as unknown as Deal, rejections };
}

/**
 * A safety net rather than a real path.
 *
 * The grammar restricts both code fields to the reference data, so this should
 * find nothing. It exists because a provider without grammar support, such as a
 * server that ignores the field, would decode freely and the failure has to
 * surface as a question rather than as a wrong lookup later.
 */
function findUnresolvableCodes(deal: Deal, data: ReferenceData): Unresolvable[] {
  const out: Unresolvable[] = [];

  const product = getField(deal, 'product.product_code');
  if (typeof product?.value === 'string' && !data.products.has(product.value)) {
    out.push({
      field: 'product.product_code',
      detail: `The message resolved to "${product.value}", which is not in our product list.`,
    });
  }

  const quote = getField(deal, 'pricing.quote_code');
  if (typeof quote?.value === 'string' && !data.quotesByCode.has(quote.value)) {
    out.push({
      field: 'pricing.quote_code',
      detail: `The message resolved to "${quote.value}", for which we hold no quotations.`,
    });
  }

  return out;
}

/** Exported for the CLI, which prints the field list in schema order. */
export const EXTRACTED_FIELDS = ALL_FIELDS;
