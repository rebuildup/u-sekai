/**
 * Failure-path evidence for the browser path.
 *
 * A browser gate is only meaningful if a broken browser fails loudly.
 * This suite drives the real adapter at a target that refuses
 * connections and asserts the two distinct failure shapes:
 *
 * - The target cannot be opened at all. `open()` rejects with an
 *   `AdapterError` naming the URL, the failing phase and the underlying
 *   cause, no browser is left behind, and `runExperiment` propagates the
 *   failure instead of inventing an observation.
 * - The page opens and then breaks mid-run. Every participant terminates
 *   with `error` (never `finish`), so the result cannot be read as a
 *   completed exploration, and no observation is fabricated after the
 *   failure.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlaywrightAdapter } from '../../src/adapter/browser/playwright-adapter.js';
import { runExperiment } from '../../src/experiment/runner.js';
import { loadExperiment } from '../../src/experiment/loader.js';
import { AdapterError } from '../../src/domain/errors.js';
import type { BrowserAdapter } from '../../src/adapter/browser/interface.js';
import type { RunResult } from '../../src/domain/result.js';
import { assertBrowserRuntimeAvailable } from './support/browser-runtime.js';
import { startDemoServer, type ServerHandle } from './support/demo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const fixture = path.resolve(here, '..', 'fixtures', 'experiment.task-tracker.json');
const outDir = path.resolve(here, '..', '.tmp', 'browser-failure-runs');
const cliPath = path.join(root, 'dist', 'cli', 'index.js');

function fsExists(p: string): boolean {
  return existsSync(p);
}

let server: ServerHandle;
let deadUrl = '';

beforeAll(async () => {
  await assertBrowserRuntimeAvailable();
  server = await startDemoServer();
  deadUrl = await closedPortUrl();
  await fs.rm(outDir, { recursive: true, force: true });
});

afterAll(async () => {
  // `server` is unassigned when beforeAll failed (for example a missing
  // browser runtime); do not mask that failure with a second error.
  await server?.close();
});

/** Binds an ephemeral port, releases it, and returns a URL nothing serves. */
async function closedPortUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const addr = probe.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}/`;
}

/**
 * A real browser against a real page that breaks on the second
 * observation, i.e. the "it worked, then it didn't" shape.
 */
class BreaksMidRunAdapter implements BrowserAdapter {
  readonly adapterId = 'playwright-breaks';
  private steps = 0;

  constructor(private readonly inner = new PlaywrightAdapter()) {}

  async open(url: string, viewport?: { width: number; height: number }): Promise<void> {
    await this.inner.open(url, viewport);
  }

  async observe(stepIndex: number) {
    this.steps += 1;
    if (this.steps > 1) {
      throw new AdapterError(
        `simulated browser failure at step ${stepIndex}: the page went away`,
        'playwright',
        { stepIndex },
      );
    }
    return this.inner.observe(stepIndex);
  }

  async execute(action: Parameters<BrowserAdapter['execute']>[0]) {
    return this.inner.execute(action);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

describe('browser failure diagnostics', () => {
  it('rejects an unreachable target with the URL, the phase and the cause', async () => {
    const adapter = new PlaywrightAdapter();
    let caught: unknown;
    try {
      await adapter.open(deadUrl);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdapterError);
    const message = (caught as Error).message;
    expect(message).toContain('playwright open failed during goto');
    expect(message).toContain(deadUrl);
    expect(message).toMatch(/ERR_CONNECTION_REFUSED|ECONNREFUSED|refused/i);
    // Actionable: the reader learns what failed, where, and how.
    expect((caught as AdapterError).detail['phase']).toBe('goto');
    expect((caught as AdapterError).adapter).toBe('playwright');
    // No browser survived the failure, and none is left to pretend to work.
    expect(adapter.__isOpenForTest()).toBe(false);
    expect(adapter.__lastCloseForTest()).toEqual({
      errors: [],
      browserWasRunning: true,
      browserConnectedAfter: false,
    });
    await expect(adapter.observe(0)).rejects.toThrow(/observe called before open/);
  }, 120_000);

  it('never fabricates browser evidence for an unopenable target', async () => {
    const def = await loadExperiment(fixture);
    let caught: unknown;
    let completed: { result: RunResult; runId: string } | null = null;
    try {
      completed = await runExperiment({
        experiment: { ...def, outDir },
        adapterFactory: () => new PlaywrightAdapter(),
        resolveTargetUrl: () => deadUrl,
      });
    } catch (err) {
      caught = err;
    }

    // An unreachable target must never look like a successful run. Which of
    // the two acceptable shapes applies depends on whether the run treats an
    // unopenable target as a participant-scoped failure or as a fatal one,
    // and both are legitimate. What is *not* legitimate is a run that
    // reports success or writes an artifact claiming the page was observed.
    if (caught !== undefined) {
      expect(caught).toBeInstanceOf(AdapterError);
      expect((caught as Error).message).toContain(deadUrl);
      // A run that never reached a page produces no artifact at all.
      expect(await fs.readdir(outDir).catch(() => [])).toEqual([]);
      return;
    }

    const { result, runId } = completed as { result: RunResult; runId: string };
    const reasons = Object.values(result.terminationReasons);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.every((r) => r === 'error' || r === 'reasonerFailure'), `unexpected reasons ${reasons.join(',')}`).toBe(true);
    expect(result.evidence.runtimeErrors.length).toBeGreaterThan(0);
    const diagnostic = result.evidence.runtimeErrors.map((e) => e.message).join('\n');
    expect(diagnostic).toContain(deadUrl);
    // No observation may claim a page was captured from a target that never
    // loaded, and no screenshot may exist for such a run.
    const artifactRoot = path.join(outDir, runId);
    const observationDir = path.join(artifactRoot, 'observations');
    if (fsExists(observationDir)) {
      for (const participant of await fs.readdir(observationDir)) {
        for (const file of await fs.readdir(path.join(observationDir, participant))) {
          const full = path.join(observationDir, participant, file);
          const observation = JSON.parse(await fs.readFile(full, 'utf8')) as { url: string };
          expect(observation.url, `${full} claims a page was observed`).not.toBe(deadUrl);
        }
      }
    }
    expect(fsExists(path.join(artifactRoot, 'screenshots'))).toBe(false);
  }, 180_000);

  it('fails the shipped CLI with a non-zero exit and an actionable message', async () => {
    await expect(fs.stat(cliPath), 'dist/cli/index.js is missing — run `npm run build`').resolves.toBeDefined();
    const deadExperiment = path.join(outDir, 'dead-target.json');
    await fs.mkdir(outDir, { recursive: true });
    const def = await loadExperiment(fixture);
    await fs.writeFile(
      deadExperiment,
      JSON.stringify({ ...def, environment: { kind: 'http', url: deadUrl }, outDir }, null, 2),
      'utf8',
    );

    const run = await runCli([cliPath, 'run', deadExperiment, '--adapter', 'playwright', '--out', outDir]);
    expect(run.code, `expected a non-zero exit, stdout=${run.stdout}`).not.toBe(0);
    expect(run.stderr).toContain('u-sekai:');
    expect(run.stderr).toContain(deadUrl);
    expect(run.stderr).toMatch(/ERR_CONNECTION_REFUSED|ECONNREFUSED|refused/i);
  }, 180_000);

  it('terminates every participant with error when the browser breaks mid-run', async () => {
    const def = await loadExperiment(fixture);
    const { result, runId } = await runExperiment({
      experiment: { ...def, outDir },
      adapterFactory: () => new BreaksMidRunAdapter(),
      resolveTargetUrl: () => server.baseUrl,
    });

    const reasons = Object.values(result.terminationReasons);
    expect(reasons).toHaveLength(def.participants.length);
    for (const reason of reasons) {
      // The critical assertion: a run that never finished cannot be
      // reported as a finished exploration.
      expect(reason).toBe('error');
    }
    // Each participant got exactly one (failing) step recorded.
    for (const p of def.participants) {
      expect(result.evidence.stepCountByParticipant[p.id]).toBe(1);
    }
    expect(result.evidence.terminationReasonByParticipant).toEqual(result.terminationReasons);

    const runDir = path.join(outDir, runId);
    // Only the first, successful observation exists; nothing after the
    // failure was invented.
    for (const p of def.participants) {
      const files = await fs.readdir(path.join(runDir, 'observations', p.id));
      expect(files).toEqual(['step-000.json']);
    }
    expect(
      (await fs.readdir(path.join(runDir, 'screenshots', def.participants[0]?.id ?? ''))).sort(),
    ).toEqual(['step-000.png']);

    // The failure is visible in the artifact: one `error` termination per
    // participant and no `finish` anywhere.
    const eventsRaw = await fs.readFile(path.join(runDir, 'events.ndjson'), 'utf8');
    const events = eventsRaw.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const terminations = events.filter((e) => e['type'] === 'termination');
    expect(terminations).toHaveLength(def.participants.length);
    for (const t of terminations) {
      expect(t['reason']).toBe('error');
    }
    expect(eventsRaw).not.toContain('"reason":"finish"');

    // KNOWN GAP (owned by src/experiment/runner.ts and
    // src/participant/runtime.ts, not by this change): the artifact
    // records the `error` termination reason but not the adapter's
    // diagnostic text. The message itself is asserted at the adapter and
    // CLI level above.
  }, 180_000);

  it('reports a navigation that fails before commit instead of a false success', async () => {
    // Chromium commits `chrome-error://chromewebdata/` when a navigation
    // cannot be delivered, so the URL *does* change. Reporting `ok` there
    // would put a false success in the run artifact.
    const own = await startDemoServer();
    const adapter = new PlaywrightAdapter();
    try {
      await adapter.open(own.baseUrl);
      const obs = await adapter.observe(0);
      const settings = obs.interactiveRegions.find((r) => r.label === 'Settings');
      expect(settings).toBeDefined();
      // Take the target away, then click the link that needs it.
      await own.close();

      const result = await adapter.execute({
        kind: 'clickByCoords',
        x: Math.round((settings?.bbox.x ?? 0) + (settings?.bbox.width ?? 0) / 2),
        y: Math.round((settings?.bbox.y ?? 0) + (settings?.bbox.height ?? 0) / 2),
      });
      expect(result.status).toBe('error');
      if (result.status !== 'error') return;
      expect(result.code).toBe('timeout');
      expect(result.note).toContain('failed before it committed');
      expect(result.note).toMatch(/ERR_CONNECTION_REFUSED|ERR_/);
    } finally {
      await adapter.close();
    }
  }, 120_000);

  it('leaves the demo environment untouched by the failed runs', async () => {
    const html = await (await fetch(`${server.baseUrl}/`)).text();
    expect(html).toContain('No tasks yet.');
  });
});

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c) => out.push(c as Buffer));
    child.stderr.on('data', (c) => err.push(c as Buffer));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        code: code ?? 0,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
  });
}
