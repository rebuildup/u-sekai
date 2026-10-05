/**
 * Acceptance: a persistent Synthetic Identity runs twice and retains
 * **only** the explicitly persisted state (Issue #63, criterion 2).
 *
 * ## The observable this file exists to prove
 *
 * "Retains the state it was told to retain" is an easy claim to make
 * loosely, so the assertions here are deliberately two-sided:
 *
 * | claim | observable |
 * | --- | --- |
 * | state survives the run | a *second service* over the same directory, sharing nothing but the bytes, reads the same record back |
 * | the second run accumulates, it does not duplicate | two observations, one per run; `interactionCount` is 2; `firstObservedAt` is unchanged from run 1 |
 * | **only** the declared state is retained | the persisted record's key set is exactly `{identity, observations, retainedState}` — the conversation, the observations, the self-report and the evidence stay in the run artifact and are *not* copied in |
 * | the retention decision follows #57, not the runtime's mood | an `ephemeral` member in the same cohort gets an observation and **no** retained state, because #57 declares `stateRetention: 'none'` for it |
 *
 * The key-set assertion is the load-bearing one. A whitelist of what is
 * written is a property of the code; a filter of what is *not* written
 * is a property of the value, and only the second survives a later
 * commit that decides to persist "just one more thing".
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';

import { runEvaluation } from '../../../src/runtime/index.js';
import { ENV_A, makeIdentity, makePlan, makeService, seedIdentities } from './support/fixtures.js';
import { buildHarness, startHarnessRoot, type HarnessRoot } from './support/harness.js';

let root: HarnessRoot;

beforeAll(async () => {
  root = await startHarnessRoot('u-sekai-runtime-retention-');
});

afterAll(async () => {
  await root.cleanup();
});

const ALICE = { id: 'idn-alice', lifecycle: 'persistent' as const };
const VISITOR = { id: 'idn-visitor', lifecycle: 'ephemeral' as const };

describe('persistent identity retention across two runs', () => {
  it('accumulates exactly the declared state and survives a fresh process', async () => {
    const { config, baseUrl } = buildHarness(root, {
      identities: [ALICE, VISITOR],
      observerFindings: [
        { id: 'obs-1', summary: 'The list gave no confirmation that the task had been saved.' },
      ],
    });
    expect(baseUrl).toBe(root.server.baseUrl);
    await seedIdentities(config.cohort, [makeIdentity(ALICE), makeIdentity(VISITOR)]);

    // --- Run 1.
    const first = await runEvaluation(config, {
      plan: makePlan({
        environmentId: ENV_A,
        version: '2026.10.1',
        observedAt: '2026-10-01T00:00:00.000Z',
        delivery: 'alpha-1',
      }),
      runId: 'run-alpha-1',
    });
    expect(first.findings.length).toBeGreaterThanOrEqual(1);

    const afterFirst = await config.cohort.loadIdentity('idn-alice' as never);
    expect(afterFirst.observations).toHaveLength(1);
    expect(afterFirst.observations[0]).toMatchObject({
      environmentId: ENV_A,
      version: '2026.10.1',
      runId: 'run-alpha-1',
    });
    expect(afterFirst.retainedState?.interactionCount).toBe(1);
    const firstObservedAt = afterFirst.retainedState?.firstObservedAt;
    expect(firstObservedAt).toBeDefined();

    // --- "Survives a process restart" is the load path, not an
    // in-process object. A brand new service over the same directory,
    // sharing nothing but the bytes on disk, must read the same record.
    const reopened = makeService(path.join(root.dir, 'store'), { now: seedClock() });
    const afterRestart = await reopened.loadIdentity('idn-alice' as never);
    expect(afterRestart.retainedState?.interactionCount).toBe(1);
    expect(afterRestart.observations).toHaveLength(1);

    // --- Run 2, on a fresh service so nothing can be served from memory.
    const second = await runEvaluation(
      { ...config, cohort: reopened },
      {
        plan: makePlan({
          environmentId: ENV_A,
          version: '2026.10.1',
          observedAt: '2026-10-01T00:10:00.000Z',
          delivery: 'alpha-2',
        }),
        runId: 'run-alpha-2',
      },
    );
    expect(second.lineage.runId).toBe('run-alpha-2');

    const afterSecond = await reopened.loadIdentity('idn-alice' as never);
    expect(afterSecond.observations).toHaveLength(2);
    expect(afterSecond.observations.map((o) => o.runId).sort()).toEqual([
      'run-alpha-1',
      'run-alpha-2',
    ]);
    expect(afterSecond.retainedState?.interactionCount).toBe(2);
    // Accumulation, not restatement: the first observation instant is
    // the one the identity actually first showed up at.
    expect(afterSecond.retainedState?.firstObservedAt).toBe(firstObservedAt);
    expect(afterSecond.retainedState?.ref).toBe('state://idn-alice');

    // --- The whitelist, asserted on the value rather than on the code.
    // Nothing from the run — no conversation, no observation payload, no
    // self-report, no evidence — is copied into the durable record.
    expect(Object.keys(afterSecond).sort()).toEqual([
      'identity',
      'observations',
      'retainedState',
    ]);
    for (const key of ['conversation', 'selfReport', 'evidence', 'observations_detail']) {
      expect(Object.keys(afterSecond)).not.toContain(key);
    }
  });

  it('persists an observation but no retained state for an ephemeral member', async () => {
    const { config } = buildHarness(root, {
      identities: [VISITOR],
      storeName: 'ephemeral-store',
    });
    await seedIdentities(config.cohort, [makeIdentity(VISITOR)]);

    const result = await runEvaluation(config, {
      plan: makePlan({
        environmentId: ENV_A,
        version: '2026.10.1',
        observedAt: '2026-10-01T00:00:00.000Z',
        delivery: 'visitor-1',
      }),
      runId: 'run-visitor-1',
    });

    // The run really happened; the identity simply has nothing to carry.
    expect(result.lineage.identityIds).toEqual(['idn-visitor']);
    expect(result.setup.status).toBe('skipped');

    const stored = await config.cohort.loadIdentity('idn-visitor' as never);
    expect(stored.observations).toHaveLength(1);
    // #57's retention table binds `ephemeral` to `stateRetention: 'none'`,
    // and #60's `touchRetainedState` raises in that case. The runtime
    // filters on the declared retention rather than calling and
    // catching, so the run succeeds and nothing is written.
    expect(stored.retainedState).toBeUndefined();
    expect(result.persistence.persistedIdentityIds).toEqual(['idn-visitor']);
    expect(result.persistence.skippedIdentityIds).toEqual(['idn-visitor']);
    expect(Object.keys(stored).sort()).toEqual(['identity', 'observations']);
  });
});

function seedClock(): () => string {
  return () => '2026-10-01T00:05:00.000Z';
}
