/**
 * Setup evidence and the setup-vs-product projection (ADR-0011, issue #59).
 *
 * ## What is recorded
 *
 * Every privileged action is attributable. `docs/product/configuration-and-authority.md`
 * requires Product, Environment, Review Program, Synthetic Identity and
 * run identity *and* "the configured authority that permitted the
 * action". Every record below therefore carries `OperatorLineage` and an
 * `OperatorAuthorityRef`; neither is optional and neither can be filled
 * in after the fact.
 *
 * Records are a closed discriminated union rather than a record with
 * optional fields, so reading one requires handling the case it names —
 * there is no shape in which a `planFailed` record can be read as a
 * `planProvisioned` one.
 *
 * ## The projection, and what it deliberately does not do
 *
 * `src/domain/evidence.ts` is not this ticket's surface and is not
 * edited. Its `runtimeErrors: { ts, where, message }` is too coarse to
 * carry the setup/product split, so this module projects instead:
 *
 * - an `OperatorSetupFailure` projects to `channel: 'runtimeError'`, whose
 *   shape is exactly the existing runtime-error slot. A setup failure is
 *   a runtime error about the evaluation, and belongs beside the other
 *   reasons a run did not complete.
 * - an `OperatorProductFailure` projects to `channel: 'productSignal'`.
 *   It is **not** a reasoner failure and **not** a finding. ADR-0008's
 *   `ReasonerFailureEvidence` is about structured-output defects on the
 *   Reasoner channel; the operator is not that channel, and a product
 *   that refused an account is not a provider that returned bad JSON.
 *
 * Neither branch is a UX finding, and the operator has no channel that
 * could carry one. Widening the shared evidence contract so a setup
 * failure is distinguishable *inside* `BehavioralEvidence` is Issue
 * #72's ticket; `projectOperatorFailure` is the seam it will widen.
 *
 * `test/unit/operator/acceptance-invariants.test.ts` pins the
 * disjointness with `@ts-expect-error`, so if a later edit made a setup
 * projection assignable to a reasoner failure or a finding-shaped value,
 * `npm run typecheck` would fail rather than the corruption shipping.
 */

import type { OperatorAuthorityRef } from './authority.js';
import type {
  OperatorFailure,
  OperatorProductFailure,
  OperatorSetupFailure,
} from './errors.js';
import type { OperatorLineage, ProvisionRequestId } from './request.js';
import type { OperatorStepKind } from './steps.js';

export const OPERATOR_AUDIT_KINDS = [
  'planProvisioned',
  'planDenied',
  'planFailed',
  'planReplayed',
  'stepRolledBack',
  'cleanupCompleted',
] as const;

export type OperatorAuditKind = (typeof OPERATOR_AUDIT_KINDS)[number];

interface OperatorAuditBase {
  /** ISO-8601 instant from the injected clock. */
  readonly ts: string;
  /** Idempotency key the action was issued under. */
  readonly requestId: ProvisionRequestId;
  /** Product / Environment / Cohort / Review Program / run. */
  readonly lineage: OperatorLineage;
  /**
   * Durable program scope, excluding the environment.
   *
   * ADR-0011 names cross-release comparison as a cost of the durable
   * model, and the axis it varies along is *the same program against a
   * different deployment*. #57's `programKey` is that join key, so a
   * release-transition analysis can group every setup action taken
   * across both environments without re-deriving the rule. Delegated
   * rather than re-derived, so it cannot drift from the durable model.
   */
  readonly programScope: string;
  /** The configured authority that permitted the action. */
  readonly authority: OperatorAuthorityRef;
  /** Which connector performed it. Non-secret identity only. */
  readonly connectorId: string;
}

export interface OperatorPlanProvisionedRecord extends OperatorAuditBase {
  readonly kind: 'planProvisioned';
  /** Resource keys the plan left live, in application order. */
  readonly resourceKeys: ReadonlyArray<string>;
  /** Steps actually dispatched. A replayed plan has none. */
  readonly dispatchedSteps: number;
  /** Units charged against the budget. */
  readonly spendUnits: number;
}

export interface OperatorPlanDeniedRecord extends OperatorAuditBase {
  readonly kind: 'planDenied';
  /** Always an `operatorSetup` failure: nothing was dispatched. */
  readonly failure: OperatorSetupFailure;
}

export interface OperatorPlanFailedRecord extends OperatorAuditBase {
  readonly kind: 'planFailed';
  readonly failure: OperatorSetupFailure | OperatorProductFailure;
  readonly appliedResourceKeys: ReadonlyArray<string>;
  readonly releasedResourceKeys: ReadonlyArray<string>;
}

export interface OperatorPlanReplayedRecord extends OperatorAuditBase {
  readonly kind: 'planReplayed';
  /** Digest of the plan that was already applied under this request id. */
  readonly requestDigest: string;
  /** Resource keys left live by the original application. */
  readonly resourceKeys: ReadonlyArray<string>;
}

export interface OperatorStepRolledBackRecord extends OperatorAuditBase {
  readonly kind: 'stepRolledBack';
  readonly stepIndex: number;
  readonly stepKind: OperatorStepKind;
  readonly resourceKey: string;
  /** `false` when compensation failed — the orphaned-state case. */
  readonly released: boolean;
  readonly message: string;
}

export interface OperatorCleanupCompletedRecord extends OperatorAuditBase {
  readonly kind: 'cleanupCompleted';
  readonly releasedResourceKeys: ReadonlyArray<string>;
  /**
   * Resources cleanup could not release. Non-empty means the world still
   * holds state this operator created.
   */
  readonly unresolvedResourceKeys: ReadonlyArray<string>;
}

export type OperatorAuditRecord =
  | OperatorPlanProvisionedRecord
  | OperatorPlanDeniedRecord
  | OperatorPlanFailedRecord
  | OperatorPlanReplayedRecord
  | OperatorStepRolledBackRecord
  | OperatorCleanupCompletedRecord;

/**
 * How a failure leaves the operator layer.
 *
 * The `channel` discriminant is the load-bearing part: a reader routes on
 * it, and the two branches carry different, non-overlapping payloads, so
 * a setup failure cannot be mistaken for a product signal downstream.
 */
export type OperatorFailureProjection =
  | {
      readonly channel: 'runtimeError';
      /** Shape-compatible with `BehavioralEvidence['runtimeErrors'][number]`. */
      readonly ts: string;
      readonly where: string;
      readonly message: string;
      /** The full, non-coarse operator failure behind the three fields above. */
      readonly setupFailure: OperatorSetupFailure;
    }
  | {
      readonly channel: 'productSignal';
      readonly ts: string;
      readonly where: string;
      readonly productCode: string;
      readonly productFailure: OperatorProductFailure;
    };

/**
 * Project an operator failure into the channel it belongs to.
 *
 * The setup branch is deliberately a *runtime* error and not a
 * reasoner failure: ADR-0008's reasoner taxonomy covers structured-output
 * defects on the Reasoner channel, and folding provisioning failures into
 * it would misattribute an environment problem to a model provider.
 */
export function projectOperatorFailure(failure: OperatorFailure): OperatorFailureProjection {
  if (failure.subject === 'operatorSetup') {
    return Object.freeze({
      channel: 'runtimeError' as const,
      ts: failure.ts,
      where: failure.where,
      message: failure.message,
      setupFailure: failure,
    });
  }
  return Object.freeze({
    channel: 'productSignal' as const,
    ts: failure.ts,
    where: failure.where,
    productCode: failure.productCode,
    productFailure: failure,
  });
}

/** Whether a projection is a setup failure rather than a product observation. */
export function isSetupProjection(
  projection: OperatorFailureProjection,
): projection is Extract<OperatorFailureProjection, { channel: 'runtimeError' }> {
  return projection.channel === 'runtimeError';
}
