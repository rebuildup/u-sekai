/**
 * Longitudinal change — what this finding says about *change* in the
 * product rather than about one moment in it (issue #61, ADR-0011).
 *
 * ## The issue leaves the shape open; here is the choice and why
 *
 * Issue #61 asks for a "longitudinal change classification" but does
 * not define it. Two tickets depend on the result, so the choice is
 * made deliberately rather than left to a bare string:
 *
 * 1. **`unknown` is a first-class value, not a missing field.** A
 *    point-in-time finding has no baseline, and a continuous finding
 *    raised on a first run has no predecessor. Representing that as
 *    "field absent" would make "we did not compare" and "we compared
 *    and found no change" indistinguishable in storage and in #64's
 *    aggregates. `mode: 'pointInTime'` therefore *requires*
 *    `change: 'unknown'` and `baseline: null` rather than allowing the
 *    field to be omitted.
 *
 * 2. **A comparative claim requires a joinable baseline.** If
 *    `change` is anything other than `unknown`, the module requires
 *    `isReleaseTransitionComparison(baseline, observed)` — #57's own
 *    predicate: same Review Program scope (`programKey`: Product,
 *    Cohort, Program), two distinct runs, at least one shared Synthetic
 *    Identity. This is the single most important rule in the file.
 *    Without it, "this is a regression introduced by version B" could
 *    be asserted for two runs with nothing in common but a cohort name,
 *    and ADR-0011's returning-user thesis would become unfalsifiable.
 *    #64's *longitudinal findings accepted* KPI is only meaningful
 *    because this rule exists.
 *
 *    The environment is deliberately *not* part of that scope. A release
 *    transition is a persistent cohort meeting an earlier and a newer
 *    version, which are normally two different deployments — so
 *    `env-staging` → `env-production` is the canonical case and must be
 *    accepted, while a different program or cohort must be rejected.
 *
 * 3. **Point-in-time and longitudinal findings share one envelope.**
 *    Both are `LongitudinalChange` on the same `Finding`; there is no
 *    separate "longitudinal finding" type. A consumer that handles the
 *    envelope handles all three of ADR-0011's evaluation modes.
 *
 * ## The baseline is a reference, not a copy
 *
 * `baseline` and `observed` are `RunLineage` values from #57 — the
 * same objects the run recorded. A finding therefore cannot carry a
 * baseline that disagrees with the run it claims to be about; there is
 * nothing to keep in sync, because there is only one value.
 */

import {
  isReleaseTransitionComparison,
  parseRunLineage,
  programKey,
  sameTarget,
} from '../product/lineage.js';
import type { EvaluationTargetRef, RunLineage } from '../product/lineage.js';
import { asReviewContractError, ReviewContractError } from './errors.js';
import { FindingId, parseFindingId } from './ids.js';
import {
  rejectDuplicates,
  rejectUnknownKeys,
  requireArray,
  requireNonEmptyString,
  requireOneOf,
  requireRecord,
} from './validation.js';

/**
 * Which of ADR-0011's three evaluation modes produced the observation.
 *
 * - `pointInTime` — one evaluation of a particular environment state.
 * - `continuous` — repeated exploration on a cadence or event trigger.
 * - `releaseTransition` — a persistent cohort across a version change.
 */
export const EVALUATION_MODES = ['pointInTime', 'continuous', 'releaseTransition'] as const;
export type EvaluationMode = (typeof EVALUATION_MODES)[number];

/**
 * What changed between the baseline and the observation.
 *
 * `unknown` means "no comparative claim was made" — see the module
 * docstring. The other five are claims and each one requires a
 * joinable baseline.
 */
export const CHANGE_KINDS = [
  'unknown',
  'introduced',
  'resolved',
  'persisted',
  'regressed',
  'unchanged',
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const MAX_CHANGE_NOTE_LENGTH = 1000;

export interface LongitudinalChange {
  readonly mode: EvaluationMode;
  readonly change: ChangeKind;
  /**
   * The earlier observation this finding compares against, or `null`
   * when no comparative claim is made.
   */
  readonly baseline: RunLineage | null;
  /** The run the finding was actually raised on. Always present. */
  readonly observed: RunLineage;
  /** Findings whose change this one supersedes or reverses, if any. */
  readonly relatedFindingIds?: ReadonlyArray<FindingId>;
  /** Why the change was classified this way. */
  readonly note?: string;
}

const LONGITUDINAL_FIELDS = [
  'mode',
  'change',
  'baseline',
  'observed',
  'relatedFindingIds',
  'note',
] as const;

export function parseLongitudinalChange(
  input: unknown,
  field = 'longitudinal',
): LongitudinalChange {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, LONGITUDINAL_FIELDS, field);

  const mode = requireOneOf(raw['mode'], EVALUATION_MODES, `${field}.mode`);
  const change = requireOneOf(raw['change'], CHANGE_KINDS, `${field}.change`);

  const observed = asReviewContractError(`${field}.observed`, () =>
    parseRunLineage(raw['observed'], `${field}.observed`),
  );

  let baseline: RunLineage | null = null;
  if (raw['baseline'] !== undefined && raw['baseline'] !== null) {
    baseline = asReviewContractError(`${field}.baseline`, () =>
      parseRunLineage(raw['baseline'], `${field}.baseline`),
    );
  }

  if (mode === 'pointInTime' && baseline !== null) {
    throw new ReviewContractError(
      `${field}.baseline must be null in pointInTime mode: a point-in-time evaluation has no ` +
        `earlier observation to compare against`,
      `${field}.baseline`,
      { mode },
    );
  }
  if (mode === 'releaseTransition' && baseline === null) {
    throw new ReviewContractError(
      `${field}.baseline is required in releaseTransition mode`,
      `${field}.baseline`,
      { mode },
    );
  }

  if (change !== 'unknown') {
    if (baseline === null) {
      throw new ReviewContractError(
        `${field}.change "${change}" is a comparative claim and requires a baseline; use ` +
          `"unknown" when no comparison was made`,
        `${field}.change`,
        { change },
      );
    }
    if (!isReleaseTransitionComparison(baseline, observed)) {
      throw new ReviewContractError(
        `${field}: change "${change}" requires a joinable baseline — the two runs must share ` +
          `the durable target and at least one Synthetic Identity (ADR-0011 release-transition ` +
          `mode), otherwise this is not a returning-user observation`,
        field,
        { change, baselineRunId: baseline.runId, observedRunId: observed.runId },
      );
    }
  }

  // A baseline is by definition an earlier observation of the same
  // program scope, so both of these are wrong whether or not a
  // comparative claim was made. Checked whenever a baseline exists
  // rather than only under a claim, because a reference to the wrong
  // run is a defect in the reference itself.
  //
  // The environment is deliberately *not* part of the scope check.
  // ADR-0011's release-transition mode is a persistent cohort
  // experiencing an earlier version and then a newer one, and those are
  // normally two different deployments of one product — so a baseline
  // on a different environment is the canonical case, not an error.
  // `isReleaseTransitionComparison` guards the same thing for claims;
  // this guard covers a baseline recorded without a claim.
  if (baseline !== null) {
    if (programKey(baseline) !== programKey(observed)) {
      throw new ReviewContractError(
        `${field}.baseline must belong to the same Review Program scope (Product, Cohort, ` +
          `Program) as the observed run; the environment may differ, since that is what a ` +
          `release transition varies along`,
        `${field}.baseline`,
        { baselineProgramKey: programKey(baseline), observedProgramKey: programKey(observed) },
      );
    }
    if (Date.parse(baseline.startedAt) > Date.parse(observed.startedAt)) {
      throw new ReviewContractError(
        `${field}.baseline.startedAt must not be after observed.startedAt`,
        `${field}.baseline.startedAt`,
        { baseline: baseline.startedAt, observed: observed.startedAt },
      );
    }
  }

  let relatedFindingIds: ReadonlyArray<FindingId> | undefined;
  if (raw['relatedFindingIds'] !== undefined) {
    const arr = requireArray(raw['relatedFindingIds'], `${field}.relatedFindingIds`);
    relatedFindingIds = Object.freeze(
      arr.map((v, i) => parseFindingId(v, `${field}.relatedFindingIds[${i}]`)),
    );
    rejectDuplicates(relatedFindingIds, `${field}.relatedFindingIds`);
  }

  const result: { -readonly [K in keyof LongitudinalChange]: LongitudinalChange[K] } = {
    mode,
    change,
    baseline,
    observed,
  };
  if (relatedFindingIds !== undefined) {
    result.relatedFindingIds = relatedFindingIds;
  }
  if (raw['note'] !== undefined) {
    result.note = requireNonEmptyString(raw['note'], `${field}.note`, MAX_CHANGE_NOTE_LENGTH);
  }
  return Object.freeze(result);
}

/**
 * Assert that a finding's declared target matches the target of the
 * run it says it observed, and that any baseline belongs to the same
 * Review Program scope.
 *
 * Called from `parseFinding`. A finding whose `target` names a
 * different environment or cohort than its own observed run would make
 * #64's per-product and per-cohort aggregates wrong in a way no later
 * check could detect, so the cross-field mismatch is rejected here.
 *
 * The two checks are deliberately different in strictness:
 *
 * - `observed` must match the target exactly, environment included. The
 *   finding is a claim about *this* deployment, so the run that
 *   produced it must have been against *this* deployment.
 * - `baseline` must match only the Program scope (`programKey`: Product,
 *   Cohort, Program). The environment is excluded because it is the
 *   axis a release transition varies along — a baseline on
 *   `env-staging` and an observation on `env-production` is the
 *   canonical returning-user comparison, and requiring them to match
 *   would reject exactly the case ADR-0011 describes.
 */
export function assertObservedTarget(
  longitudinal: LongitudinalChange,
  target: EvaluationTargetRef,
  field = 'longitudinal.observed',
  baselineField = 'longitudinal.baseline',
): void {
  if (!sameTarget(longitudinal.observed, target)) {
    throw new ReviewContractError(
      `${field} must observe the finding's own target; a finding may not be attributed to a ` +
        `Product/Environment/Cohort/Program its run did not evaluate`,
      field,
      {
        findingTarget: [target.productId, target.environmentId, target.cohortId, target.programId],
        observedTarget: [
          longitudinal.observed.productId,
          longitudinal.observed.environmentId,
          longitudinal.observed.cohortId,
          longitudinal.observed.programId,
        ],
      },
    );
  }
  if (longitudinal.baseline !== null && programKey(longitudinal.baseline) !== programKey(target)) {
    throw new ReviewContractError(
      `${baselineField} must share the finding's Review Program scope (Product, Cohort, Program); ` +
        `the environment may differ, since that is the axis a release transition varies along`,
      baselineField,
      { findingProgramKey: programKey(target), baselineProgramKey: programKey(longitudinal.baseline) },
    );
  }
}

/** True when the change makes a comparative claim about the product. */
export function isComparativeChange(change: LongitudinalChange): boolean {
  return change.change !== 'unknown';
}
