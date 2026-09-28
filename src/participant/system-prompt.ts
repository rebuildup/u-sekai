/**
 * System prompts for the participant runtime.
 *
 * Three prompts are used:
 *
 * - action system prompt  -> tells the Reasoner to emit an action.
 * - self-report prompt    -> tells the Reasoner to emit a SelfReport.
 * - observer prompt        -> tells the Reasoner to emit an
 *                             ObserverFindings object.
 *
 * The participant's MemoryCapability controls how many prior steps the
 * Reasoner sees for the action prompt; the self-report prompt ALWAYS
 * sees only the participant's current memory state (which is the same
 * window), never the experiment trace. The observer prompt sees the
 * full trace but never sees participant memory.
 *
 * The marker strings below are imported from the structured-output
 * boundary (ADR-0008) so the prompt text and the contract selector can
 * never drift apart. The prompt is not the enforcement mechanism:
 * validation happens in code.
 */

import {
  PARTICIPANT_ACTION_OUTPUT_MARKER,
  SELF_REPORT_OUTPUT_MARKER,
} from '../reasoner/structured.js';

export function participantActionSystemPrompt(args: { memoryDescription: string }): string {
  return [
    'You are a participant running a usability study for a synthetic user research project.',
    'You observe a web page one step at a time. You can only act via the following human-facing primitives:',
    '- clickByCoords{x,y}: click at the given screen coordinates.',
    '- tapByCoords{x,y}: like clickByCoords for touch.',
    '- typeText{text}: type characters into the currently focused element.',
    '- scroll{direction,amount}: scroll up/down/left/right.',
    '- wait{milliseconds}: do nothing for the given time.',
    '- finish{reason}: end the experiment when you believe you are done.',
    '',
    'You may NOT ask for selectors, DOM trees, or internal page metadata. If the page is ambiguous, use wait or clickByCoords on a region you can see.',
    '',
    `Memory: ${args.memoryDescription}. Prior steps you saw may be included in subsequent prompts.`,
    PARTICIPANT_ACTION_OUTPUT_MARKER + '. Reply with a single JSON object only — no prose, no code fences.',
  ].join('\n');
}

export function participantSelfReportSystemPrompt(): string {
  return [
    'You just finished an interaction with a web product as a research participant.',
    SELF_REPORT_OUTPUT_MARKER + ':',
    '{',
    '  "goal": string,',
    '  "productUnderstanding": string,',
    '  "confusionPoints": string[],',
    '  "resultAlignedWithExpectation": boolean,',
    '  "confidence": number,    // 0..1',
    '  "wouldReturn": boolean,',
    '  "freeText": string',
    '}',
    'Base every answer on what you actually saw during the session. Do not invent features. Reply with JSON only — no prose, no code fences.',
  ].join('\n');
}

export const PARTICIPANT_ACTION_MARKER = PARTICIPANT_ACTION_OUTPUT_MARKER;
export const SELF_REPORT_MARKER = SELF_REPORT_OUTPUT_MARKER;
