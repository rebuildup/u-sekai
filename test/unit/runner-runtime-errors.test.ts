/**
 * `BehavioralEvidence.runtimeErrors` is the run's runtime-error rollup, so
 * `runParticipant`'s diagnostic has to survive the trip through the runner
 * without being dropped and without being counted twice.
 */

import { describe, it, expect } from 'vitest';
import { isRuntimeErrorAlreadyRecorded, runtimeErrorsForParticipant } from '../../src/experiment/runner.js';
import type { RunEvent } from '../../src/domain/evidence.js';

const ts = '2026-01-01T00:00:00.000Z';

function violationEvent(participantId: string, reason: string): RunEvent {
  return {
    type: 'capability.violation',
    runId: 'run-1',
    participantId,
    stepIndex: 0,
    ts,
    axis: 'action',
    reason,
  };
}

describe('isRuntimeErrorAlreadyRecorded', () => {
  it('is true only when the same diagnostic already has a capability.violation entry', () => {
    const events: RunEvent[] = [violationEvent('p-a', 'reasoner emitted a privileged action attempt')];

    expect(isRuntimeErrorAlreadyRecorded(events, 'p-a', 'reasoner emitted a privileged action attempt'))
      .toBe(true);
  });

  it('is false for a different message, so a second, distinct failure is still reported', () => {
    const events: RunEvent[] = [violationEvent('p-a', 'action "selectorClick" is not in the visualOnly allowlist')];

    expect(isRuntimeErrorAlreadyRecorded(events, 'p-a', 'navigation failed: target stopped responding'))
      .toBe(false);
  });

  it('is false for another participant that hit the same failure', () => {
    const events: RunEvent[] = [violationEvent('p-a', 'shared failure')];

    expect(isRuntimeErrorAlreadyRecorded(events, 'p-b', 'shared failure')).toBe(false);
  });
});

describe('runtimeErrorsForParticipant', () => {
  const evidence = {
    runtimeErrors: [
      { ts, where: 'participant=p-a step=0 axis=action', message: 'violation on p-a' },
      { ts, where: 'participant=p-b step=3', message: 'failure on p-b' },
      { ts, where: 'participant=p-a', message: 'failure on p-a' },
    ],
  } as unknown as Parameters<typeof runtimeErrorsForParticipant>[0];

  it('selects only the entries whose `where` names the participant', () => {
    expect(runtimeErrorsForParticipant(evidence, 'p-a').map((e) => e.message))
      .toEqual(['violation on p-a', 'failure on p-a']);
    expect(runtimeErrorsForParticipant(evidence, 'p-b').map((e) => e.message))
      .toEqual(['failure on p-b']);
    expect(runtimeErrorsForParticipant(evidence, 'p-c')).toEqual([]);
  });
});
