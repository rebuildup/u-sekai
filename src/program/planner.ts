/**
 * The Review Program planner — decide whether an evaluation is due, and
 * if so emit a bounded, deterministic plan (ADR-0011, issue #62).
 *
 * ## One function, one decision
 *
 * `planEvaluation` is a pure function of
 * `(model, programId, now, signals, observations, policy)`. It registers
 * no timer, opens no queue, contacts no provider and reads no secret. A
 * caller may invoke it on a schedule, from a webhook handler, or twice
 * in the same millisecond; the answer differs only where the inputs do.
 * "No real queue or cron service is required here" (issue #62) is
 * satisfied by the shape, not by a comment.
 *
 * ## Order of decisions, and why it is this order
 *
 * 1. **Is anything due at all?** No candidate and no pending debounce
 *    is `not-due: no-trigger`.
 * 2. **Has the debounce elapsed?** An event inside its quiet period is
 *    `not-due: debounce-pending` with the instant it becomes evaluable.
 * 3. **Is the requested mode satisfiable?** A caller asking for a
 *    release transition without a real transition is
 *    `not-due: release-transition-lineage-missing` — reported, never
 *    silently downgraded to a continuous plan.
 * 4. **Only then, may work start?** A reservation is attempted, and the
 *    plan is emitted *only* if it is granted.
 *
 * Steps 1–3 never touch the ledger, so a plan that cannot be run for
 * structural reasons is not charged for finding that out. Step 4 is
 * the enforcement point: a denied reservation means no plan object
 * exists, so there is nothing for a caller to execute.
 *
 * ## Mode derivation
 *
 * When the caller does not state a mode, it is derived from the
 * evidence, in this order:
 *
 * - real version lineage available -> `releaseTransition`
 * - the winning trigger is `manual` -> `pointInTime`
 * - otherwise -> `continuous`
 *
 * The derivation is total and stated rather than implied, so "why is
 * this plan continuous?" has an answer that does not depend on reading
 * the code. A caller that knows it needs a release transition says so
 * via `requestedMode`, and is told when the evidence does not support
 * it instead of being given a differently-shaped plan.
 *
 * ## Cohort size is bounded by declaration, never by resolution
 *
 * The plan charges cost against `min(declaredCount ?? ceiling,
 * ceiling)`. An `explicit` cohort's count and a `sizeTarget`'s size are
 * known from the declaration; a `byLifecycle` cohort's count is not, and
 * resolving it is #60's ticket. An unresolvable cohort is therefore
 * charged as if it had exactly the declared per-plan ceiling, which
 * keeps the reservation bounded and deterministic. The plan records
 * which of the two it was, so the estimate is auditable.
 *
 * ## Re-entrancy
 *
 * The escalation path (scout -> verification) has no access to the
 * ledger. Escalation is a stage of the run that was already charged in
 * full at plan time, so it cannot release, refund or re-charge
 * anything. Re-presenting a trigger reaches `reserve`, which refuses it
 * as a duplicate and returns the ledger untouched.
 */

import {
  CohortMembershipIntent,
  Environment,
  EnvironmentId,
  EvaluationTargetRef,
  ProductModel,
  ReviewProgram,
  ReviewProgramId,
  IdentityLifecycle,
  RetentionForLifecycle,
  StateRetention,
  SyntheticCohort,
  environmentOrigins,
  findCohort,
  findEnvironment,
  findProgram,
  programKey,
} from '../product/index.js';
import { requireInteger, requireIsoInstant } from '../product/validation.js';
import {
  BudgetLedger,
  assertLedgerMatchesProgram,
  createBudgetLedger,
  defaultBudgetWindow,
  ledgerPlannedAt,
  remainingCostUnits,
  remainingRuns,
  reserve,
} from './budget.js';
import { StageCostRates, parseStageCostRates, planCost } from './cost.js';
import { ProgramPlanningError } from './errors.js';
import { AuthorityRef, PlanKey, planKeyFrom, parseAuthorityRef } from './ids.js';
import {
  EnvironmentObservation,
  LINEAGE_GAP_EXPLANATIONS,
  parseEnvironmentObservations,
  resolveVersionLineage,
  sortObservations,
} from './observation.js';
import {
  AuthorityEnvelope,
  CohortSelection,
  EVALUATION_MODES,
  EvaluationMode,
  EvaluationPlan,
  PlanTrigger,
  RetentionResolution,
  SuppressedTrigger,
  buildEvaluationPlan,
} from './plan.js';
import {
  TriggerCandidate,
  TriggerSignal,
  parseTriggerSignals,
  resolveTriggers,
} from './trigger.js';

/** Hard module ceilings. A caller may ask for less, never for more. */
const MAX_RETENTION_BY_LIFECYCLE: {
  readonly [L in IdentityLifecycle]: RetentionForLifecycle<L>;
} = Object.freeze({
  ephemeral: 'none',
  release: 'durable',
  persistent: 'durable',
});

export const MAX_IDENTITIES_PER_PLAN = 1_000;
export const MAX_MUTATING_ACTIONS_PER_PLAN = 200;
export const MAX_VERIFICATIONS_PER_PLAN = 200;

export const NOT_DUE_REASONS = [
  'no-trigger',
  'debounce-pending',
  'release-transition-lineage-missing',
  'budget-exhausted',
] as const;

export type NotDueReason = (typeof NOT_DUE_REASONS)[number];

export interface PlanEvaluationInput {
  /** The durable model the program and its references resolve in. */
  readonly model: ProductModel;
  readonly programId: ReviewProgramId;
  /** Planning instant. Never stored on the plan. */
  readonly now: string;
  /** Delivered event / manual signals. Cadence is derived, not delivered. */
  readonly signals?: ReadonlyArray<TriggerSignal>;
  /** Environment observations available for version lineage. */
  readonly observations?: ReadonlyArray<EnvironmentObservation>;
  /** Declared cap on identities per plan. 1..MAX_IDENTITIES_PER_PLAN. */
  readonly planningCeiling: number;
  /** Declared, provider-neutral cost rates. */
  readonly rates: StageCostRates;
  /** Opaque authority grants from the World Operator boundary (#59). */
  readonly operatorAuthorityRefs?: ReadonlyArray<AuthorityRef>;
  /** Declared cap on environment-mutating actions. 0..MAX_MUTATING_ACTIONS_PER_PLAN. */
  readonly maxMutatingActions: number;
  /** Pins the evaluation mode instead of deriving it. */
  readonly requestedMode?: EvaluationMode;
  /** Durable spend memory. A fresh ledger is created when absent. */
  readonly ledger?: BudgetLedger;
}

export type PlanDecision =
  | {
      readonly outcome: 'due';
      readonly plan: EvaluationPlan;
      readonly suppressed: ReadonlyArray<SuppressedTrigger>;
      /** The ledger *after* the reservation. Commit this. */
      readonly ledger: BudgetLedger;
    }
  | {
      /**
       * The trigger was already planned. `planKey` is the identity of
       * that existing evaluation; nothing was charged.
       */
      readonly outcome: 'duplicate';
      readonly planKey: PlanKey;
      readonly idempotencyKey: string;
      readonly firstPlannedAt: string;
      readonly suppressed: ReadonlyArray<SuppressedTrigger>;
      /** The ledger passed in, unchanged. */
      readonly ledger: BudgetLedger;
    }
  | {
      readonly outcome: 'not-due';
      readonly reason: NotDueReason;
      readonly suppressed: ReadonlyArray<SuppressedTrigger>;
      /** What made this not-due, in operator-readable detail. */
      readonly detail: Readonly<Record<string, unknown>>;
      /** When the next decision point is, when one is known. */
      readonly nextDueAt?: string;
      /** The ledger passed in, unchanged. */
      readonly ledger: BudgetLedger;
    };

/**
 * Decide whether `programId` is due for evaluation at `now`, and if so
 * emit the plan.
 */
export function planEvaluation(input: PlanEvaluationInput): PlanDecision {
  const program = requireProgram(input);
  const now = requireIsoInstant(input.now, 'input.now');
  const nowMs = Date.parse(now);
  const ceiling = requireInteger(
    input.planningCeiling,
    'input.planningCeiling',
    1,
    MAX_IDENTITIES_PER_PLAN,
  );
  const maxMutatingActions = requireInteger(
    input.maxMutatingActions,
    'input.maxMutatingActions',
    0,
    MAX_MUTATING_ACTIONS_PER_PLAN,
  );
  const rates = parseStageCostRates(input.rates, 'input.rates');
  const signals = parseTriggerSignals(input.signals, 'input.signals');
  const observations = parseEnvironmentObservations(input.observations, 'input.observations');
  const authorityRefs = parseAuthorityRefs(input.operatorAuthorityRefs);
  if (input.requestedMode !== undefined && !EVALUATION_MODES.includes(input.requestedMode)) {
    throw new ProgramPlanningError(
      `input.requestedMode must be one of: ${EVALUATION_MODES.join(', ')}`,
      'input.requestedMode',
      { received: input.requestedMode },
    );
  }

  const ledger = input.ledger ?? createBudgetLedger(program.id, program.budget, defaultBudgetWindow(now));
  assertLedgerMatchesProgram(ledger, program.id);

  // 1 + 2. Is anything due?
  const resolution = resolveTriggers(program, signals, nowMs);
  if (resolution.candidates.length === 0) {
    if (resolution.pendingEvents.length > 0) {
      return notDue({
        reason: 'debounce-pending',
        detail: {
          pending: resolution.pendingEvents,
          explanation: 'a matching event is inside its declared debounce window',
        },
        nextDueAt: earliest(resolution.pendingEvents.map((p) => p.dueAt)),
        ledger,
      });
    }
    return notDue({
      reason: 'no-trigger',
      detail: {
        declaredTriggers: program.triggers.map((t) => t.kind),
        deliveredSignals: signals.map((s) => s.kind),
      },
      nextDueAt: resolution.nextCadenceDueAt,
      ledger,
    });
  }

  const winner = resolution.candidates[0];
  if (winner === undefined) {
    throw new ProgramPlanningError('trigger resolution produced no winner', 'input.signals');
  }
  const suppressed = toSuppressed(resolution.candidates.slice(1));

  // Observations are scoped to the environments this program declares.
  //
  // Lineage is resolved across *all* of them, not just the target: per
  // #57's `programKey` the environment is the axis a release transition
  // varies along, so the "previous" observation usually lives in a
  // different environment than the one about to be evaluated.
  const inScope = observationsInScope(program, observations);
  const environmentId = resolveEnvironmentId(program, inScope);
  const environment = findEnvironment(input.model, environmentId);
  if (environment === undefined) {
    throw new ProgramPlanningError(
      `program ${program.id}: environment ${environmentId} is not in this model`,
      'program.environmentIds',
      { missing: environmentId },
    );
  }

  const currentObservation = sortObservations(inScope)[inScope.length - 1];
  const lineageResolution = resolveVersionLineage(inScope);

  // 3. Is the requested mode satisfiable?
  const mode = resolveMode(input.requestedMode, winner, lineageResolution.ok);
  if (mode === 'releaseTransition' && !lineageResolution.ok) {
    return notDue({
      reason: 'release-transition-lineage-missing',
      detail: {
        gap: lineageResolution.gap,
        explanation: LINEAGE_GAP_EXPLANATIONS[lineageResolution.gap],
        observedVersions: sortObservations(inScope).map((o) => ({
          environmentId: o.environmentId,
          version: o.version,
          observedAt: o.observedAt,
        })),
      },
      suppressed,
      ledger,
    });
  }
  const lineage = lineageResolution.ok ? lineageResolution.lineage : undefined;

  const cohort = findCohort(input.model, program.cohortId);
  if (cohort === undefined) {
    throw new ProgramPlanningError(
      `program ${program.id}: cohort ${program.cohortId} is not in this model`,
      'program.cohortId',
      { missing: program.cohortId },
    );
  }

  const selection = buildCohortSelection(cohort, ceiling);
  const maxVerifications = Math.min(selection.plannedIdentities, MAX_VERIFICATIONS_PER_PLAN);
  const cost = planCost(selection.plannedIdentities, maxVerifications, rates);

  const target: EvaluationTargetRef = {
    productId: program.productId,
    environmentId,
    cohortId: program.cohortId,
    programId: program.id,
  };
  // The program-scope component is #57's `programKey`, not a local
  // re-listing of the same three ids: if #57 ever changes what defines
  // a program's scope, this key follows it instead of drifting.
  const planKey = planKeyFrom([winner.idempotencyKey, programKey(target), environmentId]);
  const trigger = buildPlanTrigger(program, winner);

  const plan = buildEvaluationPlan({
    planKey,
    idempotencyKey: winner.idempotencyKey,
    mode,
    ...target,
    trigger,
    cohort: selection,
    escalation: {
      kind: 'cheapScoutThenVerification',
      maxVerifications,
      verificationCostUnits: cost.verificationCostUnits,
      reservedUpFront: true,
    },
    budget: {
      costUnits: cost.totalCostUnits,
      scoutCostUnits: cost.scoutCostUnits,
      verificationCostUnits: cost.verificationCostUnits,
      maxRunsPerDay: program.budget.maxRunsPerDay,
      maxRunsPerEvent: program.budget.maxRunsPerEvent,
      maxCostUnitsPerDay: program.budget.maxCostUnitsPerDay,
    },
    authority: buildAuthorityEnvelope(environment, authorityRefs, cohort, maxMutatingActions),
    ...(lineage !== undefined ? { lineage } : {}),
    ...(currentObservation !== undefined ? { observedVersion: currentObservation } : {}),
  });

  // 4. Enforcement. No plan is emitted unless the reservation is
  // granted, so a denied budget stops evaluation rather than reporting
  // the overrun after the fact.
  const deliveryScope = winner.deliveryId ?? `cadence:${winner.dueAt}`;
  const result = reserve(
    ledger,
    { costUnits: cost.totalCostUnits, runs: 1, deliveryId: deliveryScope, at: now },
    { idempotencyKey: winner.idempotencyKey, planKey },
  );

  if (result.granted) {
    return Object.freeze({
      outcome: 'due',
      plan,
      suppressed,
      ledger: result.ledger,
    });
  }

  if (result.reason === 'duplicate-trigger') {
    const firstPlannedAt = ledgerPlannedAt(ledger, winner.idempotencyKey);
    return Object.freeze({
      outcome: 'duplicate',
      planKey,
      idempotencyKey: winner.idempotencyKey,
      firstPlannedAt: firstPlannedAt ?? winner.dueAt,
      suppressed,
      ledger,
    });
  }

  return notDue({
    reason: 'budget-exhausted',
    detail: {
      denial: result.reason,
      requestedCostUnits: cost.totalCostUnits,
      remainingCostUnits: remainingCostUnits(ledger),
      remainingRuns: remainingRuns(ledger),
      spentCostUnits: ledger.costUnitsSpent,
      spentRuns: ledger.runsSpent,
      window: ledger.window,
    },
    suppressed,
    ledger,
  });
}

/**
 * Build a `not-due` decision.
 *
 * Every one of these means "no plan was emitted, and the ledger was not
 * charged", which is why they share a constructor: a caller reading
 * `outcome` should never have to check which of them additionally
 * mutated something.
 */
function notDue(input: {
  readonly reason: NotDueReason;
  readonly detail: Record<string, unknown>;
  readonly ledger: BudgetLedger;
  readonly suppressed?: ReadonlyArray<SuppressedTrigger>;
  /** `| undefined` so a caller may pass a computed value through directly. */
  readonly nextDueAt?: string | undefined;
}): PlanDecision {
  const decision: {
    -readonly [K in keyof Extract<PlanDecision, { outcome: 'not-due' }>]: Extract<
      PlanDecision,
      { outcome: 'not-due' }
    >[K];
  } = {
    outcome: 'not-due',
    reason: input.reason,
    suppressed: Object.freeze([...(input.suppressed ?? [])]),
    detail: Object.freeze({ ...input.detail }),
    ledger: input.ledger,
  };
  if (input.nextDueAt !== undefined) {
    decision.nextDueAt = input.nextDueAt;
  }
  return Object.freeze(decision);
}

/** The earliest of a set of instants, or `undefined` when there are none. */
function earliest(instants: ReadonlyArray<string>): string | undefined {
  return instants.slice().sort()[0];
}

function requireProgram(input: PlanEvaluationInput): ReviewProgram {
  const program = findProgram(input.model, input.programId);
  if (program === undefined) {
    throw new ProgramPlanningError(
      `program ${input.programId} is not in this model`,
      'input.programId',
      { missing: input.programId },
    );
  }
  return program;
}

function parseAuthorityRefs(value: ReadonlyArray<AuthorityRef> | undefined): ReadonlyArray<AuthorityRef> {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value)) {
    throw new ProgramPlanningError('input.operatorAuthorityRefs must be an array', 'input.operatorAuthorityRefs');
  }
  const refs = value.map((v, i) => parseAuthorityRef(v, `input.operatorAuthorityRefs[${i}]`));
  if (new Set(refs).size !== refs.length) {
    throw new ProgramPlanningError(
      'input.operatorAuthorityRefs must not contain duplicates',
      'input.operatorAuthorityRefs',
    );
  }
  return Object.freeze(refs);
}

/** Observations of environments the program declares, in any order. */
function observationsInScope(
  program: ReviewProgram,
  observations: ReadonlyArray<EnvironmentObservation>,
): ReadonlyArray<EnvironmentObservation> {
  const declared = new Set<string>(program.environmentIds);
  return observations.filter((o) => declared.has(o.environmentId));
}

/**
 * The environment a plan targets.
 *
 * The latest in-scope observation wins; with no observations, the first
 * declared environment does. Program-declared order is the declaration
 * author's intent, so it is a deterministic fallback rather than an
 * arbitrary pick.
 */
function resolveEnvironmentId(
  program: ReviewProgram,
  inScope: ReadonlyArray<EnvironmentObservation>,
): EnvironmentId {
  const latest = sortObservations(inScope)[inScope.length - 1];
  if (latest !== undefined) {
    return latest.environmentId;
  }
  const fallback = program.environmentIds[0];
  if (fallback === undefined) {
    throw new ProgramPlanningError(
      `program ${program.id} declares no environment`,
      'program.environmentIds',
    );
  }
  return fallback;
}

/**
 * Derive the evaluation mode, or honour one the caller pinned.
 *
 * See the module docstring. Requested modes are validated, not derived
 * around: pinning a mode the evidence cannot support is reported rather
 * than quietly replaced.
 */
function resolveMode(
  requested: EvaluationMode | undefined,
  winner: TriggerCandidate,
  lineageAvailable: boolean,
): EvaluationMode {
  if (requested !== undefined) {
    return requested;
  }
  if (lineageAvailable) {
    return 'releaseTransition';
  }
  return winner.kind === 'manual' ? 'pointInTime' : 'continuous';
}

function toSuppressed(candidates: ReadonlyArray<TriggerCandidate>): ReadonlyArray<SuppressedTrigger> {
  return Object.freeze(
    candidates.map((candidate) => {
      // A derived (cadence) occurrence has no delivery, so the key is
      // absent rather than explicitly `undefined` — `exactOptionalPropertyTypes`
      // distinguishes the two, and a report that carried
      // `deliveryId: undefined` would read as "a delivery that went
      // missing" rather than "there was no delivery".
      const base = {
        kind: candidate.kind,
        dueAt: candidate.dueAt,
        reason: 'superseded-by-higher-precedence' as const,
      };
      return Object.freeze(
        candidate.deliveryId !== undefined
          ? { ...base, deliveryId: candidate.deliveryId }
          : base,
      );
    }),
  );
}

function buildPlanTrigger(program: ReviewProgram, winner: TriggerCandidate): PlanTrigger {
  if (winner.kind === 'cadence') {
    const declared = program.triggers.find((t) => t.kind === 'cadence');
    if (declared === undefined) {
      throw new ProgramPlanningError(
        `program ${program.id} produced a cadence candidate without a cadence trigger`,
        'program.triggers',
      );
    }
    return Object.freeze({
      kind: 'cadence',
      dueAt: winner.dueAt,
      intervalMinutes: declared.intervalMinutes,
      timeZone: declared.timeZone,
    });
  }
  if (winner.kind === 'event') {
    const declared = program.triggers.find((t) => t.kind === 'event');
    if (declared === undefined || winner.deliveryId === undefined) {
      throw new ProgramPlanningError(
        `program ${program.id} produced an event candidate without an event trigger`,
        'program.triggers',
      );
    }
    return Object.freeze({
      kind: 'event',
      dueAt: winner.dueAt,
      deliveryId: winner.deliveryId,
      event: declared.event,
      debounceMinutes: declared.debounceMinutes,
    });
  }
  if (winner.deliveryId === undefined) {
    throw new ProgramPlanningError(
      `program ${program.id} produced a manual candidate without a delivery`,
      'input.signals',
    );
  }
  return Object.freeze({
    kind: 'manual',
    dueAt: winner.dueAt,
    deliveryId: winner.deliveryId,
  });
}

/**
 * Turn a cohort's declared membership intent into a bounded, auditable
 * selection.
 *
 * An `explicit` count and a `sizeTarget` size are declarations, so they
 * are used directly (capped by the ceiling). A `byLifecycle` rule names
 * no count at all, and resolving it is #60's ticket, so the plan is
 * charged against the declared ceiling and records that it did so.
 */
function buildCohortSelection(cohort: SyntheticCohort, ceiling: number): CohortSelection {
  const membership = cohort.membership;
  const declaredIdentityCount = declaredSize(membership);
  const plannedIdentities = Math.min(declaredIdentityCount ?? ceiling, ceiling);
  return Object.freeze({
    cohortId: cohort.id,
    membership,
    declaredIdentityCount,
    planningCeiling: ceiling,
    plannedIdentities,
  });
}

/**
 * The authority envelope: a ceiling, carried not resolved.
 *
 * Participant retention is bounded by the cohort's declared lifecycle
 * where one is named. An `explicit` membership names identities but not
 * their lifecycles, and resolving those is #60's ticket, so the plan
 * carries the global ceiling and records that the runtime narrows it
 * per identity.
 */
/**
 * The identity count a membership rule *declares*, or `null` when it
 * declares none.
 */
function declaredSize(membership: CohortMembershipIntent): number | null {
  if (membership.kind === 'explicit') {
    return membership.identityIds.length;
  }
  if (membership.kind === 'sizeTarget') {
    return membership.targetSize;
  }
  return null;
}

function buildAuthorityEnvelope(
  environment: Environment,
  authorityRefs: ReadonlyArray<AuthorityRef>,
  cohort: SyntheticCohort,
  maxMutatingActions: number,
): AuthorityEnvelope {
  const membership = cohort.membership;
  const resolution: RetentionResolution =
    membership.kind === 'explicit' ? 'per-identity-at-runtime' : 'cohort-lifecycle';
  const maxParticipantStateRetention: StateRetention =
    membership.kind === 'explicit' ? 'durable' : maxRetentionFor(membership.lifecycle);
  return Object.freeze({
    operatorAuthorityRefs: authorityRefs,
    environmentOrigins: Object.freeze([...environmentOrigins(environment)]),
    maxParticipantStateRetention,
    retentionResolution: resolution,
    maxMutatingActions,
  });
}

/**
 * The most retention a cohort's identities may hold, per lifecycle.
 *
 * The mapped type is the point. `ALLOWED_STATE_RETENTION` is declared as
 * `Readonly<Record<IdentityLifecycle, ReadonlyArray<StateRetention>>>`,
 * so indexing it can only ever yield the broad union — it cannot check a
 * lifecycle against its own retentions. Deriving from
 * `RetentionForLifecycle<L>` instead means each entry here is verified
 * against #57's own lifecycle/retention matrix at compile time, and a
 * lifecycle added to that matrix without a decision here is a missing-
 * key compile error rather than a silently wrong authority envelope.
 *
 * Retention is per-lifecycle by ADR-0011: an `ephemeral` identity retains
 * nothing, so a cohort of them must not be planned with a retention
 * ceiling that implies otherwise.
 */
function maxRetentionFor(lifecycle: IdentityLifecycle): StateRetention {
  return MAX_RETENTION_BY_LIFECYCLE[lifecycle];
}
