/**
 * Deduplication and idempotency keys (issue #62).
 *
 * The acceptance criterion is "duplicate trigger delivery does not
 * create ambiguous run identity". These tests pin both halves of it:
 * redelivery yields *one* identity, and it yields it without charging
 * the budget a second time.
 */

import { describe, it, expect } from 'vitest';

import {
  canonicalKey,
  parseTriggerSignal,
  planEvaluation,
  type BudgetLedger,
  type PlanDecision,
} from '../../../src/program/index.js';
import {
  ANCHOR,
  CADENCE_60M,
  DEPLOYMENT_TRIGGER,
  MANUAL_TRIGGER,
  RATES,
  makeModel,
  makeProgram,
  reviewProgramId,
} from './fixtures.js';

const HOUR = 3_600_000;
function iso(offsetMs: number): string {
  return new Date(Date.parse(ANCHOR) + offsetMs).toISOString();
}

const cadenceProgram = makeProgram({ id: 'rp-cadence', triggers: [CADENCE_60M] });
const deployProgram = makeProgram({ id: 'rp-deploy', triggers: [DEPLOYMENT_TRIGGER] });
const manualProgram = makeProgram({ id: 'rp-manual', triggers: [MANUAL_TRIGGER] });
const model = makeModel({ programs: [cadenceProgram, deployProgram, manualProgram] });

const manualSignal = parseTriggerSignal({
  kind: 'manual',
  deliveryId: 'manual-1',
  requestedAt: iso(10 * HOUR),
});
const deploySignal = parseTriggerSignal({
  kind: 'event',
  deliveryId: 'deploy-4711',
  event: 'deployment.completed',
  occurredAt: iso(10 * HOUR),
});

function evaluate(
  programId: string,
  overrides: { now?: string; signals?: Parameters<typeof planEvaluation>[0]['signals']; ledger?: BudgetLedger } = {},
): PlanDecision {
  return planEvaluation({
    model,
    programId: reviewProgramId(programId),
    now: overrides.now ?? iso(10 * HOUR + 30_000),
    planningCeiling: 5,
    rates: RATES,
    maxMutatingActions: 2,
    ...(overrides.signals !== undefined ? { signals: overrides.signals } : {}),
    ...(overrides.ledger !== undefined ? { ledger: overrides.ledger } : {}),
  });
}

function expectDue(decision: PlanDecision): Extract<PlanDecision, { outcome: 'due' }> {
  if (decision.outcome !== 'due') {
    throw new Error(`expected a plan, got ${decision.outcome}`);
  }
  return decision;
}

describe('Cadence slot idempotency', () => {
  it('treats a re-plan inside the same slot as a duplicate, not a second run', () => {
    const first = expectDue(evaluate('rp-cadence', { now: iso(10 * HOUR + 30_000) }));
    const second = evaluate('rp-cadence', {
      now: iso(11 * HOUR - 1),
      ledger: first.ledger,
    });

    expect(second.outcome).toBe('duplicate');
    if (second.outcome !== 'duplicate') return;
    expect(second.planKey).toBe(first.plan.planKey);
    expect(second.idempotencyKey).toBe(first.plan.idempotencyKey);
    // Charged exactly once.
    expect(first.ledger.costUnitsSpent).toBe(first.plan.budget.costUnits);
    expect(second.ledger.costUnitsSpent).toBe(first.ledger.costUnitsSpent);
    expect(first.ledger.consumedKeys).toHaveLength(1);
  });

  it('plans the next slot as a distinct evaluation', () => {
    const first = expectDue(evaluate('rp-cadence', { now: iso(10 * HOUR + 30_000) }));
    const second = expectDue(
      evaluate('rp-cadence', { now: iso(11 * HOUR + 30_000), ledger: first.ledger }),
    );
    expect(second.plan.planKey).not.toBe(first.plan.planKey);
    expect(second.ledger.consumedKeys).toHaveLength(2);
    expect(second.ledger.costUnitsSpent).toBe(first.plan.budget.costUnits * 2);
  });
});

describe('Redelivery idempotency', () => {
  it('rejects a redelivered manual request without charging again', () => {
    const first = expectDue(evaluate('rp-manual', { signals: [manualSignal] }));
    const redelivered = evaluate('rp-manual', {
      signals: [manualSignal, manualSignal],
      now: iso(10 * HOUR + 45_000),
      ledger: first.ledger,
    });

    expect(redelivered.outcome).toBe('duplicate');
    if (redelivered.outcome !== 'duplicate') return;
    expect(redelivered.planKey).toBe(first.plan.planKey);
    expect(redelivered.firstPlannedAt).toBe(iso(10 * HOUR + 30_000));
    expect(redelivered.ledger.costUnitsSpent).toBe(first.plan.budget.costUnits);
  });

  it('rejects a redelivered deployment event without charging again', () => {
    const first = expectDue(
      evaluate('rp-deploy', { signals: [deploySignal], now: iso(10 * HOUR + 11 * 60_000) }),
    );
    const redelivered = evaluate('rp-deploy', {
      signals: [deploySignal],
      now: iso(10 * HOUR + 20 * 60_000),
      ledger: first.ledger,
    });
    expect(redelivered.outcome).toBe('duplicate');
    if (redelivered.outcome !== 'duplicate') return;
    expect(redelivered.planKey).toBe(first.plan.planKey);
    expect(redelivered.ledger.runsSpent).toBe(1);
  });

  it('treats distinct deliveries as distinct evaluations', () => {
    const first = expectDue(evaluate('rp-manual', { signals: [manualSignal] }));
    const second = expectDue(
      evaluate('rp-manual', {
        signals: [
          manualSignal,
          parseTriggerSignal({
            kind: 'manual',
            deliveryId: 'manual-2',
            requestedAt: iso(10 * HOUR + 2 * 60_000),
          }),
        ],
        now: iso(10 * HOUR + 3 * 60_000),
        ledger: first.ledger,
      }),
    );
    expect(second.plan.planKey).not.toBe(first.plan.planKey);
    expect(second.ledger.consumedKeys).toHaveLength(2);
  });
});

describe('Duplicate signal batches', () => {
  it('collapses identical copies of one delivery in a single batch', () => {
    const decision = expectDue(
      evaluate('rp-manual', { signals: [manualSignal, { ...manualSignal }, { ...manualSignal }] }),
    );
    expect(decision.ledger.consumedKeys).toHaveLength(1);
  });

  it('rejects two copies of one delivery that disagree on when it happened', () => {
    expect(() =>
      evaluate('rp-manual', {
        signals: [
          manualSignal,
          parseTriggerSignal({
            kind: 'manual',
            deliveryId: 'manual-1',
            requestedAt: iso(10 * HOUR + 5 * 60_000),
          }),
        ],
      }),
    ).toThrow(/conflicting copies of delivery manual-1/);
  });
});

describe('Canonical key encoding', () => {
  it('cannot be forged by a component that contains the separator', () => {
    // A naive `join('|')` would render both of these as `a|b|c` and two
    // distinct triggers would share a key — a silent double-charge.
    expect(canonicalKey(['a', 'b|c'])).not.toBe(canonicalKey(['a|b', 'c']));
    expect(canonicalKey(['a', 'b|c'])).toBe('1:a|3:b|c');
  });

  it('is order-significant', () => {
    expect(canonicalKey(['a', 'b'])).not.toBe(canonicalKey(['b', 'a']));
  });

  it('separates two programs that share a trigger', () => {
    const other = makeProgram({ id: 'rp-other', triggers: [MANUAL_TRIGGER] });
    const twoProgramModel = makeModel({ programs: [manualProgram, other] });
    const base = {
      model: twoProgramModel,
      now: iso(10 * HOUR + 30_000),
      signals: [manualSignal],
      planningCeiling: 5,
      rates: RATES,
      maxMutatingActions: 2,
    };
    const a = planEvaluation({ ...base, programId: reviewProgramId('rp-manual') });
    const b = planEvaluation({ ...base, programId: reviewProgramId('rp-other') });
    const aDue = expectDue(a);
    const bDue = expectDue(b);
    expect(aDue.plan.idempotencyKey).not.toBe(bDue.plan.idempotencyKey);
    expect(aDue.plan.planKey).not.toBe(bDue.plan.planKey);
  });

  it('refuses a ledger belonging to another program', () => {
    const other = makeProgram({ id: 'rp-other', triggers: [MANUAL_TRIGGER] });
    const twoProgramModel = makeModel({ programs: [manualProgram, other] });
    const first = expectDue(
      planEvaluation({
        model: twoProgramModel,
        programId: reviewProgramId('rp-manual'),
        now: iso(10 * HOUR + 30_000),
        signals: [manualSignal],
        planningCeiling: 5,
        rates: RATES,
        maxMutatingActions: 2,
      }),
    );
    expect(() =>
      planEvaluation({
        model: twoProgramModel,
        programId: reviewProgramId('rp-other'),
        now: iso(10 * HOUR + 31_000),
        planningCeiling: 5,
        rates: RATES,
        maxMutatingActions: 2,
        ledger: first.ledger,
      }),
    ).toThrow(/ledger belongs to program rp-manual, not to rp-other/);
  });
});
