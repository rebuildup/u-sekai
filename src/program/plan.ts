/**
 * `EvaluationPlan` — the deterministic description of one bounded
 * evaluation (ADR-0011, issue #62).
 *
 * ## A plan is a pure function of its inputs
 *
 * A plan carries **no wall-clock creation stamp**. It records `dueAt` —
 * the semantic instant of the trigger occurrence, derived from the
 * cadence slot, the debounce end or the manual request — and nothing
 * that depends on when the planner was invoked.
 *
 * This is what makes the plan deterministic. If the plan carried
 * `createdAt`, then planning the same trigger at 10:00:01 and again at
 * 10:00:02 would produce two *different* plans for the same logical
 * evaluation, and a caller could no longer assert "identical inputs
 * produce an identical plan" — nor could a downstream store dedupe on
 * anything but the key. Attempt wall-clock is transport/ledger
 * metadata (`BudgetLedger.keyPlannedAt`) and lives outside the plan.
 *
 * ## Run identity
 *
 * `planKey` is the unambiguous identity of the evaluation, derived
 * deterministically from the trigger's idempotency key plus the durable
 * target. Two redeliveries of one trigger yield one `planKey`; two
 * *different* targets driven by the same trigger yield different
 * `planKey`s. There is no third possibility, because the derivation
 * has no inputs beyond those.
 *
 * ## The envelope is a ceiling, not a permission
 *
 * `budget` and `authority` are upper bounds. `authority.operatorAuthorityRefs`
 * are opaque handles owned by the World Operator boundary (#59,
 * `src/operator/**`) and are never resolved here — a planner that could
 * resolve its own authority could be replayed under different grants.
 * The runtime (#63) enforces the tighter of this envelope and each
 * identity's own capability bounds.
 */

import {
  CohortId,
  CohortMembershipIntent,
  EnvironmentId,
  EvaluationTargetRef,
  ProductId,
  ReviewProgramId,
  ReviewTriggerKind,
  StateRetention,
} from '../product/index.js';
import { ProgramPlanningError } from './errors.js';
import { AuthorityRef, IdempotencyKey, PlanKey, TriggerDeliveryId } from './ids.js';
import { EnvironmentObservation, VersionLineage } from './observation.js';

/** ADR-0011's three evaluation modes. */
export const EVALUATION_MODES = ['continuous', 'releaseTransition', 'pointInTime'] as const;
export type EvaluationMode = (typeof EVALUATION_MODES)[number];

/**
 * How a plan's participant state retention was bounded.
 *
 * - `cohort-lifecycle` — the cohort's membership intent names a
 *   lifecycle, so the ceiling follows from it.
 * - `per-identity-at-runtime` — an `explicit` membership names
 *   identities but not their lifecycles, and resolving them is #60's
 *   ticket. The plan then carries the global ceiling and the runtime
 *   narrows it per identity.
 */
export const RETENTION_RESOLUTIONS = ['cohort-lifecycle', 'per-identity-at-runtime'] as const;
export type RetentionResolution = (typeof RETENTION_RESOLUTIONS)[number];

/** Why a trigger occurrence lost to a higher-precedence one. */
export interface SuppressedTrigger {
  readonly kind: ReviewTriggerKind;
  readonly dueAt: string;
  readonly reason: 'superseded-by-higher-precedence';
  readonly deliveryId?: TriggerDeliveryId;
}

/** What actually triggered the plan. */
export type PlanTrigger =
  | {
      readonly kind: 'cadence';
      /** Cadence slot instant — identical for every attempt in the slot. */
      readonly dueAt: string;
      readonly intervalMinutes: number;
      readonly timeZone: string;
    }
  | {
      readonly kind: 'event';
      /** Debounce end: `occurredAt + debounceMinutes`. */
      readonly dueAt: string;
      readonly deliveryId: TriggerDeliveryId;
      readonly event: string;
      readonly debounceMinutes: number;
    }
  | {
      readonly kind: 'manual';
      readonly dueAt: string;
      readonly deliveryId: TriggerDeliveryId;
    };

/** Which cohort members the plan covers, and how that was decided. */
export interface CohortSelection {
  readonly cohortId: CohortId;
  /**
   * The declared membership intent, carried as a *reference*.
   *
   * The plan does not resolve it. `explicit` identity lists are
   * references to identities the plan has no authority over, and
   * `byLifecycle` / `sizeTarget` are selection rules whose resolution
   * is #60's ticket (`src/cohort/**`). Carrying the rule keeps the plan
   * auditable without the planner holding privileged state.
   */
  readonly membership: CohortMembershipIntent;
  /**
   * Identities implied by the declaration, or `null` when the
   * declaration does not determine a count (`byLifecycle`).
   */
  readonly declaredIdentityCount: number | null;
  /** The declared per-plan cap. Always the bound that cost is charged against. */
  readonly planningCeiling: number;
  /** `min(declaredIdentityCount ?? ceiling, ceiling)`. */
  readonly plannedIdentities: number;
}

/** cheap-scout -> verification escalation, as a plan representation. */
export interface EscalationPolicy {
  readonly kind: 'cheapScoutThenVerification';
  /** Identities permitted to escalate. Bounded by `plannedIdentities`. */
  readonly maxVerifications: number;
  /** Cost reserved for escalation whether or not it is used. */
  readonly verificationCostUnits: number;
  /**
   * True: escalation is a stage of this run, so it is already paid for
   * in `budget.costUnits` and cannot charge again.
   */
  readonly reservedUpFront: true;
}

export interface PlanBudget {
  /** Total reserved against the daily ceiling. See `cost.ts`. */
  readonly costUnits: number;
  readonly scoutCostUnits: number;
  readonly verificationCostUnits: number;
  readonly maxRunsPerDay: number;
  readonly maxRunsPerEvent: number;
  readonly maxCostUnitsPerDay: number;
}

export interface AuthorityEnvelope {
  /** Opaque grants owned by #59. Never resolved by this layer. */
  readonly operatorAuthorityRefs: ReadonlyArray<AuthorityRef>;
  /** Origins the plan is scoped to, derived from the target environment. */
  readonly environmentOrigins: ReadonlyArray<string>;
  readonly maxParticipantStateRetention: StateRetention;
  readonly retentionResolution: RetentionResolution;
  /** Declared ceiling on environment-mutating actions. */
  readonly maxMutatingActions: number;
}

export interface EvaluationPlan {
  /** Unambiguous run identity. Deterministic; see the module docstring. */
  readonly planKey: PlanKey;
  /** Trigger-scoped deduplication key. */
  readonly idempotencyKey: IdempotencyKey;
  readonly mode: EvaluationMode;
  /** The durable target this plan observes. */
  readonly target: EvaluationTargetRef;
  readonly trigger: PlanTrigger;
  readonly cohort: CohortSelection;
  readonly escalation: EscalationPolicy;
  readonly budget: PlanBudget;
  readonly authority: AuthorityEnvelope;
  /** Present exactly when `mode` is `releaseTransition`. */
  readonly lineage?: VersionLineage;
  /** The version the target environment was observed at, when known. */
  readonly observedVersion?: EnvironmentObservation;
}

export interface EvaluationPlanInit {
  readonly planKey: PlanKey;
  readonly idempotencyKey: IdempotencyKey;
  readonly mode: EvaluationMode;
  readonly productId: ProductId;
  readonly environmentId: EnvironmentId;
  readonly cohortId: CohortId;
  readonly programId: ReviewProgramId;
  readonly trigger: PlanTrigger;
  readonly cohort: CohortSelection;
  readonly escalation: EscalationPolicy;
  readonly budget: PlanBudget;
  readonly authority: AuthorityEnvelope;
  readonly lineage?: VersionLineage;
  readonly observedVersion?: EnvironmentObservation;
}

/** Assemble a frozen plan from already-computed parts. */
export function buildEvaluationPlan(init: EvaluationPlanInit): EvaluationPlan {
  if (init.mode === 'releaseTransition' && init.lineage === undefined) {
    throw new ProgramPlanningError(
      'a releaseTransition plan must carry version lineage',
      'plan.lineage',
      { mode: init.mode },
    );
  }
  if (init.mode !== 'releaseTransition' && init.lineage !== undefined) {
    throw new ProgramPlanningError(
      `version lineage is only meaningful for a releaseTransition plan, not ${init.mode}`,
      'plan.lineage',
      { mode: init.mode },
    );
  }
  if (init.escalation.maxVerifications > init.cohort.plannedIdentities) {
    throw new ProgramPlanningError(
      'escalation.maxVerifications must not exceed cohort.plannedIdentities',
      'plan.escalation.maxVerifications',
      {
        maxVerifications: init.escalation.maxVerifications,
        plannedIdentities: init.cohort.plannedIdentities,
      },
    );
  }

  const target: EvaluationTargetRef = Object.freeze({
    productId: init.productId,
    environmentId: init.environmentId,
    cohortId: init.cohortId,
    programId: init.programId,
  });

  const plan: { -readonly [K in keyof EvaluationPlan]: EvaluationPlan[K] } = {
    planKey: init.planKey,
    idempotencyKey: init.idempotencyKey,
    mode: init.mode,
    target,
    trigger: init.trigger,
    cohort: init.cohort,
    escalation: init.escalation,
    budget: init.budget,
    authority: init.authority,
  };
  if (init.lineage !== undefined) {
    plan.lineage = init.lineage;
  }
  if (init.observedVersion !== undefined) {
    plan.observedVersion = init.observedVersion;
  }
  return Object.freeze(plan);
}
