/**
 * The release-transition writes must go through the same optimistic
 * concurrency guard as every other durable write (issue #103).
 *
 * ## The failure this file exists to prevent
 *
 * Issue #92 fixed last-write-wins on the `recordRun` path. The two
 * release-transition writes inside a `persistRun` — `openTransition` and
 * `closeTransition` — were left unguarded, so a concurrent run of a
 * `release`-lifecycle identity still erased the other one's write, and
 * the run that lost reported success.
 *
 * `closeTransition` is the damaging one. It drops the retained state the
 * transition carried, so the write that clobbers a concurrent writer does
 * not merely lose a field: it deletes the state that made the second run
 * of the transition a *returning-user* observation at all. The evidence
 * #61's release-transition comparison joins on is the first thing to go.
 *
 * ## Why the race is staged rather than raced for
 *
 * The interleave is arranged with `InterleavingStore`, so the competing
 * commit lands after the losing writer has read the revision it is
 * guarding against and before its bytes land. That is exactly the window
 * a check-then-write guard closes, reached deterministically.
 *
 * ## What is asserted, and why it is the *state* that is asserted
 *
 * Each test asserts what survives in the store after the conflict, not
 * merely that something was thrown. "An error was raised" would be
 * satisfied by a guard that refuses every write unconditionally, so the
 * control case at the end runs a complete single-writer release
 * transition and asserts the transitioned state is correct when read
 * back off disk. A suite where nothing can be written cannot pass it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CohortStateService,
  InMemoryRecordStore,
  isCohortStateError,
  identityStateKey,
  parseDurableRecord,
  type AccountRef,
  type RecordStore,
} from '../../../src/cohort/index.js';
import type { SyntheticIdentityId } from '../../../src/product/index.js';
import {
  ACCOUNT_REF,
  ENV_STAGING,
  fixedClock,
  makeExplicitCohort,
  makeIdentity,
  makeService,
  makeTempDir,
} from '../../fixtures/cohort/builders.js';
import { storeFor } from '../../fixtures/cohort/records.js';
import { InterleavingStore, TracingRecordStore } from '../../fixtures/cohort/interleaving-store.js';

const VERSION_BEFORE = '2026.10.0';
const VERSION_AFTER = '2026.11.0';

/**
 * The stored revision for one identity, read from the envelope.
 *
 * Deliberately read through the store rather than through the service:
 * the revision is an envelope fact (`IdentityState` carries none), and a
 * test that read it through the accessor under test could not tell
 * whether the accessor or the guard was what it was exercising.
 */
async function storedRevision(store: RecordStore, id: SyntheticIdentityId): Promise<number | undefined> {
  const text = await store.read('identity', identityStateKey(id));
  return text === undefined ? undefined : parseDurableRecord(text, 'identity').revision;
}

/**
 * A `release`-lifecycle identity, mid-transition, at a known revision.
 *
 * Mirrors what `openReleaseWindows` leaves behind: the window is open,
 * one pre-transition observation is on record, and the retained state
 * that makes the second run a returning-user observation exists.
 */
async function stageOpenWindow(id: string) {
  const backing = new InMemoryRecordStore();
  const identity = makeIdentity('release', { id, stateRef: `${id}:state` });
  const setup = new CohortStateService({ store: backing, now: fixedClock() });
  await setup.declareIdentity(identity);
  await setup.openTransition(identity.id, { fromVersion: VERSION_BEFORE });
  await setup.touch(identity.id, '2026-10-01T00:00:00.000Z');
  await setup.recordRun(identity.id, {
    environmentId: ENV_STAGING,
    version: VERSION_BEFORE,
    observedAt: '2026-10-01T00:00:00.000Z',
    runId: 'run-before',
  });
  return { backing, identity };
}

describe('a concurrent release transition is detected, not silently applied', () => {
  it('refuses the losing closeTransition and keeps the winning writer’s observation', async () => {
    const { backing, identity } = await stageOpenWindow('idn-close');
    const revisionAtRead = await storedRevision(backing, identity.id);
    expect(revisionAtRead).toBe(4);

    const aGate = new InterleavingStore(backing);
    const aTrace = new TracingRecordStore(aGate, 'A');
    const bTrace = new TracingRecordStore(backing, 'B');
    const a = new CohortStateService({ store: aTrace, now: fixedClock() });
    const b = new CohortStateService({ store: bTrace, now: fixedClock() });

    // The competing run commits in the window the guard exists to close:
    // after A read the revision, before `put` re-reads it. It is a
    // legitimate writer — the same identity, a later run of the same
    // transition, adding its own observation.
    aGate.armBeforeRead(async () => {
      await b.recordRun(identity.id, {
        environmentId: ENV_STAGING,
        version: VERSION_AFTER,
        observedAt: '2026-11-01T00:00:00.000Z',
        runId: 'run-after',
      });
    }, 1);

    await expect(
      a.closeTransition(
        identity.id,
        { toVersion: VERSION_AFTER, closedAt: '2026-11-01T00:00:00.000Z' },
        { expectedRevision: revisionAtRead ?? 0 },
      ),
    ).rejects.toThrow(/is at revision 5, not the expected 4/);

    // The state that survives is the point. B's observation is still
    // there, the window is still open, and the retained state the
    // transition carries has not been dropped by a write that was never
    // entitled to drop it.
    const after = await a.loadIdentity(identity.id);
    expect(after.observations.map((o) => o.runId)).toEqual(['run-before', 'run-after']);
    expect(after.releaseWindow?.toVersion).toBeUndefined();
    expect(after.retainedState).toBeDefined();
    expect(await storedRevision(backing, identity.id)).toBe(5);

    // The mechanism, stated as surviving state rather than as an absence
    // of an error: the loser never wrote. Had it not been stopped, A's
    // write and B's write would both have claimed revision 5 and the
    // revision counter would have been fooled along with the payload.
    expect(aTrace.trace.labels).toEqual([]);
    expect(bTrace.trace.commits.map((c) => c.revision)).toEqual([5]);
  });

  it('documents the limit: a writer that commits after put’s own read is not detected', async () => {
    // This test asserts that data is LOST. It is here on purpose, and it
    // is the honest half of what #103 can deliver.
    //
    // The guard above closes the window between the caller's read and
    // `put`'s re-read. It cannot close the window between `put`'s
    // re-read and `store.write`, because `RecordStore` has no
    // compare-and-swap primitive: the revision check has already passed
    // by then, and `FileRecordStore`'s rename is atomic for one write but
    // carries no condition. So a competing writer that lands in *this*
    // window is overwritten, its payload is lost, and — because the
    // revision is computed from the earlier read — **both writers store
    // the same revision number.** The counter cannot be used afterwards
    // to detect it either.
    //
    // Pinning this is what stops "the writes are guarded" from being read
    // as "the writes are atomic". Closing it needs a CAS primitive on
    // `RecordStore`, which is #60's contract to change; #103 records the
    // decision and does not pretend otherwise. If someone later adds
    // CAS, this test fails, which is the correct direction for it to
    // fail in.
    const { backing, identity } = await stageOpenWindow('idn-cas-limit');
    const revisionAtRead = await storedRevision(backing, identity.id);
    expect(revisionAtRead).toBe(4);

    const aGate = new InterleavingStore(backing);
    const aTrace = new TracingRecordStore(aGate, 'A');
    const bTrace = new TracingRecordStore(backing, 'B');
    const a = new CohortStateService({ store: aTrace, now: fixedClock() });
    const b = new CohortStateService({ store: bTrace, now: fixedClock() });

    // This time the competitor commits after A's guard has already been
    // evaluated — inside A's `store.write`.
    aGate.armBeforeWrite(async () => {
      await b.recordRun(identity.id, {
        environmentId: ENV_STAGING,
        version: VERSION_AFTER,
        observedAt: '2026-11-01T00:00:00.000Z',
        runId: 'run-after',
      });
    });

    // A is not told anything. This is the un-guaranteed case.
    await a.closeTransition(
      identity.id,
      { toVersion: VERSION_AFTER, closedAt: '2026-11-01T00:00:00.000Z' },
      { expectedRevision: revisionAtRead ?? 0 },
    );

    // B's observation is gone, and the revision counter recorded a single
    // advance for two writes — so the loss leaves no trace in the
    // envelope that a later reader could detect.
    const final = await a.loadIdentity(identity.id);
    expect(final.observations.map((o) => o.runId)).toEqual(['run-before']);
    expect(bTrace.trace.commits.map((c) => c.revision)).toEqual([5]);
    expect(aTrace.trace.commits.map((c) => c.revision)).toEqual([5]);
    expect(await storedRevision(backing, identity.id)).toBe(5);
  });

  it('refuses the losing openTransition', async () => {
    const backing = new InMemoryRecordStore();
    const identity = makeIdentity('release', { id: 'idn-open', stateRef: 'idn-open:state' });
    const setup = new CohortStateService({ store: backing, now: fixedClock() });
    await setup.declareIdentity(identity);
    await setup.touch(identity.id, '2026-10-01T00:00:00.000Z');
    const revisionAtRead = await storedRevision(backing, identity.id);
    expect(revisionAtRead).toBe(2);

    const aGate = new InterleavingStore(backing);
    const a = new CohortStateService({ store: aGate, now: fixedClock() });
    const b = new CohortStateService({ store: backing, now: fixedClock() });

    aGate.armBeforeRead(async () => {
      await b.recordRun(identity.id, {
        environmentId: ENV_STAGING,
        version: VERSION_BEFORE,
        observedAt: '2026-10-01T00:00:00.000Z',
        runId: 'run-competitor',
      });
    }, 1);

    await expect(
      a.openTransition(
        identity.id,
        { fromVersion: VERSION_BEFORE, openedAt: '2026-10-01T00:00:00.000Z' },
        { expectedRevision: revisionAtRead ?? 0 },
      ),
    ).rejects.toThrow(/is at revision 3, not the expected 2/);

    // No window was opened, so nothing downstream can mistake this
    // identity for one that is mid-transition.
    const after = await a.loadIdentity(identity.id);
    expect(after.releaseWindow).toBeUndefined();
    expect(after.observations.map((o) => o.runId)).toEqual(['run-competitor']);
  });

  it('refuses retireIdentity when the record has moved', async () => {
    // Not named in #103, which listed only the two transition writes.
    // It is the same defect in the same file: a mutator that takes no
    // `SaveOptions` and therefore cannot be guarded by anyone.
    const backing = new InMemoryRecordStore();
    const identity = makeIdentity('persistent', { id: 'idn-retire', stateRef: 'retire:state' });
    const setup = new CohortStateService({ store: backing, now: fixedClock() });
    await setup.declareIdentity(identity);
    const revisionAtRead = await storedRevision(backing, identity.id);
    expect(revisionAtRead).toBe(1);

    const aGate = new InterleavingStore(backing);
    const a = new CohortStateService({ store: aGate, now: fixedClock() });
    const b = new CohortStateService({ store: backing, now: fixedClock() });

    aGate.armBeforeRead(async () => {
      await b.touch(identity.id, '2026-10-02T00:00:00.000Z');
    }, 1);

    await expect(
      a.retireIdentity(identity.id, { at: '2026-10-03T00:00:00.000Z' }, { expectedRevision: revisionAtRead ?? 0 }),
    ).rejects.toThrow(/is at revision 2, not the expected 1/);

    // Retirement did not happen, and the competing writer's retained
    // state is intact.
    const after = await a.loadIdentity(identity.id);
    expect(after.retiredAt).toBeUndefined();
    expect(after.retainedState).toBeDefined();
  });

  it('refuses a cohort definition rewrite when the cohort record has moved', async () => {
    // The same defect on the cohort side: `updateCohortDefinition`
    // discarded the resolved membership and rewrote the record with no
    // way for a caller to guard it.
    const backing = new InMemoryRecordStore();
    const service = new CohortStateService({ store: backing, now: fixedClock() });
    const identity = makeIdentity('persistent', { id: 'idn-mem', stateRef: 'mem:state' });
    await service.declareIdentity(identity);
    const cohort = makeExplicitCohort([identity.id], { id: 'coh-guard' });
    await service.declareCohort(cohort);
    const key = `cohort:${cohort.id}`;
    const stored = await backing.read('cohort', key);
    expect(stored).toBeDefined();
    const revisionAtRead = parseDurableRecord(stored as string, 'cohort').revision;

    const aGate = new InterleavingStore(backing);
    const a = new CohortStateService({ store: aGate, now: fixedClock() });
    const b = new CohortStateService({ store: backing, now: fixedClock() });

    aGate.armBeforeRead(async () => {
      await b.resolveCohort(cohort.id, { resolvedAt: '2026-10-01T00:00:00.000Z' });
    }, 1);

    await expect(
      a.updateCohortDefinition(
        makeExplicitCohort([identity.id], { id: 'coh-guard', name: 'Renamed cohort' }),
        { expectedRevision: revisionAtRead },
      ),
    ).rejects.toThrow(/is at revision 2, not the expected 1/);
  });
});

describe('a supplied expectedRevision is enforced even when the record is gone', () => {
  it('refuses a write that expected an existing revision but found no record', async () => {
    const backing = new InMemoryRecordStore();
    const identity = makeIdentity('persistent', { id: 'idn-vanished', stateRef: 'vanished:state' });
    const setup = new CohortStateService({ store: backing, now: fixedClock() });
    await setup.declareIdentity(identity);
    await setup.touch(identity.id, '2026-10-01T00:00:00.000Z');
    const revisionBefore = await storedRevision(backing, identity.id);
    expect(revisionBefore).toBe(2);

    // The record disappears between the caller's read and `put`'s own
    // re-read. The guard used to be skipped entirely whenever the record
    // was absent, so this write recreated it at revision 1 and the
    // caller's expectation was never checked.
    const aGate = new InterleavingStore(backing);
    aGate.armBeforeRead(async () => {
      await backing.delete('identity', identityStateKey(identity.id));
    }, 1);
    const service = new CohortStateService({ store: aGate, now: fixedClock() });

    await expect(
      service.touch(identity.id, '2026-10-02T00:00:00.000Z', { expectedRevision: revisionBefore ?? 0 }),
    ).rejects.toThrow(/no longer exists/);

    // "Refused" has to mean "did not write". A guard that threw and then
    // created the record anyway would satisfy the assertion above.
    expect(await storedRevision(backing, identity.id)).toBeUndefined();
  });

  it('treats expectedRevision 0 as "the record must not exist yet"', async () => {
    // #92's `persistRun` encodes an absent record as revision 0 so the
    // create-race is guarded too. Closing the bypass above must not
    // break that encoding, and the encoding must actually mean what it
    // says: a writer that saw "no record" and then finds one has lost
    // the create-race and is refused rather than overwriting whatever
    // the winner created.
    const backing = new InMemoryRecordStore();
    const identity = makeIdentity('persistent', { id: 'idn-fresh', stateRef: 'fresh:state' });
    const setup = new CohortStateService({ store: backing, now: fixedClock() });
    await setup.declareIdentity(identity);

    // The record exists, but this caller read `currentRevision` before it
    // was declared, so it expects revision 0 — i.e. no record.
    const service = new CohortStateService({ store: backing, now: fixedClock() });
    await expect(
      service.touch(identity.id, '2026-10-02T00:00:00.000Z', { expectedRevision: 0 }),
    ).rejects.toThrow(/is at revision 1, not the expected 0/);

    // Refused means not written: the winner's record is intact.
    expect(await storedRevision(backing, identity.id)).toBe(1);
    expect((await service.loadIdentity(identity.id)).retainedState).toBeUndefined();
  });
});

describe('the guard exemption list is closed and enforced', () => {
  /**
   * Issue #103 item 2 asked whether `SaveOptions.expectedRevision` should
   * be required. It stays optional, and the justification for that — in
   * the "Why `expectedRevision` is optional" note in `service.ts` — rests
   * on an exemption list being *closed*. A comment cannot keep a list
   * closed, so this block is the part that does.
   *
   * Two properties are asserted:
   *
   * 1. **Completeness.** Every public method of `CohortStateService` is
   *    accounted for: a read, a create-only declaration, or a guarded
   *    mutator that appears in the table below. Adding a mutator without
   *    classifying it fails here — which is the point, because a mutator
   *    nobody classified is a mutator nobody checked for a lost-update
   *    hole.
   * 2. **Enforcement.** Every entry in the table really does route the
   *    caller's `expectedRevision` into the guard. Each is called with
   *    `expectedRevision: 0` against a record at revision 1 or more,
   *    which is guaranteed-stale without needing a second writer, and
   *    each must raise `revision_conflict` — not `invalid_transition`,
   *    which would mean the fixture was illegal and the guard never ran.
   */

  /** Reads the record and writes nothing. */
  const READ_ONLY = [
    'currentRevision',
    'loadIdentity',
    'tryLoadIdentity',
    'loadAllIdentities',
    'loadCohort',
    'tryLoadCohort',
    'loadAllCohorts',
  ] as const;

  /**
   * Create-only. These never overwrite an existing record, so there is
   * no last-write-wins window and nothing for a revision to guard —
   * which is the reason they are exempt rather than merely unguarded.
   * The last test below asserts that justification rather than trusting
   * it.
   */
  const CREATE_ONLY = ['declareIdentity', 'declareCohort'] as const;

  /**
   * TypeScript-`private`, so invisible to a type-level caller but present
   * on the prototype at runtime. Listed so the completeness check below
   * stays a check of the *public* surface: `put` is where the guard
   * actually lives, and it is reachable only through the mutators above.
   */
  const INTERNAL = ['writeIdentity', 'put', 'readRecord', 'load', 'loadRequired'] as const;

  const OBSERVATION = {
    environmentId: ENV_STAGING,
    version: VERSION_BEFORE,
    observedAt: '2026-10-01T00:00:00.000Z',
    runId: 'run-a',
  };

  /** A stored `release` identity with an open transition window. */
  async function withOpenWindow() {
    const { backing, identity } = await stageOpenWindow('idn-surface-w');
    return { service: new CohortStateService({ store: backing, now: fixedClock() }), id: identity.id };
  }

  /** A stored `release` identity with no window open. */
  async function releaseWithoutWindow() {
    const backing = new InMemoryRecordStore();
    const identity = makeIdentity('release', { id: 'idn-surface-o', stateRef: 'surface-o:state' });
    const service = new CohortStateService({ store: backing, now: fixedClock() });
    await service.declareIdentity(identity);
    return { service, id: identity.id };
  }

  /** A stored `persistent` identity with no window open. */
  async function plain() {
    const backing = new InMemoryRecordStore();
    const identity = makeIdentity('persistent', { id: 'idn-surface-p', stateRef: 'surface:state' });
    const service = new CohortStateService({ store: backing, now: fixedClock() });
    await service.declareIdentity(identity);
    return { service, id: identity.id, backing };
  }

  /** A stored, resolvable explicit cohort. */
  async function withCohort() {
    const backing = new InMemoryRecordStore();
    const service = new CohortStateService({ store: backing, now: fixedClock() });
    const identity = makeIdentity('persistent', { id: 'idn-surface-c', stateRef: 'surface-c:state' });
    await service.declareIdentity(identity);
    const cohort = makeExplicitCohort([identity.id], { id: 'coh-surface' });
    await service.declareCohort(cohort);
    return { service, cohort, id: identity.id, backing };
  }

  /**
   * Every guarded mutator, with a fixture in which its own transform is
   * legal — so the only thing that can raise is the guard.
   */
  const GUARDED_MUTATORS: ReadonlyArray<{ readonly name: string; readonly run: () => Promise<unknown> }> = [
    {
      name: 'recordRun',
      run: async () => {
        const s = await plain();
        return s.service.recordRun(s.id, OBSERVATION, { expectedRevision: 0 });
      },
    },
    {
      name: 'touch',
      run: async () => {
        const s = await plain();
        return s.service.touch(s.id, '2026-10-02T00:00:00.000Z', { expectedRevision: 0 });
      },
    },
    {
      name: 'openTransition',
      run: async () => {
        const s = await releaseWithoutWindow();
        return s.service.openTransition(s.id, { fromVersion: VERSION_BEFORE }, { expectedRevision: 0 });
      },
    },
    {
      name: 'closeTransition',
      run: async () => {
        const s = await withOpenWindow();
        return s.service.closeTransition(
          s.id,
          { toVersion: VERSION_AFTER, closedAt: '2026-11-01T00:00:00.000Z' },
          { expectedRevision: 0 },
        );
      },
    },
    {
      name: 'resetIdentity',
      run: async () => {
        const s = await plain();
        return s.service.resetIdentity(s.id, { expectedRevision: 0 });
      },
    },
    {
      name: 'retireIdentity',
      run: async () => {
        const s = await plain();
        return s.service.retireIdentity(s.id, { at: '2026-10-03T00:00:00.000Z' }, { expectedRevision: 0 });
      },
    },
    {
      name: 'updateCohortDefinition',
      run: async () => {
        const s = await withCohort();
        return s.service.updateCohortDefinition(
          makeExplicitCohort([s.id], { id: 'coh-surface', name: 'Renamed' }),
          { expectedRevision: 0 },
        );
      },
    },
    {
      name: 'resolveCohort',
      run: async () => {
        const s = await withCohort();
        return s.service.resolveCohort(
          s.cohort.id,
          { resolvedAt: '2026-10-01T00:00:00.000Z' },
          { expectedRevision: 0 },
        );
      },
    },
  ];

  const publicMethods = Object.getOwnPropertyNames(CohortStateService.prototype).filter(
    (name) => name !== 'constructor',
  );

  it('accounts for every public method, so a new mutator cannot be added unclassified', () => {
    const classified = new Set<string>([
      ...READ_ONLY,
      ...CREATE_ONLY,
      ...INTERNAL,
      ...GUARDED_MUTATORS.map((m) => m.name),
    ]);
    const unaccounted = publicMethods.filter((name) => !classified.has(name));

    expect(
      unaccounted,
      'these public methods are neither a read, a create-only declaration, nor a guarded mutator under test',
    ).toEqual([]);
  });

  it('refuses a stale revision on every guarded mutator', async () => {
    for (const testCase of GUARDED_MUTATORS) {
      const error: unknown = await testCase.run().then(
        () => undefined,
        (e: unknown) => e,
      );
      // The transform must not be what raised: a lifecycle violation
      // would mean the fixture was wrong, not that the guard fired.
      expect(isCohortStateError(error), `${testCase.name} must refuse a stale revision`).toBe(true);
      if (!isCohortStateError(error)) throw new Error('unreachable');
      expect(error.code, `${testCase.name} error code`).toBe('revision_conflict');
    }
  });

  it('justifies the create-only exemptions: a re-declaration never overwrites', async () => {
    // The exemption is justified by the *absence of a write over an
    // existing record*, so that is what is asserted. If a future change
    // made `declareIdentity` overwrite on re-declaration, this fails and
    // the exemption has to be withdrawn rather than left standing on a
    // stale reason.
    const backing = new InMemoryRecordStore();
    const service = new CohortStateService({ store: backing, now: fixedClock() });
    const identity = makeIdentity('persistent', { id: 'idn-exempt', stateRef: 'exempt:state' });
    await service.declareIdentity(identity);
    expect(await storedRevision(backing, identity.id)).toBe(1);

    // A re-declaration must not write: the revision is unchanged even
    // though the identity now has accumulated state.
    await service.touch(identity.id, '2026-10-01T00:00:00.000Z');
    const withState = await storedRevision(backing, identity.id);
    await service.declareIdentity(identity);
    expect(await storedRevision(backing, identity.id)).toBe(withState);

    // A differing declaration is refused, not applied.
    await expect(service.declareIdentity({ ...identity, displayName: 'Different' })).rejects.toThrow();
    expect(await storedRevision(backing, identity.id)).toBe(withState);
    expect((await service.loadIdentity(identity.id)).retainedState).toBeDefined();
  });

  it('create-only declarations are guarded too: a concurrent first declare is refused', async () => {
    // The one window a create path does have.
    //
    // `declareIdentity` reads, and if the record is absent writes. Those
    // are two separate awaits, so two concurrent first declarations of
    // the same id both observe "absent" and both write — and because
    // `extra.accountRef` is caller-supplied, the loser's `accountRef`
    // would disappear with no error at all. That is the same
    // last-write-wins shape as the transition writes, wearing a create
    // path's clothes, and it is why the exemption in the note above is
    // safe rather than merely asserted.
    const backing = new InMemoryRecordStore();
    const identity = makeIdentity('persistent', { id: 'idn-create-race', stateRef: 'race:state' });

    const aGate = new InterleavingStore(backing);
    const a = new CohortStateService({ store: aGate, now: fixedClock() });
    const b = new CohortStateService({ store: backing, now: fixedClock() });

    // B creates the record in the window between A's read and A's write.
    aGate.armBeforeRead(async () => {
      await b.declareIdentity(identity, { accountRef: ACCOUNT_REF });
    }, 1);

    await expect(
      a.declareIdentity(identity, { accountRef: 'acct-alice-secondary' as AccountRef }),
    ).rejects.toThrow(/is at revision 1, not the expected 0/);

    // The winner's record is what survives, accountRef included.
    const stored = await a.loadIdentity(identity.id);
    expect(stored.accountRef).toBe(ACCOUNT_REF);
    expect(await storedRevision(backing, identity.id)).toBe(1);
  });
});


describe('currentRevision reports the envelope revision', () => {
  it('reads the same revision the guard compares against', async () => {
    const backing = new InMemoryRecordStore();
    const service = new CohortStateService({ store: backing, now: fixedClock() });
    const identity = makeIdentity('persistent', { id: 'idn-rev', stateRef: 'rev:state' });

    expect(await service.currentRevision(identity.id)).toBeUndefined();
    await service.declareIdentity(identity);
    expect(await service.currentRevision(identity.id)).toBe(1);
    await service.touch(identity.id, '2026-10-01T00:00:00.000Z');
    expect(await service.currentRevision(identity.id)).toBe(2);
    expect(await service.currentRevision(identity.id)).toBe(
      await storedRevision(backing, identity.id),
    );
  });
});

describe('control: a single-writer release transition is unaffected', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const temp = await makeTempDir();
    dir = temp.dir;
    cleanup = temp.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  it('completes open → run → close under a guard on every write', async () => {
    const service = makeService(dir);
    const reader = storeFor(dir);
    const identity = makeIdentity('release', { id: 'idn-solo', stateRef: 'solo:state' });
    await service.declareIdentity(identity);

    // Every write is made under the revision the caller just read, which
    // is what a guarded caller does.
    const observed = await service.openTransition(
      identity.id,
      { fromVersion: VERSION_BEFORE },
      { expectedRevision: (await service.currentRevision(identity.id)) ?? 0 },
    );
    expect(observed.releaseWindow?.fromVersion).toBe(VERSION_BEFORE);

    await service.touch(identity.id, '2026-10-01T00:00:00.000Z', {
      expectedRevision: (await service.currentRevision(identity.id)) ?? 0,
    });
    await service.recordRun(
      identity.id,
      {
        environmentId: ENV_STAGING,
        version: VERSION_BEFORE,
        observedAt: '2026-10-01T00:00:00.000Z',
        runId: 'run-before',
      },
      { expectedRevision: (await service.currentRevision(identity.id)) ?? 0 },
    );
    await service.recordRun(
      identity.id,
      {
        environmentId: ENV_STAGING,
        version: VERSION_AFTER,
        observedAt: '2026-11-01T00:00:00.000Z',
        runId: 'run-after',
      },
      { expectedRevision: (await service.currentRevision(identity.id)) ?? 0 },
    );
    const closed = await service.closeTransition(
      identity.id,
      { toVersion: VERSION_AFTER, closedAt: '2026-11-01T00:00:00.000Z' },
      { expectedRevision: (await service.currentRevision(identity.id)) ?? 0 },
    );

    expect(closed.releaseWindow?.toVersion).toBe(VERSION_AFTER);
    expect(closed.retainedState).toBeUndefined();
    expect(closed.observations.map((o) => o.runId)).toEqual(['run-before', 'run-after']);

    // Re-read through a second service over the same directory, and
    // cross-checked against the raw bytes. The guarantee under test is
    // that the persisted record is right, not that an object in memory
    // looked right.
    const reloaded = await makeService(dir).loadIdentity(identity.id);
    expect(reloaded.observations.map((o) => o.runId)).toEqual(['run-before', 'run-after']);
    expect(reloaded.releaseWindow?.toVersion).toBe(VERSION_AFTER);
    expect(reloaded.retainedState).toBeUndefined();
    expect(await storedRevision(reader, identity.id)).toBe(6);
  });

  it('still lets the create-only declare paths work without a guard', async () => {
    // `declareIdentity` and `declareCohort` are the legitimately
    // single-writer paths: they never overwrite an existing record, so
    // there is no last-write-wins window to close and nothing for a
    // revision to guard. See the "Why `expectedRevision` is optional"
    // note in `service.ts`.
    const service = makeService(dir);
    const identity = makeIdentity('persistent', { id: 'idn-declare', stateRef: 'declare:state' });
    const first = await service.declareIdentity(identity);
    const second = await service.declareIdentity(identity);
    expect(second).toEqual(first);

    await service.touch(identity.id, '2026-10-01T00:00:00.000Z');
    const afterTouch = await service.loadIdentity(identity.id);

    // Re-declaring must not wipe the accumulated state.
    expect(await service.declareIdentity(identity)).toEqual(afterTouch);

    // A declaration that differs is refused rather than applied.
    await expect(
      service.declareIdentity({ ...identity, displayName: 'Someone else' }),
    ).rejects.toThrow(/already stored with a different declaration/);
    expect(await service.loadIdentity(identity.id)).toEqual(afterTouch);
  });
});
