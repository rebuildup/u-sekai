/**
 * Product-review contract — evidence-backed findings, customer
 * dispositions, and longitudinal product change (issue #61, ADR-0011).
 *
 * This module is the public surface of `src/review/**`. It is not
 * re-exported from `src/index.ts`: the package entrypoint is #65's
 * ticket, and #61 must not compete for it.
 *
 * ## Layering
 *
 * `src/review/**` imports from `src/product/**` (#57) and from nothing
 * else. In particular it does **not** import from `src/domain/**`,
 * `src/evidence/**`, `src/experiment/**` or any provider, so the review
 * contract can be written, stored and consumed with no experiment
 * runtime existing — the same independence #57 established for the
 * durable model, extended one layer up.
 *
 * The one place the two layers meet is
 * `setupFailureFromRuntimeError`, which accepts a `runtimeErrors`
 * record *structurally* (`RuntimeErrorRecord`) rather than importing
 * `BehavioralEvidence`. That keeps the dependency direction one-way
 * while still giving #63 the conversion it needs.
 *
 * ## The five guarantees this contract makes structural
 *
 * 1. **A finding carries evidence or it does not exist.**
 *    `evidenceRefs` is required, non-empty, duplicate-free, and must
 *    contain at least one `supports` reference with a followable
 *    `locator`. See `evidence.ts`.
 * 2. **Channels may disagree and the disagreement is kept.** There is
 *    no scalar, no weighting and no aggregate field, and
 *    `rejectUnknownKeys` makes adding one a contract violation.
 *    `docs/product/kpis.md` lists a universal scalar UX score as an
 *    anti-metric.
 * 3. **A setup failure is not a product finding.** `Finding` and
 *    `SetupFailure` are separate types with literal `outcome`
 *    discriminants and separate id brands. See `finding.ts`.
 * 4. **A disposition is a state machine over a real finding
 *    reference.** `DISPOSITION_TRANSITIONS` is the only legal move
 *    table; `kind` and `state` are validated against each other; the
 *    `findingId` is a reference, never a copy. See `disposition.ts`
 *    and `lineage.ts`.
 * 5. **A longitudinal claim requires a joinable baseline.** Any
 *    `change` other than `unknown` requires
 *    `isReleaseTransitionComparison(baseline, observed)`. See
 *    `longitudinal.ts`.
 *
 * ## Errors
 *
 * Everything this layer rejects is a `ReviewContractError`, including
 * handles that #57's parsers refuse: cross-layer parses go through
 * `asReviewContractError`, so a caller has one error type to catch.
 *
 * ## Downstream contract
 *
 * #63 (runtime) imports `parseReviewOutcome`, `isFinding`,
 * `isSetupFailure`, `setupFailureFromRuntimeError`,
 * `parseFinding` and the id derivation helpers.
 *
 * #64 (disposition history + KPIs) imports `parseDisposition`,
 * `isLegalDispositionTransition`, `assertDispositionTransition`,
 * `nextDispositionStates`, `isDispositionCorrection`,
 * `isCustomerDecision`, `DISPOSITION_TRANSITIONS`,
 * `DECIDED_DISPOSITION_KINDS`, `OPEN_DISPOSITION_KINDS`, and the
 * lineage resolvers. #64 owns persistence, idempotency and
 * aggregation; this layer owns vocabulary, legality and the reference.
 */

export { asReviewContractError, isReviewContractError, ReviewContractError } from './errors.js';

export {
  brandedReviewId,
  deriveEvidenceId,
  deriveFindingId,
  deriveVerificationId,
  DISPOSITION_ID_PATTERN,
  dispositionId,
  FINDING_ID_PATTERN,
  findingId,
  MAX_REVIEW_ID_LENGTH,
  parseDispositionId,
  parseFindingId,
  parseReviewId,
  parseSetupFailureId,
  parseVerificationId,
  SETUP_FAILURE_ID_PATTERN,
  setupFailureId,
  VERIFICATION_ID_PATTERN,
  verificationId,
  type DispositionId,
  type FindingId,
  type ReviewIdKindName,
  type SetupFailureId,
  type VerificationId,
} from './ids.js';

export type { EvidenceId } from '../product/lineage.js';

export {
  assertSupportsClaim,
  channelsOf,
  contradictingEvidence,
  EVIDENCE_CHANNELS,
  EVIDENCE_STANCES,
  evidenceForChannel,
  isChannelConflict,
  parseEvidenceRef,
  parseEvidenceRefs,
  type EvidenceChannel,
  type EvidenceRef,
  type EvidenceStance,
} from './evidence.js';

export {
  CONFIDENCE_BASES,
  CONFIDENCE_LEVELS,
  CONFIDENCE_SOURCES,
  parseCalibrationClaim,
  parseConfidence,
  parseConfidenceProvenance,
  rankBasis,
  type CalibrationClaim,
  type Confidence,
  type ConfidenceBasis,
  type ConfidenceLevel,
  type ConfidenceProvenance,
  type ConfidenceSource,
} from './confidence.js';

export {
  assertObservedTarget,
  CHANGE_KINDS,
  EVALUATION_MODES,
  isComparativeChange,
  parseLongitudinalChange,
  type ChangeKind,
  type EvaluationMode,
  type LongitudinalChange,
} from './longitudinal.js';

export {
  ACTION_KINDS,
  assertDispositionTransition,
  DECIDED_DISPOSITION_KINDS,
  DISPOSITION_ACTOR_KINDS,
  DISPOSITION_KINDS,
  DISPOSITION_STATES,
  DISPOSITION_TRANSITIONS,
  INITIAL_DISPOSITION_STATE,
  isCustomerDecision,
  isDispositionCorrection,
  isLegalDispositionTransition,
  isOpenDisposition,
  nextDispositionStates,
  OPEN_DISPOSITION_KINDS,
  parseDisposition,
  parseDispositionAction,
  parseDispositionActor,
  RATIONALE_REQUIRED_KINDS,
  type ActionKind,
  type DecidedDispositionKind,
  type Disposition,
  type DispositionAction,
  type DispositionActor,
  type DispositionActorKind,
  type DispositionKind,
  type DispositionState,
  type OpenDispositionKind,
  type RationaleRequiredKind,
} from './disposition.js';

export {
  CONDITION_DIMENSIONS,
  conditionKey,
  FINDING_KINDS,
  inferSetupFailureCause,
  isFinding,
  isSetupFailure,
  parseAffectedCondition,
  parseAffectedConditions,
  parseFinding,
  parseReproduction,
  parseReviewOutcome,
  parseSetupFailure,
  parseVerification,
  REPRODUCTION_STATUSES,
  RISK_CLASSES,
  SEVERITIES,
  SETUP_FAILURE_CAUSES,
  setupFailureFromRuntimeError,
  VERIFICATION_OUTCOMES,
  type AffectedCondition,
  type ConditionDimension,
  type Finding,
  type FindingKind,
  type Reproduction,
  type ReproductionStatus,
  type ReviewOutcome,
  type RiskClass,
  type RuntimeErrorRecord,
  type SetupFailure,
  type SetupFailureCause,
  type SetupFailureFromRuntimeErrorOptions,
  type Severity,
  type Verification,
  type VerificationOutcome,
} from './finding.js';

export {
  findFinding,
  indexFindings,
  resolveAllDispositionLineages,
  resolveDispositionLineage,
  type FindingLineage,
} from './lineage.js';
