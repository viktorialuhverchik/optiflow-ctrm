#!/usr/bin/env node
/**
 * `pnpm mcp:demo` — the local model answering one question with both tools:
 * "what is the provisional value of the deal in recap_02.txt?"
 *
 * Two things are being demonstrated and they are separate.
 *
 * **Can the model drive the tools?** That is what the agent loop measures, over
 * repeated runs, in two modes: the chat template's native function calling, and
 * a grammar-constrained action choice. The success rate for each is printed.
 *
 * **Is the answer right?** That is not the model's job. The model chooses which
 * tool to call and with what arguments. Every number is produced by
 * `computeProvisionalValue` in the domain layer. A model that can drive tools
 * reliably and cannot multiply is exactly what this architecture assumes.
 *
 * The MCP client and server are linked by an in-memory transport rather than a
 * pipe. It is the same `McpServer`, the same registered tools and the same
 * JSON-RPC message flow as `pnpm mcp`, in one process so the agent and the
 * extractor share a single five-gigabyte model rather than loading two on a
 * sixteen-gigabyte machine. `pnpm mcp:smoke` exercises the same server over a
 * real stdio pipe.
 */
import { defineChatSessionFunction } from 'node-llama-cpp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Decimal from 'decimal.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { isoDate, type IsoDate } from '../domain/brands.js';
import { resolveFx } from '../domain/fx.js';
import { STATISTICS } from '../domain/pricing.js';
import { computeProvisionalValue } from '../domain/valuation.js';
import { createModelExtractor } from '../extract/extractor.js';
import { renderTable } from '../eval/table.js';
import { findModel } from '../llm/manifest.js';
import { NodeLlamaProvider } from '../llm/node-llama.js';
import { loadManifest, requireModelFile } from '../io/model-files.js';
import { loadReferenceData } from '../io/reference-files.js';
import { registerTools } from './tools.js';
import type { Extractor } from '../extract/types.js';
import type { ReferenceData } from '../domain/references.js';

const DOCUMENT = 'data/recap_02.txt';
const REFERENCE_DATE = '2026-08-20';
const QUESTION = 'What is the provisional value of the deal in recap_02.txt?';

function log(event: string, detail: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ event, ...detail })}\n`);
}

// --------------------------------------------------------------------------
// The agent's view of the tools
// --------------------------------------------------------------------------

type Action =
  | { tool: 'parse_recap'; document: string }
  | { tool: 'get_price_quote'; quote_code: string; date_or_period: string; statistic: string; bl_date?: string }
  | { tool: 'done' };

function actionSchema(quoteCodes: readonly string[]): unknown {
  return {
    oneOf: [
      {
        type: 'object',
        properties: { tool: { const: 'parse_recap' }, document: { enum: [DOCUMENT] } },
        required: ['tool', 'document'],
      },
      {
        type: 'object',
        properties: {
          tool: { const: 'get_price_quote' },
          quote_code: { enum: [...quoteCodes] },
          date_or_period: { type: 'string' },
          statistic: { enum: [...STATISTICS] },
          bl_date: { type: 'string' },
        },
        required: ['tool', 'quote_code', 'date_or_period', 'statistic'],
      },
      {
        type: 'object',
        properties: { tool: { const: 'done' } },
        required: ['tool'],
      },
    ],
  };
}

const AGENT_SYSTEM = `
You are answering one question about an oil cargo by calling tools. You do not do
arithmetic and you do not guess: the tools hold all the data and a calculator
runs afterwards.

Tools:

parse_recap(document)
  Reads a recap message and returns the deal terms, plus the questions that are
  still open. Call this first. Everything you need to price the cargo is in what
  it returns: the quotation code, the statistic, the pricing period, the
  differential, the quantity, the currency and the laycan.

get_price_quote(quote_code, date_or_period, statistic, bl_date)
  Averages a published quotation. Use the quote_code and statistic exactly as
  parse_recap reported them. For a B/L-relative period such as "B/L -1 / +3" you
  must also pass bl_date, because there is no default. No bill of lading has been
  issued for this cargo, so use the first day of the laycan as the estimate.

done
  Say this once you have both the parsed deal and the quotation average.

Emit one tool call at a time and nothing else.
`.trim();

// --------------------------------------------------------------------------
// Scoring one run
// --------------------------------------------------------------------------

type Mode = 'grammar' | 'native';

type RunOutcome = {
  readonly mode: Mode;
  readonly steps: number;
  readonly calledParse: boolean;
  readonly calledQuote: boolean;
  /** Did the agent pass on what parse_recap told it? This is the tool-driving skill. */
  readonly usedParsedQuoteCode: boolean;
  readonly usedParsedStatistic: boolean;
  /** Did that happen to match the committed ground truth? This is the extractor's skill. */
  readonly quoteCodeMatchesTruth: boolean;
  readonly statisticMatchesTruth: boolean;
  readonly blDateSupplied: boolean;
  readonly toolErrors: number;
  readonly completed: boolean;
  readonly ms: number;
  readonly transcript: readonly string[];
};

/**
 * Committed ground truth for this recap, read from the eval case rather than
 * repeated here, so the demo and the eval cannot disagree about the answer.
 */
function groundTruth(): { quoteCode: string; statistic: string } {
  const expected = JSON.parse(
    readFileSync('data/eval-cases/02-naphtha-cfr-rotterdam-thread/expected.json', 'utf8'),
  ) as { fields: Record<string, string> };
  return {
    quoteCode: expected.fields['pricing.quote_code'] ?? '',
    statistic: expected.fields['pricing.statistic'] ?? '',
  };
}

// --------------------------------------------------------------------------

type Host = {
  readonly client: Client;
  readonly referenceData: ReferenceData;
  readonly provider: NodeLlamaProvider;
};

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args }, undefined, {
    timeout: 600_000,
  })) as { content?: Array<{ text?: string }>; isError?: boolean };
  return {
    text: (result.content ?? []).map((part) => part.text ?? '').join('\n'),
    isError: result.isError === true,
  };
}

/**
 * Native function calling, through the model's own chat template.
 *
 * This is what an off-the-shelf MCP client gets. It is measured against the
 * grammar-constrained path because the brief asks whether tool calling is
 * reliable on this model, and the honest answer needs both numbers.
 */
async function runNativeAgent(host: Host, maxSteps = 4): Promise<RunOutcome> {
  const started = performance.now();
  const transcript: string[] = [];
  const truth = groundTruth();

  let calledParse = false;
  let calledQuote = false;
  let usedParsedQuoteCode = false;
  let usedParsedStatistic = false;
  let quoteCodeMatchesTruth = false;
  let statisticMatchesTruth = false;
  let blDateSupplied = false;
  let toolErrors = 0;
  let parsedQuoteCode: string | null = null;
  let parsedStatistic: string | null = null;

  const functions = {
    parse_recap: defineChatSessionFunction({
      description: 'Read a recap message and return the deal terms and the open questions.',
      params: {
        type: 'object',
        properties: { document: { type: 'string' } },
      } as const,
      handler: async (params: { document?: string }) => {
        calledParse = true;
        transcript.push(`parse_recap(${JSON.stringify(params)})`);
        const call = await callTool(host.client, 'parse_recap', {
          text: readFileSync(params.document ?? DOCUMENT, 'utf8'),
          reference_date: REFERENCE_DATE,
        });
        if (call.isError) {
          toolErrors += 1;
          return call.text;
        }
        const body = JSON.parse(call.text) as { deal: unknown };
        parsedQuoteCode = fieldValue(body.deal, 'pricing.quote_code');
        parsedStatistic = fieldValue(body.deal, 'pricing.statistic');
        return summariseDeal(body.deal);
      },
    }),
    get_price_quote: defineChatSessionFunction({
      description:
        'Average a published quotation over a date, a range, or a B/L-relative period. ' +
        'A B/L-relative period requires bl_date.',
      params: {
        type: 'object',
        properties: {
          quote_code: { type: 'string' },
          date_or_period: { type: 'string' },
          statistic: { type: 'string' },
          bl_date: { type: 'string' },
        },
      } as const,
      handler: async (params: {
        quote_code?: string;
        date_or_period?: string;
        statistic?: string;
        bl_date?: string;
      }) => {
        calledQuote = true;
        transcript.push(`get_price_quote(${JSON.stringify(params)})`);
        usedParsedQuoteCode ||= params.quote_code === parsedQuoteCode;
        usedParsedStatistic ||= params.statistic === parsedStatistic;
        quoteCodeMatchesTruth ||= params.quote_code === truth.quoteCode;
        statisticMatchesTruth ||= params.statistic === truth.statistic;
        blDateSupplied ||= params.bl_date !== undefined;
        const args: Record<string, unknown> = {
          quote_code: params.quote_code ?? '',
          date_or_period: params.date_or_period ?? '',
          statistic: params.statistic ?? '',
        };
        if (params.bl_date !== undefined) args['bl_date'] = params.bl_date;
        const call = await callTool(host.client, 'get_price_quote', args);
        if (call.isError) toolErrors += 1;
        return call.text;
      },
    }),
  };

  let text = '';
  try {
    const result = await host.provider.completeWithFunctions(
      AGENT_SYSTEM,
      `${QUESTION}\n\nThe document is ${DOCUMENT}.`,
      functions,
      900,
    );
    text = result.text;
  } catch (error) {
    transcript.push(`native call threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  transcript.push(`final text: ${text.slice(0, 200)}`);

  return {
    mode: 'native',
    steps: maxSteps,
    calledParse,
    calledQuote,
    usedParsedQuoteCode,
    usedParsedStatistic,
    quoteCodeMatchesTruth,
    statisticMatchesTruth,
    blDateSupplied,
    toolErrors,
    completed: calledParse && calledQuote,
    ms: performance.now() - started,
    transcript,
  };
}

async function runAgent(host: Host, mode: 'grammar', maxSteps = 6): Promise<RunOutcome> {
  const started = performance.now();
  const transcript: string[] = [];
  const schema = actionSchema(host.referenceData.quoteCodes);

  const truth = groundTruth();
  let calledParse = false;
  let calledQuote = false;
  let usedParsedQuoteCode = false;
  let usedParsedStatistic = false;
  let quoteCodeMatchesTruth = false;
  let statisticMatchesTruth = false;
  let blDateSupplied = false;
  let parsedQuoteCode: string | null = null;
  let parsedStatistic: string | null = null;
  let toolErrors = 0;
  let completed = false;
  let observations = '';
  let steps = 0;

  for (; steps < maxSteps; steps += 1) {
    const result = await host.provider.complete({
      system: AGENT_SYSTEM,
      user: `${QUESTION}\n\nThe document is ${DOCUMENT}.\n${observations}\n\nWhat is your next tool call?`,
      maxTokens: 200,
      grammar: { kind: 'json_schema', schema },
    });

    let action: Action;
    try {
      action = JSON.parse(result.text) as Action;
    } catch {
      transcript.push(`step ${steps + 1}: unparseable action, ${result.text.slice(0, 80)}`);
      break;
    }
    transcript.push(`step ${steps + 1} -> ${JSON.stringify(action)}`);

    if (action.tool === 'done') {
      completed = calledParse && calledQuote;
      break;
    }

    if (action.tool === 'parse_recap') {
      calledParse = true;
      const call = await callTool(host.client, 'parse_recap', {
        text: readFileSync(action.document, 'utf8'),
        reference_date: REFERENCE_DATE,
      });
      if (call.isError) toolErrors += 1;
      const deal = JSON.parse(call.text) as { deal: unknown; open_questions: number };
      parsedQuoteCode = fieldValue(deal.deal, 'pricing.quote_code');
      parsedStatistic = fieldValue(deal.deal, 'pricing.statistic');
      observations += `\n\nparse_recap returned:\n${summariseDeal(deal.deal)}`;
      transcript.push(`  parse_recap -> ${deal.open_questions} open question(s)`);
      continue;
    }

    calledQuote = true;
    usedParsedQuoteCode ||= action.quote_code === parsedQuoteCode;
    usedParsedStatistic ||= action.statistic === parsedStatistic;
    quoteCodeMatchesTruth ||= action.quote_code === truth.quoteCode;
    statisticMatchesTruth ||= action.statistic === truth.statistic;
    blDateSupplied ||= action.bl_date !== undefined;

    const args: Record<string, unknown> = {
      quote_code: action.quote_code,
      date_or_period: action.date_or_period,
      statistic: action.statistic,
    };
    if (action.bl_date !== undefined) args['bl_date'] = action.bl_date;
    const call = await callTool(host.client, 'get_price_quote', args);
    if (call.isError) {
      toolErrors += 1;
      observations += `\n\nget_price_quote failed: ${call.text}`;
      transcript.push(`  get_price_quote -> error: ${call.text.slice(0, 80)}`);
      continue;
    }
    observations += `\n\nget_price_quote returned:\n${call.text}`;
    transcript.push(`  get_price_quote -> ok`);
  }

  return {
    mode,
    steps,
    calledParse,
    calledQuote,
    usedParsedQuoteCode,
    usedParsedStatistic,
    quoteCodeMatchesTruth,
    statisticMatchesTruth,
    blDateSupplied,
    toolErrors,
    completed,
    ms: performance.now() - started,
    transcript,
  };
}

function fieldValue(deal: unknown, path: string): string | null {
  const node = path.split('.').reduce<unknown>((acc, key) => {
    if (typeof acc !== 'object' || acc === null) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, deal);
  if (typeof node !== 'object' || node === null) return null;
  const value = (node as { value?: unknown }).value;
  return typeof value === 'string' ? value : null;
}

/** The agent sees the fields it needs, not four kilobytes of envelope. */
function summariseDeal(deal: unknown): string {
  const get = (path: string): string => fieldValue(deal, path) ?? 'null';
  return [
    `  quote_code: ${get('pricing.quote_code')}`,
    `  statistic: ${get('pricing.statistic')}`,
    `  pricing period: ${get('pricing.period')}`,
    `  differential: ${get('pricing.differential.value')} ${get('pricing.differential.unit')}`,
    `  quantity: ${get('quantity.value')} ${get('quantity.unit')}`,
    `  product: ${get('product.product_code')}`,
    `  currency: ${get('currency')}, fx rate ${get('fx.rate')}`,
    `  laycan: ${get('delivery_window.from')} to ${get('delivery_window.to')}`,
  ].join('\n');
}

// --------------------------------------------------------------------------

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      runs: { type: 'string', default: '5' },
      mode: { type: 'string', default: 'both' },
      transcript: { type: 'string', default: 'reports/mcp-demo-transcript.md' },
    },
  });
  const runs = Number(values.runs);

  const referenceData = loadReferenceData('data');
  const entry = findModel(loadManifest(), 'qwen3-8b-q4km');
  log('model_loading', { model: entry.id });
  const provider = await NodeLlamaProvider.create({ entry, modelPath: requireModelFile(entry) });

  // One extractor, memoised. The tool host caches, the agent does not: every
  // run still has to decide to call parse_recap, it just does not pay forty
  // seconds for the same answer five times.
  const extractor: Extractor = createModelExtractor({ provider, referenceData });
  const cache = new Map<string, Awaited<ReturnType<Extractor['extract']>>>();
  const memoised: Extractor = {
    config: extractor.config,
    async extract(request) {
      const key = `${request.referenceDate}|${request.text.length}`;
      const hit = cache.get(key);
      if (hit !== undefined) {
        log('parse_recap_cached', {});
        return hit;
      }
      const output = await extractor.extract(request);
      cache.set(key, output);
      return output;
    },
  };

  const server = new McpServer({ name: 'optiflow-ctrm', version: '0.1.0' });
  registerTools(server, {
    referenceData,
    getExtractor: async () => memoised,
    log,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'optiflow-demo', version: '0.1.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const host: Host = { client, referenceData, provider };
    const mode = values.mode ?? 'both';
    const outcomes: RunOutcome[] = [];

    if (mode === 'native' || mode === 'both') {
      // Warm the parse cache before the native runs.
      //
      // Native function calling executes handlers during generation, and
      // parse_recap needs the same single-sequence model. Without this the
      // provider throws on re-entry, which is correct behaviour and makes the
      // run untestable. Warming it first measures what is actually in question:
      // whether the model picks the right tools with the right arguments.
      log('warming_parse_cache', {});
      await callTool(client, 'parse_recap', {
        text: readFileSync(DOCUMENT, 'utf8'),
        reference_date: REFERENCE_DATE,
      });
    }

    if (mode === 'native' || mode === 'both') {
      for (let run = 0; run < runs; run += 1) {
        log('agent_run', { mode: 'native', run: run + 1, of: runs });
        outcomes.push(await runNativeAgent(host));
      }
    }
    if (mode === 'grammar' || mode === 'both') {
      for (let run = 0; run < runs; run += 1) {
        log('agent_run', { mode: 'grammar', run: run + 1, of: runs });
        outcomes.push(await runAgent(host, 'grammar'));
      }
    }

    const reference = await referenceAnswer(host);
    writeTranscript(values.transcript ?? 'reports/mcp-demo-transcript.md', outcomes, reference);
    printReport(outcomes, reference);
    return 0;
  } finally {
    await client.close();
    await provider.dispose();
  }
}

// --------------------------------------------------------------------------
// The answer, computed rather than generated
// --------------------------------------------------------------------------

type Reference = {
  readonly lines: readonly string[];
};

async function referenceAnswer(host: Host): Promise<Reference> {
  const parsed = await callTool(host.client, 'parse_recap', {
    text: readFileSync(DOCUMENT, 'utf8'),
    reference_date: REFERENCE_DATE,
  });
  const body = JSON.parse(parsed.text) as { deal: Record<string, never>; open_questions: number };
  const field = (path: string): string | null => {
    const node = path.split('.').reduce<unknown>((acc, key) => {
      if (typeof acc !== 'object' || acc === null) return undefined;
      return (acc as Record<string, unknown>)[key];
    }, body.deal);
    if (typeof node !== 'object' || node === null) return null;
    const value = (node as { value?: unknown }).value;
    return typeof value === 'string' ? value : null;
  };

  const laycanFrom = field('delivery_window.from');
  const quoteCode = field('pricing.quote_code');
  const statistic = field('pricing.statistic');
  const period = field('pricing.period');
  const differential = field('pricing.differential.value');
  const differentialUnit = field('pricing.differential.unit');
  const quantity = field('quantity.value');
  const quantityUnit = field('quantity.unit');
  const currency = field('currency');
  const fxRate = field('fx.rate');
  const productCodeValue = field('product.product_code');

  const missing = Object.entries({
    laycanFrom, quoteCode, statistic, period, differential, differentialUnit,
    quantity, quantityUnit, currency,
  })
    .filter(([, value]) => value === null)
    .map(([name]) => name);

  if (missing.length > 0) {
    return {
      lines: [
        'The deal cannot be priced from what the recap states.',
        `Missing: ${missing.join(', ')}.`,
        'That is the correct answer, not a failure. Ask the trader.',
      ],
    };
  }

  const blEstimate: IsoDate = isoDate(laycanFrom as string);
  const quote = await callTool(host.client, 'get_price_quote', {
    quote_code: quoteCode as string,
    date_or_period: period as string,
    statistic: statistic as string,
    bl_date: blEstimate,
  });
  if (quote.isError) {
    return { lines: ['The quotation window could not be resolved:', quote.text] };
  }
  const quoteBody = JSON.parse(quote.text) as {
    value: string;
    unit: 'USD/MT' | 'USD/BBL';
    window: { from: string; to: string };
    non_publication_days: number;
    quotations_used: unknown[];
  };

  const fx = resolveFx(
    currency as string,
    fxRate === null ? null : `${fxRate} USD per ${currency}`,
  );
  if (!fx.ok) return { lines: ['No FX rate:', fx.error.message] };

  const product =
    productCodeValue === null ? null : (host.referenceData.products.get(productCodeValue) ?? null);

  const value = computeProvisionalValue({
    quoteAverage: new Decimal(quoteBody.value),
    quoteUnit: quoteBody.unit,
    differential: new Decimal(differential as string),
    differentialUnit: differentialUnit as 'USD/MT' | 'USD/BBL',
    quantity: new Decimal(quantity as string),
    quantityUnit: quantityUnit as 'MT' | 'BBL',
    product,
    fx: fx.value,
    window: { from: isoDate(quoteBody.window.from), to: isoDate(quoteBody.window.to) },
    quotesUsed: [],
    blDateEstimatedFrom: blEstimate,
    nonPublicationDays: quoteBody.non_publication_days,
    publishedDays: quoteBody.quotations_used.length,
  });
  if (!value.ok) return { lines: ['Could not compute a value:', value.error.message] };

  // What the same pipeline would produce if the one field the extractor gets
  // wrong on this recap were right. The gap is the money at stake in a single
  // mis-read pricing basis, which is the whole argument for the eval harness.
  const truth = groundTruth();
  let counterfactual: string[] = [];
  if (statistic !== truth.statistic) {
    const truthQuote = await callTool(host.client, 'get_price_quote', {
      quote_code: quoteCode as string,
      date_or_period: period as string,
      statistic: truth.statistic,
      bl_date: blEstimate,
    });
    if (!truthQuote.isError) {
      const truthBody = JSON.parse(truthQuote.text) as { value: string };
      const truthValue = computeProvisionalValue({
        quoteAverage: new Decimal(truthBody.value),
        quoteUnit: quoteBody.unit,
        differential: new Decimal(differential as string),
        differentialUnit: differentialUnit as 'USD/MT' | 'USD/BBL',
        quantity: new Decimal(quantity as string),
        quantityUnit: quantityUnit as 'MT' | 'BBL',
        product,
        fx: fx.value,
        window: { from: isoDate(quoteBody.window.from), to: isoDate(quoteBody.window.to) },
        quotesUsed: [],
        blDateEstimatedFrom: blEstimate,
        nonPublicationDays: quoteBody.non_publication_days,
        publishedDays: quoteBody.quotations_used.length,
      });
      if (truthValue.ok) {
        const gap = truthValue.value.valueUsd.minus(value.value.valueUsd);
        counterfactual = [
          '',
          `The extractor read the pricing basis as "${statistic}". The recap says`,
          `"${truth.statistic}". Priced the other way the same cargo is`,
          `USD ${truthValue.value.valueUsd.toDecimalPlaces(2).toString()}, a difference of`,
          `USD ${gap.toDecimalPlaces(2).toString()} on one field nobody would notice.`,
          'The eval scores that field as wrong. Nothing else in this pipeline would.',
        ];
      }
    }
  }

  const v = value.value;
  return {
    lines: [
      renderTable(
        [{ header: 'component' }, { header: 'value', align: 'right' }],
        [
          ['quotation', `${quoteCode} ${statistic}`],
          ['pricing window', `${v.window.from}..${v.window.to}`],
          ['quotation average', `${v.quoteAverage.toDecimalPlaces(4).toString()} ${v.unitPriceUnit}`],
          ['differential', `${differential} ${differentialUnit}`],
          ['unit price', `${v.unitPrice.toDecimalPlaces(4).toString()} ${v.unitPriceUnit}`],
          ['quantity as agreed', `${quantity} ${quantityUnit}`],
          ['quantity as priced', `${v.pricedQuantity.toDecimalPlaces(2).toString()} ${v.pricedQuantityUnit}`],
          ['provisional value, USD', v.valueUsd.toDecimalPlaces(2).toString()],
          [`provisional value, ${v.dealCurrency}`, v.valueInDealCurrency.toDecimalPlaces(2).toString()],
        ],
      ),
      '',
      'Assumptions, all of which belong on the invoice:',
      ...v.assumptions.map((a) => `  - ${a.detail}`),
      ...counterfactual,
    ],
  };
}

function printReport(outcomes: readonly RunOutcome[], reference: Reference): void {
  process.stdout.write(`QUESTION: ${QUESTION}\n\n`);
  process.stdout.write(`${reference.lines.join('\n')}\n\n`);

  const modes = [...new Set(outcomes.map((o) => o.mode))];
  const forMode = (mode: Mode): RunOutcome[] => outcomes.filter((o) => o.mode === mode);
  const rateIn = (mode: Mode, predicate: (o: RunOutcome) => boolean): string => {
    const subset = forMode(mode);
    return subset.length === 0 ? '-' : `${subset.filter(predicate).length}/${subset.length}`;
  };
  const row = (label: string, predicate: (o: RunOutcome) => boolean): string[] => [
    label,
    ...modes.map((mode) => rateIn(mode, predicate)),
  ];

  process.stdout.write('TOOL-CALLING RELIABILITY\n\n');
  process.stdout.write(
    `${renderTable(
      [
        { header: 'behaviour' },
        ...modes.map((mode) => ({ header: mode, align: 'right' as const })),
      ],
      [
        row('called parse_recap', (o) => o.calledParse),
        row('called get_price_quote', (o) => o.calledQuote),
        row('passed on the quotation code it was given', (o) => o.usedParsedQuoteCode),
        row('passed on the statistic it was given', (o) => o.usedParsedStatistic),
        row('supplied a B/L date estimate', (o) => o.blDateSupplied),
        row('finished without a tool error', (o) => o.toolErrors === 0),
        row('completed both calls and stopped', (o) => o.completed),
        row('quotation code matched ground truth', (o) => o.quoteCodeMatchesTruth),
        row('statistic matched ground truth', (o) => o.statisticMatchesTruth),
      ],
    )}\n\n`,
  );
  for (const mode of modes) {
    const subset = forMode(mode);
    const mean = subset.reduce((acc, o) => acc + o.ms, 0) / subset.length / 1000;
    process.stdout.write(`${mode}: ${subset.length} runs, mean ${mean.toFixed(1)}s per run\n`);
  }
}

function writeTranscript(path: string, outcomes: readonly RunOutcome[], reference: Reference): void {
  mkdirSync('reports', { recursive: true });
  const lines = [
    '# MCP demo transcript',
    '',
    `Question: **${QUESTION}**`,
    '',
    'Generated by `pnpm mcp:demo`. The model chooses the tool calls; every number',
    'below is computed by `src/domain/valuation.ts`, not generated.',
    '',
    '## Answer',
    '',
    '```',
    ...reference.lines,
    '```',
    '',
    '## Runs',
    '',
    ...outcomes.flatMap((outcome, index) => [
      `### Run ${index + 1} (${outcome.mode})`,
      '',
      '```',
      ...outcome.transcript,
      `completed: ${outcome.completed}, tool errors: ${outcome.toolErrors}, steps: ${outcome.steps}`,
      '```',
      '',
    ]),
  ];
  writeFileSync(path, `${lines.join('\n')}\n`);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    log('error', { message: error instanceof Error ? error.stack : String(error) });
    process.exitCode = 2;
  });
