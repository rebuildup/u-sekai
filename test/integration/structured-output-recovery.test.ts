/**
 * Integration test: the whole run pipeline with a deterministic provider
 * that exercises the structured-output taxonomy (ADR-0008).
 *
 * Drives `runExperiment` against the bundled demo server with an injected
 * transport, so the assertion is about the persisted artifact — not an
 * in-memory approximation of it.
 *
 * Hermetic: no network, no credential in source, no wall-clock waits.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, type ServerHandle } from '../../src/demo/environment/server.js';
import { HttpAdapter } from '../../src/adapter/browser/http-adapter.js';
import { runExperiment } from '../../src/experiment/runner.js';
import { loadExperiment } from '../../src/experiment/loader.js';
import { createAnthropicReasoner, type AnthropicFetch } from '../../src/reasoner/providers/anthropic.js';
import type { Reasoner } from '../../src/domain/reasoner.js';
import type { ExperimentDefinition, ReasonerConfig } from '../../src/domain/experiment.js';
import type { RunEvent, ReasonerFailureEvent } from '../../src/domain/evidence.js';
import type { RunResult } from '../../src/domain/result.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'experiment.task-tracker.json');
const outRoot = path.resolve(here, '..', '.tmp', 'runs');

const SELF_REPORT_MARKER = 'Emit a JSON object matching the SelfReport shape';
const OBSERVER_MARKER = 'Produce an ObserverFindings JSON object';

const VALID_SELF_REPORT = JSON.stringify({
  goal: 'add a task called Buy milk',
  productUnderstanding: 'a text box, an Add button, and a list',
  confusionPoints: ['no confirmation message appeared'],
  resultAlignedWithExpectation: true,
  confidence: 0.6,
  wouldReturn: true,
  freeText: 'Worked once I found the Add button.',
});

const VALID_FINDINGS = JSON.stringify({
  summary: 'Both participants completed the task after a short search.',
  findings: [
    { id: 'f-1', stepIndex: 1, severity: 'minor', category: 'friction', summary: 'Add button label is lowercase.', evidenceRefs: [] },
  ],
  terminationVerdict: { declared: 'finish', plausible: true, note: 'Both participants finished cleanly.' },
});

let server: ServerHandle;

beforeAll(async () => {
  server = await startServer({ port: 0 });
});

afterAll(async () => {
  await server.close();
});

function okText(text: string): Response {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

type ChannelScript = 'malformed-then-valid' | 'always-malformed' | 'contract-invalid';

interface ProviderPlan {
  /** Action-channel behaviour; indexed per action-channel call. */
  readonly action: ReadonlyArray<() => Response>;
  readonly selfReport?: () => Response;
  readonly observer?: () => Response;
}

function planFor(mode: ChannelScript): ProviderPlan {
  switch (mode) {
    case 'malformed-then-valid':
      return {
        // First action turn is unparseable, later turns are valid, so the
        // retry recovers and the run continues to a normal finish.
        action: [
          () => okText('I am not sure which element to interact with here.'),
          () => okText('{"kind":"clickByCoords","x":120,"y":140}'),
          () => okText('{"kind":"typeText","text":"Buy milk"}'),
          () => okText('{"kind":"finish","reason":"task added"}'),
        ],
      };
    case 'always-malformed':
      return { action: [() => okText('still not json, sorry')] };
    case 'contract-invalid':
      return { action: [() => okText('{"kind":"clickByCoords","x":"left","y":140}')] };
  }
}

function makeTransport(plan: ProviderPlan, stats: { action: number; selfReport: number; observer: number }): AnthropicFetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { system: string };
    if (body.system.includes(SELF_REPORT_MARKER)) {
      stats.selfReport += 1;
      return plan.selfReport ? plan.selfReport() : okText(VALID_SELF_REPORT);
    }
    if (body.system.includes(OBSERVER_MARKER)) {
      stats.observer += 1;
      return plan.observer ? plan.observer() : okText(VALID_FINDINGS);
    }
    const index = stats.action;
    stats.action += 1;
    const responder = plan.action[Math.min(index, plan.action.length - 1)];
    if (!responder) throw new Error('no action responder configured');
    return responder();
  };
}

interface RunOutcome {
  readonly runId: string;
  readonly artifactDir: string;
  readonly events: ReadonlyArray<RunEvent>;
  readonly result: RunResult;
  readonly stats: { action: number; selfReport: number; observer: number };
}

async function runWithPlan(mode: ChannelScript): Promise<RunOutcome> {
  const stats = { action: 0, selfReport: 0, observer: 0 };
  const transport = makeTransport(planFor(mode), stats);
  const definition = await loadExperiment(fixture);
  const experiment: ExperimentDefinition = {
    ...definition,
    outDir: outRoot,
    budget: { maxStepsPerParticipant: 3 },
  };

  const reasonerFactory = (
    _config: ReasonerConfig,
    _ctx: { participantLabel?: string; role: 'participant' | 'observer' | 'selfReport' },
  ): Reasoner =>
    createAnthropicReasoner({
      apiKey: 'test-key-not-a-credential',
      endpoint: 'https://provider.invalid/v1/messages',
      modelId: 'test-model',
      fetchImpl: transport,
    });

  const { result, runId } = await runExperiment({
    experiment,
    adapterFactory: () => new HttpAdapter(),
    resolveTargetUrl: () => server.baseUrl,
    reasonerFactory,
    structuredOutputPolicy: { backoffMs: 0, sleep: async () => undefined },
  });

  const artifactDir = path.join(outRoot, runId);
  const ndjson = await fs.readFile(path.join(artifactDir, 'events.ndjson'), 'utf8');
  const events = ndjson
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as RunEvent);

  return { runId, artifactDir, events, result, stats };
}

function failuresOf(events: ReadonlyArray<RunEvent>): ReasonerFailureEvent[] {
  return events.filter((e): e is ReasonerFailureEvent => e.type === 'reasoner.failure');
}

describe('structured-output recovery: full run artifact', () => {
  it('recovers from a malformed turn, continues the run, and records no capability violation', async () => {
    const out = await runWithPlan('malformed-then-valid');

    // The run completed normally despite the malformed first turn.
    expect(Object.values(out.result.terminationReasons)).toEqual(['finish', 'finish']);
    expect(out.result.observer.summary).toBe('Both participants completed the task after a short search.');

    // Headline regression: a malformed assistant turn must never produce a
    // participant capability violation anywhere in the persisted artifact.
    const capabilityViolations = out.events.filter((e) => e.type === 'capability.violation');
    expect(capabilityViolations).toEqual([]);

    // The failure and the recovery are both visible in events.ndjson.
    const failures = failuresOf(out.events);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((f) => f.failureKind === 'providerParse')).toBe(true);
    expect(failures.every((f) => f.recoveryOutcome === 'recovered')).toBe(true);
    expect(failures[0]).toMatchObject({
      channel: 'participant',
      outputKind: 'action',
      provider: 'anthropic',
      attempt: 1,
      retryable: true,
      willRetry: true,
    });

    // A recovered failure precedes the action it unblocked.
    const types = out.events.map((e) => e.type);
    expect(types.indexOf('reasoner.failure')).toBeLessThan(types.indexOf('action'));

    // No reasoner failure is folded into the capability-violation channel.
    expect(out.result.evidence.runtimeErrors).toEqual([]);
    expect(out.result.evidence.reasonerFailures).toHaveLength(failures.length);
    expect(out.result.evidence.reasonerFailures[0]).toMatchObject({
      channel: 'participant',
      outputKind: 'action',
      failureKind: 'providerParse',
      provider: 'anthropic',
      attempt: 1,
      maxAttempts: 2,
      retryable: true,
      recoveryOutcome: 'recovered',
    });

    // The credential never reaches the artifact.
    const rawArtifact = await fs.readFile(path.join(out.artifactDir, 'events.ndjson'), 'utf8');
    expect(rawArtifact).not.toContain('test-key-not-a-credential');
  });

  it('terminates with reasonerFailure when recovery is exhausted, still with no capability violation', async () => {
    const out = await runWithPlan('always-malformed');

    expect(Object.values(out.result.terminationReasons)).toEqual(['reasonerFailure', 'reasonerFailure']);
    expect(out.result.evidence.terminationReasonByParticipant).toEqual({
      'p-visual-short-memory': 'reasonerFailure',
      'p-full-history': 'reasonerFailure',
    });

    const violations = out.events.filter((e) => e.type === 'capability.violation');
    expect(violations).toEqual([]);

    // Bounded: exactly two attempts per participant action channel.
    const participantFailures = failuresOf(out.events).filter(
      (f) => f.channel === 'participant' && f.outputKind === 'action',
    );
    expect(participantFailures).toHaveLength(4); // 2 participants x 2 attempts
    expect(participantFailures.every((f) => f.attempt === 1 || f.attempt === 2)).toBe(true);
    expect(participantFailures.every((f) => f.maxAttempts === 2)).toBe(true);
    expect(participantFailures.every((f) => f.recoveryOutcome === 'exhausted')).toBe(true);

    // The termination event carries the non-capability reason.
    const terminations = out.events.filter((e) => e.type === 'termination');
    expect(terminations.some((e) => e.type === 'termination' && e.reason === 'reasonerFailure')).toBe(true);
    expect(terminations.some((e) => e.type === 'termination' && e.reason === 'capabilityViolation')).toBe(false);

    // The observer still ran on the full trace and had a chance to speak.
    expect(out.stats.observer).toBe(1);
    expect(out.result.observer.findings).toHaveLength(1);

    // The run's real failure mode is diagnosable from result.json alone.
    expect(out.result.evidence.reasonerFailures.length).toBeGreaterThanOrEqual(4);
    expect(new Set(out.result.evidence.reasonerFailures.map((f) => f.failureKind))).toEqual(new Set(['providerParse']));
  });

  it('classifies a structurally invalid action as contractValidation end to end', async () => {
    const out = await runWithPlan('contract-invalid');

    expect(Object.values(out.result.terminationReasons)).toEqual(['reasonerFailure', 'reasonerFailure']);
    expect(out.events.filter((e) => e.type === 'capability.violation')).toEqual([]);

    const participantFailures = failuresOf(out.events).filter(
      (f) => f.channel === 'participant' && f.outputKind === 'action',
    );
    expect(participantFailures).toHaveLength(4);
    expect(participantFailures.every((f) => f.failureKind === 'contractValidation')).toBe(true);
    expect(new Set(out.result.evidence.reasonerFailures.map((f) => f.failureKind))).toEqual(
      new Set(['contractValidation']),
    );
  });

  it('writes an observer report that names its own failure instead of claiming a decline', async () => {
    const stats = { action: 0, selfReport: 0, observer: 0 };
    const transport: AnthropicFetch = async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { system: string };
      if (body.system.includes(SELF_REPORT_MARKER)) return okText(VALID_SELF_REPORT);
      if (body.system.includes(OBSERVER_MARKER)) {
        stats.observer += 1;
        return okText('the trace looked uneventful');
      }
      return okText('{"kind":"finish","reason":"done"}');
    };
    const definition = await loadExperiment(fixture);
    const experiment: ExperimentDefinition = { ...definition, outDir: outRoot, budget: { maxStepsPerParticipant: 2 } };

    const { result, runId } = await runExperiment({
      experiment,
      adapterFactory: () => new HttpAdapter(),
      resolveTargetUrl: () => server.baseUrl,
      reasonerFactory: () =>
        createAnthropicReasoner({
          apiKey: 'test-key-not-a-credential',
          endpoint: 'https://provider.invalid/v1/messages',
          modelId: 'test-model',
          fetchImpl: transport,
        }),
      structuredOutputPolicy: { backoffMs: 0, sleep: async () => undefined },
    });

    // The observer turn is retried once, then reported as unavailable.
    expect(stats.observer).toBe(2);
    expect(result.observer.findings).toEqual([]);
    expect(result.observer.summary).toContain('providerParse');
    expect(result.observer.summary).not.toContain('declined');
    expect(result.observer.terminationVerdict.note).toContain('provider defect');
    expect(Object.values(result.terminationReasons)).toEqual(['finish', 'finish']);

    const events = (await fs.readFile(path.join(outRoot, runId, 'events.ndjson'), 'utf8'))
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as RunEvent);
    expect(failuresOf(events).filter((f) => f.channel === 'observer')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'capability.violation')).toEqual([]);
  });
});
