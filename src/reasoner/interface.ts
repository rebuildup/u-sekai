/**
 * Reasoner factory entry point. Adapters build Reasoner instances from
 * configuration without leaking provider-specific types upward.
 */

import type { Reasoner } from '../domain/reasoner.js';
import type { ReasonerConfig } from '../domain/experiment.js';
import type { ExperimentDefinition } from '../domain/experiment.js';
import { scriptedReasoner } from './providers/scripted.js';
import { anthropicReasoner } from './providers/anthropic.js';

export function createReasoner(
  config: ReasonerConfig,
  ctx: { participantLabel?: string; role: 'participant' | 'observer' | 'selfReport' },
): Reasoner {
  switch (config.provider) {
    case 'scripted':
      return scriptedReasoner(config, ctx);
    case 'anthropic':
      return anthropicReasoner(config, ctx);
  }
}

export function createReasonerForExperiment(
  experiment: ExperimentDefinition,
  observer: { provider: 'anthropic' | 'scripted'; modelId?: string; seed?: string },
): { perParticipant: Map<string, ReturnType<typeof createReasoner>>; observer: ReturnType<typeof createReasoner> } {
  const perParticipant = new Map<string, ReturnType<typeof createReasoner>>();
  for (const p of experiment.participants) {
    perParticipant.set(
      p.id,
      createReasoner(p.reasoner, { participantLabel: `${experiment.id}:${p.id}`, role: 'participant' }),
    );
  }
  const observerReasoner = createReasoner(
    { provider: observer.provider, ...(observer.modelId !== undefined ? { modelId: observer.modelId } : {}), ...(observer.seed !== undefined ? { seed: observer.seed } : {}) },
    { role: 'observer' },
  );
  return { perParticipant, observer: observerReasoner };
}
