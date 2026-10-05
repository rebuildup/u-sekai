/**
 * Durable domain identities (ADR-0011, issue #57).
 *
 * These five identifiers are the durable identities that sit *above* an
 * Evaluation Run. A Product exists before any run, survives every run,
 * and is not owned by `ExperimentDefinition` or by the experiment
 * runtime — see `src/product/ids.ts`'s acceptance tests for the
 * independence guarantee.
 *
 * ## Two independent guards against identity confusion
 *
 * 1. **Compile-time branding.** `ProductId` and `EnvironmentId` are
 *    distinct nominal types, so a `ProductId` cannot be passed where an
 *    `EnvironmentId` is expected. Branding is erased by serialisation,
 *    which is where the second guard applies.
 * 2. **Wire-format prefix.** Every serialised id carries a kind prefix
 *    (`prd-`, `env-`, `idn-`, `coh-`, `rp-`). A reloaded value that has
 *    been mistaken for another kind is rejected at parse time rather
 *    than silently accepted.
 *
 * ## Ids are declared, never generated
 *
 * There is deliberately no `generateProductId()` / `newCohortId()` in
 * this module or anywhere else under `src/product/**`. An id may only be
 * obtained by *declaring* it (`productId('prd-task-tracker')`) or by
 * *re-reading* it (`parseProductId(value)`). This is what makes
 * "IDs must not be silently regenerated when state is reloaded" a
 * structural property rather than a convention: there is no code path
 * in the domain that can mint a replacement.
 *
 * Both entry points are pure — same input, same output — so a value
 * round-tripped through storage comes back identical.
 */

import { ProductDomainError } from './errors.js';

/**
 * Nominal brand marker. The `__brand` key is intentionally never
 * produced at runtime: a branded value *is* its underlying string, so
 * `JSON.stringify`, storage and logging all work without ceremony.
 */
export type Brand<T, TBrand extends string> = T & { readonly __brand: TBrand };

export type ProductId = Brand<string, 'ProductId'>;
export type EnvironmentId = Brand<string, 'EnvironmentId'>;
export type SyntheticIdentityId = Brand<string, 'SyntheticIdentityId'>;
export type CohortId = Brand<string, 'CohortId'>;
export type ReviewProgramId = Brand<string, 'ReviewProgramId'>;

/** Maximum length of any serialised id, prefix included. */
export const MAX_ID_LENGTH = 64;

/**
 * Per-kind wire patterns, exported so a configuration loader (#58) can
 * report the same constraint in its own diagnostics without restating
 * the grammar.
 */
export const PRODUCT_ID_PATTERN = /^prd-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ENVIRONMENT_ID_PATTERN = /^env-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SYNTHETIC_IDENTITY_ID_PATTERN = /^idn-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const COHORT_ID_PATTERN = /^coh-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const REVIEW_PROGRAM_ID_PATTERN = /^rp-[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface IdKind {
  readonly typeName: string;
  readonly pattern: RegExp;
}

const KINDS = {
  product: { typeName: 'ProductId', pattern: PRODUCT_ID_PATTERN },
  environment: { typeName: 'EnvironmentId', pattern: ENVIRONMENT_ID_PATTERN },
  identity: { typeName: 'SyntheticIdentityId', pattern: SYNTHETIC_IDENTITY_ID_PATTERN },
  cohort: { typeName: 'CohortId', pattern: COHORT_ID_PATTERN },
  program: { typeName: 'ReviewProgramId', pattern: REVIEW_PROGRAM_ID_PATTERN },
} as const satisfies Record<string, IdKind>;

export type IdKindName = keyof typeof KINDS;

/**
 * Validate a declared id and return it branded.
 *
 * @param kind which id grammar to enforce
 * @param value the human- or configuration-authored identifier
 * @param field dotted path used in the error message
 */
export function brandedId<K extends IdKindName>(
  kind: K,
  value: string,
  field: string = KINDS[kind].typeName,
): Brand<string, (typeof KINDS)[K]['typeName']> {
  if (typeof value !== 'string') {
    throw new ProductDomainError(`${field} must be a string`, field, { kind });
  }
  if (value.length > MAX_ID_LENGTH) {
    throw new ProductDomainError(
      `${field} must be at most ${MAX_ID_LENGTH} characters`,
      field,
      { kind, length: value.length, maxLength: MAX_ID_LENGTH },
    );
  }
  if (!KINDS[kind].pattern.test(value)) {
    throw new ProductDomainError(
      `${field} must match ${KINDS[kind].pattern.source} (e.g. "prd-task-tracker")`,
      field,
      { kind, received: value, pattern: KINDS[kind].pattern.source },
    );
  }
  return value as Brand<string, (typeof KINDS)[K]['typeName']>;
}

/** Validate an id re-read from untrusted / unknown-shaped input. */
export function parseBrandedId<K extends IdKindName>(
  kind: K,
  value: unknown,
  field: string = KINDS[kind].typeName,
): Brand<string, (typeof KINDS)[K]['typeName']> {
  if (typeof value !== 'string') {
    throw new ProductDomainError(
      `${field} must be a string`,
      field,
      { kind, received: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value },
    );
  }
  return brandedId(kind, value, field);
}

export function productId(value: string): ProductId {
  return brandedId('product', value);
}
export function environmentId(value: string): EnvironmentId {
  return brandedId('environment', value);
}
export function syntheticIdentityId(value: string): SyntheticIdentityId {
  return brandedId('identity', value);
}
export function cohortId(value: string): CohortId {
  return brandedId('cohort', value);
}
export function reviewProgramId(value: string): ReviewProgramId {
  return brandedId('program', value);
}

export function parseProductId(value: unknown, field = 'ProductId'): ProductId {
  return parseBrandedId('product', value, field) as ProductId;
}
export function parseEnvironmentId(value: unknown, field = 'EnvironmentId'): EnvironmentId {
  return parseBrandedId('environment', value, field) as EnvironmentId;
}
export function parseSyntheticIdentityId(value: unknown, field = 'SyntheticIdentityId'): SyntheticIdentityId {
  return parseBrandedId('identity', value, field) as SyntheticIdentityId;
}
export function parseCohortId(value: unknown, field = 'CohortId'): CohortId {
  return parseBrandedId('cohort', value, field) as CohortId;
}
export function parseReviewProgramId(value: unknown, field = 'ReviewProgramId'): ReviewProgramId {
  return parseBrandedId('program', value, field) as ReviewProgramId;
}
