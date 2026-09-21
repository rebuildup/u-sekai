/**
 * Reasoner interface (ADR-0005).
 *
 * Providers translate `ReasonerRequest` -> provider-native JSON and back;
 * the participant runtime only ever sees `ReasonerResponse`.
 */

export interface ReasonerMessage {
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
}

export interface ReasonerRequest {
  readonly systemPrompt: string;
  readonly messages: ReadonlyArray<ReasonerMessage>;
  /** Maximum tokens the provider may consume for this call. */
  readonly maxTokens: number;
  /** Optional temperature; defaults are provider-specific. */
  readonly temperature?: number;
  /** Optional stop sequences. */
  readonly stop?: ReadonlyArray<string>;
}

export type ReasonerResponse =
  | {
      readonly kind: 'action';
      readonly action: ParticipantActionT;
      readonly rationale: string;
      readonly usage: { inputTokens: number; outputTokens: number };
    }
  | {
      readonly kind: 'selfReport';
      readonly content: Record<string, unknown>;
      readonly usage: { inputTokens: number; outputTokens: number };
    }
  | {
      readonly kind: 'observerFindings';
      readonly content: Record<string, unknown>;
      readonly usage: { inputTokens: number; outputTokens: number };
    }
  | {
      readonly kind: 'refusal';
      readonly message: string;
      readonly usage: { inputTokens: number; outputTokens: number };
    };

import type { ParticipantAction } from './capability.js';
type ParticipantActionT = ParticipantAction;

export interface Reasoner {
  readonly providerId: string;
  readonly modelId: string;
  complete(request: ReasonerRequest): Promise<ReasonerResponse>;
}
