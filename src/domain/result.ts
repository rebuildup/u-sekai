import type { BehavioralEvidence } from './evidence.js';
import type { ObserverReport } from './observer.js';
import type { SelfReport } from './self-report.js';

/**
 * Machine-readable result. Single-value UX scores are explicitly NOT
 * computed; the three signals — participant, observer, evidence — remain
 * separable.
 */
export interface RunResult {
  readonly runId: string;
  readonly experimentPath: string;
  readonly seed: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly terminationReasons: Record<string, string>;
  readonly participants: ReadonlyArray<{
    participantId: string;
    selfReport: SelfReport;
  }>;
  readonly observer: ObserverReport;
  readonly evidence: BehavioralEvidence;
}
