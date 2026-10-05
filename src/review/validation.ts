/**
 * Internal structural validation helpers for the review contract.
 *
 * ## Why these are duplicated rather than imported
 *
 * `src/product/validation.ts` (owned by #57) deliberately does not
 * re-export its helpers from `src/product/index.ts`, and says so:
 * downstream tickets should use the `parse*` entry points on the
 * domain modules. Importing the internal module directly would couple
 * #61 to #57's private surface and to its unversioned changes, which
 * the 0.4.0 plan's mutable-ownership rule exists to prevent. The
 * duplication is ~120 lines of pure, dependency-free checking and buys
 * an ownership boundary. Every helper throws `ReviewContractError` and
 * never returns a partially trusted value.
 *
 * Not re-exported from `src/review/index.ts`.
 */

import { ReviewContractError } from './errors.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ReviewContractError(`${field} must be an object`, field, { received: describe(value) });
  }
  return value;
}

/**
 * Reject any key the contract does not declare.
 *
 * This is load-bearing, not tidiness. It is what makes "there is no
 * scalar UX score field" and "a finding has no disposition field"
 * structural guarantees rather than reviewer discipline: a producer
 * cannot smuggle an unmodelled claim in under a new key.
 */
export function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const unknown = Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .sort();
  if (unknown.length > 0) {
    throw new ReviewContractError(
      `${field} has unknown field(s): ${unknown.join(', ')}`,
      field,
      { unknown, allowed: [...allowed] },
    );
  }
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ReviewContractError(`${field} must be a string`, field, { received: describe(value) });
  }
  return value;
}

export function requireNonEmptyString(value: unknown, field: string, maxLength = 200): string {
  const str = requireString(value, field);
  if (str.trim() === '') {
    throw new ReviewContractError(`${field} must not be empty`, field);
  }
  if (str.length > maxLength) {
    throw new ReviewContractError(
      `${field} must be at most ${maxLength} characters`,
      field,
      { length: str.length, maxLength },
    );
  }
  return str;
}

export function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ReviewContractError(`${field} must be an array`, field, { received: describe(value) });
  }
  return value;
}

export function requireNonEmptyArray(value: unknown, field: string): unknown[] {
  const arr = requireArray(value, field);
  if (arr.length === 0) {
    throw new ReviewContractError(`${field} must not be empty`, field);
  }
  return arr;
}

export function requireOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  const str = requireString(value, field);
  if (!(allowed as readonly string[]).includes(str)) {
    throw new ReviewContractError(
      `${field} must be one of: ${allowed.join(', ')}`,
      field,
      { received: str, allowed: [...allowed] },
    );
  }
  return str as T;
}

export function requireInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ReviewContractError(
      `${field} must be an integer`,
      field,
      { received: describe(value) },
    );
  }
  if (value < min || value > max) {
    throw new ReviewContractError(
      `${field} must be between ${min} and ${max}`,
      field,
      { received: value, min, max },
    );
  }
  return value;
}

/** Reject a duplicate within an already-parsed list of handle strings. */
export function rejectDuplicates(ids: readonly string[], field: string): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  if (duplicates.size > 0) {
    throw new ReviewContractError(
      `${field} must not contain duplicates: ${[...duplicates].sort().join(', ')}`,
      field,
      { duplicates: [...duplicates].sort() },
    );
  }
}

/** Validate an ISO-8601 instant with a `Z` / explicit-offset designator. */
export function requireIsoInstant(value: unknown, field: string): string {
  const raw = requireString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    throw new ReviewContractError(
      `${field} must be an ISO-8601 instant with an explicit UTC offset`,
      field,
      { received: raw },
    );
  }
  if (Number.isNaN(Date.parse(raw))) {
    throw new ReviewContractError(`${field} must be a real instant`, field, { received: raw });
  }
  return raw;
}

export function optionalString(
  value: unknown,
  field: string,
  maxLength = 200,
): string | undefined {
  if (value === undefined) return undefined;
  return requireNonEmptyString(value, field, maxLength);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
