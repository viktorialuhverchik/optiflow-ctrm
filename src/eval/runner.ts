/**
 * Runs an extractor over a set of cases and scores the result.
 *
 * Depends on the `Extractor` interface and nothing else, which is what lets the
 * harness be built and trusted before a model exists (docs/tasks.md phase 2).
 * Cases run sequentially: a local model holds the whole machine, and running
 * them in parallel would make the latency numbers meaningless.
 */
import { emptyDeal } from '../domain/schema.js';
import type { Extractor } from '../extract/types.js';
import type { EvalCase } from './case.js';
import { sortCases } from './case.js';
import { buildReport, type Report } from './report.js';
import { scoreCase, summarise, summariseByClass, type CaseScore } from './score.js';

export type ProgressEvent = { readonly caseId: string; readonly index: number; readonly total: number };

export async function runEval(
  cases: readonly EvalCase[],
  extractor: Extractor,
  onProgress?: (event: ProgressEvent) => void,
): Promise<Report> {
  const ordered = sortCases(cases);
  const scores: CaseScore[] = [];
  const durations = new Map<string, number>();

  for (const [index, evalCase] of ordered.entries()) {
    onProgress?.({ caseId: evalCase.meta.id, index, total: ordered.length });
    const run = await runOne(evalCase, extractor);
    scores.push(run.score);
    durations.set(evalCase.meta.id, run.durationMs);
  }

  return buildReport(
    extractor.config,
    summarise(scores),
    summariseByClass(scores),
    scores,
    durations,
  );
}

type Run = { readonly score: CaseScore; readonly durationMs: number };

async function runOne(evalCase: EvalCase, extractor: Extractor): Promise<Run> {
  const started = performance.now();
  try {
    const output = await extractor.extract({
      caseId: evalCase.meta.id,
      text: evalCase.text,
      referenceDate: evalCase.meta.reference_date,
    });
    return {
      score: scoreCase(evalCase, output.deal, output.questions),
      durationMs: output.diagnostics.durationMs || performance.now() - started,
    };
  } catch (error) {
    // A crashing extractor must not stop the suite or silently vanish from the
    // table: the case scores as if it produced nothing, and the failure is
    // counted and printed.
    const message = error instanceof Error ? error.message : String(error);
    return {
      score: scoreCase(evalCase, emptyDeal(), [], message),
      durationMs: performance.now() - started,
    };
  }
}
