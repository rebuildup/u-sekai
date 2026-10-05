/**
 * Synthetic Identity state is kept separate from Cohort membership state.
 *
 * The failure this file guards against is subtle and production-shaped:
 * a re-run of an evaluation resolves a cohort, and somewhere in that path
 * an identity's retained state gets rewritten from a partially-initialised
 * record. Nothing throws; the identity simply comes back subtly different
 * next time, and the release-transition evidence no longer joins.
 *
 * So the assertions here are byte-level. Every identity record is hashed
 * before and after a cohort operation and the hashes are compared. That
 * is stronger than asserting a field or two, and it does not need to know
 * what the fields are.
 */

import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cohortStateKey,
  CohortStateService,
  identityStateKey,
  InMemoryRecordStore,
} from '../../../src/cohort/index.js';
import {
  ENV_STAGING,
  makeIdentity,
  makeLifecycleCohort,
  makeService,
  makeTempDir,
  restart,
} from '../../fixtures/cohort/builders.js';
import { listStoreFiles, recordPath, storeFor } from '../../fixtures/cohort/records.js';

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

/** Hash every stored identity record, keyed by its file path. */
async function hashIdentityRecords(): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  const store = storeFor(dir);
  for (const key of await store.list('identity')) {
    const file = recordPath(dir, 'identity', key);
    const bytes = await fs.readFile(file);
    // Length + content is enough to detect any byte change.
    out.set(file, `${bytes.byteLength}:${bytes.toString('base64')}`);
  }
  return out;
}

describe('cohort operations do not touch identity records', () => {
  it('leaves every identity byte-identical across a resolution', async () => {
    const service = makeService(dir);
    for (const id of ['idn-a', 'idn-b', 'idn-c']) {
      const identity = makeIdentity('persistent', { id, stateRef: `${id}:state` });
      await service.declareIdentity(identity);
      await service.touch(identity.id, '2026-10-01T00:00:00.000Z');
      await service.recordRun(identity.id, {
        environmentId: ENV_STAGING,
        version: '2026.10.1',
        observedAt: '2026-10-01T00:00:00.000Z',
        runId: `run-${id}`,
      });
    }
    const cohort = makeLifecycleCohort('persistent', { id: 'coh-sep' });
    await service.declareCohort(cohort);

    const before = await hashIdentityRecords();
    expect(before.size).toBe(3);

    const resolved = await service.resolveCohort(cohort.id, {
      resolvedAt: '2026-10-02T00:00:00.000Z',
    });
    expect(resolved.membership?.members).toHaveLength(3);

    expect(await hashIdentityRecords()).toEqual(before);
  });

  it('leaves identity records untouched when a cohort is merely declared', async () => {
    const service = makeService(dir);
    const identity = makeIdentity('persistent', { id: 'idn-solo', stateRef: 'solo:state' });
    await service.declareIdentity(identity);

    const before = await hashIdentityRecords();
    await service.declareCohort(makeLifecycleCohort('persistent', { id: 'coh-decl' }));
    expect(await hashIdentityRecords()).toEqual(before);
  });

  it('writes cohort state to a different key namespace from identity state', async () => {
    const service = makeService(dir);
    const identity = makeIdentity('persistent', { id: 'idn-ns', stateRef: 'ns:state' });
    await service.declareIdentity(identity);
    const cohort = makeLifecycleCohort('persistent', { id: 'coh-ns' });
    await service.declareCohort(cohort);

    expect(identityStateKey(identity.id)).not.toBe(cohortStateKey(cohort.id));
    expect(await storeFor(dir).list('identity')).toEqual([identityStateKey(identity.id)]);
    expect(await storeFor(dir).list('cohort')).toEqual([cohortStateKey(cohort.id)]);
  });
});

describe('re-running an evaluation does not corrupt existing identities', () => {
  it('accumulates runs without disturbing retained state', async () => {
    const service = makeService(dir);
    const identity = makeIdentity('persistent', { id: 'idn-rerun', stateRef: 'rerun:state' });
    await service.declareIdentity(identity);
    await service.touch(identity.id, '2026-10-01T00:00:00.000Z');

    const before = await service.loadIdentity(identity.id);
    const interactionsBefore = before.retainedState?.interactionCount;

    for (let i = 0; i < 3; i++) {
      await makeService(dir).recordRun(identity.id, {
        environmentId: ENV_STAGING,
        version: `2026.10.${i}`,
        observedAt: `2026-10-0${i + 2}T00:00:00.000Z`,
        runId: `run-re-${i}`,
      });
    }

    const after = await restart(dir).loadIdentity(identity.id);
    // Re-running observes; it never resets the accumulated state.
    expect(after.retainedState?.interactionCount).toBe(interactionsBefore);
    expect(after.retainedState?.ref).toBe('rerun:state');
    expect(after.observations).toHaveLength(3);
    expect(after.accountRef).toBe(before.accountRef);
  });

  it('re-declaring an existing identity preserves its history', async () => {
    const service = makeService(dir);
    const identity = makeIdentity('persistent', { id: 'idn-redeclare', stateRef: 'redeclare:state' });
    await service.declareIdentity(identity);
    await service.touch(identity.id, '2026-10-01T00:00:00.000Z');
    await service.recordRun(identity.id, {
      environmentId: ENV_STAGING,
      version: '2026.10.1',
      observedAt: '2026-10-01T00:00:00.000Z',
      runId: 'run-1',
    });

    // A configuration reload declares the same identity again.
    const reloaded = await makeService(dir).declareIdentity(identity);
    expect(reloaded.retainedState?.interactionCount).toBe(1);
    expect(reloaded.observations).toHaveLength(1);
  });

  it('a full release transition leaves the identity in a clean, well-formed state', async () => {
    const service = makeService(dir);
    const identity = makeIdentity('release', { id: 'idn-full', stateRef: 'full:state' });
    await service.declareIdentity(identity);

    await service.openTransition(identity.id, { fromVersion: '2026.10.0' });
    await service.touch(identity.id, '2026-10-01T00:00:00.000Z');
    await service.recordRun(identity.id, {
      environmentId: ENV_STAGING,
      version: '2026.10.0',
      observedAt: '2026-10-01T00:00:00.000Z',
      runId: 'run-before',
    });
    // Second run of the transition sees the retained state.
    const during = await restart(dir).loadIdentity(identity.id);
    expect(during.retainedState).toBeDefined();

    await service.recordRun(identity.id, {
      environmentId: ENV_STAGING,
      version: '2026.11.0',
      observedAt: '2026-11-01T00:00:00.000Z',
      runId: 'run-after',
    });
    const closed = await service.closeTransition(identity.id, { toVersion: '2026.11.0' });

    expect(closed.retainedState).toBeUndefined();
    expect(closed.releaseWindow?.toVersion).toBe('2026.11.0');
    // Both runs are on record, which is what makes the comparison joinable.
    expect(closed.observations.map((o) => o.runId)).toEqual(['run-before', 'run-after']);

    const reloaded = await restart(dir).loadIdentity(identity.id);
    expect(reloaded.identity.id).toBe('idn-full');
    expect(reloaded.observations).toHaveLength(2);
  });
});

describe('concurrent writers are detected rather than silently clobbering', () => {
  it('refuses a write whose expected revision is stale', async () => {
    const service = makeService(dir);
    const identity = makeIdentity('persistent', { id: 'idn-cas', stateRef: 'cas:state' });
    await service.declareIdentity(identity);

    const firstRevision = 1;
    await service.touch(identity.id, '2026-10-01T00:00:00.000Z');

    // A second writer still holding the original revision.
    await expect(
      service.touch(identity.id, '2026-10-02T00:00:00.000Z', {
        expectedRevision: firstRevision,
      }),
    ).rejects.toThrow(/is at revision 2, not the expected 1/);
  });
});

describe('the in-memory store implements the same contract', () => {
  it('round-trips through the same service', async () => {
    const store = new InMemoryRecordStore();
    const memService = new CohortStateService({ store });
    const identity = makeIdentity('persistent', { id: 'idn-mem', stateRef: 'mem:state' });
    await memService.declareIdentity(identity);
    const loaded = await memService.loadIdentity(identity.id);

    expect(loaded.identity.id).toBe('idn-mem');
    expect(await store.list('identity')).toEqual([identityStateKey(identity.id)]);
  });

  it('reports an empty listing for a fresh directory', async () => {
    expect(await listStoreFiles(dir)).toEqual([]);
  });
});
