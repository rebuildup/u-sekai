import { describe, it, expect } from 'vitest';
import {
  MAX_CADENCE_MINUTES,
  MAX_DEBOUNCE_MINUTES,
  MAX_EXPLICIT_MEMBERS,
  MAX_PROGRAM_ENVIRONMENTS,
  MAX_RUNS_PER_DAY,
  MAX_TARGET_SIZE,
  MIN_CADENCE_MINUTES,
  parseCohortMembershipIntent,
  parseProgramBudget,
  parseReviewProgram,
  parseReviewTrigger,
  parseReviewTriggers,
  parseSyntheticCohort,
  ProductDomainError,
  programHasTrigger,
  TRIGGER_KINDS,
} from '../../../src/product/index.js';

describe('Cohort construction', () => {
  it('accepts each membership intent variant', () => {
    expect(
      parseSyntheticCohort({
        id: 'coh-explicit',
        productId: 'prd-a',
        name: 'Explicit',
        membership: { kind: 'explicit', identityIds: ['idn-a', 'idn-b'] },
      }).membership,
    ).toEqual({ kind: 'explicit', identityIds: ['idn-a', 'idn-b'] });

    expect(
      parseSyntheticCohort({
        id: 'coh-lifecycle',
        productId: 'prd-a',
        name: 'Lifecycle',
        membership: { kind: 'byLifecycle', lifecycle: 'persistent' },
      }).membership,
    ).toEqual({ kind: 'byLifecycle', lifecycle: 'persistent' });

    expect(
      parseSyntheticCohort({
        id: 'coh-size',
        productId: 'prd-a',
        name: 'Size',
        membership: { kind: 'sizeTarget', lifecycle: 'release', targetSize: 25 },
      }).membership,
    ).toEqual({ kind: 'sizeTarget', lifecycle: 'release', targetSize: 25 });
  });

  it('declares membership intent, not resolved membership', () => {
    // A byLifecycle cohort carries no member list at all: resolution is #60.
    const cohort = parseSyntheticCohort({
      id: 'coh-a',
      productId: 'prd-a',
      name: 'A',
      membership: { kind: 'byLifecycle', lifecycle: 'persistent' },
    });
    expect(Object.keys(cohort.membership)).toEqual(['kind', 'lifecycle']);
    expect('members' in cohort).toBe(false);
    expect('identityIds' in cohort).toBe(false);
  });

  it('carries no environment reference, so one cohort can span a release transition', () => {
    const cohort = parseSyntheticCohort({
      id: 'coh-a',
      productId: 'prd-a',
      name: 'A',
      membership: { kind: 'byLifecycle', lifecycle: 'release' },
    });
    expect(Object.keys(cohort).some((k) => /environment/i.test(k))).toBe(false);
  });
});

describe('Cohort rejection', () => {
  it('rejects an empty or non-array explicit identityIds', () => {
    expect(() => parseCohortMembershipIntent({ kind: 'explicit', identityIds: [] })).toThrow(
      /must be a non-empty array/,
    );
    expect(() => parseCohortMembershipIntent({ kind: 'explicit', identityIds: 'idn-a' })).toThrow(
      /must be a non-empty array/,
    );
  });

  it('rejects duplicate explicit identityIds', () => {
    expect(() =>
      parseCohortMembershipIntent({ kind: 'explicit', identityIds: ['idn-a', 'idn-a'] }),
    ).toThrow(/duplicates: idn-a/);
  });

  it('rejects an over-large explicit membership', () => {
    const ids = Array.from({ length: MAX_EXPLICIT_MEMBERS + 1 }, (_, i) => `idn-${i}`);
    expect(() => parseCohortMembershipIntent({ kind: 'explicit', identityIds: ids })).toThrow(
      new RegExp(`at most ${MAX_EXPLICIT_MEMBERS} entries`),
    );
  });

  it('rejects an unknown membership kind', () => {
    expect(() => parseCohortMembershipIntent({ kind: 'dynamic' })).toThrow(
      /must be one of: explicit, byLifecycle, sizeTarget/,
    );
    expect(() => parseCohortMembershipIntent({})).toThrow(/kind must be a string/);
  });

  it('rejects a non-positive or over-max targetSize', () => {
    expect(() =>
      parseCohortMembershipIntent({ kind: 'sizeTarget', lifecycle: 'release', targetSize: 0 }),
    ).toThrow(/between 1 and/);
    expect(() =>
      parseCohortMembershipIntent({ kind: 'sizeTarget', lifecycle: 'release', targetSize: 1.5 }),
    ).toThrow(/must be an integer/);
    expect(() =>
      parseCohortMembershipIntent({
        kind: 'sizeTarget',
        lifecycle: 'release',
        targetSize: MAX_TARGET_SIZE + 1,
      }),
    ).toThrow(new RegExp(`between 1 and ${MAX_TARGET_SIZE}`));
  });

  it('rejects a field belonging to a different intent variant', () => {
    expect(() =>
      parseCohortMembershipIntent({ kind: 'byLifecycle', lifecycle: 'release', targetSize: 3 }),
    ).toThrow(/unknown field\(s\): targetSize/);
    expect(() =>
      parseCohortMembershipIntent({ kind: 'explicit', identityIds: ['idn-a'], lifecycle: 'release' }),
    ).toThrow(/unknown field\(s\): lifecycle/);
  });

  it('rejects an unknown field on the cohort itself', () => {
    expect(() =>
      parseSyntheticCohort({
        id: 'coh-a',
        productId: 'prd-a',
        name: 'A',
        membership: { kind: 'byLifecycle', lifecycle: 'release' },
        scheduler: 'cron',
      }),
    ).toThrow(/unknown field\(s\): scheduler/);
  });
});

describe('Review Program trigger declarations', () => {
  it('declares exactly cadence, event and manual', () => {
    expect(TRIGGER_KINDS).toEqual(['cadence', 'event', 'manual']);
  });

  it('accepts a cadence with a zone and optional start instant', () => {
    expect(
      parseReviewTrigger({ kind: 'cadence', intervalMinutes: 120, timeZone: 'Asia/Tokyo' }),
    ).toEqual({ kind: 'cadence', intervalMinutes: 120, timeZone: 'Asia/Tokyo' });
    expect(
      parseReviewTrigger({
        kind: 'cadence',
        intervalMinutes: 120,
        timeZone: 'UTC',
        startAt: '2026-10-01T00:00:00Z',
      }),
    ).toEqual({ kind: 'cadence', intervalMinutes: 120, timeZone: 'UTC', startAt: '2026-10-01T00:00:00Z' });
  });

  it('rejects a cadence below the anti-burn floor', () => {
    expect(MIN_CADENCE_MINUTES).toBe(5);
    expect(() => parseReviewTrigger({ kind: 'cadence', intervalMinutes: 1, timeZone: 'UTC' })).toThrow(
      new RegExp(`between ${MIN_CADENCE_MINUTES} and`),
    );
    expect(() =>
      parseReviewTrigger({ kind: 'cadence', intervalMinutes: 0, timeZone: 'UTC' }),
    ).toThrow(/between 5 and/);
    expect(() =>
      parseReviewTrigger({ kind: 'cadence', intervalMinutes: MIN_CADENCE_MINUTES, timeZone: 'UTC' }),
    ).not.toThrow();
    expect(() =>
      parseReviewTrigger({ kind: 'cadence', intervalMinutes: MAX_CADENCE_MINUTES, timeZone: 'UTC' }),
    ).not.toThrow();
  });

  it('rejects a missing or non-IANA time zone', () => {
    expect(() => parseReviewTrigger({ kind: 'cadence', intervalMinutes: 60 })).toThrow(
      /timeZone must be a string/,
    );
    expect(() => parseReviewTrigger({ kind: 'cadence', intervalMinutes: 60, timeZone: '+09:00' })).toThrow(
      /must be an IANA time zone name/,
    );
    expect(() => parseReviewTrigger({ kind: 'cadence', intervalMinutes: 60, timeZone: 'Mars/Olympus' })).toThrow(
      /must be an IANA time zone name/,
    );
  });

  it('rejects a startAt without an explicit UTC offset', () => {
    expect(() =>
      parseReviewTrigger({ kind: 'cadence', intervalMinutes: 60, timeZone: 'UTC', startAt: '2026-10-01T00:00:00' }),
    ).toThrow(/explicit UTC offset/);
    expect(() =>
      parseReviewTrigger({ kind: 'cadence', intervalMinutes: 60, timeZone: 'UTC', startAt: 'yesterday' }),
    ).toThrow(/explicit UTC offset/);
    expect(() =>
      parseReviewTrigger({
        kind: 'cadence',
        intervalMinutes: 60,
        timeZone: 'UTC',
        startAt: '2026-10-01T00:00:00+09:00',
      }),
    ).not.toThrow();
  });

  it('accepts a dotted event name and rejects a malformed one', () => {
    expect(parseReviewTrigger({ kind: 'event', event: 'deployment.completed', debounceMinutes: 0 })).toEqual({
      kind: 'event',
      event: 'deployment.completed',
      debounceMinutes: 0,
    });
    for (const event of ['', 'Deployment', 'deploy..ment', ' deploy', 'deploy/complete', 'deploy complete']) {
      expect(() => parseReviewTrigger({ kind: 'event', event, debounceMinutes: 0 }), event).toThrow(
        ProductDomainError,
      );
    }
  });

  it('treats a Git-shaped event name as an opaque domain event, not a rejection', () => {
    // ADR-0011: a Git integration may *trigger* evaluation but does not
    // define the review target, so the name itself is not policed.
    expect(() =>
      parseReviewTrigger({ kind: 'event', event: 'pull_request.opened', debounceMinutes: 5 }),
    ).not.toThrow();
  });

  it('rejects an out-of-range debounce', () => {
    expect(() =>
      parseReviewTrigger({ kind: 'event', event: 'a.b', debounceMinutes: MAX_DEBOUNCE_MINUTES + 1 }),
    ).toThrow(new RegExp(`between 0 and ${MAX_DEBOUNCE_MINUTES}`));
    expect(() =>
      parseReviewTrigger({ kind: 'event', event: 'a.b', debounceMinutes: -1 }),
    ).toThrow(/between 0 and/);
  });

  it('accepts manual with no extra fields and rejects extras', () => {
    expect(parseReviewTrigger({ kind: 'manual' })).toEqual({ kind: 'manual' });
    expect(() => parseReviewTrigger({ kind: 'manual', intervalMinutes: 60 })).toThrow(
      /unknown field\(s\): intervalMinutes/,
    );
  });

  it('rejects two triggers of the same kind on one program', () => {
    expect(() =>
      parseReviewTriggers([
        { kind: 'manual' },
        { kind: 'manual' },
      ]),
    ).toThrow(/must not contain duplicates: manual/);
  });

  it('rejects an empty trigger list', () => {
    expect(() => parseReviewTriggers([])).toThrow(/must be a non-empty array/);
  });
});

describe('Review Program construction and budget', () => {
  const base = {
    id: 'rp-continuous',
    productId: 'prd-a',
    name: 'Continuous',
    environmentIds: ['env-staging'],
    cohortId: 'coh-a',
    triggers: [{ kind: 'manual' }],
    budget: { maxRunsPerDay: 10, maxRunsPerEvent: 1, maxCostUnitsPerDay: 50 },
  };

  it('accepts a complete program', () => {
    const program = parseReviewProgram(base);
    expect(program.id).toBe('rp-continuous');
    expect(program.environmentIds).toEqual(['env-staging']);
    expect(programHasTrigger(program, 'manual')).toBe(true);
    expect(programHasTrigger(program, 'cadence')).toBe(false);
  });

  it('rejects an empty or duplicate environmentIds list', () => {
    expect(() => parseReviewProgram({ ...base, environmentIds: [] })).toThrow(/must be a non-empty array/);
    expect(() =>
      parseReviewProgram({ ...base, environmentIds: ['env-staging', 'env-staging'] }),
    ).toThrow(/duplicates: env-staging/);
    expect(() =>
      parseReviewProgram({
        ...base,
        environmentIds: Array.from({ length: MAX_PROGRAM_ENVIRONMENTS + 1 }, (_, i) => `env-${i}`),
      }),
    ).toThrow(new RegExp(`at most ${MAX_PROGRAM_ENVIRONMENTS} entries`));
  });

  it('rejects out-of-range budget values', () => {
    expect(() => parseProgramBudget({ maxRunsPerDay: 0, maxRunsPerEvent: 1, maxCostUnitsPerDay: 0 })).toThrow(
      /between 1 and/,
    );
    expect(() =>
      parseProgramBudget({ maxRunsPerDay: MAX_RUNS_PER_DAY + 1, maxRunsPerEvent: 1, maxCostUnitsPerDay: 0 }),
    ).toThrow(new RegExp(`between 1 and ${MAX_RUNS_PER_DAY}`));
    expect(() =>
      parseProgramBudget({ maxRunsPerDay: 1, maxRunsPerEvent: 1, maxCostUnitsPerDay: -1 }),
    ).toThrow(/must be >= 0/);
    expect(() =>
      parseProgramBudget({ maxRunsPerDay: 1, maxRunsPerEvent: 1, maxCostUnitsPerDay: Number.NaN }),
    ).toThrow(/must be a finite number/);
    expect(() =>
      parseProgramBudget({ maxRunsPerDay: 1, maxRunsPerEvent: 1, maxCostUnitsPerDay: Number.POSITIVE_INFINITY }),
    ).toThrow(/must be a finite number/);
    expect(() => parseProgramBudget({ maxRunsPerDay: 1, maxRunsPerEvent: 1, maxCostUnitsPerDay: 0 })).not.toThrow();
  });

  it('rejects an unknown budget field', () => {
    expect(() =>
      parseProgramBudget({
        maxRunsPerDay: 1,
        maxRunsPerEvent: 1,
        maxCostUnitsPerDay: 0,
        maxUsdPerDay: 10,
      }),
    ).toThrow(/unknown field\(s\): maxUsdPerDay/);
  });

  it('rejects an unknown field on the program', () => {
    expect(() => parseReviewProgram({ ...base, cron: '* * * * *' })).toThrow(/unknown field\(s\): cron/);
  });
});
