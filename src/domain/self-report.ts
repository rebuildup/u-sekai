/**
 * Participant self-report structure. The participant runtime prompts its
 * Reasoner for this content using ONLY the participant's own memory state
 * — the experiment trace is NOT re-injected.
 */
export interface SelfReport {
  readonly participantId: string;
  readonly capturedAt: string;
  readonly goal: string;
  readonly productUnderstanding: string;
  readonly confusionPoints: ReadonlyArray<string>;
  readonly resultAlignedWithExpectation: boolean;
  readonly confidence: number; // 0..1
  readonly wouldReturn: boolean;
  readonly freeText: string;
}

export const EMPTY_SELF_REPORT: SelfReport = {
  participantId: '',
  capturedAt: '',
  goal: '',
  productUnderstanding: '',
  confusionPoints: [],
  resultAlignedWithExpectation: false,
  confidence: 0,
  wouldReturn: false,
  freeText: '',
};
