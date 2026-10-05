/**
 * Acceptance: a setup or runtime failure is distinguishable from a
 * product finding (Issue #63, criterion 4).
 *
 * ## The observable this file exists to prove
 *
 * The failure mode this criterion exists to prevent is specific and
 * silent: a harness problem gets filed as a customer-facing finding, and
 * the customer's dashboard then reports that their product is broken
 * for a run that never evaluated it. So every case here asserts the
 * same three things in the same order:
 *
 * 1. the failure is present, as a `SetupFailure` with a `cause`;
 * 2. **`findings.length === 0`** — not "fewer", zero;
 * 3. the record carries none of the fields that only a product claim
 *    can have, at both the type level (`@ts-expect-error`) and the value
 *    level (`Object.keys`).
 *
 * The cases are chosen to cover each way a run can fail to reach the
 * product, because each reaches it through a different layer:
 *
 * | case | who failed | cause | why the connector count matters |
 * | --- | --- | --- | --- |
 * | the World Operator refuses the plan | the authority boundary | `worldOperatorDenied` | 0 calls: a denial is decided before dispatch |
 * | the connector cannot create the world | the connector | `worldStateUnavailable` | 1 call: it was tried |
 * | the product refuses the setup | the product under test | `worldStateUnavailable` + a `productResponse` citation | 1 call |
 * | the environment is unreachable | the harness | `adapterError` | setup was skipped entirely |
 *
 * The product-refusal case is the sharpest one. A product that says
 * "no" is a real observation about the product, and the runtime records
 * it — as *evidence on a setup failure*, never as a finding.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { isFinding, isSetupFailure, parseReviewOutcome } from '../../../src/review/index.js';
import type { Finding, FindingId, SetupFailure } from '../../../src/review/index.js';
import { runEvaluation } from '../../../src/runtime/index.js';
import { script } from '../../../src/operator/index.js';
import {
  ENV_A,
  accountCreateStep,
  makeConnector,
  makeIdentity,
  makePlan,
  seedIdentities,
  stagingPolicy,
} from './support/fixtures.js';
import { buildHarness, startHarnessRoot, type HarnessRoot } from './support/harness.js';

let root: HarnessRoot;

beforeAll(async () => {
  root = await startHarnessRoot('u-sekai-runtime-separation-');
});

afterAll(async () => {
  await root.cleanup();
});

const ALICE = { id: 'idn-alice', lifecycle: 'persistent' as const };
const OBSERVER_FINDING = {
  id: 'obs-1',
  summary: 'The list gave no confirmation that the task had been saved.',
};

/**
 * Every outcome the runtime returned is one #61 knows how to read back.
 *
 * Round-tripping through `parseReviewOutcome` is the check: a record the
 * runtime invented and #61 would reject is not a review record, and
 * this makes that a failure rather than a downstream surprise.
 */
function expectAllReviewRecords(outcomes: ReadonlyArray<unknown>): void {
  for (const outcome of outcomes) {
    const parsed = parseReviewOutcome(outcome);
    expect(parsed.outcome === 'productFinding' || parsed.outcome === 'setupFailure').toBe(true);
  }
}

/** No product outcome was produced. */
function expectNoProductFindings(outcomes: ReadonlyArray<unknown>): void {
  const findings = outcomes.filter(isFinding);
  expect(findings).toEqual([]);
  const failures = outcomes.filter(isSetupFailure);
  expect(failures.length).toBeGreaterThan(0);
  for (const failure of failures) {
    // A SetupFailure carries no severity, no confidence, no longitudinal
    // claim and no affected conditions: there is no product claim for
    // those fields to describe.
    for (const key of ['severity', 'confidence', 'longitudinal', 'affectedConditions', 'kind']) {
      expect(Object.keys(failure)).not.toContain(key);
    }
  }
}

describe('a setup or runtime failure is never a product finding', () => {
  it('records a World Operator denial as a setup failure and dispatches nothing', async () => {
    const identity = makeIdentity(ALICE);
    const connector = makeConnector();
    const { config } = buildHarness(root, {
      identities: [ALICE],
      connector,
      // The policy grants no step at all. The declared plan is outside
      // declared authority, so #59's gate refuses the whole plan.
      policy: stagingPolicy({ grantedSteps: [], maxRisk: 'sandbox' }),
      steps: [accountCreateStep(identity.id)],
      storeName: 'denied-store',
      observerFindings: [OBSERVER_FINDING],
    });
    await seedIdentities(config.cohort, [identity]);

    const result = await runEvaluation(config, {
      plan: makePlan({
        environmentId: ENV_A,
        version: '2026.10.1',
        observedAt: '2026-10-01T00:00:00.000Z',
        delivery: 'denied-1',
      }),
      runId: 'run-denied-1',
    });

    // A denial is decided before anything is dispatched, so the count
    // is 0 — not 1-and-undone.
    expect(result.setup.status).toBe('denied');
    expect(connector.provisionCalls).toBe(0);

    // The run never reached the product: no participant ran, so the
    // observer's would-be finding has nothing to attach to.
    expect(result.setupRefused).toBe(true);
    expect(result.resolvedCohort.members.map((m) => m.id)).toEqual(['idn-alice']);
    expect(result.observer.findings).toEqual([]);

    expectAllReviewRecords(result.outcomes);
    expectNoProductFindings(result.outcomes);
    expect(result.setupFailures[0]?.cause).toBe('worldOperatorDenied');
    expect(result.setupFailures[0]?.outcome).toBe('setupFailure');

    // No durable state was written for a run that observed nothing.
    expect(result.persistence.persistedIdentityIds).toEqual([]);
    const stored = await config.cohort.loadIdentity(identity.id);
    expect(stored.observations).toEqual([]);
  }, 60_000);

  it('records a connector failure as a setup failure after attempting setup', async () => {
    const identity = makeIdentity(ALICE);
    const connector = makeConnector({
      failProvision: script({ 'account.create': 'the customer test-support API returned 503' }),
    });
    const { config } = buildHarness(root, {
      identities: [ALICE],
      connector,
      steps: [accountCreateStep(identity.id)],
      storeName: 'connector-failed-store',
      observerFindings: [OBSERVER_FINDING],
    });
    await seedIdentities(config.cohort, [identity]);

    const result = await runEvaluation(config, {
      plan: makePlan({
        environmentId: ENV_A,
        version: '2026.10.1',
        observedAt: '2026-10-01T00:00:00.000Z',
        delivery: 'connector-failed-1',
      }),
      runId: 'run-connector-failed-1',
    });

    // It was tried: one dispatch, and the world is not up.
    expect(result.setup.status).toBe('failed');
    expect(connector.provisionCalls).toBe(1);
    expect(result.setupRefused).toBe(true);

    expectAllReviewRecords(result.outcomes);
    expectNoProductFindings(result.outcomes);
    expect(result.setupFailures[0]?.cause).toBe('worldStateUnavailable');
    expect(result.setupFailures[0]?.message).toContain('503');
  }, 60_000);

  it('keeps a product refusal on a setup failure as cited evidence, not as a finding', async () => {
    const identity = makeIdentity(ALICE);
    const connector = makeConnector({
      rejectProduct: script({ 'account.create': 'account_already_exists' }),
    });
    const { config } = buildHarness(root, {
      identities: [ALICE],
      connector,
      steps: [accountCreateStep(identity.id)],
      storeName: 'product-rejected-store',
      observerFindings: [OBSERVER_FINDING],
    });
    await seedIdentities(config.cohort, [identity]);

    const result = await runEvaluation(config, {
      plan: makePlan({
        environmentId: ENV_A,
        version: '2026.10.1',
        observedAt: '2026-10-01T00:00:00.000Z',
        delivery: 'product-rejected-1',
      }),
      runId: 'run-product-rejected-1',
    });

    expect(result.setup.status).toBe('failed');
    expect(connector.provisionCalls).toBe(1);

    expectAllReviewRecords(result.outcomes);
    // The sharpest assertion in this file: the product said no, and it
    // is still not a finding, because no participant ran.
    expectNoProductFindings(result.outcomes);

    const failure = result.setupFailures[0] as SetupFailure;
    expect(failure.cause).toBe('worldStateUnavailable');
    // The refusal is not lost. It is cited on the channel that means
    // "the product under test answered", which is a different claim
    // from "the product has a usability problem".
    const channels = failure.evidenceRefs.map((r) => r.channel).sort();
    expect(channels).toContain('productResponse');
    expect(failure.evidenceRefs.some((r) => r.summary.includes('account_already_exists'))).toBe(true);
  }, 60_000);

  it('records an unreachable environment as a harness failure with no findings', async () => {
    const identity = makeIdentity(ALICE);
    const { config } = buildHarness(root, {
      identities: [ALICE],
      // No connector and no declared plan: there was nothing to set up,
      // so the failure is entirely the harness's.
      unreachable: true,
      storeName: 'unreachable-store',
      observerFindings: [OBSERVER_FINDING],
    });
    await seedIdentities(config.cohort, [identity]);

    const result = await runEvaluation(config, {
      plan: makePlan({
        environmentId: ENV_A,
        version: '2026.10.1',
        observedAt: '2026-10-01T00:00:00.000Z',
        delivery: 'unreachable-1',
      }),
      runId: 'run-unreachable-1',
    });

    expect(result.setup.status).toBe('skipped');
    // Setup was fine; the participant could not open the target.
    expect(result.setupFailures.length).toBeGreaterThan(0);
    // `adapter.open failed: fetch failed` is the adapter reporting that
    // it never reached the target, which is `adapterError` rather than
    // the `unknown` a keyword scan would have produced.
    expect(result.setupFailures.map((f) => f.cause)).toContain('adapterError');
    expect(result.setupFailures[0]?.message).toContain('adapter.open failed');

    expectAllReviewRecords(result.outcomes);
    // Zero observations, zero findings. There is no evidence to back
    // one, so `parseFinding` would refuse it even if the observer had
    // produced a finding — and the observer produced none, because the
    // run never reached the product.
    expectNoProductFindings(result.outcomes);
    expect(result.evidence.filter((r) => r.locator.includes('observation.captured'))).toEqual([]);
  }, 60_000);

  it('keeps the two id brands structurally non-assignable at the runtime boundary', () => {
    // #61 owns this guarantee and pins it in its own unit suite; the
    // runtime re-pins it at the seam it introduces, because the seam is
    // where a `SetupFailure` and a `Finding` first sit in the same array
    // and a caller will branch on it there.
    const failure = { outcome: 'setupFailure' } as const;
    const finding = { outcome: 'productFinding' } as const;

    // @ts-expect-error a SetupFailure is not a Finding
    const wrong1: Finding = failure;
    // @ts-expect-error a Finding is not a SetupFailure
    const wrong2: SetupFailure = finding;
    // @ts-expect-error a SetupFailureId is not a FindingId
    const wrong3: FindingId = 'sf-run-1-re-1' as SetupFailure['id'];

    expect([wrong1, wrong2, wrong3]).toBeDefined();
  });
});
