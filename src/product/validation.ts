/**
 * Internal structural validation helpers for the durable product model.
 *
 * Not re-exported from `src/product/index.ts`: downstream tickets should
 * use the `parse*` entry points on the domain modules, which compose
 * these helpers, rather than assembling values field by field.
 *
 * Every helper throws `ProductDomainError` and never returns a partially
 * trusted value.
 */

import { ProductDomainError } from './errors.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProductDomainError(`${field} must be an object`, field, { received: describe(value) });
  }
  return value;
}

/**
 * Reject any key the domain does not declare.
 *
 * This is what keeps a runtime/provider-shaped or Git-shaped object from
 * being smuggled into a domain value under an unmodelled key. Silently
 * dropping such keys would let a caller believe a constraint was applied
 * when it was not, so an unknown key is an error rather than a discard.
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
    throw new ProductDomainError(
      `${field} has unknown field(s): ${unknown.join(', ')}`,
      field,
      { unknown, allowed: [...allowed] },
    );
  }
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ProductDomainError(`${field} must be a string`, field, { received: describe(value) });
  }
  return value;
}

export function requireNonEmptyString(value: unknown, field: string, maxLength = 200): string {
  const str = requireString(value, field);
  if (str.trim() === '') {
    throw new ProductDomainError(`${field} must not be empty`, field);
  }
  if (str.length > maxLength) {
    throw new ProductDomainError(
      `${field} must be at most ${maxLength} characters`,
      field,
      { length: str.length, maxLength },
    );
  }
  return str;
}

export function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ProductDomainError(`${field} must be an array`, field, { received: describe(value) });
  }
  return value;
}

export function requireNonEmptyArray(value: unknown, field: string): unknown[] {
  const arr = requireArray(value, field);
  if (arr.length === 0) {
    throw new ProductDomainError(`${field} must not be empty`, field);
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
    throw new ProductDomainError(
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
    throw new ProductDomainError(`${field} must be an integer`, field, { received: describe(value) });
  }
  if (value < min || value > max) {
    throw new ProductDomainError(
      `${field} must be between ${min} and ${max}`,
      field,
      { received: value, min, max },
    );
  }
  return value;
}

export function requireFiniteNumber(value: unknown, field: string, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProductDomainError(`${field} must be a finite number`, field, { received: describe(value) });
  }
  if (value < min) {
    throw new ProductDomainError(`${field} must be >= ${min}`, field, { received: value, min });
  }
  return value;
}

/** Reject a duplicate within an already-parsed list of id strings. */
export function rejectDuplicates(ids: readonly string[], field: string): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  if (duplicates.size > 0) {
    throw new ProductDomainError(
      `${field} must not contain duplicates: ${[...duplicates].sort().join(', ')}`,
      field,
      { duplicates: [...duplicates].sort() },
    );
  }
}

/**
 * Validate an absolute http(s) origin or base URL and return a
 * canonical form.
 *
 * Rejected deliberately:
 * - non-http(s) schemes (the durable model must not assume a browser or
 *   any particular transport);
 * - embedded credentials — an origin carrying `user:pass@` is a secret
 *   in a durable document, and ADR-0011 keeps secret *values* out of
 *   committed configuration in favour of references;
 * - query strings and fragments, which are per-visit state rather than
 *   environment identity.
 *
 * A bare-origin trailing slash is stripped (`https://a.example/` becomes
 * `https://a.example`) so that two spellings of the same environment
 * compare equal. A trailing slash on a real path is preserved, because
 * there it is significant.
 */
export function requireOrigin(value: unknown, field: string): string {
  const raw = requireString(value, field);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProductDomainError(`${field} must be an absolute URL`, field, { received: raw });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProductDomainError(
      `${field} must use http or https`,
      field,
      { received: raw, protocol: url.protocol },
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new ProductDomainError(
      `${field} must not embed credentials`,
      field,
      { received: `${url.protocol}//${url.host}/` },
    );
  }
  if (url.search !== '') {
    throw new ProductDomainError(`${field} must not contain a query string`, field, { received: raw });
  }
  if (url.hash !== '') {
    throw new ProductDomainError(`${field} must not contain a fragment`, field, { received: raw });
  }
  const path = url.pathname === '/' ? '' : url.pathname;
  return `${url.protocol}//${url.host}${path}`;
}

/** Validate an ISO-8601 instant with a `Z` / explicit-offset designator. */
export function requireIsoInstant(value: unknown, field: string): string {
  const raw = requireString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    throw new ProductDomainError(
      `${field} must be an ISO-8601 instant with an explicit UTC offset`,
      field,
      { received: raw },
    );
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new ProductDomainError(`${field} must be a real instant`, field, { received: raw });
  }
  return raw;
}

/**
 * Validate an IANA timezone name.
 *
 * An offset such as `+09:00` or `GMT+9` is rejected, even though
 * `Intl.DateTimeFormat` accepts both. An offset is not a zone: it does
 * not track a DST transition, so a cadence anchored to one is not
 * reproducible across the transition — the declared interval would
 * silently become a different wall-clock interval twice a year. The
 * identifier is checked structurally here and for real existence
 * through `Intl` below.
 */
const SINGLE_WORD_TIME_ZONES = new Set(['UTC', 'GMT']);
const IANA_ZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\/[A-Za-z0-9_+-]+)+$/;

export function requireTimeZone(value: unknown, field: string): string {
  const raw = requireString(value, field);
  if (!SINGLE_WORD_TIME_ZONES.has(raw) && !IANA_ZONE_PATTERN.test(raw)) {
    throw new ProductDomainError(
      `${field} must be an IANA time zone name such as "Asia/Tokyo", not a UTC offset`,
      field,
      { received: raw },
    );
  }
  let known = false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
    known = true;
  } catch {
    known = false;
  }
  if (!known) {
    throw new ProductDomainError(`${field} must be an IANA time zone name`, field, {
      received: raw,
    });
  }
  return raw;
}

/** Read an optional field, returning `undefined` when absent. */
export function optionalString(value: unknown, field: string, maxLength = 200): string | undefined {
  if (value === undefined) return undefined;
  return requireNonEmptyString(value, field, maxLength);
}

export function optionalStringArray(
  value: unknown,
  field: string,
  map: (item: unknown, itemField: string) => string,
): string[] | undefined {
  if (value === undefined) return undefined;
  const arr = requireArray(value, field);
  return arr.map((item, i) => map(item, `${field}[${i}]`));
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
