/**
 * Plan shape: the three evaluation modes, determinism, version lineage,
 * the cost model and the authority envelope (issue #62).
 *
 * The acceptance criterion "unit tests cover all three evaluation modes
 * and idempotency" is discharged here (modes, determinism) and in
 * `idempotency.test.ts` (idempotency).
 */

import { describe, it, expect } from 'vitest';

import {
  authorityRef,
  MAX_IDENTITIES_PER_PLAN,
  MAX_MUTATING_ACTIONS_PER_PLAN,
  MAX_VERIFICATIONS_PER_PLAN,
  LINEAGE_GAP_EXPLANATIONS,
  parseStageCostRates,
  planCost,
  resolveVersionLineage,
  planEvaluation,
  type EvaluationPlan,
  type PlanDecision,
  type PlanEvaluationInput,
} from '../../../src/program/index.js';
import {
  ANCHOR,
  CADENCE_60M,
  MANUAL_TRIGGER,
  PROD_LIKE_ID,
  PROD_LIKE_ORIGIN,
  RATES,
  STAGING_ID,
  STAGING_ORIGIN,
  makeModel,
  makeProgram,
  manualSignal,
  observation,
  reviewProgramId,
} from './fixtures.js';

const HOUR = 3_600_000;
function iso(offsetMs: number): string {
  return new Date(Date.parse(ANCHOR) + offsetMs).toISOString();
}

const NOW = iso(10 * HOUR + 30_000);
const CEILING = 5;

const cadenceProgram = makeProgram({ id: 'rp-cadence', triggers: [CADENCE_60M] });
const manualProgram = makeProgram({ id: 'rp-manual', triggers: [MANUAL_TRIGGER] });
const model = makeModel({ programs: [cadenceProgram, manualProgram] });

const OBS_V1 = observation({
  observationId: 'obs-v1',
  environmentId: STAGING_ID,
  version: '2026.03.01',
  observedAt: iso(9 * HOUR),
});
const OBS_V2 = observation({
  observationId: 'obs-v2',
  environmentId: STAGING_ID,
  version: '2026.03.02',
  observedAt: iso(9 * HOUR + 30 * 60_000),
});

function evaluate(
  programId: string,
  overrides: Partial<PlanEvaluationInput> = {},
): PlanDecision {
  return planEvaluation({
    model,
    programId: reviewProgramId(programId),
    now: NOW,
    planningCeiling: CEILING,
    rates: RATES,
    maxMutatingActions: 2,
    ...overrides,
  });
}

function expectDue(decision: PlanDecision): EvaluationPlan {
  if (decision.outcome !== 'due') throw new Error(`expected a plan, got ${decision.outcome}`);
  return decision.plan;
}

describe('The three evaluation modes', () => {
  it('derives continuous for a cadence with no transition evidence', () => {
    const plan = expectDue(evaluate('rp-cadence'));
    expect(plan.mode).toBe('continuous');
    expect(plan.lineage).toBeUndefined();
  });

  it('derives pointInTime for an explicit manual evaluation', () => {
    const plan = expectDue(
      evaluate('rp-manual', {
        signals: [manualSignal('manual-1', iso(10 * HOUR))],
      }),
    );
    expect(plan.mode).toBe('pointInTime');
    expect(plan.lineage).toBeUndefined();
  });

  it('derives releaseTransition when a real version transition is observed', () => {
    const plan = expectDue(evaluate('rp-cadence', { observations: [OBS_V1, OBS_V2] }));
    expect(plan.mode).toBe('releaseTransition');
  });

  it('honours a pinned mode', () => {
    const plan = expectDue(
      evaluate('rp-manual', {
        signals: [manualSignal('manual-1', iso(10 * HOUR))],
        requestedMode: 'continuous',
      }),
    );
    expect(plan.mode).toBe('continuous');
  });

  it('rejects a requested mode outside the enum', () => {
    expect(() => evaluate('rp-cadence', { requestedMode: 'urgent' as never })).toThrow(
      /input.requestedMode must be one of/,
    );
  });
});

describe('Release-transition lineage', () => {
  it('preserves both the previous and the current environment version', () => {
    const plan = expectDue(evaluate('rp-cadence', { observations: [OBS_V1, OBS_V2] }));
    expect(plan.lineage).toBeDefined();
    expect(plan.lineage?.previous).toEqual(OBS_V1);
    expect(plan.lineage?.current).toEqual(OBS_V2);
    expect(plan.lineage?.previous.version).toBe('2026.03.01');
    expect(plan.lineage?.current.version).toBe('2026.03.02');
    // Both halves survive serialisation, so #67 can still join evidence
    // on them long after the plan was emitted.
    const round = JSON.parse(JSON.stringify(plan)) as EvaluationPlan;
    expect(round.lineage?.previous.observationId).toBe('obs-v1');
    expect(round.lineage?.current.version).toBe('2026.03.02');
  });

  it('reports a missing transition rather than silently downgrading to continuous', () => {
    const decision = evaluate('rp-cadence', {
      requestedMode: 'releaseTransition',
      observations: [OBS_V2],
    });
    expect(decision.outcome).toBe('not-due');
    if (decision.outcome !== 'not-due') return;
    expect(decision.reason).toBe('release-transition-lineage-missing');
    expect(decision.detail['gap']).toBe('insufficient-observations');
    expect('plan' in decision).toBe(false);
  });

  it.each([
    // Two observations, one environment, the same version: nothing transitioned.
    [
      'same-version',
      [
        observation({ observationId: 'obs-a', environmentId: STAGING_ID, version: '2026.03.02', observedAt: iso(8 * HOUR) }),
        observation({ observationId: 'obs-b', environmentId: STAGING_ID, version: '2026.03.02', observedAt: iso(9 * HOUR) }),
      ],
    ],
    // Versions differ but the instant does not advance, so "before"
    // and "after" cannot be ordered.
    [
      'not-advanced-in-time',
      [
        observation({ observationId: 'obs-a', environmentId: STAGING_ID, version: '2026.03.01', observedAt: iso(9 * HOUR) }),
        observation({ observationId: 'obs-b', environmentId: STAGING_ID, version: '2026.03.02', observedAt: iso(9 * HOUR) }),
      ],
    ],
  ])('explains a %s lineage gap', (gap, observations) => {
    const decision = evaluate('rp-cadence', {
      requestedMode: 'releaseTransition',
      observations,
    });
    expect(decision.outcome).toBe('not-due');
    if (decision.outcome !== 'not-due') return;
    expect(decision.detail['gap']).toBe(gap);
    expect(decision.detail['explanation']).toBeTypeOf('string');
  });

  it('explains an environment-mismatch lineage gap', () => {
    // A transition is one environment changing version. Two different
    // environments observed in sequence is a different experiment, and
    // joining their evidence would be wrong.
    //
    // This gap is guarded at the `resolveVersionLineage` boundary:
    // `planEvaluation` filters to a single target environment before
    // resolving, so a caller cannot reach the planner with a mismatched
    // pair in the first place.
    const resolution = resolveVersionLineage([
      observation({ observationId: 'obs-staging', environmentId: STAGING_ID, version: '2026.03.01', observedAt: iso(8 * HOUR) }),
      observation({ observationId: 'obs-prodlike', environmentId: PROD_LIKE_ID, version: '2026.03.02', observedAt: iso(9 * HOUR) }),
    ]);
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.gap).toBe('environment-mismatch');
    expect(LINEAGE_GAP_EXPLANATIONS[resolution.gap]).toMatch(/one environment changing version/);
  });

  it('takes the two latest observations, not the two furthest apart', () => {
    const plan = expectDue(
      evaluate('rp-cadence', {
        observations: [
          OBS_V1,
          OBS_V2,
          observation({
            observationId: 'obs-v3',
            environmentId: STAGING_ID,
            version: '2026.03.03',
            observedAt: iso(9 * HOUR + 45 * 60_000),
          }),
        ],
      }),
    );
    expect(plan.lineage?.previous.version).toBe('2026.03.02');
    expect(plan.lineage?.current.version).toBe('2026.03.03');
  });
});

describe('Plan determinism', () => {
  it('produces an identical plan for identical inputs', () => {
    const a = expectDue(evaluate('rp-cadence', { observations: [OBS_V1, OBS_V2] }));
    const b = expectDue(evaluate('rp-cadence', { observations: [OBS_V1, OBS_V2] }));
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('produces the same run identity for every instant in a cadence slot', () => {
    const early = expectDue(evaluate('rp-cadence', { now: iso(10 * HOUR + 1) }));
    const late = expectDue(evaluate('rp-cadence', { now: iso(11 * HOUR - 1) }));
    expect(late.planKey).toBe(early.planKey);
    expect(late).toEqual(early);
  });

  it('carries no wall-clock creation stamp', () => {
    const a = expectDue(evaluate('rp-cadence', { now: iso(10 * HOUR + 1) }));
    const b = expectDue(evaluate('rp-cadence', { now: iso(10 * HOUR + 59 * 60_000 + 59_000) }));
    // A `createdAt` would make these differ while the logical
    // evaluation is identical.
    expect(b).toEqual(a);
    expect(JSON.stringify(a)).not.toContain(iso(10 * HOUR + 59 * 60_000 + 59_000));
    expect(Object.keys(a)).not.toContain('createdAt');
    // The only instant on the plan is the trigger's semantic due time.
    expect(a.trigger.dueAt).toBe(iso(10 * HOUR));
  });

  it('changes cost only when a declared input changes', () => {
    const base = expectDue(evaluate('rp-cadence'));
    const wider = expectDue(evaluate('rp-cadence', { planningCeiling: 8 }));
    expect(wider.budget.costUnits).toBeGreaterThan(base.budget.costUnits);
    expect(wider.planKey).toBe(base.planKey); // same evaluation identity
  });
});

describe('Cost model', () => {
  it('is arithmetic over declared integers, not a measurement', () => {
    // 5 planned identities, 5 permitted verifications.
    const cost = planCost(5, 5, RATES);
    expect(cost).toEqual({
      scoutCostUnits: 50,
      verificationCostUnits: 250,
      totalCostUnits: 300,
    });
  });

  it('is a pure function of its inputs', () => {
    for (let i = 0; i < 25; i += 1) {
      expect(planCost(5, 5, RATES)).toEqual(planCost(5, 5, RATES));
    }
  });

  it('rejects a non-finite or negative rate', () => {
    expect(() => parseStageCostRates({ scoutUnitsPerIdentity: Number.NaN, verificationUnitsPerIdentity: 1 })).toThrow(
      /must be a finite number/,
    );
    expect(() => parseStageCostRates({ scoutUnitsPerIdentity: -1, verificationUnitsPerIdentity: 1 })).toThrow(
      /must be >= 0/,
    );
  });

  it('never lets verification exceed the scout', () => {
    const plan = expectDue(evaluate('rp-cadence', { planningCeiling: 3 }));
    expect(plan.escalation.maxVerifications).toBeLessThanOrEqual(plan.cohort.plannedIdentities);
    expect(plan.escalation.maxVerifications).toBeLessThanOrEqual(MAX_VERIFICATIONS_PER_PLAN);
  });
});

describe('Cheap-scout to verification escalation', () => {
  it('is represented in the plan, not executed by it', () => {
    const plan = expectDue(evaluate('rp-cadence'));
    expect(plan.escalation.kind).toBe('cheapScoutThenVerification');
    expect(plan.escalation).toEqual({
      kind: 'cheapScoutThenVerification',
      maxVerifications: CEILING,
      verificationCostUnits: 250,
      reservedUpFront: true,
    });
    expect(plan.budget.scoutCostUnits).toBe(50);
    expect(plan.budget.costUnits).toBe(plan.budget.scoutCostUnits + plan.budget.verificationCostUnits);
  });

  it('caps verifications for a large cohort at the module maximum', () => {
    const generous = makeProgram({
      id: 'rp-generous',
      triggers: [MANUAL_TRIGGER],
      budget: { maxCostUnitsPerDay: 10_000_000 },
    });
    const generousModel = makeModel({ programs: [generous] });
    const plan = expectDue(
      planEvaluation({
        model: generousModel,
        programId: reviewProgramId('rp-generous'),
        now: NOW,
        signals: [manualSignal('m1', iso(10 * HOUR))],
        planningCeiling: MAX_IDENTITIES_PER_PLAN,
        rates: RATES,
        maxMutatingActions: 2,
      }),
    );
    expect(plan.cohort.plannedIdentities).toBe(MAX_IDENTITIES_PER_PLAN);
    // Verification is capped independently of the scout size.
    expect(plan.escalation.maxVerifications).toBe(MAX_VERIFICATIONS_PER_PLAN);
  });
});

describe('Cohort selection', () => {
  it('uses an explicit membership count from the declaration', () => {
    const program_ = makeProgram({
      id: 'rp-explicit',
      triggers: [MANUAL_TRIGGER],
      cohortId: 'coh-explicit',
    });
    const explicitModel = makeModel({ programs: [program_] });
    const plan = expectDue(
      planEvaluation({
        model: explicitModel,
        programId: reviewProgramId('rp-explicit'),
        now: NOW,
        signals: [manualSignal('m1', iso(10 * HOUR))],
        planningCeiling: CEILING,
        rates: RATES,
        maxMutatingActions: 2,
      }),
    );
    expect(plan.cohort.membership.kind).toBe('explicit');
    expect(plan.cohort.declaredIdentityCount).toBe(2);
    expect(plan.cohort.plannedIdentities).toBe(2);
    expect(plan.budget.costUnits).toBe(2 * 10 + 2 * 50);
  });

  it('uses a sizeTarget size, capped by the planning ceiling', () => {
    const program_ = makeProgram({
      id: 'rp-size',
      triggers: [MANUAL_TRIGGER],
      cohortId: 'coh-size',
    });
    const sizeModel = makeModel({ programs: [program_] });
    const plan = expectDue(
      planEvaluation({
        model: sizeModel,
        programId: reviewProgramId('rp-size'),
        now: NOW,
        signals: [manualSignal('m1', iso(10 * HOUR))],
        planningCeiling: CEILING,
        rates: RATES,
        maxMutatingActions: 2,
      }),
    );
    expect(plan.cohort.declaredIdentityCount).toBe(20);
    expect(plan.cohort.planningCeiling).toBe(CEILING);
    expect(plan.cohort.plannedIdentities).toBe(CEILING);
  });

  it('charges an unresolvable byLifecycle cohort against the declared ceiling', () => {
    const plan = expectDue(evaluate('rp-cadence'));
    expect(plan.cohort.membership.kind).toBe('byLifecycle');
    expect(plan.cohort.declaredIdentityCount).toBeNull();
    expect(plan.cohort.plannedIdentities).toBe(CEILING);
  });

  it('carries the selection rule as a reference and resolves no members', () => {
    const plan = expectDue(evaluate('rp-cadence'));
    expect(plan.cohort.cohortId).toBe('coh-release');
    expect(plan.cohort.membership).toEqual({ kind: 'byLifecycle', lifecycle: 'release' });
    // A plan that resolved membership would hold privileged state it
    // has no authority over, so no member list appears on the cohort
    // selection itself.
    expect(Object.keys(plan.cohort)).not.toContain('memberIds');
    expect(Object.keys(plan.cohort)).not.toContain('identityIds');
  });
});

describe('Authority envelope', () => {
  it('scopes the plan to the target environment origins', () => {
    const program_ = makeProgram({
      id: 'rp-prod',
      triggers: [MANUAL_TRIGGER],
      environmentIds: [STAGING_ID, PROD_LIKE_ID],
    });
    const prodModel = makeModel({ programs: [program_] });
    const plan = expectDue(
      planEvaluation({
        model: prodModel,
        programId: reviewProgramId('rp-prod'),
        now: NOW,
        signals: [manualSignal('m1', iso(10 * HOUR))],
        observations: [
          observation({
            observationId: 'obs-prod',
            environmentId: PROD_LIKE_ID,
            version: '2026.03.02',
            observedAt: iso(9 * HOUR),
          }),
        ],
        planningCeiling: CEILING,
        rates: RATES,
        maxMutatingActions: 4,
        operatorAuthorityRefs: [authorityRef('grant-seed-data'), authorityRef('grant-test-inbox')],
      }),
    );
    expect(plan.authority.environmentOrigins).toEqual([
      PROD_LIKE_ORIGIN,
      'https://www.task-tracker.example',
    ]);
    expect(plan.authority.operatorAuthorityRefs).toEqual(['grant-seed-data', 'grant-test-inbox']);
    expect(plan.authority.maxMutatingActions).toBe(4);
  });

  it('never widens authority past the target environment', () => {
    const plan = expectDue(evaluate('rp-cadence'));
    expect(plan.authority.environmentOrigins).toEqual([STAGING_ORIGIN]);
    expect(plan.authority.environmentOrigins).not.toContain(PROD_LIKE_ORIGIN);
  });

  it('bounds participant retention from the cohort lifecycle, and says how', () => {
    // `coh-release` names a lifecycle, so the ceiling follows from it.
    const release = expectDue(evaluate('rp-cadence'));
    expect(release.authority.retentionResolution).toBe('cohort-lifecycle');
    expect(release.authority.maxParticipantStateRetention).toBe('durable');

    // `coh-explicit` names identities but not lifecycles; resolving
    // those is #60's ticket, so the runtime narrows it per identity.
    const program_ = makeProgram({
      id: 'rp-explicit',
      triggers: [MANUAL_TRIGGER],
      cohortId: 'coh-explicit',
    });
    const explicitModel = makeModel({ programs: [program_] });
    const explicit = expectDue(
      planEvaluation({
        model: explicitModel,
        programId: reviewProgramId('rp-explicit'),
        now: NOW,
        signals: [manualSignal('m1', iso(10 * HOUR))],
        planningCeiling: CEILING,
        rates: RATES,
        maxMutatingActions: 0,
      }),
    );
    expect(explicit.authority.retentionResolution).toBe('per-identity-at-runtime');
    expect(explicit.authority.maxMutatingActions).toBe(0);
  });

  it('rejects a mutating-action ceiling above the module maximum', () => {
    expect(() => evaluate('rp-cadence', { maxMutatingActions: MAX_MUTATING_ACTIONS_PER_PLAN + 1 })).toThrow(
      /input.maxMutatingActions must be between 0 and 200/,
    );
  });

  it('rejects duplicate or malformed authority references', () => {
    expect(() =>
      evaluate('rp-cadence', { operatorAuthorityRefs: [authorityRef('grant-a'), authorityRef('grant-a')] }),
    ).toThrow(/must not contain duplicates/);
    expect(() => evaluate('rp-cadence', { operatorAuthorityRefs: ['has space' as never] })).toThrow(
      /must be a valid AuthorityRef handle/,
    );
  });
});
