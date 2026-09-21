/**
 * Public experiment contract. An experiment definition is the durable
 * artefact a user passes to `u-sekai run`.
 */

import type { CapabilityProfile } from './capability.js';

export interface TargetEnvironment {
  readonly kind: 'http';
  readonly url: string;
}

export interface DemoEnvironment {
  readonly kind: 'demo';
  /** In-repo demo server. Address is allocated at runtime. */
  readonly app: 'task-tracker';
}

export type EnvironmentRef = TargetEnvironment | DemoEnvironment;

export interface ReasonerConfig {
  readonly provider: 'anthropic' | 'scripted';
  readonly modelId?: string;
  /** Optional deterministic seed for providers that accept one. */
  readonly seed?: string;
}

export interface ParticipantConfig {
  readonly id: string;
  /** Free-form persona / situation prompt — what the user would say about themselves. */
  readonly personaPrompt: string;
  readonly capability: CapabilityProfile;
  /** Reasoner used by this participant (and by its self-report). */
  readonly reasoner: ReasonerConfig;
}

export interface ExperimentDefinition {
  readonly id: string;
  readonly environment: EnvironmentRef;
  readonly userStory: string;
  readonly participants: ReadonlyArray<ParticipantConfig>;
  readonly budget: {
    readonly maxStepsPerParticipant: number;
  };
  /**
   * The provider used to run the independent observer. May reuse the
   * same provider as a participant but never shares its context.
   */
  readonly observer: ReasonerConfig;
  readonly outDir: string;
  /** Deterministic seed for the run; used by scripted reasoner and event hashes. */
  readonly seed: string;
  readonly packageVersion?: string;
}
