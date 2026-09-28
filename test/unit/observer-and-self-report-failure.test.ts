/**
 * Observer and self-report structured-output failure tests (ADR-0008).
 *
 * Both channels used to fail silently: the observer emitted
 * `summary: 'observer declined to produce findings'` and the self-report
 * emitted `freeText: 'selfReport unavailable'`, with no evidence recorded.
 * Each must now produce a typed failure and say why.
 */

import { describe, it, expect } from 'vitest';
import { runObserver } from '../../src/observer/runtime.js';
import { runParticipant } from '../../src/participant/runtime.js';
import { makeInMemoryRecorder } from '../../src/evidence/recorder.js';
import { createAnthropicReasoner, type AnthropicFetch } from '../../src/reasoner/providers/anthropic.js';
import type { Reasoner, ReasonerRequest, ReasonerResponse } from '../../src/domain/reasoner.js';
import type { ReasonerFailureEvent, RunEvent } from '../../src/domain/evidence.js';
import type { CapabilityProfile } from '../../src/domain/capability.js';
import type { BrowserAdapter } from '../../src/adapter/browser/interface.js';
import type { ObserverObservation } from '../../src/domain/observation.js';
import type { ActionResult } from '../../src/domain/action.js';

const ZERO_BACKOFF = { backoffMs: 0, sleep: async () => undefined };

function okText(text: string): Response {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function transportReturning(text: string): AnthropicFetch {
  return async () => okText(text);
}

function anthropicWith(transport: AnthropicFetch): Reasoner {
  return createAnthropicReasoner({
    apiKey: 'test-key-not-a-credential',
    endpoint: 'https://provider.invalid/v1/messages',
    modelId: 'test-model',
    fetchImpl: transport,
  });
}

/** A Reasoner that returns a well-typed envelope with a bad payload. */
function reasonerReturningContent(
  kind: 'selfReport' | 'observerFindings',
  content: Record<string, unknown>,
): Reasoner {
  return {
    providerId: 'fixture-provider',
    modelId: 'fixture-model',
    complete: async (): Promise<ReasonerResponse> => ({
      kind,
      content,
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  };
}

async function observeWith(reasoner: Reasoner) {
  const recorder = makeInMemoryRecorder();
  await recorder.append({
    type: 'run.start',
    runId: 'run-obs',
    ts: '2026-09-22T00:00:00.000Z',
    experimentPath: '.',
    seed: 's',
    packageVersion: '0.1.0',
  });
  const report = await runObserver({
    runId: 'run-obs',
    reasoner,
    recorder,
    userStory: 'add a task',
    participants: [{ participantId: 'p1', personaPrompt: 'a hurried user' }],
    structuredOutputPolicy: ZERO_BACKOFF,
  });
  const events = await recorder.snapshot();
  return {
    report,
    events,
    failures: events.filter((e): e is ReasonerFailureEvent => e.type === 'reasoner.failure'),
  };
}

describe('observer runtime: typed structured-output failures', () => {
  it('classifies an unparseable observer response as providerParse and says so', async () => {
    const out = await observeWith(anthropicWith(transportReturning('The run looked fine to me.')));

    expect(out.report.findings).toEqual([]);
    expect(out.report.summary).toContain('unavailable');
    expect(out.report.summary).toContain('providerParse');
    expect(out.report.summary).not.toContain('declined');
    expect(out.report.terminationVerdict.plausible).toBe(false);
    expect(out.report.terminationVerdict.note).toContain('provider defect');

    expect(out.failures).toHaveLength(2); // bounded recovery: 2 attempts
    expect(out.failures.map((f) => f.failureKind)).toEqual(['providerParse', 'providerParse']);
    expect(out.failures[0]).toMatchObject({
      channel: 'observer',
      outputKind: 'observerFindings',
      provider: 'anthropic',
      recoveryOutcome: 'exhausted',
    });
    expect(out.events.some((e) => e.type === 'capability.violation')).toBe(false);
  });

  it('classifies a structurally invalid observer response as contractValidation', async () => {
    const out = await observeWith(anthropicWith(transportReturning('{"summary":"looked fine"}')));

    expect(out.report.findings).toEqual([]);
    expect(out.report.summary).toContain('contractValidation');
    expect(out.failures.map((f) => f.failureKind)).toEqual(['contractValidation', 'contractValidation']);
    expect(out.events.some((e) => e.type === 'capability.violation')).toBe(false);
  });

  it('rejects an unknown finding severity instead of coercing it to info', async () => {
    const out = await observeWith(
      reasonerReturningContent('observerFindings', {
        summary: 's',
        findings: [{ summary: 'x', severity: 'catastrophic' }],
        terminationVerdict: { declared: 'finish', plausible: true, note: '' },
      }),
    );
    expect(out.report.summary).toContain('contractValidation');
    expect(out.report.findings).toEqual([]);
  });

  it('recovers and produces real findings when a later attempt succeeds', async () => {
    let call = 0;
    const out = await observeWith(
      anthropicWith(async () => {
        call += 1;
        if (call === 1) return okText('no json here');
        return okText(
          JSON.stringify({
            summary: 'one friction point',
            findings: [{ id: 'f-1', stepIndex: 0, severity: 'minor', category: 'friction', summary: 'no feedback', evidenceRefs: [] }],
            terminationVerdict: { declared: 'finish', plausible: true, note: 'ok' },
          }),
        );
      }),
    );

    expect(out.report.summary).toBe('one friction point');
    expect(out.report.findings).toHaveLength(1);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toMatchObject({ failureKind: 'providerParse', recoveryOutcome: 'recovered', willRetry: true });
  });

  it('produces no failure evidence on the happy path', async () => {
    const out = await observeWith(
      anthropicWith(
        transportReturning(
          JSON.stringify({
            summary: 'clean run',
            findings: [],
            terminationVerdict: { declared: 'finish', plausible: true, note: '' },
          }),
        ),
      ),
    );
    expect(out.report.summary).toBe('clean run');
    expect(out.failures).toEqual([]);
  });
});

class FakeAdapter implements BrowserAdapter {
  readonly adapterId = 'fake-adapter';
  async open(): Promise<void> {
    /* nothing */
  }
  async observe(stepIndex: number): Promise<ObserverObservation> {
    return {
      stepIndex,
      url: 'https://example.invalid/',
      title: 'Task Tracker',
      capturedAt: '2026-09-22T00:00:00.000Z',
      visual: { width: 1280, height: 800, visibleText: 'Task Tracker', focused: null },
      aria: { role: 'document', name: 'Task Tracker', children: [] },
      domHtml: '<html></html>',
      console: [],
      network: [],
      interactiveRegions: [],
    };
  }
  async execute(_action: Parameters<BrowserAdapter['execute']>[0]): Promise<ActionResult> {
    return { status: 'ok', observedAfter: { url: 'https://example.invalid/', title: 'Task Tracker' } };
  }
  async close(): Promise<void> {
    /* nothing */
  }
}

const CAPABILITY: CapabilityProfile = {
  observation: 'visual',
  action: 'visualOnly',
  memory: { kind: 'limitedRecent', windowSteps: 3 },
};

/** Always emits finish on the action channel so the run reaches the self-report step. */
function actionThenSelfReportReasoner(
  selfReportRequest: (req: ReasonerRequest) => Promise<ReasonerResponse>,
): Reasoner {
  return {
    providerId: 'fixture-provider',
    modelId: 'fixture-model',
    complete: async (req: ReasonerRequest): Promise<ReasonerResponse> => {
      if (req.systemPrompt.includes('Emit a JSON object matching the SelfReport shape')) {
        return selfReportRequest(req);
      }
      return {
        kind: 'action',
        action: { kind: 'finish', reason: 'done' },
        rationale: 'done',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

async function runToSelfReport(reasoner: Reasoner) {
  const recorder = makeInMemoryRecorder();
  const result = await runParticipant({
    runId: 'run-24',
    participantId: 'p1',
    personaPrompt: 'a hurried user',
    userStory: 'add a task',
    capability: CAPABILITY,
    reasoner,
    adapter: new FakeAdapter(),
    targetUrl: 'https://example.invalid/',
    budget: 2,
    recorder,
    structuredOutputPolicy: ZERO_BACKOFF,
  });
  const events: ReadonlyArray<RunEvent> = await recorder.snapshot();
  return {
    result,
    events,
    failures: events.filter((e): e is ReasonerFailureEvent => e.type === 'reasoner.failure'),
  };
}

describe('self-report runtime: typed structured-output failures', () => {
  it('classifies an unparseable self-report as providerParse and makes the placeholder self-describing', async () => {
    const out = await runToSelfReport(
      anthropicWith(async (_url, init) => {
        const body = JSON.parse(String(init.body)) as { system: string };
        if (body.system.includes('Emit a JSON object matching the SelfReport shape')) {
          return okText('I am not sure, really.');
        }
        return okText('{"kind":"finish","reason":"done"}');
      }),
    );

    // The run itself still terminated cleanly; only the self-report failed.
    expect(out.result.terminationReason).toBe('finish');

    const selfReportFailures = out.failures.filter((f) => f.channel === 'selfReport');
    expect(selfReportFailures.map((f) => f.failureKind)).toEqual(['providerParse', 'providerParse']);
    expect(selfReportFailures[0]).toMatchObject({ outputKind: 'selfReport', recoveryOutcome: 'exhausted' });

    expect(out.result.selfReport.freeText).toContain('providerParse');
    expect(out.result.selfReport.freeText).toContain('not participant silence');
    expect(out.result.selfReport.goal).toBe('');
    expect(out.result.selfReport.confidence).toBe(0);

    // A selfReport.response is still written, and it is not silent.
    const responses = out.events.filter((e) => e.type === 'selfReport.response');
    expect(responses).toHaveLength(1);
    expect(out.events.some((e) => e.type === 'capability.violation')).toBe(false);
  });

  it('classifies an out-of-range confidence as contractValidation', async () => {
    const out = await runToSelfReport(
      actionThenSelfReportReasoner(async () => ({
        kind: 'selfReport',
        content: {
          goal: 'add a task',
          productUnderstanding: 'a text box',
          confusionPoints: [],
          resultAlignedWithExpectation: true,
          confidence: 5,
          wouldReturn: true,
          freeText: 'fine',
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    );

    const selfReportFailures = out.failures.filter((f) => f.channel === 'selfReport');
    expect(selfReportFailures.map((f) => f.failureKind)).toEqual(['contractValidation', 'contractValidation']);
    expect(out.result.selfReport.freeText).toContain('contractValidation');
    expect(out.result.selfReport.freeText).toContain('not participant silence');
    expect(out.events.some((e) => e.type === 'capability.violation')).toBe(false);
  });

  it('classifies a missing required self-report field as contractValidation', async () => {
    const out = await runToSelfReport(
      actionThenSelfReportReasoner(async () => ({
        kind: 'selfReport',
        content: { goal: 'add a task' },
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    );
    expect(out.failures.filter((f) => f.channel === 'selfReport').map((f) => f.failureKind)).toEqual([
      'contractValidation',
      'contractValidation',
    ]);
  });

  it('classifies a self-report response of the wrong kind as contractValidation', async () => {
    const out = await runToSelfReport(
      actionThenSelfReportReasoner(async () => ({
        kind: 'refusal',
        message: 'no',
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    );
    expect(out.failures.filter((f) => f.channel === 'selfReport').map((f) => f.failureKind)).toEqual([
      'contractValidation',
      'contractValidation',
    ]);
    expect(out.result.selfReport.freeText).toContain('contractValidation');
  });

  it('keeps the valid self-report path byte-identical in shape', async () => {
    const out = await runToSelfReport(
      actionThenSelfReportReasoner(async () => ({
        kind: 'selfReport',
        content: {
          goal: 'add a task',
          productUnderstanding: 'a text box',
          confusionPoints: ['no confirmation'],
          resultAlignedWithExpectation: true,
          confidence: 0.6,
          wouldReturn: true,
          freeText: 'worked',
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    );
    expect(out.failures).toEqual([]);
    expect(out.result.selfReport).toMatchObject({
      participantId: 'p1',
      goal: 'add a task',
      productUnderstanding: 'a text box',
      confusionPoints: ['no confirmation'],
      resultAlignedWithExpectation: true,
      confidence: 0.6,
      wouldReturn: true,
      freeText: 'worked',
    });
  });
});
