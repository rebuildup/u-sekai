/**
 * Participant runtime: the adapter must be released, and a failure must stay
 * scoped to the participant that hit it.
 *
 * These are unit-level guarantees of `runParticipant`; the process-level
 * guarantee (exit code + artifact) is covered by
 * `test/e2e/cli-failure-reporting.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { runParticipant } from '../../src/participant/runtime.js';
import { InMemoryRecorder } from '../../src/evidence/recorder.js';
import { AdapterError } from '../../src/domain/errors.js';
import type { EvidenceRecorder } from '../../src/evidence/recorder.js';
import type { RunEvent } from '../../src/domain/evidence.js';
import type { BrowserAdapter } from '../../src/adapter/browser/interface.js';
import type { ObserverObservation } from '../../src/domain/observation.js';
import type { ActionResult } from '../../src/domain/action.js';
import type { ParticipantAction } from '../../src/domain/capability.js';
import type { Reasoner, ReasonerRequest, ReasonerResponse } from '../../src/domain/reasoner.js';

class RecordingAdapter implements BrowserAdapter {
  readonly adapterId = 'double';
  closeCalls = 0;
  openCalls = 0;

  constructor(private readonly behaviour: {
    open?: () => Promise<void>;
    execute?: (action: ParticipantAction) => Promise<ActionResult>;
  } = {}) {}

  async open(): Promise<void> {
    this.openCalls += 1;
    if (this.behaviour.open) await this.behaviour.open();
  }

  async observe(stepIndex: number): Promise<ObserverObservation> {
    return {
      stepIndex,
      url: 'http://target.test/app',
      title: 'Task tracker',
      capturedAt: new Date().toISOString(),
      visual: {
        width: 1280,
        height: 800,
        visibleText: 'Add a task',
        focused: { x: 0, y: 0, width: 0, height: 0 },
      },
      aria: { role: 'document', name: 'Task tracker', children: [] },
      domHtml: '<main>Add a task</main>',
      console: [],
      network: [],
      interactiveRegions: [],
    };
  }

  async execute(action: ParticipantAction): Promise<ActionResult> {
    if (this.behaviour.execute) return this.behaviour.execute(action);
    return { status: 'ok', observedAfter: { url: 'http://target.test/app', title: 'Task tracker' } };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

/** Always answers `finish`, so the loop ends on its own terms. */
function finishingReasoner(): Reasoner {
  return {
    providerId: 'double',
    modelId: 'double:finish',
    complete: async (_req: ReasonerRequest): Promise<ReasonerResponse> => ({
      kind: 'action',
      action: { kind: 'finish', reason: 'done' },
      rationale: 'done',
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  };
}

/** Finishes the loop, then fails the self-report capture. */
function selfReportFailingReasoner(message: string): Reasoner {
  return {
    providerId: 'double',
    modelId: 'double:self-report-failure',
    complete: async (req: ReasonerRequest): Promise<ReasonerResponse> => {
      if (/SelfReport shape/.test(req.systemPrompt)) throw new Error(message);
      return {
        kind: 'action',
        action: { kind: 'finish', reason: 'done' },
        rationale: 'done',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

/** A recorder whose post-loop `termination` append fails, as a failing
 * artifact writer would. */
function recorderFailingOnTermination(inner: InMemoryRecorder): EvidenceRecorder {
  return {
    append: async (event: RunEvent) => {
      if (event.type === 'termination') throw new Error('evidence sink unavailable');
      await inner.append(event);
    },
    snapshot: () => inner.snapshot(),
    close: () => inner.close(),
  };
}

function baseOptions(overrides: {
  adapter: BrowserAdapter;
  reasoner: Reasoner;
  recorder: EvidenceRecorder;
}) {
  return {
    runId: 'run-1',
    participantId: 'p-double',
    personaPrompt: 'You are a first-time visitor.',
    userStory: 'You want to add a task.',
    capability: {
      observation: 'visual',
      action: 'visualOnly',
      memory: { kind: 'limitedRecent', windowSteps: 2 },
    },
    adapter: overrides.adapter,
    reasoner: overrides.reasoner,
    targetUrl: 'http://target.test/',
    budget: 3,
    recorder: overrides.recorder,
  } as const;
}

describe('participant runtime: adapter release', () => {
  it('closes the adapter after a clean finish', async () => {
    const adapter = new RecordingAdapter();
    const recorder = new InMemoryRecorder();
    const result = await runParticipant(baseOptions({
      adapter,
      reasoner: finishingReasoner(),
      recorder,
    }));

    expect(result.terminationReason).toBe('finish');
    expect(result.error).toBeUndefined();
    expect(adapter.closeCalls).toBe(1);
  });

  it('closes the adapter even when the post-loop phase throws', async () => {
    const adapter = new RecordingAdapter();
    const inner = new InMemoryRecorder();

    await expect(runParticipant(baseOptions({
      adapter,
      reasoner: finishingReasoner(),
      recorder: recorderFailingOnTermination(inner),
    }))).rejects.toThrow('evidence sink unavailable');

    // The leak this guards against is a live browser process / open handle
    // keeping the Node event loop alive after the run.
    expect(adapter.closeCalls).toBe(1);
  });
});

describe('participant runtime: failures stay scoped to the participant', () => {
  it('turns a target that cannot be opened into a participant failure with a diagnostic', async () => {
    const adapter = new RecordingAdapter({
      open: async () => {
        throw new AdapterError('http adapter open failed (500) for http://target.test/', 'http', {
          status: 500,
        });
      },
    });
    const recorder = new InMemoryRecorder();
    const result = await runParticipant(baseOptions({
      adapter,
      reasoner: finishingReasoner(),
      recorder,
    }));

    expect(result.terminationReason).toBe('error');
    expect(result.error).toBe('adapter.open failed: http adapter open failed (500) for http://target.test/');
    expect(adapter.closeCalls).toBe(1);

    const terminations = (await recorder.snapshot())
      .filter((e): e is Extract<RunEvent, { type: 'termination' }> => e.type === 'termination');
    expect(terminations).toHaveLength(1);
    expect(terminations[0]?.reason).toBe('error');
  });

  it('keeps an adapter failure inside the step loop as a participant diagnostic', async () => {
    const adapter = new RecordingAdapter({
      execute: async () => {
        throw new AdapterError('navigation failed: target stopped responding', 'http');
      },
    });
    const result = await runParticipant(baseOptions({
      adapter,
      reasoner: {
        providerId: 'double',
        modelId: 'double:click',
        complete: async (): Promise<ReasonerResponse> => ({
          kind: 'action',
          action: { kind: 'clickByCoords', x: 1, y: 1 },
          rationale: 'click',
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      },
      recorder: new InMemoryRecorder(),
    }));

    expect(result.terminationReason).toBe('error');
    expect(result.error).toBe('navigation failed: target stopped responding');
    expect(adapter.closeCalls).toBe(1);
  });

  it('degrades a self-report capture failure to a placeholder and keeps it observable', async () => {
    const adapter = new RecordingAdapter();
    const recorder = new InMemoryRecorder();
    const result = await runParticipant(baseOptions({
      adapter,
      reasoner: selfReportFailingReasoner('provider returned no content'),
      recorder,
    }));

    // The exploration itself succeeded, so the terminal state is unchanged.
    expect(result.terminationReason).toBe('finish');
    expect(result.selfReport.freeText).toContain('unavailable');
    expect(adapter.closeCalls).toBe(1);

    // The failure must be observable, but *how* depends on whether the
    // Reasoner call sits behind the structured-output recovery boundary
    // (ADR-0008). Without it the diagnostic is returned on the result; with
    // it, the boundary absorbs the throw and records a typed
    // `reasoner.failure` for the self-report channel instead. Both are
    // acceptable; silently losing it is not. This assertion is therefore
    // order-independent and valid whether or not #24 has landed.
    const events = await recorder.snapshot() as unknown as ReadonlyArray<{ type: string; [k: string]: unknown }>;
    const typedFailure = events.some(
      (e) => e.type === 'reasoner.failure' && e.channel === 'selfReport',
    );
    const returnedDiagnostic = typeof result.error === 'string' && result.error !== '';
    expect(typedFailure || returnedDiagnostic).toBe(true);
  });

  it('releases the adapter when the post-loop self-report phase throws outright', async () => {
    const adapter = new RecordingAdapter();
    const inner = new InMemoryRecorder();
    // A failure the recovery boundary cannot absorb: the evidence sink is
    // unavailable, so persisting the self-report prompt itself throws.
    const recorder: EvidenceRecorder = {
      append: async (event: RunEvent) => {
        if (event.type === 'selfReport.prompt') throw new Error('evidence sink unavailable');
        await inner.append(event);
      },
      snapshot: () => inner.snapshot(),
      close: () => inner.close(),
    };

    const result = await runParticipant(baseOptions({
      adapter,
      reasoner: {
        providerId: 'double',
        modelId: 'double:finish',
        complete: async (): Promise<ReasonerResponse> => ({
          kind: 'action',
          action: { kind: 'finish', reason: 'done' },
          rationale: 'done',
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      },
      recorder,
    }));

    // The trace the participant already produced is not discarded.
    expect(result.terminationReason).toBe('finish');
    expect(result.selfReport.freeText).toContain('unavailable');
    expect(result.error).toContain('self-report capture failed');
    // The important part: the adapter is released even on this path.
    expect(adapter.closeCalls).toBe(1);
  });
});
