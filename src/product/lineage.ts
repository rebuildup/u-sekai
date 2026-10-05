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
 */
export function isReleaseTransitionComparison(a: RunLineage, b: RunLineage): boolean {
  if (a.runId === b.runId) return false;
  if (programKey(a) !== programKey(b)) return false;
  const bIdentities = new Set<string>(b.identityIds);
  return a.identityIds.some((id) => bIdentities.has(id));
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
