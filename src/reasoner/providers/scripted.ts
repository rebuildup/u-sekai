/**
 * Deterministic scripted Reasoner (ADR-0005).
 *
 * The script is derived from the seed and the promptDigest so we get:
 *
 * - reproducible CI runs (no flake),
 * - same conversation == same next action,
 * - cap-the-budget exits cleanly,
 * - exit via `finish` action after a small number of scripted steps.
 *
 * This is the default Reasoner for tests and CI.
 */

import type { Reasoner, ReasonerRequest, ReasonerResponse } from '../../domain/reasoner.js';
import type { ParticipantAction } from '../../domain/capability.js';
import type { ReasonerConfig } from '../../domain/experiment.js';

interface ScriptedState {
  readonly script: ReadonlyArray<ParticipantAction>;
  cursor: number;
  finishedBySelfReport: boolean;
}

export function scriptedReasoner(
  config: ReasonerConfig & { script?: ReadonlyArray<ParticipantAction> },
  _ctx: { participantLabel?: string; role: 'participant' | 'observer' | 'selfReport' },
): Reasoner {
  const seed = config.seed ?? 'scripted';
  const defaultScript: ReadonlyArray<ParticipantAction> = [
    { kind: 'clickByCoords', x: 200, y: 200 },
    { kind: 'typeText', text: 'Buy milk' },
    { kind: 'wait', milliseconds: 200 },
    { kind: 'finish', reason: 'done' },
  ];
  const state: ScriptedState = {
    script: config.script ?? defaultScript,
    cursor: 0,
    finishedBySelfReport: false,
  };

  function pickAction(req: ReasonerRequest): ReasonerResponse {
    // The runtime puts role markers in the systemPrompt for self-report
    // and observer flows; the action flow uses a different systemPrompt.
    if (/Emit a JSON object matching the SelfReport shape/.test(req.systemPrompt)) {
      state.finishedBySelfReport = true;
      return {
        kind: 'selfReport',
        content: {
          goal: 'I wanted to add a task to my list.',
          productUnderstanding: 'It is a small task tracker with a single text input.',
          confusionPoints: ['I did not see a confirmation message'],
          resultAlignedWithExpectation: true,
          confidence: 0.6,
          wouldReturn: true,
          freeText: 'Worked once I found the right spot.',
        },
        usage: { inputTokens: req.messages.reduce((n, m) => n + m.content.length, 0), outputTokens: 64 },
      };
    }
    if (/Produce an ObserverFindings JSON object/.test(req.systemPrompt)) {
      return {
        kind: 'observerFindings',
        content: {
          summary: 'Single-step deterministic observation. No issues found by the script.',
          findings: [
            {
              id: 'f-script-1',
              stepIndex: null,
              severity: 'info',
              category: 'timing',
              summary: 'Scripted reasoner finished cleanly.',
              evidenceRefs: [],
            },
          ],
          terminationVerdict: { declared: 'finish', plausible: true, note: 'Scripted source.' },
        },
        usage: { inputTokens: req.messages.reduce((n, m) => n + m.content.length, 0), outputTokens: 64 },
      };
    }
    if (state.cursor >= state.script.length) {
      return {
        kind: 'action',
        action: { kind: 'finish', reason: `script exhausted (seed=${seed})` },
        rationale: 'Script exhausted.',
        usage: { inputTokens: req.messages.reduce((n, m) => n + m.content.length, 0), outputTokens: 16 },
      };
    }
    const action = state.script[state.cursor] as ParticipantAction;
    state.cursor += 1;
    return {
      kind: 'action',
      action,
      rationale: `scripted step ${state.cursor}`,
      usage: { inputTokens: req.messages.reduce((n, m) => n + m.content.length, 0), outputTokens: 16 },
    };
  }

  return {
    providerId: 'scripted',
    modelId: `scripted:${seed}`,
    complete: async (req) => pickAction(req),
  };
}
