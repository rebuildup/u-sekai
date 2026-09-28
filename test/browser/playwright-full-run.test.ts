/**
 * Full-flow browser test: participants -> self-report -> observer ->
 * artifact, all through `PlaywrightAdapter` and the bundled demo
 * environment.
 *
 * What makes this more than "the browser started": each participant is
 * given a scripted action list whose coordinates are read off the real
 * rendered page (the observer view's labelled regions), and the test
 * then asserts on the demo server's own state. A task that only exists
 * because a synthetic user clicked and typed through the constrained
 * action surface cannot be produced by a no-op.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlaywrightAdapter } from '../../src/adapter/browser/playwright-adapter.js';
import { runExperiment } from '../../src/experiment/runner.js';
import { loadExperiment } from '../../src/experiment/loader.js';
import type { ExperimentDefinition, ReasonerConfig } from '../../src/domain/experiment.js';
import type { ParticipantAction } from '../../src/domain/capability.js';
import { assertBrowserRuntimeAvailable } from './support/browser-runtime.js';
import { locateDemoControls, startDemoServer, type ServerHandle } from './support/demo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'experiment.task-tracker.json');
const outDir = path.resolve(here, '..', '.tmp', 'browser-runs');

/** What each participant types into the real "Add a task" field. */
const TITLES = ['Buy milk', 'Write release notes'] as const;

let server: ServerHandle;

beforeAll(async () => {
  await assertBrowserRuntimeAvailable();
  server = await startDemoServer();
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
});

afterAll(async () => {
  // `server` is unassigned when beforeAll failed (for example a missing
  // browser runtime); do not mask that failure with a second error.
  await server?.close();
});

/**
 * `scriptedReasoner` already accepts a per-participant action script
 * (`ReasonerConfig & { script?: ... }`); `ReasonerConfig` itself has no
 * `script` member, so the experiment contract cannot carry one yet.
 */
type ScriptedReasonerConfig = ReasonerConfig & {
  readonly script: ReadonlyArray<ParticipantAction>;
};

function scripted(p: ExperimentDefinition['participants'][number], script: ReadonlyArray<ParticipantAction>): ScriptedReasonerConfig {
  return { ...p.reasoner, script };
}

describe('browser full run', () => {
  it('completes participant -> self-report -> observer -> artifact against the real demo app', async () => {
    const controls = await locateDemoControls(server.baseUrl);
    const def = await loadExperiment(fixture);

    const experiment: ExperimentDefinition = {
      ...def,
      outDir,
      budget: { maxStepsPerParticipant: 6 },
      participants: def.participants.map((p, i) => ({
        ...p,
        reasoner: scripted(p, [
          // Focus the real text field, type, then submit with the real
          // "Add" button. All three are the human-facing primitives a
          // `visualOnly` participant is allowed to use.
          { kind: 'clickByCoords', ...controls.titleInput },
          { kind: 'typeText', text: TITLES[i] ?? 'Untitled task' },
          { kind: 'clickByCoords', ...controls.addButton },
          { kind: 'wait', milliseconds: 100 },
          { kind: 'finish', reason: 'task added' },
        ]),
      })),
    };

    const adapters: PlaywrightAdapter[] = [];
    const { result, runId } = await runExperiment({
      experiment,
      adapterFactory: () => {
        const adapter = new PlaywrightAdapter();
        adapters.push(adapter);
        return adapter;
      },
      resolveTargetUrl: () => server.baseUrl,
    });

    const openDiagnostics = adapters.map((adapter) => adapter.__lastOpenForTest());
    const screenshotDiagnostics = adapters.map((adapter) => adapter.__screenshotDiagnosticsForTest());
    const failureContext =
      `runtimeErrors=${JSON.stringify(result.evidence.runtimeErrors)} openDiagnostics=${JSON.stringify(openDiagnostics)} screenshotDiagnostics=${JSON.stringify(screenshotDiagnostics)}`;

    console.info(`browser launch diagnostics: ${JSON.stringify(openDiagnostics)}`);
    console.info(`browser screenshot diagnostics: ${JSON.stringify(screenshotDiagnostics)}`);

    // --- participants reached a clean terminal state ----------------
    expect(Object.keys(result.terminationReasons)).toHaveLength(def.participants.length);
    for (const reason of Object.values(result.terminationReasons)) {
      expect(['finish', 'stepBudgetExceeded'], failureContext).toContain(reason);
      expect(reason, failureContext).toBe('finish');
    }
    expect(result.evidence.runtimeErrors, failureContext).toEqual([]);
    expect(openDiagnostics, failureContext).toHaveLength(def.participants.length);
    for (const diagnostic of openDiagnostics) {
      expect(diagnostic, failureContext).toEqual({
        launchAttempts: 1,
        status: 'success',
        phase: 'ready',
      });
    }
    expect(screenshotDiagnostics, failureContext).toHaveLength(def.participants.length);
    for (const participantDiagnostics of screenshotDiagnostics) {
      expect(participantDiagnostics.length, failureContext).toBeGreaterThan(0);
      for (const diagnostic of participantDiagnostics) {
        expect(diagnostic.status, failureContext).toBe('success');
        expect(diagnostic.attempts, failureContext).toBeGreaterThanOrEqual(1);
        expect(diagnostic.attempts, failureContext).toBeLessThanOrEqual(2);
      }
    }
    for (const p of result.participants) {
      expect(p.selfReport.participantId).toBe(p.participantId);
      expect(p.selfReport.capturedAt).not.toBe('');
    }
    expect(result.observer.capturedAt).not.toBe('');

    // --- the constrained action surface changed real server state ---
    const page = await (await fetch(`${server.baseUrl}/`)).text();
    for (const title of TITLES) {
      expect(page, `"${title}" was never created by the browser run`).toContain(`<span>${title}</span>`);
    }

    // --- the artifact tree exists on disk ----------------------------
    const runDir = path.join(outDir, runId);
    const manifest = JSON.parse(await fs.readFile(path.join(runDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest['runId']).toBe(runId);
    expect(manifest['packageVersion']).toBeDefined();
    for (const name of ['participants.json', 'events.ndjson', 'observer-report.json', 'result.json', 'summary.md']) {
      await expect(fs.stat(path.join(runDir, name))).resolves.toBeDefined();
    }

    // --- screenshots are real PNG files with matching hashes ---------
    let screenshotCount = 0;
    for (const p of def.participants) {
      const obsDir = path.join(runDir, 'observations', p.id);
      const files = (await fs.readdir(obsDir)).filter((f) => f.endsWith('.json')).sort();
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const raw = await fs.readFile(path.join(obsDir, file), 'utf8');
        const observation = JSON.parse(raw) as {
          visual: { screenshotHash?: string; width: number; height: number };
          screenshot?: { path: string; sha256: string; byteLength: number };
        };
        // Real viewport, not the old hardcoded constant.
        expect(observation.visual.width).toBe(1280);
        expect(observation.visual.height).toBe(800);

        const ref = observation.screenshot;
        expect(ref, `${file} has no screenshot reference`).toBeDefined();
        const png = await fs.readFile(path.join(runDir, ref?.path ?? ''));
        expect(png.byteLength).toBe(ref?.byteLength);
        // PNG magic bytes.
        expect(Array.from(png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
        // The recorded hash matches the bytes actually on disk, and
        // matches the hash the adapter reported in the observation.
        expect(sha256(png)).toBe(ref?.sha256);
        expect(ref?.sha256).toBe(observation.visual.screenshotHash);
        // Bytes are never inlined into the JSON.
        expect(raw).not.toContain('__bytes');
        expect(raw).not.toContain('screenshotPng');
        screenshotCount += 1;
      }
    }
    expect(screenshotCount).toBeGreaterThanOrEqual(def.participants.length);

    // --- observation JSON carries no privileged material ------------
    for (const p of def.participants) {
      const obsDir = path.join(runDir, 'observations', p.id);
      for (const file of await fs.readdir(obsDir)) {
        const raw = await fs.readFile(path.join(obsDir, file), 'utf8');
        expect(raw).not.toContain('domHtml');
        expect(raw).not.toContain('data-uid');
        expect(raw).not.toMatch(/<(!doctype|html|body|input|button|form)/i);
        const parsed = JSON.parse(raw) as { interactiveRegions: Array<Record<string, unknown>> };
        for (const region of parsed.interactiveRegions) {
          expect(Object.keys(region).sort()).toEqual(['bbox', 'label']);
        }
      }
    }
  }, 180_000);
});

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
