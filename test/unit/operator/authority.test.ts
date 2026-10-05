/**
 * The authority gate: least privilege, deny-by-default, and the
 * dangerous classes (ADR-0011, issue #59).
 *
 * These exercise `authorizeStep` directly. It is a pure function of
 * `(policy, environmentGrant, step)`, so each rule can be tested in
 * isolation without constructing an operator — and a test that a
 * *denial* dispatches nothing lives in `provisioning.test.ts`, where a
 * connector can be counted.
 */

import { describe, it, expect } from 'vitest';

import {
  authorizeStep,
  compareRisk,
  findEnvironmentGrant,
  OPERATOR_RISK_CLASSES,
  OPERATOR_STEP_KINDS,
  OPERATOR_STEP_RISK,
  OperatorError,
  operatorStepRisk,
  parseEnvironmentGrants,
  parseOperatorAuthorityPolicy,
  parseOperatorBudget,
  parseOperatorStep,
  parseRealMoneyAuthority,
  type OperatorAuthorityPolicy,
  type OperatorStep,
} from '../../../src/operator/index.js';

import {
  FOREIGN_ORIGIN,
  fullStagingPolicy,
  minimalPolicy,
  productionGrant,
  PRODUCTION_ORIGIN,
  STAGING_ORIGIN,
  stagingGrant,
} from '../../fixtures/operator/authority.js';

function policy(overrides: Record<string, unknown> = {}): OperatorAuthorityPolicy {
  return parseOperatorAuthorityPolicy(minimalPolicy(overrides));
}

function grantOf(p: OperatorAuthorityPolicy, environmentId = 'env-staging') {
  const grant = findEnvironmentGrant(p, environmentId);
  if (grant === undefined) throw new Error(`expected a grant for ${environmentId}`);
  return grant;
}

function step(input: Record<string, unknown>): OperatorStep {
  return parseOperatorStep(input);
}

describe('risk classes', () => {
  it('orders sandbox below mutating below destructive below external', () => {
    expect(compareRisk('sandbox', 'mutating')).toBeLessThan(0);
    expect(compareRisk('mutating', 'destructive')).toBeLessThan(0);
    expect(compareRisk('destructive', 'external')).toBeLessThan(0);
    expect(compareRisk('external', 'sandbox')).toBeGreaterThan(0);
  });

  it('gives every step a fixed risk class the caller cannot influence', () => {
    expect(Object.keys(OPERATOR_STEP_RISK).sort()).toEqual([...OPERATOR_STEP_KINDS].sort());
    // Real money and destructive cleanup are the two classes ADR-0011
    // lists as requiring explicit narrow enablement.
    expect(operatorStepRisk('billing.realCharge')).toBe('external');
    expect(operatorStepRisk('billing.sandboxCharge')).toBe('mutating');
    expect(operatorStepRisk('account.retire')).toBe('destructive');
    expect(operatorStepRisk('inbox.read')).toBe('sandbox');
  });

  it('models real money as a distinct step kind, not a flag on a shared one', () => {
    // There is no `mode`/`live` field anywhere in the vocabulary, so
    // "sandbox" cannot be flipped to "real" by editing a value.
    for (const kind of OPERATOR_STEP_KINDS) {
      const parsed = step(
        kind === 'account.retire' || kind === 'fixture.reset' || kind === 'entitlement.revoke'
          ? { kind, resourceKey: 'r', origin: STAGING_ORIGIN }
          : kind === 'inbox.read'
            ? { kind, resourceKey: 'r', origin: STAGING_ORIGIN, identityId: 'idn-a', folder: 'test-inbox', maxMessages: 5 }
            : kind === 'account.create'
              ? { kind, resourceKey: 'r', origin: STAGING_ORIGIN, identityId: 'idn-a', displayName: 'A' }
              : kind === 'fixture.seed'
                ? { kind, resourceKey: 'r', origin: STAGING_ORIGIN, identityId: 'idn-a', template: 'smoke-v2' }
                : kind === 'entitlement.grant'
                  ? { kind, resourceKey: 'r', origin: STAGING_ORIGIN, identityId: 'idn-a', entitlement: 'pro' }
                  : { kind, resourceKey: 'r', origin: STAGING_ORIGIN, identityId: 'idn-a', amountUnits: 1 },
      );
      expect(Object.keys(parsed as object)).not.toContain('mode');
      expect(Object.keys(parsed as object)).not.toContain('live');
      expect(Object.keys(parsed as object)).not.toContain('realMoney');
    }
  });
});

describe('rule 1 — least privilege over environments', () => {
  it('refuses an environment the policy never declared', () => {
    const p = policy();
    expect(findEnvironmentGrant(p, 'env-other')).toBeUndefined();
  });

  it('grants a step kind only for declared environments, not globally', () => {
    const p = policy({ environments: [stagingGrant({ environmentId: 'env-other' })] });
    expect(findEnvironmentGrant(p, 'env-staging')).toBeUndefined();
    const decision = authorizeStep(
      p,
      grantOf(p, 'env-other'),
      step({ kind: 'account.create', resourceKey: 'a', origin: STAGING_ORIGIN, identityId: 'idn-a', displayName: 'A' }),
    );
    expect(decision.permitted).toBe(true);
    // Same policy, same granted step, undeclared environment: the
    // operator resolves no grant and therefore has no authority.
    expect(findEnvironmentGrant(p, 'env-staging')).toBeUndefined();
  });
});

describe('rule 2 — explicit opt-in', () => {
  it('refuses a step kind that is not granted', () => {
    const p = policy();
    const decision = authorizeStep(
      p,
      grantOf(p),
      step({ kind: 'entitlement.grant', resourceKey: 'ent', origin: STAGING_ORIGIN, identityId: 'idn-a', entitlement: 'pro' }),
    );
    expect(decision.permitted).toBe(false);
    if (decision.permitted) throw new Error('unreachable');
    expect(decision.failureKind).toBe('authorityDenied');
    expect(decision.message).toContain('not granted');
  });

  it('grants nothing by omission: an empty grantedSteps list denies everything', () => {
    const p = policy({ grantedSteps: [] });
    const decision = authorizeStep(
      p,
      grantOf(p),
      step({ kind: 'account.create', resourceKey: 'a', origin: STAGING_ORIGIN, identityId: 'idn-a', displayName: 'A' }),
    );
    expect(decision.permitted).toBe(false);
  });
});

describe('rules 2 and 3 — two independent guards', () => {
  it('refuses a granted destructive step when the ceiling is still mutating', () => {
    // The grant set and the ceiling are different fields, so raising
    // only the grant does not widen authority.
    const p = policy({ grantedSteps: ['fixture.reset'] });
    const decision = authorizeStep(
      p,
      grantOf(p),
      step({ kind: 'fixture.reset', resourceKey: 'fx', origin: STAGING_ORIGIN }),
    );
    expect(decision.permitted).toBe(false);
    if (decision.permitted) throw new Error('unreachable');
    expect(decision.failureKind).toBe('riskNotPermitted');
  });

  it('refuses a granted step kind whose risk is above the ceiling even when its class is lower', () => {
    const p = policy({ grantedSteps: ['billing.realCharge'], maxRisk: 'destructive' });
    const decision = authorizeStep(
      p,
      grantOf(p),
      step({ kind: 'billing.realCharge', resourceKey: 'chg', origin: STAGING_ORIGIN, identityId: 'idn-a', amountUnits: 100 }),
    );
    expect(decision.permitted).toBe(false);
    if (decision.permitted) throw new Error('unreachable');
    // `external` is above a `destructive` ceiling even though real money
    // is separately denied — the ceiling check runs first and is
    // independent of the real-money decision.
    expect(decision.failureKind).toBe('riskNotPermitted');
  });

  it('refuses an ungranted step whose risk is below the ceiling', () => {
    const p = policy({ maxRisk: 'external' });
    const decision = authorizeStep(
      p,
      grantOf(p),
      step({ kind: 'fixture.seed', resourceKey: 'fx', origin: STAGING_ORIGIN, identityId: 'idn-a', template: 'smoke-v2' }),
    );
    expect(decision.permitted).toBe(false);
    if (decision.permitted) throw new Error('unreachable');
    expect(decision.failureKind).toBe('authorityDenied');
  });
});

describe('rule 4 — destructive opt-in is per environment', () => {
  it('refuses a destructive step when the environment has not allowed destructive steps', () => {
    const p = policy({
      grantedSteps: ['fixture.reset'],
      maxRisk: 'destructive',
      environments: [stagingGrant({ destructiveAllowed: false })],
    });
    const decision = authorizeStep(
      p,
      grantOf(p),
      step({ kind: 'fixture.reset', resourceKey: 'fx', origin: STAGING_ORIGIN }),
    );
    expect(decision.permitted).toBe(false);
    if (decision.permitted) throw new Error('unreachable');
    expect(decision.message).toContain('destructive');
  });

  it('permits it once the environment states the opt-in', () => {
    const p = policy({ grantedSteps: ['fixture.reset'], maxRisk: 'destructive' });
    const decision = authorizeStep(
      p,
      grantOf(p),
      step({ kind: 'fixture.reset', resourceKey: 'fx', origin: STAGING_ORIGIN }),
    );
    expect(decision.permitted).toBe(true);
  });
});

describe('rule 5 — destructive production mutation is a separate decision', () => {
  it('refuses a destructive step in production even when destructive steps are allowed there', () => {
    const p = policy({
      grantedSteps: ['fixture.reset'],
      maxRisk: 'destructive',
      environments: [productionGrant({ destructiveAllowed: true })],
    });
    const decision = authorizeStep(
      p,
      grantOf(p, 'env-production'),
      step({ kind: 'fixture.reset', resourceKey: 'fx', origin: PRODUCTION_ORIGIN }),
    );
    expect(decision.permitted).toBe(false);
    if (decision.permitted) throw new Error('unreachable');
    expect(decision.message).toContain('destructive in production');
  });

  it('permits it only when both keys are stated', () => {
    const p = policy({
      grantedSteps: ['fixture.reset'],
      maxRisk: 'destructive',
      environments: [productionGrant({ destructiveAllowed: true, productionDestructive: true })],
    });
    const decision = authorizeStep(
      p,
      grantOf(p, 'env-production'),
      step({ kind: 'fixture.reset', resourceKey: 'fx', origin: PRODUCTION_ORIGIN }),
    );
    expect(decision.permitted).toBe(true);
  });

  it('rejects a policy that claims productionDestructive on a non-production environment', () => {
    // A grant that looks more careful than it is is refused at parse
    // time rather than silently ignored at dispatch time.
    expect(() =>
      policy({ environments: [stagingGrant({ productionDestructive: true })] }),
    ).toThrow(OperatorError);
  });
});

describe('rule 6 — real money', () => {
  const realCharge = () =>
    step({ kind: 'billing.realCharge', resourceKey: 'chg', origin: STAGING_ORIGIN, identityId: 'idn-a', amountUnits: 500 });

  it('denies real money when the policy says denied', () => {
    const p = policy({ grantedSteps: ['billing.realCharge'], maxRisk: 'external' });
    const decision = authorizeStep(p, grantOf(p), realCharge());
    expect(decision.permitted).toBe(false);
    if (decision.permitted) throw new Error('unreachable');
    expect(decision.message).toContain('realMoney.mode');
  });

  it('permits real money only with an explicit bound', () => {
    const p = policy({
      grantedSteps: ['billing.realCharge'],
      maxRisk: 'external',
      realMoney: { mode: 'enabled', maxUnitsPerDay: 1000, allowProduction: false },
    });
    const decision = authorizeStep(p, grantOf(p), realCharge());
    expect(decision.permitted).toBe(true);
    if (!decision.permitted) throw new Error('unreachable');
    expect(decision.ref.realMoney).toBe('enabled');
  });

  it('refuses real money in production when allowProduction is false', () => {
    const p = policy({
      grantedSteps: ['billing.realCharge'],
      maxRisk: 'external',
      realMoney: { mode: 'enabled', maxUnitsPerDay: 1000, allowProduction: false },
      environments: [productionGrant({ destructiveAllowed: true, productionDestructive: true })],
    });
    const decision = authorizeStep(
      p,
      grantOf(p, 'env-production'),
      step({ kind: 'billing.realCharge', resourceKey: 'chg', origin: PRODUCTION_ORIGIN, identityId: 'idn-a', amountUnits: 500 }),
    );
    expect(decision.permitted).toBe(false);
    if (decision.permitted) throw new Error('unreachable');
    expect(decision.message).toContain('real money in production');
  });

  it('keeps sandbox billing independent of the real-money decision', () => {
    const p = policy({
      grantedSteps: ['billing.sandboxCharge'],
      maxRisk: 'mutating',
      realMoney: { mode: 'denied' },
    });
    const decision = authorizeStep(
      p,
      grantOf(p),
      step({ kind: 'billing.sandboxCharge', resourceKey: 'chg', origin: STAGING_ORIGIN, identityId: 'idn-a', amountUnits: 500 }),
    );
    expect(decision.permitted).toBe(true);
  });

  it('refuses a realMoney authority that carries a limit while denying', () => {
    // The denied form has no `maxUnitsPerDay` field, so there is no
    // value a later edit could read as a limit.
    expect(() => parseRealMoneyAuthority({ mode: 'denied', maxUnitsPerDay: 1000 })).toThrow(OperatorError);
    expect(parseRealMoneyAuthority({ mode: 'denied' })).toEqual({ mode: 'denied' });
  });
});

describe('rule 7 — crossing a configured origin', () => {
  it('refuses a step whose origin is outside the environment grant', () => {
    const p = policy(fullStagingPolicy());
    const decision = authorizeStep(
      p,
      grantOf(p),
      step({
        kind: 'account.create',
        resourceKey: 'a',
        origin: FOREIGN_ORIGIN,
        identityId: 'idn-a',
        displayName: 'A',
      }),
    );
    expect(decision.permitted).toBe(false);
    if (decision.permitted) throw new Error('unreachable');
    expect(decision.message).toContain('outside environment');
  });

  it('accepts a declared additional origin and canonicalises it', () => {
    const p = policy(fullStagingPolicy({
      environments: [stagingGrant({ additionalOrigins: ['https://staging-alt.task-tracker.example'] })],
    }));
    const decision = authorizeStep(
      p,
      grantOf(p),
      step({
        kind: 'account.create',
        resourceKey: 'a',
        // Trailing slash on a bare origin is the same origin.
        origin: 'https://staging-alt.task-tracker.example/',
        identityId: 'idn-a',
        displayName: 'A',
      }),
    );
    expect(decision.permitted).toBe(true);
  });
});

describe('rule 8 — allow-listed detail denies by absence', () => {
  it('refuses a seed template when no allow-list is declared', () => {
    const p = policy(fullStagingPolicy({ allowedSeedTemplates: undefined }));
    const decision = authorizeStep(
      p,
      grantOf(p),
      step({ kind: 'fixture.seed', resourceKey: 'fx', origin: STAGING_ORIGIN, identityId: 'idn-a', template: 'smoke-v2' }),
    );
    expect(decision.permitted).toBe(false);
    if (decision.permitted) throw new Error('unreachable');
    expect(decision.message).toContain('not permitted');
  });

  it('refuses a seed template that is not on the allow-list', () => {
    const p = policy(fullStagingPolicy({ allowedSeedTemplates: ['empty-board'] }));
    const decision = authorizeStep(
      p,
      grantOf(p),
      step({ kind: 'fixture.seed', resourceKey: 'fx', origin: STAGING_ORIGIN, identityId: 'idn-a', template: 'smoke-v2' }),
    );
    expect(decision.permitted).toBe(false);
  });

  it('refuses reading an inbox folder that is not on the allow-list', () => {
    const p = policy(fullStagingPolicy());
    const decision = authorizeStep(
      p,
      grantOf(p),
      step({
        kind: 'inbox.read',
        resourceKey: 'inbox',
        origin: STAGING_ORIGIN,
        identityId: 'idn-a',
        folder: 'real-inbox',
        maxMessages: 5,
      }),
    );
    expect(decision.permitted).toBe(false);
    if (decision.permitted) throw new Error('unreachable');
    expect(decision.message).toContain('inbox folder');
  });
});

describe('policy parsing fails closed', () => {
  it('requires maxRisk rather than defaulting it', () => {
    const raw = minimalPolicy();
    delete raw['maxRisk'];
    expect(() => parseOperatorAuthorityPolicy(raw)).toThrow(OperatorError);
  });

  it('requires realMoney rather than defaulting it', () => {
    const raw = minimalPolicy();
    delete raw['realMoney'];
    expect(() => parseOperatorAuthorityPolicy(raw)).toThrow(OperatorError);
  });

  it('requires destructiveAllowed to be stated on every environment', () => {
    const raw = minimalPolicy();
    delete (raw['environments'] as Record<string, unknown>[])[0]!['destructiveAllowed'];
    expect(() => parseOperatorAuthorityPolicy(raw)).toThrow(OperatorError);
  });

  it('rejects an unknown policy field instead of dropping it', () => {
    expect(() => parseOperatorAuthorityPolicy(minimalPolicy({ escalateEverything: true }))).toThrow(
      /unknown field/,
    );
  });

  it('rejects a stepUnits key that names no real step', () => {
    expect(() => parseOperatorAuthorityPolicy(minimalPolicy({ stepUnits: { 'account.doom': 1 } }))).toThrow(
      OperatorError,
    );
  });

  it('rejects an unknown risk class', () => {
    expect(() => parseOperatorAuthorityPolicy(minimalPolicy({ maxRisk: 'apocalyptic' }))).toThrow(OperatorError);
    expect([...OPERATOR_RISK_CLASSES]).toContain('destructive');
  });

  it('rejects a budget missing either bound', () => {
    expect(() => parseOperatorBudget({ maxStepsPerDay: 10 })).toThrow(OperatorError);
    expect(() => parseOperatorBudget({ maxStepsPerDay: 10, maxUnitsPerDay: 0 })).toThrow(OperatorError);
    expect(parseOperatorBudget({ maxStepsPerDay: 1, maxUnitsPerDay: 1 })).toEqual({
      maxStepsPerDay: 1,
      maxUnitsPerDay: 1,
    });
  });

  it('rejects duplicate environments and duplicate grants', () => {
    expect(() => parseEnvironmentGrants([stagingGrant(), stagingGrant()])).toThrow(/duplicates/);
    expect(() => parseOperatorAuthorityPolicy(minimalPolicy({ grantedSteps: ['account.create', 'account.create'] }))).toThrow(
      /duplicates/,
    );
  });
});
