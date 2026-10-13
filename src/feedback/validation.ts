/**
 * Internal structural validation helpers for the feedback ledger.
 *
 * ## Why these are duplicated rather than imported
 *
 * The same reasoning #61 recorded in `src/review/validation.ts`, one
 * layer further up. #57's `src/product/validation.ts` does not
 * re-export its helpers from `src/product/index.ts`, and #61 refused to
 * couple itself to #57's private surface; importing #61's unexported
 * `src/review/validation.ts` directly would couple #64 to an internal
 * module in exactly the same way, and would make a #61 refactor of a
 * helper an unannounced breaking change for this ticket's file set.
 *
 * The duplication here is smaller than #61's (~70 lines) because the
 * ledger only needs a handful of the checks: it does not parse findings
 * or evidence, and it never re-validates a `Disposition` — that is
 * `parseDisposition`'s job, and the ledger calls it rather than
 * re-implementing the vocabulary rules that #61 already owns.
 *
 * Not re-exported from `src/feedback/index.ts`.
 */

import { FeedbackContractError } from './errors.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new FeedbackContractError(`${field} must be an object`, field, {
      received: describe(value),
    });
  }
  return value;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new FeedbackContractError(`${field} must be a string`, field, {
      received: describe(value),
    });
  }
  return value;
}

export function requireNonEmptyString(value: unknown, field: string, maxLength = 200): string {
  const str = requireString(value, field);
  if (str.trim() === '') {
    throw new FeedbackContractError(`${field} must not be empty`, field);
  }
  if (str.length > maxLength) {
    throw new FeedbackContractError(`${field} must be at most ${maxLength} characters`, field, {
      length: str.length,
      maxLength,
    });
  }
  return str;
}

export function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new FeedbackContractError(`${field} must be an array`, field, {
      received: describe(value),
    });
  }
  return value;
}

export function requireOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  const str = requireString(value, field);
  if (!(allowed as readonly string[]).includes(str)) {
    throw new FeedbackContractError(`${field} must be one of: ${allowed.join(', ')}`, field, {
      received: str,
      allowed: [...allowed],
    });
  }
  return str as T;
}

/**
 * Require a finite, non-negative number.
 *
 * `Number.isFinite` rather than `Number.isInteger`: a cost may carry a
 * fractional unit (cents, micro-credits), but it may not be `NaN`,
 * `Infinity` or negative. Those three would each make a downstream KPI
 * silently wrong rather than loudly wrong — `NaN` propagates into a
 * ratio and turns it into `NaN`, `Infinity` turns a cost-per-finding
 * into `Infinity` the moment the count is zero, and a negative cost
 * makes "cost per accepted finding" improve as the service burns more
 * money.
 */
export function requireNonNegativeFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FeedbackContractError(`${field} must be a finite number`, field, {
      received: describe(value),
    });
  }
  if (value < 0) {
    throw new FeedbackContractError(
      `${field} must not be negative; a negative cost makes cost-per-finding fall as the service ` +
        `spends more, which is the wrong direction for a viability metric`,
      field,
      { received: value },
    );
  }
  return value;
}

/**
 * Reject a duplicate in an already-parsed list of handle strings.
 *
 * Sorted in the message so the failure is deterministic: two replays of
 * the same bad input produce the same error text, which is what makes an
 * error string usable as an audit key.
 */
export function rejectDuplicates(values: readonly string[], field: string): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  if (duplicates.size > 0) {
    throw new FeedbackContractError(
      `${field} must not contain duplicates: ${[...duplicates].sort().join(', ')}`,
      field,
      { duplicates: [...duplicates].sort() },
    );
  }
}

/** Reject any key the contract does not declare. */
export function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const unknown = Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .sort();
  if (unknown.length > 0) {
    throw new FeedbackContractError(
      `${field} has unknown field(s): ${unknown.join(', ')}`,
      field,
      { unknown, allowed: [...allowed] },
    );
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  return typeof value;
}
