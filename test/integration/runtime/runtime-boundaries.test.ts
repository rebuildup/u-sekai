/**
 * Regression tests for boundaries the runtime owns and a reader cannot
 * check by reading one happy-path test.
 *
 * Each case here exists because a real defect was found in review and
 * fixed; the test is what stops it coming back. They are grouped
 * because they are all "the runtime must refuse or bound something at
 * its own edge", which is one concern wearing three hats.
 *
 * ## 1. Review ids stay inside #61's bound for *any* declared run id
 *
 * #57 accepts a declared `runId` of up to 256 characters; #61 caps a
 * review id at 128. Composing a setup-failure id by spelling the run id
 * into it therefore produced an id #61 would reject — silently, because
 * `setupFailureFromRuntimeError` takes its id as a `SetupFailureId` and
 * never re-parses it. The fix hashes the run id into a bounded token and
 * *parses* the result, so the bound is enforced at the point of
 * construction. The observable is that a 256-character run id yields
 * setup-failure ids that `parseSetupFailureId` accepts, and that every
 * produced record round-trips through `parseReviewOutcome`.
 *
 * ## 2. A plan the durable model does not declare is refused before work
 *
 * A plan naming an environment, cohort or program the model does not
 * declare is a caller mistake. It is refused before the World Operator
 * is constructed, so no connector call is made and no browser launches.
 * The observable is the connector's call count, not the error alone.
 *
 * ## 3. An environment with no endpoint is refused before provisioning
 *
 * Found in review: the target URL was resolved *after* setup, so a model
 * whose environment declared no endpoint would provision world state and
 * then throw. The observable is again the connector's call count — zero.
 *
 * ## 4. A cleanup that cannot release its world state is a review record
 *
 * #59's `rollbackFailed` is the one condition in the taxonomy that can
 * leave state behind, so it is reported as a `SetupFailure` of its own
 * rather than left for the caller to notice in `result.cleanup`. The
 * observable is that the orphaned resource key appears in a record.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { parseReviewOutcome, parseSetupFailureId } from '../../../src/review/index.js';
import { parseEvaluationRunId } from '../../../src/product/index.js';
import { MAX_REVIEW_ID_LENGTH } from '../../../src/review/ids.js';
import { script } from '../../../src/operator/index.js';
import { runEvaluation } from '../../../src/runtime/index.js';
import {
  ENV_A,
  accountCreateStep,
  makeConnector,
  makeIdentity,
  makePlan,
  seedIdentities,
} from './support/fixtures.js';
import { buildHarness, startHarnessRoot, type HarnessRoot } from './support/harness.js';

let root: HarnessRoot;

beforeAll(async () => {
  root = await startHarnessRoot('u-sekai-runtime-boundaries-');
});

afterAll(async () => {
  await root.cleanup();
});

const ALICE = { id: 'idn-alice', lifecycle: 'persistent' as const };

/** A run id at the very top of #57's accepted length. */
const LONG_RUN_ID = `run.${'a'.repeat(250)}`;

describe('runtime boundaries', () => {
  it('keeps review ids inside #61\'s bound for a 256-character run id', async () => {
    const identity = makeIdentity(ALICE);
    const { config } = buildHarness(root, {
      identities: [ALICE],
      storeName: 'long-run-id-store',
      // An adapter that cannot reach the target, so the run produces
      // runtime errors and therefore setup-failure ids.
      unreachable: true,
    });
    await seedIdentities(config.cohort, [identity]);

    const declared = parseEvaluationRunId(LONG_RUN_ID);
    expect(declared.length).toBeGreaterThan(MAX_REVIEW_ID_LENGTH);

    const result = await runEvaluation(config, {
      plan: makePlan({
        environmentId: ENV_A,
        version: '2026.10.1',
        observedAt: '2026-10-01T00:00:00.000Z',
        delivery: 'long-run-id',
      }),
      runId: LONG_RUN_ID,
    });

    expect(result.setupFailures.length).toBeGreaterThan(0);
    for (const failure of result.setupFailures) {
      // The id is inside #61's bound and parses under #61's own parser,
      // rather than being a cast the parser never saw.
      expect(failure.id.length).toBeLessThanOrEqual(MAX_REVIEW_ID_LENGTH);
      expect(() => parseSetupFailureId(failure.id)).not.toThrow();
      expect(failure.runId).toBe(declared);
    }
    // And the whole set still round-trips as review records.
    for (const outcome of result.outcomes) {
      expect(() => parseReviewOutcome(outcome)).not.toThrow();
    }
  }, 60_000);

  it('refuses a plan whose target the model does not declare, before any dispatch', async () => {
    const identity = makeIdentity(ALICE);
    const connector = makeConnector();
    const { config } = buildHarness(root, {
      identities: [ALICE],
      connector,
      steps: [accountCreateStep(identity.id)],
      storeName: 'undeclared-store',
    });
    await seedIdentities(config.cohort, [identity]);

    // A well-formed plan key, on a program the model does not declare.
    const strayPlan = makePlan({
      environmentId: ENV_A,
      version: '2026.10.1',
      observedAt: '2026-10-01T00:00:00.000Z',
      delivery: 'undeclared-1',
    });
    const undeclared = {
      ...strayPlan,
      target: { ...strayPlan.target, environmentId: 'env-nowhere' },
    } as typeof strayPlan;

    await expect(
      runEvaluation(config, { plan: undeclared, runId: 'run-undeclared' }),
    ).rejects.toMatchObject({ code: 'planNotInModel' });

    // Nothing was provisioned and nothing was driven.
    expect(connector.provisionCalls).toBe(0);
    expect(connector.releaseCalls).toBe(0);
  }, 60_000);

  it('refuses an environment with no endpoint before provisioning', async () => {
    const identity = makeIdentity(ALICE);
    const connector = makeConnector();
    const { config } = buildHarness(root, {
      identities: [ALICE],
      connector,
      steps: [accountCreateStep(identity.id)],
      storeName: 'no-endpoint-store',
    });
    await seedIdentities(config.cohort, [identity]);

    // #57's parser is the first line: an environment cannot be *declared*
    // without an endpoint. `RuntimeConfiguration.model` is typed as the
    // `ProductModel` interface rather than a parse function's return, so a
    // caller that assembles a model by hand — or one that has been through
    // a serialisation boundary #57 knows nothing about — can still hand the
    // runtime a target with no entry point. That is the case the runtime's
    // own check exists for, and it is what this test builds.
    const endpointless = {
      ...config,
      model: {
        ...config.model,
        environments: config.model.environments.map((e) => ({
          ...e,
          endpoint: { baseUrl: '' },
        })),
      },
    } as typeof config;

    await expect(
      runEvaluation(endpointless, {
        plan: makePlan({
          environmentId: ENV_A,
          version: '2026.10.1',
          observedAt: '2026-10-01T00:00:00.000Z',
          delivery: 'no-endpoint-1',
        }),
        runId: 'run-no-endpoint-1',
      }),
    ).rejects.toMatchObject({ code: 'noEnvironmentEndpoint' });

    // The ordering is the point: the refusal happened before the World
    // Operator was constructed, so no world state was applied for a run
    // that was always going to fail.
    expect(connector.provisionCalls).toBe(0);
    expect(connector.releaseCalls).toBe(0);
  }, 60_000);

  it('reports world state it could not release as a review record', async () => {
    const identity = makeIdentity(ALICE);
    // Compensation fails, so the world keeps the resource this run
    // created. #59 calls that the only condition that can leak.
    const connector = makeConnector({
      failRelease: script({ 'account.create': 'the customer test-support API refused to release' }),
    });
    const { config } = buildHarness(root, {
      identities: [ALICE],
      connector,
      steps: [accountCreateStep(identity.id)],
      storeName: 'orphaned-store',
    });
    await seedIdentities(config.cohort, [identity]);

    const result = await runEvaluation(config, {
      plan: makePlan({
        environmentId: ENV_A,
        version: '2026.10.1',
        observedAt: '2026-10-01T00:00:00.000Z',
        delivery: 'orphaned-1',
      }),
      runId: 'run-orphaned-1',
    });

    // The leak is visible in the returned verdict...
    expect(result.cleanup?.status).toBe('partiallyCleaned');
    expect(connector.liveResourceKeys()).toEqual(['acct-primary']);
    // ...and in the review records, which is where a customer-facing
    // consumer reads it. It is never collapsed into another failure.
    const leak = result.setupFailures.find((f) => f.message.includes('could not release'));
    expect(leak).toBeDefined();
    expect(leak?.cause).toBe('worldStateUnavailable');
    expect(leak?.outcome).toBe('setupFailure');
    for (const outcome of result.outcomes) {
      expect(() => parseReviewOutcome(outcome)).not.toThrow();
    }
  }, 60_000);
});
