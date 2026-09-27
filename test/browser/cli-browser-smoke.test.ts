/**
 * CLI-level browser smoke: the shipped `u-sekai run` binary, the
 * Playwright adapter, the bundled demo environment and the deterministic
 * scripted reasoner. This is the path the release gate exercises, so it
 * asserts on the artifact the CLI produced, not on internal state.
 *
 * Coordinates in `test/fixtures/experiment.task-tracker.browser.json`
 * are the measured centres of the demo controls in a 1280x800 viewport
 * (input centre (97,178), "Add" centre (212,178)). This suite proves
 * they still hit those elements, so a layout change fails loudly with a
 * readable note instead of silently clicking empty space.
 *
 * The gate condition is asserted on the artifact's termination reasons,
 * not only on the process exit code. Measured behaviour of
 * `src/cli/index.ts` (not owned by this change): a target that cannot be
 * opened aborts the run and exits 2 with the adapter diagnostic on
 * stderr, but a failure *inside* the step loop yields exit 0 with
 * `terminationReasons: {<id>: 'error'}`. A CLI exit code alone must
 * therefore not be treated as a browser-smoke result.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBrowserRuntimeAvailable } from './support/browser-runtime.js';
import { startDemoServer, withIndependentPage, type ServerHandle } from './support/demo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const cliPath = path.join(root, 'dist', 'cli', 'index.js');
const fixture = path.join(root, 'test', 'fixtures', 'experiment.task-tracker.browser.json');
const outDir = path.join(root, 'test', '.tmp', 'browser-cli');

/** Titles each participant types; see the fixture. */
const TITLES = ['Buy milk', 'Write release notes'] as const;

let server: ServerHandle;

beforeAll(async () => {
  await assertBrowserRuntimeAvailable();
  // The CLI boots its own demo server; this instance only exists so the
  // suite can verify the coordinates still address the right elements.
  server = await startDemoServer();
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
});

afterAll(async () => {
  // `server` is unassigned when beforeAll failed (for example a missing
  // browser runtime); do not mask that failure with a second error.
  await server?.close();
});

describe('CLI browser smoke', () => {
  it('runs the compiled CLI with --adapter playwright and produces a complete artifact', async () => {
    await expect(fs.stat(cliPath), 'dist/cli/index.js is missing — run `npm run build` (npm run test:browser does)').resolves.toBeDefined();

    const run = await runCli([
      cliPath,
      'run',
      fixture,
      '--adapter',
      'playwright',
      '--reasoner',
      'scripted',
      '--observer-reasoner',
      'scripted',
      '--out',
      outDir,
    ]);
    expect(run.stderr, `CLI failed: ${run.stderr}`).toBe('');
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^run=\S+$/m);
    expect(run.stdout).toMatch(/^artifact=\S+$/m);

    const runId = /^run=(.+)$/m.exec(run.stdout)?.[1]?.trim() ?? '';
    expect(runId).not.toBe('');
    const runDir = path.join(outDir, runId);

    const result = JSON.parse(await fs.readFile(path.join(runDir, 'result.json'), 'utf8')) as {
      terminationReasons: Record<string, string>;
      participants: Array<{ participantId: string; selfReport: { participantId: string; capturedAt: string } }>;
      observer: { capturedAt: string };
      evidence: { runtimeErrors: unknown[] };
    };
    // The gate: every participant really finished. A browser that failed
    // to reach the page would show `error` here.
    for (const [id, reason] of Object.entries(result.terminationReasons)) {
      expect(reason, `participant ${id} ended as ${reason}`).toBe('finish');
    }
    expect(result.evidence.runtimeErrors).toEqual([]);
    expect(result.observer.capturedAt).not.toBe('');
    for (const p of result.participants) {
      expect(p.selfReport.participantId).toBe(p.participantId);
    }

    for (const name of ['manifest.json', 'participants.json', 'events.ndjson', 'observer-report.json', 'summary.md']) {
      await expect(fs.stat(path.join(runDir, name))).resolves.toBeDefined();
    }

    // --- the scripted coordinates still address the real controls ----
    const eventsRaw = await fs.readFile(path.join(runDir, 'events.ndjson'), 'utf8');
    const events = eventsRaw.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const notes = events
      .filter((e) => e['type'] === 'action.result')
      .map((e) => ((e['result'] as { note?: string } | undefined)?.note ?? ''));
    expect(notes.some((n) => /clicked <input[^>]*> at \(97, 178\)/.test(n)), `no click landed on the task input: ${JSON.stringify(notes)}`).toBe(true);
    expect(notes.some((n) => /clicked <button[^>]*> at \(212, 178\)/.test(n)), `no click landed on the Add button: ${JSON.stringify(notes)}`).toBe(true);
    expect(notes.some((n) => /typed 8 chars into <input>/.test(n))).toBe(true);

    // --- the typed text really became a task in the demo app ---------
    for (const p of Object.keys(result.terminationReasons)) {
      const obsDir = path.join(runDir, 'observations', p);
      const files = (await fs.readdir(obsDir)).filter((f) => f.endsWith('.json')).sort();
      expect(files.length).toBeGreaterThan(0);
      const texts: string[] = [];
      for (const file of files) {
        const raw = await fs.readFile(path.join(obsDir, file), 'utf8');
        const observation = JSON.parse(raw) as {
          visual: { width: number; height: number; visibleText: string; screenshotHash?: string };
          screenshot?: { path: string; sha256: string; byteLength: number };
        };
        texts.push(observation.visual.visibleText);
        expect(observation.visual.width).toBe(1280);
        expect(observation.visual.height).toBe(800);

        // Screenshots: real PNG bytes whose hash matches the record.
        const ref = observation.screenshot;
        expect(ref, `${file} has no screenshot reference`).toBeDefined();
        const png = await fs.readFile(path.join(runDir, ref?.path ?? ''));
        expect(Array.from(png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
        expect(png.byteLength).toBe(ref?.byteLength);
        expect(createHash('sha256').update(png).digest('hex')).toBe(ref?.sha256);
        expect(ref?.sha256).toBe(observation.visual.screenshotHash);

        // No binary inlining, no privileged material.
        expect(raw).not.toContain('__bytes');
        expect(raw).not.toContain('screenshotPng');
        expect(raw).not.toContain('data-uid');
        expect(raw).not.toMatch(/<(!doctype|html|body|input|button|form)/i);
      }
      const joined = texts.join('\n');
      const mine = TITLES[Object.keys(result.terminationReasons).indexOf(p)];
      expect(joined, `participant ${p} never saw its task in the list`).toContain(mine);
    }

    // --- the participant's own request payload stays unprivileged ----
    for (const e of events.filter((x) => x['type'] === 'reasoner.request')) {
      const payload = JSON.stringify(e);
      expect(payload).not.toContain('<');
      expect(payload).not.toContain('data-uid');
      const request = e['request'] as Record<string, unknown>;
      const allowed = ['systemPrompt', 'maxTokens', 'messages', 'systemPromptDigest', 'temperature'];
      expect(Object.keys(request).filter((k) => !allowed.includes(k))).toEqual([]);
    }
  }, 240_000);

  it('keeps the coordinates honest against the live demo layout', async () => {
    // Independent guard: the fixture's hardcoded coordinates must still
    // resolve to the task input and the Add button.
    const probes = await withIndependentPage(server.baseUrl, async (page) =>
      page.evaluate(() => {
        const at = (x: number, y: number): string => {
          const el = document.elementFromPoint(x, y);
          return el ? el.tagName.toLowerCase() : 'none';
        };
        return { input: at(97, 178), add: at(212, 178) };
      }),
    );
    expect(probes.input).toBe('input');
    expect(probes.add).toBe('button');
  }, 60_000);
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
