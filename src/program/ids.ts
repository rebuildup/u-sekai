/**
 * Planning-layer identifiers and the canonical key encoding (issue #62).
 *
 * ## Two keys, two jobs
 *
 * - `IdempotencyKey` answers *"has this exact trigger already been
 *   planned?"*. It is scoped to one logical trigger occurrence.
 * - `PlanKey` answers *"what is the run identity of this evaluation?"*.
 *   It is derived from the idempotency key **plus** the durable target
 *   (program, environment, cohort), so two different targets can never
 *   collide on a trigger-derived key.
 *
 * Both are produced by pure functions from the trigger's *semantic*
 * identity — the cadence slot, the event's own delivery id, the manual
 * request's delivery id — and never from a wall clock reading or an
 * arrival timestamp. That is what makes redelivery detectable instead of
 * merely observable.
 *
 * ## Canonical encoding
 *
 * `canonicalKey` length-prefixes every component, so no component can
 * forge a separator and make two different key vectors encode to the
 * same string. Without the prefix, `[a, 'b|c']` and `[a|b, c]` would
 * both render as `a|b|c` and two distinct triggers would share an
 * idempotency key — a silent double-charge.
 */

import { Brand } from '../product/index.js';
import { ProgramPlanningError } from './errors.js';

export type TriggerDeliveryId = Brand<string, 'TriggerDeliveryId'>;
export type ObservationId = Brand<string, 'ObservationId'>;
export type EnvironmentVersion = Brand<string, 'EnvironmentVersion'>;
export type AuthorityRef = Brand<string, 'AuthorityRef'>;
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>;
export type PlanKey = Brand<string, 'PlanKey'>;

/** Maximum length of any opaque handle carried in a plan. */
export const MAX_HANDLE_LENGTH = 256;

/**
 * Delivery id grammar. Deliberately the same shape as #57's
 * `EvaluationRunId` / `EvidenceId` handles: a transport-assigned opaque
 * handle (a queue message id, a webhook delivery id, a
 * `requestId` a person clicked with).
 */
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const OBSERVATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

/**
 * Environment *version* label. This is observation metadata describing
 * which build an environment was serving when it was looked at — not
 * environment identity.
 *
 * ADR-0011 is explicit that a deployment, release identifier or source
 * diff is a *trigger or explanatory metadata*, not the review target, and
 * `src/product/environment.ts` deliberately declares no Git-shaped field
 * for exactly that reason. Recording which version was observed is the
 * sanctioned lineage join for release-transition comparison; modelling
 * a version *as* the environment is what ADR-0011 forbids, and this
 * module does not do it.
 */
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** Authority grant handle. Owned and resolved by #59 (`src/operator/**`). */
const AUTHORITY_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

/** Idempotency / plan key prefix, as produced by this module. */
const IDEMPOTENCY_KEY_PATTERN = /^ik_[A-Za-z0-9._:@|=-]+$/;
const PLAN_KEY_PATTERN = /^pk_[A-Za-z0-9._:@|=-]+$/;

export function parseTriggerDeliveryId(value: unknown, field = 'deliveryId'): TriggerDeliveryId {
  return requireHandle(value, field, DELIVERY_ID_PATTERN, 'TriggerDeliveryId') as TriggerDeliveryId;
}

export function parseObservationId(value: unknown, field = 'observationId'): ObservationId {
  return requireHandle(value, field, OBSERVATION_ID_PATTERN, 'ObservationId') as ObservationId;
}

export function parseEnvironmentVersion(value: unknown, field = 'version'): EnvironmentVersion {
  return requireHandle(value, field, VERSION_PATTERN, 'EnvironmentVersion') as EnvironmentVersion;
}

/**
 * Reference an authority grant owned by the World Operator boundary.
 *
 * Opaque by construction: this layer carries the handle so a plan can
 * state *which* grants it was planned under, and never resolves it. A
 * plan that could resolve its own authority could be replayed with
 * different grants, which is the failure ADR-0011's authority model
 * exists to prevent.
 */
export function parseAuthorityRef(value: unknown, field = 'authorityRef'): AuthorityRef {
  return requireHandle(value, field, AUTHORITY_REF_PATTERN, 'AuthorityRef') as AuthorityRef;
}

export function parseIdempotencyKey(value: unknown, field = 'idempotencyKey'): IdempotencyKey {
  return requireHandle(value, field, IDEMPOTENCY_KEY_PATTERN, 'IdempotencyKey') as IdempotencyKey;
}

export function parsePlanKey(value: unknown, field = 'planKey'): PlanKey {
  return requireHandle(value, field, PLAN_KEY_PATTERN, 'PlanKey') as PlanKey;
}

/*
 * Declaration helpers, mirroring #57's `productId()` / `environmentId()`.
 *
 * These validate a value the caller *authored*; they do not generate one.
 * As in `src/product/ids.ts`, nothing here mints an identity, so a plan's
 * ids are always traceable to a declaration and never silently
 * regenerated.
 */

export function observationId(value: string): ObservationId {
  return requireHandle(value, 'observationId', OBSERVATION_ID_PATTERN, 'ObservationId') as ObservationId;
}

export function environmentVersion(value: string): EnvironmentVersion {
  return requireHandle(value, 'version', VERSION_PATTERN, 'EnvironmentVersion') as EnvironmentVersion;
}

export function triggerDeliveryId(value: string): TriggerDeliveryId {
  return requireHandle(value, 'deliveryId', DELIVERY_ID_PATTERN, 'TriggerDeliveryId') as TriggerDeliveryId;
}

export function authorityRef(value: string): AuthorityRef {
  return requireHandle(value, 'authorityRef', AUTHORITY_REF_PATTERN, 'AuthorityRef') as AuthorityRef;
}

function requireHandle(
  value: unknown,
  field: string,
  pattern: RegExp,
  typeName: string,
): string {
  if (typeof value !== 'string') {
    throw new ProgramPlanningError(`${field} must be a string`, field, {
      typeName,
      received: describeReceived(value),
    });
  }
  if (value.length === 0 || value.length > MAX_HANDLE_LENGTH) {
    throw new ProgramPlanningError(
      `${field} must be between 1 and ${MAX_HANDLE_LENGTH} characters`,
      field,
      { typeName, length: value.length },
    );
  }
  if (!pattern.test(value)) {
    throw new ProgramPlanningError(`${field} must be a valid ${typeName} handle`, field, {
      typeName,
      received: value,
    });
  }
  return value;
}

function describeReceived(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Length-prefixed, order-significant encoding of key components.
 *
 * Every component is rendered as `<utf16Length>:<component>`, so a
 * component containing `|` cannot imitate the separator. Two different
 * component vectors can therefore never produce the same string.
 */
export function canonicalKey(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('|');
}

export function idempotencyKey(parts: readonly string[]): IdempotencyKey {
  return `ik_${canonicalKey(parts)}` as IdempotencyKey;
}

export function planKeyFrom(parts: readonly string[]): PlanKey {
  return `pk_${canonicalKey(parts)}` as PlanKey;
}
