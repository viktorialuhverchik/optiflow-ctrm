/**
 * End-to-end guard on the harness itself, run against the two baselines and the
 * real case directory. It is the regression test for the thing that measures
 * everything else, so it asserts the properties the baselines exist to prove
 * rather than any specific score.
 */
import { describe, expect, it } from 'vitest';
import { isIsoDate } from '../domain/brands.js';
import { MONEY_CRITICAL_FIELDS } from '../domain/schema.js';
import { CASE_CLASSES } from './case.js';
import { loadCases } from '../io/case-files.js';
import { loadReferenceData } from '../io/reference-files.js';
import type { Extractor } from '../extract/types.js';
import { createNullExtractor } from './extractors/null-extractor.js';
import { createRegexExtractor } from './extractors/regex-extractor.js';
import { runEval } from './runner.js';

const cases = loadCases('data/eval-cases');
const referenceData = loadReferenceData('data');

describe('the committed case set', () => {
  it('loads and validates every case', () => {
    expect(cases.length).toBeGreaterThanOrEqual(3);
    for (const evalCase of cases) {
      expect(evalCase.text.trim().length).toBeGreaterThan(0);
      expect(evalCase.expected.size).toBeGreaterThan(0);
    }
  });

  it('contains at least one case whose expected answer is a refusal', () => {
    const hasNullExpectation = cases.some((c) =>
      [...c.expected.values()].some((value) => value === null),
    );
    expect(hasNullExpectation).toBe(true);
  });

  it('covers every case class', () => {
    const covered = new Set(cases.map((c) => c.meta.class));
    for (const name of CASE_CLASSES) expect(covered).toContain(name);
  });

  it('expects only codes that exist in the reference data', () => {
    // A typo in an expected product or quote code would make a case permanently
    // unpassable and look like a model failure for the rest of the project.
    for (const evalCase of cases) {
      const product = evalCase.expected.get('product.product_code');
      if (product !== null && product !== undefined) {
        expect(referenceData.productCodes, evalCase.meta.id).toContain(product);
      }
      const quote = evalCase.expected.get('pricing.quote_code');
      if (quote !== null && quote !== undefined) {
        expect(referenceData.quoteCodes, evalCase.meta.id).toContain(quote);
      }
    }
  });

  it('expects only real calendar dates', () => {
    for (const evalCase of cases) {
      for (const path of ['recap_date', 'delivery_window.from', 'delivery_window.to']) {
        const value = evalCase.expected.get(path);
        if (typeof value === 'string') {
          expect(isIsoDate(value), `${evalCase.meta.id} ${path}`).toBe(true);
        }
      }
      const from = evalCase.expected.get('delivery_window.from');
      const to = evalCase.expected.get('delivery_window.to');
      if (typeof from === 'string' && typeof to === 'string') {
        expect(from <= to, `${evalCase.meta.id} laycan runs backwards`).toBe(true);
      }
    }
  });

  it('has a must-abstain expectation for every field the release gate protects', () => {
    // If no case in the set expects null on a money-critical field, the gate can
    // never fail and it is decoration rather than a check.
    for (const path of MONEY_CRITICAL_FIELDS) {
      const covered = cases.some((c) => c.expected.get(path) === null);
      expect(covered, `no case expects a refusal on ${path}`).toBe(true);
    }
  });
});

describe('the null baseline', () => {
  it('abstains perfectly, scores nothing, and never trips the gate', async () => {
    // If any of these stopped holding, the metric would be gameable by refusing
    // to answer, and every number in the report would be worthless.
    const report = await runEval(cases, createNullExtractor());
    const { summary } = report.scores;
    expect(summary.abstentionRate).toBe(1);
    expect(summary.accuracy).toBe(0);
    expect(summary.confidentNonsense).toBe(0);
    expect(summary.silentErrorRate).toBe(0);
    expect(summary.gatePassed).toBe(true);
  });
});

describe('the regex baseline', () => {
  it('is more accurate than refusing everything', async () => {
    const report = await runEval(cases, createRegexExtractor(referenceData));
    expect(report.scores.summary.accuracy).toBeGreaterThan(0);
  });

  it('is unsafe in exactly the way the gate is meant to catch', async () => {
    // It reads "about 5,000 mt each" out of "2-3 cargoes" and reports a firm
    // quantity. Useful-and-unsafe, against the null baseline's safe-and-useless.
    const report = await runEval(cases, createRegexExtractor(referenceData));
    expect(report.scores.summary.confidentNonsense).toBeGreaterThan(0);
    expect(report.scores.summary.gatePassed).toBe(false);
  });
});

describe('the runner', () => {
  it('produces byte-identical scores on repeated runs', async () => {
    const a = await runEval(cases, createNullExtractor());
    const b = await runEval(cases, createNullExtractor());
    // Timings are excluded on purpose: they are never reproducible, which is
    // why the report separates them from the scores block (D3).
    expect(JSON.stringify(a.scores)).toBe(JSON.stringify(b.scores));
  });

  it('scores a crashing extractor as a failure instead of stopping the suite', async () => {
    const broken: Extractor = {
      config: { name: 'broken', kind: 'baseline', detail: {} },
      extract: () => Promise.reject(new Error('model unavailable')),
    };
    const report = await runEval(cases, broken);
    expect(report.scores.summary.failures).toBe(cases.length);
    expect(report.scores.cases[0]?.failure).toBe('model unavailable');
  });
});
