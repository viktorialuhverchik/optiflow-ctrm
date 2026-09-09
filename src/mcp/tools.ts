/**
 * The two MCP tools, registered on any server instance.
 *
 * Shared so the stdio server and the phase 9 demo run identical code. A rule
 * that only held on one of those paths would be a rule nobody tests
 * (code-style §1).
 *
 * The extractor is supplied as a factory rather than an instance so a host can
 * load the model lazily. `get_price_quote` never touches it: pricing is
 * arithmetic over published data and a model has no business in it.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { parseIsoDate } from '../domain/brands.js';
import { STATISTICS } from '../domain/pricing.js';
import { lookupQuote } from '../domain/quote-lookup.js';
import type { ReferenceData } from '../domain/references.js';
import type { Extractor } from '../extract/types.js';

export type ToolHost = {
  readonly referenceData: ReferenceData;
  /** Called on the first parse_recap. May load a model. */
  readonly getExtractor: () => Promise<Extractor>;
  readonly log: (event: string, detail?: Record<string, unknown>) => void;
};

type TextResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };

function json(value: unknown): TextResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function toolError(message: string): TextResult {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

export function registerTools(server: McpServer, host: ToolHost): void {
  server.registerTool(
    'parse_recap',
    {
      title: 'Parse a trade recap',
      description:
        'Extract one deal object from a free-text recap. Returns the deal and the questions that ' +
        'must go back to the trader. A field the message does not state comes back null with a ' +
        'question, never a guess. Reading the questions is not optional: a deal with open ' +
        'questions is not ready to price or to contract.',
      inputSchema: {
        text: z
          .string()
          .min(1)
          .describe('The recap, exactly as it arrived. A whole email thread is fine.'),
        reference_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe(
            'The date to read the message as of, YYYY-MM-DD. Required: the extractor never reads ' +
              'the system clock, so a laycan written without a year has nothing to resolve against.',
          ),
      },
    },
    async ({ text, reference_date }) => {
      const started = performance.now();
      const extractor = await host.getExtractor();
      const output = await extractor.extract({
        caseId: 'mcp',
        text,
        referenceDate: reference_date,
      });
      host.log('parse_recap', {
        ms: Math.round(performance.now() - started),
        questions: output.questions.length,
        repairAttempts: output.diagnostics.repairAttempts,
      });

      return json({
        deal: output.deal,
        questions: output.questions,
        open_questions: output.questions.length,
        diagnostics: {
          repair_attempts: output.diagnostics.repairAttempts,
          dropped: output.diagnostics.evidenceRejections,
        },
      });
    },
  );

  server.registerTool(
    'get_price_quote',
    {
      title: 'Look up a published quotation',
      description:
        'Average a published Platts or Argus quotation over a date, a date range, or a ' +
        'B/L-relative pricing period. Reads data/price_quotes.csv. No model is involved, so the ' +
        'answer is exact and repeatable. Returns the individual quotations it used, so the ' +
        'number can be checked by hand.',
      inputSchema: {
        quote_code: z
          .enum(host.referenceData.quoteCodes as [string, ...string[]])
          .describe('The quotation series. Only these codes exist.'),
        date_or_period: z
          .string()
          .describe(
            'One of: a date "2026-09-14", a range "2026-09-11..2026-09-15", or a B/L-relative ' +
              'period "B/L +0/+3". A B/L-relative period needs bl_date.',
          ),
        statistic: z.enum(STATISTICS).describe('Which column to average.'),
        bl_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe(
            'The bill of lading date, required only for a B/L-relative period. There is no ' +
              'default: anchoring on today would price a window nobody asked for.',
          ),
      },
    },
    async ({ quote_code, date_or_period, statistic, bl_date }) => {
      const blDate = bl_date === undefined ? null : parseIsoDate(bl_date);
      if (blDate !== null && !blDate.ok) return toolError(blDate.error.message);

      const result = lookupQuote(
        host.referenceData,
        quote_code,
        date_or_period,
        statistic,
        blDate === null ? null : blDate.value,
      );
      if (!result.ok) {
        host.log('get_price_quote_failed', { code: result.error.code });
        return toolError(`${result.error.code}: ${result.error.message}`);
      }

      const found = result.value;
      host.log('get_price_quote', { quote: quote_code, days: found.quotesUsed.length });

      return json({
        quote_code: found.quoteCode,
        quote_name: found.quoteName,
        statistic: found.statistic,
        window: found.window,
        value: found.value.toDecimalPlaces(4).toString(),
        unit: found.unit,
        quotations_used: found.quotesUsed.map((quote) => ({
          date: quote.date,
          low: quote.low.toString(),
          high: quote.high.toString(),
          mean: quote.mean.toString(),
        })),
        non_publication_days: found.nonPublicationDays,
        outside_coverage: found.outsideCoverage,
      });
    },
  );
}
