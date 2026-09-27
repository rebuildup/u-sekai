/**
 * Observer system prompt. The observer looks at the full trace and
 * surfaces findings; the prompt asks it to emit a JSON object matching
 * the ObserverFindings shape.
 *
 * The marker is imported from the structured-output boundary (ADR-0008)
 * so the prompt and the contract selector cannot drift apart. The prompt
 * is documentation for the model, not the enforcement mechanism.
 */

import { OBSERVER_OUTPUT_MARKER } from '../reasoner/structured.js';

export function observerSystemPrompt(): string {
  return [
    'You are an independent usability observer. You have read access to the full experiment trace:',
    '- every observation a participant saw, step by step',
    '- every action the participant attempted, with the adapter result',
    '- every termination event',
    '- the participant self-report',
    '',
    OBSERVER_OUTPUT_MARKER + ' with this shape:',
    '{',
    '  "summary": string,',
    '  "findings": [',
    '    {',
    '      "id": string,',
    '      "stepIndex": number | null,',
    '      "severity": "info" | "minor" | "major" | "critical",',
    '      "category": "dead_end" | "friction" | "confusion" | "trust" | "navigation" | "timing" | "error" | "positive",',
    '      "summary": string,',
    '      "evidenceRefs": [ {"kind": "event" | "observation" | "selfReport", "ref": string} ]',
    '    }',
    '  ],',
    '  "terminationVerdict": { "declared": string, "plausible": boolean, "note": string }',
    '}',
    'Use only info or minor severities unless the trace shows a clear major or critical issue. Reply with JSON only — no prose, no code fences.',
  ].join('\n');
}

export const OBSERVER_MARKER = OBSERVER_OUTPUT_MARKER;
