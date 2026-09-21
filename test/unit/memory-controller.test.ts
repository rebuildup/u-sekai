import { describe, it, expect } from 'vitest';
import { buildReasonerRequest, memoryWindowDescription } from '../../src/capability/memory-controller.js';
import type { ObservationCapturedEvent } from '../../src/domain/evidence.js';
import type { RunEvent } from '../../src/domain/evidence.js';

const PERSONA = 'A first-time visitor.';
const USER_STORY = 'Add a task to the list.';

function buildHistory(events: RunEvent[]): RunEvent[] {
  return events;
}

function ev(stepIndex: number, url: string, title: string): ObservationCapturedEvent {
  return {
    type: 'observation.captured',
    runId: 'r',
    participantId: 'p',
    stepIndex,
    ts: '2026-09-21T10:00:00.000Z',
    url,
    title,
  };
}

describe('memory-controller', () => {
  it('fullHistory includes every prior step plus the current step', () => {
    const events = [ev(0, 'http://a', 'A'), ev(1, 'http://b', 'B'), ev(2, 'http://c', 'C')];
    const out = buildReasonerRequest(
      {
        personaPrompt: PERSONA,
        userStory: USER_STORY,
        systemPrompt: 'sp',
        history: buildHistory(events),
        currentObservation: ev(3, 'http://d', 'D'),
        maxTokens: 256,
      },
      { kind: 'fullHistory' },
    );
    expect(out.includedStepIndices).toEqual([0, 1, 2, 3]);
    expect(out.droppedStepIndices).toEqual([]);
  });

  it('limitedRecent drops older steps when over budget', () => {
    const events = [ev(0, 'http://a', 'A'), ev(1, 'http://b', 'B'), ev(2, 'http://c', 'C'), ev(3, 'http://d', 'D')];
    const out = buildReasonerRequest(
      {
        personaPrompt: PERSONA,
        userStory: USER_STORY,
        systemPrompt: 'sp',
        history: buildHistory(events),
        currentObservation: ev(4, 'http://e', 'E'),
        maxTokens: 256,
      },
      { kind: 'limitedRecent', windowSteps: 2 },
    );
    expect(out.includedStepIndices).toEqual([2, 3, 4]);
    expect(out.droppedStepIndices).toEqual([0, 1]);
  });

  it('memoryWindowDescription is human-readable', () => {
    expect(memoryWindowDescription({ kind: 'fullHistory' })).toContain('all prior');
    expect(memoryWindowDescription({ kind: 'limitedRecent', windowSteps: 3 })).toContain('3');
  });

  it('rejects invalid limitedRecent window', () => {
    expect(() =>
      buildReasonerRequest(
        {
          personaPrompt: PERSONA,
          userStory: USER_STORY,
          systemPrompt: 'sp',
          history: [],
          currentObservation: ev(0, 'http://a', 'A'),
          maxTokens: 256,
        },
        { kind: 'limitedRecent', windowSteps: 0 },
      ),
    ).toThrow();
  });
});
