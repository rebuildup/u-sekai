/**
 * Independent observer findings. Generated from the full experiment trace
 * (events, observations, action results) but explicitly NOT from
 * participant memory — those are separate contexts.
 */

export type ObserverFindingSeverity = 'info' | 'minor' | 'major' | 'critical';

export interface ObserverFinding {
  readonly id: string;
  readonly stepIndex: number | null;
  readonly severity: ObserverFindingSeverity;
  readonly category:
    | 'dead_end'
    | 'friction'
    | 'confusion'
    | 'trust'
    | 'navigation'
    | 'timing'
    | 'error'
    | 'positive';
  readonly summary: string;
  readonly evidenceRefs: ReadonlyArray<{
    kind: 'event' | 'observation' | 'selfReport';
    ref: string;
  }>;
}

export interface ObserverReport {
  readonly capturedAt: string;
  readonly summary: string;
  readonly findings: ReadonlyArray<ObserverFinding>;
  readonly terminationVerdict: {
    readonly declared: string;
    readonly plausible: boolean;
    readonly note: string;
  };
}
