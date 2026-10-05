/**
 * Cohort membership resolution and reproducibility.
 *
 * The property under test is that a cohort is a *derivation*, not a
 * hand-maintained list: the same persisted definition plus the same
 * stored identities must always yield the same members, and a definition
 * that drifted without a re-resolution is detected rather than quietly
 * producing a different population.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cohortStateKey, resolveMembership } from '../../../src/cohort/index.js';
import type { SyntheticIdentityId } from '../../../src/product/index.js';
import {
  asCohortId,
  asProductId,
  makeExplicitCohort,
  makeIdentity,
  makeLifecycleCohort,
  makeService,
  makeSizeTargetCohort,
  makeTempDir,
  restart,
} from '../../fixtures/cohort/builders.js';
import { patchRecord, readRawRecord } from '../../fixtures/cohort/records.js';

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

/** Declare a set of persistent identities and return their branded ids. */
async function seedPersistent(
  count: number,
  prefix = 'idn-p',
): Promise<ReadonlyArray<SyntheticIdentityId>> {
  const service = makeService(dir);
  const ids: SyntheticIdentityId[] = [];
  for (let i = 0; i < count; i++) {
    const declared = makeIdentity('persistent', {
      id: `${prefix}${i + 1}`,
      stateRef: `${prefix}${i + 1}:state`,
    });
    await service.declareIdentity(declared);
    ids.push(declared.id);
  }
  return ids;
}

describe('membership rules', () => {
  it('resolves an explicit rule to exactly the named identities', async () => {
    const ids = await seedPersistent(3);
    const service = makeService(dir);
    const cohort = makeExplicitCohort([ids[2]!, ids[0]!], { id: 'coh-pick' });
    await service.declareCohort(cohort);

    const resolved = await service.resolveCohort(cohort.id, {
      resolvedAt: '2026-10-01T00:00:00.000Z',
    });
    expect(resolved.membership?.members).toEqual([ids[0], ids[2]]);
  });

  it('resolves a lifecycle rule to every identity of that lifecycle, ascending', async () => {
    const service = makeService(dir);
    await service.declareIdentity(makeIdentity('persistent', { id: 'idn-z', stateRef: 'z:state' }));
    await service.declareIdentity(makeIdentity('persistent', { id: 'idn-a', stateRef: 'a:state' }));
    await service.declareIdentity(makeIdentity('release', { id: 'idn-r', stateRef: 'r:state' }));

    const cohort = makeLifecycleCohort('persistent', { id: 'coh-all-persistent' });
    await service.declareCohort(cohort);
    const resolved = await service.resolveCohort(cohort.id, { resolvedAt: '2026-10-01T00:00:00.000Z' });

    expect(resolved.membership?.members).toEqual(['idn-a', 'idn-z']);
  });

  it('resolves a size target deterministically, independent of declaration order', async () => {
    await seedPersistent(5);
    const service = makeService(dir);
    const cohort = makeSizeTargetCohort('persistent', 3, { id: 'coh-top3' });
    await service.declareCohort(cohort);

    const first = await service.resolveCohort(cohort.id, { resolvedAt: '2026-10-01T00:00:00.000Z' });
    const second = await restart(dir).resolveCohort(cohort.id, {
      resolvedAt: '2026-10-02T00:00:00.000Z',
    });

    expect(first.membership?.members).toEqual(['idn-p1', 'idn-p2', 'idn-p3']);
    expect(second.membership?.members).toEqual(first.membership?.members);
  });

  it('refuses a size target it cannot meet', async () => {
    await seedPersistent(2);
    const service = makeService(dir);
    const cohort = makeSizeTargetCohort('persistent', 5, { id: 'coh-too-big' });
    await service.declareCohort(cohort);

    await expect(
      service.resolveCohort(cohort.id, { resolvedAt: '2026-10-01T00:00:00.000Z' }),
    ).rejects.toThrow(/targets 5 "persistent" identities but only 2 are available/);
  });

  it('returns a short cohort only when the caller explicitly opts in', async () => {
    await seedPersistent(2);
    const service = makeService(dir);
    const cohort = makeSizeTargetCohort('persistent', 5, { id: 'coh-best-effort' });
    await service.declareCohort(cohort);

    const resolved = await service.resolveCohort(
      cohort.id,
      { resolvedAt: '2026-10-01T00:00:00.000Z', requireFullSizeTarget: false },
    );
    expect(resolved.membership?.members).toHaveLength(2);
  });

  it('refuses an explicit rule naming an identity that does not exist', async () => {
    const service = makeService(dir);
    await service.declareIdentity(makeIdentity('persistent', { id: 'idn-real', stateRef: 'r:state' }));
    const cohort = makeExplicitCohort(['idn-real', 'idn-phantom']);
    await service.declareCohort(cohort);

    await expect(
      service.resolveCohort(cohort.id, { resolvedAt: '2026-10-01T00:00:00.000Z' }),
    ).rejects.toThrow(/names identity idn-phantom, which is not in this store/);
  });

  it('excludes a retired identity and reports why', async () => {
    const ids = await seedPersistent(2);
    const service = makeService(dir);
    await service.retireIdentity(ids[1]!, { at: '2026-10-01T00:00:00.000Z' });

    const cohort = makeLifecycleCohort('persistent', { id: 'coh-with-retired' });
    await service.declareCohort(cohort);
    const resolved = await service.resolveCohort(cohort.id, { resolvedAt: '2026-10-01T00:00:00.000Z' });

    expect(resolved.membership?.members).toEqual([ids[0]]);
    expect(resolved.membership?.excluded).toEqual([{ identityId: ids[1]!, reason: 'retired' }]);
  });

  it('reloads the excluded list rather than presenting a retired member as a member', async () => {
    const ids = await seedPersistent(2);
    const service = makeService(dir);
    await service.retireIdentity(ids[1]!, { at: '2026-10-01T00:00:00.000Z' });
    const cohort = makeLifecycleCohort('persistent', { id: 'coh-excluded-round-trip' });
    await service.declareCohort(cohort);
    await service.resolveCohort(cohort.id, { resolvedAt: '2026-10-01T00:00:00.000Z' });

    const reloaded = await restart(dir).loadCohort(cohort.id);
    expect(reloaded.membership?.members).toEqual([ids[0]]);
    expect(reloaded.membership?.excluded).toEqual([{ identityId: ids[1]!, reason: 'retired' }]);
  });
});

describe('a cohort is reproducible from its persisted definition', () => {
  it('resolves identically after a process restart', async () => {
    const ids = await seedPersistent(4);
    const service = makeService(dir);
    const cohort = makeLifecycleCohort('persistent', { id: 'coh-repro' });
    await service.declareCohort(cohort);
    const before = await service.resolveCohort(cohort.id, { resolvedAt: '2026-10-01T00:00:00.000Z' });

    const after = await restart(dir).resolveCohort(cohort.id, {
      resolvedAt: '2026-10-05T00:00:00.000Z',
    });

    expect(after.membership?.members).toEqual(before.membership?.members);
    expect(after.membership?.members).toEqual(ids);
    expect(after.definitionDigest).toBe(before.definitionDigest);
  });

  it('produces the same digest for the same definition regardless of key order', async () => {
    const service = makeService(dir);
    const cohort = makeLifecycleCohort('persistent', { id: 'coh-digest' });
    const declared = await service.declareCohort(cohort);
    const key = cohortStateKey(cohort.id);

    const stored = JSON.parse(await readRawRecord(dir, 'cohort', key)) as {
      payload: { cohort: Record<string, unknown> };
    };

    // Re-emit the cohort with its keys in the opposite order. The digest
    // is computed over canonical JSON, so this must not look like
    // tampering.
    const reordered: Record<string, unknown> = {};
    for (const k of [...Object.keys(stored.payload.cohort)].reverse()) {
      reordered[k] = stored.payload.cohort[k];
    }
    await patchRecord(dir, 'cohort', key, (record) => {
      const payload = { ...(record['payload'] as Record<string, unknown>) };
      payload['cohort'] = reordered;
      return { ...record, payload };
    });

    const reloaded = await restart(dir).loadCohort(cohort.id);
    expect(reloaded.definitionDigest).toBe(declared.definitionDigest);
    expect(reloaded.cohort.id).toBe('coh-digest');
  });

  it('detects a definition edited without re-resolving', async () => {
    await seedPersistent(2);
    const service = makeService(dir);
    const cohort = makeLifecycleCohort('persistent', { id: 'coh-tampered' });
    await service.declareCohort(cohort);
    await service.resolveCohort(cohort.id, { resolvedAt: '2026-10-01T00:00:00.000Z' });

    await patchRecord(dir, 'cohort', cohortStateKey(cohort.id), (record) => {
      const payload = { ...(record['payload'] as Record<string, unknown>) };
      payload['cohort'] = { ...(payload['cohort'] as Record<string, unknown>), name: 'Renamed' };
      return { ...record, payload };
    });

    await expect(restart(dir).loadCohort(cohort.id)).rejects.toThrow(
      /definitionDigest does not match the persisted cohort definition/,
    );
  });

  it('is idempotent when the same cohort is declared twice', async () => {
    await seedPersistent(1);
    const service = makeService(dir);
    const cohort = makeLifecycleCohort('persistent', { id: 'coh-idempotent' });

    const first = await service.declareCohort(cohort);
    const second = await service.declareCohort(cohort);

    expect(second.definitionDigest).toBe(first.definitionDigest);
    expect(await restart(dir).loadAllCohorts()).toHaveLength(1);
  });
});

describe('resolution is a pure function', () => {
  it('does not mutate the identity states handed to it', async () => {
    const service = makeService(dir);
    const identity = makeIdentity('persistent', { id: 'idn-pure-1', stateRef: 'pure:state' });
    await service.declareIdentity(identity);
    await service.touch(identity.id, '2026-10-01T00:00:00.000Z');
    const withState = await service.loadIdentity(identity.id);

    const cohort = makeLifecycleCohort('persistent', { id: 'coh-purity' });
    const declared = await service.declareCohort(cohort);

    const resolved = resolveMembership(declared, [withState], {
      resolvedAt: '2026-10-01T00:00:00.000Z',
    });

    expect(resolved.membership?.members).toEqual(['idn-pure-1']);
    // The input is unchanged and still frozen.
    expect(withState.retainedState?.interactionCount).toBe(1);
    expect(Object.isFrozen(withState)).toBe(true);
    expect(Object.isFrozen(withState.observations)).toBe(true);
  });
});

describe('a cohort from another product is refused', () => {
  it('rejects resolving against a foreign identity', async () => {
    const service = makeService(dir);
    const foreign = makeIdentity('persistent', { id: 'idn-foreign', stateRef: 'f:state' });
    // Same shape, different product.
    const asForeign = { ...foreign, productId: asProductId('prd-other') };
    await service.declareIdentity(asForeign);

    const cohort = makeLifecycleCohort('persistent', { id: 'coh-foreign' });
    const declared = await service.declareCohort(cohort);

    await expect(
      service.resolveCohort(cohort.id, { resolvedAt: '2026-10-01T00:00:00.000Z' }),
    ).rejects.toThrow(/belongs to prd-task-tracker/);
    expect(declared.definitionDigest).toBeTypeOf('string');
  });
});

describe('lookup failures', () => {
  it('raises for a cohort that was never declared', async () => {
    await expect(
      restart(dir).loadCohort(asCohortId('coh-absent')),
    ).rejects.toThrow(/no cohort record for coh-absent/);
  });
});
