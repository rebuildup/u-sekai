/**
 * Errors for the durable cohort / identity state store (ADR-0011, issue #60).
 *
 * ## Why this is a subclass rather than a new hierarchy
 *
 * #57 established `ProductDomainError` as the single error type of the
 * durable product model. A second, parallel hierarchy would force every
 * caller to catch two types for one class of failure, so `CohortStateError`
 * *extends* `ProductDomainError`: `instanceof ProductDomainError` keeps
 * working for code written against #57, and `instanceof CohortStateError`
 * narrows to persistence failures.
 *
 * The inherited `kind` discriminant is deliberately left as
 * `'product_domain_error'`. A corrupt cohort record *is* a product domain
 * error; overriding the discriminant with a second literal would have made
 * the two types structurally incompatible and would have required every
 * `catch` written against #57 to change. The narrower signal is
 * `code`, which is also mirrored into `detail` so it survives being
 * serialised across a process boundary.
 */

import { ProductDomainError } from '../product/errors.js';

/**
 * Why a durable state operation failed.
 *
 * Every one of these is a *loud* failure. The acceptance criterion this
 * module exists to satisfy is "corrupt/stale state fails explicitly rather
 * than silently creating a new identity" — so there is deliberately no
 * `recovered` / `reset` / `defaultsApplied` code. Nothing in this module
 * repairs damaged state on the way in; a repair path is a migration
 * (see `record.ts`), which is explicit, versioned and auditable.
 */
export const COHORT_STATE_ERROR_CODES = [
  /** Stored bytes were not valid JSON, or were not a record object. */
  'corrupt_record',
  /** The record declares a schema version this build cannot interpret. */
  'unsupported_schema_version',
  /** No registered migration bridges the stored version to the current one. */
  'missing_migration',
  /** A record was filed under a key whose contents disagree with the key. */
  'key_mismatch',
  /** The record's `kind` is not one this build persists. */
  'unknown_record_kind',
  /** A lookup named an identity the store does not hold. */
  'identity_not_found',
  /** A lookup named a cohort the store does not hold. */
  'cohort_not_found',
  /** Persisted content does not match the digest recorded alongside it. */
  'integrity_mismatch',
  /** The operation is not legal for the identity's lifecycle or status. */
  'invalid_transition',
  /**
   * A write supplied an `expectedRevision` the stored record has moved
   * past.
   *
   * Separate from `invalid_transition` because the two call for
   * different responses. A lifecycle violation is a bug in the caller
   * that will recur however often it is retried; a revision conflict
   * means the record moved, which is information the caller can act on.
   * Collapsing them into one code forces a caller that must handle a
   * conflict to also catch every malformed transition.
   */
  'revision_conflict',
  /** An existing record was overwritten through a create-only path. */
  'already_exists',
  /** A cohort's membership rule cannot be satisfied by the stored identities. */
  'membership_unsatisfiable',
] as const;

export type CohortStateErrorCode = (typeof COHORT_STATE_ERROR_CODES)[number];

export class CohortStateError extends ProductDomainError {
  /** Narrower than the inherited `kind`; see the module docstring. */
  readonly code: CohortStateErrorCode;

  constructor(
    code: CohortStateErrorCode,
    message: string,
    field?: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message, field, { ...detail, code });
    this.name = 'CohortStateError';
    this.code = code;
  }
}

export function isCohortStateError(value: unknown): value is CohortStateError {
  return value instanceof CohortStateError;
}
