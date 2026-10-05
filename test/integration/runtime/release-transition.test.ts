/**
 * Acceptance: a release-transition integration test demonstrates
 * version/state A -> B behaviour (Issue #63, criterion 6).
 *
 * ## What "A -> B" is demonstrated *as*, and what it is not
 *
 * Two things are demonstrated, and they are deliberately kept apart:
 *
 * 1. **Durable state A -> B, for real.** A `release` Synthetic Identity
 *    observes environment A at version `2026.10.1`, then the *same*
 *    identity returns against environment B at `2026.10.2`. The stored
 *    record shows the window opened from A, both observations present,
 *    and the transition closed to B with the transition-scoped retained
 *    state dropped (#60's own rule). This is a state transition in the
 *    durable store, read back through a second service over the same
 *    bytes.
 * 2. **A comparative claim, for real.** Run B's findings carry
 *    `mode: 'releaseTransition'`, the earlier run's lineage as their
 *    baseline, and a per-finding `introduced` / `persisted` verdict
 *    computed by joining the two runs' finding sets.
 *
 * What is **not** demonstrated, and is reported rather than papered
 * over: that the two *deployments behaved differently*. `RunLineage`
 * (#57) carries no version identity, so nothing in the record can prove
 * a version boundary was crossed rather than one deployment observed
 * twice under two names. That is Issue #83. The test therefore asserts
 * the two demonstrations above and says nothing about product behaviour
 * differing — a claim it is not entitled to make.
 *
 * ## The falsifications
 *
 * A release-transition test that only exercises the accepted case
 * proves nothing about the predicate. Three cases here must each fail,
 * and each differs from the accepted one by a single axis:
 *
 * | falsification | axis changed | expected |
 * | --- | --- | --- |
 * | no baseline supplied | the run's join | `unjoinableBaseline`, before anything runs |
 * | a baseline from a different cohort | the cohort | `unjoinableBaseline`, naming the scopes |
 * | an `ephemeral` identity in a transition plan | the lifecycle | `planNotInModel`, naming the members |
 *
 * The first two matter most: they are the cases where an implementation
 * that "just attaches a baseline" would silently produce a
 * release-transition finding about two unrelated runs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';

import { isReleaseTransitionComparison } from '../../../src/product/index.js';
import type { RunLineage } from '../../../src/product/index.js';
import { classifyChange } from '../../../src/runtime/index.js';
import { runEvaluation } from '../../../src/runtime/index.js';
import type { EvaluationPlan } from '../../../src/program/index.js';
import {
  ENV_A,
  makeIdentity,
  makePlan,
  makeService,
  seedIdentities,
  stagingPolicy,
} from './support/fixtures.js';
import { buildHarness, startHarnessRoot, type HarnessRoot } from './support/harness.js';

let root: HarnessRoot;

beforeAll(async () => {
  root = await startHarnessRoot('u-sekai-runtime-transition-');
});

afterAll(async () => {
  await root.cleanup();
});

const RETURNING = { id: 'idn-returning', lifecycle: 'release' as const };
const PERSISTED_PROBLEM = 'The list gave no confirmation that the task had been saved.';
const NEW_PROBLEM = 'The Settings page links to nothing that changes anything.';

function planA(): EvaluationPlan {
  return makePlan({
    environmentId: ENV_A,
    version: '2026.10.1',
    observedAt: '2026-10-01T00:00:00.000Z',
    mode: 'pointInTime',
    delivery: 'version-a',
  });
}

function planB(): EvaluationPlan {
  return makePlan({
    environmentId: 'env-beta',
    version: '2026.10.2',
    observedAt: '2026-10-08T00:00:00.000Z',
    // A genuine `crossEnvironment` lineage: the same program and cohort
    // observed against a different deployment, one version later.
    previousObservation: {
      environmentId: ENV_A,
      version: '2026.10.1',
      observedAt: '2026-10-01T00:00:00.000Z',
    },
  });
}

describe('release transition: version / state A -> B', () => {
  it('carries a returning identity from A to B and classifies each finding against the join', async () => {
    const identity = makeIdentity(RETURNING);
    const { config } = buildHarness(root, {
      identities: [RETURNING],
      storeName: 'transition-store',
      extraEnvironments: [{ id: 'env-beta', baseUrl: root.server.baseUrl }],
      observerFindings: [{ id: 'obs-a', summary: PERSISTED_PROBLEM }],
    });
    await seedIdentities(config.cohort, [identity]);

    // --- Run A: version A, on environment A.
    const runA = await runEvaluation(config, { plan: planA(), runId: 'run-a' });
    expect(runA.findings.map((f) => f.title)).toEqual([PERSISTED_PROBLEM]);

    const afterA = await config.cohort.loadIdentity(identity.id);
    expect(afterA.observations).toHaveLength(1);
    expect(afterA.observations[0]).toMatchObject({
      environmentId: ENV_A,
      version: '2026.10.1',
      runId: 'run-a',
    });
    // No transition window yet: A was a point-in-time observation.
    expect(afterA.releaseWindow).toBeUndefined();
    expect(afterA.retainedState?.interactionCount).toBe(1);

    // --- Run B: the same identity, environment B, version B, with the
    // earlier run supplied as the baseline and one extra problem that
    // only appears now.
    const { config: configB } = buildHarness(root, {
      identities: [RETURNING],
      storeName: 'transition-store',
      extraEnvironments: [{ id: 'env-beta', baseUrl: root.server.baseUrl }],
      observerFindings: [
        { id: 'obs-a2', summary: PERSISTED_PROBLEM },
        { id: 'obs-b', summary: NEW_PROBLEM },
      ],
    });

    const runB = await runEvaluation(configB, {
      plan: planB(),
      runId: 'run-b',
      baseline: runA.lineage as RunLineage,
      baselineFindings: runA.findings,
    });

    // --- The join is the one #57's predicate recognises.
    expect(runB.mode).toBe('releaseTransition');
    expect(isReleaseTransitionComparison(runA.lineage, runB.lineage)).toBe(true);

    // --- Both findings are classified against the join, and the
    // classification is a real join rather than a guess: the problem
    // that was already there is `persisted`, the one that is new is
    // `introduced`.
    const byTitle = new Map(runB.findings.map((f) => [f.title, f]));
    expect([...byTitle.keys()].sort()).toEqual([NEW_PROBLEM, PERSISTED_PROBLEM].sort());
    expect(byTitle.get(PERSISTED_PROBLEM)?.longitudinal.change).toBe('persisted');
    expect(byTitle.get(NEW_PROBLEM)?.longitudinal.change).toBe('introduced');
    for (const finding of runB.findings) {
      expect(finding.longitudinal.mode).toBe('releaseTransition');
      expect(finding.longitudinal.baseline?.runId).toBe('run-a');
      expect(finding.observedIn).toBe('run-b');
      expect(finding.target.environmentId).toBe('env-beta');
    }

    // --- The durable state really transitioned, read back through a
    // fresh service over the same bytes.
    const reopened = makeService(path.join(root.dir, 'transition-store'), {
      now: () => '2026-10-08T01:00:00.000Z',
    });
    const afterB = await reopened.loadIdentity(identity.id);

    // Both observations, in both environments, at both versions.
    expect(afterB.observations).toHaveLength(2);
    const seen = afterB.observations
      .map((o) => `${o.environmentId}@${o.version}`)
      .sort();
    expect(seen).toEqual([`${ENV_A}@2026.10.1`, 'env-beta@2026.10.2']);

    // The window records the transition it spanned, and it is closed.
    expect(afterB.releaseWindow).toMatchObject({
      fromVersion: '2026.10.1',
      toVersion: '2026.10.2',
    });
    expect(afterB.releaseWindow?.closedAt).toBeDefined();

    // #60's rule: the retained state a `release` identity carried for
    // the transition is gone once the transition is closed. The identity
    // returned for B; it does not keep accumulating across it.
    expect(afterB.retainedState).toBeUndefined();
    expect(runB.persistence.closedTransitions).toEqual([identity.id]);
  }, 90_000);

  it('refuses a release-transition plan with no baseline, before anything runs', async () => {
    const identity = makeIdentity(RETURNING);
    const { config } = buildHarness(root, {
      identities: [RETURNING],
      storeName: 'no-baseline-store',
      extraEnvironments: [{ id: 'env-beta', baseUrl: root.server.baseUrl }],
      policy: stagingPolicy(),
    });
    await seedIdentities(config.cohort, [identity]);

    // #61 refuses a `releaseTransition` finding with no baseline, so the
    // runtime refuses the invocation rather than quietly downgrading it
    // to a point-in-time run and reporting success.
    await expect(runEvaluation(config, { plan: planB(), runId: 'run-no-baseline' })).rejects.toMatchObject({
      code: 'unjoinableBaseline',
    });

    // Nothing was provisioned, driven or persisted.
    const stored = await config.cohort.loadIdentity(identity.id);
    expect(stored.observations).toEqual([]);
    expect(stored.releaseWindow).toBeUndefined();
  }, 60_000);

  it('refuses a baseline from a different cohort, naming the scopes', async () => {
    const identity = makeIdentity(RETURNING);
    const { config } = buildHarness(root, {
      identities: [RETURNING],
      storeName: 'wrong-scope-store',
      extraEnvironments: [{ id: 'env-beta', baseUrl: root.server.baseUrl }],
    });
    await seedIdentities(config.cohort, [identity]);

    // A baseline that is a real lineage, on the same program, but for a
    // different cohort and a disjoint set of identities. It differs from
    // the accepted case by one axis.
    const foreignBaseline = {
      productId: runIdentityTargetProduct(),
      environmentId: ENV_A,
      cohortId: 'coh-someone-else',
      programId: runIdentityTargetProgram(),
      runId: 'run-foreign',
      identityIds: ['idn-stranger'],
      startedAt: '2026-10-01T00:00:00.000Z',
      endedAt: '2026-10-01T00:05:00.000Z',
    } as unknown as RunLineage;

    await expect(
      runEvaluation(config, {
        plan: planB(),
        runId: 'run-wrong-scope',
        baseline: foreignBaseline,
      }),
    ).rejects.toMatchObject({ code: 'unjoinableBaseline' });

    // And the message names the axis, rather than leaving the caller to
    // guess which of the three predicates failed.
    await expect(
      runEvaluation(config, {
        plan: planB(),
        runId: 'run-wrong-scope-2',
        baseline: foreignBaseline,
      }),
    ).rejects.toThrow(/does not share this program's scope/);
  }, 60_000);

  it('refuses a transition plan whose members cannot span one', async () => {
    const ephemeral = { id: 'idn-ephemeral', lifecycle: 'ephemeral' as const };
    const { config } = buildHarness(root, {
      identities: [ephemeral],
      storeName: 'wrong-lifecycle-store',
      extraEnvironments: [{ id: 'env-beta', baseUrl: root.server.baseUrl }],
    });
    await seedIdentities(config.cohort, [makeIdentity(ephemeral)]);

    // A baseline for the same cohort, so the lifecycle is the *only*
    // axis that differs from the accepted case.
    const sameShapeBaseline = {
      productId: 'prd-task-tracker',
      environmentId: ENV_A,
      cohortId: 'coh-returning',
      programId: 'rp-continuous',
      runId: 'run-a-ephemeral',
      identityIds: ['idn-ephemeral'],
      startedAt: '2026-10-01T00:00:00.000Z',
      endedAt: '2026-10-01T00:05:00.000Z',
    } as unknown as RunLineage;

    await expect(
      runEvaluation(config, {
        plan: planB(),
        runId: 'run-wrong-lifecycle',
        baseline: sameShapeBaseline,
      }),
    ).rejects.toMatchObject({ code: 'planNotInModel' });

    // The error names the member that cannot span the transition, so the
    // fix is obvious from the message.
    await expect(
      runEvaluation(config, {
        plan: planB(),
        runId: 'run-wrong-lifecycle-2',
        baseline: sameShapeBaseline,
      }),
    ).rejects.toThrow(/idn-ephemeral/);
  }, 60_000);

  it('classifies a change as unknown when there is no baseline to join', () => {
    // A pure-function check of the join, with no browser and no run: the
    // classifier must not invent a verdict.
    const current = { kind: 'usabilityDefect' as const, title: 'The list gave no confirmation.' };
    expect(classifyChange(current, undefined)).toBe('unknown');
    expect(classifyChange(current, [])).toBe('unknown');
    expect(
      classifyChange(current, [
        {
          kind: 'usabilityDefect',
          title: 'The list gave no confirmation.',
        } as never,
      ]),
    ).toBe('persisted');
    expect(
      classifyChange(current, [
        { kind: 'workflowBlocker', title: 'Something else entirely.' } as never,
      ]),
    ).toBe('introduced');
  });
});

function runIdentityTargetProduct(): EvaluationPlan['target']['productId'] {
  return planA().target.productId;
}

function runIdentityTargetProgram(): EvaluationPlan['target']['programId'] {
  return planA().target.programId;
}
