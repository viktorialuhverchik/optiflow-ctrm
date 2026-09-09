/**
 * Expected failures are values, not exceptions (code-style §6).
 *
 * Anything a recap can legitimately cause — an unresolvable quote code, a
 * pricing window with no published quotations, an evidence span that is not in
 * the source text — comes back as `err`. Exceptions are reserved for programmer
 * errors: a missing reference file, a broken invariant, an impossible branch.
 */

export type DomainErrorCode =
  | 'BAD_DATE'
  | 'BAD_DATE_RANGE'
  | 'BAD_DECIMAL'
  | 'BAD_PERIOD'
  | 'PRODUCT_UNRESOLVED'
  | 'QUOTE_CODE_UNRESOLVED'
  | 'QUOTE_WINDOW_EMPTY'
  | 'UNIT_UNCONVERTIBLE'
  | 'CURRENCY_MISMATCH'
  | 'REFERENCE_DATA_INVALID';

export type DomainError = {
  readonly code: DomainErrorCode;
  /** Human-readable, safe to show a trader. Never contains full recap text. */
  readonly message: string;
  /** Structured context. Keys are stable; this is logged as JSON, not prose. */
  readonly context?: Readonly<Record<string, string | number | null>>;
};

export type Result<T, E = DomainError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E = DomainError>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function fail(
  code: DomainErrorCode,
  message: string,
  context?: Readonly<Record<string, string | number | null>>,
): Result<never> {
  return { ok: false, error: context === undefined ? { code, message } : { code, message, context } };
}

/** Unwrap in tests and at entry points where a failure really is a bug. */
export function expect<T>(result: Result<T>, hint: string): T {
  if (result.ok) return result.value;
  throw new Error(`${hint}: [${result.error.code}] ${result.error.message}`);
}

export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok;
}

/** Exhaustiveness guard for discriminated unions (code-style §3). */
export function assertNever(value: never, hint = 'unexpected variant'): never {
  throw new Error(`${hint}: ${JSON.stringify(value)}`);
}
