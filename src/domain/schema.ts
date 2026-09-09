/**
 * The deal object. Single source of truth for the shape (code-style §3).
 *
 * Zod drives four things: the decoding grammar, runtime validation of model
 * output, the MCP tool signatures, and the eval expectation loader. There is no
 * second, hand-written definition anywhere.
 *
 * Two decisions worth knowing about:
 *
 * 1. **Every value is wrapped in a `Field` envelope.** `value: null` is a real
 *    answer meaning "the recap does not state this", `evidence` is the span it
 *    was read from, and `status` separates "absent" from "ambiguous" because the
 *    two produce different questions (B6, B7).
 *
 * 2. **Quote and product codes are plain strings here, not enums.** The
 *    decoding grammar narrows them to the codes actually present in the
 *    reference CSVs, which removes invented codes before the model can emit
 *    one. The schema stays code-agnostic so eval expectations load without
 *    reference data, and unresolvable codes become a question rather than a
 *    parse failure.
 */
import { z } from 'zod';

export const FIELD_STATUSES = ['stated', 'absent', 'ambiguous'] as const;
export type FieldStatus = (typeof FIELD_STATUSES)[number];

/**
 * Leaf value types.
 *
 * Each is defined once and reused, so the grammar builder can identify a leaf by
 * object identity and emit a token-level rule for it. That is why these are
 * module constants rather than inline expressions: `src/llm/grammar.ts` compares
 * against them to decide whether a field decodes as a decimal, a date, a
 * currency code or free text.
 */

/** Plain decimal text. Numbers never pass through a float (code-style §5). */
export const decimalText = z
  .string()
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/, 'plain decimal, no thousands separators');

export const isoDateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const currencyText = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code');

export const freeText = z.string().min(1);

function field<T extends z.ZodType>(inner: T) {
  return z.object({
    value: inner.nullable(),
    evidence: z.string().nullable(),
    status: z.enum(FIELD_STATUSES),
  });
}

export type Field<T> = {
  value: T | null;
  evidence: string | null;
  status: FieldStatus;
};

export const INCOTERMS = ['EXW', 'FAS', 'FOB', 'CFR', 'CIF', 'DAP', 'DDP'] as const;
export const TOLERANCE_OPTIONS = ['seller', 'buyer'] as const;
export const QUANTITY_UNIT_VALUES = ['MT', 'BBL'] as const;
export const PRICE_UNIT_VALUES = ['USD/MT', 'USD/BBL'] as const;
export const STATISTIC_VALUES = ['mean', 'high', 'low', 'mean_of_high'] as const;
export const PAYMENT_SHAPES = [
  'prepayment',
  'net_days',
  'lc_at_sight',
  'provisional_then_final',
  'other',
] as const;
export const PAYMENT_ANCHORS = ['bl', 'invoice', 'nor', 'delivery'] as const;
export const APPOINTED_BY = ['seller', 'buyer', 'both'] as const;

export const DealSchema = z.object({
  recap_date: field(isoDateText),
  buyer: field(freeText),
  seller: field(freeText),

  product: z.object({
    as_written: field(freeText),
    product_code: field(freeText),
  }),

  quantity: z.object({
    value: field(decimalText),
    unit: field(z.enum(QUANTITY_UNIT_VALUES)),
    tolerance_pct: field(decimalText),
    tolerance_option: field(z.enum(TOLERANCE_OPTIONS)),
  }),

  delivery_term: z.object({
    // B5: what the recap actually said, even when it is not an Incoterm.
    as_written: field(freeText),
    incoterm: field(z.enum(INCOTERMS)),
    place: field(freeText),
  }),

  delivery_window: z.object({
    as_written: field(freeText),
    from: field(isoDateText),
    to: field(isoDateText),
  }),

  // B8: a formula, never collapsed into one number.
  pricing: z.object({
    quote_code: field(freeText),
    statistic: field(z.enum(STATISTIC_VALUES)),
    period: field(freeText),
    differential: z.object({
      value: field(decimalText),
      unit: field(z.enum(PRICE_UNIT_VALUES)),
    }),
  }),

  currency: field(currencyText),

  payment_terms: z.object({
    as_written: field(freeText),
    shape: field(z.enum(PAYMENT_SHAPES)),
    days: field(decimalText),
    days_from: field(z.enum(PAYMENT_ANCHORS)),
    pct_upfront: field(decimalText),
    late_interest_pct_pa: field(decimalText),
  }),

  // --- conditional from here down: absence is not an error --------------
  fx: z.object({
    rate: field(decimalText),
    basis: field(freeText),
  }),
  quality_spec: field(freeText),
  inspection: z.object({
    inspector: field(freeText),
    appointed_by: field(z.enum(APPOINTED_BY)),
    cost_split: field(freeText),
  }),
  demurrage: z.object({
    rate_per_day: field(decimalText),
    currency: field(currencyText),
  }),
  law: field(freeText),
  arbitration: field(freeText),
  vessel: field(freeText),
  notes: field(freeText),
});

export type Deal = z.infer<typeof DealSchema>;

/**
 * Mandatory fields, as dotted paths, in report order.
 *
 * This list is the contract between the schema, the question generator and the
 * scorer. Adding a mandatory field to the schema without adding it here means
 * it is silently never scored, so the three are cross-checked by a unit test.
 */
export const MANDATORY_FIELDS = [
  'recap_date',
  'buyer',
  'seller',
  'product.as_written',
  'product.product_code',
  'quantity.value',
  'quantity.unit',
  'quantity.tolerance_pct',
  'quantity.tolerance_option',
  'delivery_term.incoterm',
  'delivery_term.place',
  'delivery_window.from',
  'delivery_window.to',
  'pricing.quote_code',
  'pricing.statistic',
  'pricing.period',
  'pricing.differential.value',
  'pricing.differential.unit',
  'currency',
  'payment_terms.as_written',
] as const;

export type MandatoryField = (typeof MANDATORY_FIELDS)[number];

/**
 * Fields whose invention costs money directly. `confident_nonsense` on any of
 * these is the release gate in docs/rules-and-constraints.md §4.
 */
export const MONEY_CRITICAL_FIELDS: readonly MandatoryField[] = [
  'quantity.value',
  'quantity.unit',
  'quantity.tolerance_pct',
  'pricing.quote_code',
  'pricing.statistic',
  'pricing.period',
  'pricing.differential.value',
  'pricing.differential.unit',
  'currency',
];

/** Every field path in the schema, mandatory or not, in a stable order. */
export const ALL_FIELDS: readonly string[] = collectFieldPaths(DealSchema);

function collectFieldPaths(schema: z.ZodObject, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(schema.shape)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isFieldEnvelope(value)) out.push(path);
    else if (value instanceof z.ZodObject) out.push(...collectFieldPaths(value, path));
  }
  return out;
}

function isFieldEnvelope(schema: unknown): boolean {
  if (!(schema instanceof z.ZodObject)) return false;
  const keys = Object.keys(schema.shape).sort();
  return keys.length === 3 && keys[0] === 'evidence' && keys[1] === 'status' && keys[2] === 'value';
}

/** Read a field envelope by dotted path. Returns null when the path is not a field. */
export function getField(deal: Deal, path: string): Field<unknown> | null {
  let node: unknown = deal;
  for (const segment of path.split('.')) {
    if (typeof node !== 'object' || node === null) return null;
    node = (node as Record<string, unknown>)[segment];
  }
  if (typeof node !== 'object' || node === null) return null;
  const candidate = node as Record<string, unknown>;
  if (!('value' in candidate) || !('status' in candidate) || !('evidence' in candidate)) return null;
  return candidate as Field<unknown>;
}

/** An all-null deal: every field absent, no evidence. The abstention baseline. */
export function emptyDeal(): Deal {
  const blank = { value: null, evidence: null, status: 'absent' as const };
  const build = (schema: z.ZodObject): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema.shape)) {
      if (isFieldEnvelope(value)) out[key] = { ...blank };
      else if (value instanceof z.ZodObject) out[key] = build(value);
    }
    return out;
  };
  return DealSchema.parse(build(DealSchema));
}

// --------------------------------------------------------------------------
// Schema introspection for the grammar builder
// --------------------------------------------------------------------------

/**
 * What a leaf field decodes as, at the token level.
 *
 * The grammar builder needs more than "string": a quantity and a laycan are both
 * strings to Zod, and letting the model emit `"30,000"` for one or `"early Oct"`
 * for the other is how a parse quietly becomes a different number. Identifying
 * the leaf here lets the grammar forbid those before a token is chosen.
 */
export type LeafKind =
  | { readonly kind: 'text' }
  | { readonly kind: 'decimal' }
  | { readonly kind: 'iso_date' }
  | { readonly kind: 'currency' }
  | { readonly kind: 'enum'; readonly values: readonly string[] };

export type SchemaNode =
  | { readonly kind: 'object'; readonly children: ReadonlyArray<readonly [string, SchemaNode]> }
  | { readonly kind: 'field'; readonly leaf: LeafKind };

function leafKindOf(inner: z.ZodType): LeafKind {
  if (inner === decimalText) return { kind: 'decimal' };
  if (inner === isoDateText) return { kind: 'iso_date' };
  if (inner === currencyText) return { kind: 'currency' };
  if (inner === freeText) return { kind: 'text' };
  if (inner instanceof z.ZodEnum) {
    return { kind: 'enum', values: Object.values(inner.enum) as string[] };
  }
  // Deliberately fatal. A new leaf type that the grammar does not know about
  // would silently decode as free text, which is the failure this whole
  // mechanism exists to prevent.
  throw new Error('unrecognised leaf schema: add it to leafKindOf in schema.ts');
}

/** The deal schema as a tree the grammar builder can walk. Key order is stable. */
export function describeSchema(schema: z.ZodObject = DealSchema): SchemaNode {
  const children: Array<readonly [string, SchemaNode]> = [];
  for (const [key, value] of Object.entries(schema.shape)) {
    if (isFieldEnvelope(value)) {
      const envelope = value as z.ZodObject;
      const valueSchema = envelope.shape['value'];
      if (valueSchema === undefined) throw new Error(`field ${key} has no value schema`);
      const unwrapped = valueSchema instanceof z.ZodNullable ? valueSchema.unwrap() : valueSchema;
      children.push([key, { kind: 'field', leaf: leafKindOf(unwrapped as z.ZodType) }]);
    } else if (value instanceof z.ZodObject) {
      children.push([key, describeSchema(value)]);
    }
  }
  return { kind: 'object', children };
}
