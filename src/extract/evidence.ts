/**
 * Evidence verification.
 *
 * Every value has to quote the words it came from, and those words have to be in
 * the message. A value whose evidence is not there is dropped and the field is
 * asked about instead.
 *
 * This converts a class of confident nonsense into a detectable failure with no
 * second model call and no extra latency. It is not a complete defence, and the
 * limit is worth stating plainly: it catches invented text, not misattributed
 * text. A differential copied from the wrong line of a forwarded thread quotes a
 * real span and passes. The thread cases in the eval set exist to size that gap.
 *
 * Dropping a value turns a possibly-correct answer into an over-refusal, which
 * the scorer counts as `wrong_abstention`. That is the safe direction to fail
 * in, and the count is reported so the trade can be seen rather than assumed.
 */
import { ALL_FIELDS, getField, type Deal } from '../domain/schema.js';

export type EvidenceRejection = {
  readonly field: string;
  readonly reason: 'missing_evidence' | 'evidence_not_in_source';
  /** Truncated. Full recap text never reaches a log (code-style §12). */
  readonly quoted: string;
};

/**
 * Normalise for comparison.
 *
 * Whitespace is collapsed because a model reading a wrapped email line will
 * quote it back with the wrap removed, and that is not a fabrication. Case is
 * folded for the same reason. Nothing else is relaxed: punctuation and digits
 * have to match, which is the entire point.
 */
export function normaliseForSearch(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function evidenceAppearsIn(source: string, evidence: string): boolean {
  const needle = normaliseForSearch(evidence);
  if (needle === '') return false;
  return normaliseForSearch(source).includes(needle);
}

export type EvidenceCheck = {
  readonly deal: Deal;
  readonly rejections: readonly EvidenceRejection[];
};

/**
 * Drop every value whose evidence is not in the source.
 *
 * A field with a null value is left alone: an abstention needs no evidence, and
 * demanding one would penalise the behaviour we are trying to encourage.
 */
export function verifyEvidence(deal: Deal, source: string): EvidenceCheck {
  const rejections: EvidenceRejection[] = [];
  const copy = structuredClone(deal) as unknown as Record<string, unknown>;

  for (const path of ALL_FIELDS) {
    const entry = getField(deal, path);
    if (entry === null || entry.value === null) continue;

    if (entry.evidence === null || entry.evidence.trim() === '') {
      rejections.push({ field: path, reason: 'missing_evidence', quoted: '' });
      clearField(copy, path);
      continue;
    }

    if (!evidenceAppearsIn(source, entry.evidence)) {
      rejections.push({
        field: path,
        reason: 'evidence_not_in_source',
        quoted: entry.evidence.slice(0, 60),
      });
      clearField(copy, path);
    }
  }

  return { deal: copy as unknown as Deal, rejections };
}

function clearField(root: Record<string, unknown>, path: string): void {
  const segments = path.split('.');
  let node = root;
  for (const segment of segments.slice(0, -1)) {
    node = node[segment] as Record<string, unknown>;
  }
  node[segments[segments.length - 1] as string] = {
    value: null,
    evidence: null,
    // "ambiguous" rather than "absent": the message may well say this, we just
    // could not confirm where. The question generator asks accordingly.
    status: 'ambiguous',
  };
}
