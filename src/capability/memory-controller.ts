/**
 * Memory controller (ADR-0006). Builds a `ReasonerRequest` for the
 * participant's Reasoner from the participant's own event history,
 * constrained by the participant's `MemoryCapability`. This is the ONLY
 * path through which prior events reach the Reasoner.
 */

import type { MemoryCapability } from '../domain/capability.js';
import type {
  ObservationCapturedEvent,
  ReasonerResponseEvent,
  RunEvent,
  ActionEvent,
  ActionResultEvent,
  SelfReportResponseEvent,
  StepStartEvent,
} from '../domain/evidence.js';
import type { ReasonerRequest } from '../domain/reasoner.js';
import { CapabilityViolation } from '../domain/errors.js';

const SYSTEM_PROMPT_DIGEST_PLACEHOLDER = 'system-prompt-digest';

export interface MemoryInputs {
  readonly personaPrompt: string;
  readonly userStory: string;
  readonly systemPrompt: string;
  readonly history: ReadonlyArray<RunEvent>;
  readonly currentObservation: ObservationCapturedEvent;
  readonly maxTokens: number;
  readonly temperature?: number;
}

export interface MemoryOutcome {
  readonly request: ReasonerRequest;
  readonly includedStepIndices: ReadonlyArray<number>;
  readonly droppedStepIndices: ReadonlyArray<number>;
}

export function buildReasonerRequest(
  inputs: MemoryInputs,
  capability: MemoryCapability,
): MemoryOutcome {
  const currentStep = inputs.currentObservation.stepIndex;
  const priorSteps = collectPriorSteps(inputs.history, currentStep);
  validateCapability(capability, currentStep);

  const outcome = selectSteps(priorSteps, capability, currentStep);
  const messages = outcome.selected.map((step) => buildStepMessage(step));
  messages.push({
    role: 'user',
    content: buildCurrentStepPrompt(inputs.currentObservation, inputs.personaPrompt, inputs.userStory),
  });

  const request: ReasonerRequest = {
    systemPrompt: inputs.systemPrompt,
    messages,
    maxTokens: inputs.maxTokens,
    ...(inputs.temperature !== undefined ? { temperature: inputs.temperature } : {}),
  };

  return {
    request,
    includedStepIndices: [...outcome.includedStepIndices, currentStep],
    droppedStepIndices: outcome.droppedStepIndices,
  };
}

export function memoryWindowDescription(cap: MemoryCapability): string {
  switch (cap.kind) {
    case 'fullHistory':
      return 'all prior steps (capped to the current observation only by length)';
    case 'limitedRecent':
      return `the most recent ${cap.windowSteps} step(s) (rolling window)`;
  }
}

function validateCapability(cap: MemoryCapability, stepIndex: number): void {
  if (cap.kind === 'limitedRecent') {
    if (!Number.isInteger(cap.windowSteps) || cap.windowSteps < 1) {
      throw new CapabilityViolation(
        'limitedRecent window must be >= 1',
        'memory',
        { stepIndex, windowSteps: cap.windowSteps },
      );
    }
  }
}

interface PriorStep {
  readonly stepIndex: number;
  readonly observation: ObservationCapturedEvent;
  readonly action: ActionEvent | null;
  readonly result: ActionResultEvent | null;
  readonly reasonerResponse: ReasonerResponseEvent | null;
  readonly selfReport: SelfReportResponseEvent | null;
}

function collectPriorSteps(history: ReadonlyArray<RunEvent>, currentStep: number): ReadonlyArray<PriorStep> {
  const grouped = new Map<number, Omit<PriorStep, 'stepIndex'>>();
  for (const e of history) {
    const step = stepIndexOf(e, currentStep);
    if (step === null) continue;
    const entry = grouped.get(step) ?? { observation: null as unknown as ObservationCapturedEvent, action: null, result: null, reasonerResponse: null, selfReport: null };
    if (e.type === 'observation.captured') {
      grouped.set(step, { ...entry, observation: e });
    } else if (e.type === 'action') {
      grouped.set(step, { ...entry, action: e });
    } else if (e.type === 'action.result') {
      grouped.set(step, { ...entry, result: e });
    } else if (e.type === 'reasoner.response') {
      grouped.set(step, { ...entry, reasonerResponse: e });
    } else if (e.type === 'selfReport.response') {
      grouped.set(step, { ...entry, selfReport: e });
    } else if (e.type === 'step.start' && e.stepIndex === step) {
      // no-op; included implicitly
      void (e as StepStartEvent);
    }
  }
  const out: PriorStep[] = [];
  for (const [stepIndex, v] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
    if (stepIndex >= currentStep) continue;
    out.push({ stepIndex, ...v });
  }
  return out;
}

function stepIndexOf(e: RunEvent, currentStep: number): number | null {
  switch (e.type) {
    case 'step.start':
      return e.stepIndex;
    case 'observation.captured':
    case 'action':
    case 'action.result':
    case 'reasoner.request':
    case 'reasoner.response':
    case 'capability.violation':
      return e.stepIndex;
    case 'termination':
      return null;
    case 'run.start':
    case 'run.end':
      return null;
    case 'selfReport.prompt':
    case 'selfReport.response':
      return null;
    case 'observer.prompt':
    case 'observer.response':
      return null;
  }
  void currentStep;
  return null;
}

function selectSteps(
  priorSteps: ReadonlyArray<PriorStep>,
  capability: MemoryCapability,
  currentStep: number,
): { selected: ReadonlyArray<PriorStep>; includedStepIndices: number[]; droppedStepIndices: number[] } {
  if (capability.kind === 'fullHistory') {
    const selected = priorSteps;
    return {
      selected,
      includedStepIndices: selected.map((s) => s.stepIndex),
      droppedStepIndices: [],
    };
  }
  // limitedRecent
  const sorted = [...priorSteps].sort((a, b) => a.stepIndex - b.stepIndex);
  const dropped = sorted.slice(0, Math.max(0, sorted.length - capability.windowSteps));
  const selected = sorted.slice(Math.max(0, sorted.length - capability.windowSteps));
  void currentStep;
  return {
    selected,
    includedStepIndices: selected.map((s) => s.stepIndex),
    droppedStepIndices: dropped.map((s) => s.stepIndex),
  };
}

function buildStepMessage(step: PriorStep): { role: 'user' | 'assistant'; content: string } {
  const obs = step.observation;
  const obsBlock = `[step ${step.stepIndex}] url=${obs.url} title=${obs.title}`;
  const actionBlock = step.action
    ? `You acted with: ${JSON.stringify(step.action.action)}`
    : 'You did not act this step.';
  const resultBlock = step.result
    ? `Result: ${step.result.result.status}${step.result.result.status === 'error' ? ` (${'note' in step.result.result ? step.result.result.note : ''})` : ''}`
    : '';
  const responseBlock = step.reasonerResponse
    ? `You produced: ${JSON.stringify(step.reasonerResponse.response)}`
    : '';
  return {
    role: 'assistant',
    content: [obsBlock, actionBlock, resultBlock, responseBlock].filter(Boolean).join('\n'),
  };
}

function buildCurrentStepPrompt(
  obs: ObservationCapturedEvent,
  personaPrompt: string,
  userStory: string,
): string {
  return [
    '[Current observation]',
    `url=${obs.url}`,
    `title=${obs.title}`,
    `ts=${obs.ts}`,
    '',
    '[Persona]',
    personaPrompt,
    '',
    '[User story for this run]',
    userStory,
    '',
    'Pick exactly one human-facing action and emit it as JSON: ' +
      '{kind: "clickByCoords"|"tapByCoords"|"typeText"|"scroll"|"wait"|"finish", ...}. ' +
      'Do not request selectors, do not request internal DOM. If unsure, issue `wait`.',
  ].join('\n');
}

export const __testHelpers = { SYSTEM_PROMPT_DIGEST_PLACEHOLDER };
