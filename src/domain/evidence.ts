import type { ParticipantObservation } from './observation.js';
import type { ParticipantAction } from './capability.js';
import type { ReasonerRequest, ReasonerResponse } from './reasoner.js';

/**
 * Stable event types persisted to `events.ndjson`. New event types must
 * extend this union so the schema doc stays the source of truth.
 */

export interface StepStartEvent {
  readonly type: 'step.start';
  readonly runId: string;
  readonly participantId: string;
  readonly stepIndex: number;
  readonly ts: string;
}

export interface ObservationCapturedEvent {
  readonly type: 'observation.captured';
  readonly runId: string;
  readonly participantId: string;
  readonly stepIndex: number;
  readonly ts: string;
  readonly url: string;
  readonly title: string;
}

export interface ReasonerRequestEvent {
  readonly type: 'reasoner.request';
  readonly runId: string;
  readonly participantId: string;
  readonly stepIndex: number;
  readonly ts: string;
  readonly promptHash: string;
  readonly messageCount: number;
  /** Compact JSON-safe payload of the request without leaking API keys. */
  readonly request: Omit<ReasonerRequest, 'systemPrompt'> & { systemPromptDigest: string };
}

export interface ReasonerResponseEvent {
  readonly type: 'reasoner.response';
  readonly runId: string;
  readonly participantId: string;
  readonly stepIndex: number;
  readonly ts: string;
  readonly response: ReasonerResponse;
}

export interface ActionEvent {
  readonly type: 'action';
  readonly runId: string;
  readonly participantId: string;
  readonly stepIndex: number;
  readonly ts: string;
  readonly action: ParticipantAction;
}

export interface ActionResultEvent {
  readonly type: 'action.result';
  readonly runId: string;
  readonly participantId: string;
  readonly stepIndex: number;
  readonly ts: string;
  readonly result:
    | { status: 'ok'; note?: string }
    | { status: 'noop'; note: string }
    | { status: 'error'; note: string; code: string };
}

export interface CapabilityViolationEvent {
  readonly type: 'capability.violation';
  readonly runId: string;
  readonly participantId: string;
  readonly stepIndex: number;
  readonly ts: string;
  readonly axis: 'observation' | 'action' | 'memory';
  readonly reason: string;
}

export interface TerminationEvent {
  readonly type: 'termination';
  readonly runId: string;
  readonly participantId: string;
  readonly ts: string;
  readonly reason: 'finish' | 'stepBudgetExceeded' | 'capabilityViolation' | 'error' | 'finishFromObserver' | 'finishFromSelfReport';
}

export interface SelfReportPromptEvent {
  readonly type: 'selfReport.prompt';
  readonly runId: string;
  readonly participantId: string;
  readonly ts: string;
  readonly promptDigest: string;
}

export interface SelfReportResponseEvent {
  readonly type: 'selfReport.response';
  readonly runId: string;
  readonly participantId: string;
  readonly ts: string;
  readonly report: import('./self-report.js').SelfReport;
}

export interface ObserverPromptEvent {
  readonly type: 'observer.prompt';
  readonly runId: string;
  readonly ts: string;
  readonly promptDigest: string;
}

export interface ObserverResponseEvent {
  readonly type: 'observer.response';
  readonly runId: string;
  readonly ts: string;
  readonly report: import('./observer.js').ObserverReport;
}

export interface RunStartEvent {
  readonly type: 'run.start';
  readonly runId: string;
  readonly ts: string;
  readonly experimentPath: string;
  readonly seed: string;
  readonly packageVersion: string;
}

export interface RunEndEvent {
  readonly type: 'run.end';
  readonly runId: string;
  readonly ts: string;
  readonly durationMs: number;
}

export type RunEvent =
  | StepStartEvent
  | ObservationCapturedEvent
  | ReasonerRequestEvent
  | ReasonerResponseEvent
  | ActionEvent
  | ActionResultEvent
  | CapabilityViolationEvent
  | TerminationEvent
  | SelfReportPromptEvent
  | SelfReportResponseEvent
  | ObserverPromptEvent
  | ObserverResponseEvent
  | RunStartEvent
  | RunEndEvent;

export interface BehavioralEvidence {
  readonly runId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly stepCountByParticipant: Record<string, number>;
  readonly actionSequencesByParticipant: Record<string, ReadonlyArray<ParticipantAction>>;
  readonly navigationsByParticipant: Record<string, ReadonlyArray<{ step: number; from: string; to: string }>>;
  readonly runtimeErrors: ReadonlyArray<{ ts: string; where: string; message: string }>;
  readonly terminationReasonByParticipant: Record<string, TerminationEvent['reason']>;
  readonly participantConfigurations: ReadonlyArray<{
    participantId: string;
    personaPrompt: string;
    capability: import('./capability.js').CapabilityProfile;
  }>;
  readonly experimentSummaryHash: string;
}

export interface StoredObservation {
  readonly participantId: string;
  readonly stepIndex: number;
  readonly observation: ParticipantObservation;
}
