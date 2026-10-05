/**
 * The module's exported contract surface (issue #62).
 *
 * `TRIGGER_PRECEDENCE`, `NOT_DUE_REASONS` and `RETENTION_RESOLUTIONS` are
 * the vocabularies a downstream ticket (#63 executor, #64 KPI, #67
 * comparison) codes against. They are only worth exporting if they are
 * actually true, so each is pinned here against observed behaviour
 * rather than against its own declaration.
 */

import { describe, it, expect } from 'vitest';

import {
  NOT_DUE_REASONS,
  RETENTION_RESOLUTIONS,
  TRIGGER_PRECEDENCE,
  parseIdempotencyKey,
  parsePlanKey,
  planEvaluation,
  type PlanDecision,
  type PlanEvaluationInput,
} from '../../../src/program/index.js';
import {
  ANCHOR,
  CADENCE_60M,
  DEPLOYMENT_TRIGGER,
  MANUAL_TRIGGER,
  RATES,
  deploymentSignal,
  makeModel,
  makeProgram,
  manualSignal,
  reviewProgramId,
} from './fixtures.js';

const HOUR = 3_600_000;
function iso(offsetMs: number): string {
  return new Date(Date.parse(ANCHOR) + offsetMs).toISOString();
}

const NOW = iso(10 * HOUR + 30_000);

const allProgram = makeProgram({
  id: 'rp-all',
  triggers: [MANUAL_TRIGGER, DEPLOYMENT_TRIGGER, CADENCE_60M],
});
const explicitProgram = makeProgram({
  id: 'rp-explicit',
  triggers: [MANUAL_TRIGGER],
  cohortId: 'coh-explicit',
});
const releaseProgram = makeProgram({ id: 'rp-release', triggers: [MANUAL_TRIGGER] });
// Event-only, so a debouncing deployment is the *only* thing pending.
// `rp-all` would also have a due cadence slot, and the cadence would
// win, which would hide the debounce-pending outcome entirely.
const deployProgram = makeProgram({ id: 'rp-deploy', triggers: [DEPLOYMENT_TRIGGER] });
const model = makeModel({
  programs: [allProgram, explicitProgram, releaseProgram, deployProgram],
});

type Overrides = Omit<Partial<PlanEvaluationInput>, 'model' | 'programId' | 'now'> & {
  readonly programId: string;
  readonly now?: string;
};

function evaluate(overrides: Overrides): PlanDecision {
  const { programId, now, ...rest } = overrides;
  return planEvaluation({
    planningCeiling: 5,
    rates: RATES,
    maxMutatingActions: 2,
    ...rest,
    model,
    programId: reviewProgramId(programId),
    now: now ?? NOW,
  });
}

function expectDue(decision: PlanDecision) {
  if (decision.outcome !== 'due') throw new Error(`expected a plan, got ${decision.outcome}`);
  return decision.plan;
}

describe('TRIGGER_PRECEDENCE', () => {
  it('names every trigger kind the planner understands', () => {
    expect([...TRIGGER_PRECEDENCE].sort()).toEqual(['cadence', 'event', 'manual']);
  });

  it('is the order the planner actually resolves in', () => {
    // Past the deployment's debounce, so all three genuinely compete.
    const now = iso(10 * HOUR + 15 * 60_000);
    const manual = manualSignal('m1', iso(10 * HOUR));
    const deploy = deploymentSignal('d1', iso(10 * HOUR));

    // Dropping one signal at a time reveals the next one in the
    // declared order.
    const both = expectDue(evaluate({ programId: 'rp-all', now, signals: [manual, deploy] }));
    expect(both.trigger.kind).toBe('manual');

    const withoutManual = expectDue(
      evaluate({ programId: 'rp-all', now, signals: [deploy] }),
    );
    expect(withoutManual.trigger.kind).toBe('event');

    const cadenceOnly = expectDue(evaluate({ programId: 'rp-all', now }));
    expect(cadenceOnly.trigger.kind).toBe('cadence');

    expect([both.trigger.kind, withoutManual.trigger.kind, cadenceOnly.trigger.kind]).toEqual([
      ...TRIGGER_PRECEDENCE,
    ]);
  });
});

describe('NOT_DUE_REASONS', () => {
  it('lists exactly the reasons the planner can emit', () => {
    const seen = new Set<string>();

    // no-trigger: before the cadence anchor, nothing is due yet.
    record(
      evaluate({ programId: 'rp-all', now: iso(-HOUR) }),
      seen,
    );
    // debounce-pending: the deployment is inside its quiet period.
    record(
      evaluate({
        programId: 'rp-deploy',
        signals: [deploymentSignal('d1', iso(10 * HOUR))],
      }),
      seen,
    );
    // release-transition-lineage-missing: pinned with no transition.
    record(evaluate({ programId: 'rp-all', requestedMode: 'releaseTransition' }), seen);
    // budget-exhausted: a ceiling the cheapest plan cannot meet.
    record(evaluateExhausted(), seen);

    expect([...seen].sort()).toEqual([...NOT_DUE_REASONS].sort());
  });
});

describe('RETENTION_RESOLUTIONS', () => {
  it('is exactly the two ways a plan bounds participant retention', () => {
    expect([...RETENTION_RESOLUTIONS].sort()).toEqual([
      'cohort-lifecycle',
      'per-identity-at-runtime',
    ]);
  });

  it('matches how the planner chooses between them', () => {
    // `coh-release` names a lifecycle, so the ceiling follows from it.
    const named = expectDue(
      evaluate({ programId: 'rp-release', signals: [manualSignal('mr', iso(10 * HOUR))] }),
    );
    expect(named.authority.retentionResolution).toBe('cohort-lifecycle');
    expect(named.authority.maxParticipantStateRetention).toBe('durable');

    // `coh-explicit` names identities but not lifecycles, and resolving
    // those is #60's ticket, so the runtime narrows it per identity.
    const unnamed = expectDue(
      evaluate({ programId: 'rp-explicit', signals: [manualSignal('mx', iso(10 * HOUR))] }),
    );
    expect(unnamed.authority.retentionResolution).toBe('per-identity-at-runtime');
  });
});

describe('Plan keys survive a store round-trip', () => {
  it('re-parses a plan loaded back from storage rather than trusting the string', () => {
    const plan = expectDue(
      evaluate({ programId: 'rp-release', signals: [manualSignal('mr', iso(10 * HOUR))] }),
    );

    const reloaded = JSON.parse(
      JSON.stringify({ planKey: plan.planKey, idempotencyKey: plan.idempotencyKey }),
    ) as { planKey: string; idempotencyKey: string };

    expect(parsePlanKey(reloaded.planKey)).toBe(plan.planKey);
    expect(parseIdempotencyKey(reloaded.idempotencyKey)).toBe(plan.idempotencyKey);
  });

  it('refuses a key-shaped string that was not minted here', () => {
    expect(() => parsePlanKey('not-a-plan-key')).toThrow(/must be a valid PlanKey handle/);
    expect(() => parseIdempotencyKey('not-an-idempotency-key')).toThrow(
      /must be a valid IdempotencyKey handle/,
    );
  });
});

function record(decision: PlanDecision, seen: Set<string>): void {
  if (decision.outcome === 'not-due') {
    seen.add(decision.reason);
  }
}

function evaluateExhausted(): PlanDecision {
  const tight = makeProgram({
    id: 'rp-tight',
    triggers: [MANUAL_TRIGGER],
    cohortId: 'coh-explicit',
    budget: { maxCostUnitsPerDay: 1 },
  });
  const tightModel = makeModel({ programs: [tight] });
  return planEvaluation({
    model: tightModel,
    programId: reviewProgramId('rp-tight'),
    now: NOW,
    signals: [manualSignal('m9', iso(10 * HOUR))],
    planningCeiling: 5,
    rates: RATES,
    maxMutatingActions: 2,
  });
}
