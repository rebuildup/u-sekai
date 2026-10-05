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
 * ## A transition is *within one environment*
 *
 * `resolveVersionLineage` requires `previous.environmentId ===
 * current.environmentId`. ADR-0011's release transition is "a persistent
 * cohort experiences an earlier version and then a newer version" — the
 * experiment is a single environment promoted, so that memory, habits,
 * expectations and stored data formed under version A are still present
 * on version B. A staging-to-production promotion is a different
 * experiment with different state semantics, and silently treating it as
 * a release transition would join evidence that does not belong together.
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
  | 'environment-mismatch'
  | 'same-version'
  | 'not-advanced-in-time';

export const LINEAGE_GAP_EXPLANATIONS: Readonly<Record<LineageGap, string>> = Object.freeze({
  'insufficient-observations':
    'a release transition needs a previous and a current observation of the same environment',
  'environment-mismatch':
    'a release transition is one environment changing version, not one environment becoming another',
  'same-version': 'the two observations report the same environment version, so nothing transitioned',
  'not-advanced-in-time': 'the current observation is not strictly after the previous observation',
});

export type LineageResolution =
  | { readonly ok: true; readonly lineage: VersionLineage }
  | { readonly ok: false; readonly gap: LineageGap };

/**
 * Derive a version lineage from observations, or explain why there is
 * none.
 *
 * Only the two *latest* observations of a single environment are
 * considered. Reaching further back would let a three-observation
 * history pick a "previous" that is two versions stale, which is not the
 * transition a release-transition evaluation is about.
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
  if (previous.environmentId !== current.environmentId) {
    return { ok: false, gap: 'environment-mismatch' };
  }
  if (previous.version === current.version) {
    return { ok: false, gap: 'same-version' };
  }
  if (Date.parse(previous.observedAt) >= Date.parse(current.observedAt)) {
    return { ok: false, gap: 'not-advanced-in-time' };
  }
  return { ok: true, lineage: Object.freeze({ previous, current }) };
}
