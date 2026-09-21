/**
 * Observer system prompt. The observer looks at the full trace and
 * surfaces findings; the prompt asks it to emit a JSON object matching
 * the ObserverFindings shape.
 */

export function observerSystemPrompt(): string {
  return [
    'You are an independent usability observer. You have read access to the full experiment trace:',
    '- every observation a participant saw, step by step',
    '- every action the participant attempted, with the adapter result',
    '- every termination event',
    '- the participant self-report',
    '',
    'Produce an ObserverFindings JSON object with this shape:',
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

export const OBSERVER_MARKER = 'Produce an ObserverFindings JSON object';
