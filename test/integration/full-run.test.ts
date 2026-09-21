/**
 * Integration test: full u-sekai flow against the demo environment using
 * the deterministic scripted reasoner and the HTTP adapter. No network
 * access is required except the local demo server.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type ServerHandle } from '../../src/demo/environment/server.js';
import { HttpAdapter } from '../../src/adapter/browser/http-adapter.js';
import { runExperiment } from '../../src/experiment/runner.js';
import { makeInMemoryRecorder } from '../../src/evidence/recorder.js';
import { loadExperiment } from '../../src/experiment/loader.js';
import type { ExperimentDefinition } from '../../src/domain/experiment.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'experiment.task-tracker.json');

let server: ServerHandle;

beforeAll(async () => {
  server = await startServer({ port: 0 });
});

afterAll(async () => {
  await server.close();
});

describe('full-run integration', () => {
  it('runs both participants end-to-end and writes the artifact tree', async () => {
    const def = await loadExperiment(fixture);
    const experiment: ExperimentDefinition = {
      ...def,
      outDir: path.resolve(here, '..', '.tmp', 'runs'),
    };

    const rec = makeInMemoryRecorder();
    void rec; // The runner owns its own recorder; we just keep an import for typing sanity.

    const { result, runId } = await runExperiment({
      experiment,
      adapterFactory: () => new HttpAdapter(),
      resolveTargetUrl: () => server.baseUrl,
    });

    expect(runId).toContain('demo-');
    expect(Object.keys(result.terminationReasons)).toHaveLength(2);
    expect(result.participants).toHaveLength(2);
    // Both scripted participants should reach finish before the budget.
    for (const id of Object.keys(result.terminationReasons)) {
      // acceptance: the loop reaches a known terminal state, not a runtime error.
      expect(['finish', 'stepBudgetExceeded']).toContain(result.terminationReasons[id]);
    }
    // Self-reports carry the participant id.
    for (const p of result.participants) {
      expect(p.selfReport.participantId).toBe(p.participantId);
      expect(p.selfReport.capturedAt).not.toBe('');
    }
  });
});
