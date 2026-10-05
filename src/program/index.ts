/**
 * Review Program planning — triggers, budgets and cost-aware evaluation
 * plans (ADR-0011, issue #62).
 *
 * The public surface of `src/program/**`. This module decides *when* an
 * evaluation is due and *what* it would consist of. It owns no timer,
 * no queue, no provider client and no durable store: `planEvaluation`
 * is a pure function, and the ledger a caller passes in is the
 * scheduling memory it must persist itself.
 *
 * Builds on the durable declarations in `src/product/**` (issue #57)
 * and resolves none of their internals. Cohort resolution (#60) and
 * the World Operator authority boundary (#59) are referenced, never
 * reimplemented.
 *
 * Not re-exported from `src/index.ts` — the package entrypoint is #65's
 * ticket.
 */

export { ProgramPlanningError } from './errors.js';

export type {
  AuthorityRef,
  EnvironmentVersion,
  IdempotencyKey,
  ObservationId,
  PlanKey,
  TriggerDeliveryId,
} from './ids.js';
export {
  MAX_HANDLE_LENGTH,
  authorityRef,
  canonicalKey,
  environmentVersion,
  idempotencyKey,
  observationId,
  parseAuthorityRef,
  parseEnvironmentVersion,
  parseIdempotencyKey,
  parseObservationId,
  parsePlanKey,
  parseTriggerDeliveryId,
  planKeyFrom,
  triggerDeliveryId,
} from './ids.js';

export {
  LINEAGE_GAP_EXPLANATIONS,
  assertVersionLineage,
  compareObservations,
  parseEnvironmentObservation,
  parseEnvironmentObservations,
  resolveVersionLineage,
  sortObservations,
  type EnvironmentObservation,
  type LineageGap,
  type LineageResolution,
  type VersionLineage,
} from './observation.js';

export {
  parseStageCostRates,
  planCost,
  type PlanCost,
  type StageCostRates,
} from './cost.js';

export {
  TRIGGER_PRECEDENCE,
  cadenceKey,
  cadenceSlotAt,
  declaredTrigger,
  eventDueAt,
  eventKey,
  manualKey,
  nextCadenceSlot,
  parseTriggerSignal,
  parseTriggerSignals,
  resolveTriggers,
  type EventSignal,
  type ManualSignal,
  type TriggerCandidate,
  type TriggerResolution,
  type TriggerSignal,
} from './trigger.js';

export {
  BUDGET_DENIAL_REASONS,
  assertLedgerMatchesProgram,
  createBudgetLedger,
  defaultBudgetWindow,
  ledgerConsumes,
  ledgerPlannedAt,
  remainingCostUnits,
  remainingRuns,
  reserve,
  type BudgetDenialReason,
  type BudgetLedger,
  type BudgetSpendRequest,
  type BudgetWindow,
  type ReservationResult,
} from './budget.js';

export {
  EVALUATION_MODES,
  RETENTION_RESOLUTIONS,
  buildEvaluationPlan,
  comparePlanKeys,
  planTargetKey,
  type AuthorityEnvelope,
  type CohortSelection,
  type EscalationPolicy,
  type EvaluationMode,
  type EvaluationPlan,
  type EvaluationPlanInit,
  type PlanBudget,
  type PlanTrigger,
  type RetentionResolution,
  type SuppressedTrigger,
} from './plan.js';

export {
  MAX_IDENTITIES_PER_PLAN,
  MAX_MUTATING_ACTIONS_PER_PLAN,
  MAX_VERIFICATIONS_PER_PLAN,
  NOT_DUE_REASONS,
  isBudgetDenial,
  planEvaluation,
  type NotDueReason,
  type PlanDecision,
  type PlanEvaluationInput,
} from './planner.js';
