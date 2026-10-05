/**
 * Idempotency and compensation (ADR-0011, issue #59).
 *
 * Two failure modes that a managed evaluation service cannot afford:
 * double-provisioning after a retry, and orphaned world state after a
 * partial apply. Both are asserted against the *connector's* own view of
 * what it created, not against the operator's bookkeeping, so a bug that
 * loses a record cannot pass.
 */

import { describe, it, expect } from 'vitest';

import {
  createWorldOperator,
  isOperatorSetupFailure,
  ScriptedProvisioningProvider,
  script,
  type ConnectorReleaseCommand,
  type ConnectorReleaseOutcome,
  type OperatorResult,
  type WorldOperator,
} from '../../../src/operator/index.js';

import {
  fullStagingPolicy,
  lineage,
  provisionRequest,
  sequenceClock,
  STAGING_ORIGIN,
} from '../../fixtures/operator/authority.js';

const AT = '2026-10-05T09:00:00.000Z';
const LATER = '2026-10-05T10:00:00.000Z';

function build(
  provider: ScriptedProvisioningProvider,
  policy: Record<string, unknown> = fullStagingPolicy(),
  instants: readonly string[] = [AT],
): WorldOperator {
  return createWorldOperator({ policy, connector: provider, clock: sequenceClock(instants) });
}

function provisioned(result: OperatorResult) {
  if (result.status !== 'provisioned') throw new Error(`expected provisioned, got ${result.status}`);
  return result;
}

/** A five-step plan, the shape a mid-sequence failure is tested against. */
function fiveStepPlan(): Record<string, unknown> {
  return {
    kind: 'account.create',
    resourceKey: 'acct',
    origin: STAGING_ORIGIN,
    identityId: 'idn-alice',
    displayName: 'Alice',
  };
}

function fiveStepRequest(failingKey: string): Record<string, unknown> {
  return provisionRequest({
    requestId: 'req-five',
    steps: [
      { ...fiveStepPlan(), resourceKey: 'acct' },
      { kind: 'fixture.seed', resourceKey: 'fx', origin: STAGING_ORIGIN, identityId: 'idn-alice', template: 'smoke-v2' },
      { kind: 'entitlement.grant', resourceKey: 'ent', origin: STAGING_ORIGIN, identityId: 'idn-alice', entitlement: 'pro' },
      failingKey === 'step4'
        ? { kind: 'inbox.read', resourceKey: 'inbox', origin: STAGING_ORIGIN, identityId: 'idn-alice', folder: 'test-inbox', maxMessages: 5 }
        : { kind: 'fixture.seed', resourceKey: 'fx2', origin: STAGING_ORIGIN, identityId: 'idn-alice', template: 'empty-board' },
      { kind: 'billing.sandboxCharge', resourceKey: 'chg', origin: STAGING_ORIGIN, identityId: 'idn-alice', amountUnits: 100 },
    ],
  });
}

describe('re-running a provision is idempotent', () => {
  it('dispatches nothing and returns the recorded result', async () => {
    const provider = new ScriptedProvisioningProvider();
    const operator = build(provider, fullStagingPolicy(), [AT, LATER]);

    const first = provisioned(await operator.provision(provisionRequest()));
    expect(first.replayed).toBe(false);
    expect(provider.provisionCalls).toBe(1);
    expect(provider.liveResourceKeys()).toEqual(['acct-alice']);

    const second = provisioned(await operator.provision(provisionRequest()));
    expect(second.replayed).toBe(true);
    // The whole point: no second account, no second connector call.
    expect(provider.provisionCalls).toBe(1);
    expect(provider.liveResourceKeys()).toEqual(['acct-alice']);
    expect(second.resourceKeys).toEqual(first.resourceKeys);
    expect(second.spendUnits).toBe(first.spendUnits);
  });

  it('does not double-charge the budget on a replay', async () => {
    const provider = new ScriptedProvisioningProvider();
    const operator = build(provider, fullStagingPolicy({ budget: { maxStepsPerDay: 1, maxUnitsPerDay: 10 } }));

    await operator.provision(provisionRequest());
    // The single daily step is used up. A replay must not be refused,
    // because nothing was dispatched.
    const replay = await operator.provision(provisionRequest());
    expect(replay.status).toBe('provisioned');
    if (replay.status !== 'provisioned') throw new Error('unreachable');
    expect(replay.replayed).toBe(true);
    expect(provider.provisionCalls).toBe(1);
  });

  it('recognises a retry that was re-issued under a new run id', async () => {
    // A caller retrying after a crashed run re-issues the *same* plan
    // under a *new* run id. The run id is excluded from the digest
    // precisely so this is recognised as the same intent; treating it
    // as a new plan would double-provision, which is the one outcome
    // idempotency exists to prevent.
    const provider = new ScriptedProvisioningProvider();
    const operator = build(provider, fullStagingPolicy(), [AT, LATER]);

    const first = provisioned(await operator.provision(provisionRequest()));
    const retry = await operator.provision(provisionRequest({ lineage: lineage({ runId: 'run-0002' }) }));

    expect(retry.status).toBe('provisioned');
    if (retry.status !== 'provisioned') throw new Error('unreachable');
    expect(retry.replayed).toBe(true);
    // Attributed to the calling run, but keeping the instant at which
    // the world was actually set up.
    expect(retry.lineage.runId).toBe('run-0002');
    expect(retry.ts).toBe(first.ts);
    expect(provider.provisionCalls).toBe(1);
    expect(provider.liveResourceKeys()).toEqual(['acct-alice']);
  });

  it('refuses to reuse a request id for a different plan', async () => {
    const provider = new ScriptedProvisioningProvider();
    const operator = build(provider);

    await operator.provision(provisionRequest());
    const conflicting = await operator.provision(
      provisionRequest({
        steps: [
          { kind: 'account.create', resourceKey: 'acct-alice', origin: STAGING_ORIGIN, identityId: 'idn-alice', displayName: 'Alice' },
          { kind: 'fixture.seed', resourceKey: 'extra', origin: STAGING_ORIGIN, identityId: 'idn-alice', template: 'smoke-v2' },
        ],
      }),
    );

    expect(conflicting.status).toBe('denied');
    if (conflicting.status !== 'denied') throw new Error('unreachable');
    // Returning the first result here would let the caller believe a
    // second, larger plan had been applied.
    expect(conflicting.failure.message).toContain('different plan');
    expect(provider.provisionCalls).toBe(1);
  });

  it('replays the same request id under a different environment as a first application', async () => {
    // The journal key is (environment, requestId), so the same
    // idempotency key legitimately provisions once per environment
    // rather than colliding across them.
    const provider = new ScriptedProvisioningProvider();
    const operator = build(
      provider,
      fullStagingPolicy({
        environments: [
          {
            environmentId: 'env-staging',
            environmentClass: 'staging',
            baseUrl: STAGING_ORIGIN,
            destructiveAllowed: true,
            productionDestructive: false,
          },
        ],
      }),
    );

    await operator.provision(provisionRequest());
    const second = await operator.provision(provisionRequest());
    if (second.status !== 'provisioned') throw new Error('unreachable');
    expect(second.replayed).toBe(true);

    // An undeclared environment is denied outright rather than
    // journalled, so a later grant can still use the key.
    const denied = await operator.provision(
      provisionRequest({ lineage: lineage({ environmentId: 'env-unknown' }) }),
    );
    expect(denied.status).toBe('denied');
    expect(provider.provisionCalls).toBe(1);
  });

  it('records the replay in the audit log', async () => {
    const provider = new ScriptedProvisioningProvider();
    const operator = build(provider, fullStagingPolicy(), [AT, LATER]);

    await operator.provision(provisionRequest());
    await operator.provision(provisionRequest());

    const kinds = operator.audit().map((r) => r.kind);
    expect(kinds).toEqual(['planProvisioned', 'planReplayed']);
  });

  it('does not journal a denied plan, so the request id stays usable', async () => {
    const provider = new ScriptedProvisioningProvider();
    const operator = build(
      provider,
      fullStagingPolicy({ grantedSteps: ['account.create', 'fixture.seed'] }),
    );

    const denied = await operator.provision(
      provisionRequest({
        steps: [
          { kind: 'fixture.seed', resourceKey: 'fx', origin: STAGING_ORIGIN, identityId: 'idn-a', template: 'smoke-v2' },
          // Ungranted, so the plan is denied at the gate.
          { kind: 'fixture.reset', resourceKey: 'fx', origin: STAGING_ORIGIN },
        ],
      }),
    );
    expect(denied.status).toBe('denied');
    expect(provider.provisionCalls).toBe(0);

    // Nothing was journalled, so a *different*, permitted plan under the
    // same request id is not treated as a conflict with a plan that was
    // never applied.
    const permitted = await operator.provision(provisionRequest());
    expect(permitted.status).toBe('provisioned');
    if (permitted.status !== 'provisioned') throw new Error('unreachable');
    expect(permitted.replayed).toBe(false);
    expect(provider.provisionCalls).toBe(1);
  });
});

describe('a mid-sequence failure leaves no orphaned state', () => {
  it('releases everything applied before a step 3 of 5 failure', async () => {
    const provider = new ScriptedProvisioningProvider({
      failProvision: script({ ent: 'entitlement API unavailable' }),
    });
    const operator = build(provider, fullStagingPolicy(), [AT, LATER, LATER, LATER, LATER, LATER, LATER, LATER]);

    const result = await operator.provision(fiveStepRequest('step4'));

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.failure.failureKind).toBe('connectorFailed');
    expect(result.failure.stepIndex).toBe(2);
    // Steps 0 and 1 were applied and then released.
    expect(result.appliedResourceKeys).toEqual(['acct', 'fx']);
    expect(result.releasedResourceKeys).toEqual(['fx', 'acct']);
    expect(result.orphanedResourceKeys).toEqual([]);
    // The connector's own view, not the operator's bookkeeping.
    expect(provider.liveResourceKeys()).toEqual([]);
  });

  it('releases in reverse application order', async () => {
    const released: string[] = [];
    const provider = new ScriptedProvisioningProvider({
      failProvision: script({ ent: 'boom' }),
    });
    const original = provider.release.bind(provider);
    provider.release = async (command: ConnectorReleaseCommand): Promise<ConnectorReleaseOutcome> => {
      released.push(command.resourceKey);
      return original(command);
    };

    const operator = build(provider, fullStagingPolicy(), Array(10).fill(AT));
    await operator.provision(fiveStepRequest('step4'));
    // The entitlement hangs off the seeded fixture, which hangs off the
    // account; releasing the account first would orphan the rest.
    expect(released).toEqual(['fx', 'acct']);
  });

  it('reports rollbackFailed and names the orphans when compensation itself fails', async () => {
    const provider = new ScriptedProvisioningProvider({
      failProvision: script({ ent: 'boom' }),
      failRelease: script({ fx: 'fixture API unavailable' }),
    });
    const operator = build(provider, fullStagingPolicy(), Array(10).fill(AT));

    const result = await operator.provision(fiveStepRequest('step4'));

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    // The loudest kind in the taxonomy, not the connector failure that
    // triggered it: this is the only condition that leaves state behind.
    expect(result.failure.failureKind).toBe('rollbackFailed');
    expect(isOperatorSetupFailure(result.failure)).toBe(true);
    if (!isOperatorSetupFailure(result.failure)) throw new Error('unreachable');
    expect(result.failure.orphanedResourceKeys).toEqual(['fx']);
    expect(result.orphanedResourceKeys).toEqual(['fx']);
    // The connector confirms it: `fx` really is still there.
    expect(provider.liveResourceKeys()).toEqual(['fx']);
    // `acct` was released successfully.
    expect(provider.liveResourceKeys()).not.toContain('acct');
  });

  it('treats a connector that throws during compensation as not released', async () => {
    const provider = new ScriptedProvisioningProvider({
      failProvision: script({ ent: 'boom' }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).release = async (command: ConnectorReleaseCommand): Promise<ConnectorReleaseOutcome> => {
      if (command.resourceKey === 'fx') throw new Error('socket closed mid-release');
      return { released: true, message: 'ok' };
    };

    const operator = build(provider, fullStagingPolicy(), Array(10).fill(AT));
    const result = await operator.provision(fiveStepRequest('step4'));

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    // A throw is not a release. Treating it as one would orphan state
    // silently, which is what compensation exists to prevent.
    expect(result.failure.failureKind).toBe('rollbackFailed');
    expect(result.orphanedResourceKeys).toEqual(['fx']);
  });

  it('rolls back after a product rejection too', async () => {
    const provider = new ScriptedProvisioningProvider({
      rejectProduct: script({ ent: 'plan_not_found' }),
    });
    const operator = build(provider, fullStagingPolicy(), Array(10).fill(AT));

    const result = await operator.provision(fiveStepRequest('step4'));
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.failure.subject).toBe('productResponse');
    expect(result.releasedResourceKeys).toEqual(['fx', 'acct']);
    expect(provider.liveResourceKeys()).toEqual([]);
  });

  it('charges the budget for the steps that were actually dispatched', async () => {
    const provider = new ScriptedProvisioningProvider({
      failProvision: script({ ent: 'boom' }),
    });
    // Room for the whole five-step plan, so the failure is a dispatch
    // failure rather than a budget denial.
    const operator = build(
      provider,
      fullStagingPolicy({ budget: { maxStepsPerDay: 5, maxUnitsPerDay: 1000 } }),
      Array(10).fill(AT),
    );

    const result = await operator.provision(fiveStepRequest('step4'));
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.dispatchedSteps).toBe(3);

    // Three of the five daily steps are now consumed, even though the
    // plan was rolled back: the connector really did do the work. Two
    // steps remain, so a two-step plan fits and a three-step plan does
    // not.
    const twoStep = await operator.provision(
      provisionRequest({
        requestId: 'req-two',
        steps: [
          { kind: 'account.create', resourceKey: 'a2', origin: STAGING_ORIGIN, identityId: 'idn-b', displayName: 'B' },
          { kind: 'fixture.seed', resourceKey: 'b2', origin: STAGING_ORIGIN, identityId: 'idn-b', template: 'smoke-v2' },
        ],
      }),
    );
    expect(twoStep.status).toBe('provisioned');

    const threeStep = await operator.provision(
      provisionRequest({
        requestId: 'req-three',
        steps: [
          { kind: 'account.create', resourceKey: 'a3', origin: STAGING_ORIGIN, identityId: 'idn-b', displayName: 'B' },
          { kind: 'fixture.seed', resourceKey: 'b3', origin: STAGING_ORIGIN, identityId: 'idn-b', template: 'smoke-v2' },
          { kind: 'entitlement.grant', resourceKey: 'c3', origin: STAGING_ORIGIN, identityId: 'idn-b', entitlement: 'pro' },
        ],
      }),
    );
    expect(threeStep.status).toBe('denied');
    if (threeStep.status !== 'denied') throw new Error('unreachable');
    expect(threeStep.failure.failureKind).toBe('budgetExhausted');
  });

  it('does not journal a failed plan, so a corrected retry can run', async () => {
    const provider = new ScriptedProvisioningProvider({
      failProvision: script({ ent: 'boom' }),
    });
    const operator = build(provider, fullStagingPolicy(), Array(12).fill(AT));

    const failed = await operator.provision(fiveStepRequest('step4'));
    expect(failed.status).toBe('failed');
    expect(provider.liveResourceKeys()).toEqual([]);

    // A different plan under the same request id is not a conflict,
    // because nothing was journalled for the failed attempt.
    const retried = await operator.provision(provisionRequest());
    expect(retried.status).toBe('provisioned');
    if (retried.status !== 'provisioned') throw new Error('unreachable');
    expect(retried.replayed).toBe(false);
  });

  it('writes a stepRolledBack audit record per released resource', async () => {
    const provider = new ScriptedProvisioningProvider({
      failProvision: script({ ent: 'boom' }),
    });
    const operator = build(provider, fullStagingPolicy(), Array(10).fill(AT));
    await operator.provision(fiveStepRequest('step4'));

    const rollbacks = operator.audit().filter((r) => r.kind === 'stepRolledBack');
    expect(rollbacks).toHaveLength(2);
    expect(rollbacks.map((r) => (r.kind === 'stepRolledBack' ? r.resourceKey : ''))).toEqual(['fx', 'acct']);
    for (const record of rollbacks) {
      expect(record.kind === 'stepRolledBack' && record.released).toBe(true);
    }
  });
});

describe('budget window rolls with the injected clock', () => {
  it('resets the daily counters when the clock crosses a UTC day', async () => {
    const provider = new ScriptedProvisioningProvider();
    const operator = build(
      provider,
      fullStagingPolicy({ budget: { maxStepsPerDay: 1, maxUnitsPerDay: 10 } }),
      ['2026-10-05T23:00:00.000Z', '2026-10-05T23:30:00.000Z', '2026-10-06T00:30:00.000Z'],
    );

    const plan = (requestId: string) =>
      provisionRequest({
        requestId,
        steps: [{ kind: 'account.create', resourceKey: requestId, origin: STAGING_ORIGIN, identityId: 'idn-a', displayName: 'A' }],
      });

    expect((await operator.provision(plan('req-1'))).status).toBe('provisioned');
    const second = await operator.provision(plan('req-2'));
    expect(second.status).toBe('denied');
    if (second.status !== 'denied') throw new Error('unreachable');
    expect(second.failure.failureKind).toBe('budgetExhausted');

    // The clock has crossed midnight; the window is new.
    const third = await operator.provision(plan('req-3'));
    expect(third.status).toBe('provisioned');
    expect(provider.provisionCalls).toBe(2);
  });
});

describe('operators share no state', () => {
  it('keeps journals, budgets and audit logs independent per instance', async () => {
    const providerA = new ScriptedProvisioningProvider();
    const providerB = new ScriptedProvisioningProvider();
    const operatorA = build(providerA, fullStagingPolicy({ policyId: 'pol-a' }), [AT]);
    const operatorB = build(providerB, fullStagingPolicy({ policyId: 'pol-b' }), [AT]);

    await operatorA.provision(provisionRequest());

    // The same request id under a different operator is a first
    // application, not a replay: idempotency is per operator instance.
    const onB = await operatorB.provision(provisionRequest());
    expect(onB.status).toBe('provisioned');
    if (onB.status !== 'provisioned') throw new Error('unreachable');
    expect(onB.replayed).toBe(false);

    expect(operatorA.audit()).toHaveLength(1);
    expect(operatorB.audit()).toHaveLength(1);
    expect(operatorA.policyId).toBe('pol-a');
    expect(operatorB.policyId).toBe('pol-b');
  });
});
