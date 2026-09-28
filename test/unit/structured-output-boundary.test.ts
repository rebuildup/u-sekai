/**
 * Structured-output boundary unit tests (ADR-0008).
 *
 * These assert the *distinguishing* observable for each taxonomy member,
 * not merely that something threw.
 */

import { describe, it, expect } from 'vitest';
import {
  admitParticipantAction,
  assertReasonerResponseContract,
  boundedInternalMessage,
  classifyStructuredFailure,
  detectStructuredOutputKind,
  excerptForDiagnostics,
  EXCERPT_MAX_LENGTH,
  extractJsonObject,
  isRetryableFailure,
  MAX_ATTEMPTS_CEILING,
  parseStructuredOutput,
  requireObserverFindingsContent,
  requireSelfReportContent,
  resolveStructuredOutputPolicy,
  runWithStructuredOutputRecovery,
  validateActionContent,
  validateObserverFindingsContent,
  validateSelfReportContent,
  type ValidatedObserverFindingsContent,
} from '../../src/reasoner/structured.js';
import {
  CapabilityViolation,
  ProviderError,
  StructuredOutputError,
  type StructuredFailureKind,
  type StructuredOutputFailureDetail,
} from '../../src/domain/errors.js';
import { isPrivilegedActionAttempt } from '../../src/domain/capability.js';
import { participantActionSystemPrompt, participantSelfReportSystemPrompt } from '../../src/participant/system-prompt.js';
import { observerSystemPrompt } from '../../src/observer/system-prompt.js';
import type { ReasonerResponse } from '../../src/domain/reasoner.js';

const CTX = { provider: 'test-provider', modelId: 'test-model' } as const;

function expectStructuredError(
  fn: () => unknown,
  failureKind: 'providerTransport' | 'providerParse' | 'contractValidation',
): StructuredOutputError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(StructuredOutputError);
    const structured = err as StructuredOutputError;
    expect(structured.failureKind).toBe(failureKind);
    // Regression guard: a provider/protocol defect must never be reported
    // as a participant capability defect.
    expect(structured).not.toBeInstanceOf(CapabilityViolation);
    return structured;
  }
  throw new Error('expected the call to throw');
}

describe('structured output: output kind detection', () => {
  it('derives the expected contract from the system prompt markers', () => {
    expect(detectStructuredOutputKind(participantActionSystemPrompt({ memoryDescription: 'x' }))).toBe('action');
    expect(detectStructuredOutputKind(participantSelfReportSystemPrompt())).toBe('selfReport');
    expect(detectStructuredOutputKind(observerSystemPrompt())).toBe('observerFindings');
  });

  it('defaults to the action contract for an unrecognised prompt', () => {
    expect(detectStructuredOutputKind('some other system prompt')).toBe('action');
  });
});

describe('structured output: JSON extraction', () => {
  it('returns null when no JSON object is present', () => {
    expect(extractJsonObject('I would just click the button, honestly.')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
    expect(extractJsonObject('[1, 2, 3]')).toBeNull();
    expect(extractJsonObject('kind: clickByCoords')).toBeNull();
  });

  it('extracts a bare or embedded object', () => {
    expect(extractJsonObject('{"kind":"wait","milliseconds":1}')).toEqual({ kind: 'wait', milliseconds: 1 });
    expect(extractJsonObject('Sure!\n```json\n{"kind":"finish","reason":"done"}\n```\n')).toEqual({
      kind: 'finish',
      reason: 'done',
    });
  });
});

describe('structured output: bounded, redacted diagnostics', () => {
  it('caps an excerpt and reports how much was dropped', () => {
    // Prose input, so the assertion is about the length cap rather than
    // about redaction (covered separately below).
    const long = 'the assistant declined to answer in the requested json format '.repeat(20);
    const excerpt = excerptForDiagnostics(long);
    expect(excerpt.length).toBeLessThan(EXCERPT_MAX_LENGTH + 64);
    expect(excerpt).toContain('truncated');
  });

  it('never leaks a credential-shaped value', () => {
    const excerpt = excerptForDiagnostics(
      'denied: x-api-key: sk-ant-api03-AAAABBBBCCCCDDDDeeee  and Authorization: Bearer tok-abcdef123456',
    );
    expect(excerpt).not.toContain('sk-ant-api03-AAAABBBBCCCCDDDDeeee');
    expect(excerpt).not.toContain('tok-abcdef123456');
    expect(excerpt).toContain('[redacted]');
  });

  it('redacts an unlabelled key-shaped token that a provider echoed back', () => {
    const excerpt = excerptForDiagnostics(
      'request rejected because test-key-not-a-credential was not recognised',
    );
    expect(excerpt).not.toContain('test-key-not-a-credential');
    expect(excerpt).toContain('[redacted]');
    // The surrounding prose is still readable, so the excerpt stays useful.
    expect(excerpt).toContain('request rejected because');
  });

  it('redacts a long unbroken token that a provider echoed back', () => {
    const excerpt = excerptForDiagnostics('rejected: A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
    expect(excerpt).not.toContain('A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
  });

  it('redacts a labelled credential even when the token is short', () => {
    const excerpt = excerptForDiagnostics('Authorization: Bearer abc123def456');
    expect(excerpt).not.toContain('abc123def456');
    expect(excerpt).toContain('Authorization=[redacted]');
  });

  it('redacts a quoted JSON credential field with a short value', () => {
    const excerpt = excerptForDiagnostics('{"error":{"api_key":"short1"}}');
    expect(excerpt).not.toContain('short1');
    expect(excerpt).toContain('[redacted]');
  });

  it('keeps a long camelCase field name readable so the artifact stays diagnosable', () => {
    const excerpt = excerptForDiagnostics(
      'selfReport: "resultAlignedWithExpectation" must be a boolean',
    );
    expect(excerpt).toContain('resultAlignedWithExpectation');
  });

  it('keeps hyphenated boundary wording readable', () => {
    expect(boundedInternalMessage('structured-output recovery wall-clock budget exhausted'))
      .toContain('structured-output recovery wall-clock budget exhausted');
  });
});

describe('structured output: action contract', () => {
  it('accepts every well-formed human-facing action', () => {
    const accepted = [
      { kind: 'clickByCoords', x: 1, y: 2 },
      { kind: 'tapByCoords', x: 1, y: 2 },
      { kind: 'typeText', text: 'hello' },
      { kind: 'scroll', direction: 'down', amount: 3 },
      { kind: 'wait', milliseconds: 0 },
      { kind: 'finish', reason: 'done' },
    ];
    for (const action of accepted) {
      expect(validateActionContent(action, CTX)).toEqual(action);
    }
  });

  it.each([
    ['an unknown action kind', { kind: 'teleport', target: 'mars' }],
    ['no kind discriminator at all', {}],
    ['a non-string kind', { kind: 7 }],
    ['a stringly-typed coordinate', { kind: 'clickByCoords', x: 'left', y: 2 }],
    ['a missing coordinate', { kind: 'clickByCoords', x: 1 }],
    ['a non-finite coordinate', { kind: 'tapByCoords', x: 1, y: Number.POSITIVE_INFINITY }],
    ['a bad scroll direction', { kind: 'scroll', direction: 'sideways', amount: 1 }],
    ['an out-of-range wait', { kind: 'wait', milliseconds: -5 }],
    ['a non-string finish reason', { kind: 'finish', reason: 42 }],
    ['a non-object payload', 'clickByCoords'],
    ['an array payload', [{ kind: 'wait', milliseconds: 1 }]],
  ])('classifies %s as contractValidation, not a capability violation', (_label, payload) => {
    expectStructuredError(() => validateActionContent(payload, CTX), 'contractValidation');
  });

  it.each(['selectorClick', 'evaluateJs', 'getDomTree', 'readInternalMetadata'])(
    'classifies a %s attempt as a genuine capability violation',
    (kind) => {
      let caught: unknown;
      try {
        validateActionContent({ kind, payload: { selector: '#root' } }, CTX);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CapabilityViolation);
      expect((caught as CapabilityViolation).axis).toBe('action');
      expect(caught).not.toBeInstanceOf(StructuredOutputError);
    },
  );

  it('still classifies a privileged kind as a violation when its payload is malformed', () => {
    for (const payload of [{ kind: 'getDomTree', payload: 'not-an-object' }, { kind: 'readInternalMetadata' }]) {
      let caught: unknown;
      try {
        validateActionContent(payload, CTX);
      } catch (err) {
        caught = err;
      }
      // A recognised privileged `kind` is a violation regardless of how
      // broken its payload is: the intent is unambiguous.
      expect(caught).toBeInstanceOf(CapabilityViolation);
    }
  });

  it('keeps isPrivilegedActionAttempt type-sound by requiring an object payload', () => {
    expect(isPrivilegedActionAttempt({ kind: 'evaluateJs', payload: { code: 'x' } })).toBe(true);
    expect(isPrivilegedActionAttempt({ kind: 'evaluateJs', payload: 'x' })).toBe(false);
    expect(isPrivilegedActionAttempt({ kind: 'evaluateJs' })).toBe(false);
    expect(isPrivilegedActionAttempt({ kind: 'clickByCoords', x: 1, y: 2 })).toBe(false);
  });
});

describe('structured output: selfReport contract', () => {
  const valid = {
    goal: 'add a task',
    productUnderstanding: 'a text box and a button',
    confusionPoints: ['no confirmation'],
    resultAlignedWithExpectation: true,
    confidence: 0.5,
    wouldReturn: true,
    freeText: 'ok',
  };

  it('returns total content and defaults the two derivable fields', () => {
    const { confusionPoints, freeText, ...rest } = valid;
    void confusionPoints;
    void freeText;
    const content = validateSelfReportContent(rest, CTX);
    expect(content.confusionPoints).toEqual([]);
    expect(content.freeText).toBe('');
    expect(content.goal).toBe('add a task');
  });

  it.each([
    ['a missing goal', { ...valid, goal: undefined }],
    ['a numeric goal', { ...valid, goal: 3 }],
    ['confidence above 1', { ...valid, confidence: 5 }],
    ['confidence below 0', { ...valid, confidence: -0.1 }],
    ['a string confidence', { ...valid, confidence: 'high' }],
    ['a string wouldReturn', { ...valid, wouldReturn: 'yes' }],
    ['a string resultAlignedWithExpectation', { ...valid, resultAlignedWithExpectation: 1 }],
    ['non-string confusionPoints', { ...valid, confusionPoints: [1, 2] }],
    ['non-string freeText', { ...valid, freeText: {} }],
  ])('classifies %s as contractValidation', (_label, payload) => {
    expectStructuredError(() => validateSelfReportContent(payload, CTX), 'contractValidation');
  });
});

describe('structured output: observerFindings contract', () => {
  const valid = {
    summary: 'one friction point',
    findings: [
      { id: 'f-1', stepIndex: 2, severity: 'minor', category: 'friction', summary: 'no feedback', evidenceRefs: [] },
    ],
    terminationVerdict: { declared: 'finish', plausible: true, note: 'ok' },
  };

  it('accepts a well-formed findings object and fills defaults', () => {
    const content = validateObserverFindingsContent(valid, CTX);
    expect(content.findings).toHaveLength(1);
    expect(content.findings[0]?.severity).toBe('minor');
  });

  it('defaults an omitted severity/category rather than inventing a finding', () => {
    const content = validateObserverFindingsContent(
      { summary: 's', findings: [{ summary: 'x' }], terminationVerdict: {} },
      CTX,
    );
    expect(content.findings[0]?.severity).toBe('info');
    expect(content.findings[0]?.stepIndex).toBeNull();
    expect(content.findings[0]?.evidenceRefs).toEqual([]);
  });

  it.each([
    ['a missing summary', { findings: [], terminationVerdict: {} }],
    ['a non-array findings field', { summary: 's', findings: {}, terminationVerdict: {} }],
    ['a missing terminationVerdict', { summary: 's', findings: [] }],
    ['a non-object terminationVerdict', { summary: 's', findings: [], terminationVerdict: 'finish' }],
    ['an unknown severity', { summary: 's', findings: [{ summary: 'x', severity: 'catastrophic' }], terminationVerdict: {} }],
    ['an unknown category', { summary: 's', findings: [{ summary: 'x', category: 'vibes' }], terminationVerdict: {} }],
    ['a non-string finding summary', { summary: 's', findings: [{ summary: 1 }], terminationVerdict: {} }],
    ['a non-object finding', { summary: 's', findings: ['nope'], terminationVerdict: {} }],
    ['a bad evidence ref kind', { summary: 's', findings: [{ summary: 'x', evidenceRefs: [{ kind: 'vibes', ref: 'r' }] }], terminationVerdict: {} }],
    ['a non-boolean terminationVerdict.plausible', { summary: 's', findings: [], terminationVerdict: { plausible: 'yes' } }],
  ])('classifies %s as contractValidation', (_label, payload) => {
    expectStructuredError(() => validateObserverFindingsContent(payload, CTX), 'contractValidation');
  });
});

describe('structured output: parseStructuredOutput entry point', () => {
  it('maps an unparseable assistant turn to providerParse', () => {
    const err = expectStructuredError(
      () => parseStructuredOutput('action', 'Sure! I will click the blue thing.', CTX),
      'providerParse',
    );
    expect(err.detail.provider).toBe('test-provider');
    expect(err.detail.outputKind).toBe('action');
    expect(err.detail.excerpt).toContain('blue thing');
  });

  it('returns a typed action for a valid payload', () => {
    const res = parseStructuredOutput('action', '{"kind":"finish","reason":"done"}', CTX);
    expect(res.kind).toBe('action');
    if (res.kind === 'action') expect(res.action).toEqual({ kind: 'finish', reason: 'done' });
  });

  it('validates self-report content at the boundary', () => {
    expectStructuredError(
      () => parseStructuredOutput('selfReport', '{"goal":"g"}', CTX),
      'contractValidation',
    );
    const ok = parseStructuredOutput(
      'selfReport',
      '{"goal":"g","productUnderstanding":"p","resultAlignedWithExpectation":false,"confidence":0.2,"wouldReturn":true}',
      CTX,
    );
    expect(ok.kind).toBe('selfReport');
  });

  it('validates observer findings at the boundary', () => {
    expectStructuredError(
      () => parseStructuredOutput('observerFindings', '{"summary":"s"}', CTX),
      'contractValidation',
    );
    const ok = parseStructuredOutput(
      'observerFindings',
      '{"summary":"s","findings":[],"terminationVerdict":{"declared":"finish","plausible":true,"note":""}}',
      CTX,
    );
    expect(ok.kind).toBe('observerFindings');
  });
});

describe('structured output: response narrowing helpers', () => {
  const actionResponse: ReasonerResponse = {
    kind: 'action',
    action: { kind: 'wait', milliseconds: 5 },
    rationale: 'r',
    usage: { inputTokens: 1, outputTokens: 1 },
  };

  it('rejects a response of the wrong kind as contractValidation', () => {
    expectStructuredError(() => requireSelfReportContent(actionResponse, CTX), 'contractValidation');
    expectStructuredError(() => requireObserverFindingsContent(actionResponse, CTX), 'contractValidation');
  });

  it('rejects a response whose payload violates the contract', () => {
    const bad: ReasonerResponse = {
      kind: 'observerFindings',
      content: { summary: 's', findings: [{ summary: 3 }], terminationVerdict: {} },
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    expectStructuredError(() => requireObserverFindingsContent(bad, CTX), 'contractValidation');
  });

  it('rejects a wrong-kind response in the runtime contract check', () => {
    expectStructuredError(
      () => assertReasonerResponseContract(actionResponse, 'selfReport', CTX),
      'contractValidation',
    );
  });

  it('accepts a matching response', () => {
    expect(() => assertReasonerResponseContract(actionResponse, 'action', CTX)).not.toThrow();
    const good: ValidatedObserverFindingsContent = {
      summary: 's',
      findings: [],
      terminationVerdict: { declared: 'finish', plausible: true, note: '' },
    };
    expect(good.summary).toBe('s');
  });
});

describe('structured output: action admission', () => {
  it('admits a structurally valid participant action', () => {
    const result = admitParticipantAction({ kind: 'clickByCoords', x: 1, y: 2 });
    expect(result.status).toBe('admitted');
  });

  it('reports a privileged primitive as a capability violation', () => {
    const result = admitParticipantAction({ kind: 'selectorClick', payload: { selector: '#root' } });
    expect(result.status).toBe('capabilityViolation');
    if (result.status === 'capabilityViolation') {
      expect(result.attempt.kind).toBe('selectorClick');
    }
  });

  it('reports a structurally wrong action as contract-invalid, not a violation', () => {
    expect(admitParticipantAction({ kind: 'teleport' }).status).toBe('contractInvalid');
    expect(admitParticipantAction({ kind: 'clickByCoords', x: 'left', y: 2 }).status).toBe('contractInvalid');
    expect(admitParticipantAction({}).status).toBe('contractInvalid');
  });
});

describe('structured output: failure classification', () => {
  it('maps each error type onto exactly one taxonomy member', () => {
    expect(classifyStructuredFailure(new StructuredOutputError('m', 'providerParse')).failureKind).toBe('providerParse');
    expect(classifyStructuredFailure(new CapabilityViolation('m', 'action')).failureKind).toBe('capabilityViolation');
    expect(classifyStructuredFailure(new ProviderError('m', 'p')).failureKind).toBe('providerTransport');
    expect(classifyStructuredFailure(new Error('boom')).failureKind).toBe('providerTransport');
  });
});

describe('structured output: retry eligibility', () => {
  const policy = resolveStructuredOutputPolicy();

  const retryable = (failureKind: StructuredFailureKind, detail: StructuredOutputFailureDetail = {}): boolean =>
    isRetryableFailure(failureKind, detail, policy);

  it('treats parse and contract failures as recoverable', () => {
    expect(retryable('providerParse')).toBe(true);
    expect(retryable('contractValidation')).toBe(true);
  });

  it('never retries a capability violation', () => {
    expect(retryable('capabilityViolation', { status: 500 })).toBe(false);
  });

  it.each([400, 401, 403, 404, 422])('does not retry the non-transient status %i', (status) => {
    expect(retryable('providerTransport', { status })).toBe(false);
  });

  it.each([429, 500, 502, 503])('retries the transient status %i', (status) => {
    expect(retryable('providerTransport', { status })).toBe(true);
  });

  it('retries a network error or timeout that carries no status', () => {
    expect(retryable('providerTransport')).toBe(true);
    expect(retryable('providerTransport', { timeout: true })).toBe(true);
  });
});

describe('structured output: bounded recovery', () => {
  const base = {
    outputKind: 'action',
    channel: 'participant',
    provider: 'p',
    modelId: 'm',
  } as const;

  const noSleep = { sleep: async () => undefined };

  it('marks an early failure as recovered when a later attempt succeeds', async () => {
    let calls = 0;
    const res = await runWithStructuredOutputRecovery<number>({
      ...base,
      policy: { ...noSleep },
      invoke: async () => {
        calls += 1;
        if (calls === 1) throw new StructuredOutputError('bad', 'providerParse');
        return 7;
      },
    });
    expect(res.status).toBe('ok');
    expect(res.status === 'ok' ? res.value : null).toBe(7);
    expect(calls).toBe(2);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]).toMatchObject({
      attempt: 1,
      failureKind: 'providerParse',
      retryable: true,
      willRetry: true,
      recoveryOutcome: 'recovered',
      provider: 'p',
      maxAttempts: 2,
    });
  });

  it('marks every failure as exhausted and stops at the attempt ceiling', async () => {
    let calls = 0;
    const res = await runWithStructuredOutputRecovery<number>({
      ...base,
      policy: { ...noSleep, maxAttempts: 3 },
      invoke: async () => {
        calls += 1;
        throw new StructuredOutputError('bad', 'contractValidation');
      },
    });
    expect(res.status).toBe('failed');
    expect(calls).toBe(3);
    expect(res.status === 'failed' ? res.failureKind : null).toBe('contractValidation');
    expect(res.failures.map((f) => f.recoveryOutcome)).toEqual(['exhausted', 'exhausted', 'exhausted']);
    expect(res.failures.map((f) => f.attempt)).toEqual([1, 2, 3]);
    expect(res.failures.at(-1)?.willRetry).toBe(false);
  });

  it('fails a capability violation immediately without a retry', async () => {
    let calls = 0;
    const res = await runWithStructuredOutputRecovery<number>({
      ...base,
      policy: { ...noSleep, maxAttempts: 4 },
      invoke: async () => {
        calls += 1;
        throw new CapabilityViolation('privileged attempt "evaluateJs"', 'action');
      },
    });
    expect(calls).toBe(1);
    expect(res.status === 'failed' ? res.failureKind : null).toBe('capabilityViolation');
    expect(res.failures[0]).toMatchObject({ retryable: false, willRetry: false });
  });

  it('fails a non-transient 4xx immediately without a retry', async () => {
    let calls = 0;
    const res = await runWithStructuredOutputRecovery<number>({
      ...base,
      policy: { ...noSleep, maxAttempts: 4 },
      invoke: async () => {
        calls += 1;
        throw new StructuredOutputError('http 400', 'providerTransport', { status: 400 });
      },
    });
    expect(calls).toBe(1);
    expect(res.failures[0]).toMatchObject({ failureKind: 'providerTransport', httpStatus: 400, retryable: false });
  });

  it('retries a transient 5xx up to the ceiling', async () => {
    let calls = 0;
    const res = await runWithStructuredOutputRecovery<number>({
      ...base,
      policy: { ...noSleep, maxAttempts: 3 },
      invoke: async () => {
        calls += 1;
        throw new StructuredOutputError('http 503', 'providerTransport', { status: 503 });
      },
    });
    expect(calls).toBe(3);
    expect(res.failures.every((f) => f.retryable)).toBe(true);
  });

  it('never records an unbounded number of attempts for a misconfigured policy', () => {
    const resolved = resolveStructuredOutputPolicy({ maxAttempts: 1000 });
    expect(resolved.maxAttempts).toBe(MAX_ATTEMPTS_CEILING);
    expect(resolveStructuredOutputPolicy({ maxAttempts: 0 }).maxAttempts).toBe(1);
    expect(resolveStructuredOutputPolicy({ maxAttempts: Number.NaN }).maxAttempts).toBe(1);
  });

  it('bounds the whole sequence by wall clock, not only by attempt count', async () => {
    let clock = 0;
    let calls = 0;
    const res = await runWithStructuredOutputRecovery<number>({
      ...base,
      policy: {
        maxAttempts: 5,
        backoffMs: 100,
        maxTotalMs: 250,
        attemptTimeoutMs: 60_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
      invoke: async () => {
        calls += 1;
        clock += 200;
        throw new StructuredOutputError('bad', 'providerParse');
      },
    });
    // 5 attempts would need 5 * 200ms of provider time alone; the 250ms
    // wall-clock budget stops the sequence after the first attempt.
    expect(calls).toBe(1);
    expect(res.status).toBe('failed');
    expect(res.failures[0]).toMatchObject({ retryable: true, willRetry: false, recoveryOutcome: 'exhausted' });
  });

  it('honours an explicit retryOn override', async () => {
    let calls = 0;
    const res = await runWithStructuredOutputRecovery<number>({
      ...base,
      policy: { ...noSleep, maxAttempts: 3, retryOn: ['providerParse'] },
      invoke: async () => {
        calls += 1;
        throw new StructuredOutputError('bad', 'contractValidation');
      },
    });
    expect(calls).toBe(1);
    expect(res.failures[0]?.retryable).toBe(false);
  });

  it('treats a post-condition failure as a classified failure, not a success', async () => {
    let calls = 0;
    const res = await runWithStructuredOutputRecovery<number>({
      ...base,
      policy: { ...noSleep, maxAttempts: 1 },
      invoke: async () => {
        calls += 1;
        return 1;
      },
      validate: () => {
        throw new StructuredOutputError('nope', 'contractValidation');
      },
    });
    expect(calls).toBe(1);
    expect(res.status).toBe('failed');
    expect(res.status === 'failed' ? res.failureKind : null).toBe('contractValidation');
  });
});
