/**
 * Internal structural validation for the operator boundary.
 *
 * Not re-exported from `src/operator/index.ts`. Downstream tickets should
 * use the `parse*` entry points, which compose these helpers.
 *
 * ## Why these are duplicated from `src/product/validation.ts`
 *
 * `src/product/validation.ts` is deliberately *internal* to the durable
 * model — it is not re-exported from `src/product/index.ts`, and its
 * helpers throw `ProductDomainError`. An operator request is not a
 * product-domain value: it carries no durable identity of its own and
 * failing to parse it must not be reported as malformed *product
 * configuration*. The failure taxonomy is the reason the duplication is
 * worth paying for.
 *
 * The behaviour is deliberately identical to the durable model's, and in
 * particular it keeps the two properties #57 established:
 *
 * - an unknown key is an **error**, never a silent drop, so a
 *   runtime- or provider-shaped object cannot be smuggled in under an
 *   unmodelled field; and
 * - a missing value is an **error**, never a substituted default, so a
 *   caller can never believe a constraint was applied when it was not.
 *
 * Note the consequence for the authority boundary: because the operator
 * vocabulary is closed, there is no request field in which a real
 * person's identity or credentials could be expressed. `rejectUnknownKeys`
 * is what makes that true at runtime rather than merely conventional.
 */

import { OperatorError } from './errors.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new OperatorError('invalidRequest', `${field} must be an object`, field, {
      received: describeValue(value),
    });
  }
  return value;
}

/** Reject any key the operator vocabulary does not declare. */
export function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const unknown = Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .sort();
  if (unknown.length > 0) {
    throw new OperatorError(
      'invalidRequest',
      `${field} has unknown field(s): ${unknown.join(', ')}`,
      field,
      { unknown, allowed: [...allowed] },
    );
  }
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new OperatorError('invalidRequest', `${field} must be a string`, field, {
      received: describeValue(value),
    });
  }
  return value;
}

export function requireNonEmptyString(value: unknown, field: string, maxLength = 200): string {
  const str = requireString(value, field);
  if (str.trim() === '') {
    throw new OperatorError('invalidRequest', `${field} must not be empty`, field);
  }
  if (str.length > maxLength) {
    throw new OperatorError(
      'invalidRequest',
      `${field} must be at most ${maxLength} characters`,
      field,
      { length: str.length, maxLength },
    );
  }
  return str;
}

export function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new OperatorError('invalidRequest', `${field} must be an array`, field, {
      received: describeValue(value),
    });
  }
  return value;
}

export function requireNonEmptyArray(value: unknown, field: string): unknown[] {
  const arr = requireArray(value, field);
  if (arr.length === 0) {
    throw new OperatorError('invalidRequest', `${field} must not be empty`, field);
  }
  return arr;
}

export function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const str = requireString(value, field);
  if (!(allowed as readonly string[]).includes(str)) {
    throw new OperatorError('invalidRequest', `${field} must be one of: ${allowed.join(', ')}`, field, {
      received: str,
      allowed: [...allowed],
    });
  }
  return str as T;
}

export function requireInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new OperatorError('invalidRequest', `${field} must be an integer`, field, {
      received: describeValue(value),
    });
  }
  if (value < min || value > max) {
    throw new OperatorError(
      'invalidRequest',
      `${field} must be between ${min} and ${max}`,
      field,
      { received: value, min, max },
    );
  }
  return value;
}

export function requireFiniteNumber(
  value: unknown,
  field: string,
  min: number,
  max = Number.POSITIVE_INFINITY,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new OperatorError('invalidRequest', `${field} must be a finite number`, field, {
      received: describeValue(value),
    });
  }
  if (value < min) {
    throw new OperatorError('invalidRequest', `${field} must be >= ${min}`, field, {
      received: value,
      min,
    });
  }
  if (value > max) {
    throw new OperatorError('invalidRequest', `${field} must be <= ${max}`, field, {
      received: value,
      max,
    });
  }
  return value;
}

/** ISO-8601 instant with an explicit `Z` / offset designator. */
export function requireIsoInstant(value: unknown, field: string): string {
  const raw = requireString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    throw new OperatorError(
      'invalidRequest',
      `${field} must be an ISO-8601 instant with an explicit UTC offset`,
      field,
      { received: raw },
    );
  }
  if (Number.isNaN(Date.parse(raw))) {
    throw new OperatorError('invalidRequest', `${field} must be a real instant`, field, {
      received: raw,
    });
  }
  return raw;
}

/** Dotted lowercase token, e.g. `empty-inbox`, `smoke-v2`. */
export function requireToken(value: unknown, field: string, maxLength = 64): string {
  const raw = requireNonEmptyString(value, field, maxLength);
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(raw)) {
    throw new OperatorError(
      'invalidRequest',
      `${field} must be a lowercase dotted token (e.g. "smoke-v2")`,
      field,
      { received: raw },
    );
  }
  return raw;
}

export function rejectDuplicates(values: readonly string[], field: string): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  if (duplicates.size > 0) {
    throw new OperatorError(
      'invalidRequest',
      `${field} must not contain duplicates: ${[...duplicates].sort().join(', ')}`,
      field,
      { duplicates: [...duplicates].sort() },
    );
  }
}

export function optionalString(value: unknown, field: string, maxLength = 200): string | undefined {
  if (value === undefined) return undefined;
  return requireNonEmptyString(value, field, maxLength);
}

/**
 * Deterministic JSON with recursively sorted object keys.
 *
 * Used to digest a provisioning plan so a replayed request can be
 * recognised as the *same* request. `JSON.stringify` alone preserves
 * insertion order, which would make two structurally identical plans
 * hash differently and silently defeat idempotency.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Name a value's type for a diagnostic, without interpolating the value
 * itself — an error message must never carry a secret value.
 */
export function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
