import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

import { runEvaluation } from '../../../src/runtime/index.js';
import { ENV_A, makeIdentity, makePlan, makeService, seedIdentities } from './support/fixtures.js';
import { buildHarness, startHarnessRoot, type HarnessRoot } from './support/harness.js';

let root: HarnessRoot;
beforeAll(async () => { root = await startHarnessRoot('u-sekai-persistent-transition-'); });
afterAll(async () => { await root.cleanup(); });

const PERSISTENT = { id: 'idn-durable', lifecycle: 'persistent' as const };
const RELEASE = { id: 'idn-bounded', lifecycle: 'release' as const };
const EPHEMERAL = { id: 'idn-visitor', lifecycle: 'ephemeral' as const };

function versionPlan(version: number) {
  return makePlan({
    environmentId: ENV_A,
    version: `v${version}`,
    observedAt: `2026-10-0${version}T00:00:00.000Z`,
    ...(version === 1 ? { mode: 'pointInTime' as const } : {
      previousObservation: {
        environmentId: ENV_A,
        version: `v${version - 1}`,
        observedAt: `2026-10-0${version - 1}T00:00:00.000Z`,
      },
    }),
  });
}

describe('persistent identities across release transitions', () => {
  it('preserves declared state through A -> B -> C with newly opened services', async () => {
    const identity = makeIdentity(PERSISTENT);
    const { config } = buildHarness(root, { identities: [PERSISTENT], storeName: 'durable' });
    await seedIdentities(config.cohort, [identity]);
    let previous = await runEvaluation(config, { plan: versionPlan(1), runId: 'run-v1' });
    const afterA = await config.cohort.loadIdentity(identity.id);

    for (const version of [2, 3]) {
      const cohort = makeService(path.join(root.dir, 'durable'));
      const open = vi.spyOn(cohort, 'openTransition');
      const close = vi.spyOn(cohort, 'closeTransition');
      const result = await runEvaluation({ ...config, cohort }, {
        plan: versionPlan(version), runId: `run-v${version}`,
        baseline: previous.lineage, baselineFindings: previous.findings,
      });
      expect(result.mode).toBe('releaseTransition');
      expect(result.lineage.identityIds).toEqual([identity.id]);
      expect(result.persistence.closedTransitions).toEqual([]);
      expect(open).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();

      const stored = await makeService(path.join(root.dir, 'durable')).loadIdentity(identity.id);
      expect(stored.identity).toEqual(identity);
      expect(stored.observations.map((entry) => entry.version)).toEqual(
        Array.from({ length: version }, (_, index) => `v${index + 1}`),
      );
      expect(stored.retainedState).toMatchObject({
        ref: afterA.retainedState?.ref,
        firstObservedAt: afterA.retainedState?.firstObservedAt,
        interactionCount: version,
      });
      expect(stored.releaseWindow).toBeUndefined();
      previous = result;
    }
  });

  it('opens and closes windows only for release members of a mixed cohort', async () => {
    const identities = [PERSISTENT, RELEASE].map(makeIdentity);
    const { config } = buildHarness(root, { identities: [PERSISTENT, RELEASE], storeName: 'mixed' });
    await seedIdentities(config.cohort, identities);
    const runA = await runEvaluation(config, { plan: versionPlan(1), runId: 'mixed-a' });
    const cohort = makeService(path.join(root.dir, 'mixed'));
    const open = vi.spyOn(cohort, 'openTransition');
    const close = vi.spyOn(cohort, 'closeTransition');
    const runB = await runEvaluation({ ...config, cohort }, {
      plan: versionPlan(2), runId: 'mixed-b', baseline: runA.lineage,
    });
    expect(runB.persistence.closedTransitions).toEqual([RELEASE.id]);
    expect(open.mock.calls.map(([id]) => id)).toEqual([RELEASE.id]);
    expect(close.mock.calls.map(([id]) => id)).toEqual([RELEASE.id]);
    for (const identity of identities) {
      const stored = await makeService(path.join(root.dir, 'mixed')).loadIdentity(identity.id);
      expect(stored.observations.map((entry) => entry.version)).toEqual(['v1', 'v2']);
      if (identity.lifecycle === 'persistent') {
        expect(stored.retainedState?.interactionCount).toBe(2);
        expect(stored.releaseWindow).toBeUndefined();
      } else {
        expect(stored.retainedState).toBeUndefined();
        expect(stored.releaseWindow).toMatchObject({ fromVersion: 'v1', toVersion: 'v2' });
        expect(stored.releaseWindow?.closedAt).toBeDefined();
      }
    }
  });

  it('rejects an ephemeral member before driving or mutating any member', async () => {
    const identities = [PERSISTENT, RELEASE, EPHEMERAL].map(makeIdentity);
    const { config } = buildHarness(root, {
      identities: [PERSISTENT, RELEASE, EPHEMERAL], storeName: 'ephemeral',
    });
    await seedIdentities(config.cohort, identities);
    const runA = await runEvaluation(config, { plan: versionPlan(1), runId: 'ephemeral-a' });
    const before = await Promise.all(identities.map((identity) => config.cohort.loadIdentity(identity.id)));
    const adapterFactory = vi.fn(config.adapterFactory);
    const open = vi.spyOn(config.cohort, 'openTransition');
    const record = vi.spyOn(config.cohort, 'recordRun');
    await expect(runEvaluation({ ...config, adapterFactory }, {
      plan: versionPlan(2), runId: 'ephemeral-b', baseline: runA.lineage,
    })).rejects.toMatchObject({ code: 'planNotInModel' });
    expect(adapterFactory).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(await Promise.all(identities.map((identity) => config.cohort.loadIdentity(identity.id)))).toEqual(before);
  });
});
