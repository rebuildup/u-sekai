/**
 * Budget enforcement, not just budget accounting (issue #62).
 *
 * The distinction under test: an *accounting* layer reports what was
 * spent after the fact and stops nothing, while an *enforcement* layer
 * decides before work starts whether it may start. These tests assert
 * the second, and assert the properties that keep it honest under
 * repetition and re-entrancy.
 */

import { describe, it, expect } from 'vitest';

import * as program from '../../../src/program/index.js';
import {
  BUDGET_DENIAL_REASONS,
  createBudgetLedger,
  defaultBudgetWindow,
  ledgerConsumes,
  ledgerPlannedAt,
  planEvaluation,
  reserve,
  type BudgetLedger,
  type PlanDecision,
} from '../../../src/program/index.js';
import {
  MANUAL_TRIGGER,
  RATES,
  makeModel,
  makeProgram,
  reviewProgramId,
} from './fixtures.js';

const NOW = '2026-03-02T10:00:30.000Z';
const CEILING = 5;

/**
 * `coh-explicit` declares two identities, so with ceiling 5:
 * scout 2*10 = 20, verification 2*50 = 100, total 120 per plan.
 */
const PLAN_COST = 120;

function manualSignal(n: number) {
  return {
    kind: 'manual' as const,
    deliveryId: `manual-${n}`,
    requestedAt: `2026-03-02T10:0${n}:00.000Z`,
  };
}

function modelWith(budget: Partial<Parameters<typeof makeProgram>[0]['budget']> = {}) {
  const program_ = makeProgram({
    id: 'rp-budget',
    triggers: [MANUAL_TRIGGER],
    cohortId: 'coh-explicit',
    budget,
  });
  return makeModel({ programs: [program_] });
}

function evaluate(
  model: ReturnType<typeof modelWith>,
  overrides: { signals?: readonly unknown[]; ledger?: BudgetLedger } = {},
): PlanDecision {
  return planEvaluation({
    model,
    programId: reviewProgramId('rp-budget'),
    now: NOW,
    signals: overrides.signals as never,
    planningCeiling: CEILING,
    rates: RATES,
    maxMutatingActions: 2,
    ...(overrides.ledger !== undefined ? { ledger: overrides.ledger } : {}),
  });
}

function expectDue(decision: PlanDecision): Extract<PlanDecision, { outcome: 'due' }> {
  if (decision.outcome !== 'due') throw new Error(`expected a plan, got ${decision.outcome}`);
  return decision;
}

describe('Exceeding the cost budget halts evaluation', () => {
  it('emits no plan once the ceiling is reached', () => {
    const model = modelWith({ maxCostUnitsPerDay: 2 * PLAN_COST });
    const first = expectDue(evaluate(model, { signals: [manualSignal(1)] }));
    expect(first.plan.budget.costUnits).toBe(PLAN_COST);

    const second = expectDue(
      evaluate(model, { signals: [manualSignal(2)], ledger: first.ledger }),
    );
    expect(second.ledger.costUnitsSpent).toBe(2 * PLAN_COST);

    const third = evaluate(model, { signals: [manualSignal(3)], ledger: second.ledger });
    expect(third.outcome).toBe('not-due');
    if (third.outcome !== 'not-due') return;
    expect(third.reason).toBe('budget-exhausted');
    expect(third.detail['denial']).toBe('cost-budget-exhausted');
    expect(third.detail['remainingCostUnits']).toBe(0);

    // The load-bearing assertion: there is no plan to execute. A budget
    // that only reported the overrun would still have produced one.
    expect('plan' in third).toBe(false);
  });

  it('leaves the ledger byte-for-byte unchanged when a reservation is denied', () => {
    const model = modelWith({ maxCostUnitsPerDay: PLAN_COST });
    const first = expectDue(evaluate(model, { signals: [manualSignal(1)] }));
    const denied = evaluate(model, { signals: [manualSignal(2)], ledger: first.ledger });
    expect(denied.outcome).toBe('not-due');
    if (denied.outcome !== 'not-due') return;
    expect(denied.ledger).toBe(first.ledger);
    expect(denied.ledger.costUnitsSpent).toBe(PLAN_COST);
    expect(denied.ledger.runsSpent).toBe(1);
    expect(denied.ledger.consumedKeys).toHaveLength(1);
  });

  it('halts on the run ceiling even when cost remains', () => {
    const model = modelWith({ maxRunsPerDay: 1, maxCostUnitsPerDay: 1_000_000 });
    const first = expectDue(evaluate(model, { signals: [manualSignal(1)] }));
    const second = evaluate(model, { signals: [manualSignal(2)], ledger: first.ledger });
    expect(second.outcome).toBe('not-due');
    if (second.outcome !== 'not-due') return;
    expect(second.detail['denial']).toBe('run-budget-exhausted');
    expect('plan' in second).toBe(false);
  });
});

describe('Monotonic budget accounting', () => {
  it('never decreases across a long mixed sequence', () => {
    const model = modelWith({ maxCostUnitsPerDay: 1_000_000, maxRunsPerDay: 1_000 });
    let ledger: BudgetLedger | undefined;
    const observed: number[] = [];
    for (let i = 1; i <= 6; i += 1) {
      const decision = evaluate(model, {
        signals: [manualSignal(i)],
        ...(ledger !== undefined ? { ledger } : {}),
      });
      if (decision.outcome === 'due') {
        ledger = decision.ledger;
      } else {
        expect(decision.ledger).toBe(ledger);
        continue;
      }
      observed.push(ledger.costUnitsSpent);
    }
    expect(observed).toEqual([PLAN_COST, 2 * PLAN_COST, 3 * PLAN_COST, 4 * PLAN_COST, 5 * PLAN_COST, 6 * PLAN_COST]);
    for (let i = 1; i < observed.length; i += 1) {
      expect(observed[i]!).toBeGreaterThan(observed[i - 1]!);
    }
  });

  it('exposes no API that could release, refund or reset spend', () => {
    // A re-entrant release path is the failure this guards. It is
    // checked against the module's exported surface so that adding one
    // later fails this test rather than quietly re-opening the hole.
    const forbidden = /release|refund|reset|revoke|rollback|credit|unspent|void|reclaim|revert/i;
    const offenders = Object.keys(program).filter((name) => forbidden.test(name));
    expect(offenders).toEqual([]);
  });

  it('cannot decrease spend through the only mutation, `reserve`', () => {
    const program_ = makeProgram({ id: 'rp-mono', triggers: [MANUAL_TRIGGER] });
    // A ceiling the third reservation cannot meet, and distinct
    // deliveries so the per-event ceiling is not what stops it.
    const ceilings = { ...program_.budget, maxRunsPerDay: 10, maxCostUnitsPerDay: 15, maxRunsPerEvent: 10 };
    let ledger = createBudgetLedger(program_.id, ceilings, defaultBudgetWindow(NOW));

    ledger = grantWith(ledger, { costUnits: 10, runs: 1 }, 'd1', 'ik_1:a');
    ledger = grantWith(ledger, { costUnits: 5, runs: 1 }, 'd2', 'ik_2:b');
    expect(ledger.costUnitsSpent).toBe(15);

    // Every subsequent reservation is a grant or a refusal; a refusal
    // returns the *same object*, so a caller that ignores the result
    // cannot have lost or gained spend.
    const refused = reserve(
      ledger,
      { costUnits: 10, runs: 1, deliveryId: 'd', at: NOW },
      { idempotencyKey: 'ik_3:c' as never, planKey: 'pk_3:c' as never },
    );
    expect(refused.granted).toBe(false);
    if (refused.granted) return;
    expect(refused.ledger).toBe(ledger);
    expect(refused.ledger.costUnitsSpent).toBe(15);
  });

  it('never releases spend when a reservation is refused for any reason', () => {
    const program_ = makeProgram({ id: 'rp-mono', triggers: [MANUAL_TRIGGER] });
    const ceilings = { ...program_.budget, maxCostUnitsPerDay: 10 };
    let ledger = createBudgetLedger(program_.id, ceilings, defaultBudgetWindow(NOW));
    ledger = grantWith(ledger, { costUnits: 10, runs: 1 }, 'd1', 'ik_1:a');

    const reasons = new Set<string>();
    const attempts = [
      { key: 'ik_1:a', costUnits: 1 }, // duplicate
      { key: 'ik_2:b', costUnits: 5 }, // cost exhausted
    ];
    for (const attempt of attempts) {
      const result = reserve(
        ledger,
        { costUnits: attempt.costUnits, runs: 1, deliveryId: 'd', at: NOW },
        { idempotencyKey: attempt.key as never, planKey: 'pk_x' as never },
      );
      expect(result.granted).toBe(false);
      if (result.granted) return;
      reasons.add(result.reason);
      expect(result.ledger).toBe(ledger);
      expect(result.ledger.costUnitsSpent).toBe(10);
    }
    expect(reasons).toEqual(new Set(['duplicate-trigger', 'cost-budget-exhausted']));
  });
});

describe('Re-entrant paths cannot release already-spent budget', () => {
  it('re-planning the same trigger re-uses the reservation instead of re-charging it', () => {
    const model = modelWith({ maxCostUnitsPerDay: PLAN_COST });
    const first = expectDue(evaluate(model, { signals: [manualSignal(1)] }));
    expect(first.ledger.costUnitsSpent).toBe(PLAN_COST);

    // Re-entering the planner with the committed ledger — the
    // redelivery, retry or supervisor-loop case — cannot buy the same
    // evaluation twice, and cannot hand the money back.
    for (let i = 0; i < 3; i += 1) {
      const again = evaluate(model, { signals: [manualSignal(1)], ledger: first.ledger });
      expect(again.outcome).toBe('duplicate');
      if (again.outcome !== 'duplicate') return;
      expect(again.ledger).toBe(first.ledger);
      expect(again.ledger.costUnitsSpent).toBe(PLAN_COST);
      expect(again.ledger.runsSpent).toBe(1);
      expect(again.ledger.consumedKeys).toEqual([first.plan.idempotencyKey]);
    }
  });

  it('pays for escalation up front, so the escalation path has nothing to charge', () => {
    const model = modelWith({ maxCostUnitsPerDay: 1_000_000 });
    const decision = expectDue(evaluate(model, { signals: [manualSignal(1)] }));
    const { budget, escalation } = decision.plan;

    // The full scout + verification envelope is already committed.
    expect(budget.costUnits).toBe(budget.scoutCostUnits + budget.verificationCostUnits);
    expect(escalation.reservedUpFront).toBe(true);
    expect(escalation.verificationCostUnits).toBe(budget.verificationCostUnits);
    expect(decision.ledger.costUnitsSpent).toBe(budget.costUnits);

    // Escalating any number of times, even past the declared ceiling,
    // cannot move the ledger: the escalation policy carries no ledger
    // and the planner's only mutation is `reserve` on a new key.
    for (let i = 0; i < escalation.maxVerifications + 5; i += 1) {
      const afterEscalation = evaluate(model, {
        signals: [manualSignal(1)],
        ledger: decision.ledger,
      });
      expect(afterEscalation.ledger.costUnitsSpent).toBe(budget.costUnits);
      expect(afterEscalation.ledger.runsSpent).toBe(1);
    }
  });

  it('charges a second, genuinely different evaluation exactly once', () => {
    const model = modelWith({ maxCostUnitsPerDay: 2 * PLAN_COST });
    const first = expectDue(evaluate(model, { signals: [manualSignal(1)] }));
    const second = expectDue(evaluate(model, { signals: [manualSignal(2)], ledger: first.ledger }));
    const third = evaluate(model, { signals: [manualSignal(2)], ledger: second.ledger });
    expect(third.outcome).toBe('duplicate');
    if (third.outcome !== 'duplicate') return;
    expect(third.ledger.costUnitsSpent).toBe(2 * PLAN_COST);
  });
});

describe('Per-event run ceiling', () => {
  it('is enforced by `reserve`', () => {
    // `planEvaluation` emits at most one plan per delivery, so with the
    // minimum ceiling #57 allows this cannot bind there. It is enforced
    // and tested at the gate that can actually be driven.
    const program_ = makeProgram({ id: 'rp-event', triggers: [MANUAL_TRIGGER] });
    const ceilings = { ...program_.budget, maxRunsPerEvent: 2, maxRunsPerDay: 100 };
    let ledger = createBudgetLedger(program_.id, ceilings, defaultBudgetWindow(NOW));

    ledger = grantWith(ledger, { costUnits: 0, runs: 1 }, 'd1', 'ik_1:a');
    ledger = grantWith(ledger, { costUnits: 0, runs: 1 }, 'd1', 'ik_2:b');
    expect(ledger.eventRuns['d1']).toBe(2);

    const third = reserve(
      ledger,
      { costUnits: 0, runs: 1, deliveryId: 'd1', at: NOW },
      { idempotencyKey: 'ik_3:c' as never, planKey: 'pk_3:c' as never },
    );
    expect(third.granted).toBe(false);
    if (third.granted) return;
    expect(third.reason).toBe('event-run-budget-exhausted');
    expect(third.ledger).toBe(ledger);
    expect(third.ledger.eventRuns['d1']).toBe(2);

    // A different delivery has its own allowance.
    const other = reserve(
      ledger,
      { costUnits: 0, runs: 1, deliveryId: 'd2', at: NOW },
      { idempotencyKey: 'ik_4:d' as never, planKey: 'pk_4:d' as never },
    );
    expect(other.granted).toBe(true);
  });
});

describe('Budget window', () => {
  it('is the UTC calendar day containing the planning instant', () => {
    const window = defaultBudgetWindow('2026-03-02T23:59:59.000Z');
    expect(window.start).toBe('2026-03-02T00:00:00.000Z');
    expect(window.end).toBe('2026-03-03T00:00:00.000Z');
  });

  it('names every denial reason it can produce', () => {
    expect([...BUDGET_DENIAL_REASONS].sort()).toEqual([
      'cost-budget-exhausted',
      'duplicate-trigger',
      'event-run-budget-exhausted',
      'run-budget-exhausted',
    ]);
  });
});

describe('Externally-supplied keys do not reach the prototype chain', () => {
  // Regression: `ledger.eventRuns[deliveryId] ?? 0` read through the
  // prototype chain. `constructor` and `toString` satisfy the handle
  // grammar, so a real delivery could read `Object` as its prior run
  // count; `Object + 1` is a string, and the per-event ceiling then
  // compared a string against a number while still appearing satisfied.
  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty'])(
    'treats a delivery id of %s as a fresh delivery, not an inherited value',
    (deliveryId) => {
      const program_ = makeProgram({ id: 'rp-proto', triggers: [MANUAL_TRIGGER] });
      const ceilings = { ...program_.budget, maxRunsPerEvent: 2, maxRunsPerDay: 100 };
      let ledger = createBudgetLedger(program_.id, ceilings, defaultBudgetWindow(NOW));

      const first = reserve(
        ledger,
        { costUnits: 0, runs: 1, deliveryId, at: NOW },
        { idempotencyKey: 'ik_1:a' as never, planKey: 'pk_1:a' as never },
      );
      expect(first.granted).toBe(true);
      if (!first.granted) return;
      ledger = first.ledger;

      // A number, not a stringified inherited function.
      expect(typeof ledger.eventRuns[deliveryId]).toBe('number');
      expect(ledger.eventRuns[deliveryId]).toBe(1);

      ledger = grantWith(ledger, { costUnits: 0, runs: 1 }, deliveryId, 'ik_2:b');
      expect(ledger.eventRuns[deliveryId]).toBe(2);

      const third = reserve(
        ledger,
        { costUnits: 0, runs: 1, deliveryId, at: NOW },
        { idempotencyKey: 'ik_3:c' as never, planKey: 'pk_3:c' as never },
      );
      expect(third.granted).toBe(false);
      if (third.granted) return;
      expect(third.reason).toBe('event-run-budget-exhausted');
    },
  );

  it('does not read an inherited value for a consumed key', () => {
    const program_ = makeProgram({ id: 'rp-proto', triggers: [MANUAL_TRIGGER] });
    const ledger = createBudgetLedger(program_.id, program_.budget, defaultBudgetWindow(NOW));
    expect(ledgerPlannedAt(ledger, 'constructor')).toBeUndefined();
    expect(ledgerConsumes(ledger, 'toString')).toBe(false);
  });
});

function grantWith(
  ledger: BudgetLedger,
  spend: { costUnits: number; runs: number },
  deliveryId: string,
  key: string,
): BudgetLedger {
  const result = reserve(
    ledger,
    { ...spend, deliveryId, at: NOW },
    { idempotencyKey: key as never, planKey: `pk_${key}` as never },
  );
  if (!result.granted) throw new Error(`expected ${key} to be granted, got ${result.reason}`);
  return result.ledger;
}

describe('Ledger identity', () => {
  it('is bound to the program that created it', () => {
    const program_ = makeProgram({ id: 'rp-budget', triggers: [MANUAL_TRIGGER] });
    const ledger = createBudgetLedger(program_.id, program_.budget, defaultBudgetWindow(NOW));
    expect(ledger.programId).toBe(reviewProgramId('rp-budget'));
    expect(ledger.costUnitsSpent).toBe(0);
    expect(ledger.consumedKeys).toEqual([]);
  });
});
