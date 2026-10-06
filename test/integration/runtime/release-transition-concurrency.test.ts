/**
 * The release-transition writes inside the runtime must go through the
 * same optimistic-concurrency guard as every other durable write
 * (issue #106).
 *
 * ## The defect this file was written before the fix for
 *
 * Two predecessors fixed opposite halves of one defect:
 *
 * - #92 (PR #102) made `persistRun` pass a guard to `recordRun`. What
 *   it supplied was the identity **id**, not a **revision**, so nothing
 *   could be compared and nothing could be detected.
 * - #103 (PR #105) made the cohort layer *enforce* the guard:
 *   `openTransition` / `closeTransition` / `retireIdentity` /
 *   `updateCohortDefinition` / `resolveCohort` now take `SaveOptions`
 *   and route it to `put`.
 *
 * Between them, the layer enforced a guard that **no caller ever
 * satisfied**. `persistence.ts` called `openTransition` and
 * `closeTransition` with no `SaveOptions` at all, so a concurrent run
 * of a `release`-lifecycle identity stayed completely undetected — the
 * same silent data loss #92 existed to remove, one function call away.
 *
 * The two halves are only effective together, which is why this file
 * exists on its own branch: against #92 alone the transition writes are
 * unguarded, and against #103 alone the guard is a parameter nobody
 * passes.
 *
 * ## Why `release` is the lifecycle that matters here
 *
 * #92's `recordRun` guard is already correct, so the `persistent` path
 * in `persist-run-concurrency.test.ts` is protected. The release path
 * was not, and the release path is the destructive one: `closeTransition`
 * *drops* `retainedState`, so the write that clobbers a concurrent
 * writer does not merely lose a field — it deletes the state that made
 * the second run of the transition a returning-user observation at all,
 * and with it the evidence #61's release-transition comparison joins on.
 *
 * ## The race is staged, and staged so that it is staged *either way*
 *
 * `CohortStateService` reads the record more than once per mutating
 * call — the public method's own load, then `put`'s re-read — and both
 * are awaited, so a race is reachable. Reaching it by timing is flaky,
 * and a flaky concurrency test trains reviewers to re-run it instead of
 * read it. `InterleavingStore` therefore runs a competing commit at the
 * exact point it matters.
 *
 * The exact point is the subtle part, and getting it wrong produces a
 * reproduction that is red for the wrong reason — which is worse than
 * no reproduction, because a test that cannot tell "the guard is
 * absent" from "the race never happened" will happily pass for the
 * second reason once someone fixes the first.
 *
 * The fix *adds* a read: measuring the revision to guard against. So an
 * arming ordinal derived from the fixed code names a read that does not
 * exist in the unfixed code, the hook never fires, the competitor never
 * runs, and the "reproduction" then fails at the arming assertion or on
 * a success that only looks like a missing guard. Every stage below
 * therefore arms at **the first read ordinal that exists on both sides
 * of the fix**:
 *
 * | stage | armed before read | unfixed: what that read is | fixed: what that read is |
 * | --- | --- | --- | --- |
 * | `closeTransition` | 9 | `put`'s re-read | `closeTransition`'s own load |
 * | `openTransition` | 2 | `put`'s re-read | `openTransition`'s own load |
 *
 * On both sides that lands the competitor strictly after the writer has
 * finished reading and strictly before its bytes are computed, so the
 * unfixed run really does lose data and the fixed run really does
 * conflict. The ordninal is asserted *after* the data-loss claim for
 * the same reason: a red run must be red because the loser's write was
 * applied, and the ordinal is a property of the staging, not of the
 * defect.
 *
 * ## What the assertions are about
 *
 * Each test asserts the state that **survives**, and asserts it *first*.
 * "An error was raised" would be satisfied by a runtime that refused
 * every write, so the control cases at the end run complete
 * single-writer and sequential release runs and assert the transitioned
 * state is correct when read back off disk. A suite where nothing can
 * be written cannot pass them.
 *
 * ## No retry policy is asserted
 *
 * #92 deliberately left retry-vs-fail to #60/#66, and #106 inherits
 * that. These tests pin only what is decided: the conflict is
 * **detected**, it is **typed** distinctly from an unrelated store
 * failure, it **carries the revisions** that make it diagnosable, and it
 * **does not overwrite**. A test asserting "it retries three times"
 * would be inventing a product decision.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  persistRun,
  openReleaseWindows,
  resolveCohort,
  isRuntimeIntegrationError,
} from '../../../src/runtime/index.js';
import {
  CohortStateService,
  FileRecordStore,
  identityStateKey,
  parseDurableRecord,
  type DurableRecordKind,
  type RecordStore,
} from '../../../src/cohort/index.js';
import type { SyntheticIdentity, SyntheticIdentityId } from '../../../src/product/index.js';
import type { EvaluationPlan } from '../../../src/program/index.js';
import {
  ENV_A,
  ENV_B,
  asEnvironmentId,
  makeExplicitCohort,
  makeIdentity,
  makePlan,
  fixedClock,
} from './support/fixtures.js';
import { InterleavingStore, TracingRecordStore } from '../../fixtures/cohort/interleaving-store.js';

const RETURNING = { id: 'idn-returning-race', lifecycle: 'release' as const };

const VERSION_BEFORE = '2026.10.1';
const VERSION_AFTER = '2026.10.2';
const BEFORE_AT = '2026-10-01T00:00:00.000Z';
const AFTER_AT = '2026-10-08T00:00:00.000Z';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'u-sekai-release-concurrency-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Plans and writers                                                            */
/* -------------------------------------------------------------------------- */

/** A `releaseTransition` plan: version A -> version B, window opened and closed. */
function transitionPlan(runId: string, version: string): EvaluationPlan {
  return makePlan({
    environmentId: ENV_B,
    version,
    observedAt: AFTER_AT,
    previousObservation: { environmentId: ENV_A, version: VERSION_BEFORE, observedAt: BEFORE_AT },
    delivery: `${version}-${runId}`,
  });
}

function persistArgs(spec: {
  readonly service: CohortStateService;
  readonly members: ReadonlyArray<SyntheticIdentity>;
  readonly runId: string;
  readonly version: string;
  readonly closeTransition: boolean;
}) {
  return {
    service: spec.service,
    plan: transitionPlan(spec.runId, spec.version),
    members: spec.members,
    environmentId: asEnvironmentId(ENV_B),
    version: spec.version,
    runId: spec.runId,
    observedAt: AFTER_AT,
    closeTransition: spec.closeTransition,
  };
}

function openArgs(service: CohortStateService, members: ReadonlyArray<SyntheticIdentity>, openedAt: string) {
  return {
    service,
    plan: transitionPlan('open', VERSION_AFTER),
    members,
    openedAt,
  };
}

/** A service over the shared bytes — one per writer, as two processes would be. */
function writer(store: RecordStore, now = fixedClock()): CohortStateService {
  return new CohortStateService({ store, now });
}

/**
 * The stored revision for one identity, read from the envelope.
 *
 * Deliberately read through the store rather than through the service:
 * the revision is an envelope fact (`IdentityState` carries none), so a
 * test that read it through the accessor the fix relies on could not
 * tell whether the accessor or the guard was under test.
 */
async function storedRevision(store: RecordStore, id: SyntheticIdentityId): Promise<number | undefined> {
  const text = await store.read('identity', identityStateKey(id));
  return text === undefined ? undefined : parseDurableRecord(text, 'identity').revision;
}

/* -------------------------------------------------------------------------- */
/* Staging                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A `release` identity mid-transition, at a known revision, in its own
 * directory.
 *
 * Mirrors what `openReleaseWindows` leaves behind: the window is open,
 * one pre-transition observation is on record, and the retained state
 * that makes the second run a returning-user observation exists. The
 * revision it lands on is pinned, because every assertion below is a
 * statement about which revision a write was or was not entitled to
 * claim.
 *
 * The directory is per-stage because #60's rule is that a `release`
 * identity spans exactly one transition: re-staging the same identity
 * id in one directory would raise `invalid_transition` at its
 * `openTransition`, which is correct behaviour and a useless fixture.
 */
async function stageOpenWindow(
  stage = 'primary',
  options: { readonly windowOpen?: boolean } = {},
): Promise<{
  readonly backing: FileRecordStore;
  readonly identity: SyntheticIdentity;
  readonly revision: number;
}> {
  const backing = new FileRecordStore({ rootDir: path.join(dir, stage) });
  const identity = makeIdentity(RETURNING);
  const setup = writer(backing, fixedClock(BEFORE_AT));
  await setup.declareIdentity(identity);
  if (options.windowOpen !== false) {
    await setup.openTransition(identity.id, { fromVersion: VERSION_BEFORE, openedAt: BEFORE_AT });
  }
  await setup.touch(identity.id, BEFORE_AT);
  await setup.recordRun(identity.id, {
    environmentId: asEnvironmentId(ENV_A),
    version: VERSION_BEFORE,
    observedAt: BEFORE_AT,
    runId: 'run-before',
  });
  // declareIdentity (1) + openTransition (0 or 1) + touch (1) + recordRun (1).
  const expectedRevision = options.windowOpen === false ? 3 : 4;
  const revision = await storedRevision(backing, identity.id);
  if (revision !== expectedRevision) {
    throw new Error(`fixture is at revision ${revision}, expected ${expectedRevision}`);
  }
  return { backing, identity, revision };
}

/**
 * Counts the reads a writer issued.
 *
 * The counter is read from *inside* the interleaving hook, which runs
 * after the gate has counted the read it is about to service and before
 * the inner store has been consulted. So the value seen there is the
 * one-based ordinal of the read the commit landed in front of.
 */
class CountingReads implements RecordStore {
  private reads = 0;

  constructor(private readonly inner: RecordStore) {}

  get readCount(): number {
    return this.reads;
  }

  read(kind: DurableRecordKind, key: string): Promise<string | undefined> {
    this.reads += 1;
    return this.inner.read(kind, key);
  }

  write(kind: DurableRecordKind, key: string, text: string): Promise<void> {
    return this.inner.write(kind, key, text);
  }

  delete(kind: DurableRecordKind, key: string): Promise<boolean> {
    return this.inner.delete(kind, key);
  }

  list(kind: DurableRecordKind): Promise<ReadonlyArray<string>> {
    return this.inner.list(kind);
  }
}

/* -------------------------------------------------------------------------- */
/* The reproduction                                                             */
/* -------------------------------------------------------------------------- */

describe('a concurrent release transition is detected, not silently applied', () => {
  /**
   * The red-before reproduction, on the runtime side.
   *
   * Read derivation for `persistRun` of one `release` member with
   * durable retention. The first seven reads are the same either way;
   * the fix adds read 8.
   *
   * | # | read | |
   * | --- | --- | --- |
   * | 1 | `currentRevision` for `recordRun` | either way |
   * | 2, 3 | `recordRun`: its own load, then `put`'s re-read | either way |
   * | 4 | `currentRevision` for `touch` | either way |
   * | 5, 6 | `touch`: its own load, then `put`'s re-read | either way |
   * | 7 | the `loadIdentity` that collects the result | either way |
   * | 8 | `currentRevision` for `closeTransition` | **fix only** |
   * | 9 | `closeTransition`: its own load, then `put`'s re-read | either way |
   *
   * Read 9 is the first read after the fix's extra read that exists in
   * both versions, so the competitor is armed in front of it. That is
   * the last point at which the loser's payload is still computed from
   * a snapshot taken before the competitor committed, and it is the
   * first point that is inside the guard's window once the revision is
   * supplied.
   */
  it('refuses the losing closeTransition and keeps the concurrent writer’s observation', async () => {
    const { backing, identity, revision } = await stageOpenWindow();

    const gate = new InterleavingStore(backing);
    const counter = new CountingReads(gate);
    const aTrace = new TracingRecordStore(counter, 'A');
    const bTrace = new TracingRecordStore(backing, 'B');
    const a = writer(aTrace, fixedClock(AFTER_AT));
    const b = writer(bTrace, fixedClock(AFTER_AT));

    let armedAt = 0;
    gate.armBeforeRead(async () => {
      armedAt = counter.readCount;
      // A legitimate concurrent writer: the same identity, a later run
      // of the same transition, recording its own observation.
      await b.recordRun(identity.id, {
        environmentId: asEnvironmentId(ENV_B),
        version: VERSION_AFTER,
        observedAt: AFTER_AT,
        runId: 'run-concurrent',
      });
    }, 8);

    const outcome = await persistRun(
      persistArgs({ service: a, members: [identity], runId: 'run-a', version: VERSION_AFTER, closeTransition: true }),
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    // --- The substantive claim comes first, and it is about the data.
    //
    // `run-a`'s own observation and touch landed — those writes are
    // *not* the ones that raced — and the concurrent writer's
    // observation must still be there. The window is still open and the
    // retained state the transition carries must not have been dropped
    // by a write that was never entitled to drop it.
    //
    // Against the unguarded runtime this is where the test goes red,
    // and it is red because the loser's `closeTransition` was applied
    // over a snapshot taken before `run-concurrent` existed:
    // `run-concurrent` is simply not in the list, and `retainedState`
    // has been dropped. Nothing about that failure depends on a read
    // count, which is the point — see the header note on staging.
    const after = await writer(backing, fixedClock(AFTER_AT)).loadIdentity(identity.id);
    expect(after.observations.map((o) => o.runId), "the concurrent writer's observation must survive").toEqual([
      'run-before',
      'run-a',
      'run-concurrent',
    ]);
    expect(after.releaseWindow?.toVersion).toBeUndefined();
    expect(after.retainedState, 'the transition’s retained state must not be dropped by a lost-update write').toBeDefined();

    // --- The write was refused, and refused *as a conflict*: typed
    // distinctly from an unrelated store failure and carrying the two
    // revisions, so an operator can tell "someone else wrote" from "the
    // record was rebuilt" — the difference between a retry and a call.
    if (outcome.ok) throw new Error('unreachable: the assertion above already failed');
    if (!isRuntimeIntegrationError(outcome.error)) throw new Error('unreachable');
    expect(outcome.error.code).toBe('revisionConflict');
    expect(outcome.error.field).toBe('identity.closeTransition');
    expect(outcome.error.detail).toMatchObject({ identityId: identity.id, code: 'revision_conflict' });
    const expected = outcome.error.detail.expected;
    const actual = outcome.error.detail.actual;
    expect(expected).toBeTypeOf('number');
    expect(actual).toBeTypeOf('number');
    expect(actual as number).toBeGreaterThan(expected as number);

    // --- The mechanism, stated as surviving state rather than as an
    // absence of an error. A's first two writes are its own
    // `recordRun` and `touch`, which did not race and are expected to
    // land. The third would be the `closeTransition`; the write the
    // guard refused is the one that is *absent* from the trace.
    // Had it not been stopped, A and B would both have written
    // revision 7 and the counter would have been fooled along with the
    // payload.
    expect(aTrace.trace.commits.map((c) => c.revision)).toEqual([revision + 1, revision + 2]);
    expect(bTrace.trace.commits.map((c) => c.revision)).toEqual([revision + 3]);

    // --- Last, because it is a statement about the staging rather than
    // about the defect: the competitor really did commit, in front of
    // the read the derivation above names. Asserted after the data-loss
    // claim so a failure points at the loss, not at the fixture.
    expect(armedAt, 'the commit must land in front of read 9').toBe(9);
  });

  /**
   * The same defect on the *open* side, which is the more surprising
   * one: `openTransition` is a write that looks additive but is a
   * read-modify-write over the whole record, so a concurrent writer's
   * observation is erased by a writer that was only trying to open a
   * window.
   *
   * Read derivation: the fix measures the revision first (read 1), and
   * `openTransition` then loads the record and `put` re-reads it. Read
   * 2 is the first read that exists in both versions, so the commit is
   * armed in front of it — `put`'s re-read before the fix, the
   * mutator's own load after it.
   *
   * Staged with **no** window open, because #60 permits a `release`
   * identity exactly one transition: staging one that is already open
   * would fail as `invalid_transition` before the guard was ever
   * reached, which is a different scenario and proves nothing.
   */
  it('refuses the losing openTransition instead of erasing a concurrent run’s observation', async () => {
    const { backing, identity, revision } = await stageOpenWindow('open-guard', { windowOpen: false });

    const gate = new InterleavingStore(backing);
    const counter = new CountingReads(gate);
    const aTrace = new TracingRecordStore(counter, 'A');
    const bTrace = new TracingRecordStore(backing, 'B');
    const a = writer(aTrace, fixedClock(AFTER_AT));
    const b = writer(bTrace, fixedClock(AFTER_AT));

    let armedAt = 0;
    gate.armBeforeRead(async () => {
      armedAt = counter.readCount;
      await b.recordRun(identity.id, {
        environmentId: asEnvironmentId(ENV_B),
        version: VERSION_AFTER,
        observedAt: AFTER_AT,
        runId: 'run-concurrent',
      });
    }, 1);

    const outcome = await openReleaseWindows(openArgs(a, [identity], AFTER_AT)).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    // --- The substantive claim, first, and again about the data. An
    // open window looks additive, so the loss here is not obvious from
    // the call: the concurrent writer's observation is dropped because
    // the whole record is rewritten from a pre-race snapshot. Against
    // the unguarded runtime `run-concurrent` is absent and a window was
    // opened by a writer that was no longer entitled to open one.
    const after = await writer(backing, fixedClock(AFTER_AT)).loadIdentity(identity.id);
    expect(after.observations.map((o) => o.runId), "the concurrent writer's observation must survive").toEqual([
      'run-before',
      'run-concurrent',
    ]);
    expect(after.releaseWindow, 'no window may be opened by a writer that lost the race').toBeUndefined();

    if (outcome.ok) throw new Error('unreachable: the assertion above already failed');
    if (!isRuntimeIntegrationError(outcome.error)) throw new Error('unreachable');
    expect(outcome.error.code).toBe('revisionConflict');
    expect(outcome.error.field).toBe('identity.openTransition');
    expect(outcome.error.detail).toMatchObject({ identityId: identity.id, code: 'revision_conflict' });

    // The mechanism: the loser's write never reached the store, so it
    // never claimed a revision. Had it not been stopped, A and B would
    // both have written revision 4 and the counter would have been
    // fooled along with the payload.
    expect(aTrace.trace.labels).toEqual([]);
    expect(bTrace.trace.commits.map((c) => c.revision)).toEqual([revision + 1]);

    expect(armedAt, 'the commit must land in front of read 2').toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Controls: a guard that cannot tell a legitimate path from a race is not one  */
/* -------------------------------------------------------------------------- */

describe('control: a single-writer release transition is unaffected', () => {
  it('completes open -> run -> close, and the transition really happened', async () => {
    const backing = new FileRecordStore({ rootDir: dir });
    const identity = makeIdentity(RETURNING);
    const service = writer(backing, fixedClock());

    await service.declareIdentity(identity);
    await openReleaseWindows(openArgs(service, [identity], BEFORE_AT));

    const result = await persistRun(
      persistArgs({ service, members: [identity], runId: 'run-solo', version: VERSION_AFTER, closeTransition: true }),
    );

    expect(result.persistedIdentityIds).toEqual([identity.id]);
    expect(result.closedTransitions).toEqual([identity.id]);

    // Read back through a service that shares nothing but the bytes.
    const reopened = writer(new FileRecordStore({ rootDir: dir }), fixedClock(AFTER_AT));
    const stored = await reopened.loadIdentity(identity.id);
    expect(stored.releaseWindow).toMatchObject({
      fromVersion: VERSION_BEFORE,
      toVersion: VERSION_AFTER,
    });
    expect(stored.releaseWindow?.closedAt).toBeDefined();
    // #60's rule: the transition-scoped retained state is gone once the
    // transition closes. The identity returned; it does not keep
    // accumulating across it.
    expect(stored.retainedState).toBeUndefined();
    expect(stored.observations.map((o) => o.runId)).toEqual(['run-solo']);
  });
});

describe('control: sequential release runs are not mistaken for a race', () => {
  it('accumulates both observations from two runs of the same returning user', async () => {
    // Not "two full transitions": #60's rule is that a `release`
    // identity spans exactly one transition, so a second
    // `openReleaseWindow` is an `invalid_transition` by design. The
    // case that matters for a guard is the ordinary one — the same
    // returning user observed twice, one run after the other. A guard
    // that cannot tell it apart from a race has no business being
    // called a guard.
    const { backing, identity } = await stageOpenWindow();
    const service = writer(new FileRecordStore({ rootDir: path.join(dir, 'primary') }), fixedClock(AFTER_AT));

    await persistRun(
      persistArgs({ service, members: [identity], runId: 'run-s1', version: VERSION_AFTER, closeTransition: true }),
    );
    // The second run observes the same record, serially.
    await persistRun(
      persistArgs({ service, members: [identity], runId: 'run-s2', version: VERSION_AFTER, closeTransition: false }),
    );

    const reopened = writer(new FileRecordStore({ rootDir: path.join(dir, 'primary') }), fixedClock(AFTER_AT));
    const stored = await reopened.loadIdentity(identity.id);
    expect(stored.observations.map((o) => o.runId)).toEqual(['run-before', 'run-s1', 'run-s2']);
    expect(stored.releaseWindow?.toVersion).toBe(VERSION_AFTER);
    // Both sequential runs landed: the fixture's revision 4, then
    // recordRun + touch + closeTransition for run-s1 (3), then
    // recordRun + touch for run-s2 (2). Had a stale revision been
    // carried down from the first run instead of re-measured, this
    // would have been refused.
    expect(await storedRevision(backing, identity.id)).toBe(9);
  });

  it('measures the close separately per member, so a multi-member cohort is not refused', async () => {
    // The close is a *second pass* over every member, after each
    // member's `recordRun` and `touch` have already advanced the
    // record. A revision carried down from the write loop would be
    // stale for every member but the first, and would refuse a
    // perfectly ordinary release transition over a cohort.
    const backing = new FileRecordStore({ rootDir: dir });
    const service = writer(backing, fixedClock());
    const members = ['idn-a', 'idn-b', 'idn-c'].map((id) => makeIdentity({ id, lifecycle: 'release' }));
    for (const member of members) await service.declareIdentity(member);
    await openReleaseWindows(openArgs(service, members, BEFORE_AT));

    const result = await persistRun(
      persistArgs({ service, members, runId: 'run-multi', version: VERSION_AFTER, closeTransition: true }),
    );

    expect(result.closedTransitions).toEqual(members.map((m) => m.id));
    const reopened = writer(new FileRecordStore({ rootDir: dir }), fixedClock(AFTER_AT));
    for (const member of members) {
      const stored = await reopened.loadIdentity(member.id);
      expect(stored.releaseWindow?.toVersion).toBe(VERSION_AFTER);
    }
  });

  it('measures the open separately per member, so a multi-member cohort is not refused', async () => {
    // The same shape on the open side, and the reason the revision is
    // measured inside the loop rather than hoisted out of it.
    const backing = new FileRecordStore({ rootDir: dir });
    const service = writer(backing, fixedClock());
    const members = ['idn-d', 'idn-e'].map((id) => makeIdentity({ id, lifecycle: 'release' }));
    for (const member of members) await service.declareIdentity(member);

    const opened = await openReleaseWindows(openArgs(service, members, BEFORE_AT));

    expect(opened).toEqual(members.map((m) => m.id));
    const reopened = writer(new FileRecordStore({ rootDir: dir }), fixedClock(AFTER_AT));
    for (const member of members) {
      const stored = await reopened.loadIdentity(member.id);
      expect(stored.releaseWindow?.fromVersion).toBe(VERSION_BEFORE);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The limits, documented and pinned rather than papered over                  */
/* -------------------------------------------------------------------------- */

describe('the limit: no store-level compare-and-swap means one window remains', () => {
  /**
   * The guard closes the window between the runtime's revision read and
   * `put`'s own re-read. It does **not** close the window between
   * `put`'s re-read and `store.write`, because `RecordStore` exposes
   * only `read` / `write` / `delete` / `list` — there is no
   * compare-and-swap primitive, and a capability only one
   * implementation has is not a capability of the store.
   *
   * Closing it needs a CAS on `RecordStore`, which is #60's contract
   * change and not this ticket's. So the limit is stated here, pinned
   * by this test, and left visible: a reader must not come away
   * believing the guard is atomic. A half-guarantee stated as a whole
   * one is the defect class this investigation exists to reject.
   *
   * #103's finding is the reason this cannot be worked around by
   * reading revisions: the counter itself is fooled, because both
   * writers compute their revision from the same earlier read and store
   * the same number. That is why check-then-write is not made sound by
   * reading revisions again afterwards.
   */
  it('does not detect a writer that commits after put’s own re-read', async () => {
    const { backing, identity } = await stageOpenWindow('close-path');

    const gate = new InterleavingStore(backing);
    const aTrace = new TracingRecordStore(gate, 'A');
    const bTrace = new TracingRecordStore(backing, 'B');
    const a = writer(aTrace, fixedClock(AFTER_AT));
    const b = writer(bTrace, fixedClock(AFTER_AT));

    // `armBeforeWrite` fires on the runtime's *first* write, after
    // `put` has re-read and computed the revision it is about to claim
    // and before its bytes land. That is precisely the residual
    // window — and note it is the one #92's already-correct
    // `recordRun` guard cannot close either. The limit is a property
    // of the store contract, not of #106's change.
    gate.armBeforeWrite(async () => {
      await b.recordRun(identity.id, {
        environmentId: asEnvironmentId(ENV_B),
        version: VERSION_AFTER,
        observedAt: AFTER_AT,
        runId: 'run-after-the-check',
      });
    });

    // It succeeds. That is the documented limit, asserted rather than
    // hidden: both writers claim revision 5, so the counter is fooled
    // along with the payload and no amount of reading revisions
    // afterwards can detect the loss.
    await persistRun(
      persistArgs({ service: a, members: [identity], runId: 'run-a', version: VERSION_AFTER, closeTransition: true }),
    );

    expect(bTrace.trace.commits.map((c) => c.revision)).toEqual([5]);
    expect(aTrace.trace.commits.map((c) => c.revision)).toEqual([5, 6, 7]);
    // B's observation is gone, erased by A's pre-B snapshot.
    const lost = await writer(backing, fixedClock(AFTER_AT)).loadIdentity(identity.id);
    expect(lost.observations.map((o) => o.runId)).toEqual(['run-before', 'run-a']);

    // The same window is reachable on a transition write, and there
    // the whole payload is the one that survives. Staged without an
    // open window, because #60 permits a `release` identity exactly
    // one transition and this one has not had it yet.
    const second = await stageOpenWindow('open-path', { windowOpen: false });
    const cGate = new InterleavingStore(second.backing);
    const cTrace = new TracingRecordStore(cGate, 'C');
    const dTrace = new TracingRecordStore(second.backing, 'D');
    const c = writer(cTrace, fixedClock(AFTER_AT));
    const d = writer(dTrace, fixedClock(AFTER_AT));
    cGate.armBeforeWrite(async () => {
      await d.recordRun(second.identity.id, {
        environmentId: asEnvironmentId(ENV_B),
        version: VERSION_AFTER,
        observedAt: AFTER_AT,
        runId: 'run-after-the-check',
      });
    });

    await openReleaseWindows(openArgs(c, [second.identity], AFTER_AT));

    expect(cTrace.trace.commits.map((x) => x.revision)).toEqual([4]);
    expect(dTrace.trace.commits.map((x) => x.revision)).toEqual([4]);
    const afterOpen = await writer(second.backing, fixedClock(AFTER_AT)).loadIdentity(second.identity.id);
    expect(afterOpen.observations.map((o) => o.runId)).toEqual(['run-before']);
    expect(afterOpen.releaseWindow?.openedAt).toBe(AFTER_AT);
  });
});

describe('the limit: the runtime has no way to guard resolveCohort', () => {
  /**
   * This test asserts that data is LOST. It is here on purpose, and it
   * is the honest boundary of what #106 can deliver.
   *
   * `resolveCohort` is a mutator like any other — it rewrites the
   * cohort record and discards the previously resolved membership — and
   * #103 gave it a `SaveOptions` guard. The runtime calls it from
   * {@link resolveCohort} and **cannot** supply a revision, because
   * `CohortStateService.currentRevision` reads an *identity* record and
   * there is no cohort-side equivalent. Adding one is a change to
   * `src/cohort/**`, which is #60's and #103's surface, not this
   * ticket's.
   *
   * So the runtime's one remaining unguarded write is named here, in
   * the code, and in this test, rather than left to be discovered. The
   * asymmetry is deliberate: where the runtime *can* measure a revision
   * it does, and there is no way to opt out; where it cannot, the code
   * says in a comment that no protection applies on that path. What it
   * must not do is present the first as though it were the second.
   */
  it('loses a concurrent membership resolution, and says so', async () => {
    const backing = new FileRecordStore({ rootDir: dir });
    const identity = makeIdentity({ id: 'idn-cohort-guard', lifecycle: 'persistent' });
    const cohort = makeExplicitCohort([identity.id]);
    const setup = writer(backing, fixedClock(BEFORE_AT));
    await setup.declareIdentity(identity);
    await setup.declareCohort(cohort);

    const gate = new InterleavingStore(backing);
    const counter = new CountingReads(gate);
    const aTrace = new TracingRecordStore(counter, 'A');
    const bTrace = new TracingRecordStore(backing, 'B');
    const a = writer(aTrace, fixedClock(AFTER_AT));
    const b = writer(bTrace, fixedClock(AFTER_AT));

    // The competitor re-resolves membership between the runtime's own
    // load of the cohort record and `put`'s re-read of it — the same
    // window the transition writes are now guarded against.
    let armedAt = 0;
    gate.armBeforeRead(async () => {
      armedAt = counter.readCount;
      await b.resolveCohort(cohort.id, { resolvedAt: BEFORE_AT });
    }, 1);

    const resolved = await resolveCohort({
      service: a,
      cohortId: cohort.id,
      planningCeiling: 10,
      resolvedAt: AFTER_AT,
    });
    expect(resolved.members.map((m) => m.id)).toEqual([identity.id]);

    // The competitor ran, and it ran inside the window: this is a real
    // race, not an unexercised path.
    expect(armedAt).toBe(2);
    expect(bTrace.trace.commits.map((c) => c.revision)).toEqual([2]);

    // And the runtime was not told. Its own resolution was computed
    // from the pre-race snapshot and simply overwrote the competitor's,
    // because there is no revision for it to guard with. Note what is
    // *not* claimed here, because it would be false: unlike the CAS
    // window above, this one does not fool the counter. The revisions
    // advance cleanly (2 then 3) because `put` re-read after the
    // competitor committed. The loss is a plain last-write-wins — the
    // envelope records a perfectly ordinary second write, so nothing
    // downstream can tell that a resolution was discarded.
    expect(aTrace.trace.commits.map((c) => c.revision)).toEqual([3]);
    expect(await storedCohortRevision(backing, cohort.id)).toBe(3);

    // The discarded resolution is what makes it a loss: the stored
    // membership carries the runtime's own `resolvedAt`, and the
    // competitor's is gone. Nothing raised.
    const stored = await writer(backing, fixedClock(AFTER_AT)).loadCohort(cohort.id);
    expect(stored.membership?.resolvedAt).toBe(AFTER_AT);
  });
});

async function storedCohortRevision(store: RecordStore, id: string): Promise<number | undefined> {
  const text = await store.read('cohort', `cohort:${id}`);
  return text === undefined ? undefined : parseDurableRecord(text, 'cohort').revision;
}
