/**
 * Stable references for run and evidence lineage (ADR-0011, issue #57).
 *
 * ## Why this module exists
 *
 * ADR-0011 names "cross-release comparisons require careful identity,
 * environment, and evidence lineage" as a cost of the durable model.
 * A release-transition evaluation is only meaningful if the evidence
 * from version A and version B can be joined on the same identity and
 * the same program. These types are that join key.
 *
 * ## The product layer does not own run identity
 *
 * `EvaluationRunId` is an opaque, foreign key. The durable model records
 * *which run observed what*, but the runtime that executes a run mints
 * the run id and owns its format. This is deliberate: making the product
 * layer own run identity would couple it to the experiment runtime,
 * which is exactly the independence #57 has to establish. Nothing here
 * imports `src/domain/**`, `src/experiment/**` or `RunResult`.
 *
 * ## Version identity is an observation, not an identity (issue #83)
 *
 * `Environment` deliberately carries no version (`environment.ts`).
 * That is an ADR-0011 decision, not an oversight, and it is the reason
 * this module had no way to tell a *version* boundary from an
 * *environment-name* boundary: `isReleaseTransitionComparison` could
 * only see that two lineages named different environments.
 *
 * The fix is **not** a `versionId` field. `environment.ts` says
 * explicitly that a version is not part of what an environment *is*, and
 * #62's `EnvironmentObservation` already exists to carry the version as
 * a **timestamped observation** — "this environment answered as this
 * version when it was looked at". Inventing a second place to record a
 * version would create exactly the drift the durable model exists to
 * prevent.
 *
 * So the version arrives here the same way #62's observation does: as a
 * value the caller supplies from its observation record, checked here
 * against the lineage's own run window. `resolveVersionBoundary` is the
 * only place the two meet, and it *fails closed* — see its docstring.
 */

import { ProductDomainError } from './errors.js';
import {
  Brand,
  CohortId,
  EnvironmentId,
  parseCohortId,
  parseEnvironmentId,
  parseProductId,
  parseReviewProgramId,
  parseSyntheticIdentityId,
  ProductId,
  ReviewProgramId,
  SyntheticIdentityId,
} from './ids.js';
import {
  rejectDuplicates,
  rejectUnknownKeys,
  requireIsoInstant,
  requireNonEmptyString,
  requireRecord,
} from './validation.js';

/**
 * Opaque handle for one execution of an Evaluation Run.
 *
 * Minted and owned outside this layer. Branded only so a raw `string`
 * cannot be passed in its place by accident.
 */
export type EvaluationRunId = Brand<string, 'EvaluationRunId'>;

/** Durable reference to an event-family observation, for evidence joins. */
export type EvidenceId = Brand<string, 'EvidenceId'>;

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

export function parseEvaluationRunId(value: unknown, field = 'runId'): EvaluationRunId {
  return requireHandle(value, field, RUN_ID_PATTERN, 'EvaluationRunId') as EvaluationRunId;
}

export function parseEvidenceId(value: unknown, field = 'evidenceId'): EvidenceId {
  return requireHandle(value, field, EVIDENCE_ID_PATTERN, 'EvidenceId') as EvidenceId;
}

/**
 * The durable identities one evaluation run was observing.
 *
 * This is the unit a Review Program resolves to: `where` and `who` are
 * already fixed, so two runs carrying an equal target are comparable.
 */
export interface EvaluationTargetRef {
  readonly productId: ProductId;
  readonly environmentId: EnvironmentId;
  readonly cohortId: CohortId;
  readonly programId: ReviewProgramId;
}

/**
 * One run's lineage: the durable target it observed, which identities
 * actually took part, and when.
 *
 * `identityIds` is the *resolved* membership, so evidence from a
 * release-transition run carries the same identity id as the run before
 * the release. That is the join ADR-0011's second evaluation mode needs.
 */
export interface RunLineage extends EvaluationTargetRef {
  readonly runId: EvaluationRunId;
  readonly identityIds: ReadonlyArray<SyntheticIdentityId>;
  readonly startedAt: string;
  readonly endedAt?: string;
  /** Optional evidence handles observed during this run. */
  readonly evidenceIds?: ReadonlyArray<EvidenceId>;
}

const TARGET_FIELDS = ['productId', 'environmentId', 'cohortId', 'programId'] as const;
const LINEAGE_FIELDS = [...TARGET_FIELDS, 'runId', 'identityIds', 'startedAt', 'endedAt', 'evidenceIds'] as const;

export function parseEvaluationTargetRef(
  input: unknown,
  field = 'target',
): EvaluationTargetRef {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, TARGET_FIELDS, field);
  return Object.freeze({
    productId: parseProductId(raw['productId'], `${field}.productId`),
    environmentId: parseEnvironmentId(raw['environmentId'], `${field}.environmentId`),
    cohortId: parseCohortId(raw['cohortId'], `${field}.cohortId`),
    programId: parseReviewProgramId(raw['programId'], `${field}.programId`),
  });
}

export function parseRunLineage(input: unknown, field = 'lineage'): RunLineage {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, LINEAGE_FIELDS, field);

  const target = parseEvaluationTargetRef(
    {
      productId: raw['productId'],
      environmentId: raw['environmentId'],
      cohortId: raw['cohortId'],
      programId: raw['programId'],
    },
    field,
  );

  const runId = parseEvaluationRunId(raw['runId'], `${field}.runId`);

  const rawIdentities = raw['identityIds'];
  if (!Array.isArray(rawIdentities) || rawIdentities.length === 0) {
    throw new ProductDomainError(
      `${field}.identityIds must be a non-empty array`,
      `${field}.identityIds`,
    );
  }
  const identityIds = rawIdentities.map((v, i) =>
    parseSyntheticIdentityId(v, `${field}.identityIds[${i}]`),
  );
  rejectDuplicates(identityIds, `${field}.identityIds`);

  const startedAt = requireIsoInstant(raw['startedAt'], `${field}.startedAt`);
  const endedAt =
    raw['endedAt'] === undefined ? undefined : requireIsoInstant(raw['endedAt'], `${field}.endedAt`);
  if (endedAt !== undefined && Date.parse(endedAt) < Date.parse(startedAt)) {
    throw new ProductDomainError(
      `${field}.endedAt must not precede startedAt`,
      `${field}.endedAt`,
      { startedAt, endedAt },
    );
  }

  const rawEvidence = raw['evidenceIds'];
  let evidenceIds: ReadonlyArray<EvidenceId> | undefined;
  if (rawEvidence !== undefined) {
    if (!Array.isArray(rawEvidence)) {
      throw new ProductDomainError(`${field}.evidenceIds must be an array`, `${field}.evidenceIds`);
    }
    const parsed = rawEvidence.map((v, i) => parseEvidenceId(v, `${field}.evidenceIds[${i}]`));
    rejectDuplicates(parsed, `${field}.evidenceIds`);
    evidenceIds = Object.freeze(parsed);
  }

  const result: { -readonly [K in keyof RunLineage]: RunLineage[K] } = {
    ...target,
    runId,
    identityIds: Object.freeze(identityIds),
    startedAt,
  };
  if (endedAt !== undefined) {
    result.endedAt = endedAt;
  }
  if (evidenceIds !== undefined) {
    result.evidenceIds = evidenceIds;
  }
  return Object.freeze(result);
}

/**
 * Key for joining two runs that observed the same durable target.
 * Environment is included: it identifies *which* deployment was
 * observed, so two runs are the same target only when they looked at the
 * same deployment. For comparing a transition *between* deployments, use
 * `programKey` — the environment is the thing that changes, not the thing
 * that must match.
 */
export function targetKey(target: EvaluationTargetRef): string {
  return [target.productId, target.environmentId, target.cohortId, target.programId].join('|');
}

/** Whether two lineages observed the same durable target. */
export function sameTarget(a: EvaluationTargetRef, b: EvaluationTargetRef): boolean {
  return targetKey(a) === targetKey(b);
}

/**
 * Key for the durable scope a Review Program evaluates, excluding the
 * environment.
 *
 * This is the axis a release transition varies *along*: the same program
 * and the same cohort observed against a different deployment.
 */
export function programKey(target: EvaluationTargetRef): string {
  return [target.productId, target.cohortId, target.programId].join('|');
}

/**
 * Whether two lineages form a release-transition comparison: the same
 * program scope, at least one shared identity, and two distinct runs.
 *
 * This is the predicate #67's acceptance scenario and the KPI layer
 * (#64) both need. Two conditions are load-bearing:
 *
 * - **The environment is deliberately excluded.** ADR-0011's
 *   release-transition mode is a persistent cohort experiencing an
 *   earlier version and then a newer one, and those two versions are
 *   usually two *different* environments of the same product. Requiring
 *   an equal `environmentId` here would reject the exact case the
 *   predicate exists to recognise. The environment still distinguishes
 *   the two observations; it is recorded on each lineage.
 * - **A shared identity is required.** Two runs of the same program with
 *   disjoint members are not a returning-user observation, and must not
 *   be reported as one.
 *
 * A comparison across two *different* programs or cohorts is not a
 * transition: `programKey` guards that.
 *
 * ## This predicate is a *necessary* condition, not a sufficient one
 *
 * `isReleaseTransitionComparison` answers "are these two runs the same
 * program scope observed by a returning identity?". It cannot answer
 * "did they cross a version boundary", because a `RunLineage` carries no
 * version: `environment.ts` deliberately declares none, and adding one
 * here would duplicate the observation #62 already records. A pair of
 * runs of one build, exposed under two environment names, satisfies this
 * predicate — and is correctly *not* a release transition.
 *
 * Use {@link resolveVersionBoundary} to close that gap. Callers that
 * assert a release transition should call both: this one for the scope
 * join, that one for the version crossing. Callers that only need the
 * scope join (a `continuous` finding, say) keep calling this alone and
 * are unaffected.
 */
export function isReleaseTransitionComparison(a: RunLineage, b: RunLineage): boolean {
  if (a.runId === b.runId) return false;
  if (programKey(a) !== programKey(b)) return false;
  const bIdentities = new Set<string>(b.identityIds);
  return a.identityIds.some((id) => bIdentities.has(id));
}

/**
 * The version label one environment was observed serving at one instant.
 *
 * ## This is an observation, not an identity
 *
 * An `Environment` is a durable target and by ADR-0011 carries no
 * version, branch, commit or deployment field — see `environment.ts`,
 * which also refuses those keys at parse time. What a *particular
 * deployment* was serving at a *particular moment* is a different fact,
 * and this type names only that fact.
 *
 * The grammar is deliberately identical to #62's `EnvironmentVersion`
 * (`src/program/ids.ts`), so a version #62 accepts is a version this
 * layer accepts and the two cannot drift on spelling. Both are opaque:
 * nothing here parses a semver, resolves a Git ref, or orders two
 * versions. "Newer than" is a statement about a deployment pipeline,
 * not about a string, and the product layer does not own that pipeline.
 */
export type ObservedVersion = Brand<string, 'ObservedVersion'>;

const OBSERVED_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export function parseObservedVersion(value: unknown, field = 'version'): ObservedVersion {
  return requireHandle(value, field, OBSERVED_VERSION_PATTERN, 'ObservedVersion') as ObservedVersion;
}

/** One environment's version, observed at one instant. */
export interface VersionObservation {
  readonly environmentId: EnvironmentId;
  /** Opaque build/version label, as observed — never resolved to a diff. */
  readonly version: ObservedVersion;
  /** ISO-8601 instant the observation was taken. */
  readonly observedAt: string;
}

const VERSION_OBSERVATION_FIELDS = ['environmentId', 'version', 'observedAt'] as const;

/**
 * Deep-parse one version observation from untrusted input.
 *
 * `resolveVersionBoundary` compares two versions for equality and orders
 * two instants. A `VersionObservation` is a plain structural type, so a
 * caller can also build one by hand without going through here — which is
 * why {@link resolveVersionBoundary} re-validates rather than trusting its
 * arguments. This function is the ergonomic path for callers reading from
 * storage or config; it is not the only guard.
 */
export function parseVersionObservation(
  input: unknown,
  field = 'versionObservation',
): VersionObservation {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, VERSION_OBSERVATION_FIELDS, field);
  return Object.freeze({
    environmentId: parseEnvironmentId(raw['environmentId'], `${field}.environmentId`),
    version: parseObservedVersion(raw['version'], `${field}.version`),
    observedAt: requireIsoInstant(raw['observedAt'], `${field}.observedAt`),
  });
}

/**
 * Why a pair of observations did not establish a version boundary.
 *
 * A closed set, so a caller renders every rejection from this table
 * rather than inventing wording for the case it forgot.
 */
export type VersionBoundaryGap =
  /** Both observations report the same version. Nothing transitioned. */
  | 'same-version'
  /** The current observation is not strictly later than the previous one. */
  | 'not-advanced-in-time'
  /** The two observations are not a pair this lineage can join. */
  | 'not-joinable';

export const VERSION_BOUNDARY_EXPLANATIONS: Readonly<Record<VersionBoundaryGap, string>> =
  Object.freeze({
    'same-version':
      'both observations report the same version, so no version boundary was crossed — ' +
      'a differing environment name alone is not a release transition',
    'not-advanced-in-time':
      'the current observation is not strictly after the previous one, so it cannot be a later version',
    'not-joinable':
      'the observations are not a comparable pair for this run, so no version boundary can be established',
  });

export type VersionBoundaryResolution =
  | { readonly ok: true; readonly previous: VersionObservation; readonly current: VersionObservation }
  | { readonly ok: false; readonly gap: VersionBoundaryGap };

/**
 * Establish that two runs crossed a **version** boundary, not merely an
 * environment-name boundary.
 *
 * ## Why this fails closed
 *
 * Every rejection refuses to assert something the evidence does not
 * support. `same-version` is a rejection, not a pass: two runs of one
 * build exposed under two environment names is the exact case issue
 * #83 names, and accepting it would let a report claim a release
 * transition that never happened. A missing or malformed version is
 * refused by `parseObservedVersion`, so no path here treats "unknown"
 * as "different" — and because the two versions are compared for
 * *equality* rather than for an assumed ordering, an absent `previous`
 * cannot be silently treated as an earlier build.
 *
 * ## Why this is a separate call rather than a wider predicate
 *
 * Widening `isReleaseTransitionComparison` would have changed the
 * meaning of every existing caller — `src/review/longitudinal.ts` and
 * `src/runtime/execute.ts` both call it — and would have re-refused the
 * cross-environment case #57 relaxed it *for* in `ce71c14`, because
 * those callers carry no version at all. Keeping the version crossing
 * a separate, opt-in call preserves their behaviour exactly while giving
 * #67 a version boundary it can actually assert.
 *
 * ## Why the observations are re-parsed here
 *
 * `VersionObservation` is a structural type, so a caller can build one
 * by hand and hand this function `observedAt: 'soon'`. `Date.parse`
 * returns `NaN` for that, every comparison against `NaN` is `false`,
 * and a naive ordering check would sail past it — the gate would fail
 * *open* and accept an unordered pair. Re-parsing through
 * `parseVersionObservation` makes the refusal explicit and typed: an
 * unorderable instant raises rather than being silently tolerated. The
 * same re-parse rejects a `version` that is not a string, which would
 * otherwise let `3` and `'3'` register as two different builds.
 *
 * ## Why the instants are checked
 *
 * A version boundary claims the observed version *changed between* the
 * two runs. Ordering the observations by their own `observedAt` alone
 * would accept a pair whose "previous" was observed before the baseline
 * run even started — which describes some earlier run, not this one.
 * So `previous` must fall at or after the baseline's `startedAt`, and
 * `current` strictly after `previous`. That makes "before" a claim about
 * instants the lineage itself carries, not about a version string.
 *
 * @param baseline  the earlier run's lineage
 * @param previous  the version observed at or after that run started
 * @param current   the version observed strictly after `previous`
 */
export function resolveVersionBoundary(
  baseline: RunLineage,
  previous: VersionObservation,
  current: VersionObservation,
): VersionBoundaryResolution {
  const validatedPrevious = parseVersionObservation(previous, 'previous');
  const validatedCurrent = parseVersionObservation(current, 'current');
  if (validatedPrevious.version === validatedCurrent.version) {
    return { ok: false, gap: 'same-version' };
  }
  const previousAt = Date.parse(validatedPrevious.observedAt);
  const currentAt = Date.parse(validatedCurrent.observedAt);
  if (previousAt >= currentAt) {
    return { ok: false, gap: 'not-advanced-in-time' };
  }
  if (previousAt < Date.parse(baseline.startedAt)) {
    return { ok: false, gap: 'not-joinable' };
  }
  // No symmetric check for `current` is needed: the ordering check above
  // establishes `currentAt > previousAt`, and the guard below establishes
  // `previousAt >= baseline.startedAt`, so `currentAt` is already inside
  // the window. A second test would be unreachable, not defensive.
  return { ok: true, previous: validatedPrevious, current: validatedCurrent };
}

function requireHandle(
  value: unknown,
  field: string,
  pattern: RegExp,
  typeName: string,
): string {
  const raw = requireNonEmptyString(value, field, 256);
  if (!pattern.test(raw)) {
    throw new ProductDomainError(
      `${field} must be a valid ${typeName} handle`,
      field,
      { received: raw, typeName },
    );
  }
  return raw;
}
