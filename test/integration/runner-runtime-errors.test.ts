/**
 * Integration: a participant that dies on an adapter failure must be
 * diagnosable from the run artifact alone.
 *
 * The failing `BrowserAdapter` double is supplied through the experiment's
 * own adapter factory, so no browser, no external service and no provider
 * credential are involved.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, type ServerHandle } from '../../src/demo/environment/server.js';
import { runExperiment, runtimeErrorsForParticipant } from '../../src/experiment/runner.js';
import { classifyRunExit } from '../../src/cli/index.js';
import { loadExperiment } from '../../src/experiment/loader.js';
import { AdapterError } from '../../src/domain/errors.js';
import type { BrowserAdapter } from '../../src/adapter/browser/interface.js';
import type { ObserverObservation } from '../../src/domain/observation.js';
import type { ParticipantAction } from '../../src/domain/capability.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'experiment.task-tracker.json');
const outDir = path.resolve(here, '..', '.tmp', 'runtime-errors');

const ADAPTER_FAILURE = 'navigation failed: target stopped responding';

class FailingAdapter implements BrowserAdapter {
  readonly adapterId = 'failing-double';
  closeCalls = 0;

  async open(): Promise<void> {
    /* the target is already "open" for this double */
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

  async execute(_action: ParticipantAction): Promise<never> {
    throw new AdapterError(ADAPTER_FAILURE, 'failing-double');
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

let server: ServerHandle;

beforeAll(async () => {
  server = await startServer({ port: 0 });
  await fs.rm(outDir, { recursive: true, force: true });
});

afterAll(async () => {
  await server.close();
});

describe('runtimeErrors rollup', () => {
  it('records the adapter diagnostic once per participant and writes it to the artifact', async () => {
    const def = await loadExperiment(fixture);
    const adapters: FailingAdapter[] = [];

    const { result, runId } = await runExperiment({
      experiment: { ...def, outDir },
      adapterFactory: () => {
        const a = new FailingAdapter();
        adapters.push(a);
        return a;
      },
      resolveTargetUrl: () => server.baseUrl,
    });

    const participantIds = Object.keys(result.terminationReasons);
    expect(participantIds).toHaveLength(2);
    for (const id of participantIds) {
      expect(result.terminationReasons[id]).toBe('error');
    }
    expect(adapters.every((a) => a.closeCalls === 1)).toBe(true);

    // The process-level consequence: this run must not report success.
    expect(classifyRunExit(result.terminationReasons).code).toBe(2);

    // One entry per participant, each naming the participant and the step.
    expect(result.evidence.runtimeErrors).toHaveLength(2);
    for (const id of participantIds) {
      const entries = runtimeErrorsForParticipant(result.evidence, id);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.message).toBe(ADAPTER_FAILURE);
      expect(entries[0]?.where).toBe(`participant=${id} step=0`);
      expect(entries[0]?.ts).not.toBe('');
    }

    // The diagnostic is findable in the written artifact.
    const runDir = path.join(outDir, runId);
    const resultRaw = await fs.readFile(path.join(runDir, 'result.json'), 'utf8');
    expect(resultRaw).toContain(ADAPTER_FAILURE);
    const summaryRaw = await fs.readFile(path.join(runDir, 'summary.md'), 'utf8');
    expect(summaryRaw).toContain(ADAPTER_FAILURE);
    for (const id of participantIds) {
      expect(summaryRaw).toContain(`- Participant ${id}: terminated (error) -- ${ADAPTER_FAILURE}`);
    }
  }, 60_000);
});
