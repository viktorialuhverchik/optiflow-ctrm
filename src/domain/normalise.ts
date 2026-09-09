/**
 * Canonicalising what the model reports.
 *
 * The model is asked to copy what the message says. Code decides what the
 * canonical form of that is. This is the same division as everywhere else in
 * the system, applied to text rather than arithmetic.
 *
 * Right now it holds one rule, and that rule earns its place: the pricing period
 * arrives as "over B/L +0/+3" about a third of the time, and
 * `parseBlRelativePeriod` is anchored, so the leading connective makes the
 * period unparseable downstream. That is a real defect with a real consequence,
 * not a formatting preference: an unparseable period means no pricing window,
 * which means no invoice.
 *
 * The prompt already asks the model to drop the word. It does so unreliably. The
 * lesson from phase 6 applies here too: when an instruction does not stick, move
 * the guarantee into code.
 */

/** Words traders put in front of a pricing period. None of them is part of it. */
const LEADING_CONNECTIVE = /^(over|basis|against|versus|vs\.?)\s+/i;

export function normalisePricingPeriod(text: string): string {
  let out = text.trim();
  // Loop: "basis over B/L +0/+3" appears occasionally.
  while (LEADING_CONNECTIVE.test(out)) {
    out = out.replace(LEADING_CONNECTIVE, '').trim();
  }
  // A trailing comma or full stop is where the model stopped copying, not part
  // of the value.
  return out.replace(/[\s,;.]+$/, '').trim();
}
