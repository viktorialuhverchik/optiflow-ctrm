/**
 * Reference data: products.csv and price_quotes.csv.
 *
 * Pure. Takes file *contents*, not paths; the filesystem edge lives in
 * src/io/reference-files.ts (code-style §1, §7).
 *
 * Two things here matter beyond loading. First, conversion factors come from
 * the CSV and never from a constant in the code (B4). Second, the set of known
 * quote codes is exported so the decoding grammar can be restricted to exactly
 * those codes plus null, which removes invented quote codes as a failure mode
 * before the model ever emits one.
 */
import Decimal from 'decimal.js';
import { parseCsv, cell, optionalCell, type CsvRow } from './csv.js';
import { parseIsoDate, type IsoDate, type ProductCode, type QuoteCode } from './brands.js';
import { compareDates, type DateRange } from './dates.js';
import { fail, ok, type Result } from './result.js';

export const QUANTITY_UNITS = ['MT', 'BBL'] as const;
export type QuantityUnit = (typeof QUANTITY_UNITS)[number];

export const PRICE_UNITS = ['USD/MT', 'USD/BBL'] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];

export type ProductRow = {
  readonly code: ProductCode;
  readonly name: string;
  readonly typicalSpec: string | null;
  readonly defaultUnit: QuantityUnit;
  readonly bblPerMt: Decimal;
  readonly densityKgM3: Decimal;
};

export type QuoteRow = {
  readonly date: IsoDate;
  readonly publication: string;
  readonly code: QuoteCode;
  readonly name: string;
  readonly unit: PriceUnit;
  readonly low: Decimal;
  readonly high: Decimal;
  readonly mean: Decimal;
};

export type ReferenceData = {
  readonly products: ReadonlyMap<string, ProductRow>;
  readonly quotesByCode: ReadonlyMap<string, readonly QuoteRow[]>;
  /** Sorted, for a stable grammar and a stable report. */
  readonly productCodes: readonly string[];
  readonly quoteCodes: readonly string[];
};

function decimalCell(row: CsvRow, column: string, line: number): Result<Decimal> {
  const raw = cell(row, column, line);
  if (!raw.ok) return raw;
  try {
    return ok(new Decimal(raw.value));
  } catch {
    return fail('REFERENCE_DATA_INVALID', `"${column}" on row ${line} is not a number`, {
      column,
      line,
      value: raw.value,
    });
  }
}

export function parseProducts(csvText: string): Result<ProductRow[]> {
  const parsed = parseCsv(csvText);
  if (!parsed.ok) return parsed;

  const rows: ProductRow[] = [];
  for (const [index, row] of parsed.value.entries()) {
    const line = index + 2;
    const code = cell(row, 'product_code', line);
    const name = cell(row, 'product_name', line);
    const unit = cell(row, 'default_unit', line);
    const bblPerMt = decimalCell(row, 'bbl_per_mt', line);
    const density = decimalCell(row, 'density_kg_m3', line);
    if (!code.ok) return code;
    if (!name.ok) return name;
    if (!unit.ok) return unit;
    if (!bblPerMt.ok) return bblPerMt;
    if (!density.ok) return density;
    if (!isQuantityUnit(unit.value)) {
      return fail('REFERENCE_DATA_INVALID', `unknown default_unit "${unit.value}" on row ${line}`, {
        line,
        value: unit.value,
      });
    }
    if (bblPerMt.value.lte(0)) {
      return fail('REFERENCE_DATA_INVALID', `bbl_per_mt must be positive on row ${line}`, { line });
    }
    rows.push({
      code: code.value as ProductCode,
      name: name.value,
      typicalSpec: optionalCell(row, 'typical_spec'),
      defaultUnit: unit.value,
      bblPerMt: bblPerMt.value,
      densityKgM3: density.value,
    });
  }
  return ok(rows);
}

export function parseQuotes(csvText: string): Result<QuoteRow[]> {
  const parsed = parseCsv(csvText);
  if (!parsed.ok) return parsed;

  const rows: QuoteRow[] = [];
  for (const [index, row] of parsed.value.entries()) {
    const line = index + 2;
    const rawDate = cell(row, 'date', line);
    const publication = cell(row, 'publication', line);
    const code = cell(row, 'quote_code', line);
    const name = cell(row, 'quote_name', line);
    const unit = cell(row, 'unit', line);
    const low = decimalCell(row, 'low', line);
    const high = decimalCell(row, 'high', line);
    const mean = decimalCell(row, 'mean', line);
    if (!rawDate.ok) return rawDate;
    if (!publication.ok) return publication;
    if (!code.ok) return code;
    if (!name.ok) return name;
    if (!unit.ok) return unit;
    if (!low.ok) return low;
    if (!high.ok) return high;
    if (!mean.ok) return mean;

    const date = parseIsoDate(rawDate.value);
    if (!date.ok) {
      return fail('REFERENCE_DATA_INVALID', `bad date on row ${line}: "${rawDate.value}"`, { line });
    }
    if (!isPriceUnit(unit.value)) {
      return fail('REFERENCE_DATA_INVALID', `unknown price unit "${unit.value}" on row ${line}`, {
        line,
        value: unit.value,
      });
    }
    if (low.value.gt(high.value)) {
      return fail('REFERENCE_DATA_INVALID', `low above high on row ${line}`, { line });
    }
    rows.push({
      date: date.value,
      publication: publication.value,
      code: code.value as QuoteCode,
      name: name.value,
      unit: unit.value,
      low: low.value,
      high: high.value,
      mean: mean.value,
    });
  }
  return ok(rows);
}

export function buildReferenceData(productsCsv: string, quotesCsv: string): Result<ReferenceData> {
  const products = parseProducts(productsCsv);
  if (!products.ok) return products;
  const quotes = parseQuotes(quotesCsv);
  if (!quotes.ok) return quotes;

  const productMap = new Map<string, ProductRow>();
  for (const product of products.value) {
    if (productMap.has(product.code)) {
      return fail('REFERENCE_DATA_INVALID', `duplicate product_code "${product.code}"`, {
        code: product.code,
      });
    }
    productMap.set(product.code, product);
  }

  const quoteMap = new Map<string, QuoteRow[]>();
  for (const quote of quotes.value) {
    const list = quoteMap.get(quote.code);
    if (list === undefined) quoteMap.set(quote.code, [quote]);
    else list.push(quote);
  }
  for (const [code, list] of quoteMap) {
    list.sort((a, b) => compareDates(a.date, b.date));
    for (let i = 1; i < list.length; i += 1) {
      if (list[i]?.date === list[i - 1]?.date) {
        return fail('REFERENCE_DATA_INVALID', `duplicate quote for ${code} on ${list[i]?.date}`, {
          code,
          date: list[i]?.date ?? null,
        });
      }
    }
  }

  return ok({
    products: productMap,
    quotesByCode: quoteMap,
    productCodes: [...productMap.keys()].sort(),
    quoteCodes: [...quoteMap.keys()].sort(),
  });
}

// --------------------------------------------------------------------------
// Lookups
// --------------------------------------------------------------------------

export function resolveProduct(data: ReferenceData, code: string): Result<ProductRow> {
  const product = data.products.get(code);
  if (product === undefined) {
    return fail('PRODUCT_UNRESOLVED', `unknown product code "${code}"`, {
      code,
      known: data.productCodes.join(','),
    });
  }
  return ok(product);
}

export function resolveQuote(data: ReferenceData, code: string): Result<readonly QuoteRow[]> {
  const quotes = data.quotesByCode.get(code);
  if (quotes === undefined || quotes.length === 0) {
    return fail('QUOTE_CODE_UNRESOLVED', `unknown quote code "${code}"`, {
      code,
      known: data.quoteCodes.join(','),
    });
  }
  return ok(quotes);
}

/**
 * Quotations published inside a window.
 *
 * Publications skip weekends and holidays, so the window normally contains
 * fewer quotations than it has days. That is expected. What is *not* expected
 * is a window that runs past the end of the data: `requestedDays` and
 * `coverage` are returned so the caller can tell "a normal week" from "we do
 * not have these prices yet" and refuse to invoice on the second.
 */
export type QuoteWindow = {
  readonly quotes: readonly QuoteRow[];
  readonly requestedDays: number;
  readonly coverage: DateRange;
  readonly outsideCoverage: boolean;
};

export function quotesInWindow(
  data: ReferenceData,
  code: string,
  window: DateRange,
): Result<QuoteWindow> {
  const all = resolveQuote(data, code);
  if (!all.ok) return all;

  const first = all.value[0];
  const last = all.value[all.value.length - 1];
  if (first === undefined || last === undefined) {
    return fail('QUOTE_CODE_UNRESOLVED', `no quotations for "${code}"`, { code });
  }
  const coverage: DateRange = { from: first.date, to: last.date };

  const quotes = all.value.filter(
    (q) => compareDates(q.date, window.from) >= 0 && compareDates(q.date, window.to) <= 0,
  );
  const requestedDays = 1 + (Date.parse(window.to) - Date.parse(window.from)) / 86_400_000;
  const outsideCoverage =
    compareDates(window.from, coverage.from) < 0 || compareDates(window.to, coverage.to) > 0;

  if (quotes.length === 0) {
    return fail('QUOTE_WINDOW_EMPTY', `no quotations for ${code} in ${window.from}..${window.to}`, {
      code,
      from: window.from,
      to: window.to,
      coverageFrom: coverage.from,
      coverageTo: coverage.to,
    });
  }
  return ok({ quotes, requestedDays, coverage, outsideCoverage });
}

export function isQuantityUnit(value: string): value is QuantityUnit {
  return (QUANTITY_UNITS as readonly string[]).includes(value);
}

export function isPriceUnit(value: string): value is PriceUnit {
  return (PRICE_UNITS as readonly string[]).includes(value);
}
