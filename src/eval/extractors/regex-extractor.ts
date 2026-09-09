/**
 * Baseline B: patterns, no model.
 *
 * A deliberately crude reader of the well-formed recap layout: labelled lines,
 * a quotation name copied verbatim from the publication, an explicit laycan. It
 * exists for two reasons.
 *
 * First, it is a floor. A local model that cannot beat a hundred lines of
 * regular expressions on the clean cases is not earning its memory footprint.
 *
 * Second, it is a fast target for debugging the harness itself: it runs in
 * microseconds, so the scorer, the report and the case set can be exercised
 * without waiting on inference.
 *
 * It is expected to fail badly on threads, distractors and anything written in
 * prose, and to fail *unsafely* where a pattern half-matches. That contrast is
 * the point: the null baseline shows what safe-and-useless looks like, and this
 * one shows what useful-and-unsafe looks like.
 *
 * Two of its failures are left in deliberately, because they are the failures a
 * real extractor has to avoid rather than artefacts of laziness:
 *
 *   - the statistic pattern finds "Low" inside "Ultra Low Sulphur Diesel" and
 *     reports a low-of-the-day pricing basis that nobody agreed;
 *   - the Incoterm pattern finds "CIF" inside the quotation name
 *     "Platts CIF NWE ULSD 10 ppm" and calls a delivered-Rotterdam cargo CIF.
 *
 * Both produce a confident, plausible, wrong answer from a word that belongs to
 * a different part of the sentence. A language model reading the same text can
 * make exactly these mistakes, which is why the cases that catch them are in the
 * set.
 */
import { parseHalfMonth, parseLaycan, parseWrittenDate } from '../../domain/dates.js';
import { generateQuestions, type Unresolvable } from '../../domain/questions.js';
import type { ReferenceData } from '../../domain/references.js';
import { emptyDeal, type Deal, type FieldStatus } from '../../domain/schema.js';
import {
  emptyDiagnostics,
  type ExtractionRequest,
  type Extractor,
  type ExtractionOutput,
} from '../../extract/types.js';

type Hit = { value: string; evidence: string; status?: FieldStatus };

function setField(deal: Deal, path: string, hit: Hit | null): void {
  if (hit === null) return;
  const segments = path.split('.');
  let node = deal as unknown as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    node = node[segment] as Record<string, unknown>;
  }
  node[segments[segments.length - 1] as string] = {
    value: hit.value,
    evidence: hit.evidence,
    status: hit.status ?? 'stated',
  };
}

function match(text: string, pattern: RegExp, group = 1): Hit | null {
  const found = pattern.exec(text);
  if (found === null) return null;
  const value = found[group];
  if (value === undefined || value.trim() === '') return null;
  return { value: value.trim(), evidence: found[0].trim() };
}

/** Strip thousands separators so the value satisfies the schema's decimal rule. */
function toDecimalText(raw: string): string | null {
  const cleaned = raw.replace(/,/g, '').trim();
  return /^-?\d+(?:\.\d+)?$/.test(cleaned) ? String(Number(cleaned)) : null;
}

export function createRegexExtractor(data: ReferenceData): Extractor {
  return {
    config: {
      name: 'regex',
      kind: 'baseline',
      detail: {
        description: 'labelled-line patterns, no model',
        model: null,
        deterministic: 'yes',
      },
    },
    async extract(request: ExtractionRequest): Promise<ExtractionOutput> {
      const started = performance.now();
      const { deal, unresolvable } = readRecap(request.text, request.referenceDate, data);
      return {
        deal,
        questions: generateQuestions(deal, unresolvable),
        diagnostics: emptyDiagnostics(performance.now() - started),
      };
    },
  };
}

function readRecap(
  text: string,
  referenceDate: string,
  data: ReferenceData,
): { deal: Deal; unresolvable: Unresolvable[] } {
  const deal = emptyDeal();
  const unresolvable: Unresolvable[] = [];
  const contextYear = Number(referenceDate.slice(0, 4));

  // --- parties ---------------------------------------------------------
  setField(deal, 'seller', match(text, /^\s*Seller:\s*(.+)$/im));
  setField(deal, 'buyer', match(text, /^\s*Buyer:\s*(.+)$/im));

  // --- recap date ------------------------------------------------------
  const recapDate =
    match(text, /RECAP\s+(\d{1,2}[./]\d{1,2}[./]\d{2,4})/i) ??
    match(text, /recap of our call (?:today\s+)?(\d{1,2}[./]\d{1,2}[./]\d{2,4})/i);
  if (recapDate !== null) {
    const parsed = parseWrittenDate(recapDate.value);
    if (parsed.ok) setField(deal, 'recap_date', { value: parsed.value, evidence: recapDate.evidence });
  }

  // --- product ---------------------------------------------------------
  const product = match(text, /^\s*Product:\s*(.+)$/im);
  setField(deal, 'product.as_written', product);
  if (product !== null) {
    const haystack = product.value.toLowerCase();
    const hit = data.productCodes.find((code) => {
      const name = data.products.get(code)?.name.toLowerCase();
      return name !== undefined && haystack.includes(name);
    });
    if (hit !== undefined) {
      setField(deal, 'product.product_code', { value: hit, evidence: product.evidence });
    }
  }

  // --- quantity --------------------------------------------------------
  const quantity = /([\d,]+(?:\.\d+)?)\s*(MT|mt|BBL|bbl|barrels?)\b/.exec(text);
  if (quantity !== null) {
    const value = toDecimalText(quantity[1] ?? '');
    if (value !== null) {
      setField(deal, 'quantity.value', { value, evidence: quantity[0].trim() });
      const rawUnit = (quantity[2] ?? '').toLowerCase();
      setField(deal, 'quantity.unit', {
        value: rawUnit === 'mt' ? 'MT' : 'BBL',
        evidence: quantity[0].trim(),
      });
    }
  }

  const tolerance = /\+\/?-\s*(\d+(?:\.\d+)?)\s*%/.exec(text);
  if (tolerance !== null) {
    const value = toDecimalText(tolerance[1] ?? '');
    if (value !== null) {
      setField(deal, 'quantity.tolerance_pct', { value, evidence: tolerance[0].trim() });
    }
  }

  const option = /\b(seller|buyer)(?:'s|s')?\s+option\b/i.exec(text);
  if (option !== null) {
    setField(deal, 'quantity.tolerance_option', {
      value: (option[1] ?? '').toLowerCase(),
      evidence: option[0].trim(),
    });
  }

  // --- delivery term ---------------------------------------------------
  // [^\S\n] is "whitespace that is not a newline": without it the captured
  // place runs off the end of the line and swallows the next label.
  const delivery =
    /\b(EXW|FAS|FOB|CFR|CIF|DAP|DDP)[^\S\n]+([A-Z][\w'-]*(?:[^\S\n]+[A-Z][\w'-]*)*)/.exec(text);
  if (delivery !== null) {
    setField(deal, 'delivery_term.as_written', { value: delivery[0].trim(), evidence: delivery[0].trim() });
    setField(deal, 'delivery_term.incoterm', { value: delivery[1] ?? '', evidence: delivery[0].trim() });
    setField(deal, 'delivery_term.place', { value: delivery[2] ?? '', evidence: delivery[0].trim() });
  }

  // --- laycan ----------------------------------------------------------
  const laycan =
    match(text, /^\s*Laycan:\s*(.+)$/im) ??
    match(text, /\blaycan\s+(?:now\s+)?([0-9]{1,2}\s*-\s*[0-9]{1,2}\s+[A-Za-z]+(?:\s+\d{4})?)/i) ??
    match(text, /\b((?:first|second)\s+half\s+of\s+[A-Za-z]+(?:\s+\d{4})?)/i);
  if (laycan !== null) {
    setField(deal, 'delivery_window.as_written', laycan);
    const range = parseLaycan(laycan.value, contextYear);
    if (range.ok) {
      setField(deal, 'delivery_window.from', { value: range.value.from, evidence: laycan.evidence });
      setField(deal, 'delivery_window.to', { value: range.value.to, evidence: laycan.evidence });
    } else {
      const half = parseHalfMonth(laycan.value, contextYear);
      if (half.ok) {
        setField(deal, 'delivery_window.from', {
          value: half.value.range.from,
          evidence: laycan.evidence,
        });
        setField(deal, 'delivery_window.to', {
          value: half.value.range.to,
          evidence: laycan.evidence,
        });
      }
    }
  }

  // --- pricing ---------------------------------------------------------
  const lowerText = text.toLowerCase();
  const quoteCode = data.quoteCodes.find((code) => {
    const name = data.quotesByCode.get(code)?.[0]?.name.toLowerCase();
    return name !== undefined && lowerText.includes(name);
  });
  if (quoteCode !== undefined) {
    const name = data.quotesByCode.get(quoteCode)?.[0]?.name ?? quoteCode;
    setField(deal, 'pricing.quote_code', { value: quoteCode, evidence: name });
  }

  const statistic = /\b(mean of high|mean|average|high|low)\b/i.exec(text);
  if (statistic !== null) {
    const word = (statistic[1] ?? '').toLowerCase();
    setField(deal, 'pricing.statistic', {
      value: word === 'average' ? 'mean' : word === 'mean of high' ? 'mean_of_high' : word,
      evidence: statistic[0].trim(),
    });
  }

  const period = match(text, /\bover\s+(B\/?L\s*[+-][^,\n]*|the\s+[^,\n]+)/i);
  setField(deal, 'pricing.period', period);

  const differential =
    /\b(minus|less|plus|premium of|discount of)\s+(?:USD\s*)?([\d,]+(?:\.\d+)?)\s*(?:USD\s*)?\/\s*(MT|mt|BBL|bbl)/.exec(
      text,
    );
  if (differential !== null) {
    const magnitude = toDecimalText(differential[2] ?? '');
    const word = (differential[1] ?? '').toLowerCase();
    const negative = word === 'minus' || word === 'less' || word === 'discount of';
    if (magnitude !== null) {
      setField(deal, 'pricing.differential.value', {
        value: negative ? `-${magnitude}` : magnitude,
        evidence: differential[0].trim(),
      });
      setField(deal, 'pricing.differential.unit', {
        value: (differential[3] ?? '').toUpperCase() === 'MT' ? 'USD/MT' : 'USD/BBL',
        evidence: differential[0].trim(),
      });
    }
  }

  // --- currency and payment -------------------------------------------
  setField(deal, 'currency', match(text, /^\s*Currency:\s*([A-Z]{3})\s*$/im));
  setField(deal, 'payment_terms.as_written', match(text, /^\s*Payment:\s*(.+)$/im));

  // --- conditional -----------------------------------------------------
  setField(deal, 'law', match(text, /^\s*Law:\s*(.+)$/im));
  setField(deal, 'vessel', match(text, /^\s*Vessel:\s*(.+)$/im));

  return { deal, unresolvable };
}
