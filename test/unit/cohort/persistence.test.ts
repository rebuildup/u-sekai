/**
 * Cross-release persistence: the acceptance criteria that actually
 * distinguish a durable store from a file that happens to be written.
 *
 * The four questions this file exists to answer:
 *
 * 1. Does state come back in a *new process*? (`restart()` builds a new
 *    store and service over the same directory.)
 * 2. Is the key stable across releases, or secretly derived from the run?
 * 3. Does a record survive a schema change, in both directions?
 * 4. Does damaged state fail loudly rather than producing a new identity?
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyMigrationChain,
  CohortStateError,
  DURABLE_RECORD_SCHEMA_VERSION,
  FileRecordStore,
  identityStateKey,
  isCohortStateError,
  parseDurableRecord,
  type RecordMigration,
} from '../../../src/cohort/index.js';
import {
  ACCOUNT_REF,
  ENV_STAGING,
  fixedClock,
  makeIdentity,
  makeService,
  asIdentityId,
  makeTempDir,
  restart,
} from '../../fixtures/cohort/builders.js';
import {
  addPayloadField,
  listStoreFiles,
  readRawRecord,
  recordPath,
  setSchemaVersion,
  storeFor,
  writeRawRecord,
} from '../../fixtures/cohort/records.js';

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

describe('state survives a process-level reload', () => {
  it('returns the same identity id, lifecycle and account reference', async () => {
    const identity = makeIdentity('persistent', { id: 'idn-alice', stateRef: 'alice:state:1' });

    const first = makeService(dir);
    await first.declareIdentity(identity, { accountRef: ACCOUNT_REF });
    await first.recordRun(identity.id, {
      environmentId: ENV_STAGING,
      version: '2026.10.1',
      observedAt: '2026-10-01T00:00:00.000Z',
      runId: 'run-1',
    });

    // A completely fresh store + service over the same bytes on disk.
    const second = restart(dir);
    const reloaded = await second.loadIdentity(identity.id);

    expect(reloaded.identity.id).toBe('idn-alice');
    expect(reloaded.identity.lifecycle).toBe('persistent');
    expect(reloaded.accountRef).toBe(ACCOUNT_REF);
    expect(reloaded.observations).toHaveLength(1);
    expect(reloaded.observations[0]?.runId).toBe('run-1');
    expect(reloaded.observations[0]?.version).toBe('2026.10.1');
  });

  it('reloads through a brand-new FileRecordStore, not a retained one', async () => {
    const identity = makeIdentity('release', { id: 'idn-bob', stateRef: 'bob:state:1' });
    await makeService(dir).declareIdentity(identity);

    // A second store object over the same root, proving nothing is held
    // in memory between the writer and the reader.
    const reader = new FileRecordStore({ rootDir: dir });
    const raw = await reader.read('identity', identityStateKey(identity.id));
    expect(raw).toBeTypeOf('string');

    const reloaded = await restart(dir).loadIdentity(identity.id);
    expect(reloaded.identity.id).toBe('idn-bob');
  });

  it('survives being read by a service with a different clock', async () => {
    const identity = makeIdentity('persistent', { id: 'idn-clock', stateRef: 'clock:state' });
    await makeService(dir, { now: fixedClock('2026-10-01T00:00:00.000Z') }).declareIdentity(identity);

    // A "later release" with a completely different notion of now.
    const later = makeService(dir, { now: fixedClock('2027-03-09T12:00:00.000Z') });
    const reloaded = await later.loadIdentity(identity.id);
    expect(reloaded.identity.id).toBe('idn-clock');
  });
});

describe('the persistence key is stable across releases', () => {
  it('is derived from the declared id alone', () => {
    expect(identityStateKey(asIdentityId('idn-alice'))).toBe('identity:idn-alice');
  });

  it('does not change when runs, instants or revisions accumulate', async () => {
    const identity = makeIdentity('persistent', { id: 'idn-stable', stateRef: 'stable:state' });
    const service = makeService(dir);
    await service.declareIdentity(identity);
    const key = identityStateKey(identity.id);

    const before = await readRawRecord(dir, 'identity', key);
    const beforeEnvelope = JSON.parse(before) as { key: string; revision: number };
    expect(beforeEnvelope.revision).toBe(1);

    for (let i = 0; i < 5; i++) {
      await service.recordRun(identity.id, {
        environmentId: ENV_STAGING,
        version: `2026.10.${i}`,
        observedAt: `2026-10-0${i + 1}T00:00:00.000Z`,
        runId: `run-${i}`,
      });
    }
    await service.touch(identity.id, '2026-10-09T00:00:00.000Z');

    // Same file, even though five runs and many timestamps passed.
    const after = await readRawRecord(dir, 'identity', key);
    expect(after).toBeTypeOf('string');
    expect(recordPath(dir, 'identity', key)).toBe(recordPath(dir, 'identity', key));

    const envelope = JSON.parse(after) as { key: string; revision: number };
    expect(envelope.key).toBe(key);
    expect(envelope.revision).toBeGreaterThan(1);
  });

  it('carries no run id, timestamp or build identifier in the key', async () => {
    const identity = makeIdentity('persistent', { id: 'idn-pure', stateRef: 'pure:state' });
    await makeService(dir).declareIdentity(identity);
    const key = identityStateKey(identity.id);

    // The key is a pure function of the id: the same id produces the same
    // key in every process, forever.
    expect(identityStateKey(asIdentityId('idn-pure'))).toBe(key);
    expect(key).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(key).not.toContain('run-');
  });
});

describe('state survives a schema change', () => {
  it('loads a record carrying a field this build does not know', async () => {
    const identity = makeIdentity('persistent', { id: 'idn-forward', stateRef: 'forward:state' });
    await makeService(dir).declareIdentity(identity);
    const key = identityStateKey(identity.id);

    // Simulate a 0.5.0 that added an attribute to identity records.
    await addPayloadField(dir, 'identity', key, 'lastRewardedAt', '2027-01-01T00:00:00.000Z');

    const reloaded = await restart(dir).loadIdentity(identity.id);
    expect(reloaded.identity.id).toBe('idn-forward');
    expect(reloaded.identity.lifecycle).toBe('persistent');
  });

  it('still enforces known fields when an unknown field is present', async () => {
    const identity = makeIdentity('persistent', { id: 'idn-mixed', stateRef: 'mixed:state' });
    await makeService(dir).declareIdentity(identity);
    const key = identityStateKey(identity.id);

    // Unknown field tolerated...
    await addPayloadField(dir, 'identity', key, 'futureOnly', { anything: true });
    // ...but a *known* field that is corrupt is still an error.
    const text = await readRawRecord(dir, 'identity', key);
    const record = JSON.parse(text) as { payload: Record<string, unknown> };
    record.payload['lifecycle'] = 'eternal';
    await writeRawRecord(dir, 'identity', key, JSON.stringify(record));

    await expect(restart(dir).loadIdentity(identity.id)).rejects.toThrow();
  });

  it('refuses a record written by a newer schema instead of downgrading it', async () => {
    const identity = makeIdentity('persistent', { id: 'idn-future', stateRef: 'future:state' });
    await makeService(dir).declareIdentity(identity);
    const key = identityStateKey(identity.id);
    await setSchemaVersion(dir, 'identity', key, DURABLE_RECORD_SCHEMA_VERSION + 1);

    const error = await restart(dir)
      .loadIdentity(identity.id)
      .catch((e: unknown) => e);
    expect(isCohortStateError(error)).toBe(true);
    expect((error as CohortStateError).code).toBe('unsupported_schema_version');
  });

  it('applies a registered migration chain', () => {
    const migrations: RecordMigration[] = [
      {
        fromVersion: 1,
        toVersion: 2,
        migrate: (payload) => ({ ...payload, introducedInV2: true }),
      },
    ];
    const upgraded = applyMigrationChain({
      storedVersion: 1,
      targetVersion: 2,
      payload: { id: 'idn-alice' },
      kind: 'identity',
      key: 'identity:idn-alice',
      migrations,
    });
    expect(upgraded).toEqual({ id: 'idn-alice', introducedInV2: true });
  });

  it('fails explicitly when a needed migration is not registered', () => {
    expect(() =>
      applyMigrationChain({
        storedVersion: 1,
        targetVersion: 2,
        payload: {},
        kind: 'identity',
        key: 'identity:idn-alice',
        migrations: [],
      }),
    ).toThrow(/no migration registered from schema version 1 to 2/);
  });

  it('fails explicitly on a version newer than the target', () => {
    expect(() =>
      applyMigrationChain({
        storedVersion: 3,
        targetVersion: 1,
        payload: {},
        kind: 'identity',
        key: 'identity:idn-alice',
        migrations: [],
      }),
    ).toThrow(/schema version 3/);
  });

  it('rejects an unmodelled key on the envelope itself', () => {
    expect(() =>
      parseDurableRecord(
        JSON.stringify({
          schemaVersion: 1,
          kind: 'identity',
          key: 'identity:idn-alice',
          revision: 1,
          updatedAt: '2026-10-01T00:00:00.000Z',
          payload: {},
          surprise: true,
        }),
        'identity',
      ),
    ).toThrow(/unknown envelope field/);
  });
});

describe('corrupt or stale state fails explicitly', () => {
  it('raises rather than inventing an identity for one that is absent', async () => {
    const error = await restart(dir)
      .loadIdentity(asIdentityId('idn-nobody'))
      .catch((e: unknown) => e);
    expect(isCohortStateError(error)).toBe(true);
    expect((error as CohortStateError).code).toBe('identity_not_found');
  });

  it('writes nothing when an absent identity is requested', async () => {
    await restart(dir).loadIdentity(asIdentityId('idn-nobody')).catch(() => undefined);
    expect(await listStoreFiles(dir)).toEqual([]);
  });

  it('raises on truncated JSON', async () => {
    const identity = makeIdentity('persistent', { id: 'idn-broken', stateRef: 'broken:state' });
    await makeService(dir).declareIdentity(identity);
    await writeRawRecord(dir, 'identity', identityStateKey(identity.id), '{"schemaVersion":1,');

    const error = await restart(dir)
      .loadIdentity(identity.id)
      .catch((e: unknown) => e);
    expect((error as CohortStateError).code).toBe('corrupt_record');
  });

  it('raises when the stored key disagrees with the filename it was found under', async () => {
    const identity = makeIdentity('persistent', { id: 'idn-swap', stateRef: 'swap:state' });
    await makeService(dir).declareIdentity(identity);

    const key = identityStateKey(identity.id);
    const text = await readRawRecord(dir, 'identity', key);
    const record = JSON.parse(text) as Record<string, unknown>;
    record['key'] = 'identity:idn-someone-else';
    await writeRawRecord(dir, 'identity', key, JSON.stringify(record));

    const error = await restart(dir)
      .loadIdentity(identity.id)
      .catch((e: unknown) => e);
    expect((error as CohortStateError).code).toBe('key_mismatch');
  });

  it('raises when a cohort record is stored under the identity namespace', async () => {
    const identity = makeIdentity('persistent', { id: 'idn-mix', stateRef: 'mix:state' });
    await makeService(dir).declareIdentity(identity);
    const key = identityStateKey(identity.id);
    const text = await readRawRecord(dir, 'identity', key);
    const record = JSON.parse(text) as Record<string, unknown>;
    record['kind'] = 'cohort';
    await writeRawRecord(dir, 'identity', key, JSON.stringify(record));

    const error = await restart(dir)
      .loadIdentity(identity.id)
      .catch((e: unknown) => e);
    expect((error as CohortStateError).code).toBe('key_mismatch');
  });

  it('surfaces a damaged file when listing, rather than hiding the record', async () => {
    const identity = makeIdentity('persistent', { id: 'idn-list', stateRef: 'list:state' });
    await makeService(dir).declareIdentity(identity);
    await writeRawRecord(dir, 'identity', identityStateKey(identity.id), 'not json at all');

    await expect(storeFor(dir).list('identity')).rejects.toThrow(/not valid JSON/);
  });
});

describe('the store does not leak a path out of its root', () => {
  it('keeps a traversal-shaped state reference inside the store directory', async () => {
    // #57's IdentityStateRef grammar allows `/` and `.` after the first
    // alphanumeric character, so this value is a legitimate reference
    // that would escape the root if it were used as a path.
    const hostile = 'a/../../../../tmp/u-sekai-escaped';
    const identity = makeIdentity('persistent', { id: 'idn-traversal', stateRef: hostile });
    await makeService(dir).declareIdentity(identity);

    const key = identityStateKey(identity.id);
    const stored = recordPath(dir, 'identity', key);
    const relative = path.relative(dir, stored);
    expect(relative.startsWith('..')).toBe(false);
    expect(path.isAbsolute(relative)).toBe(false);

    // And nothing was created at the escaped location.
    await expect(fs.stat('/tmp/u-sekai-escaped')).rejects.toThrow();

    // The reference still round-trips: the key is preserved inside the
    // envelope even though the filename is a hash of it.
    const reloaded = await restart(dir).loadIdentity(identity.id);
    expect(reloaded.identity.stateRef).toBe(hostile);
  });

  it('gives distinct files to keys that share a sanitized prefix', async () => {
    const a = makeIdentity('persistent', { id: 'idn-a', stateRef: 'shared/ref' });
    const b = makeIdentity('persistent', { id: 'idn-b', stateRef: 'shared/ref' });
    const service = makeService(dir);
    await service.declareIdentity(a);
    await service.declareIdentity(b);

    expect(recordPath(dir, 'identity', identityStateKey(a.id))).not.toBe(
      recordPath(dir, 'identity', identityStateKey(b.id)),
    );
    expect(await service.loadAllIdentities()).toHaveLength(2);
  });
});
