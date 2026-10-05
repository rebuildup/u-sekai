/**
 * Environment observations — the version lineage a release-transition
 * plan preserves (ADR-0011, issue #62).
 *
 * ## Why this module exists
 *
 * `Environment` in `src/product/environment.ts` deliberately carries no
 * version, branch, commit or deployment field: ADR-0011 makes the
 * deployable environment the review target and refuses to reduce it to a
 * source diff. But ADR-0011's second evaluation mode — release
 * transition — is meaningless without knowing *which version* an
 * environment was serving, before and after.
 *
 * The resolution is to treat the version as an **observation**: a
 * timestamped record of "this environment answered as this version when
 * it was looked at". The environment stays the target; the version is
 * lineage metadata attached to an observation of it. Nothing here makes
 * a version into an identity, and nothing here resolves a diff.
 *
 * ## The environment is the axis a transition varies *along*
 *
 * #57's `programKey` joins a `ReviewProgram` and a `Cohort` and
 * deliberately **excludes** the environment, and
 * `isReleaseTransitionComparison` treats the environment as the thing
 * that changes rather than the thing that must match. So the canonical
 * release transition here is the *same cohort on the same program,
 * observed against a different deployment* — a staging version before,
 * the environment it was promoted into after.
 *
 * `resolveVersionLineage` follows that. It accepts both shapes and
 * records which one it found in `VersionLineage.kind`:
 *
 * - `crossEnvironment` — different environment, different version. The
 *   ordinary case: a build observed in one environment and the same
 *   build line observed in the next.
 * - `sameEnvironment` — one environment promoted to a new version. Also
 *   a real transition, and the shape #57's own acceptance tests cover.
 *
 * An earlier revision of this module rejected the cross-environment
 * shape. That was compensating for the *previous* #57 contract, which
 * required an equal `environmentId`; it was removed rather than kept,
 * because under the current contract it would reject the exact case the
 * predicate exists to recognise.
 */

import { EnvironmentId, parseEnvironmentId } from '../product/index.js';
import {
  rejectDuplicates,
  rejectUnknownKeys,
  requireIsoInstant,
  requireRecord,
} from '../product/validation.js';
import { ProgramPlanningError } from './errors.js';
import { ObservationId, parseEnvironmentVersion, parseObservationId } from './ids.js';

export interface EnvironmentObservation {
  readonly observationId: ObservationId;
  readonly environmentId: EnvironmentId;
  /** Opaque build/version label the environment was serving. */
  readonly version: string;
  /** ISO-8601 instant the observation was taken. */
  readonly observedAt: string;
}

/**
 * The ordered pair of observations that makes a release transition
 * legible: what the environment was, and what it became.
 *
 * Both halves are preserved verbatim on the plan. Dropping `previous`
 * after computing it would make the join key unreconstructable, and
 * #67's comparison and #64's KPI layer both need it.
 */
export interface VersionLineage {
  readonly previous: EnvironmentObservation;
  readonly current: EnvironmentObservation;
  /**
   * Which shape of transition this is. See the module docstring: #57's
   * `programKey` excludes the environment, so a move to a different
   * environment of the same product is the ordinary case, and a plan
   * that cannot say which shape it carries would force #67 to
   * rediscover it.
   */
  readonly kind: 'sameEnvironment' | 'crossEnvironment';
}

const OBSERVATION_FIELDS = ['observationId', 'environmentId', 'version', 'observedAt'] as const;

export function parseEnvironmentObservation(
  input: unknown,
  field = 'observation',
): EnvironmentObservation {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, OBSERVATION_FIELDS, field);
  return Object.freeze({
    observationId: parseObservationId(raw['observationId'], `${field}.observationId`),
    environmentId: parseEnvironmentId(raw['environmentId'], `${field}.environmentId`),
    version: parseEnvironmentVersion(raw['version'], `${field}.version`),
    observedAt: requireIsoInstant(raw['observedAt'], `${field}.observedAt`),
  });
}

export function parseEnvironmentObservations(
  input: unknown,
  field = 'input.observations',
): ReadonlyArray<EnvironmentObservation> {
  if (input === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(input)) {
    throw new ProgramPlanningError(`${field} must be an array`, field);
  }
  const observations = input.map((v, i) => parseEnvironmentObservation(v, `${field}[${i}]`));
  rejectDuplicates(
    observations.map((o) => o.observationId),
    field,
  );
  return Object.freeze(observations);
}

/**
 * Total order on observations: by `observedAt`, then by
 * `observationId` as a tiebreak.
 *
 * The tiebreak is what makes ordering total. Two observations taken in
 * the same millisecond must still sort deterministically, or "the
 * current observation" would depend on input array order and the same
 * inputs could yield two different plans.
 */
export function compareObservations(a: EnvironmentObservation, b: EnvironmentObservation): number {
  const delta = Date.parse(a.observedAt) - Date.parse(b.observedAt);
  if (delta !== 0) return delta < 0 ? -1 : 1;
  if (a.observationId === b.observationId) return 0;
  return a.observationId < b.observationId ? -1 : 1;
}

export function sortObservations(
  observations: readonly EnvironmentObservation[],
): ReadonlyArray<EnvironmentObservation> {
  return Object.freeze([...observations].sort(compareObservations));
}

/** Why two observations are not a release transition, in operator words. */
export type LineageGap =
  | 'insufficient-observations'
  | 'same-version'
  | 'not-advanced-in-time';

export const LINEAGE_GAP_EXPLANATIONS: Readonly<Record<LineageGap, string>> = Object.freeze({
  'insufficient-observations':
    'a release transition needs a previous and a current observation of the same program scope',
  'same-version': 'the two observations report the same version, so nothing transitioned',
  'not-advanced-in-time': 'the current observation is not strictly after the previous observation',
});

export type LineageResolution =
  | { readonly ok: true; readonly lineage: VersionLineage }
  | { readonly ok: false; readonly gap: LineageGap };

/**
 * Derive a version lineage from observations, or explain why there is
 * none.
 *
 * Only the two *latest* observations are considered. Reaching further
 * back would let a three-observation history pick a "previous" that is
 * two versions stale, which is not the transition a release-transition
 * evaluation is about.
 *
 * The caller must pass observations already scoped to one program's
 * declared environments; this function does not know a program's scope
 * and will happily build a lineage across two products if handed both.
 */
export function resolveVersionLineage(
  observations: readonly EnvironmentObservation[],
): LineageResolution {
  if (observations.length < 2) {
    return { ok: false, gap: 'insufficient-observations' };
  }
  const ordered = sortObservations(observations);
  const current = ordered[ordered.length - 1];
  const previous = ordered[ordered.length - 2];
  if (current === undefined || previous === undefined) {
    return { ok: false, gap: 'insufficient-observations' };
  }
  if (previous.version === current.version) {
    return { ok: false, gap: 'same-version' };
  }
  if (Date.parse(previous.observedAt) >= Date.parse(current.observedAt)) {
    return { ok: false, gap: 'not-advanced-in-time' };
  }
  const kind =
    previous.environmentId === current.environmentId ? 'sameEnvironment' : 'crossEnvironment';
  return { ok: true, lineage: Object.freeze({ previous, current, kind }) };
}
