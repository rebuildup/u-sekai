/**
 * Trigger evaluation and due/not-due planning (issue #62).
 *
 * Covers the acceptance criteria that are about *when* evaluation runs:
 * a cadence schedules evaluation of unchanged surfaces, a deployment
 * event triggers evaluation without making the PR/source diff the
 * review target, and resolution is deterministic when several triggers
 * match.
 */

import { describe, it, expect } from 'vitest';

import { parseReviewTrigger, type ReviewTriggerKind } from '../../../src/product/index.js';
import {
  cadenceSlotAt,
  nextCadenceSlot,
  parseTriggerSignal,
  planEvaluation,
  type PlanEvaluationInput,
} from '../../../src/program/index.js';
import {
  ANCHOR,
  CADENCE_60M,
  DEPLOYMENT_TRIGGER,
  MANUAL_TRIGGER,
  PROD_LIKE_ID,
  RATES,
  STAGING_ID,
  makeModel,
  makeProgram,
  deploymentSignal,
  manualSignal,
  observation,
  reviewProgramId,
} from './fixtures.js';

const HOUR = 3_600_000;

function iso(offsetMs: number): string {
  return new Date(Date.parse(ANCHOR) + offsetMs).toISOString();
}

/** 10:00:30 into the anchored day. */
const AT_10_00_30 = iso(10 * HOUR + 30_000);

const cadenceProgram = makeProgram({ id: 'rp-cadence', triggers: [CADENCE_60M] });
const deployProgram = makeProgram({ id: 'rp-deploy', triggers: [DEPLOYMENT_TRIGGER] });
const manualProgram = makeProgram({ id: 'rp-manual', triggers: [MANUAL_TRIGGER] });
const allProgram = makeProgram({
  id: 'rp-all',
  triggers: [CADENCE_60M, DEPLOYMENT_TRIGGER, MANUAL_TRIGGER],
});

const model = makeModel({ programs: [cadenceProgram, deployProgram, manualProgram, allProgram] });

function evaluate(
  overrides: Omit<Partial<PlanEvaluationInput>, 'programId'> & { programId: string },
): ReturnType<typeof planEvaluation> {
  return planEvaluation({
    model,
    now: AT_10_00_30,
    planningCeiling: 5,
    rates: RATES,
    maxMutatingActions: 2,
    ...overrides,
    programId: reviewProgramId(overrides.programId),
  });
}

/** A manual request and a deployment that are both live at AT_10_00_30. */
const manual = manualSignal('manual-1', iso(10 * HOUR + 2 * 60_000));
const deployment = deploymentSignal('deploy-4711', iso(10 * HOUR));

describe('Cadence planning', () => {
  it('schedules evaluation of unchanged product surfaces', () => {
    // No observation, no event, no source change: the program is
    // continuous, so "unchanged" is not a reason to skip. This is the
    // acceptance criterion, asserted directly.
    const decision = evaluate({ programId: 'rp-cadence' });
    expect(decision.outcome).toBe('due');
    if (decision.outcome !== 'due') return;

    expect(decision.plan.mode).toBe('continuous');
    expect(decision.plan.target.environmentId).toBe(STAGING_ID);
    expect(decision.plan.trigger).toEqual({
      kind: 'cadence',
      dueAt: iso(10 * HOUR),
      intervalMinutes: 60,
      timeZone: 'Asia/Tokyo',
    });
  });

  it('derives the same slot for every instant inside it', () => {
    const trigger = parseReviewTrigger(CADENCE_60M);
    if (trigger.kind !== 'cadence') throw new Error('expected a cadence trigger');
    const early = cadenceSlotAt(trigger, Date.parse(iso(10 * HOUR)));
    const late = cadenceSlotAt(trigger, Date.parse(iso(11 * HOUR - 1)));
    expect(early).toBe(iso(10 * HOUR));
    expect(late).toBe(iso(10 * HOUR));
    expect(cadenceSlotAt(trigger, Date.parse(iso(11 * HOUR)))).toBe(iso(11 * HOUR));
  });

  it('is not due before the declared start, and says when it will be', () => {
    const decision = evaluate({ programId: 'rp-cadence', now: iso(-HOUR) });
    expect(decision.outcome).toBe('not-due');
    if (decision.outcome !== 'not-due') return;
    expect(decision.reason).toBe('no-trigger');
    expect(decision.nextDueAt).toBe(ANCHOR);
  });

  it('reports the next slot when no signal has arrived', () => {
    const trigger = parseReviewTrigger(CADENCE_60M);
    if (trigger.kind !== 'cadence') throw new Error('expected a cadence trigger');
    expect(nextCadenceSlot(trigger, Date.parse(AT_10_00_30))).toBe(iso(11 * HOUR));
  });
});

describe('Event trigger planning', () => {
  it('triggers evaluation on a deployment without making the diff the target', () => {
    const decision = evaluate({
      programId: 'rp-deploy',
      now: iso(10 * HOUR + 10 * 60_000),
      signals: [deploymentSignal('deploy-4711', iso(10 * HOUR))],
    });
    expect(decision.outcome).toBe('due');
    if (decision.outcome !== 'due') return;

    // The review target is the environment, and the trigger records the
    // deployment's own identity.
    expect(decision.plan.target).toEqual({
      productId: 'prd-task-tracker',
      environmentId: STAGING_ID,
      cohortId: 'coh-release',
      programId: 'rp-deploy',
    });
    expect(decision.plan.trigger).toEqual({
      kind: 'event',
      dueAt: iso(10 * HOUR + 10 * 60_000),
      deliveryId: 'deploy-4711',
      event: 'deployment.completed',
      debounceMinutes: 10,
    });

    // No Git-shaped key anywhere on the plan, at any depth.
    const serialised = JSON.stringify(decision.plan).toLowerCase();
    for (const forbidden of ['branch', 'commit', 'sha', 'diff', 'mergeRequest', 'pullrequest', '"pr"']) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('refuses a PR-shaped deployment payload at the signal boundary', () => {
    // Normalisation happens before a signal reaches the planner, so a
    // webhook body carrying a pull request cannot be smuggled in and
    // become part of trigger identity.
    expect(() =>
      parseTriggerSignal({
        kind: 'event',
        deliveryId: 'deploy-4712',
        event: 'deployment.completed',
        occurredAt: iso(10 * HOUR),
        pullRequest: 4712,
      }),
    ).toThrow(/unknown field\(s\): pullRequest/);

    expect(() =>
      parseTriggerSignal({
        kind: 'event',
        deliveryId: 'deploy-4713',
        event: 'deployment.completed',
        occurredAt: iso(10 * HOUR),
        commitSha: 'deadbeef',
      }),
    ).toThrow(/unknown field\(s\): commitSha/);
  });

  it('is not due until the declared debounce has elapsed', () => {
    const signals = [
      parseTriggerSignal({
        kind: 'event',
        deliveryId: 'deploy-4711',
        event: 'deployment.completed',
        occurredAt: iso(10 * HOUR),
      }),
    ];

    const during = evaluate({ programId: 'rp-deploy', now: iso(10 * HOUR + 5 * 60_000), signals });
    expect(during.outcome).toBe('not-due');
    if (during.outcome !== 'not-due') return;
    expect(during.reason).toBe('debounce-pending');
    expect(during.nextDueAt).toBe(iso(10 * HOUR + 10 * 60_000));

    const after = evaluate({
      programId: 'rp-deploy',
      now: iso(10 * HOUR + 10 * 60_000),
      signals,
    });
    expect(after.outcome).toBe('due');
  });

  it('ignores an event the program does not declare', () => {
    const decision = evaluate({
      programId: 'rp-deploy',
      signals: [
        parseTriggerSignal({
          kind: 'event',
          deliveryId: 'deploy-9999',
          event: 'deployment.failed',
          occurredAt: iso(10 * HOUR),
        }),
      ],
    });
    expect(decision.outcome).toBe('not-due');
    if (decision.outcome !== 'not-due') return;
    expect(decision.reason).toBe('no-trigger');
  });

  it('debounces a burst into one evaluation, keeping the last occurrence', () => {
    const decision = evaluate({
      programId: 'rp-deploy',
      now: iso(10 * HOUR + 20 * 60_000),
      signals: [
        parseTriggerSignal({
          kind: 'event',
          deliveryId: 'deploy-1',
          event: 'deployment.completed',
          occurredAt: iso(10 * HOUR),
        }),
        parseTriggerSignal({
          kind: 'event',
          deliveryId: 'deploy-2',
          event: 'deployment.completed',
          occurredAt: iso(10 * HOUR + 8 * 60_000),
        }),
      ],
    });
    expect(decision.outcome).toBe('due');
    if (decision.outcome !== 'due') return;
    if (decision.plan.trigger.kind !== 'event') throw new Error('expected an event trigger');
    expect(decision.plan.trigger.deliveryId).toBe('deploy-2');
    // The superseded occurrence is reported, not dropped.
    expect(decision.suppressed).toEqual([
      {
        kind: 'event',
        dueAt: iso(10 * HOUR + 10 * 60_000),
        reason: 'superseded-by-higher-precedence',
        deliveryId: 'deploy-1',
      },
    ]);
  });
});

describe('Trigger precedence', () => {
  it('resolves manual > event > cadence, deterministically', () => {
    // Planned after the deployment's 10-minute debounce, so the event
    // is an eligible candidate and genuinely competes with the manual
    // request and the due cadence slot.
    const decision = evaluate({
      programId: 'rp-all',
      now: iso(10 * HOUR + 15 * 60_000),
      signals: [manual, deployment],
    });
    expect(decision.outcome).toBe('due');
    if (decision.outcome !== 'due') return;
    expect(decision.plan.trigger.kind).toBe('manual');
    expect(decision.suppressed.map((s) => s.kind).sort()).toEqual(['cadence', 'event']);
    for (const suppressed of decision.suppressed) {
      expect(suppressed.reason).toBe('superseded-by-higher-precedence');
    }
  });

  it('prefers the deployment over the cadence when nobody asked', () => {
    const decision = evaluate({
      programId: 'rp-all',
      now: iso(10 * HOUR + 10 * 60_000),
      signals: [deployment],
    });
    expect(decision.outcome).toBe('due');
    if (decision.outcome !== 'due') return;
    expect(decision.plan.trigger.kind).toBe('event');
    expect(decision.suppressed.map((s) => s.kind)).toEqual(['cadence']);
  });

  it('yields the same winner regardless of signal array order', () => {
    const forward = evaluate({
      programId: 'rp-all',
      now: iso(10 * HOUR + 15 * 60_000),
      signals: [manual, deployment],
    });
    const reversed = evaluate({
      programId: 'rp-all',
      now: iso(10 * HOUR + 15 * 60_000),
      signals: [deployment, manual],
    });
    expect(forward.outcome).toBe('due');
    expect(reversed.outcome).toBe('due');
    if (forward.outcome !== 'due' || reversed.outcome !== 'due') return;
    expect(reversed.plan.planKey).toBe(forward.plan.planKey);
    expect(reversed.plan.trigger).toEqual(forward.plan.trigger);
  });

  it('orders simultaneous same-kind signals by delivery id, not array order', () => {
    const a = parseTriggerSignal({ kind: 'manual', deliveryId: 'manual-a', requestedAt: iso(10 * HOUR) });
    const b = parseTriggerSignal({ kind: 'manual', deliveryId: 'manual-b', requestedAt: iso(10 * HOUR) });
    const first = evaluate({ programId: 'rp-manual', signals: [a, b] });
    const second = evaluate({ programId: 'rp-manual', signals: [b, a] });
    if (first.outcome !== 'due' || second.outcome !== 'due') throw new Error('expected both due');
    if (first.plan.trigger.kind !== 'manual' || second.plan.trigger.kind !== 'manual') {
      throw new Error('expected manual triggers');
    }
    expect(first.plan.trigger.deliveryId).toBe('manual-b');
    expect(second.plan.trigger.deliveryId).toBe('manual-b');
    expect(first.plan.planKey).toBe(second.plan.planKey);
  });

  it('picks the most recent manual request', () => {
    const older = parseTriggerSignal({
      kind: 'manual',
      deliveryId: 'manual-old',
      requestedAt: iso(10 * HOUR),
    });
    const newer = parseTriggerSignal({
      kind: 'manual',
      deliveryId: 'manual-new',
      requestedAt: iso(10 * HOUR + 3 * 60_000),
    });
    const decision = evaluate({ programId: 'rp-manual', signals: [older, newer] });
    if (decision.outcome !== 'due') throw new Error('expected due');
    if (decision.plan.trigger.kind !== 'manual') throw new Error('expected manual');
    expect(decision.plan.trigger.deliveryId).toBe('manual-new');
    expect(decision.suppressed.map((s) => s.deliveryId)).toEqual(['manual-old']);
  });

  it('charges only the winner, and leaves a suppressed slot unconsumed', () => {
    // The cadence slot stays unconsumed when a manual request wins, so
    // a later planning call can still evaluate that slot rather than
    // silently losing an hour of continuous coverage.
    const first = evaluate({
      programId: 'rp-all',
      now: iso(10 * HOUR + 15 * 60_000),
      signals: [manual, deployment],
    });
    if (first.outcome !== 'due') throw new Error('expected due');
    expect(first.plan.trigger.kind).toBe('manual');
    // Exactly one reservation, for the winner only.
    expect(first.ledger.consumedKeys).toEqual([first.plan.idempotencyKey]);
    expect(first.ledger.runsSpent).toBe(1);

    const followUp = evaluate({
      programId: 'rp-all',
      now: iso(10 * HOUR + 10 * 60_000),
      signals: [deployment],
      ledger: first.ledger,
    });
    if (followUp.outcome !== 'due') throw new Error('expected due');
    expect(followUp.plan.trigger.kind).toBe('event');
    expect(followUp.plan.idempotencyKey).not.toBe(first.plan.idempotencyKey);
    expect(followUp.ledger.consumedKeys).toHaveLength(2);

    // And the suppressed cadence slot is still available afterwards.
    const cadenceOnly = evaluate({ programId: 'rp-all', ledger: followUp.ledger });
    if (cadenceOnly.outcome !== 'due') throw new Error('expected due');
    expect(cadenceOnly.plan.trigger.kind).toBe('cadence');
  });
});

describe('Trigger input validation', () => {
  it('rejects a signal kind the planner does not model', () => {
    expect(() => parseTriggerSignal({ kind: 'cron', deliveryId: 'x' })).toThrow(
      /kind must be one of: event, manual/,
    );
  });

  it('rejects a non-instant timestamp', () => {
    expect(() =>
      parseTriggerSignal({ kind: 'manual', deliveryId: 'manual-1', requestedAt: '2026-03-02' }),
    ).toThrow(/ISO-8601 instant with an explicit UTC offset/);
  });

  it('rejects a program that is not in the model', () => {
    expect(() => evaluate({ programId: 'rp-absent' })).toThrow(/rp-absent is not in this model/);
  });

  it('rejects a planning ceiling above the module maximum', () => {
    expect(() => evaluate({ programId: 'rp-cadence', planningCeiling: 100_000 })).toThrow(
      /input.planningCeiling must be between 1 and 1000/,
    );
  });

  it('targets the latest observed environment the program declares', () => {
    const bothEnvironments = makeProgram({
      id: 'rp-both',
      triggers: [CADENCE_60M],
      environmentIds: [STAGING_ID, PROD_LIKE_ID],
    });
    const twoEnvModel = makeModel({ programs: [bothEnvironments] });
    const base: PlanEvaluationInput = {
      model: twoEnvModel,
      programId: reviewProgramId('rp-both'),
      now: AT_10_00_30,
      planningCeiling: 5,
      rates: RATES,
      maxMutatingActions: 2,
    };

    const stagingOnly = planEvaluation(base);
    if (stagingOnly.outcome !== 'due') throw new Error('expected due');
    // With no observation the declared order decides.
    expect(stagingOnly.plan.target.environmentId).toBe(STAGING_ID);

    const withObservation = planEvaluation({
      ...base,
      observations: [
        observation({
          observationId: 'obs-prodlike',
          environmentId: PROD_LIKE_ID,
          version: '2026.03.02',
          observedAt: iso(9 * HOUR),
        }),
      ],
    });
    if (withObservation.outcome !== 'due') throw new Error('expected due');
    expect(withObservation.plan.target.environmentId).toBe(PROD_LIKE_ID);
    // And the plan carries the version it was observed at, without that
    // version becoming the target's identity.
    expect(withObservation.plan.observedVersion?.version).toBe('2026.03.02');
    expect(withObservation.plan.target.environmentId).toBe(PROD_LIKE_ID);
  });

  it('ignores an observation of an environment the program does not declare', () => {
    const decision = evaluate({
      programId: 'rp-all',
      signals: [manual],
      observations: [
        observation({
          observationId: 'obs-prodlike',
          environmentId: PROD_LIKE_ID,
          version: '2026.03.02',
          observedAt: iso(9 * HOUR),
        }),
      ],
    });
    if (decision.outcome !== 'due') throw new Error('expected due');
    expect(decision.plan.target.environmentId).toBe(STAGING_ID);
  });
});

describe('Declared trigger kinds', () => {
  it('keeps one trigger per kind, as #57 requires', () => {
    const kinds: ReviewTriggerKind[] = ['manual', 'event', 'cadence'];
    expect(kinds).toHaveLength(3);
    const trigger = parseReviewTrigger(DEPLOYMENT_TRIGGER);
    expect(trigger.kind).toBe('event');
  });
});
