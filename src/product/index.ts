/**
 * Durable product domain model (ADR-0011, issue #57).
 *
 * The public surface of `src/product/**`. This module is intentionally
 * standalone: it imports nothing from `src/domain/**`,
 * `src/experiment/**`, `src/capability/**` or any provider, so a
 * Product, Environment, Synthetic Identity, Cohort or Review Program can
 * be declared without an experiment, a run, or a runtime existing.
 *
 * Owned by #57. Not re-exported from `src/index.ts` — the package
 * entrypoint is #65's ticket.
 */

export { ProductDomainError } from './errors.js';

export {
  brandedId,
  cohortId,
  environmentId,
  MAX_ID_LENGTH,
  parseBrandedId,
  parseCohortId,
  parseEnvironmentId,
  parseProductId,
  parseReviewProgramId,
  parseSyntheticIdentityId,
  productId,
  reviewProgramId,
  syntheticIdentityId,
  COHORT_ID_PATTERN,
  ENVIRONMENT_ID_PATTERN,
  PRODUCT_ID_PATTERN,
  REVIEW_PROGRAM_ID_PATTERN,
  SYNTHETIC_IDENTITY_ID_PATTERN,
} from './ids.js';
export type {
  Brand,
  CohortId,
  EnvironmentId,
  IdKindName,
  ProductId,
  ReviewProgramId,
  SyntheticIdentityId,
} from './ids.js';

export { buildProduct, isProduct, parseProduct, productSummaryLine, type Product } from './product.js';

export {
  DEPLOYMENT_KINDS,
  ENVIRONMENT_CLASSES,
  environmentIncludesOrigin,
  environmentOrigins,
  parseEnvironment,
  parseEnvironmentEndpoint,
  type DeploymentKind,
  type Environment,
  type EnvironmentClass,
  type EnvironmentEndpoint,
} from './environment.js';

export {
  ALLOWED_STATE_RETENTION,
  assertRetentionAllowed,
  IDENTITY_LIFECYCLES,
  MAX_CONCURRENT_SESSIONS,
  MAX_PERMITTED_ORIGINS,
  parseIdentityCapabilityBounds,
  parseIdentityStateRef,
  parseSyntheticIdentity,
  STATE_RETENTIONS,
  type IdentityCapabilityBounds,
  type IdentityLifecycle,
  type IdentityStateRef,
  type RetentionForLifecycle,
  type StateRetention,
  type SyntheticIdentity,
} from './identity.js';

export {
  MAX_EXPLICIT_MEMBERS,
  MAX_TARGET_SIZE,
  MEMBERSHIP_INTENT_KINDS,
  parseCohortMembershipIntent,
  parseSyntheticCohort,
  type CohortMembershipIntent,
  type ExplicitMembership,
  type LifecycleMembership,
  type MembershipIntentKind,
  type SizeTargetMembership,
  type SyntheticCohort,
} from './cohort.js';

export {
  MAX_CADENCE_MINUTES,
  MAX_COST_UNITS_PER_DAY,
  MAX_DEBOUNCE_MINUTES,
  MAX_PROGRAM_ENVIRONMENTS,
  MAX_RUNS_PER_DAY,
  MAX_RUNS_PER_EVENT,
  MIN_CADENCE_MINUTES,
  parseProgramBudget,
  parseReviewProgram,
  parseReviewTrigger,
  parseReviewTriggers,
  programHasTrigger,
  TRIGGER_KINDS,
  type CadenceTrigger,
  type EventTrigger,
  type ManualTrigger,
  type ProgramBudget,
  type ReviewProgram,
  type ReviewTrigger,
  type ReviewTriggerKind,
} from './program.js';

export {
  isReleaseTransitionComparison,
  parseEvaluationRunId,
  parseEvaluationTargetRef,
  parseEvidenceId,
  parseRunLineage,
  sameTarget,
  targetKey,
  type EvaluationRunId,
  type EvaluationTargetRef,
  type EvidenceId,
  type RunLineage,
} from './lineage.js';

export {
  buildProductModel,
  findCohort,
  findEnvironment,
  findIdentity,
  findProgram,
  parseProductModel,
  type ProductModel,
} from './product-model.js';
