/**
 * End-to-end operator behaviour against the deterministic scripted
 * provider (ADR-0011, issue #59).
 *
 * The rule these tests exist to pin: **a denial dispatches nothing.**
 * Every negative case asserts `provider.provisionCalls === 0`, because
 * "rejected before any connector call" is a claim about the world, not
 * about a return value.
 */

import { describe, it, expect } from 'vitest';

import {
  createWorldOperator,
  isOperatorProductFailure,
  isOperatorSetupFailure,
  isSetupProjection,
  OPERATOR_AUDIT_KINDS,
  projectOperatorFailure,
  ScriptedProvisioningProvider,
  script,
  type OperatorCleanupResult,
  type OperatorResult,
  type OperatorProvisionedResult,
  type WorldOperator,
} from '../../../src/operator/index.js';

import {
  fixedClock,
  FOREIGN_ORIGIN,
  fullStagingPolicy,
  lineage,
  minimalPolicy,
  productionGrant,
  PRODUCTION_ORIGIN,
  provisionRequest,
  STAGING_ORIGIN,
  stagingGrant,
} from '../../fixtures/operator/authority.js';

const AT = '2026-10-05T09:00:00.000Z';

interface Harness {
  readonly operator: WorldOperator;
  readonly provider: ScriptedProvisioningProvider;
}

function harness(
  policy: Record<string, unknown> = fullStagingPolicy(),
  provider: ScriptedProvisioningProvider = new ScriptedProvisioningProvider(),
): Harness {
  return {
    operator: createWorldOperator({ policy, connector: provider, clock: fixedClock(AT) }),
    provider,
  };
}

function provisioned(result: OperatorResult): OperatorProvisionedResult {
  if (result.status !== 'provisioned') {
    throw new Error(`expected provisioned, received ${result.status}: ${JSON.stringify(result)}`);
  }
  return result;
}

describe('account provisioning', () => {
  it('creates a test account and reports the lineage it acted under', async () => {
    const { operator, provider } = harness();
    const result = provisioned(await operator.provision(provisionRequest()));

    expect(result.status).toBe('provisioned');
    expect(result.dispatchedSteps).toBe(1);
    expect(result.replayed).toBe(false);
    expect(result.resourceKeys).toEqual(['acct-alice']);
    expect(provider.liveResourceKeys()).toEqual(['acct-alice']);
    expect(provider.provisionCalls).toBe(1);

    // Every one of the four durable identities plus the run is present on
    // the result, so the action is attributable without the audit log.
    expect(result.lineage).toEqual({
      productId: 'prd-task-tracker',
      environmentId: 'env-staging',
      cohortId: 'coh-returning',
      programId: 'rp-staging-continuous',
      runId: 'run-0001',
    });
  });

  it('records the declared authority that permitted the action', async () => {
    const { operator } = harness();
    const result = provisioned(await operator.provision(provisionRequest()));

    expect(result.authority).toMatchObject({
      policyId: 'pol-staging',
      environmentId: 'env-staging',
      environmentClass: 'staging',
      stepKind: 'account.create',
      risk: 'mutating',
      realMoney: 'denied',
    });
  });

  it('writes an audit record carrying lineage, program scope and authority for the plan', async () => {
    const { operator } = harness();
    await operator.provision(provisionRequest());

    const audit = operator.audit();
    expect(audit).toHaveLength(1);
    const record = audit[0]!;
    expect(OPERATOR_AUDIT_KINDS).toContain(record.kind);
    expect(record.kind).toBe('planProvisioned');
    expect(record.lineage.environmentId).toBe('env-staging');
    expect(record.authority.policyId).toBe('pol-staging');
    expect(record.connectorId).toBe('scripted');
    // The cross-environment program scope, from #57's `programKey`: the
    // durable scope excluding the environment, which is the axis a
    // release transition varies along.
    expect(record.programScope).toBe('prd-task-tracker|coh-returning|rp-staging-continuous');
  });

  it('gives the same program scope for two environments of one program', async () => {
    // This is what makes a release-transition setup log joinable: the
    // two deployments differ in `environmentId` and nothing else.
    const { operator } = harness(
      fullStagingPolicy({
        environments: [stagingGrant(), productionGrant({ destructiveAllowed: true })],
      }),
    );
    await operator.provision(provisionRequest({ requestId: 'req-staging' }));
    await operator.provision(
      provisionRequest({
        requestId: 'req-production',
        lineage: lineage({ environmentId: 'env-production' }),
        steps: [
          {
            kind: 'account.create',
            resourceKey: 'acct-alice',
            origin: PRODUCTION_ORIGIN,
            identityId: 'idn-alice',
            displayName: 'Alice',
          },
        ],
      }),
    );

    const scopes = operator.audit().map((r) => r.programScope);
    expect(scopes).toHaveLength(2);
    expect(scopes[0]).toBe(scopes[1]);
  });
});

describe('entitlement setup and billing', () => {
  it('grants an entitlement as part of the same plan', async () => {
    const { operator, provider } = harness();
    const result = provisioned(
      await operator.provision(
        provisionRequest({
          steps: [
            {
              kind: 'account.create',
              resourceKey: 'acct-alice',
              origin: STAGING_ORIGIN,
              identityId: 'idn-alice',
              displayName: 'Alice',
            },
            {
              kind: 'entitlement.grant',
              resourceKey: 'ent-alice',
              origin: STAGING_ORIGIN,
              identityId: 'idn-alice',
              entitlement: 'pro',
            },
          ],
        }),
      ),
    );
    expect(result.resourceKeys).toEqual(['acct-alice', 'ent-alice']);
    expect(provider.liveResourceKeys()).toEqual(['acct-alice', 'ent-alice']);
  });

  it('runs a sandbox charge under a real-money-denied policy', async () => {
    const { operator } = harness();
    const result = provisioned(
      await operator.provision(
        provisionRequest({
          steps: [
            {
              kind: 'billing.sandboxCharge',
              resourceKey: 'chg-1',
              origin: STAGING_ORIGIN,
              identityId: 'idn-alice',
              amountUnits: 500,
            },
          ],
        }),
      ),
    );
    // Sandbox billing is a `mutating` step; real money is a different
    // kind entirely, so denying real money does not block it.
    expect(result.authority.realMoney).toBe('denied');
    expect(result.authority.stepKind).toBe('billing.sandboxCharge');
  });

  it('refuses a real charge and dispatches nothing', async () => {
    const { operator, provider } = harness(
      fullStagingPolicy({ grantedSteps: [...fullStagingPolicy()['grantedSteps'] as string[], 'billing.realCharge'], maxRisk: 'external' }),
    );
    const result = await operator.provision(
      provisionRequest({
        steps: [
          {
            kind: 'billing.realCharge',
            resourceKey: 'chg-real',
            origin: STAGING_ORIGIN,
            identityId: 'idn-alice',
            amountUnits: 5000,
          },
        ],
      }),
    );

    expect(result.status).toBe('denied');
    if (result.status !== 'denied') throw new Error('unreachable');
    expect(result.dispatchedSteps).toBe(0);
    expect(result.failure.failureKind).toBe('authorityDenied');
    expect(result.failure.message).toContain('realMoney.mode');
    expect(provider.provisionCalls).toBe(0);
    expect(provider.liveResourceKeys()).toEqual([]);
  });
});

describe('least privilege — the caller cannot exceed its authority', () => {
  it('refuses a step kind outside grantedSteps and dispatches nothing', async () => {
    const { operator, provider } = harness(minimalPolicy());
    const result = await operator.provision(
      provisionRequest({
        steps: [
          {
            kind: 'entitlement.grant',
            resourceKey: 'ent',
            origin: STAGING_ORIGIN,
            identityId: 'idn-alice',
            entitlement: 'pro',
          },
        ],
      }),
    );
    expect(result.status).toBe('denied');
    if (result.status !== 'denied') throw new Error('unreachable');
    expect(result.failure.failureKind).toBe('authorityDenied');
    expect(result.dispatchedSteps).toBe(0);
    expect(provider.provisionCalls).toBe(0);
  });

  it('refuses a step above the risk ceiling even when the kind is granted', async () => {
    const { operator, provider } = harness(
      minimalPolicy({ grantedSteps: ['account.create', 'fixture.reset'], maxRisk: 'mutating' }),
    );
    const result = await operator.provision(
      provisionRequest({
        steps: [
          { kind: 'account.create', resourceKey: 'fx', origin: STAGING_ORIGIN, identityId: 'idn-a', displayName: 'A' },
          { kind: 'fixture.reset', resourceKey: 'fx', origin: STAGING_ORIGIN },
        ],
      }),
    );
    expect(result.status).toBe('denied');
    if (result.status !== 'denied') throw new Error('unreachable');
    expect(result.failure.failureKind).toBe('riskNotPermitted');
    // The permitted first step was not applied either: authorisation
    // runs over the whole plan before the first dispatch.
    expect(provider.provisionCalls).toBe(0);
  });

  it('refuses an undeclared environment and dispatches nothing', async () => {
    const { operator, provider } = harness();
    const result = await operator.provision(provisionRequest({ lineage: lineage({ environmentId: 'env-unknown' }) }));
    expect(result.status).toBe('denied');
    if (result.status !== 'denied') throw new Error('unreachable');
    expect(result.failure.message).toContain('not declared');
    expect(result.authority.environmentClass).toBe('undeclared');
    expect(provider.provisionCalls).toBe(0);
  });

  it('refuses a step that crosses to a foreign origin and dispatches nothing', async () => {
    const { operator, provider } = harness();
    const result = await operator.provision(
      provisionRequest({
        steps: [
          {
            kind: 'account.create',
            resourceKey: 'acct-alice',
            origin: FOREIGN_ORIGIN,
            identityId: 'idn-alice',
            displayName: 'Alice',
          },
        ],
      }),
    );
    expect(result.status).toBe('denied');
    expect(provider.provisionCalls).toBe(0);
  });

  it('refuses destructive steps in production and dispatches nothing', async () => {
    const { operator, provider } = harness(
      fullStagingPolicy({
        environments: [stagingGrant(), productionGrant({ destructiveAllowed: true })],
      }),
    );
    const result = await operator.provision(
      provisionRequest({
        lineage: lineage({ environmentId: 'env-production' }),
        steps: [
          { kind: 'account.create', resourceKey: 'fx', origin: PRODUCTION_ORIGIN, identityId: 'idn-a', displayName: 'A' },
          { kind: 'fixture.reset', resourceKey: 'fx', origin: PRODUCTION_ORIGIN },
        ],
      }),
    );
    expect(result.status).toBe('denied');
    if (result.status !== 'denied') throw new Error('unreachable');
    expect(result.failure.message).toContain('destructive in production');
    expect(provider.provisionCalls).toBe(0);
  });

  it('authorises nothing at all when grantedSteps is empty, and dispatches nothing', async () => {
    const { operator, provider } = harness(minimalPolicy({ grantedSteps: [] }));
    const result = await operator.provision(provisionRequest());
    expect(result.status).toBe('denied');
    expect(provider.provisionCalls).toBe(0);
  });

  it('refuses a plan when any one step is unauthorised, before applying the permitted ones', async () => {
    // Authorisation runs over the whole plan first, so a plan that is
    // partly permitted does not half-apply.
    const { operator, provider } = harness(minimalPolicy());
    const result = await operator.provision(
      provisionRequest({
        steps: [
          {
            kind: 'account.create',
            resourceKey: 'acct-alice',
            origin: STAGING_ORIGIN,
            identityId: 'idn-alice',
            displayName: 'Alice',
          },
          {
            kind: 'account.retire',
            resourceKey: 'acct-alice',
            origin: STAGING_ORIGIN,
          },
        ],
      }),
    );
    expect(result.status).toBe('denied');
    expect(provider.provisionCalls).toBe(0);
    expect(provider.liveResourceKeys()).toEqual([]);
  });
});

describe('budget is enforced before dispatch', () => {
  it('refuses a plan that would exceed the daily step bound and dispatches nothing', async () => {
    const { operator, provider } = harness(
      fullStagingPolicy({ budget: { maxStepsPerDay: 2, maxUnitsPerDay: 1000 } }),
    );
    const result = await operator.provision(
      provisionRequest({
        steps: [
          { kind: 'account.create', resourceKey: 'a', origin: STAGING_ORIGIN, identityId: 'idn-a', displayName: 'A' },
          { kind: 'fixture.seed', resourceKey: 'b', origin: STAGING_ORIGIN, identityId: 'idn-a', template: 'smoke-v2' },
          { kind: 'fixture.seed', resourceKey: 'c', origin: STAGING_ORIGIN, identityId: 'idn-a', template: 'smoke-v2' },
        ],
      }),
    );
    expect(result.status).toBe('denied');
    if (result.status !== 'denied') throw new Error('unreachable');
    expect(result.failure.failureKind).toBe('budgetExhausted');
    expect(result.failure.detail['unit']).toBe('stepsPerDay');
    expect(provider.provisionCalls).toBe(0);
  });

  it('refuses a plan that would exceed the daily unit bound and dispatches nothing', async () => {
    const { operator, provider } = harness(
      fullStagingPolicy({ budget: { maxStepsPerDay: 100, maxUnitsPerDay: 2 } }),
    );
    const result = await operator.provision(
      provisionRequest({
        steps: [
          { kind: 'fixture.seed', resourceKey: 'a', origin: STAGING_ORIGIN, identityId: 'idn-a', template: 'smoke-v2' },
          { kind: 'fixture.seed', resourceKey: 'b', origin: STAGING_ORIGIN, identityId: 'idn-a', template: 'smoke-v2' },
        ],
      }),
    );
    expect(result.status).toBe('denied');
    if (result.status !== 'denied') throw new Error('unreachable');
    expect(result.failure.detail['unit']).toBe('unitsPerDay');
    expect(provider.provisionCalls).toBe(0);
  });

  it('exhausts the budget across successive plans', async () => {
    const { operator, provider } = harness(
      fullStagingPolicy({ budget: { maxStepsPerDay: 2, maxUnitsPerDay: 1000 } }),
    );
    const plan = (requestId: string) =>
      provisionRequest({
        requestId,
        steps: [{ kind: 'account.create', resourceKey: `acct-${requestId}`, origin: STAGING_ORIGIN, identityId: 'idn-a', displayName: 'A' }],
      });

    expect((await operator.provision(plan('req-a'))).status).toBe('provisioned');
    expect((await operator.provision(plan('req-b'))).status).toBe('provisioned');
    const third = await operator.provision(plan('req-c'));
    expect(third.status).toBe('denied');
    if (third.status !== 'denied') throw new Error('unreachable');
    expect(third.failure.failureKind).toBe('budgetExhausted');
    // Exactly the two permitted plans were dispatched.
    expect(provider.provisionCalls).toBe(2);
  });

  it('applies the real-money bound separately from the general budget', async () => {
    const { operator, provider } = harness(
      fullStagingPolicy({
        grantedSteps: ['billing.realCharge'],
        maxRisk: 'external',
        realMoney: { mode: 'enabled', maxUnitsPerDay: 100, allowProduction: false },
        budget: { maxStepsPerDay: 100, maxUnitsPerDay: 100_000 },
      }),
    );
    const result = await operator.provision(
      provisionRequest({
        steps: [
          { kind: 'billing.realCharge', resourceKey: 'chg', origin: STAGING_ORIGIN, identityId: 'idn-a', amountUnits: 500 },
        ],
      }),
    );
    expect(result.status).toBe('denied');
    if (result.status !== 'denied') throw new Error('unreachable');
    // The general budget had room; only the real-money bound refused.
    expect(result.failure.detail['unit']).toBe('realMoneyUnitsPerDay');
    expect(provider.provisionCalls).toBe(0);
  });
});

describe('fail closed on unknown or missing input', () => {
  it('rejects an unknown request field instead of dropping it', async () => {
    const { operator, provider } = harness();
    const result = await operator.provision(provisionRequest({ escalate: true }));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.failure.failureKind).toBe('invalidRequest');
    expect(result.failure.message).toContain('unknown field');
    expect(provider.provisionCalls).toBe(0);
  });

  it('rejects an unknown step field instead of dropping it', async () => {
    const { operator, provider } = harness();
    const result = await operator.provision(
      provisionRequest({
        steps: [
          {
            kind: 'account.create',
            resourceKey: 'acct-alice',
            origin: STAGING_ORIGIN,
            identityId: 'idn-alice',
            displayName: 'Alice',
            password: 'hunter2',
          },
        ],
      }),
    );
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.failure.message).toContain('password');
    expect(provider.provisionCalls).toBe(0);
  });

  it('rejects a real-identity handle, because the vocabulary has no slot for one', async () => {
    const { operator, provider } = harness();
    const result = await operator.provision(
      provisionRequest({
        steps: [
          {
            kind: 'account.create',
            resourceKey: 'acct-alice',
            origin: STAGING_ORIGIN,
            identityId: 'idn-alice',
            displayName: 'Alice',
            email: 'real.person@example.com',
          },
        ],
      }),
    );
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.failure.message).toContain('email');
    expect(provider.provisionCalls).toBe(0);
  });

  it('rejects a missing lineage rather than defaulting one', async () => {
    const { operator, provider } = harness();
    const raw = provisionRequest();
    delete raw['lineage'];
    const result = await operator.provision(raw);
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.failure.message).toContain('lineage');
    expect(provider.provisionCalls).toBe(0);
  });

  it('rejects a missing requestId rather than generating one', async () => {
    const { operator, provider } = harness();
    const raw = provisionRequest();
    delete raw['requestId'];
    const result = await operator.provision(raw);
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.failure.message).toContain('requestId');
    expect(provider.provisionCalls).toBe(0);
  });

  it('rejects a malformed durable id rather than accepting a raw string', async () => {
    const { operator } = harness();
    const result = await operator.provision(
      provisionRequest({
        steps: [
          {
            kind: 'account.create',
            resourceKey: 'acct-alice',
            origin: STAGING_ORIGIN,
            // Not a branded SyntheticIdentityId.
            identityId: 'alice',
            displayName: 'Alice',
          },
        ],
      }),
    );
    expect(result.status).toBe('rejected');
  });

  it('rejects a step that consumes a resource no earlier step produces', async () => {
    const { operator, provider } = harness();
    const result = await operator.provision(
      provisionRequest({
        steps: [{ kind: 'account.retire', resourceKey: 'acct-alice', origin: STAGING_ORIGIN }],
      }),
    );
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.failure.message).toContain('no earlier step produces');
    expect(provider.provisionCalls).toBe(0);
  });

  it('rejects duplicate resource keys within one plan', async () => {
    const { operator, provider } = harness();
    const result = await operator.provision(
      provisionRequest({
        steps: [
          { kind: 'account.create', resourceKey: 'same', origin: STAGING_ORIGIN, identityId: 'idn-a', displayName: 'A' },
          { kind: 'fixture.seed', resourceKey: 'same', origin: STAGING_ORIGIN, identityId: 'idn-a', template: 'smoke-v2' },
        ],
      }),
    );
    expect(result.status).toBe('rejected');
    expect(provider.provisionCalls).toBe(0);
  });
});

describe('setup failure versus product outcome', () => {
  it('reports a connector failure as an operatorSetup failure', async () => {
    const provider = new ScriptedProvisioningProvider({
      failProvision: script({ 'acct-alice': 'upstream test-support API timed out' }),
    });
    const { operator } = harness(fullStagingPolicy(), provider);
    const result = await operator.provision(provisionRequest());

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(isOperatorSetupFailure(result.failure)).toBe(true);
    expect(isOperatorProductFailure(result.failure)).toBe(false);
    expect(result.failure.subject).toBe('operatorSetup');
    expect(result.failure.failureKind).toBe('connectorFailed');
  });

  it("reports the product's own refusal as a productResponse, not a setup failure", async () => {
    const provider = new ScriptedProvisioningProvider({
      rejectProduct: script({ 'acct-alice': 'account_already_exists' }),
    });
    const { operator } = harness(fullStagingPolicy(), provider);
    const result = await operator.provision(provisionRequest());

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(isOperatorProductFailure(result.failure)).toBe(true);
    expect(isOperatorSetupFailure(result.failure)).toBe(false);
    expect(result.failure.subject).toBe('productResponse');
    if (!isOperatorProductFailure(result.failure)) throw new Error('unreachable');
    expect(result.failure.productCode).toBe('account_already_exists');
  });

  it('projects the two failures into different evidence channels', async () => {
    const setupProvider = new ScriptedProvisioningProvider({
      failProvision: script({ 'acct-alice': 'connector exploded' }),
    });
    const setupResult = await harness(fullStagingPolicy(), setupProvider).operator.provision(provisionRequest());
    if (setupResult.status !== 'failed') throw new Error('unreachable');
    const setupProjection = projectOperatorFailure(setupResult.failure);

    const productProvider = new ScriptedProvisioningProvider({
      rejectProduct: script({ 'acct-alice': 'account_already_exists' }),
    });
    const productResult = await harness(fullStagingPolicy(), productProvider).operator.provision(provisionRequest());
    if (productResult.status !== 'failed') throw new Error('unreachable');
    const productProjection = projectOperatorFailure(productResult.failure);

    expect(setupProjection.channel).toBe('runtimeError');
    expect(productProjection.channel).toBe('productSignal');
    // The predicate is what a downstream router would use, and it
    // discriminates the two the same way the projection does.
    expect(isSetupProjection(setupProjection)).toBe(true);
    expect(isSetupProjection(productProjection)).toBe(false);
    if (setupProjection.channel !== 'runtimeError' || productProjection.channel !== 'productSignal') {
      throw new Error('unreachable');
    }
    // The setup projection carries the existing runtime-error shape, so
    // it can be recorded beside a run's other runtime errors without
    // widening the shared evidence contract.
    expect(setupProjection.ts).toBe(AT);
    expect(setupProjection.where).toBe('operator.provision.steps[0]');
    expect(typeof setupProjection.message).toBe('string');
  });
});

describe('cleanup lifecycle', () => {
  it('releases every resource a plan created', async () => {
    const { operator, provider } = harness();
    await operator.provision(provisionRequest());
    expect(provider.liveResourceKeys()).toEqual(['acct-alice']);

    const cleanup = (await operator.cleanup({ requestId: 'req-setup-1', lineage: lineage() })) as Extract<
      OperatorCleanupResult,
      { status: 'cleaned' }
    >;
    expect(cleanup.status).toBe('cleaned');
    expect(cleanup.releasedResourceKeys).toEqual(['acct-alice']);
    expect(cleanup.unresolvedResourceKeys).toEqual([]);
    expect(provider.liveResourceKeys()).toEqual([]);
    expect(cleanup.lineage.environmentId).toBe('env-staging');
  });

  it('cleans up a multi-step plan in reverse application order', async () => {
    const { operator, provider } = harness();
    await operator.provision(
      provisionRequest({
        steps: [
          { kind: 'account.create', resourceKey: 'acct', origin: STAGING_ORIGIN, identityId: 'idn-a', displayName: 'A' },
          { kind: 'fixture.seed', resourceKey: 'fx', origin: STAGING_ORIGIN, identityId: 'idn-a', template: 'smoke-v2' },
          { kind: 'entitlement.grant', resourceKey: 'ent', origin: STAGING_ORIGIN, identityId: 'idn-a', entitlement: 'pro' },
        ],
      }),
    );
    const cleanup = await operator.cleanup({ requestId: 'req-setup-1', lineage: lineage() });
    expect(cleanup.status).toBe('cleaned');
    if (cleanup.status !== 'cleaned') throw new Error('unreachable');
    // Reverse order is what a dependent resource requires: the
    // entitlement and fixture are released before the account they hang off.
    expect(cleanup.releasedResourceKeys).toEqual(['ent', 'fx', 'acct']);
    expect(provider.liveResourceKeys()).toEqual([]);
  });

  it('refuses cleanup when the environment has not allowed destructive steps', async () => {
    const { operator, provider } = harness(
      fullStagingPolicy({ environments: [stagingGrant({ destructiveAllowed: false })] }),
    );
    await operator.provision(provisionRequest());
    const before = provider.releaseCalls;

    const cleanup = await operator.cleanup({ requestId: 'req-setup-1', lineage: lineage() });
    expect(cleanup.status).toBe('denied');
    if (cleanup.status !== 'denied') throw new Error('unreachable');
    expect(cleanup.dispatchedSteps).toBe(0);
    // Cleanup is destructive and goes through the same gate; an
    // ungated "admin" path would have released it here.
    expect(provider.releaseCalls).toBe(before);
  });

  it('refuses cleanup in production without the production opt-in', async () => {
    const { operator, provider } = harness(
      fullStagingPolicy({ environments: [stagingGrant(), productionGrant({ destructiveAllowed: true })] }),
    );
    const cleanup = await operator.cleanup({
      requestId: 'req-setup-1',
      lineage: lineage({ environmentId: 'env-production' }),
    });
    expect(cleanup.status).toBe('denied');
    expect(provider.releaseCalls).toBe(0);
  });

  it('reports a partially cleaned world as rollbackFailed with the unresolved keys', async () => {
    const provider = new ScriptedProvisioningProvider({ failRelease: script({ 'ent': 'entitlement API unavailable' }) });
    const { operator } = harness(fullStagingPolicy(), provider);
    await operator.provision(
      provisionRequest({
        steps: [
          { kind: 'account.create', resourceKey: 'acct', origin: STAGING_ORIGIN, identityId: 'idn-a', displayName: 'A' },
          { kind: 'entitlement.grant', resourceKey: 'ent', origin: STAGING_ORIGIN, identityId: 'idn-a', entitlement: 'pro' },
        ],
      }),
    );

    const cleanup = await operator.cleanup({ requestId: 'req-setup-1', lineage: lineage() });
    expect(cleanup.status).toBe('partiallyCleaned');
    if (cleanup.status !== 'partiallyCleaned') throw new Error('unreachable');
    expect(cleanup.unresolvedResourceKeys).toEqual(['ent']);
    expect(cleanup.releasedResourceKeys).toEqual(['acct']);
    expect(cleanup.failure.failureKind).toBe('rollbackFailed');
    expect(cleanup.failure.subject).toBe('operatorSetup');
    // The connector's own state confirms the world still holds it.
    expect(provider.liveResourceKeys()).toEqual(['ent']);
  });

  it('rejects a cleanup request for an unknown request id without touching the connector', async () => {
    const { operator, provider } = harness();
    const cleanup = await operator.cleanup({ requestId: 'req-never-ran', lineage: lineage() });
    expect(cleanup.status).toBe('cleaned');
    if (cleanup.status !== 'cleaned') throw new Error('unreachable');
    expect(cleanup.releasedResourceKeys).toEqual([]);
    expect(provider.releaseCalls).toBe(0);
  });

  it('rejects a malformed cleanup request', async () => {
    const { operator, provider } = harness();
    const cleanup = await operator.cleanup({ requestId: 'req-setup-1', lineage: lineage(), force: true });
    expect(cleanup.status).toBe('rejected');
    expect(provider.releaseCalls).toBe(0);
  });
});

describe('the provider is deterministic', () => {
  it('produces identical handles and values for the same plan', async () => {
    const first = new ScriptedProvisioningProvider();
    const second = new ScriptedProvisioningProvider();
    const a = provisioned(await harness(fullStagingPolicy(), first).operator.provision(provisionRequest()));
    const b = provisioned(await harness(fullStagingPolicy(), second).operator.provision(provisionRequest()));
    expect(a.resourceKeys).toEqual(b.resourceKeys);
    expect(a.spendUnits).toEqual(b.spendUnits);
    expect(first.provisionCalls).toBe(second.provisionCalls);
  });

  it('reads a test inbox without creating durable state', async () => {
    const { operator, provider } = harness();
    const result = provisioned(
      await operator.provision(
        provisionRequest({
          steps: [
            {
              kind: 'inbox.read',
              resourceKey: 'inbox',
              origin: STAGING_ORIGIN,
              identityId: 'idn-alice',
              folder: 'test-inbox',
              maxMessages: 10,
            },
          ],
        }),
      ),
    );
    // A read has nothing to compensate, so it is not tracked as a live
    // resource and rollback would never try to undo it.
    expect(result.resourceKeys).toEqual([]);
    expect(provider.liveResourceKeys()).toEqual([]);
  });
});
