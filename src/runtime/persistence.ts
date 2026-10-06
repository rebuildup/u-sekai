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
 *
 * ## The one write here that is deliberately unguarded
 *
 * `CohortStateService.resolveCohort` is a **mutator**: it rewrites the
 * cohort record and discards the membership a previous writer resolved.
 * #103 gave it a `SaveOptions` guard, and this call does not supply one,
 * because **the runtime has no way to measure one** —
 * `CohortStateService.currentRevision` reads an *identity* record, and
 * there is no cohort-side equivalent. Adding one is a change to
 * `src/cohort/**`, which is #60's and #103's surface, not this
 * ticket's.
 *
 * So the choice this ticket makes is stated rather than implied:
 *
 * - **Everywhere the runtime *can* measure a revision, it does, and
 *   there is no way to opt out.** That is the fail-closed direction, and
 *   it is the one taken in {@link openReleaseWindows} and
 *   {@link persistRun}.
 * - **Here, where it cannot, no protection applies** — and the code says
 *   so at the call site, rather than leaving a reader to infer a
 *   guarantee that is not there.
 *
 * The consequence is a real one and is pinned by a test rather than
 * waved at: a concurrent membership resolution is lost silently. What
 * that does *not* do is fool the revision counter (both writes land at
 * consecutive revisions, because `put` re-reads after the competitor
 * committed), so nothing downstream can tell a discarded resolution
 * from an ordinary second write. Closing it needs a cohort-side
 * revision accessor and, beyond that, #60's compare-and-swap contract.
 * Reported as a known gap; not absorbed here.
 */
export async function resolveCohort(input: ResolveCohortInput): Promise<ResolvedCohort> {
  const state = await guard('cohort.resolve', undefined, () =>
    // No `SaveOptions` on purpose — see the note above. `identityId` is
    // `undefined` here for the same reason: this is a *cohort* record,
    // so naming an identity would misattribute the failure.
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
    const loaded = await guard('identity.loadIdentity', id, () => input.service.loadIdentity(id));
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
 *
 * ## The open is guarded, and the revision is measured per member
 *
 * `openTransition` rewrites the whole identity record, so it is not the
 * additive write it looks like: a writer whose snapshot predates a
 * concurrent run erases that run's observation while only trying to open
 * a window. #103 gave the method a `SaveOptions` guard; this is the
 * caller that supplies one, and without it the guard is a parameter
 * nobody passes — enforced, advertised, and inert.
 *
 * The revision is measured **inside** the loop, immediately before the
 * write it guards. A revision hoisted out of the loop would be stale for
 * every member but the first, and a cohort of three `release` identities
 * — the ordinary case, one per environment — would refuse two of its own
 * members. A revision carried over from an unrelated earlier write would
 * be wrong in the same way for a different reason.
 */
export async function openReleaseWindows(
  input: OpenTransitionInput,
): Promise<ReadonlyArray<SyntheticIdentityId>> {
  const previous = input.plan.lineage?.previous;
  if (previous === undefined) return Object.freeze([]);
  assertTransitionEligible(input.plan, input.members);

  const opened: SyntheticIdentityId[] = [];
  for (const member of input.members) {
    // Absent means `0` — "the record must not exist yet" — which is what
    // closes the create-race on this path: if another writer creates the
    // record in the window, its revision is at least 1 and this write is
    // refused instead of overwriting it. In practice `openTransition`'s
    // own load raises `identity_not_found` for an absent record first;
    // the `0` is what makes the *late* create a conflict rather than a
    // silent overwrite of the newcomer.
    const beforeOpen = await guard('identity.currentRevision', member.id, () =>
      input.service.currentRevision(member.id),
    );
    await guard('identity.openTransition', member.id, () =>
      input.service.openTransition(
        member.id,
        {
          fromVersion: previous.version,
          openedAt: input.openedAt,
        },
        { expectedRevision: beforeOpen ?? 0 },
      ),
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
 *
 * ## Every write here is guarded, and there is no way to opt out
 *
 * Each write reads the record's current revision and passes it as
 * #60's `expectedRevision`, so a writer whose view of the record is no
 * longer current is refused instead of overwriting. This is not an
 * optional extra: a guard that a caller may leave off is a guard whose
 * absence is indistinguishable from its presence, and #92 exists
 * because a perfectly good guard was left off here for a whole release.
 * There is deliberately no `expectedRevision` field on
 * {@link PersistRunInput}, because a field that can be omitted is a
 * field that will be.
 *
 * **This is the fail-closed direction, chosen deliberately.** The
 * alternative — leaving `expectedRevision` optional here because #60's
 * layer makes it optional — is the dangerous steady state this whole
 * investigation is about: a guard that is enforced, advertised as
 * protection, and supplied by nobody. It reads as safe and is not. So
 * within the runtime's own write surface there is no parameter, no
 * option, and no branch by which a durable write is made unguarded; a
 * caller cannot opt out because there is nothing to opt out *of*. The
 * one path where the runtime structurally cannot comply —
 * {@link resolveCohort}, whose guard would need a cohort-side revision
 * the cohort layer does not expose — says in a comment that no
 * protection applies there, and is pinned by a test as the only such
 * call. Those two statements are different on purpose and are not to be
 * collapsed into each other.
 *
 * The alternative shape — an explicit `'guarded' | 'unconditional'` flag —
 * was considered and rejected. It restores the ability to persist
 * unguarded, which is the ability that caused this defect, and there is
 * no production caller that needs it: `execute.ts` is the only one, and
 * it persists runs of identities that another run may be evaluating at
 * the same moment. A caller that genuinely must write unguarded has
 * #60's `recordRun` and its `SaveOptions` directly, and making that a
 * deliberate step outside the runtime is the point.
 *
 * ## What a caller sees when a conflict happens
 *
 * A `RuntimeIntegrationError` with code `revisionConflict`, carrying the
 * identity, the operation, and the expected and actual revisions. The
 * write is not applied and not retried. Issue #92 leaves retry-vs-fail
 * to #60/#66, so this decides neither: it makes the conflict loud,
 * typed and diagnosable, and leaves the policy to whoever owns it.
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
    // Read the revision, then write under it. #60 re-reads inside its
    // own read-modify-write and compares, so the window this closes is
    // exactly the one between this read and that write — which is where
    // the second run of an identity used to slip through and erase the
    // first.
    //
    // An absent record reads as revision 0, and that is a truthful
    // encoding rather than a convenience: #60 rejects any stored
    // revision below 1, so no real record can collide with it. It also
    // closes the create-race that omitting the guard would leave open —
    // if another writer creates the record in the window, its revision
    // is at least 1 and the write is refused. Passing `undefined` here
    // instead would skip the check entirely and clobber it, which is the
    // absence-as-permission shape #92 exists to remove.
    const observed = await guard('identity.currentRevision', member.id, () =>
      input.service.currentRevision(member.id),
    );
    await guard('identity.recordRun', member.id, () =>
      input.service.recordRun(
        member.id,
        {
          environmentId: input.environmentId,
          version: input.version,
          observedAt: input.observedAt,
          runId: input.runId,
        },
        { expectedRevision: observed ?? 0 },
      ),
    );
    persisted.push(member.id);

    // The retained-state touch is the *only* accumulated state the
    // runtime writes, and it is skipped entirely for an identity whose
    // declared retention is `none`. #60's `touchRetainedState` raises
    // in that case, so the filter is what keeps a legitimate
    // point-in-time run over ephemeral identities from failing.
    //
    // The touch is a second write against the same record, so it needs
    // its own revision: `recordRun` above advanced it.
    if (member.capability.stateRetention !== 'none') {
      const afterRecordRun = await guard('identity.currentRevision', member.id, () =>
        input.service.currentRevision(member.id),
      );
      await guard('identity.touch', member.id, () =>
        input.service.touch(member.id, input.observedAt, { expectedRevision: afterRecordRun ?? 0 }),
      );
    } else {
      skipped.push(member.id);
    }

    const state = await guard('identity.loadIdentity', member.id, () =>
      input.service.loadIdentity(member.id),
    );
    states.push(state);
  }

  if (input.closeTransition === true && toVersion !== undefined) {
    for (const member of input.members) {
      // Measured here, in this loop, and not carried down from the write
      // loop above: this is a *second pass* over every member, after
      // each member's `recordRun` and `touch` have already advanced the
      // record. A revision from earlier in `persistRun` is stale for
      // every member, and would refuse an ordinary multi-member release
      // transition rather than a race.
      //
      // The close is the most destructive write the runtime performs —
      // `closeReleaseWindow` *drops* `retainedState` — so a stale write
      // here does not lose a field, it deletes the state that made the
      // second run of the transition a returning-user observation, and
      // with it the evidence #61's release-transition comparison joins
      // on. That is why the guard belongs here and not only in the
      // cohort layer: #103 enforcing it and no caller supplying it left
      // the one write that destroys data unguarded.
      const beforeClose = await guard('identity.currentRevision', member.id, () =>
        input.service.currentRevision(member.id),
      );
      await guard('identity.closeTransition', member.id, () =>
        input.service.closeTransition(member.id, { toVersion }, { expectedRevision: beforeClose ?? 0 }),
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
 *
 * A revision conflict is separated out because it is not a contract
 * violation. Nothing was called wrongly; the record simply moved. The
 * message says so, and names the identity, so an operator reading a log
 * can tell "this run lost a race" from "this run was written wrongly".
 * The runtime states the fact and stops. Whether to retry is #92's
 * open question and belongs to #60/#66, so no retry is attempted and
 * none is implied.
 */
async function guard<T>(
  field: string,
  identityId: SyntheticIdentityId | undefined,
  op: () => Promise<T>,
): Promise<T> {
  try {
    return await op();
  } catch (error) {
    if (isCohortStateError(error)) {
      if (error.code === 'revision_conflict') {
        const expected = error.detail['expected'];
        const actual = error.detail['actual'];
        throw new RuntimeIntegrationError(
          `durable cohort state refused ${field} for ${identityId}: the record advanced from ` +
            `revision ${String(expected)} to ${String(actual)} after this run read it, so the write ` +
            'was not applied. Another run is persisting the same identity concurrently; whether to ' +
            'retry or fail is a caller decision.',
          'revisionConflict',
          field,
          { code: error.code, identityId, expected, actual },
        );
      }
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
