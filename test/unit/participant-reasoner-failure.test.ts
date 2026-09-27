/**
 * Participant runtime regression tests for the structured-output failure
 * taxonomy (ADR-0008).
 *
 * These drive the real Anthropic adapter through an injected transport, so
 * the whole path is exercised: raw assistant text -> JSON extraction ->
 * contract validation -> taxonomy -> bounded recovery -> typed evidence ->
 * termination reason.
 *
 * Hermetic: no network, no credential in source, no wall-clock waits.
 */

import { describe, it, expect } from 'vitest';
import { runParticipant } from '../../src/participant/runtime.js';
import { makeInMemoryRecorder } from '../../src/evidence/recorder.js';
import { createAnthropicReasoner, type AnthropicFetch } from '../../src/reasoner/providers/anthropic.js';
import type { CapabilityProfile } from '../../src/domain/capability.js';
import type { ReasonerFailureEvent, RunEvent, TerminationEvent } from '../../src/domain/evidence.js';
import type { BrowserAdapter } from '../../src/adapter/browser/interface.js';
import type { ObserverObservation } from '../../src/domain/observation.js';
import type { ActionResult } from '../../src/domain/action.js';

const CAPABILITY: CapabilityProfile = {
  observation: 'visual',
  action: 'visualOnly',
  memory: { kind: 'limitedRecent', windowSteps: 3 },
};

const SELF_REPORT_TEXT = JSON.stringify({
  goal: 'add a task',
  productUnderstanding: 'a text box and a button',
  confusionPoints: [],
  resultAlignedWithExpectation: true,
  confidence: 0.5,
  wouldReturn: true,
  freeText: 'fine',
});

const SELF_REPORT_MARKER = 'Emit a JSON object matching the SelfReport shape';

/**
 * A channel-aware transport stub. The participant action channel and the
 * self-report channel are answered independently so a test can fail one
 * without disturbing the other.
 */
interface ChannelScript {
  readonly action: ReadonlyArray<() => Response>;
  readonly selfReport?: () => Response;
}

interface StubStats {
  actionCalls: number;
  selfReportCalls: number;
}

function makeTransport(script: ChannelScript): { fetchImpl: AnthropicFetch; stats: StubStats } {
  const stats: StubStats = { actionCalls: 0, selfReportCalls: 0 };
  const fetchImpl: AnthropicFetch = async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { system: string };
    if (body.system.includes(SELF_REPORT_MARKER)) {
      stats.selfReportCalls += 1;
      return script.selfReport ? script.selfReport() : okText(SELF_REPORT_TEXT);
    }
    const index = stats.actionCalls;
    stats.actionCalls += 1;
    const responder = script.action[Math.min(index, script.action.length - 1)];
    if (!responder) throw new Error('no action responder configured');
    return responder();
  };
  return { fetchImpl, stats };
}

function okText(text: string): Response {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function httpStatus(status: number, body = '{"error":"upstream"}'): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

class FakeAdapter implements BrowserAdapter {
  readonly adapterId = 'fake-adapter';
  readonly executed: unknown[] = [];
  closed = false;

  async open(): Promise<void> {
    /* nothing */
  }

  async observe(stepIndex: number): Promise<ObserverObservation> {
    return {
      stepIndex,
      url: 'https://example.invalid/',
      title: 'Task Tracker',
      capturedAt: '2026-09-22T00:00:00.000Z',
      visual: { width: 1280, height: 800, visibleText: 'Task Tracker Add', focused: null },
      aria: { role: 'document', name: 'Task Tracker', children: [] },
      domHtml: '<html></html>',
      console: [],
      network: [],
      interactiveRegions: [{ selector: '#add', label: 'Add', bbox: { x: 0, y: 0, width: 10, height: 10 } }],
    };
  }

  async execute(action: Parameters<BrowserAdapter['execute']>[0]): Promise<ActionResult> {
    this.executed.push(action);
    return { status: 'ok', observedAfter: { url: 'https://example.invalid/', title: 'Task Tracker' } };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

interface RunOutcome {
  readonly result: Awaited<ReturnType<typeof runParticipant>>;
  readonly events: ReadonlyArray<RunEvent>;
  readonly failures: ReadonlyArray<ReasonerFailureEvent>;
  readonly termination: TerminationEvent | undefined;
  readonly adapter: FakeAdapter;
  readonly stats: StubStats;
}

async function runWith(script: ChannelScript, budget = 3): Promise<RunOutcome> {
  const { fetchImpl, stats } = makeTransport(script);
  const reasoner = createAnthropicReasoner({
    apiKey: 'test-key-not-a-credential',
    endpoint: 'https://provider.invalid/v1/messages',
    modelId: 'test-model',
    fetchImpl,
  });
  const recorder = makeInMemoryRecorder();
  const adapter = new FakeAdapter();
  const result = await runParticipant({
    runId: 'run-24',
    participantId: 'p1',
    personaPrompt: 'a hurried user',
    userStory: 'add a task called Buy milk',
    capability: CAPABILITY,
    reasoner,
    adapter,
    targetUrl: 'https://example.invalid/',
    budget,
    recorder,
    // Zero backoff keeps the suite fast without changing the retry count.
    structuredOutputPolicy: { backoffMs: 0, sleep: async () => undefined },
  });
  const events = await recorder.snapshot();
  return {
    result,
    events,
    failures: events.filter((e): e is ReasonerFailureEvent => e.type === 'reasoner.failure'),
    termination: [...events].reverse().find((e): e is TerminationEvent => e.type === 'termination'),
    adapter,
    stats,
  };
}

describe('participant runtime: malformed assistant output (Issue case 1)', () => {
  it('classifies unparseable output as providerParse and never as a capability violation', async () => {
    const out = await runWith({
      action: [() => okText('I think the best move is to click the blue button.')],
    });

    expect(out.result.terminationReason).toBe('reasonerFailure');
    expect(out.result.error).toContain('providerParse');

    const actionFailures = out.failures.filter((f) => f.channel === 'participant');
    expect(actionFailures).toHaveLength(2); // 1 initial attempt + 1 retry
    expect(actionFailures.map((f) => f.failureKind)).toEqual(['providerParse', 'providerParse']);
    expect(actionFailures.every((f) => f.recoveryOutcome === 'exhausted')).toBe(true);
    expect(actionFailures.every((f) => f.retryable)).toBe(true);

    // Headline regression: no capability violation was recorded.
    expect(out.events.some((e) => e.type === 'capability.violation')).toBe(false);
    expect(out.termination?.reason).toBe('reasonerFailure');
    // The participant never reached the adapter.
    expect(out.adapter.executed).toEqual([]);
  });

  it('keeps the recorded excerpt redacted and bounded', async () => {
    const out = await runWith({
      action: [() => okText(`no json here, key sk-ant-api03-AAAABBBBCCCCDDDDeeee ${'pad '.repeat(80)}`)],
    });
    const excerpt = out.failures[0]?.excerpt ?? '';
    expect(excerpt).not.toContain('sk-ant-api03-AAAABBBBCCCCDDDDeeee');
    expect(excerpt.length).toBeLessThan(320);
  });
});

describe('participant runtime: structurally invalid action (Issue case 2)', () => {
  it.each([
    ['an unknown action kind', '{"kind":"teleport","target":"mars"}'],
    ['a missing kind', '{}'],
    ['a stringly-typed coordinate', '{"kind":"clickByCoords","x":"left","y":2}'],
  ])('classifies %s as contractValidation, not a capability violation', async (_label, payload) => {
    const out = await runWith({ action: [() => okText(payload)] });

    expect(out.result.terminationReason).toBe('reasonerFailure');
    const actionFailures = out.failures.filter((f) => f.channel === 'participant');
    expect(actionFailures.map((f) => f.failureKind)).toEqual(['contractValidation', 'contractValidation']);
    expect(out.events.some((e) => e.type === 'capability.violation')).toBe(false);
    expect(out.termination?.reason).toBe('reasonerFailure');
  });

  it('records a contractValidation failure against the failing step', async () => {
    const out = await runWith({ action: [() => okText('{"kind":"teleport"}')] });
    const first = out.failures.find((f) => f.channel === 'participant');
    expect(first?.stepIndex).toBe(0);
    expect(first?.participantId).toBe('p1');
    expect(first?.outputKind).toBe('action');
    expect(first?.provider).toBe('anthropic');
  });
});

describe('participant runtime: capability-disallowed action (Issue case 3)', () => {
  it('still records a genuine capability violation for a privileged parsed action', async () => {
    const out = await runWith({
      action: [() => okText('{"kind":"selectorClick","payload":{"selector":"#add"}}')],
    });

    expect(out.result.terminationReason).toBe('capabilityViolation');
    const violation = out.events.find((e) => e.type === 'capability.violation');
    expect(violation).toBeDefined();
    if (violation && violation.type === 'capability.violation') {
      expect(violation.axis).toBe('action');
    }
    expect(out.termination?.reason).toBe('capabilityViolation');

    // A capability violation is never retried.
    expect(out.stats.actionCalls).toBe(1);
    const failure = out.failures.find((f) => f.channel === 'participant');
    expect(failure).toMatchObject({ failureKind: 'capabilityViolation', retryable: false, willRetry: false });
  });
});

describe('participant runtime: provider transport failure (Issue case 4)', () => {
  it('classifies an HTTP failure as providerTransport', async () => {
    const out = await runWith({ action: [() => httpStatus(500)] });
    const actionFailures = out.failures.filter((f) => f.channel === 'participant');
    expect(actionFailures.map((f) => f.failureKind)).toEqual(['providerTransport', 'providerTransport']);
    expect(actionFailures[0]?.httpStatus).toBe(500);
    expect(out.result.terminationReason).toBe('reasonerFailure');
  });

  it.each([400, 401, 403, 404])('does not retry the non-transient status %i', async (status) => {
    const out = await runWith({ action: [() => httpStatus(status)] });
    expect(out.stats.actionCalls).toBe(1);
    const failure = out.failures.find((f) => f.channel === 'participant');
    expect(failure).toMatchObject({ failureKind: 'providerTransport', httpStatus: status, retryable: false });
  });

  it.each([429, 503])('retries the transient status %i exactly once', async (status) => {
    const out = await runWith({ action: [() => httpStatus(status)] });
    expect(out.stats.actionCalls).toBe(2);
    const actionFailures = out.failures.filter((f) => f.channel === 'participant');
    expect(actionFailures).toHaveLength(2);
    expect(actionFailures.every((f) => f.retryable)).toBe(true);
    expect(actionFailures[0]?.willRetry).toBe(true);
    expect(actionFailures[1]?.willRetry).toBe(false);
  });
});

describe('participant runtime: successful recovery (Issue case 5)', () => {
  it('continues the run and records both the failure and the recovery', async () => {
    const out = await runWith({
      action: [
        () => okText('I am not sure what to do here.'), // attempt 1: unparseable
        () => okText('{"kind":"clickByCoords","x":10,"y":20}'), // attempt 2: valid
        () => okText('{"kind":"finish","reason":"added the task"}'),
      ],
    }, 2);

    // The run continued rather than terminating on the malformed turn.
    expect(out.result.terminationReason).toBe('finish');
    expect(out.result.steps).toBe(2);
    expect(out.termination?.reason).toBe('finish');
    expect(out.adapter.executed).toEqual([
      { kind: 'clickByCoords', x: 10, y: 20 },
      { kind: 'finish', reason: 'added the task' },
    ]);

    // Evidence shows a failure AND a recovery, not a termination.
    const actionFailures = out.failures.filter((f) => f.channel === 'participant');
    expect(actionFailures).toHaveLength(1);
    expect(actionFailures[0]).toMatchObject({
      attempt: 1,
      failureKind: 'providerParse',
      retryable: true,
      willRetry: true,
      recoveryOutcome: 'recovered',
    });

    // The failure precedes the recovered action in the persisted trace.
    const types = out.events.map((e) => e.type);
    expect(types.indexOf('reasoner.failure')).toBeLessThan(types.lastIndexOf('action'));
    expect(out.events.some((e) => e.type === 'capability.violation')).toBe(false);
  });
});

describe('participant runtime: retry exhaustion (Issue case 6)', () => {
  it('terminates with the non-capability reason and a bounded attempt count', async () => {
    const out = await runWith({ action: [() => okText('still not json')] }, 5);

    expect(out.result.terminationReason).toBe('reasonerFailure');
    expect(out.termination?.reason).toBe('reasonerFailure');
    // Bounded: the default policy allows exactly 2 total attempts.
    expect(out.stats.actionCalls).toBe(2);
    const actionFailures = out.failures.filter((f) => f.channel === 'participant');
    expect(actionFailures).toHaveLength(2);
    expect(actionFailures.map((f) => f.attempt)).toEqual([1, 2]);
    expect(actionFailures.every((f) => f.maxAttempts === 2)).toBe(true);
    expect(actionFailures.every((f) => f.recoveryOutcome === 'exhausted')).toBe(true);
    expect(out.events.some((e) => e.type === 'capability.violation')).toBe(false);
  });

  it('does not consume the remaining step budget on a failure', async () => {
    const out = await runWith({ action: [() => okText('still not json')] });
    expect(out.result.steps).toBe(0);
    // The self-report channel is independent of the action channel, so a
    // valid self-report is still produced and no extra failure is invented.
    expect(out.failures.filter((f) => f.channel === 'selfReport')).toEqual([]);
    expect(out.result.selfReport.goal).toBe('add a task');
  });

  it('records a typed self-report failure without turning it into a capability violation', async () => {
    const out = await runWith({
      action: [() => okText('still not json')],
      selfReport: () => okText('{"goal":"g"}'),
    });

    expect(out.result.terminationReason).toBe('reasonerFailure');
    const selfReportFailures = out.failures.filter((f) => f.channel === 'selfReport');
    expect(selfReportFailures.map((f) => f.failureKind)).toEqual(['contractValidation', 'contractValidation']);
    expect(selfReportFailures.every((f) => f.outputKind === 'selfReport')).toBe(true);
    expect(selfReportFailures.every((f) => f.recoveryOutcome === 'exhausted')).toBe(true);
    // A self-report failure has no step, but must still be attributable to
    // a participant in a multi-participant run.
    expect(selfReportFailures.every((f) => f.participantId === 'p1')).toBe(true);
    expect(selfReportFailures.every((f) => f.stepIndex === undefined)).toBe(true);
    expect(out.result.selfReport.freeText).toContain('contractValidation');
    expect(out.result.selfReport.freeText).toContain('not participant silence');
    expect(out.events.some((e) => e.type === 'capability.violation')).toBe(false);
  });
});

describe('participant runtime: deterministic scripted path is unchanged', () => {
  it('produces no failure evidence at all', async () => {
    const recorder = makeInMemoryRecorder();
    const adapter = new FakeAdapter();
    const { scriptedReasoner } = await import('../../src/reasoner/providers/scripted.js');
    const result = await runParticipant({
      runId: 'run-24',
      participantId: 'p1',
      personaPrompt: 'a hurried user',
      userStory: 'add a task',
      capability: CAPABILITY,
      reasoner: scriptedReasoner({ provider: 'scripted', seed: 's' }, { role: 'participant' }),
      adapter,
      targetUrl: 'https://example.invalid/',
      budget: 10,
      recorder,
    });
    const events = await recorder.snapshot();
    expect(result.terminationReason).toBe('finish');
    expect(events.filter((e) => e.type === 'reasoner.failure')).toEqual([]);
  });
});
