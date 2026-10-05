/**
 * Lifecycle transitions: what each of #57's three lifecycles may do.
 *
 * ADR-0011's three evaluation modes are only meaningful if the
 * lifecycles are enforced rather than documented, so each block below
 * asserts the *refusal* as well as the happy path — a lifecycle test
 * that never checks that an illegal transition throws proves nothing
 * about the invariant it claims to protect.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isEligibleForRun,
  isRetired,
  parseAccountRef,
  parseIdentityState,
  parseVersionLabel,
  resetRetainedState,
  touchRetainedState,
} from '../../../src/cohort/index.js';
import { ProductDomainError } from '../../../src/product/index.js';
import { listStoreFiles } from '../../fixtures/cohort/records.js';
import {
  ACCOUNT_REF,
  ENV_STAGING,
  makeIdentity,
  makeService,
  makeTempDir,
  restart,
} from '../../fixtures/cohort/builders.js';

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

describe('ephemeral identities reset cleanly', () => {
  it('holds no state and resets to the same value idempotently', async () => {
    const identity = makeIdentity('ephemeral', { id: 'idn-ephemeral' });
    const service = makeService(dir);
    const declared = await service.declareIdentity(identity);

    expect(declared.retainedState).toBeUndefined();
    expect(declared.identity.stateRef).toBeUndefined();

    const once = resetRetainedState(declared);
    const twice = resetRetainedState(once);
    const thrice = resetRetainedState(twice);

    expect(once.retainedState).toBeUndefined();
    expect(twice).toEqual(once);
    expect(thrice).toEqual(once);
    expect(thrice.identity.id).toBe('idn-ephemeral');
  });

  it('is still clean after a process restart', async () => {
    const identity = makeIdentity('ephemeral', { id: 'idn-ephemeral2' });
    await makeService(dir).declareIdentity(identity);

    const reloaded = await restart(dir).loadIdentity(identity.id);
    const afterReset = await makeService(dir).resetIdentity(identity.id);

    expect(reloaded.retainedState).toBeUndefined();
    expect(afterReset.retainedState).toBeUndefined();
    expect(afterReset.identity.id).toBe('idn-ephemeral2');
  });

  it('refuses to accumulate state', async () => {
    const identity = makeIdentity('ephemeral', { id: 'idn-ephemeral3' });
    const declared = await makeService(dir).declareIdentity(identity);
    expect(() => touchRetainedState(declared, { at: '2026-10-01T00:00:00.000Z' })).toThrow(
      /retains no state/,
    );
  });

  it('rejects a stored record that claims otherwise', async () => {
    const identity = makeIdentity('persistent', { id: 'idn-legit', stateRef: 'legit:state' });
    const declared = await makeService(dir).declareIdentity(identity);
    const withState = touchRetainedState(declared, { at: '2026-10-01T00:00:00.000Z' });

    // Re-file a state-carrying record under an ephemeral identity.
    const forged = { ...withState, identity: makeIdentity('ephemeral', { id: 'idn-legit' }) };
    expect(() => parseIdentityState(serializeForTest(forged))).toThrow(
      /retains no state, so retainedState must be absent/,
    );
  });
});

describe('release identities retain state across exactly one transition', () => {
  const versionA = '2026.10.0';
  const versionB = '2026.11.0';

  it('carries state from the first run of the window into the second', async () => {
    const identity = makeIdentity('release', { id: 'idn-rel', stateRef: 'rel:state:2026-10' });
    const service = makeService(dir);
    await service.declareIdentity(identity);

    await service.openTransition(identity.id, { fromVersion: versionA, openedAt: '2026-10-01T00:00:00.000Z' });
    await service.touch(identity.id, '2026-10-01T00:00:00.000Z');
    await service.touch(identity.id, '2026-10-01T05:00:00.000Z');

    // A separate process sees the same retained state: this is the whole
    // point of a release-scoped identity.
    const midway = await restart(dir).loadIdentity(identity.id);
    expect(midway.retainedState).toBeDefined();
    expect(midway.retainedState?.interactionCount).toBe(2);
    expect(midway.retainedState?.ref).toBe('rel:state:2026-10');
  });

  it('drops the state once the window closes, keeping the lineage', async () => {
    const identity = makeIdentity('release', { id: 'idn-rel2', stateRef: 'rel:state:2026-10' });
    const service = makeService(dir);
    await service.declareIdentity(identity);
    await service.openTransition(identity.id, { fromVersion: versionA });
    await service.touch(identity.id, '2026-10-01T00:00:00.000Z');
    await service.recordRun(identity.id, {
      environmentId: ENV_STAGING,
      version: versionA,
      observedAt: '2026-10-01T00:00:00.000Z',
      runId: 'run-a',
    });

    const closed = await service.closeTransition(identity.id, { toVersion: versionB });
    expect(closed.retainedState).toBeUndefined();
    expect(closed.releaseWindow?.toVersion).toBe(versionB);
    expect(closed.releaseWindow?.closedAt).toBeDefined();
    // The record of *which* identities carried state survives.
    expect(closed.observations).toHaveLength(1);

    const reloaded = await restart(dir).loadIdentity(identity.id);
    expect(reloaded.retainedState).toBeUndefined();
    expect(reloaded.releaseWindow?.toVersion).toBe(versionB);
  });

  it('refuses a second window and a second close', async () => {
    const identity = makeIdentity('release', { id: 'idn-rel3', stateRef: 'rel:state' });
    const service = makeService(dir);
    await service.declareIdentity(identity);
    await service.openTransition(identity.id, { fromVersion: versionA });
    await service.closeTransition(identity.id, { toVersion: versionB });

    await expect(service.openTransition(identity.id, { fromVersion: '2027.1.0' })).rejects.toThrow(
      /already has a transition window/,
    );
    await expect(service.closeTransition(identity.id, { toVersion: '2027.2.0' })).rejects.toThrow(
      /already closed/,
    );
  });

  it('refuses to close a window that was never opened', async () => {
    const identity = makeIdentity('release', { id: 'idn-rel4', stateRef: 'rel:state' });
    const service = makeService(dir);
    await service.declareIdentity(identity);
    await expect(service.closeTransition(identity.id, { toVersion: versionB })).rejects.toThrow(
      /no open transition window/,
    );
  });

  it('refuses a window on a non-release identity', async () => {
    const identity = makeIdentity('persistent', { id: 'idn-rel5', stateRef: 'rel:state' });
    const service = makeService(dir);
    await service.declareIdentity(identity);
    await expect(service.openTransition(identity.id, { fromVersion: versionA })).rejects.toThrow(
      /only a "release" identity/,
    );
  });
});

describe('persistent identities survive many runs and restarts', () => {
  it('accumulates state and history across five runs and five processes', async () => {
    const identity = makeIdentity('persistent', { id: 'idn-pers', stateRef: 'pers:state' });
    await makeService(dir).declareIdentity(identity);

    for (let i = 0; i < 5; i++) {
      const service = restart(dir);
      await service.touch(identity.id, `2026-10-0${i + 1}T00:00:00.000Z`);
      await service.recordRun(identity.id, {
        environmentId: ENV_STAGING,
        version: `2026.10.${i}`,
        observedAt: `2026-10-0${i + 1}T00:00:00.000Z`,
        runId: `run-${i}`,
      });
    }

    const final = await restart(dir).loadIdentity(identity.id);
    expect(final.retainedState?.interactionCount).toBe(5);
    expect(final.observations).toHaveLength(5);
    expect(final.identity.id).toBe('idn-pers');
  });

  it('keeps the account reference and history through a reset', async () => {
    const identity = makeIdentity('persistent', { id: 'idn-pers2', stateRef: 'pers:state' });
    const service = makeService(dir);
    await service.declareIdentity(identity, { accountRef: ACCOUNT_REF });
    await service.touch(identity.id, '2026-10-01T00:00:00.000Z');
    await service.recordRun(identity.id, {
      environmentId: ENV_STAGING,
      version: '2026.10.1',
      observedAt: '2026-10-01T00:00:00.000Z',
      runId: 'run-1',
    });

    const afterReset = await restart(dir).resetIdentity(identity.id);
    expect(afterReset.retainedState).toBeUndefined();
    expect(afterReset.accountRef).toBe(ACCOUNT_REF);
    expect(afterReset.observations).toHaveLength(1);
  });
});

describe('retirement', () => {
  it('withdraws an identity while keeping its lineage', async () => {
    const identity = makeIdentity('persistent', { id: 'idn-ret', stateRef: 'ret:state' });
    const service = makeService(dir);
    await service.declareIdentity(identity);
    await service.touch(identity.id, '2026-10-01T00:00:00.000Z');

    const retired = await service.retireIdentity(identity.id, { at: '2026-10-02T00:00:00.000Z' });
    expect(retired.retiredAt).toBe('2026-10-02T00:00:00.000Z');
    expect(isRetired(retired)).toBe(true);
    expect(isEligibleForRun(retired)).toBe(false);
    expect(retired.observations).toHaveLength(0);

    const reloaded = await restart(dir).loadIdentity(identity.id);
    expect(isRetired(reloaded)).toBe(true);
  });

  it('refuses to observe or reset a retired identity', async () => {
    const identity = makeIdentity('persistent', { id: 'idn-ret2', stateRef: 'ret:state' });
    const service = makeService(dir);
    await service.declareIdentity(identity);
    await service.retireIdentity(identity.id, { at: '2026-10-02T00:00:00.000Z' });

    await expect(
      service.recordRun(identity.id, {
        environmentId: ENV_STAGING,
        version: '1.0.0',
        observedAt: '2026-10-03T00:00:00.000Z',
        runId: 'run-after-retire',
      }),
    ).rejects.toThrow(/retired identity cannot be observed/);

    await expect(service.resetIdentity(identity.id)).rejects.toThrow(/cannot be reset/);
  });

  it('is idempotent', async () => {
    const identity = makeIdentity('persistent', { id: 'idn-ret3', stateRef: 'ret:state' });
    const service = makeService(dir);
    await service.declareIdentity(identity);
    const first = await service.retireIdentity(identity.id, { at: '2026-10-02T00:00:00.000Z' });
    const second = await service.retireIdentity(identity.id, { at: '2026-10-09T00:00:00.000Z' });
    expect(second.retiredAt).toBe(first.retiredAt);
  });
});

describe('re-running an observation does not duplicate history', () => {
  it('replaces the same run rather than appending it twice', async () => {
    const identity = makeIdentity('persistent', { id: 'idn-dedupe', stateRef: 'dedupe:state' });
    const service = makeService(dir);
    await service.declareIdentity(identity);

    const observation = {
      environmentId: ENV_STAGING,
      version: '2026.10.1',
      observedAt: '2026-10-01T00:00:00.000Z',
      runId: 'run-same',
    };
    await service.recordRun(identity.id, observation);
    await service.recordRun(identity.id, observation);
    await service.recordRun(identity.id, { ...observation, observedAt: '2026-10-01T09:00:00.000Z' });

    const reloaded = await restart(dir).loadIdentity(identity.id);
    expect(reloaded.observations).toHaveLength(1);
    expect(reloaded.observations[0]?.observedAt).toBe('2026-10-01T09:00:00.000Z');
  });
});

describe('raw secrets are not persistable', () => {
  /**
   * Includes bare lowercase passwords on purpose. A charset-only rule
   * accepts `hunter2`, which is why the grammar is structural: a valid
   * reference must name a declared kind.
   */
  const CREDENTIALS = [
    'sk-ant-api03-REALLOOKINGKEY-0123456789',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'AKIAIOSFODNN7EXAMPLE',
    'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop',
    'dXNlcjpwYXNzd29yZA==',
    'CorrectHorseBatteryStaple',
    'hunter2',
    'password123',
    'letmein',
    'user@example.com',
    // Lowercase and hyphenated, but not a declared reference kind.
    'sk-ant-api03-key',
    'password-123',
    'secret-token-value',
  ];

  for (const credential of CREDENTIALS) {
    it(`rejects ${credential.slice(0, 20)}… as an account reference`, () => {
      expect(() => parseAccountRef(credential)).toThrow(ProductDomainError);
    });
  }

  it('accepts a namespaced handle of a declared kind', () => {
    expect(parseAccountRef('acct-alice-primary')).toBe('acct-alice-primary');
    expect(parseAccountRef('world-seed-42')).toBe('world-seed-42');
    expect(parseAccountRef('fixture-checkout')).toBe('fixture-checkout');
  });

  it('names the offending kind in the error so the mistake is obvious', () => {
    expect(() => parseAccountRef('sk-ant-key')).toThrow(/"sk" is not one/);
  });

  it('keeps a stored account reference within the allowed character set', async () => {
    const identity = makeIdentity('persistent', { id: 'idn-secret', stateRef: 'secret:state' });
    await makeService(dir).declareIdentity(identity, { accountRef: ACCOUNT_REF });

    const reloaded = await restart(dir).loadIdentity(identity.id);
    expect(reloaded.accountRef).toBe(ACCOUNT_REF);
    expect(reloaded.accountRef).toMatch(/^[a-z0-9-]+$/);
  });

  it('never writes a rejected credential to disk', async () => {
    const identity = makeIdentity('persistent', { id: 'idn-nodisk', stateRef: 'nodisk:state' });
    await expect(
      makeService(dir).declareIdentity(identity, { accountRef: 'hunter2' as never }),
    ).rejects.toThrow(ProductDomainError);
    // The write path validates before storing, so nothing at all reached disk.
    expect(await listStoreFiles(dir)).toEqual([]);
  });
});

describe('retention is lifecycle-dependent and is treated as such', () => {
  it('refuses a re-declaration that changes only the retention level', async () => {
    // A `release` identity may declare `session` or `durable`
    // (ADR-0011's retention matrix). Re-declaring the same id at the
    // other level is a retention change, and the retained state already
    // written under the old level would be stranded by it.
    const service = makeService(dir);
    const durable = makeIdentity('release', {
      id: 'idn-retention',
      stateRef: 'retention:state',
      stateRetention: 'durable',
    });
    await service.declareIdentity(durable);
    await service.touch(durable.id, '2026-10-01T00:00:00.000Z');
    const before = await restart(dir).loadIdentity(durable.id);

    const session = makeIdentity('release', {
      id: 'idn-retention',
      stateRef: 'retention:state',
      stateRetention: 'session',
    });
    await expect(service.declareIdentity(session)).rejects.toThrow(
      /already stored with a different declaration/,
    );

    const after = await restart(dir).loadIdentity(durable.id);
    expect(after).toEqual(before);
    expect(after.identity.capability.stateRetention).toBe('durable');
    expect(after.retainedState).toBeDefined();
  });

  it('cannot construct a record whose retention contradicts its lifecycle', () => {
    // The fixture goes through #57's parser, so an illegal pairing is
    // refused at the boundary rather than reaching the store.
    expect(() =>
      makeIdentity('ephemeral', { id: 'idn-illegal', stateRetention: 'durable' }),
    ).toThrow();
    expect(() =>
      makeIdentity('persistent', { id: 'idn-illegal2', stateRef: 's', stateRetention: 'session' }),
    ).toThrow();
  });

  it('holds no state for an identity that retains none', async () => {
    const ephemeral = makeIdentity('ephemeral', { id: 'idn-nostate' });
    const service = makeService(dir);
    const state = await service.declareIdentity(ephemeral);

    expect(state.identity.capability.stateRetention).toBe('none');
    expect(state.identity.stateRef).toBeUndefined();
    expect(state.retainedState).toBeUndefined();
    // And the check survives a reload, not just the write path.
    const reloaded = await restart(dir).loadIdentity(ephemeral.id);
    expect(reloaded.retainedState).toBeUndefined();
  });
});

describe('version labels', () => {
  it('accepts the spellings deployments actually use', () => {
    for (const v of ['2026.10.1', 'v1.2.3', 'build-1234', 'main+abc.123', 'release_2026-10']) {
      expect(parseVersionLabel(v)).toBe(v);
    }
  });

  it('rejects values that are not labels', () => {
    for (const v of ['', '  ', 'a/b', 'version with spaces', '-leading-dash', 'a?b=1']) {
      expect(() => parseVersionLabel(v)).toThrow();
    }
  });
});

/** Serialize a state exactly as the service would, for parse-level tests. */
function serializeForTest(state: unknown): Record<string, unknown> {
  const s = state as {
    identity: Record<string, unknown>;
    accountRef?: string;
    retainedState?: unknown;
    observations: ReadonlyArray<unknown>;
    releaseWindow?: unknown;
    retiredAt?: string;
  };
  const out: Record<string, unknown> = { ...s.identity, observations: [...s.observations] };
  if (s.accountRef !== undefined) out['accountRef'] = s.accountRef;
  if (s.retainedState !== undefined) out['retainedState'] = s.retainedState;
  if (s.releaseWindow !== undefined) out['releaseWindow'] = s.releaseWindow;
  if (s.retiredAt !== undefined) out['retiredAt'] = s.retiredAt;
  return out;
}
