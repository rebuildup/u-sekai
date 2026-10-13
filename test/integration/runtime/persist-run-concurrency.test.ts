/**
 * Acceptance: `persistRun` refuses a concurrent write rather than
 * clobbering it (Issue #92).
 *
 * ## The defect this file was written before the fix for
 *
 * #60 publishes an optimistic-concurrency guard — `SaveOptions
 * .expectedRevision` — and enforces it in `CohortStateService.put`.
 * #63's `persistRun` called `recordRun` without it. The guard existed,
 * was correct, and was never supplied, so two evaluations of one
 * identity were last-write-wins: whichever run persisted last replaced
 * the record, and the other run's observation and retained-state count
 * disappeared with no error anywhere.
 *
 * The first test below is the one that goes red on the unfixed code. It
 * asserts the outcome, not the mechanism, so it stays meaningful if the
 * implementation changes shape.
 *
 * ## Why the control cases are the point
 *
 * "The second write is refused" is a claim that a broken harness can
 * satisfy trivially. A `persistRun` that refused *everything* would
 * pass that assertion while destroying the feature. Three tests pin the
 * other half:
 *
 * | test | what it rules out |
 * | --- | --- |
 * | a lone `persistRun` succeeds and its observation is readable back | a store that refuses to persist at all |
 * | two **sequential** `persistRun` calls both succeed and accumulate | a guard that fires on the legitimate serial path |
 * | the concurrent test asserts the *survivor's* data is present | "refused" achieved by losing everyone's writes |
 *
 * The sequential test is the strongest of the three. It is the ordinary
 * case — two runs of the same returning user, one after the other — and
 * a guard that cannot tell it apart from a race has no business being
 * called a guard.
 *
 * ## No retry policy is asserted
 *
 * Issue #92 deliberately does not decide whether a conflict should
 * retry or fail; that belongs to #60/#66. So the tests pin only what is
 * decided: the conflict is **detected**, it is **typed distinctly** from
 * an unrelated store failure, it **carries the revisions** that made it
 * diagnosable, and it **does not overwrite**. A test asserting "it
 * retries three times" would be inventing a product decision.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { persistRun, isRuntimeIntegrationError } from '../../../src/runtime/index.js';
import { CohortStateService, FileRecordStore } from '../../../src/cohort/index.js';
import { makeIdentity, makePlan, makeTempDir, asEnvironmentId, ENV_A, PRODUCT_ID } from './support/fixtures.js';
import { GatedRecordStore } from './support/gated-store.js';
import type { SyntheticIdentity } from '../../../src/product/index.js';

const ALICE = { id: 'idn-concurrent', lifecycle: 'persistent' as const };

let dir: string;
let cleanup: () => Promise<void>;

/** A service over the shared bytes — one per writer, as two processes would be. */
function writer(now: () => string): CohortStateService {
  return new CohortStateService({
    store: new FileRecordStore({ rootDir: dir }),
    now,
  });
}

function clock(start: string): () => string {
  let tick = 0;
  return () => new Date(Date.parse(start) + tick++ * 1_000).toISOString();
}

beforeEach(async () => {
  const temp = await makeTempDir('u-sekai-runtime-concurrency-');
  dir = temp.dir;
  cleanup = temp.cleanup;
});

afterEach(async () => {
  await cleanup();
});

/** Declare the identity and its cohort, then hand back a seeded service. */
async function seed(): Promise<CohortStateService> {
  const service = writer(clock('2026-10-01T00:00:00.000Z'));
  const identity = makeIdentity(ALICE);
  await service.declareIdentity(identity);
  return service;
}

function persistArgs(
  service: CohortStateService,
  identity: SyntheticIdentity,
  runId: string,
  version: string,
) {
  return {
    service,
    plan: makePlan({
      environmentId: ENV_A,
      version,
      observedAt: '2026-10-01T00:00:00.000Z',
      delivery: `${version}-${runId}`,
    }),
    members: [identity],
    environmentId: asEnvironmentId(ENV_A),
    version,
    runId,
    observedAt: '2026-10-01T00:00:00.000Z',
  } as const;
}

interface RacingWriters {
  readonly identity: SyntheticIdentity;
  readonly first: CohortStateService;
  readonly second: CohortStateService;
  readonly parked: GatedRecordStore;
  /** The losing run, still in flight, held at the point of its second read. */
  readonly losing: Promise<unknown>;
}

/**
 * Two services over one set of bytes, with the second one parked
 * mid-flight so the first can commit underneath it.
 *
 * The parking point is the whole trick and is the same in every test
 * here: let the second writer take **one** read, then hold it. Arming
 * any earlier parks the revision observation itself, and the writer
 * would then correctly succeed against the newer revision — a
 * different scenario, not a lost update. Arming any later holds a read
 * that happens after it has already decided, which proves nothing.
 */
async function raceTwoWriters(): Promise<RacingWriters> {
  const inner = new FileRecordStore({ rootDir: dir });
  const firstStore = new GatedRecordStore(inner);
  const secondStore = new GatedRecordStore(inner);
  const started = '2026-10-01T00:00:00.000Z';
  const first = new CohortStateService({ store: firstStore, now: clock(started) });
  const second = new CohortStateService({ store: secondStore, now: clock(started) });
  const identity = makeIdentity(ALICE);
  await first.declareIdentity(identity);

  const losing = persistRun(persistArgs(second, identity, 'run-losing', '2026.10.9'));
  await secondStore.afterReads(1);
  secondStore.holdNextRead();
  await secondStore.held();

  return { identity, first, second, parked: secondStore, losing };
}

describe('a lone persistRun writes and its data survives', () => {
  it('records the observation and leaves it readable by a second service', async () => {
    const service = await seed();
    const identity = makeIdentity(ALICE);

    const result = await persistRun(persistArgs(service, identity, 'run-solo', '2026.10.1'));

    expect(result.persistedIdentityIds).toEqual([identity.id]);

    // Read back through a service that shares nothing but the bytes.
    const reopened = writer(clock('2026-10-02T00:00:00.000Z'));
    const stored = await reopened.loadIdentity(identity.id);
    expect(stored.observations).toHaveLength(1);
    expect(stored.observations[0]).toMatchObject({ runId: 'run-solo', version: '2026.10.1' });
    expect(stored.retainedState?.interactionCount).toBe(1);
  });
});

describe('sequential persistRun calls are not mistaken for a race', () => {
  it('accumulates both observations across two runs of the same identity', async () => {
    const service = await seed();
    const identity = makeIdentity(ALICE);

    await persistRun(persistArgs(service, identity, 'run-1', '2026.10.1'));
    await persistRun(persistArgs(service, identity, 'run-2', '2026.10.2'));

    const stored = await writer(clock('2026-10-03T00:00:00.000Z')).loadIdentity(identity.id);
    expect(stored.observations.map((o) => o.runId).sort()).toEqual(['run-1', 'run-2']);
    expect(stored.retainedState?.interactionCount).toBe(2);
  });
});

describe('a concurrent persistRun is refused instead of clobbering', () => {
  it('keeps the committed run and raises a typed conflict for the other', async () => {
    const race = await raceTwoWriters();
    const { identity, first, parked, losing } = race;

    // The other run commits in full while the second is parked.
    const winning = await persistRun(persistArgs(first, identity, 'run-winning', '2026.10.1'));
    expect(winning.persistedIdentityIds).toEqual([identity.id]);

    parked.release();

    // --- The defect, before the fix: `losing` resolved, and its write
    // replaced the record, so `run-winning`'s observation was gone.
    const outcome = await losing.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    expect(outcome.ok).toBe(false);

    // --- Control, in the same test: the run that committed is intact.
    // Without this, "refused" could be satisfied by losing every write.
    const stored = await writer(clock('2026-10-04T00:00:00.000Z')).loadIdentity(identity.id);
    expect(stored.observations.map((o) => o.runId)).toEqual(['run-winning']);
    expect(stored.observations.map((o) => o.runId)).not.toContain('run-losing');
    expect(stored.retainedState?.interactionCount).toBe(1);

    // --- The failure is typed and diagnosable, not a generic store error.
    // The two `throw`s are narrowing for the type checker, which `expect`
    // cannot do; in a passing run neither is reached.
    if (outcome.ok) throw new Error('unreachable: the assertion above already failed');
    if (!isRuntimeIntegrationError(outcome.error)) throw new Error('unreachable');
    expect(outcome.error.code).toBe('revisionConflict');
    // `code` on the runtime error, `detail.code` on the #60 error it
    // came from: two layers, two names, both preserved.
    expect(outcome.error.field).toBe('identity.recordRun');
    expect(outcome.error.detail).toMatchObject({
      identityId: identity.id,
      code: 'revision_conflict',
    });
    // The revisions are carried so an operator can tell "someone else
    // wrote" from "the record was rebuilt", which is the difference
    // between a retry and a phone call.
    const expected = outcome.error.detail.expected;
    const actual = outcome.error.detail.actual;
    expect(expected).toBeTypeOf('number');
    expect(actual).toBeTypeOf('number');
    expect(actual as number).toBeGreaterThan(expected as number);
  });
});

describe('the conflict is loud, not swallowed', () => {
  it('leaves the committed record at the winner revision rather than advancing on the loser', async () => {
    const race = await raceTwoWriters();
    const { identity, first, parked, losing } = race;

    const committedRevision = await first.currentRevision(identity.id);
    expect(committedRevision).toBe(1);

    await persistRun(persistArgs(first, identity, 'run-winning', '2026.10.1'));
    parked.release();
    await expect(losing).rejects.toThrow();

    // The refused writer advanced nothing. If the guard were absent this
    // would be a strictly larger number, which is the "both writes
    // happened" signature.
    const after = await writer(clock('2026-10-05T00:00:00.000Z')).currentRevision(identity.id);
    // declareIdentity (1) + the winner's recordRun (1) + touch (1).
    expect(after).toBe(3);
  });
});

describe('the product is the one that is being evaluated', () => {
  it('pins the fixture identity to this product so the failure is not a cross-product join', () => {
    expect(makeIdentity(ALICE).productId).toBe(PRODUCT_ID);
  });
});
