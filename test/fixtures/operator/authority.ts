/**
 * Deterministic test doubles for the World Operator (issue #59).
 *
 * The operator reads no ambient time, so every budget-window and
 * timestamp assertion in `test/unit/operator/**` is only meaningful
 * because the clock arrives here rather than from `Date.now()`.
 */

import type { OperatorClock } from '../../../src/operator/index.js';

export const STAGING_ORIGIN = 'https://staging.task-tracker.example';
export const STAGING_ALT_ORIGIN = 'https://staging-alt.task-tracker.example';
export const PRODUCTION_ORIGIN = 'https://task-tracker.example';
/** Deliberately outside every grant. */
export const FOREIGN_ORIGIN = 'https://not-granted.example';

/** A clock frozen at one instant. */
export function fixedClock(instant: string): OperatorClock {
  return { now: () => instant };
}

/**
 * A clock that walks a declared sequence and then holds the last value.
 *
 * `#now` is called once per `provision` and once per released resource,
 * so a sequence pins the instants a compensation actually recorded
 * instead of letting them drift with the wall clock.
 */
export function sequenceClock(instants: readonly string[]): OperatorClock {
  const last = instants[instants.length - 1];
  if (last === undefined) throw new Error('sequenceClock requires at least one instant');
  let index = 0;
  return {
    now: () => {
      const value = instants[Math.min(index, instants.length - 1)] ?? last;
      index += 1;
      return value;
    },
  };
}

/** A staging environment grant with destructive steps allowed. */
export function stagingGrant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    environmentId: 'env-staging',
    environmentClass: 'staging',
    baseUrl: STAGING_ORIGIN,
    destructiveAllowed: true,
    productionDestructive: false,
    ...overrides,
  };
}

/** A production environment grant that has not opted into destructive steps. */
export function productionGrant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    environmentId: 'env-production',
    environmentClass: 'production',
    baseUrl: PRODUCTION_ORIGIN,
    destructiveAllowed: false,
    productionDestructive: false,
    ...overrides,
  };
}

/**
 * The least-privilege policy: one environment, one granted step, the
 * `mutating` ceiling, real money denied.
 *
 * This is the shape a customer who has granted nothing beyond creating a
 * test account would have, and it is the baseline the deny-by-default
 * tests widen one field at a time.
 */
export function minimalPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    policyId: 'pol-minimal',
    environments: [stagingGrant()],
    grantedSteps: ['account.create'],
    maxRisk: 'mutating',
    stepUnits: { 'account.create': 1 },
    realMoney: { mode: 'denied' },
    budget: { maxStepsPerDay: 50, maxUnitsPerDay: 50 },
    ...overrides,
  };
}

/** A policy that grants every non-real-money step against staging. */
export function fullStagingPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    policyId: 'pol-staging',
    environments: [stagingGrant()],
    grantedSteps: [
      'account.create',
      'account.retire',
      'fixture.seed',
      'fixture.reset',
      'entitlement.grant',
      'entitlement.revoke',
      'inbox.read',
      'billing.sandboxCharge',
    ],
    maxRisk: 'destructive',
    stepUnits: {
      'account.create': 1,
      'account.retire': 0,
      'fixture.seed': 2,
      'fixture.reset': 0,
      'entitlement.grant': 1,
      'entitlement.revoke': 0,
      'inbox.read': 1,
      'billing.sandboxCharge': 5,
    },
    realMoney: { mode: 'denied' },
    budget: { maxStepsPerDay: 100, maxUnitsPerDay: 100 },
    allowedSeedTemplates: ['empty-board', 'smoke-v2'],
    allowedInboxFolders: ['test-inbox'],
    ...overrides,
  };
}

export function lineage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    productId: 'prd-task-tracker',
    environmentId: 'env-staging',
    cohortId: 'coh-returning',
    programId: 'rp-staging-continuous',
    runId: 'run-0001',
    ...overrides,
  };
}

export function accountCreateStep(
  resourceKey = 'acct-alice',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: 'account.create',
    resourceKey,
    origin: STAGING_ORIGIN,
    identityId: 'idn-alice',
    displayName: 'Alice',
    ...overrides,
  };
}

export function provisionRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'req-setup-1',
    lineage: lineage(),
    steps: [accountCreateStep()],
    reason: 'acceptance fixture',
    ...overrides,
  };
}
