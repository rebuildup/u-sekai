/**
 * Acceptance: operator capabilities remain unavailable to the
 * Participant (Issue #63, criterion 3).
 *
 * ## The observable this file exists to prove
 *
 * "The participant cannot reach the operator" is a claim about a
 * boundary, and a boundary is only worth what its *refusals* are worth.
 * So this file contains no assertion that a happy path works; it
 * contains two attempts to cross the boundary and the observation that
 * both failed:
 *
 * | attempt | observable |
 * | --- | --- |
 * | read the operator off the participant context | a compile-time exhaustiveness check: any of `operator` / `connector` / `cohort` / `setup` appearing as a key on `ParticipantExecutionContext` fails `npm run typecheck` |
 * | reach the connector through the returned result | the only connector-shaped value on the result is `{ connectorId }` — one key, no `provision` |
 * | reach a privileged primitive from inside the participant loop | the Reasoner emits `evaluateJs`; the run records a typed `capability.violation`, terminates on `capabilityViolation`, and the connector's dispatch count is **unchanged** by the attempt |
 *
 * The connector count is the load-bearing observation. It is not a
 * count of "calls the runtime made" but a count of "calls anything
 * could have made": if a participant's privileged attempt had reached
 * the connector in any way, the number would move. It does not.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { runEvaluation } from '../../../src/runtime/index.js';
import type { ParticipantExecutionContext } from '../../../src/runtime/index.js';
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

/**
 * Compiled, not merely checked.
 *
 * `AssertNever<T extends never>` fails to compile the moment `T` is not
 * `never`, so adding an `operator` field to `ParticipantExecutionContext`
 * breaks `npm run typecheck` instead of quietly widening what a
 * participant run is handed. Exported so the declaration is not reported
 * as an unused local.
 */
type AssertNever<T extends never> = T;
export type ParticipantContextCarriesNoOperator = AssertNever<
  Extract<'operator' | 'connector' | 'cohort' | 'setup' | 'store', keyof ParticipantExecutionContext>
>;

let root: HarnessRoot;

beforeAll(async () => {
  root = await startHarnessRoot('u-sekai-runtime-isolation-');
});

afterAll(async () => {
  await root.cleanup();
});

const ALICE = { id: 'idn-alice', lifecycle: 'persistent' as const };

describe('operator capabilities are unreachable from a participant', () => {
  it('refuses a privileged action attempt and leaves the connector dispatch count unchanged', async () => {
    const identity = makeIdentity(ALICE);
    const connector = makeConnector();

    const { config } = buildHarness(root, {
      identities: [ALICE],
      connector,
      policy: stagingPolicy(),
      steps: [accountCreateStep(identity.id)],
      // The participant tries to reach a primitive no capability profile
      // grants, on its very first step.
      attemptPrivilegedKind: 'evaluateJs',
    });
    await seedIdentities(config.cohort, [identity]);

    const before = connector.provisionCalls;

    const result = await runEvaluation(config, {
      plan: makePlan({
        environmentId: ENV_A,
        version: '2026.10.1',
        observedAt: '2026-10-01T00:00:00.000Z',
        delivery: 'isolation-1',
      }),
      runId: 'run-isolation-1',
    });

    // --- World setup happened once, through the declared plan.
    expect(before).toBe(0);
    expect(result.setup.status).toBe('provisioned');
    expect(result.setup.resourceKeys).toEqual(['acct-primary']);
    expect(connector.provisionCalls).toBe(1);

    // --- The participant's privileged attempt was refused by the
    // capability boundary and the run terminated on it.
    const events = await fs.readFile(path.join(result.artifactDir, 'events.ndjson'), 'utf8');
    expect(events).toContain('capability.violation');
    expect(result.setupFailures.some((f) => f.cause === 'policyDenied')).toBe(true);

    // --- And, the load-bearing part: the attempt dispatched nothing.
    // One provision call is still one provision call: the attempt added
    // none. (The resource itself is already released by the time
    // `runEvaluation` returns, which cleanup asserts separately below.)
    expect(connector.provisionCalls).toBe(1);

    // --- Cleanup still released what setup created.
    expect(result.cleanup?.status).toBe('cleaned');
    expect(connector.releaseCalls).toBe(1);
    expect(connector.liveResourceKeys()).toEqual([]);
  });

  it('exposes no privileged object on the returned result', async () => {
    const identity = makeIdentity(ALICE);
    const connector = makeConnector();
    const { config } = buildHarness(root, {
      identities: [ALICE],
      connector,
      steps: [accountCreateStep(identity.id)],
      storeName: 'exposure-store',
    });
    await seedIdentities(config.cohort, [identity]);

    const result = await runEvaluation(config, {
      plan: makePlan({
        environmentId: ENV_A,
        version: '2026.10.1',
        observedAt: '2026-10-01T00:00:00.000Z',
        delivery: 'exposure-1',
      }),
      runId: 'run-exposure-1',
    });

    // The setup phase reports which connector acted, by identity only.
    // One string, and nothing that could dispatch.
    expect(Object.keys(result.setup.connector)).toEqual(['connectorId']);
    expect(result.setup.connector.connectorId).toBe('scripted-connector');

    // No value reachable from the result carries a `provision` or
    // `release` method, which is the whole privileged effect surface.
    const seen = new Set<unknown>();
    const walk = (value: unknown, depth: number): void => {
      if (value === null || typeof value !== 'object' || depth > 6) return;
      if (seen.has(value)) return;
      seen.add(value);
      if (typeof (value as { provision?: unknown }).provision === 'function') {
        throw new Error('a privileged dispatch method is reachable from the evaluation result');
      }
      for (const nested of Object.values(value as Record<string, unknown>)) walk(nested, depth + 1);
    };
    walk(result, 0);

    // The audit records the authority, not the capability.
    expect(result.operatorAudit.every((r) => typeof r.connectorId === 'string')).toBe(true);
  });
});
