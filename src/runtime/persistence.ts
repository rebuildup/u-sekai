/**
 * Cohort and transition persistence (issue #63).
 *
 * ## The runtime persists through #60 and writes nothing itself
 *
 * Every write here is a read-modify-write on `CohortStateService`, so
 * the cross-release-stable key is #60's to compute and a value that
 * could not be read back is never stored. There is no file write, no
 * cache and no in-process shadow copy in this module, which is what
 * makes "identity ids survive a process restart" a structural property
 * rather than a promise: a second process over the same directory
 * resolves the same members from the same bytes.
 *
 * ## "Only the explicitly persisted state" is a whitelist, not a filter
 *
 * The runtime records exactly two things per identity per run:
 *
 * 1. a `RecordedObservation` — environment, version, instant, run id —
 *    and
 * 2. the retained-state touch, and **only** when the identity's
 *    declared `stateRetention` is not `none`.
 *
 * Nothing else is written. The participant's conversation, its
 * observations, its self-report and the run's evidence stay in the
 * run's own artifact directory; none of them is copied into the durable
 * identity record. That is the difference between "retains the state it
 * was told to retain" and "retains everything it saw", and it is why
 * this module touches exactly one counter.
 *
 * ## The release window brackets the *second* run
 *
 * `openReleaseWindow` runs before the identities execute and
 * `closeReleaseWindow` after they have been persisted, so the retained
 * state a `release` identity accumulated under version A is present
 * for its version-B run and gone afterwards. #60 owns the semantics;
 * this module only chooses when to call it, and only when the plan
 * actually declares version lineage.
 */

import type {
  CohortId,
  EnvironmentId,
  SyntheticIdentity,
  SyntheticIdentityId,
} from '../product/index.js';
import type { IdentityState } from '../cohort/index.js';
import type { CohortStateService } from '../cohort/index.js';
import { isCohortStateError } from '../cohort/index.js';
import type { EvaluationPlan } from '../program/index.js';
import { RuntimeIntegrationError } from './errors.js';

export interface ResolveCohortInput {
  readonly service: CohortStateService;
  readonly cohortId: CohortId;
  /** The plan's declared per-plan cap on identities. */
  readonly planningCeiling: number;
  /** Instant stamped onto the resolution, for determinism. */
  readonly resolvedAt: string;
}

export interface ResolvedCohort {
  /** The durable state after membership was resolved. */
  readonly state: Awaited<ReturnType<CohortStateService['loadCohort']>>;
  /** Declarations for the members that were actually selected. */
  readonly members: ReadonlyArray<SyntheticIdentity>;
  /** Distinct lifecycles among the members, sorted. */
  readonly lifecycles: ReadonlyArray<string>;
  /**
   * Members the plan's ceiling excluded. Reported rather than dropped,
   * so a run that covered 3 of a cohort's 10 members is legible.
   */
  readonly excludedByCeiling: ReadonlyArray<SyntheticIdentityId>;
}

/**
 * Resolve which identities this run covers.
 *
 * The plan's `cohort.planningCeiling` is the bound, and it is applied
 * *after* #60's own resolution so the durable membership rule stays
 * authoritative: the runtime narrows, it does not re-select. Members
 * come back in the order #60 stored them (ascending identity id), so
 * the same cohort and ceiling always produce the same run.
 *
 * Membership is stored as ids, so each selected id is loaded back
 * through `loadIdentity`. That is a second read rather than a shortcut
 * around #60: `loadIdentity` raises on a missing record instead of
 * returning a replacement, and a run that silently dropped a member
 * would understate the very cohort the finding lineage names.
 */
export async function resolveCohort(input: ResolveCohortInput): Promise<ResolvedCohort> {
  const state = await guard('cohort.resolve', () =>
    input.service.resolveCohort(input.cohortId, { resolvedAt: input.resolvedAt }),
  );

  const membership = state.membership;
  if (membership === undefined) {
    throw new RuntimeIntegrationError(
      `cohort ${input.cohortId} resolved without membership; a run cannot select identities ` +
        'from an unresolved cohort',
      'emptyCohort',
      'cohort.membership',
      { cohortId: input.cohortId },
    );
  }

  const ordered = [...membership.members].sort();
  const selected = ordered.slice(0, Math.max(0, input.planningCeiling));
  const excluded = ordered.slice(selected.length);

  const members: SyntheticIdentity[] = [];
  for (const id of selected) {
    const loaded = await guard('identity.loadIdentity', () => input.service.loadIdentity(id));
    members.push(loaded.identity);
  }

  if (members.length === 0) {
    throw new RuntimeIntegrationError(
      `cohort ${input.cohortId} resolved to no eligible member for this plan; ` +
        `${membership.excluded.length} identity/identities were excluded and the plan's ` +
        `planning ceiling is ${input.planningCeiling}`,
      'emptyCohort',
      'cohort.membership',
      {
        cohortId: input.cohortId,
        excluded: membership.excluded,
        planningCeiling: input.planningCeiling,
      },
    );
  }

  return Object.freeze({
    state,
    members: Object.freeze(members),
    lifecycles: Object.freeze([...new Set(members.map((m) => m.lifecycle))].sort()),
    excludedByCeiling: Object.freeze(excluded),
  });
}

export interface OpenTransitionInput {
  readonly service: CohortStateService;
  readonly plan: EvaluationPlan;
  readonly members: ReadonlyArray<SyntheticIdentity>;
  readonly openedAt: string;
}

/**
 * Refuse a release-transition plan whose members cannot span a
 * transition.
 *
 * Only a `release` lifecycle has a window — #60's `openReleaseWindow`
 * raises for any other lifecycle, and it is right to: an `ephemeral`
 * identity retains nothing to carry, and a `persistent` one is
 * accumulating across every run rather than across one transition.
 *
 * This is a check rather than a filter on purpose. Silently skipping
 * the ineligible members would let a plan claim a returning-user
 * comparison that no identity could participate in, and #61's
 * `isReleaseTransitionComparison` would then reject the resulting
 * finding for a reason that names the wrong thing. Reporting it here
 * names the members that caused it, at the point where the mistake was
 * made and before anything has been provisioned, driven or billed for.
 *
 * A plan with no version lineage is exempt: a `continuous` or
 * `pointInTime` plan has no transition to bracket.
 */
export function assertTransitionEligible(
  plan: EvaluationPlan,
  members: ReadonlyArray<SyntheticIdentity>,
  field = 'plan.lineage',
): void {
  if (plan.lineage === undefined) return;
  const ineligible = members.filter((m) => m.lifecycle !== 'release').map((m) => m.id);
  if (ineligible.length === 0) return;
  throw new RuntimeIntegrationError(
    'a releaseTransition plan covers identities that cannot span a transition: ' +
      `${ineligible.join(', ')}. Only the "release" lifecycle retains state across one ` +
      'version change; an "ephemeral" identity retains nothing and a "persistent" one is not a ' +
      'single-transition case.',
    'planNotInModel',
    field,
    { ineligibleIdentityIds: ineligible, requiredLifecycle: 'release' },
  );
}

/**
 * Open the release window for every member.
 *
 * Callers are expected to have run {@link assertTransitionEligible}
 * first, so this is a straight loop: one read-modify-write per member,
 * each under the same cross-release-stable key #60 owns.
 */
export async function openReleaseWindows(
  input: OpenTransitionInput,
): Promise<ReadonlyArray<SyntheticIdentityId>> {
  const previous = input.plan.lineage?.previous;
  if (previous === undefined) return Object.freeze([]);
  assertTransitionEligible(input.plan, input.members);

  const opened: SyntheticIdentityId[] = [];
  for (const member of input.members) {
    await guard('identity.openTransition', () =>
      input.service.openTransition(member.id, {
        fromVersion: previous.version,
        openedAt: input.openedAt,
      }),
    );
    opened.push(member.id);
  }
  return Object.freeze(opened);
}

export interface PersistRunInput {
  readonly service: CohortStateService;
  readonly plan: EvaluationPlan;
  readonly members: ReadonlyArray<SyntheticIdentity>;
  readonly environmentId: EnvironmentId;
  /** The version the environment was observed at. */
  readonly version: string;
  readonly runId: string;
  readonly observedAt: string;
  /** When false, no retained state is touched and no observation is added. */
  readonly persistObservations?: boolean;
  /** Closes the release window, when the plan declares version lineage. */
  readonly closeTransition?: boolean;
}

export interface PersistRunResult {
  /** The durable state of each member after the run, by identity id. */
  readonly states: ReadonlyArray<IdentityState>;
  readonly persistedIdentityIds: ReadonlyArray<SyntheticIdentityId>;
  readonly skippedIdentityIds: ReadonlyArray<SyntheticIdentityId>;
  readonly closedTransitions: ReadonlyArray<SyntheticIdentityId>;
}

/**
 * Record the run against every member.
 *
 * `persistObservations: false` writes nothing at all and is what a
 * caller uses for a dry run. The default is `true`, because a run that
 * observed a cohort and recorded nothing about it would make the next
 * release-transition join impossible.
 */
export async function persistRun(input: PersistRunInput): Promise<PersistRunResult> {
  if (input.persistObservations === false) {
    return Object.freeze({
      states: Object.freeze([]),
      persistedIdentityIds: Object.freeze([]),
      skippedIdentityIds: Object.freeze(input.members.map((m) => m.id)),
      closedTransitions: Object.freeze([]),
    });
  }

  const states: IdentityState[] = [];
  const persisted: SyntheticIdentityId[] = [];
  const skipped: SyntheticIdentityId[] = [];
  const closed: SyntheticIdentityId[] = [];

  const toVersion = input.plan.lineage?.current.version;

  for (const member of input.members) {
    await guard('identity.recordRun', () =>
      input.service.recordRun(member.id, {
        environmentId: input.environmentId,
        version: input.version,
        observedAt: input.observedAt,
        runId: input.runId,
      }),
    );
    persisted.push(member.id);

    // The retained-state touch is the *only* accumulated state the
    // runtime writes, and it is skipped entirely for an identity whose
    // declared retention is `none`. #60's `touchRetainedState` raises
    // in that case, so the filter is what keeps a legitimate
    // point-in-time run over ephemeral identities from failing.
    if (member.capability.stateRetention !== 'none') {
      await guard('identity.touch', () => input.service.touch(member.id, input.observedAt));
    } else {
      skipped.push(member.id);
    }

    const state = await guard('identity.loadIdentity', () => input.service.loadIdentity(member.id));
    states.push(state);
  }

  if (input.closeTransition === true && toVersion !== undefined) {
    for (const member of input.members) {
      await guard('identity.closeTransition', () =>
        input.service.closeTransition(member.id, { toVersion }),
      );
      closed.push(member.id);
    }
  }

  return Object.freeze({
    states: Object.freeze(states),
    persistedIdentityIds: Object.freeze(persisted),
    skippedIdentityIds: Object.freeze(skipped),
    closedTransitions: Object.freeze(closed),
  });
}

/**
 * A durable-store failure, reported as a contract violation.
 *
 * #60 raises rather than degrading, and it is right to: a store that
 * could not read back a record must not have a run report success over
 * it. The runtime does not swallow the error, and it does not convert it
 * into a `SetupFailure` either — a `SetupFailure` says the *product*
 * could not be evaluated, and a corrupt identity record is neither that
 * nor a product finding.
 */
async function guard<T>(field: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (error) {
    if (isCohortStateError(error)) {
      throw new RuntimeIntegrationError(
        `durable cohort state rejected ${field}: ${error.message}`,
        'cohortState',
        field,
        { code: error.code },
      );
    }
    throw error;
  }
}
