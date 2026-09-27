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

/**
 * One failed structured-output attempt (ADR-0008).
 *
 * Every field needed to tell retry-success from retry-exhaustion is on the
 * event itself, so a reader never has to correlate with the surrounding
 * trace. The payload carries no HTTP headers, no API key, and only a hard
 * capped, redacted excerpt of provider text.
 */
export interface ReasonerFailureEvent {
  readonly type: 'reasoner.failure';
  readonly runId: string;
  readonly ts: string;
  /** Which structured output was expected. */
  readonly outputKind: 'action' | 'selfReport' | 'observerFindings';
  /** Which Reasoner channel produced the failure. */
  readonly channel: 'participant' | 'observer' | 'selfReport';
  readonly failureKind: import('./errors.js').StructuredFailureKind;
  readonly provider: string;
  readonly modelId: string;
  /** 1-based attempt number. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Whether the taxonomy and policy considered this failure kind retryable. */
  readonly retryable: boolean;
  /** Whether another attempt was actually made. */
  readonly willRetry: boolean;
  /** Whether recovery eventually succeeded, or the sequence was exhausted. */
  readonly recoveryOutcome: 'recovered' | 'exhausted';
  /** Redacted, bounded diagnostic message. */
  readonly message: string;
  readonly participantId?: string;
  readonly stepIndex?: number;
  readonly httpStatus?: number;
  /** Redacted, hard-capped provider text excerpt. */
  readonly excerpt?: string;
}

export type TerminationReason =
  | 'finish'
  | 'stepBudgetExceeded'
  | 'capabilityViolation'
  | 'error'
  | 'finishFromObserver'
  | 'finishFromSelfReport'
  /**
   * Terminal state for a recoverable-but-exhausted structured-output
   * failure (ADR-0008). Distinct from `capabilityViolation` so a provider
   * defect is never reported as a participant capability defect.
   */
  | 'reasonerFailure';

export interface TerminationEvent {
  readonly type: 'termination';
  readonly runId: string;
  readonly participantId: string;
  readonly ts: string;
  readonly reason: TerminationReason;
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
  | ReasonerFailureEvent
  | TerminationEvent
  | SelfReportPromptEvent
  | SelfReportResponseEvent
  | ObserverPromptEvent
  | ObserverResponseEvent
  | RunStartEvent
  | RunEndEvent;

/**
 * One Reasoner structured-output failure, folded into
 * `BehavioralEvidence` so a run's real failure mode is diagnosable from
 * `result.json` without re-reading `events.ndjson` (ADR-0008).
 */
export interface ReasonerFailureEvidence {
  readonly ts: string;
  readonly where: string;
  readonly channel: ReasonerFailureEvent['channel'];
  readonly outputKind: ReasonerFailureEvent['outputKind'];
  readonly failureKind: ReasonerFailureEvent['failureKind'];
  readonly provider: string;
  readonly modelId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly retryable: boolean;
  readonly recoveryOutcome: ReasonerFailureEvent['recoveryOutcome'];
  readonly message: string;
}

export interface BehavioralEvidence {
  readonly runId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly stepCountByParticipant: Record<string, number>;
  readonly actionSequencesByParticipant: Record<string, ReadonlyArray<ParticipantAction>>;
  readonly navigationsByParticipant: Record<string, ReadonlyArray<{ step: number; from: string; to: string }>>;
  /** Runtime-enforced capability violations. Provider defects live in `reasonerFailures`. */
  readonly runtimeErrors: ReadonlyArray<{ ts: string; where: string; message: string }>;
  /** Structured Reasoner failures, including recovered ones. */
  readonly reasonerFailures: ReadonlyArray<ReasonerFailureEvidence>;
  readonly terminationReasonByParticipant: Record<string, TerminationReason>;
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
