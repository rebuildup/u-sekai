/**
 * Structural helpers for the parts of `u-sekai.yml` that have no home
 * in the durable product model: authority envelopes, World Operator
 * connectors, secret references and the configuration document's own
 * shape.
 *
 * These exist because #57's `validation.ts` is deliberately *not*
 * re-exported from `src/product/index.ts` — that module is internal to
 * the domain. What is re-used from the domain (origins, time zones,
 * durable ids, the entity parsers) is called through `asConfigError` so
 * the grammar is stated once. What is restated here is only the
 * "is this a mapping / is this a string / is this key declared" shape
 * of the configuration's own vocabulary.
 *
 * Every helper throws `UseSekaiConfigError` and never returns a
 * partially trusted value.
 */

import { UseSekaiConfigError } from './errors.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireMapping(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new UseSekaiConfigError(`${field} must be a mapping`, field, {
      reason: 'wrong_type',
      receivedType: describeType(value),
    });
  }
  return value;
}

export function requireNonEmptyMapping(
  value: unknown,
  field: string,
): Record<string, unknown> {
  const mapping = requireMapping(value, field);
  if (Object.keys(mapping).length === 0) {
    throw new UseSekaiConfigError(`${field} must declare at least one entry`, field, {
      reason: 'empty',
    });
  }
  return mapping;
}

/**
 * Refuse any key the configuration does not declare.
 *
 * The same rule the domain applies, and for the same reason: a config
 * surface that discards an unrecognised key lets a customer believe a
 * constraint was honoured when the file did not express it. A typo in
 * `destructiveActions`, a Git-shaped `branch:` from a deployment tool
 * pasted in wholesale, or a `model: gpt-4` someone expected to take
 * effect must all be loud.
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
    throw new UseSekaiConfigError(
      `${field} has unknown key(s): ${unknown.join(', ')}`,
      field,
      { reason: 'unknown_key', unknown, allowed: [...allowed] },
    );
  }
}

export function requireString(value: unknown, field: string, maxLength = 500): string {
  if (typeof value !== 'string') {
    throw new UseSekaiConfigError(`${field} must be a string`, field, {
      reason: 'wrong_type',
      receivedType: describeType(value),
    });
  }
  if (value.length > maxLength) {
    throw new UseSekaiConfigError(
      `${field} must be at most ${maxLength} characters`,
      field,
      { reason: 'too_long', length: value.length, maxLength },
    );
  }
  return value;
}

export function requireNonEmptyString(value: unknown, field: string, maxLength = 500): string {
  const str = requireString(value, field, maxLength);
  if (str.trim() === '') {
    throw new UseSekaiConfigError(`${field} must not be empty`, field, { reason: 'empty' });
  }
  return str;
}

export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new UseSekaiConfigError(`${field} must be true or false`, field, {
      reason: 'wrong_type',
      receivedType: describeType(value),
    });
  }
  return value;
}

export function requireInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new UseSekaiConfigError(`${field} must be an integer`, field, {
      reason: 'wrong_type',
      receivedType: describeType(value),
    });
  }
  if (value < min || value > max) {
    throw new UseSekaiConfigError(`${field} must be between ${min} and ${max}`, field, {
      reason: 'out_of_range',
      received: value,
      min,
      max,
    });
  }
  return value;
}

export function requireFiniteNumber(value: unknown, field: string, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new UseSekaiConfigError(`${field} must be a number`, field, {
      reason: 'wrong_type',
      receivedType: describeType(value),
    });
  }
  if (value < min) {
    throw new UseSekaiConfigError(`${field} must be >= ${min}`, field, {
      reason: 'out_of_range',
      received: value,
      min,
    });
  }
  return value;
}

export function requireOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== 'string') {
    throw new UseSekaiConfigError(`${field} must be a string`, field, {
      reason: 'wrong_type',
      receivedType: describeType(value),
    });
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new UseSekaiConfigError(`${field} must be one of: ${allowed.join(', ')}`, field, {
      reason: 'not_in_enum',
      received: value,
      allowed: [...allowed],
    });
  }
  return value as T;
}

export function requireSequence(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new UseSekaiConfigError(`${field} must be a list`, field, {
      reason: 'wrong_type',
      receivedType: describeType(value),
    });
  }
  return value;
}

export function requireNonEmptySequence(value: unknown, field: string): unknown[] {
  const items = requireSequence(value, field);
  if (items.length === 0) {
    throw new UseSekaiConfigError(`${field} must declare at least one entry`, field, {
      reason: 'empty',
    });
  }
  return items;
}

export function optionalString(
  value: unknown,
  field: string,
  maxLength = 500,
): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field, maxLength);
}

export function rejectDuplicates(values: readonly string[], field: string): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  if (duplicates.size > 0) {
    throw new UseSekaiConfigError(
      `${field} must not repeat: ${[...duplicates].sort().join(', ')}`,
      field,
      { reason: 'duplicates', duplicates: [...duplicates].sort() },
    );
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'boolean') return 'a boolean';
  if (typeof value === 'string') return 'a string';
  return typeof value;
}
