/**
 * Provisioning request — the only thing the World Operator accepts
 * (ADR-0011, issue #59).
 *
 * ## Lineage first
 *
 * Every request names the durable scope it acts in before it names any
 * step. `docs/product/configuration-and-authority.md` requires every
 * privileged action to be attributable to Product, Environment, Review
 * Program, Synthetic Identity/Cohort and run identity, and this module
 * makes the first four structurally non-optional: a plan without a
 * lineage cannot be constructed, so an unattributable setup action is
 * unrepresentable rather than merely discouraged.
 *
 * The scope is parsed by #57's `parseEvaluationTargetRef`, so the
 * operator reuses the durable model's identity rules instead of
 * re-implementing them, and keys it with #57's `programKey` rather than
 * hand-rolling a program key.
 *
 * ## `requestId` is declared, never generated
 *
 * There is no id generator anywhere in this package, exactly as #57
 * established for the durable model. `requestId` is a caller-declared
 * idempotency key: the caller that retries a plan after a transport
 * failure supplies the same key, and the operator recognises the retry.
 * If this layer minted the key it could not recognise its own retry, and
 * a re-run would double-provision — which is the one outcome the
 * idempotency requirement exists to prevent.
 *
 * Reusing a `requestId` with a *different* plan is refused rather than
 * replayed. Silently returning the first result would let a caller
 * believe a second, larger plan had been applied.
 */

import { createHash } from 'node:crypto';

import {
  parseEvaluationRunId,
  parseEvaluationTargetRef,
  ProductDomainError,
  programKey,
  type Brand,
  type EnvironmentId,
  type EvaluationRunId,
  type EvaluationTargetRef,
} from '../product/index.js';
import { OperatorError } from './errors.js';
import {
  parseOperatorStep,
  stepConsumesResource,
  stepProducesResource,
  type OperatorStep,
} from './steps.js';
import {
  canonicalJson,
  describeValue,
  optionalString,

  rejectUnknownKeys,
  requireNonEmptyArray,
  requireRecord,
} from './validation.js';

/**
 * Caller-declared idempotency key for one provisioning plan.
 *
 * Scoped to an environment, not global: the same key may legitimately
 * provision a plan in two different environments.
 */
export type ProvisionRequestId = Brand<string, 'ProvisionRequestId'>;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

export function provisionRequestId(value: string): ProvisionRequestId {
  if (!REQUEST_ID_PATTERN.test(value)) {
    throw new OperatorError(
      'invalidRequest',
      'requestId must be 1..128 characters of letters, digits and . _ : @ / -',
      'requestId',
      { received: value },
    );
  }
  return value as ProvisionRequestId;
}

export function parseProvisionRequestId(value: unknown, field = 'requestId'): ProvisionRequestId {
  if (typeof value !== 'string') {
    throw new OperatorError('invalidRequest', `${field} must be a string`, field, {
      received: describeValue(value),
    });
  }
  return provisionRequestId(value);
}

/**
 * The durable scope a setup action is attributable to.
 *
 * `EvaluationTargetRef` carries Product / Environment / Cohort / Review
 * Program; the run id is appended because the runtime that mints run
 * identity owns it, not the durable model (#57, `lineage.ts`).
 */
export interface OperatorLineage extends EvaluationTargetRef {
  readonly runId: EvaluationRunId;
}

const LINEAGE_FIELDS = ['productId', 'environmentId', 'cohortId', 'programId', 'runId'] as const;

export function parseOperatorLineage(input: unknown, field = 'lineage'): OperatorLineage {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, LINEAGE_FIELDS, field);

  let target: EvaluationTargetRef;
  try {
    target = parseEvaluationTargetRef(
      {
        productId: raw['productId'],
        environmentId: raw['environmentId'],
        cohortId: raw['cohortId'],
        programId: raw['programId'],
      },
      field,
    );
  } catch (error) {
    // Re-raise as an operator contract failure so a caller has one error
    // type to handle. The durable model's own diagnostic is preserved in
    // `detail` rather than discarded.
    if (error instanceof ProductDomainError) {
      throw new OperatorError('invalidRequest', error.message, error.field ?? field, {
        ...error.detail,
        origin: 'product_domain_error',
      });
    }
    throw error;
  }

  return Object.freeze({
    ...target,
    runId: parseEvaluationRunId(raw['runId'], `${field}.runId`),
  });
}

export interface ProvisionRequest {
  readonly requestId: ProvisionRequestId;
  readonly lineage: OperatorLineage;
  /** Ordered, non-empty. Applied in order; compensated in reverse. */
  readonly steps: ReadonlyArray<OperatorStep>;
  /** Audit note. Never a secret, never evaluated. */
  readonly reason?: string;
}

const REQUEST_FIELDS = ['requestId', 'lineage', 'steps', 'reason'] as const;

export function parseProvisionRequest(input: unknown, field = 'provisionRequest'): ProvisionRequest {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, REQUEST_FIELDS, field);

  const requestId = parseProvisionRequestId(raw['requestId'], `${field}.requestId`);
  const lineage = parseOperatorLineage(raw['lineage'], `${field}.lineage`);
  const steps = parsePlan(raw['steps'], `${field}.steps`);
  const reason = optionalString(raw['reason'], `${field}.reason`, 500);

  const result: { -readonly [K in keyof ProvisionRequest]: ProvisionRequest[K] } = {
    requestId,
    lineage,
    steps,
  };
  if (reason !== undefined) result.reason = reason;
  return Object.freeze(result);
}

/** Maximum steps in a single plan. Bounds compensation and budget arithmetic. */
export const MAX_PLAN_STEPS = 32;

function parsePlan(value: unknown, field: string): ReadonlyArray<OperatorStep> {
  const arr = requireNonEmptyArray(value, field);
  if (arr.length > MAX_PLAN_STEPS) {
    throw new OperatorError(
      'invalidRequest',
      `${field} must have at most ${MAX_PLAN_STEPS} steps`,
      field,
      { length: arr.length, maxLength: MAX_PLAN_STEPS },
    );
  }
  const steps = arr.map((v, i) => parseOperatorStep(v, `${field}[${i}]`));

  // A step may name a resource only if an *earlier* step produced it.
  // Forward references are refused rather than resolved at dispatch,
  // because a plan whose order is not a property of the plan is a plan
  // whose compensation order is not knowable before it runs.
  //
  // Only *producing* steps must be unique. A consuming step legitimately
  // reuses the key of the producer whose resource it tears down —
  // `account.create` then `account.retire` on one key is how cleanup is
  // written, and treating that pair as a duplicate would make the
  // cleanup lifecycle inexpressible.
  const produced = new Set<string>();
  for (const step of steps) {
    if (stepConsumesResource(step)) {
      if (!produced.has(step.resourceKey)) {
        throw new OperatorError(
          'invalidRequest',
          `${field}: step "${step.kind}" consumes resource "${step.resourceKey}", which no earlier step produces`,
          field,
          { resourceKey: step.resourceKey, kind: step.kind, producedBefore: [...produced].sort() },
        );
      }
      continue;
    }
    if (!stepProducesResource(step)) {
      // A read-only step creates and consumes nothing, so its resource
      // key is a label for the audit record rather than a handle.
      continue;
    }
    if (produced.has(step.resourceKey)) {
      throw new OperatorError(
        'invalidRequest',
        `${field}: resource "${step.resourceKey}" is produced by more than one step`,
        field,
        { resourceKey: step.resourceKey, kind: step.kind },
      );
    }
    produced.add(step.resourceKey);
  }

  return Object.freeze(steps);
}

/**
 * Stable digest of a request's meaning.
 *
 * Three fields are excluded on purpose, and all for the same reason: the
 * digest answers "is this the same *plan*?", and none of them is part of
 * what the plan does to the world.
 *
 * - `requestId` is what selects the journal entry, not what the plan is.
 *   Including it would make a retry look like a different plan.
 * - `runId` is minted by the runtime that executes a run. A caller
 *   retrying after a crashed run re-issues the *same* plan under a *new*
 *   run id, and that retry must be recognised as the same intent.
 * - `reason` is an audit note. It changes nothing about the world, so a
 *   caller that re-issued the same steps with a clearer note is retrying,
 *   not asking for something different. Including it would let a
 *   cosmetic edit turn an idempotent retry into a second provision.
 *
 * Everything that *does* change the world — the durable scope and every
 * step, in order — is inside the digest.
 */
export function requestDigest(request: ProvisionRequest): string {
  const canonical = canonicalJson({
    lineage: {
      productId: request.lineage.productId,
      environmentId: request.lineage.environmentId,
      cohortId: request.lineage.cohortId,
      programId: request.lineage.programId,
    },
    steps: request.steps,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Journal key: an idempotency key scoped to the environment it acts in.
 *
 * The run id is deliberately *not* part of the key. A caller that retries
 * after a crashed run re-issues the plan under a new run id and must still
 * be recognised as the same intent, otherwise the retry double-provisions
 * — which is precisely the failure idempotency exists to prevent.
 */
export function requestJournalKey(environmentId: EnvironmentId, requestId: ProvisionRequestId): string {
  return `${environmentId}|${requestId}`;
}

/** Program scope key, delegated to #57 rather than hand-rolled. */
export function lineageProgramKey(lineage: OperatorLineage): string {
  return programKey(lineage);
}
