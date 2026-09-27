/**
 * A local, provider-free Reasoner for the browser tests.
 *
 * The browser suite asserts on the participant runtime and the adapter,
 * not on a provider implementation, so it depends only on the
 * `Reasoner` domain interface. That keeps the suite decoupled from
 * `src/reasoner/**` (provider wiring, transport, prompt details) and
 * guarantees no API key and no network access.
 */

import type { Reasoner, ReasonerRequest, ReasonerResponse } from '../../../src/domain/reasoner.js';
import type { ParticipantAction } from '../../../src/domain/capability.js';

const USAGE = { inputTokens: 0, outputTokens: 1 };

/**
 * Replays a fixed action list, then finishes. A self-report response is
 * recognised the same way the shipped scripted provider does, by the
 * self-report instruction in the system prompt, so the runtime flow is
 * complete without depending on that provider's internals.
 */
export function fakeReasoner(script: ReadonlyArray<ParticipantAction>, label = 'fake'): Reasoner {
  let cursor = 0;
  return {
    providerId: 'fake',
    modelId: `fake:${label}`,
    complete(request: ReasonerRequest): Promise<ReasonerResponse> {
      if (/SelfReport shape/.test(request.systemPrompt)) {
        return Promise.resolve({
          kind: 'selfReport',
          content: {
            goal: 'add a task',
            productUnderstanding: 'a text field and an Add button',
            confusionPoints: [],
            resultAlignedWithExpectation: true,
            confidence: 0.5,
            wouldReturn: true,
            freeText: 'fake reasoner',
          },
          usage: USAGE,
        });
      }
      const action = script[cursor] ?? { kind: 'finish' as const, reason: 'fake script exhausted' };
      cursor += 1;
      return Promise.resolve({ kind: 'action', action, rationale: `fake step ${cursor}`, usage: USAGE });
    },
  };
}
