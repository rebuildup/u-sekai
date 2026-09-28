/**
 * End-to-end: the CLI must report a run whose participants failed, instead
 * of exiting 0. The compiled CLI is driven as a child process so the exit
 * code under test is the real process exit code, not a re-implementation of
 * it.
 *
 * Determinism without external services:
 *
 * - adapter failure: a local HTTP server that answers every request with
 *   `500`, so `HttpAdapter.open` fails with a message this repository owns
 *   (`http adapter open failed (500) for <url>`);
 * - Reasoner failure: the same local server is pointed at by
 *   `ANTHROPIC_BASE_URL` with a dummy key, so the provider adapter fails
 *   locally. No credential and no external network are involved.
 *
 * The Reasoner-failure assertions are deliberately written against terminal
 * reasons and evidence *shape* only. The terminal reason produced by a
 * Reasoner failure is allowed to change (0.2.0 introduces a dedicated
 * `reasonerFailure` reason); what must not change is that the run exits
 * non-zero and records a diagnostic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const cliPath = path.join(root, 'dist', 'cli', 'index.js');
const taskTrackerFixture = path.join(root, 'test', 'fixtures', 'experiment.task-tracker.json');
const outDir = path.join(root, 'test', '.tmp', 'e2e-failure-reporting');
/** Marker served by the local failing server; greppable in the artifact. */
const PROVIDER_FAILURE_MARKER = 'u-sekai-test-provider-failure-marker';

interface FailingServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

let failingServer: FailingServer | null = null;

beforeEach(async () => {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  failingServer = await startAlwaysFailingServer();
});

afterEach(async () => {
  await failingServer?.close();
  failingServer = null;
});

describe('e2e: a failed participant run is reported, not reported as success', () => {
  it('exits 2 and persists the diagnostic when every participant hits an adapter runtime failure', async () => {
    const experimentPath = await writeExperiment('adapter-failure', {
      environment: { kind: 'http', url: `${failingServer!.baseUrl}/` },
    });

    const out = await runCli([
      cliPath, 'run', experimentPath,
      '--adapter', 'http',
      '--reasoner', 'scripted',
      '--observer-reasoner', 'scripted',
      '--out', outDir,
    ]);

    expect(out.code).toBe(2);

    // stderr is actionable: which participants, which reason, where to look.
    expect(out.stderr).toContain('p-visual-short-memory: error');
    expect(out.stderr).toContain('p-full-history: error');
    expect(out.stderr).toContain('result.json');

    const runDir = await latestRunDir(outDir);
    const resultRaw = await fs.readFile(path.join(runDir, 'result.json'), 'utf8');
    const result = JSON.parse(resultRaw) as {
      terminationReasons: Record<string, string>;
      evidence: { runtimeErrors: Array<{ ts: string; where: string; message: string }> };
    };
    for (const id of Object.keys(result.terminationReasons)) {
      expect(result.terminationReasons[id]).toBe('error');
    }
    expect(result.evidence.runtimeErrors).toHaveLength(2);
    for (const entry of result.evidence.runtimeErrors) {
      expect(entry.where).toMatch(/^participant=p-/);
      expect(entry.message).toContain('http adapter open failed (500)');
      expect(entry.ts).not.toBe('');
    }

    // The diagnostic must be findable in the written artifact, not only in
    // the process output.
    expect(resultRaw).toContain('http adapter open failed (500)');
    const summaryRaw = await fs.readFile(path.join(runDir, 'summary.md'), 'utf8');
    expect(summaryRaw).toContain('http adapter open failed (500)');
    expect(summaryRaw).toMatch(/- Participant p-visual-short-memory: terminated \(error\) -- /);
  }, 60_000);

  it('exits 2 and still writes an artifact when every participant hits a Reasoner failure', async () => {
    const out = await runCli(
      [
        cliPath, 'run', taskTrackerFixture,
        '--adapter', 'http',
        '--reasoner', 'anthropic',
        '--observer-reasoner', 'scripted',
        '--out', outDir,
      ],
      { ANTHROPIC_API_KEY: 'dummy-key-not-used', ANTHROPIC_BASE_URL: failingServer!.baseUrl },
    );

    expect(out.code).toBe(2);
    expect(out.stderr).toContain('p-visual-short-memory');
    expect(out.stderr).toContain('p-full-history');

    const runDir = await latestRunDir(outDir);
    const result = JSON.parse(await fs.readFile(path.join(runDir, 'result.json'), 'utf8')) as {
      terminationReasons: Record<string, string>;
      evidence: { runtimeErrors: Array<{ where: string; message: string }> };
    };
    // Shape, not the concrete reason string: 0.2.0 gives this its own
    // terminal reason, and this assertion must hold before and after that.
    for (const id of Object.keys(result.terminationReasons)) {
      expect(['finish', 'stepBudgetExceeded']).not.toContain(result.terminationReasons[id]);
    }
    expect(result.evidence.runtimeErrors).toHaveLength(2);
    for (const entry of result.evidence.runtimeErrors) {
      expect(entry.where).toMatch(/^participant=p-/);
      expect(entry.message).not.toBe('');
    }
  }, 60_000);

  it('exits 2 for a mixed run where one participant finished and another failed', async () => {
    // The first participant stays scripted and finishes; the second one is
    // pointed at the local failing provider.
    const experimentPath = await writeExperiment('mixed', { p2Provider: 'anthropic' });

    const out = await runCli(
      [
        cliPath, 'run', experimentPath,
        '--adapter', 'http',
        '--out', outDir,
      ],
      { ANTHROPIC_API_KEY: 'dummy-key-not-used', ANTHROPIC_BASE_URL: failingServer!.baseUrl },
    );

    expect(out.code).toBe(2);

    const runDir = await latestRunDir(outDir);
    const result = JSON.parse(await fs.readFile(path.join(runDir, 'result.json'), 'utf8')) as {
      terminationReasons: Record<string, string>;
    };
    expect(result.terminationReasons['p-visual-short-memory']).toBe('finish');
    expect(['finish', 'stepBudgetExceeded']).not.toContain(result.terminationReasons['p-full-history']);
  }, 60_000);

  it('still exits 0 with an empty runtimeErrors for a clean run', async () => {
    const out = await runCli([
      cliPath, 'run', taskTrackerFixture,
      '--adapter', 'http',
      '--reasoner', 'scripted',
      '--observer-reasoner', 'scripted',
      '--out', outDir,
    ]);

    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');

    const runDir = await latestRunDir(outDir);
    const resultRaw = await fs.readFile(path.join(runDir, 'result.json'), 'utf8');
    const result = JSON.parse(resultRaw) as {
      terminationReasons: Record<string, string>;
      evidence: { runtimeErrors: unknown[] };
    };
    for (const id of Object.keys(result.terminationReasons)) {
      expect(['finish', 'stepBudgetExceeded']).toContain(result.terminationReasons[id]);
    }
    expect(result.evidence.runtimeErrors).toEqual([]);
    expect(resultRaw).not.toContain('runtime failure');
  }, 60_000);
});

interface ExperimentTweaks {
  /** Target environment; omitted keeps the fixture's in-repo demo app. */
  readonly environment?: { kind: 'http'; url: string };
  /**
   * Reasoner provider of the second participant. Default `scripted`, so the
   * failure under test comes from the target, not from the provider.
   */
  readonly p2Provider?: 'scripted' | 'anthropic';
}

/** Derive a runnable experiment from the shipped fixture. */
async function writeExperiment(
  name: string,
  { environment, p2Provider = 'scripted' }: ExperimentTweaks = {},
): Promise<string> {
  const base = JSON.parse(await fs.readFile(taskTrackerFixture, 'utf8')) as {
    id: string;
    environment: unknown;
    seed: string;
    participants: Array<{ id: string; reasoner: { provider: string; seed?: string } }>;
  };
  const experimentPath = path.join(outDir, `experiment.${name}.json`);
  const experiment = {
    ...base,
    id: `e2e-${name}`,
    seed: `e2e-${name}`,
    ...(environment !== undefined ? { environment } : {}),
    participants: base.participants.map((p, i) => ({
      ...p,
      reasoner: i === 1
        ? { provider: p2Provider, ...(p2Provider === 'scripted' ? { seed: 'beta' } : {}) }
        : p.reasoner,
    })),
  };
  await fs.writeFile(experimentPath, JSON.stringify(experiment, null, 2), 'utf8');
  return experimentPath;
}

async function latestRunDir(dir: string): Promise<string> {
  const entries = await fs.readdir(dir);
  const runId = entries.find((e) => e.includes('-') && !e.startsWith('experiment.'));
  expect(runId, `no run directory under ${dir}: ${entries.join(', ')}`).toBeDefined();
  return path.join(dir, runId as string);
}

async function startAlwaysFailingServer(): Promise<FailingServer> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(PROVIDER_FAILURE_MARKER);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

function runCli(
  command: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, command, {
      cwd: root,
      env: { ...process.env, ...env },
    });
    const chunks: Buffer[] = [];
    const errs: Buffer[] = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => errs.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: code ?? 0,
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr: Buffer.concat(errs).toString('utf8'),
      });
    });
  });
}
