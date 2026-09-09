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

/** Supplied by the caller because only it knows how the model was loaded. */
export type RunnerOptions = { readonly modelLoadMs?: number };

export async function runEval(
  cases: readonly EvalCase[],
  extractor: Extractor,
  onProgress?: (event: ProgressEvent) => void,
  options: RunnerOptions = {},
): Promise<Report> {
  const ordered = sortCases(cases);
  const scores: CaseScore[] = [];
  const durations = new Map<string, number>();
  let promptTokens = 0;
  let completionTokens = 0;
  let repairAttempts = 0;
  let evidenceRejections = 0;

  for (const [index, evalCase] of ordered.entries()) {
    onProgress?.({ caseId: evalCase.meta.id, index, total: ordered.length });
    const run = await runOne(evalCase, extractor);
    scores.push(run.score);
    durations.set(evalCase.meta.id, run.durationMs);
    promptTokens += run.promptTokens;
    completionTokens += run.completionTokens;
    repairAttempts += run.repairAttempts;
    evidenceRejections += run.evidenceRejections;
  }

  return buildReport(
    extractor.config,
    summarise(scores),
    summariseByClass(scores),
    scores,
    durations,
    {
      modelLoadMs: options.modelLoadMs ?? null,
      promptTokens,
      completionTokens,
      repairAttempts,
      evidenceRejections,
    },
  );
}

type Run = {
  readonly score: CaseScore;
  readonly durationMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly repairAttempts: number;
  readonly evidenceRejections: number;
};

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
      promptTokens: output.diagnostics.promptTokens ?? 0,
      completionTokens: output.diagnostics.completionTokens ?? 0,
      repairAttempts: output.diagnostics.repairAttempts,
      evidenceRejections: output.diagnostics.evidenceRejections.length,
    };
  } catch (error) {
    // A crashing extractor must not stop the suite or silently vanish from the
    // table: the case scores as if it produced nothing, and the failure is
    // counted and printed.
    const message = error instanceof Error ? error.message : String(error);
    return {
      score: scoreCase(evalCase, emptyDeal(), [], message),
      durationMs: performance.now() - started,
      promptTokens: 0,
      completionTokens: 0,
      repairAttempts: 0,
      evidenceRejections: 0,
    };
  }
}
