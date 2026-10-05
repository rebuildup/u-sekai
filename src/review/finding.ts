/**
 * Finding — one evidence-backed product problem, and SetupFailure —
 * the thing that is emphatically not one (issue #61).
 *
 * ## A setup failure is not a finding
 *
 * `BehavioralEvidence.runtimeErrors` in `src/domain/evidence.ts` is
 * `{ ts, where, message }[]`. It does not say whether an error came
 * from the product under test or from the harness observing it: a
 * browser that could not launch, an environment that was not reachable
 * and a checkout button that does nothing all land in the same array.
 *
 * If a harness failure is recorded as a product finding, three things
 * break at once, and none of them is recoverable downstream:
 *
 * 1. #64's *finding acceptance rate* and *false-positive rate* are
 *    denominated over findings. A dead browser is a finding that is
 *    always false-positive, and it drags the false-positive rate up
 *    while telling the customer their product is broken.
 * 2. #64's *cost per accepted finding* rises for a reason that has
 *    nothing to do with the product, which is the metric that decides
 *    whether the service is viable.
 * 3. The finding says something false about the customer's Environment,
 *    and nothing downstream can tell it apart from a true one.
 *
 * So the two are separate types with a literal discriminant each:
 *
 * ```ts
 * interface Finding      { outcome: 'productFinding'; ... }
 * interface SetupFailure { outcome: 'setupFailure';   ... }
 * ```
 *
 * `FindingId` and `SetupFailureId` are separate nominal types too. The
 * discriminant alone stops the type-level swap; the distinct id stops
 * the wire-level swap, where branding has been erased by `JSON`.
 * `test/unit/review/type-separation.test.ts` pins both with
 * `@ts-expect-error` assertions that `npm run typecheck` enforces, so
 * the separation cannot be quietly removed.
 *
 * A `SetupFailure` still carries evidence — an `environmentProbe`
 * reference derived from the error record itself — because "the run
 * failed for a reason nobody can inspect" is not a useful diagnostic.
 * What it does not carry is `severity`, `confidence`, `affectedConditions`
 * or `longitudinal`: there is no product claim for those fields to
 * describe.
 *
 * ## `setupFailureFromRuntimeError` exists for #63
 *
 * The runtime integration ticket needs to turn a `runtimeErrors` entry
 * into a `SetupFailure` and has no other way to do it without editing
 * `src/domain/evidence.ts`, which is not its surface either. The
 * adapter takes the record structurally — `{ ts, where, message }`,
 * typed locally rather than imported — so this layer stays free of any
 * dependency on `src/domain/**`, matching #57's layering.
 *
 * ## No field may claim a Synthetic Cohort represents humans
 *
 * ADR-0011's non-reality boundary. `rejectRepresentativenessClaim`
 * rejects a small set of key spellings with a message that names the
 * boundary, so a producer that reaches for `representativeSample` gets
 * a diagnosis rather than a generic "unknown field".
 */

import { parseEvaluationRunId, parseEvaluationTargetRef } from '../product/lineage.js';
import type { EvaluationRunId, EvaluationTargetRef } from '../product/lineage.js';
import type { SyntheticIdentityId } from '../product/ids.js';
import { parseSyntheticIdentityId } from '../product/ids.js';
import { parseConfidence } from './confidence.js';
import type { Confidence } from './confidence.js';
import { assertSupportsClaim, parseEvidenceRef, parseEvidenceRefs } from './evidence.js';
import type { EvidenceRef } from './evidence.js';
import { asReviewContractError, ReviewContractError } from './errors.js';
import {
  deriveEvidenceId,
  FindingId,
  parseFindingId,
  parseSetupFailureId,
  parseVerificationId,
  SetupFailureId,
  VerificationId,
} from './ids.js';
import {
  assertObservedTarget,
  parseLongitudinalChange,
} from './longitudinal.js';
import type { LongitudinalChange } from './longitudinal.js';
import {
  rejectDuplicates,
  rejectUnknownKeys,
  requireArray,
  requireIsoInstant,
  requireNonEmptyArray,
  requireNonEmptyString,
  requireOneOf,
  requireRecord,
} from './validation.js';

/** What kind of problem a finding describes. A category, not a score. */
export const FINDING_KINDS = [
  'workflowBlocker',
  'reliabilityFailure',
  'usabilityDefect',
  'accessibilityBarrier',
  'comprehensionGap',
  'trustDefect',
  'dataIntegrity',
  'contentProblem',
  'other',
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/**
 * How much the finding matters to the user.
 *
 * Ordered independently of `riskClass`: a cosmetic issue in a payment
 * flow and a functional issue in an export both carry `high`, and
 * collapsing the two axes into one number is the anti-metric
 * `docs/product/kpis.md` warns about.
 */
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Which class of harm the finding belongs to. Orthogonal to severity. */
export const RISK_CLASSES = [
  'safety',
  'privacy',
  'security',
  'accessibility',
  'reliability',
  'performance',
  'usability',
  'content',
  'other',
] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

/**
 * The dimensions a condition can vary along.
 *
 * `synthetic` is a dimension in its own right: the condition "this only
 * happens to a Synthetic Identity with a narrow memory window" is a
 * real, reportable condition and omitting it would let a consumer
 * mistake it for a human-population claim.
 */
export const CONDITION_DIMENSIONS = [
  'capability',
  'identityState',
  'lifecycle',
  'membership',
  'environment',
  'flow',
  'deviceProfile',
  'locale',
  'synthetic',
] as const;
export type ConditionDimension = (typeof CONDITION_DIMENSIONS)[number];

export interface AffectedCondition {
  readonly dimension: ConditionDimension;
  /**
   * The concrete value, e.g. `memory=limitedRecent`, `step=4`.
   * Free-form but never empty; there is no closed vocabulary because
   * the dimensions are #57's and #60's to extend.
   */
  readonly value: string;
}

/** Whether and how the finding was reproduced. */
export const REPRODUCTION_STATUSES = [
  'reproduced',
  'attemptedNotReproduced',
  'notAttempted',
  'blockedBySetup',
] as const;
export type ReproductionStatus = (typeof REPRODUCTION_STATUSES)[number];

export interface Reproduction {
  readonly status: ReproductionStatus;
  /** Ordered steps a verifier can follow. Required when reproduced. */
  readonly steps?: ReadonlyArray<string>;
  readonly notes?: string;
}

/** What an independent verification pass concluded. */
export const VERIFICATION_OUTCOMES = ['confirmed', 'refuted', 'inconclusive', 'notRun'] as const;
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

export interface Verification {
  readonly id: VerificationId;
  /** The finding this pass checked. */
  readonly findingId: FindingId;
  readonly outcome: VerificationOutcome;
  /** The run the pass executed under, when it executed one. */
  readonly runId?: EvaluationRunId;
  /** Identities the pass used. Empty/absent for a static re-check. */
  readonly identityIds?: ReadonlyArray<SyntheticIdentityId>;
  /** What the pass looked at. Required: a verification is evidence too. */
  readonly evidenceRefs: ReadonlyArray<EvidenceRef>;
  readonly rationale: string;
  readonly verifiedAt: string;
}

export interface Finding {
  /**
   * Literal discriminant. A `SetupFailure` is not assignable to this
   * type, so setup and product outcomes cannot be mixed by accident.
   */
  readonly outcome: 'productFinding';
  readonly id: FindingId;
  readonly title: string;
  /** What the user experienced, in product terms. */
  readonly summary: string;
  readonly kind: FindingKind;
  readonly severity: Severity;
  readonly riskClass: RiskClass;
  /** The producer's own confidence. Never a customer decision. */
  readonly confidence: Confidence;
  /** Product / Environment / Cohort / Review Program this is about. */
  readonly target: EvaluationTargetRef;
  /** The run that raised it. Must equal `longitudinal.observed.runId`. */
  readonly observedIn: EvaluationRunId;
  /** Which Synthetic Identities hit it. Never a count of humans. */
  readonly identityIds: ReadonlyArray<SyntheticIdentityId>;
  /** Required, non-empty, at least one `supports`. See `evidence.ts`. */
  readonly evidenceRefs: ReadonlyArray<EvidenceRef>;
  /** Required, non-empty. */
  readonly affectedConditions: ReadonlyArray<AffectedCondition>;
  readonly reproduction: Reproduction;
  readonly longitudinal: LongitudinalChange;
  readonly observedAt: string;
  /** Present when `reproduction.status` is `reproduced`. */
  readonly verification?: Verification;
}

const FINDING_FIELDS = [
  'outcome',
  'id',
  'title',
  'summary',
  'kind',
  'severity',
  'riskClass',
  'confidence',
  'target',
  'observedIn',
  'identityIds',
  'evidenceRefs',
  'affectedConditions',
  'reproduction',
  'longitudinal',
  'observedAt',
  'verification',
] as const;

const REPRODUCTION_FIELDS = ['status', 'steps', 'notes'] as const;
const VERIFICATION_FIELDS = [
  'id',
  'findingId',
  'outcome',
  'runId',
  'identityIds',
  'evidenceRefs',
  'rationale',
  'verifiedAt',
] as const;

export const MAX_TITLE_LENGTH = 200;
export const MAX_SUMMARY_LENGTH = 2000;
export const MAX_CONDITION_VALUE_LENGTH = 300;
export const MAX_REPRODUCTION_NOTES_LENGTH = 2000;
export const MAX_VERIFICATION_RATIONALE_LENGTH = 2000;
export const MAX_REPRODUCTION_STEP_LENGTH = 500;
export const MAX_REPRODUCTION_STEPS = 50;

export function parseFinding(input: unknown, field = 'finding'): Finding {
  const raw = requireRecord(input, field);

  // The discriminant is checked before the field list, so a caller that
  // passed a SetupFailure is told what it actually handed over instead
  // of being handed a list of SetupFailure field names that a Finding
  // does not have.
  if (raw['outcome'] !== 'productFinding') {
    throw new ReviewContractError(
      `${field}.outcome must be "productFinding"; a SetupFailure is a separate type and must ` +
        `not be recorded as a product finding`,
      `${field}.outcome`,
      { received: raw['outcome'] },
    );
  }

  rejectRepresentativenessClaim(raw, field);
  rejectUnknownKeys(raw, FINDING_FIELDS, field);

  const id = parseFindingId(raw['id'], `${field}.id`);
  const target = asReviewContractError(`${field}.target`, () =>
    parseEvaluationTargetRef(raw['target'], `${field}.target`),
  );
  const observedIn = asReviewContractError(`${field}.observedIn`, () =>
    parseEvaluationRunId(raw['observedIn'], `${field}.observedIn`),
  );
  const identityIds = asReviewContractError(`${field}.identityIds`, () =>
    parseIdentityIdList(raw['identityIds'], `${field}.identityIds`),
  );
  const evidenceRefs = parseEvidenceRefs(raw['evidenceRefs'], `${field}.evidenceRefs`);
  assertSupportsClaim(evidenceRefs, `${field}.evidenceRefs`);
  const affectedConditions = parseAffectedConditions(
    raw['affectedConditions'],
    `${field}.affectedConditions`,
  );
  const reproduction = parseReproduction(raw['reproduction'], `${field}.reproduction`);
  const longitudinal = asReviewContractError(`${field}.longitudinal`, () =>
    parseLongitudinalChange(raw['longitudinal'], `${field}.longitudinal`),
  );
  assertObservedTarget(longitudinal, target, `${field}.longitudinal.observed`);

  if (longitudinal.observed.runId !== observedIn) {
    throw new ReviewContractError(
      `${field}.observedIn must be the run the finding was raised on (longitudinal.observed.runId)`,
      `${field}.observedIn`,
      { observedIn, observedRunId: longitudinal.observed.runId },
    );
  }

  if (!identityIds.some((identity) => longitudinal.observed.identityIds.includes(identity))) {
    throw new ReviewContractError(
      `${field}.identityIds must include at least one identity that took part in the run the ` +
        `finding was raised on; a finding attributed to an identity that did not participate ` +
        `cannot be reproduced or verified`,
      `${field}.identityIds`,
      {
        identityIds,
        observedIdentityIds: longitudinal.observed.identityIds,
      },
    );
  }

  const observedAt = requireIsoInstant(raw['observedAt'], `${field}.observedAt`);

  let verification: Verification | undefined;
  if (raw['verification'] !== undefined) {
    verification = parseVerification(raw['verification'], `${field}.verification`, id);
  }
  if (reproduction.status === 'reproduced' && verification === undefined) {
    throw new ReviewContractError(
      `${field}: reproduction.status "reproduced" requires a verification record. "I reproduced ` +
        `it" is a claim about evidence, so the contract requires the evidence handle and the ` +
        `verdict that support it.`,
      `${field}.verification`,
      { status: reproduction.status },
    );
  }
  if (verification !== undefined && reproduction.status === 'notAttempted') {
    throw new ReviewContractError(
      `${field}: a verification was recorded but reproduction.status is "notAttempted"`,
      `${field}.reproduction.status`,
      { verificationOutcome: verification.outcome },
    );
  }
  if (verification?.outcome === 'refuted' && reproduction.status === 'reproduced') {
    throw new ReviewContractError(
      `${field}: a finding cannot be both "reproduced" and refuted by its own verification`,
      `${field}.reproduction.status`,
      { verificationOutcome: verification.outcome },
    );
  }

  const result: { -readonly [K in keyof Finding]: Finding[K] } = {
    outcome: 'productFinding',
    id,
    title: requireNonEmptyString(raw['title'], `${field}.title`, MAX_TITLE_LENGTH),
    summary: requireNonEmptyString(raw['summary'], `${field}.summary`, MAX_SUMMARY_LENGTH),
    kind: requireOneOf(raw['kind'], FINDING_KINDS, `${field}.kind`),
    severity: requireOneOf(raw['severity'], SEVERITIES, `${field}.severity`),
    riskClass: requireOneOf(raw['riskClass'], RISK_CLASSES, `${field}.riskClass`),
    confidence: parseConfidence(raw['confidence'], `${field}.confidence`),
    target,
    observedIn,
    identityIds,
    evidenceRefs,
    affectedConditions,
    reproduction,
    longitudinal,
    observedAt,
  };
  if (verification !== undefined) {
    result.verification = verification;
  }
  return Object.freeze(result);
}

export function parseReproduction(input: unknown, field = 'reproduction'): Reproduction {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, REPRODUCTION_FIELDS, field);
  const status = requireOneOf(raw['status'], REPRODUCTION_STATUSES, `${field}.status`);

  let steps: ReadonlyArray<string> | undefined;
  if (raw['steps'] !== undefined) {
    const arr = requireArray(raw['steps'], `${field}.steps`);
    if (arr.length > MAX_REPRODUCTION_STEPS) {
      throw new ReviewContractError(
        `${field}.steps must have at most ${MAX_REPRODUCTION_STEPS} entries`,
        `${field}.steps`,
        { length: arr.length, maxLength: MAX_REPRODUCTION_STEPS },
      );
    }
    steps = Object.freeze(
      arr.map((v, i) =>
        requireNonEmptyString(v, `${field}.steps[${i}]`, MAX_REPRODUCTION_STEP_LENGTH),
      ),
    );
  }

  if (status === 'reproduced' && (steps === undefined || steps.length === 0)) {
    throw new ReviewContractError(
      `${field}.steps must be non-empty when status is "reproduced"; the reproduction rate KPI ` +
        `is computed from findings someone else can follow`,
      `${field}.steps`,
      { status },
    );
  }

  const result: { -readonly [K in keyof Reproduction]: Reproduction[K] } = { status };
  if (steps !== undefined) result.steps = steps;
  if (raw['notes'] !== undefined) {
    result.notes = requireNonEmptyString(
      raw['notes'],
      `${field}.notes`,
      MAX_REPRODUCTION_NOTES_LENGTH,
    );
  }
  return Object.freeze(result);
}

export function parseVerification(
  input: unknown,
  field = 'verification',
  expectedFindingId?: FindingId,
): Verification {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, VERIFICATION_FIELDS, field);

  const findingId = parseFindingId(raw['findingId'], `${field}.findingId`);
  if (expectedFindingId !== undefined && findingId !== expectedFindingId) {
    throw new ReviewContractError(
      `${field}.findingId must be the finding being verified`,
      `${field}.findingId`,
      { expected: expectedFindingId, received: findingId },
    );
  }

  const identityIds =
    raw['identityIds'] === undefined
      ? undefined
      : asReviewContractError(`${field}.identityIds`, () =>
          parseIdentityIdList(raw['identityIds'], `${field}.identityIds`, false),
        );

  const result: { -readonly [K in keyof Verification]: Verification[K] } = {
    id: parseVerificationId(raw['id'], `${field}.id`),
    findingId,
    outcome: requireOneOf(raw['outcome'], VERIFICATION_OUTCOMES, `${field}.outcome`),
    evidenceRefs: parseEvidenceRefs(raw['evidenceRefs'], `${field}.evidenceRefs`),
    rationale: requireNonEmptyString(
      raw['rationale'],
      `${field}.rationale`,
      MAX_VERIFICATION_RATIONALE_LENGTH,
    ),
    verifiedAt: requireIsoInstant(raw['verifiedAt'], `${field}.verifiedAt`),
  };
  if (raw['runId'] !== undefined) {
    result.runId = asReviewContractError(`${field}.runId`, () =>
      parseEvaluationRunId(raw['runId'], `${field}.runId`),
    );
  }
  if (identityIds !== undefined) {
    result.identityIds = identityIds;
  }
  return Object.freeze(result);
}

export function parseAffectedCondition(
  input: unknown,
  field = 'affectedCondition',
): AffectedCondition {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, ['dimension', 'value'], field);
  return Object.freeze({
    dimension: requireOneOf(raw['dimension'], CONDITION_DIMENSIONS, `${field}.dimension`),
    value: requireNonEmptyString(
      raw['value'],
      `${field}.value`,
      MAX_CONDITION_VALUE_LENGTH,
    ),
  });
}

export function parseAffectedConditions(
  input: unknown,
  field = 'affectedConditions',
): ReadonlyArray<AffectedCondition> {
  const arr = requireNonEmptyArray(input, field);
  const parsed = arr.map((v, i) => parseAffectedCondition(v, `${field}[${i}]`));
  const keys = parsed.map((c) => `${c.dimension}=${c.value}`);
  rejectDuplicates(keys, field);
  return Object.freeze(parsed);
}

/** Stable grouping key for the conditions a finding was observed under. */
export function conditionKey(conditions: ReadonlyArray<AffectedCondition>): string {
  return [...conditions]
    .map((c) => `${c.dimension}=${c.value}`)
    .sort()
    .join('&');
}

// ---------------------------------------------------------------------------
// Setup failure
// ---------------------------------------------------------------------------

/**
 * Why the evaluation could not be set up or could not proceed.
 *
 * These are harness / environment / provider / policy problems. None of
 * them is a statement about the product, which is the whole point of
 * keeping them in a separate type.
 */
export const SETUP_FAILURE_CAUSES = [
  'harnessUnavailable',
  'environmentUnreachable',
  'worldOperatorDenied',
  'worldStateUnavailable',
  'providerUnavailable',
  'adapterError',
  'policyDenied',
  'budgetExhausted',
  'unknown',
] as const;
export type SetupFailureCause = (typeof SETUP_FAILURE_CAUSES)[number];

export interface SetupFailure {
  /**
   * Literal discriminant. Not assignable to `Finding`, and `Finding` is
   * not assignable to it.
   */
  readonly outcome: 'setupFailure';
  /** Distinct id brand from `FindingId`, so the wire form cannot be swapped. */
  readonly id: SetupFailureId;
  readonly cause: SetupFailureCause;
  /** What went wrong. Bounded, redacted by the producer. */
  readonly message: string;
  /** Present when the failure happened inside a known evaluation. */
  readonly target?: EvaluationTargetRef;
  readonly runId?: EvaluationRunId;
  readonly identityIds?: ReadonlyArray<SyntheticIdentityId>;
  /**
   * Always non-empty. A setup failure that cannot be inspected is an
   * operationally useless failure.
   */
  readonly evidenceRefs: ReadonlyArray<EvidenceRef>;
  readonly occurredAt: string;
}

const SETUP_FAILURE_FIELDS = [
  'outcome',
  'id',
  'cause',
  'message',
  'target',
  'runId',
  'identityIds',
  'evidenceRefs',
  'occurredAt',
] as const;

export const MAX_SETUP_FAILURE_MESSAGE_LENGTH = 2000;

export function parseSetupFailure(input: unknown, field = 'setupFailure'): SetupFailure {
  const raw = requireRecord(input, field);

  // Discriminant first, for the same reason as `parseFinding`.
  if (raw['outcome'] !== 'setupFailure') {
    throw new ReviewContractError(
      `${field}.outcome must be "setupFailure"; a product observation is a Finding`,
      `${field}.outcome`,
      { received: raw['outcome'] },
    );
  }

  rejectUnknownKeys(raw, SETUP_FAILURE_FIELDS, field);

  const evidenceRefs = parseEvidenceRefs(raw['evidenceRefs'], `${field}.evidenceRefs`);

  const result: { -readonly [K in keyof SetupFailure]: SetupFailure[K] } = {
    outcome: 'setupFailure',
    id: parseSetupFailureId(raw['id'], `${field}.id`),
    cause: requireOneOf(raw['cause'], SETUP_FAILURE_CAUSES, `${field}.cause`),
    message: requireNonEmptyString(
      raw['message'],
      `${field}.message`,
      MAX_SETUP_FAILURE_MESSAGE_LENGTH,
    ),
    evidenceRefs,
    occurredAt: requireIsoInstant(raw['occurredAt'], `${field}.occurredAt`),
  };
  if (raw['target'] !== undefined) {
    result.target = asReviewContractError(`${field}.target`, () =>
      parseEvaluationTargetRef(raw['target'], `${field}.target`),
    );
  }
  if (raw['runId'] !== undefined) {
    result.runId = asReviewContractError(`${field}.runId`, () =>
      parseEvaluationRunId(raw['runId'], `${field}.runId`),
    );
  }
  if (raw['identityIds'] !== undefined) {
    result.identityIds = asReviewContractError(`${field}.identityIds`, () =>
      parseIdentityIdList(raw['identityIds'], `${field}.identityIds`, false),
    );
  }
  return Object.freeze(result);
}

/**
 * Build a `SetupFailure` from one `BehavioralEvidence.runtimeErrors`
 * entry.
 *
 * ## Why this adapter is here rather than in `src/domain/evidence.ts`
 *
 * `runtimeErrors` is `{ ts, where, message }`. It carries no cause
 * taxonomy, and adding one would change a type six other tickets are
 * written against. The classification therefore happens *here*, at the
 * boundary where a runtime error becomes a durable review record, and
 * the input is typed structurally so this module keeps its promise of
 * depending on nothing under `src/domain/**`.
 *
 * ## Determinism
 *
 * The evidence handle is derived from the record's own content
 * (`ts|where|message`), so re-reading the same failure always yields
 * the same `EvidenceId` and the same failure cannot be counted twice
 * because two callers spelled it differently.
 *
 * ## Cause inference
 *
 * Inference is keyword-based and deliberately conservative: an
 * unrecognised message becomes `unknown`, which is the honest answer.
 * A caller that knows better passes `cause` explicitly and the
 * inference is skipped. `harnessUnavailable` is the fallback for
 * connection-shaped messages because an unreachable environment is the
 * most common reason a run produces no product evidence at all, and
 * mis-filing it as a product finding is the failure mode this whole
 * split exists to prevent.
 */
export function setupFailureFromRuntimeError(
  error: RuntimeErrorRecord,
  options: SetupFailureFromRuntimeErrorOptions,
): SetupFailure {
  const field = options.field ?? 'setupFailure';
  const ts = requireIsoInstant(error.ts, `${field}.error.ts`);
  const where = requireNonEmptyString(error.where, `${field}.error.where`, 200);
  const message = requireNonEmptyString(error.message, `${field}.error.message`, 2000);

  const evidenceRef = parseEvidenceRef(
    {
      id: deriveEvidenceId(`setup|${ts}|${where}|${message}`),
      channel: 'environmentProbe',
      stance: 'supports',
      locator: `runtimeErrors[${options.index ?? 0}]`,
      observedAt: ts,
      summary: `${where}: ${message}`.slice(0, 500),
    },
    `${field}.evidenceRefs[0]`,
  );

  const result: { -readonly [K in keyof SetupFailure]: SetupFailure[K] } = {
    outcome: 'setupFailure',
    id: options.id,
    cause: options.cause ?? inferSetupFailureCause(message),
    message,
    evidenceRefs: Object.freeze([evidenceRef]),
    occurredAt: ts,
  };
  if (options.target !== undefined) {
    result.target = options.target;
  }
  if (options.runId !== undefined) {
    result.runId = options.runId;
  }
  if (options.identityIds !== undefined) {
    result.identityIds = options.identityIds;
  }
  return Object.freeze(result);
}

/**
 * Structural shape of one `BehavioralEvidence.runtimeErrors` entry.
 *
 * Declared here rather than imported from `src/domain/evidence.ts` so
 * this layer depends on nothing under `src/domain/**` — the same
 * layering #57 established for the durable product model. A
 * `runtimeErrors` array is assignable to `ReadonlyArray<RuntimeErrorRecord>`
 * without any change to #57 or to that file.
 */
export interface RuntimeErrorRecord {
  readonly ts: string;
  readonly where: string;
  readonly message: string;
}

export interface SetupFailureFromRuntimeErrorOptions {
  /** The declared id. Callers declare it; this module never mints one. */
  readonly id: SetupFailureId;
  /** Overrides the keyword inference. */
  readonly cause?: SetupFailureCause;
  readonly target?: EvaluationTargetRef;
  readonly runId?: EvaluationRunId;
  readonly identityIds?: ReadonlyArray<SyntheticIdentityId>;
  /** Index of the record within `runtimeErrors`, used in the locator. */
  readonly index?: number;
  /** Error field prefix for nested use. */
  readonly field?: string;
}

/**
 * Which subset of messages map to a given cause, in priority order.
 *
 * Ordered most-specific first, because a general keyword list placed
 * above a specific one will swallow it: "world operator provisioning
 * denied" contains "denied", and filing that as a plain
 * `policyDenied` would lose the fact that the World Operator boundary
 * was the thing that refused.
 *
 * A refusal and an unavailability are deliberately different causes.
 * "world state mutation is not permitted" is `policyDenied` — nobody
 * was *refused* the state that exists — so `worldStateUnavailable`
 * only matches phrasings where state could not be obtained at all,
 * rather than matching the phrase "world state" wherever it appears.
 */
const CAUSE_KEYWORDS: ReadonlyArray<readonly [SetupFailureCause, readonly string[]]> = [
  ['worldOperatorDenied', ['world operator', 'provisioning denied']],
  ['policyDenied', ['not permitted', 'forbidden', 'denied', 'not allowed', 'policy']],
  ['worldStateUnavailable', [
    'world state unavailable',
    'world state not found',
    'no world state',
    'could not seed',
    'cannot seed',
    'failed to seed',
    'missing fixture',
    'test account not found',
  ]],
  ['budgetExhausted', ['budget', 'quota exceeded', 'rate limit', 'exhausted']],
  ['providerUnavailable', ['api key', 'unauthorized', '401', '429', 'provider', 'model']],
  ['harnessUnavailable', [
    'econnrefused',
    'enotfound',
    'econnreset',
    'unreachable',
    'timeout',
    'timed out',
    'browser',
    'chromium',
    'launch',
    'connect',
    'dns',
  ]],
];

export function inferSetupFailureCause(message: string): SetupFailureCause {
  const haystack = message.toLowerCase();
  for (const [cause, keywords] of CAUSE_KEYWORDS) {
    if (keywords.some((keyword) => haystack.includes(keyword))) {
      return cause;
    }
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Guards and helpers
// ---------------------------------------------------------------------------

/** Type guard. The discriminant is literal, so this is exact. */
export function isFinding(value: unknown): value is Finding {
  return isRecordWithOutcome(value, 'productFinding');
}

/** Type guard. The counterpart of `isFinding`. */
export function isSetupFailure(value: unknown): value is SetupFailure {
  return isRecordWithOutcome(value, 'setupFailure');
}

/**
 * Either kind of review record, discriminated on `outcome`.
 *
 * #63 returns this from a run and switches on the discriminant, so
 * the setup/product decision is made once, at the boundary, and never
 * has to be re-guessed from the shape of the payload.
 */
export type ReviewOutcome = Finding | SetupFailure;

export function parseReviewOutcome(input: unknown, field = 'reviewOutcome'): ReviewOutcome {
  const raw = requireRecord(input, field);
  if (raw['outcome'] === 'setupFailure') return parseSetupFailure(raw, field);
  if (raw['outcome'] === 'productFinding') return parseFinding(raw, field);
  throw new ReviewContractError(
    `${field}.outcome must be "productFinding" or "setupFailure"`,
    `${field}.outcome`,
    { received: raw['outcome'] === null ? 'null' : typeof raw['outcome'] },
  );
}

const REPRESENTATIVENESS_CLAIM_KEYS = [
  'representative',
  'representativeSample',
  'representativeness',
  'humanSample',
  'humanRepresentativeness',
  'populationSize',
  'userSample',
  'sampleSize',
] as const;

const REPRESENTATIVENESS_CLAIM_PATTERN =
  /^(representative|representativeness|humanSample|humanRepresentativeness|populationSize|userSample)/;

/**
 * Reject a key that asserts a Synthetic Cohort stands in for humans.
 *
 * `rejectUnknownKeys` would already reject these; this runs first only
 * so the failure explains *why* the key is refused instead of listing
 * it as merely unknown. ADR-0011 allows u-sekai to earn a
 * representativeness claim with evidence — and #57's
 * `Confidence.calibration` is where such evidence would be recorded —
 * but not to assert one on a field of a finding.
 */
function rejectRepresentativenessClaim(raw: Record<string, unknown>, field: string): void {
  for (const key of Object.keys(raw)) {
    if ((REPRESENTATIVENESS_CLAIM_KEYS as ReadonlyArray<string>).includes(key)) {
      throw new ReviewContractError(
        `${field}.${key} is refused: no field of a finding may claim that a Synthetic Cohort is ` +
          `a representative sample of human users (ADR-0011 non-reality boundary). A calibration ` +
          `claim, if it is ever earned, belongs in confidence.calibration with a named yardstick.`,
        `${field}.${key}`,
        { key },
      );
    }
    if (REPRESENTATIVENESS_CLAIM_PATTERN.test(key)) {
      throw new ReviewContractError(
        `${field}.${key} is refused: a field name may not assert human representativeness ` +
          `(ADR-0011 non-reality boundary)`,
        `${field}.${key}`,
        { key },
      );
    }
  }
}

function isRecordWithOutcome(value: unknown, outcome: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { outcome?: unknown }).outcome === outcome
  );
}

function parseIdentityIdList(
  input: unknown,
  field: string,
  requireNonEmpty: true,
): ReadonlyArray<SyntheticIdentityId>;
function parseIdentityIdList(
  input: unknown,
  field: string,
  requireNonEmpty?: boolean,
): ReadonlyArray<SyntheticIdentityId>;
function parseIdentityIdList(
  input: unknown,
  field: string,
  requireNonEmpty = true,
): ReadonlyArray<SyntheticIdentityId> {
  const arr = requireNonEmpty ? requireNonEmptyArray(input, field) : requireArray(input, field);
  const ids = arr.map((v, i) => parseSyntheticIdentityId(v, `${field}[${i}]`));
  rejectDuplicates(ids, field);
  return Object.freeze(ids);
}
