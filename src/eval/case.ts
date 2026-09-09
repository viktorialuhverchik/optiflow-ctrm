/**
 * Eval case format and loader.
 *
 * A case is a directory holding three files:
 *
 *   input.txt      the recap, exactly as it would arrive
 *   expected.json  a flat map of dotted field path to expected value
 *   meta.json      id, title, class, reference date, provenance
 *
 * Expected values are a flat map rather than a whole deal object because that
 * is what a reviewer can actually read in a diff, and because it makes the
 * scored surface explicit: a field with no key is a field nobody claimed to
 * know the answer for.
 *
 * The loader is strict on purpose (code-style §9). A typo in a field path or a
 * number written as a JSON number instead of a decimal string would otherwise
 * score silently as a miss, and a broken expectation produces confident, wrong
 * conclusions about the whole system.
 */
import { z } from 'zod';
import { ALL_FIELDS, MANDATORY_FIELDS } from '../domain/schema.js';

export const CASE_CLASSES = [
  'clean',
  'thread_amendment',
  'distractor',
  'unit_mismatch',
  'non_usd',
  'must_abstain',
] as const;
export type CaseClass = (typeof CASE_CLASSES)[number];

export const CaseMetaSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'lowercase kebab-case'),
  title: z.string().min(1),
  class: z.enum(CASE_CLASSES),
  /** Injected clock for this case (D4). Supplies the year for a bare laycan. */
  reference_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.enum(['supplied', 'variant', 'invented']),
  notes: z.string().default(''),
});
export type CaseMeta = z.infer<typeof CaseMetaSchema>;

/** Expected values are strings or null. Never JSON numbers: see the module note. */
export const ExpectedSchema = z.object({
  fields: z.record(z.string(), z.union([z.string(), z.null()])),
  notes: z.string().default(''),
});
export type Expected = z.infer<typeof ExpectedSchema>;

export type EvalCase = {
  readonly meta: CaseMeta;
  readonly text: string;
  readonly expected: ReadonlyMap<string, string | null>;
  readonly directory: string;
};

const ALL_FIELD_SET = new Set(ALL_FIELDS);

/**
 * Validate a case that has already been read off disk. Pure, so the rules are
 * unit-testable without fixtures.
 */
export function buildCase(
  directory: string,
  rawMeta: unknown,
  rawExpected: unknown,
  text: string,
): EvalCase {
  const meta = CaseMetaSchema.parse(rawMeta);
  const expected = ExpectedSchema.parse(rawExpected);

  if (text.trim() === '') {
    throw new Error(`${directory}: input.txt is empty`);
  }

  const unknownPaths = Object.keys(expected.fields).filter((path) => !ALL_FIELD_SET.has(path));
  if (unknownPaths.length > 0) {
    throw new Error(`${directory}: expected.json names fields that are not in the schema: ${unknownPaths.join(', ')}`);
  }

  const missing = MANDATORY_FIELDS.filter((path) => !(path in expected.fields));
  if (missing.length > 0) {
    // Every mandatory field must have a stated expectation, including the ones
    // whose expected answer is null. Otherwise a must-abstain case would score
    // as "not tested" exactly where abstention matters most.
    throw new Error(`${directory}: expected.json is missing mandatory fields: ${missing.join(', ')}`);
  }

  return {
    meta,
    text,
    expected: new Map(Object.entries(expected.fields)),
    directory,
  };
}

/** Cases run in id order so two runs produce identical reports (D5). */
export function sortCases(cases: readonly EvalCase[]): EvalCase[] {
  return [...cases].sort((a, b) => (a.meta.id < b.meta.id ? -1 : a.meta.id > b.meta.id ? 1 : 0));
}
