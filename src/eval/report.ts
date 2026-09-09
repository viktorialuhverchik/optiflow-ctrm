/**
 * Report rendering and the JSON artefact.
 *
 * The JSON report is split into a `scores` block and a `timings` block on
 * purpose. Scores are deterministic for a fixed extractor, so two runs can be
 * diffed byte for byte to prove a change did nothing. Timings never are, so
 * they are kept out of the way rather than polluting that diff (D3, D6).
 */
import { OUTCOMES, zeroCounts, type CaseScore, type OutcomeCounts, type Summary } from './score.js';
import { renderTable, percent, type Column } from './table.js';
import type { ExtractorConfig } from '../extract/types.js';

export type Report = {
  readonly extractor: ExtractorConfig;
  readonly scores: {
    readonly summary: Summary;
    readonly byClass: Record<string, Summary>;
    readonly cases: readonly CaseScore[];
  };
  readonly timings: {
    readonly totalMs: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly perCaseMs: Record<string, number>;
  };
  /**
   * What the run cost. Separate from `scores` for the same reason timings are:
   * none of it is reproducible, and it must not pollute a scores diff (D3).
   */
  readonly resources: {
    /** Peak resident set for the whole process, bytes. */
    readonly peakRssBytes: number;
    readonly modelLoadMs: number | null;
    readonly promptTokens: number;
    readonly completionTokens: number;
    /** Completion tokens divided by generation time, across the suite. */
    readonly tokensPerSecond: number;
    readonly repairAttempts: number;
    readonly evidenceRejections: number;
  };
};

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank. Simple, and exact for the small case counts we run.
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index] ?? 0;
}

export type ResourceTotals = {
  readonly modelLoadMs: number | null;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly repairAttempts: number;
  readonly evidenceRejections: number;
};

export function buildReport(
  extractor: ExtractorConfig,
  summary: Summary,
  byClass: ReadonlyMap<string, Summary>,
  cases: readonly CaseScore[],
  durationsByCase: ReadonlyMap<string, number>,
  totals: ResourceTotals = {
    modelLoadMs: null,
    promptTokens: 0,
    completionTokens: 0,
    repairAttempts: 0,
    evidenceRejections: 0,
  },
): Report {
  const durations = cases.map((c) => durationsByCase.get(c.caseId) ?? 0);
  const perCaseMs: Record<string, number> = {};
  for (const score of cases) perCaseMs[score.caseId] = durationsByCase.get(score.caseId) ?? 0;

  return {
    extractor,
    scores: {
      summary,
      byClass: Object.fromEntries(byClass),
      cases,
    },
    timings: {
      totalMs: durations.reduce((a, b) => a + b, 0),
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      perCaseMs,
    },
    resources: {
      // maxRSS is reported in kilobytes on macOS and Linux alike by Node.
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      modelLoadMs: totals.modelLoadMs,
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      tokensPerSecond:
        durations.length === 0 || totals.completionTokens === 0
          ? 0
          : totals.completionTokens / (durations.reduce((a, b) => a + b, 0) / 1000),
      repairAttempts: totals.repairAttempts,
      evidenceRejections: totals.evidenceRejections,
    },
  };
}

export function renderReport(report: Report): string {
  const blocks: string[] = [];

  blocks.push(renderHeader(report));
  blocks.push(renderPerCase(report.scores.cases));
  blocks.push(renderOutcomes(report.scores.summary));
  blocks.push(renderByClass(report.scores.byClass));
  blocks.push(renderHeadline(report.scores.summary, report.timings));
  blocks.push(renderResources(report));

  return blocks.join('\n\n');
}

function renderResources(report: Report): string {
  const r = report.resources;
  const cases = report.scores.cases.length;
  const columns: Column[] = [{ header: 'cost' }, { header: 'value', align: 'right' }];
  const rows: string[][] = [
    ['peak resident memory MiB', (r.peakRssBytes / 1024 / 1024).toFixed(0)],
    ['model load ms', r.modelLoadMs === null ? 'n/a' : String(Math.round(r.modelLoadMs))],
    ['prompt tokens, mean per recap', cases === 0 ? '0' : String(Math.round(r.promptTokens / cases))],
    [
      'completion tokens, mean per recap',
      cases === 0 ? '0' : String(Math.round(r.completionTokens / cases)),
    ],
    ['completion tokens/s, end to end', r.tokensPerSecond.toFixed(1)],
    ['repair retries fired', String(r.repairAttempts)],
    ['values dropped by the checks', String(r.evidenceRejections)],
    ['whole suite, seconds', (report.timings.totalMs / 1000).toFixed(0)],
  ];
  return renderTable(columns, rows);
}

function renderHeader(report: Report): string {
  const rows = Object.entries(report.extractor.detail).map(([key, value]) => [
    key,
    value === null ? 'null' : String(value),
  ]);
  const columns: Column[] = [{ header: 'setting' }, { header: 'value' }];
  return [
    `extractor: ${report.extractor.name}  (${report.extractor.kind})`,
    '',
    renderTable(columns, rows),
  ].join('\n');
}

function renderPerCase(cases: readonly CaseScore[]): string {
  const columns: Column[] = [
    { header: 'case' },
    { header: 'class' },
    { header: 'ok', align: 'right' },
    { header: 'abst', align: 'right' },
    { header: 'wrong', align: 'right' },
    { header: 'refused', align: 'right' },
    { header: 'INVENTED', align: 'right' },
    { header: 'silent' },
    { header: 'gate' },
  ];

  const rows = cases.map((score) => {
    const counted = tally(score);
    return [
      score.caseId,
      score.caseClass,
      String(counted.correct),
      String(counted.correct_abstention + counted.unflagged_abstention),
      String(counted.wrong_value),
      String(counted.wrong_abstention),
      String(counted.confident_nonsense),
      score.silentError ? 'YES' : '.',
      score.gateViolation ? 'FAIL' : '.',
    ];
  });

  return renderTable(columns, rows);
}

function tally(score: CaseScore): OutcomeCounts {
  const counts = zeroCounts();
  for (const field of score.fields) {
    if (!field.mandatory) continue;
    counts[field.outcome] += 1;
  }
  return counts;
}

function renderOutcomes(summary: Summary): string {
  const columns: Column[] = [
    { header: 'outcome' },
    { header: 'fields', align: 'right' },
    { header: 'share', align: 'right' },
    { header: 'meaning' },
  ];
  const meanings: Record<string, string> = {
    correct: 'value matched',
    correct_abstention: 'null, and a question was asked',
    unflagged_abstention: 'null, but nobody was asked',
    wrong_abstention: 'refused a value we did have',
    wrong_value: 'produced a different value',
    confident_nonsense: 'invented a value nobody stated',
  };
  const total = summary.mandatoryFieldCount;
  const rows = OUTCOMES.map((outcome) => [
    outcome,
    String(summary.counts[outcome]),
    total === 0 ? '0.0%' : percent(summary.counts[outcome] / total),
    meanings[outcome] ?? '',
  ]);
  return renderTable(columns, rows);
}

function renderByClass(byClass: Record<string, Summary>): string {
  const columns: Column[] = [
    { header: 'class' },
    { header: 'cases', align: 'right' },
    { header: 'accuracy', align: 'right' },
    { header: 'abstention', align: 'right' },
    { header: 'over-refusal', align: 'right' },
    { header: 'invented', align: 'right' },
    { header: 'silent err', align: 'right' },
    { header: 'silent money', align: 'right' },
  ];
  const rows = Object.entries(byClass).map(([name, summary]) => [
    name,
    String(summary.caseCount),
    percent(summary.accuracy),
    percent(summary.abstentionRate),
    percent(summary.overRefusalRate),
    String(summary.confidentNonsense),
    percent(summary.silentErrorRate),
    percent(summary.silentCriticalRate),
  ]);
  return renderTable(columns, rows);
}

function renderHeadline(summary: Summary, timings: Report['timings']): string {
  const gate = summary.gatePassed
    ? 'PASS  no invented value on a money-critical field'
    : `FAIL  ${summary.gateViolations} case(s) invented a money-critical value`;

  const columns: Column[] = [{ header: 'metric' }, { header: 'value', align: 'right' }];
  const rows: string[][] = [
    ['cases', String(summary.caseCount)],
    ['mandatory fields scored', String(summary.mandatoryFieldCount)],
    ['field accuracy', percent(summary.accuracy)],
    ['correct abstention', percent(summary.abstentionRate)],
    ['over-refusal', percent(summary.overRefusalRate)],
    ['confident nonsense, mandatory', String(summary.confidentNonsense)],
    ['confident nonsense, all fields', String(summary.confidentNonsenseAll)],
    ['silent error rate, any field', percent(summary.silentErrorRate)],
    ['SILENT ERROR RATE, MONEY FIELDS', percent(summary.silentCriticalRate)],
    ['extractor failures', String(summary.failures)],
    ['p50 latency ms', String(Math.round(timings.p50Ms))],
    ['p95 latency ms', String(Math.round(timings.p95Ms))],
  ];

  return [renderTable(columns, rows), '', `RELEASE GATE: ${gate}`].join('\n');
}
