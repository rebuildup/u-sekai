/**
 * The base contract's `SyntheticIdentity` is a discriminated union on
 * `lifecycle`, so narrowing on `lifecycle` makes
 * `capability.stateRetention` a **literal** type rather than the general
 * `StateRetention` union.
 *
 * That is invisible to `tsc` in the dangerous direction. A comparison
 * that was a real runtime decision can become a compile-time constant
 * after narrowing — `if (id.lifecycle === 'ephemeral') { id.capability.stateRetention === 'none' }`
 * is `true` by the type system alone, so the inner branch is dead and no
 * compiler will say so. Since persistence is this ticket's whole
 * deliverable, "it typechecks" is not a sufficient claim about the
 * persisted bytes.
 *
 * This file settles the question at both levels:
 *
 * - **Type level.** Assert that narrowing really does collapse
 *   `stateRetention` to a literal, and that the single production read
 *   site deliberately reads it *un-narrowed* and therefore keeps the
 *   general type.
 * - **Runtime level.** Drive all three lifecycles through a real
 *   write/read cycle, assert the reconstructed identity is equal, and
 *   assert the invariant branch discriminates for each lifecycle.
 */

import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { identityStateKey, parseIdentityState, FileRecordStore } from '../../../src/cohort/index.js';
import { parseSyntheticCohort, ProductDomainError } from '../../../src/product/index.js';
import type {
  IdentityLifecycle,
  StateRetention,
  SyntheticIdentity,
} from '../../../src/product/index.js';
import {
  makeIdentity,
  makeService,
  makeTempDir,
  restart,
} from '../../fixtures/cohort/builders.js';
import { readRawRecord, recordPath } from '../../fixtures/cohort/records.js';

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

/* -------------------------------------------------------------------------- */
/* Type level                                                                  */
/* -------------------------------------------------------------------------- */

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type EphemeralRetention = Extract<SyntheticIdentity, { lifecycle: 'ephemeral' }>['capability']['stateRetention'];
type ReleaseRetention = Extract<SyntheticIdentity, { lifecycle: 'release' }>['capability']['stateRetention'];
type PersistentRetention = Extract<SyntheticIdentity, { lifecycle: 'persistent' }>['capability']['stateRetention'];

/** Narrowing on the discriminant does collapse retention to a literal. */
const narrowedEphemeralIsNone: Expect<Equal<EphemeralRetention, 'none'>> = true;
const narrowedPersistentIsDurable: Expect<Equal<PersistentRetention, 'durable'>> = true;
/** `session | durable` can never be `none`, so it is not assignable to it. */
const narrowedReleaseExcludesNone: Expect<Equal<Extract<ReleaseRetention, 'none'>, never>> = true;

/**
 * Read *without* narrowing — the way `assertLifecycleConsistent`
 * (`src/cohort/identity.ts`) does.
 *
 * This must stay the general union. If a future edit narrowed to one
 * lifecycle before that read, the `=== 'none'` comparison would silently
 * become a constant and the `invalid_transition` guard would stop firing
 * for the other two lifecycles. The assertion below is the tripwire.
 */
const unNarrowedRetentionIsGeneral: Expect<
  Equal<SyntheticIdentity['capability']['stateRetention'], StateRetention>
> = true;

describe('the union is engaged, and the one production read is deliberately un-narrowed', () => {
  it('collapses stateRetention to a literal when narrowed', () => {
    expect(narrowedEphemeralIsNone).toBe(true);
    expect(narrowedPersistentIsDurable).toBe(true);
    expect(narrowedReleaseExcludesNone).toBe(true);
  });

  it('keeps the general StateRetention union when read un-narrowed', () => {
    expect(unNarrowedRetentionIsGeneral).toBe(true);
  });

  it('discriminates at runtime across all three lifecycles', () => {
    const observed = (['ephemeral', 'release', 'persistent'] as const).map((lifecycle) => {
      const identity = buildIdentity(lifecycle);
      return {
        lifecycle: identity.lifecycle,
        retention: identity.capability.stateRetention,
        isNone: identity.capability.stateRetention === 'none',
      };
    });

    expect(observed).toEqual([
      { lifecycle: 'ephemeral', retention: 'none', isNone: true },
      { lifecycle: 'release', retention: 'durable', isNone: false },
      { lifecycle: 'persistent', retention: 'durable', isNone: false },
    ]);
    // A genuine three-way decision, so the guard that depends on it
    // cannot have been constant-folded away.
    expect(new Set(observed.map((o) => o.isNone)).size).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Runtime: round-trip under the new contract                                  */
/* -------------------------------------------------------------------------- */

const ALL_LIFECYCLES: ReadonlyArray<IdentityLifecycle> = ['ephemeral', 'release', 'persistent'];

function buildIdentity(lifecycle: IdentityLifecycle): SyntheticIdentity {
  return lifecycle === 'ephemeral'
    ? makeIdentity('ephemeral', { id: `idn-rt-${lifecycle}` })
    : makeIdentity(lifecycle, {
        id: `idn-rt-${lifecycle}`,
        stateRef: `rt:${lifecycle}:state`,
        persona: `A ${lifecycle} identity used for the round-trip check.`,
        permittedOrigins: ['https://staging.example', 'https://beta.example'],
        maxConcurrentSessions: 2,
      });
}

describe('an identity round-trips through the store under the union contract', () => {
  for (const lifecycle of ALL_LIFECYCLES) {
    it(`reconstructs an equal ${lifecycle} identity from disk`, async () => {
      const original = buildIdentity(lifecycle);
      await makeService(dir).declareIdentity(original);

      const reloaded = await restart(dir).loadIdentity(original.id);

      // Deep equality of the whole reconstructed identity, not just the
      // fields this package happens to read.
      expect(reloaded.identity).toEqual(original);
      expect(reloaded.identity.lifecycle).toBe(original.lifecycle);
      expect(reloaded.identity.capability.stateRetention).toBe(
        original.capability.stateRetention,
      );
      expect(Object.isFrozen(reloaded.identity)).toBe(true);
    });

    it(`persists the exact retention for a ${lifecycle} identity on disk`, async () => {
      const original = buildIdentity(lifecycle);
      await makeService(dir).declareIdentity(original);

      const raw = await readRawRecord(dir, 'identity', identityStateKey(original.id));
      const envelope = JSON.parse(raw) as {
        payload: { lifecycle: string; capability: { stateRetention: string } };
      };

      expect(envelope.payload.lifecycle).toBe(lifecycle);
      expect(envelope.payload.capability.stateRetention).toBe(
        original.capability.stateRetention,
      );
      // A plain string on disk, so a later release re-enters the union
      // through #57's parser rather than trusting a stored type tag.
      expect(typeof envelope.payload.capability.stateRetention).toBe('string');
    });
  }

  it('keeps all three lifecycles independent through one store', async () => {
    const service = makeService(dir);
    for (const lifecycle of ALL_LIFECYCLES) {
      await service.declareIdentity(buildIdentity(lifecycle));
    }

    const reloaded = await restart(dir).loadAllIdentities();
    expect(reloaded).toHaveLength(3);
    expect(
      reloaded.map((s) => [s.identity.lifecycle, s.identity.capability.stateRetention]),
    ).toEqual([
      ['ephemeral', 'none'],
      ['persistent', 'durable'],
      ['release', 'durable'],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Runtime: the invariant branch is live for every lifecycle                   */
/* -------------------------------------------------------------------------- */

/** A stored-payload shape for `lifecycle`, optionally carrying retained state. */
function payloadFor(
  lifecycle: IdentityLifecycle,
  withRetainedState: boolean,
): Record<string, unknown> {
  const identity = buildIdentity(lifecycle);
  const base: Record<string, unknown> = { ...identity, observations: [] };
  if (withRetainedState) {
    base['retainedState'] = {
      ref: `rt:${lifecycle}:state`,
      interactionCount: 1,
      firstObservedAt: '2026-10-01T00:00:00.000Z',
      lastObservedAt: '2026-10-01T00:00:00.000Z',
    };
  }
  return base;
}

describe('the retainedState guard fires for the right lifecycle', () => {
  it('rejects retained state on an ephemeral identity', () => {
    expect(() => parseIdentityState(payloadFor('ephemeral', true))).toThrow(
      /retains no state, so retainedState must be absent/,
    );
  });

  it('accepts retained state on a release identity', () => {
    expect(parseIdentityState(payloadFor('release', true)).retainedState?.interactionCount).toBe(1);
  });

  it('accepts retained state on a persistent identity', () => {
    expect(parseIdentityState(payloadFor('persistent', true)).retainedState?.interactionCount).toBe(1);
  });

  it('accepts a retained identity that holds no retained state', () => {
    for (const lifecycle of ['release', 'persistent'] as const) {
      expect(parseIdentityState(payloadFor(lifecycle, false)).retainedState).toBeUndefined();
    }
  });

  it('rejects retained state that references a state the identity may not hold', () => {
    const identity = buildIdentity('persistent');
    const payload: Record<string, unknown> = { ...identity, observations: [] };
    // Removing stateRef makes the record self-contradictory: #57 requires
    // it when retention is not `none`, and this package requires
    // retainedState.ref to agree with it.
    delete payload['stateRef'];
    payload['retainedState'] = {
      ref: 'orphan:state',
      interactionCount: 1,
      firstObservedAt: '2026-10-01T00:00:00.000Z',
      lastObservedAt: '2026-10-01T00:00:00.000Z',
    };
    expect(() => parseIdentityState(payload)).toThrow(ProductDomainError);
  });
});

/* -------------------------------------------------------------------------- */
/* The byte-level separation assertion, on the merged base                     */
/* -------------------------------------------------------------------------- */

describe('cohort resolution still leaves identity bytes untouched', () => {
  it('hashes every identity record before and after a resolution', async () => {
    const service = makeService(dir);
    for (const lifecycle of ALL_LIFECYCLES) {
      await service.declareIdentity(buildIdentity(lifecycle));
    }
    const cohort = parseSyntheticCohort({
      id: 'coh-union',
      productId: 'prd-task-tracker',
      name: 'Mixed-lifecycle cohort',
      membership: { kind: 'byLifecycle', lifecycle: 'persistent' },
    });
    await service.declareCohort(cohort);

    const store = new FileRecordStore({ rootDir: dir });
    const snapshot = async (): Promise<ReadonlyMap<string, string>> => {
      const out = new Map<string, string>();
      for (const key of await store.list('identity')) {
        const bytes = await fs.readFile(recordPath(dir, 'identity', key));
        out.set(key, `${bytes.byteLength}:${bytes.toString('base64')}`);
      }
      return out;
    };

    const before = await snapshot();
    expect(before.size).toBe(3);

    const resolved = await service.resolveCohort(cohort.id, {
      resolvedAt: '2026-10-02T00:00:00.000Z',
    });
    expect(resolved.membership?.members).toEqual(['idn-rt-persistent']);

    expect(await snapshot()).toEqual(before);
  });
});
