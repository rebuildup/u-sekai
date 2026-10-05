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
 * ## The race is staged, not raced for
 *
 * `CohortStateService` reads the record more than once per mutating
 * call — the public method's own load, then `put`'s re-read — and both
 * are awaited, so a race is reachable. Reaching it by timing is flaky,
 * and a flaky concurrency test trains reviewers to re-run it instead of
 * read it. `InterleavingStore` therefore runs a competing commit at the
 * exact point it matters, so the test asserts on the window a
 * check-then-write guard closes rather than on a timing coincidence.
 *
 * ## The arming ordinals are asserted, not assumed
 *
 * Staging a guard's window by read ordinal has a failure mode that
 * fails *silently in the wrong direction*: arm one read too early and
 * the competing commit lands before the runtime has measured the
 * revision at all, the writer then legitimately succeeds against the
 * newer revision, and the test stops testing the guard without saying
 * so. `CountingReads` records the ordinal the hook actually fired at and
 * every stage asserts it, so a change to the write path's read count
 * fails loudly here instead of passing for the wrong reason.
 *
 * Fixing #106 *moved* those ordinals, because the fix adds the
 * `currentRevision` read that supplies the guard. The derivations are
 * written out at each stage rather than left as bare numbers.
 *
 * ## What the assertions are about
 *
 * Each test asserts the state that **survives**, not merely that
 * something threw. "An error was raised" would be satisfied by a
 * runtime that refused every write, so the control cases at the end run
 * complete single-writer and sequential release runs and assert the
 * transitioned state is correct when read back off disk. A suite where
 * nothing can be written cannot pass them.
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
   * durable retention, against the fix:
   *
   * | # | read |
   * | --- | --- |
   * | 1 | `currentRevision` for `recordRun` |
   * | 2, 3 | `recordRun`: its own load, then `put`'s re-read |
   * | 4 | `currentRevision` for `touch` |
   * | 5, 6 | `touch`: its own load, then `put`'s re-read |
   * | 7 | the `loadIdentity` that collects the result |
   * | 8 | `currentRevision` for `closeTransition` |
   * | 9, 10 | `closeTransition`: its own load, then `put`'s re-read |
   *
   * The guard is the window between read 8 and read 10, so the commit
   * is armed in front of read 10 — after the revision the runtime
   * measured, and before `put` compares it.
   */
  it('refuses the losing closeTransition and keeps the concurrent writer’s observation', async () => {
    const { backing, identity, revision } = await stageOpenWindow();

    const gate = new InterleavingStore(backing);
    const counter = new CountingReads(gate);
    const aTrace = new TracingRecordStore(counter, 'A');
    const bTrace = new TracingRecordStore(backing, 'B');
    const a = writer(aTrace, fixedClock(AFTER_AT));
    const b = writer(bTrace, fixedClock(AFTER_AT));

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
    }, 9);

    let armedAt = 0;
    const outcome = await persistRun(
      persistArgs({ service: a, members: [identity], runId: 'run-a', version: VERSION_AFTER, closeTransition: true }),
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    // The substantive claim comes first, so a red run is red *because
    // the write was not refused* and not because an ordinal moved.
    // On the unguarded code this is where it fails: the loser's
    // `closeTransition` returned success.
    expect(outcome.ok).toBe(false);

    // --- The failure is typed, names the field, and carries both
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

    // --- The state that survives is the point. `run-a`'s own
    // observation and touch landed — those writes are *not* the ones
    // that raced — and the concurrent writer's observation is still
    // there. The window is still open and the retained state the
    // transition carries has not been dropped by a write that was
    // never entitled to drop it.
    const after = await writer(backing, fixedClock(AFTER_AT)).loadIdentity(identity.id);
    expect(after.observations.map((o) => o.runId)).toEqual(['run-before', 'run-a', 'run-concurrent']);
    expect(after.releaseWindow?.toVersion).toBeUndefined();
    expect(after.retainedState).toBeDefined();

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
  });

  /**
   * The same defect on the *open* side, which is the more surprising
   * one: `openTransition` is a write that looks additive but is a
   * read-modify-write over the whole record, so a concurrent writer's
   * observation is erased by a writer that was only trying to open a
   * window.
   *
   * Read derivation, measured rather than assumed: `openReleaseWindows`
   * measures the revision first (read 1), `openTransition` then loads
   * the record (read 2) and `put` re-reads it (read 3). The guard's
   * window is between reads 1 and 3, so the commit is armed in front
   * of read 3.
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

    gate.armBeforeRead(async () => {
      armedAt = counter.readCount;
      await b.recordRun(identity.id, {
        environmentId: asEnvironmentId(ENV_B),
        version: VERSION_AFTER,
        observedAt: AFTER_AT,
        runId: 'run-concurrent',
      });
    }, 2);

    let armedAt = 0;
    const outcome = await openReleaseWindows(openArgs(a, [identity], AFTER_AT)).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    expect(armedAt, 'the commit must land in front of read 3, the guard’s window').toBe(3);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable: the assertion above already failed');
    if (!isRuntimeIntegrationError(outcome.error)) throw new Error('unreachable');
    expect(outcome.error.code).toBe('revisionConflict');
    expect(outcome.error.field).toBe('identity.openTransition');

    // The concurrent writer's observation survived, and no window was
    // opened by a writer that was no longer entitled to open one.
    const after = await writer(backing, fixedClock(AFTER_AT)).loadIdentity(identity.id);
    expect(after.observations.map((o) => o.runId)).toEqual(['run-before', 'run-concurrent']);
    expect(after.releaseWindow).toBeUndefined();

    // The mechanism: the loser's write never reached the store, so it
    // never claimed a revision. Had it not been stopped, A and B would
    // both have written revision 4 and the counter would have been
    // fooled along with the payload.
    expect(aTrace.trace.labels).toEqual([]);
    expect(bTrace.trace.commits.map((c) => c.revision)).toEqual([revision + 1]);
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
});

/* -------------------------------------------------------------------------- */
/* The limit, documented and pinned rather than papered over                  */
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
    // the whole payload is the one that survives. `openReleaseWindows`
    // is a single write, so the gate lands in its only `put`.
    // `openReleaseWindows` is a single write, so the gate lands in its
    // only `put` — and its window is the residual one for a *transition*
    // write, where the whole payload is the one that survives. Staged
    // without an open window, because #60 permits a `release` identity
    // exactly one transition and this one has not had it yet.
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
