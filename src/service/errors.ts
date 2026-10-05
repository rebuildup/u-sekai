/**
 * Service errors for the managed-service control plane (issue #66).
 *
 * ## One error type at the boundary, and what it costs
 *
 * Every rejection a client can provoke — a missing capability, an
 * unmodelled request field, a product nobody registered, an illegal job
 * transition — is a {@link ServiceError} with a `code` from
 * {@link SERVICE_ERROR_CODES}. That is deliberate: a transport adapter
 * (#65's surface) needs one discriminant to map onto one HTTP status,
 * and a caller that has to catch `ProductDomainError`,
 * `ReviewContractError`, `ProgramPlanningError` and
 * `RuntimeIntegrationError` separately cannot build a handler that
 * cannot leak a fifth one.
 *
 * The cost is real and is paid explicitly rather than silently:
 * {@link asServiceError} **re-raises** a cross-layer rejection with its
 * original message, field and `detail` preserved. Nothing is swallowed,
 * and a diagnostic that loses the offending field is a bug in this
 * module, not in the layer that raised it.
 *
 * ## A code is part of the contract
 *
 * `job-not-found` and a findings report that legitimately contains no
 * findings are the same fact to a careless caller — "I asked and there
 * was nothing" — and this project has been bitten by exactly that
 * confusion before. So the *not-found* codes are a distinct, named
 * outcome rather than an empty collection, and
 * `test/integration/service/failure-visibility.test.ts` pins the
 * difference.
 *
 * ## No import of `src/operator/**`
 *
 * This module deliberately does not reference an operator error type.
 * The control plane has no direct edge into the World Operator package
 * at all — see `index.ts` — and an error import would be one.
 */

import { ProductDomainError } from '../product/index.js';
import { ReviewContractError } from '../review/index.js';
import { ProgramPlanningError } from '../program/index.js';
import { RuntimeIntegrationError } from '../runtime/index.js';

export const SERVICE_ERROR_CODES = [
  /** The principal is not entitled to the capability the request needs. */
  'not-authorized',
  /** The request carried a key this API does not declare. */
  'unknown-field',
  /** The request was structurally wrong in a way with no more specific code. */
  'invalid-request',
  /** A caller-supplied id did not belong to the tenant in the request. */
  'tenant-mismatch',
  'product-not-found',
  'environment-not-found',
  'program-not-found',
  /** The named job was never scheduled. Not an empty findings list. */
  'job-not-found',
  'job-already-exists',
  /** The requested status change is not in the job's transition set. */
  'illegal-job-transition',
  /** A concurrent writer advanced the job first. */
  'stale-job-revision',
  /** The trigger is not due. The reason is in `detail.reason`. */
  'not-due',
  /** An idempotency key was replayed with a different request body. */
  'idempotency-conflict',
  'finding-not-found',
  /** #61's transition table refused the disposition move. */
  'illegal-disposition-transition',
  /** `createService` was called without a declared cost unit. */
  'missing-cost-policy',
  /** A registration would redefine an existing entity differently. */
  'duplicate-registration',
  /** The injected executor raised. Never swallowed into a success. */
  'execution-failed',
] as const;

export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];

export class ServiceError extends Error {
  readonly kind: 'service_error' = 'service_error' as const;
  constructor(
    message: string,
    readonly code: ServiceErrorCode,
    /** Dotted path of the offending request field. */
    readonly field?: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export function isServiceError(value: unknown): value is ServiceError {
  return value instanceof ServiceError;
}

/** Every cross-layer error type this boundary is expected to re-raise. */
const CROSS_LAYER = [
  ProductDomainError,
  ReviewContractError,
  ProgramPlanningError,
  RuntimeIntegrationError,
] as const;

/**
 * Re-raise a cross-layer rejection as a {@link ServiceError}.
 *
 * The original message, field and detail survive, so nothing is lost.
 * An error that is not a known cross-layer rejection is **rethrown
 * unchanged** — that is the enforcement. Relabelling an unexpected
 * `Error` as a `ServiceError` would tell a reader the client asked for
 * something impossible when in fact the service is broken, and the
 * rethrow is what stops that from becoming a habit.
 */
export function asServiceError(error: unknown, fallbackField = 'request'): ServiceError {
  if (isServiceError(error)) {
    return error;
  }
  for (const type of CROSS_LAYER) {
    if (error instanceof type) {
      return new ServiceError(error.message, 'invalid-request', error.field ?? fallbackField, {
        cause: error.name,
        ...error.detail,
      });
    }
  }
  throw error;
}

/**
 * Run a cross-layer parser and re-raise whatever it refuses.
 *
 * The boundary form of {@link asServiceError}: every `parse*` call from
 * #57, #61 and #62 in `src/service/**` goes through here, so a rejection
 * is a `ServiceError` on the way out while the message, field and detail
 * that explain it survive. An error that is not a known cross-layer
 * rejection propagates unchanged — see {@link asServiceError}.
 */
export function attempt<T>(fn: () => T, field = 'request'): T {
  try {
    return fn();
  } catch (error) {
    throw asServiceError(error, field);
  }
}

/** Async form of {@link attempt}, for the injected feedback sink. */
export async function attemptAsync<T>(fn: () => Promise<T>, field = 'request'): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw asServiceError(error, field);
  }
}
