/**
 * Every durable write the runtime performs carries a **measured**
 * revision (issue #106).
 *
 * ## Why this file exists beside the race file
 *
 * `release-transition-concurrency.test.ts` pins the *effect* of the
 * guard: stage a race, assert the losing write was refused and the data
 * survived. This file pins the *wiring*, which is the actual defect.
 *
 * The defect #92 and #103 jointly left behind was not "the guard fires
 * unreliably". It was that #103 made the cohort layer **enforce** a
 * guard and **no caller ever supplied one**. Two halves of a fix, each
 * individually correct, together producing a protection that exists on
 * paper. A race test alone would not have caught that either half was
 * needed: with the runtime supplying nothing, every guard call in the
 * suite either passed an explicit revision the test itself chose, or
 * never raced.
 *
 * So this file asserts the invariant directly, on the runtime's whole
 * write surface, by recording what the runtime actually asks the
 * service to do.
 *
 * ## The invariant, stated as a sequence rather than as a set
 *
 * > Every write the runtime performs is immediately preceded by its own
 * > measurement of that identity's revision, and no write is performed
 * > with a revision the runtime did not just read.
 *
 * "Immediately preceded" is the load-bearing word. Checking only that a
 * write carried *some* number would pass for a constant `1`, for a `0`
 * that means nothing, and for a revision measured once at the top of the
 * function and reused — all three of which the lead brief names as
 * things a revision must not be, and all three of which look identical
 * to a set-membership assertion. The event log below is ordered, and
 * the assertion is about adjacency in it, so a hoisted measurement fails
 * the moment the second member is written.
 *
 * It also catches the failure mode that a per-call assertion cannot: a
 * mutator called with `options` omitted entirely. Omission is not "some
 * number", it is the absence of the guard, and only adjacency makes the
 * two distinguishable.
 *
 * ## Why the adjacent mutators are pinned as *uncalled*
 *
 * #103 went past its own issue and guarded `retireIdentity`,
 * `resetIdentity` and `updateCohortDefinition` as well as the two
 * transition writes, because leaving one of three identical unguarded
 * mutators behind is the half-fix this whole investigation rejects.
 *
 * The runtime calls **none** of them. That is worth pinning rather than
 * asserting in prose: if a future change starts calling
 * `retireIdentity` from `persistRun`, the closed-list assertion below
 * fails and the new path has to be classified — which is the same
 * discipline #103 applies to the cohort layer's own method list,
 * applied to the runtime's.
 *
 * ## The one call that is unguarded, and why it stays that way
 *
 * `resolveCohort` rewrites the *cohort* record, and the cohort layer
 * exposes a revision accessor for *identity* records only. The runtime
 * therefore has no value it could supply, and supplying a wrong one
 * (another identity's revision, or the cohort id) would be worse than
 * supplying none.
 *
 * So the fail direction is stated rather than implied:
 *
 * - **Fail closed** everywhere the runtime can measure. There is no
 *   parameter, option or branch in `src/runtime/**` by which a durable
 *   write is made unguarded; the caller cannot opt out because there is
 *   nothing to opt out of.
 * - **"No protection applies"** on the one path where measuring is
 *   structurally impossible — named in a comment at the call site in
 *   `persistence.ts`, named here, and asserted to be the *only*
 *   unguarded call, so the two can never quietly converge into one
 *   claim.
 *
 * A real conflict on that path is therefore still undetectable. That is
 * stated in the production comment and pinned by a test in the race
 * file; it is not absorbed here, because closing it needs a
 * cohort-side revision accessor and #60's compare-and-swap contract,
 * both of which belong to `src/cohort/**`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  persistRun,
  openReleaseWindows,
  resolveCohort,
} from '../../../src/runtime/index.js';
import {
  CohortStateService,
  FileRecordStore,
  type AccountRef,
  type CohortState,
  type IdentityState,
  type RecordedObservation,
  type ResolveOptions,
  type SaveOptions,
} from '../../../src/cohort/index.js';
import type {
  CohortId,
  SyntheticCohort,
  SyntheticIdentity,
  SyntheticIdentityId,
} from '../../../src/product/index.js';
import {
  ENV_A,
  ENV_B,
  asEnvironmentId,
  makeExplicitCohort,
  makeIdentity,
  makePlan,
  fixedClock,
} from './support/fixtures.js';

const VERSION_BEFORE = '2026.10.1';
const VERSION_AFTER = '2026.10.2';
const BEFORE_AT = '2026-10-01T00:00:00.000Z';
const AFTER_AT = '2026-10-08T00:00:00.000Z';

/* -------------------------------------------------------------------------- */
/* Recording the runtime's write surface                                         */
/* -------------------------------------------------------------------------- */

type GuardedWrite =
  | 'recordRun'
  | 'touch'
  | 'openTransition'
  | 'closeTransition'
  | 'resetIdentity'
  | 'retireIdentity'
  | 'updateCohortDefinition';
type AnyWrite = GuardedWrite | 'declareIdentity' | 'declareCohort' | 'resolveCohort';

/**
 * Every mutator #103 gave a guard to, whether or not the runtime calls
 * it.
 *
 * Listed in full rather than trimmed to the ones the runtime uses,
 * because a trimmed list would make the "was it called?" assertion below
 * pass by construction for any method left out of it.
 */
const GUARDED_MUTATORS: ReadonlyArray<GuardedWrite> = [
  'recordRun',
  'touch',
  'openTransition',
  'closeTransition',
  'resetIdentity',
  'retireIdentity',
  'updateCohortDefinition',
];

function isGuarded(name: AnyWrite): name is GuardedWrite {
  return (GUARDED_MUTATORS as ReadonlyArray<AnyWrite>).includes(name);
}

type Event =
  | { readonly kind: 'measure'; readonly identityId: SyntheticIdentityId }
  | { readonly kind: 'write'; readonly name: AnyWrite; readonly expectedRevision: number | undefined };

type WriteEvent = Extract<Event, { readonly kind: 'write' }>;
type MeasureEvent = Extract<Event, { readonly kind: 'measure' }>;

function isWrite(event: Event): event is WriteEvent {
  return event.kind === 'write';
}

function isMeasure(event: Event): event is MeasureEvent {
  return event.kind === 'measure';
}

/**
 * The write events, in order.
 *
 * A named predicate rather than `as` casts: a cast would let the test
 * assert a shape it had not actually checked, which is the same
 * "absence read as presence" shape the rest of this investigation is
 * about.
 */
function writes(events: ReadonlyArray<Event>): ReadonlyArray<WriteEvent> {
  return events.filter(isWrite);
}

/**
 * A real service that reports, in order, what it was asked to do.
 *
 * A subclass rather than a spy or a `Proxy` on purpose: the runtime
 * takes a `CohortStateService`, so the recording has to *be* one, and a
 * hand-written stand-in would be a different type with different
 * behaviour — exactly the substitution the contract forbids. Every
 * override delegates to `super`, so the writes under test are the
 * production ones.
 *
 * `expectedRevision` is recorded as `undefined` when the caller omitted
 * it, which is the case that matters: `{}` and "no third argument at
 * all" are the same thing to `put`, and a recording that conflated them
 * with a supplied value would be the bug this file exists to catch.
 *
 * Every mutator is overridden, **including the two the runtime never
 * calls** (`declareIdentity`, `declareCohort`). That is not dead code:
 * the closed-list assertion below is only sound if an *unrecorded* call
 * is impossible, so a runtime that started declaring identities through
 * the service would be caught here rather than slipping past the log.
 */
class RecordingService extends CohortStateService {
  readonly events: Event[] = [];

  private write(name: AnyWrite, options: SaveOptions | undefined): void {
    this.events.push({ kind: 'write', name, expectedRevision: options?.expectedRevision });
  }

  override async currentRevision(id: SyntheticIdentityId): Promise<number | undefined> {
    const revision = await super.currentRevision(id);
    this.events.push({ kind: 'measure', identityId: id });
    return revision;
  }

  override async declareIdentity(
    identity: SyntheticIdentity,
    extra: { readonly accountRef?: AccountRef } = {},
  ): Promise<IdentityState> {
    this.write('declareIdentity', undefined);
    return super.declareIdentity(identity, extra);
  }

  override async declareCohort(cohort: SyntheticCohort): Promise<CohortState> {
    this.write('declareCohort', undefined);
    return super.declareCohort(cohort);
  }

  override async recordRun(
    id: SyntheticIdentityId,
    observation: RecordedObservation,
    options: SaveOptions = {},
  ): Promise<IdentityState> {
    this.write('recordRun', options);
    return super.recordRun(id, observation, options);
  }

  override async touch(id: SyntheticIdentityId, at: string, options: SaveOptions = {}): Promise<IdentityState> {
    this.write('touch', options);
    return super.touch(id, at, options);
  }

  override async openTransition(
    id: SyntheticIdentityId,
    input: { readonly fromVersion: string; readonly openedAt?: string },
    options: SaveOptions = {},
  ): Promise<IdentityState> {
    this.write('openTransition', options);
    return super.openTransition(id, input, options);
  }

  override async closeTransition(
    id: SyntheticIdentityId,
    input: { readonly toVersion: string; readonly closedAt?: string },
    options: SaveOptions = {},
  ): Promise<IdentityState> {
    this.write('closeTransition', options);
    return super.closeTransition(id, input, options);
  }

  override async resetIdentity(id: SyntheticIdentityId, options: SaveOptions = {}): Promise<IdentityState> {
    this.write('resetIdentity', options);
    return super.resetIdentity(id, options);
  }

  override async retireIdentity(
    id: SyntheticIdentityId,
    input: { readonly at?: string } = {},
    options: SaveOptions = {},
  ): Promise<IdentityState> {
    this.write('retireIdentity', options);
    return super.retireIdentity(id, input, options);
  }

  override async updateCohortDefinition(
    cohort: SyntheticCohort,
    options: SaveOptions = {},
  ): Promise<CohortState> {
    this.write('updateCohortDefinition', options);
    return super.updateCohortDefinition(cohort, options);
  }

  override async resolveCohort(
    id: CohortId,
    options: Partial<ResolveOptions> = {},
    saveOptions: SaveOptions = {},
  ): Promise<CohortState> {
    this.write('resolveCohort', saveOptions);
    return super.resolveCohort(id, options, saveOptions);
  }
}

/* -------------------------------------------------------------------------- */
/* Setup                                                                        */
/* -------------------------------------------------------------------------- */

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'u-sekai-guard-wiring-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function transitionPlan(runId: string, version: string) {
  return makePlan({
    environmentId: ENV_B,
    version,
    observedAt: AFTER_AT,
    previousObservation: { environmentId: ENV_A, version: VERSION_BEFORE, observedAt: BEFORE_AT },
    delivery: `${version}-${runId}`,
  });
}

/**
 * A `release` cohort of three members, seeded through a *plain* service.
 *
 * Plain, not recording, because the declarations are the fixture's
 * business and not the runtime's: they would otherwise appear in the
 * event log as runtime writes and blur exactly the boundary this file
 * measures.
 */
async function seeded(ids: ReadonlyArray<string>, stage: string) {
  const backing = new FileRecordStore({ rootDir: path.join(dir, stage) });
  const setup = new CohortStateService({ store: backing, now: fixedClock(BEFORE_AT) });
  const members = ids.map((id) => makeIdentity({ id, lifecycle: 'release' }));
  for (const member of members) await setup.declareIdentity(member);
  const cohort = makeExplicitCohort(members.map((m) => m.id));
  await setup.declareCohort(cohort);
  return { backing, members, cohortId: cohort.id };
}

/** Drives the runtime's whole write surface over a fresh recording service. */
async function runRuntime(
  backing: FileRecordStore,
  cohortId: CohortId,
  members: ReadonlyArray<SyntheticIdentity>,
): Promise<ReadonlyArray<Event>> {
  const service = new RecordingService({ store: backing, now: fixedClock(AFTER_AT) });

  const resolved = await resolveCohort({
    service,
    cohortId,
    planningCeiling: members.length,
    resolvedAt: BEFORE_AT,
  });
  expect(resolved.members.map((m) => m.id)).toEqual(members.map((m) => m.id));

  await openReleaseWindows({
    service,
    plan: transitionPlan('open', VERSION_AFTER),
    members: resolved.members,
    openedAt: BEFORE_AT,
  });

  // The three phases are awaited one after another on purpose. They are
  // not independent operations: each write's guard is the revision the
  // previous phase left behind, so running them concurrently would
  // manufacture a race the runtime does not create and measure the wrong
  // thing.
  await persistRun({
    service,
    plan: transitionPlan('run', VERSION_AFTER),
    members: resolved.members,
    environmentId: asEnvironmentId(ENV_B),
    version: VERSION_AFTER,
    runId: 'run-wiring',
    observedAt: AFTER_AT,
    closeTransition: true,
  });

  return service.events;
}

/* -------------------------------------------------------------------------- */
/* The invariant                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The runtime's write surface, as a closed list.
 *
 * Closed on both sides of the assertion below: a call the runtime does
 * not make here, and a call it makes that this file has not classified,
 * both fail. #103 applies the same discipline to
 * `CohortStateService.prototype`; this is the same idea applied to the
 * runtime, which #103 could not reach and #92 did not audit.
 */
const RUNTIME_WRITES: ReadonlyArray<AnyWrite> = [
  'resolveCohort',
  'openTransition',
  'recordRun',
  'touch',
  'closeTransition',
];

/**
 * The one call the runtime makes with no revision, and why.
 *
 * `resolveCohort` rewrites the cohort record. The cohort layer exposes a
 * revision accessor for *identity* records and no cohort-side
 * equivalent, so there is no value this ticket could supply without
 * inventing one — and an invented revision is worse than none, because
 * it would refuse writes at random or, with a reused identity revision,
 * refuse the wrong ones.
 *
 * So it stays unguarded, and the production code says so at the call
 * site. The cost is real and is pinned by
 * `release-transition-concurrency.test.ts`; closing it needs
 * `src/cohort/**`, which is #60's and #103's.
 */
const UNGUARDABLE: ReadonlyArray<AnyWrite> = ['resolveCohort'];

describe('every durable write the runtime performs carries its own measured revision', () => {
  it('measures immediately before each write, for every member, with no value reused', async () => {
    const { backing, members, cohortId } = await seeded(['idn-w1', 'idn-w2', 'idn-w3'], 'primary');
    const events = await runRuntime(backing, cohortId, members);

    expect(events.length, 'the run must actually have written').toBeGreaterThan(0);

    // --- Closed list, first: it is the precondition for the rest.
    expect(
      [...new Set(writes(events).map((e) => e.name))].sort(),
      'the runtime’s write surface must stay classified — an unlisted mutator means an unclassified path',
    ).toEqual([...RUNTIME_WRITES].sort());

    // --- Adjacency: each guarded write is preceded by its own
    // measurement, of the same identity, with nothing in between.
    //
    // This is what rejects a hoisted revision, a constant, and a value
    // carried over from an unrelated write. All three would pass an
    // assertion that only asked "is there a number here", and all three
    // are the defect this ticket exists to remove.
    const guarded = GUARDED_MUTATORS;
    expect(guarded.length, 'the guarded-mutator list is not empty').toBeGreaterThan(0);

    let measurements = 0;
    const paired: Array<{ name: GuardedWrite; identityId: SyntheticIdentityId; revision: number }> = [];
    events.forEach((event, index) => {
      if (isMeasure(event)) {
        measurements += 1;
        return;
      }
      if (!isGuarded(event.name)) return;

      const previous = index === 0 ? undefined : events[index - 1];
      if (previous === undefined || !isMeasure(previous)) {
        throw new Error(
          `${event.name} must be preceded by its own currentRevision read — ` +
            'a revision from anywhere else is not a guard',
        );
      }
      expect(
        event.expectedRevision,
        `${event.name} must supply a measured revision; ${String(event.expectedRevision)} means it supplied none`,
      ).toBeTypeOf('number');
      if (event.expectedRevision === undefined) {
        throw new Error(`${event.name} supplied no revision; the assertion above already failed`);
      }
      // `0` is #60's encoding for "the record must not exist yet". It is
      // correct for a create and only a create; every runtime write here
      // targets a declared identity, so seeing it would mean the runtime
      // substituted a constant for a measurement.
      expect(
        event.expectedRevision,
        `${event.name} must not use the create-only encoding 0 for an existing record`,
      ).toBeGreaterThan(0);

      paired.push({ name: event.name, identityId: previous.identityId, revision: event.expectedRevision });
    });

    // One measurement per guarded write, exactly. A count, not just a
    // pattern, so a *surplus* measurement (a read taken and then not
    // used) is visible rather than invisible.
    expect(measurements, 'one measurement per guarded write, no more and no fewer').toBe(paired.length);

    // --- Per identity, the revisions strictly increase. Distinct across
    // the run is *not* the claim and would be false — three members all
    // start at revision 1, so the same number legitimately recurs for
    // different identities. Strictly increasing per identity is the
    // claim that rejects a carried-over value, and it is the one the
    // sequence of measurements is supposed to produce.
    for (const id of new Set(paired.map((p) => p.identityId))) {
      const mine = paired.filter((p) => p.identityId === id);
      const revisions = mine.map((p) => p.revision);
      expect(revisions, `${id}: each write must measure a strictly newer revision than the last`).toEqual(
        [...revisions].sort((a, b) => a - b),
      );
      expect(new Set(revisions).size, `${id}: no revision may be reused across writes`).toBe(revisions.length);
      expect(mine.map((p) => p.name), `${id}: every member gets the same write sequence`).toEqual([
        'openTransition',
        'recordRun',
        'touch',
        'closeTransition',
      ]);
    }
  });

  it('leaves the adjacent guarded mutators uncalled, so none is reachable unguarded', async () => {
    const { backing, members, cohortId } = await seeded(['idn-adj'], 'adjacent');
    const events = await runRuntime(backing, cohortId, members);
    const called = new Set(writes(events).map((e) => e.name));

    // #103 guarded these precisely because leaving one of three
    // identical unguarded mutators behind is the half-fix this work
    // rejects. The runtime reaches none of them — and this assertion is
    // what makes that a checked fact rather than a claim, because the
    // first change that calls one from `src/runtime/**` turns it red.
    for (const name of ['retireIdentity', 'resetIdentity', 'updateCohortDefinition'] as const) {
      expect(called.has(name), `the runtime must not call ${name} without classifying it`).toBe(false);
    }
  });

  it('makes the single unguarded call explicit, and says which one it is', async () => {
    const { backing, members, cohortId } = await seeded(['idn-exempt'], 'exempt');
    const events = await runRuntime(backing, cohortId, members);

    const unguarded = writes(events)
      .filter((e) => e.expectedRevision === undefined)
      .map((e) => e.name);

    // The dangerous steady state is "optional, enforced, and nobody
    // supplies it" — a guard that reads as protection and is not. The
    // way out is not to pretend it does not exist but to name it, which
    // is what this list is: one call, on the cohort record, with the
    // reason written at the call site in `persistence.ts`.
    expect(unguarded, 'exactly one runtime write is unguarded, and it is the cohort-side one').toEqual([
      ...UNGUARDABLE,
    ]);

    // And it is unguarded for the structural reason, not by omission:
    // nothing was measured before it, because nothing can be.
    const resolveIndex = events.findIndex((e) => isWrite(e) && e.name === 'resolveCohort');
    const before = resolveIndex <= 0 ? undefined : events[resolveIndex - 1];
    expect(
      before === undefined ? 'none' : before.kind,
      'no measurement precedes the one unguarded call',
    ).not.toBe('measure');
  });

  it('still writes the whole transition, so the invariant is not bought with a refused run', async () => {
    // A wiring assertion passes trivially against a runtime that writes
    // nothing. This is the control: the guarded run completes, its
    // writes are all present in the log, and the transition really
    // landed on disk.
    const { backing, members, cohortId } = await seeded(['idn-ctl'], 'control');
    const events = await runRuntime(backing, cohortId, members);

    const only = members[0];
    if (only === undefined) throw new Error('the control fixture must have one member');
    const reopened = new CohortStateService({ store: backing, now: fixedClock(AFTER_AT) });
    const stored = await reopened.loadIdentity(only.id);
    expect(stored.releaseWindow?.toVersion).toBe(VERSION_AFTER);
    expect(stored.observations.map((o) => o.runId)).toEqual(['run-wiring']);

    expect(writes(events).map((e) => e.name)).toEqual([
      'resolveCohort',
      'openTransition',
      'recordRun',
      'touch',
      'closeTransition',
    ]);
  });
});