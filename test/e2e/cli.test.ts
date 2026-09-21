/**
 * End-to-end smoke: invoke the compiled CLI as a child process with the
 * task-tracker experiment fixture. The CLI will boot the demo server,
 * run the participant loop with the scripted reasoner, persist the
 * artifact tree, and exit 0.
 *
 * No external API keys. No browser binaries. Runs in CI.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const cliPath = path.join(root, 'dist', 'cli', 'index.js');
const fixture = path.join(root, 'test', 'fixtures', 'experiment.task-tracker.json');
const outDir = path.join(root, 'test', '.tmp', 'e2e');

describe('e2e: u-sekai run', () => {
  it('exits 0, persists an artifact tree, and ends each participant cleanly', async () => {
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.mkdir(outDir, { recursive: true });

    const out = await runCli([
      cliPath,
      'run',
      fixture,
      '--adapter',
      'http',
      '--reasoner',
      'scripted',
      '--observer-reasoner',
      'scripted',
      '--out',
      outDir,
    ]);
    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');

    const runDirs = await fs.readdir(outDir);
    expect(runDirs.length).toBeGreaterThanOrEqual(1);

    // An artifact directory exists for the run.
    const runId = runDirs.find((d) => d.startsWith('demo-0.1.0')) ?? runDirs[0]!;
    const runDir = path.join(outDir, runId);
    const manifestRaw = await fs.readFile(path.join(runDir, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
    expect(manifest.runId).toBe(runId);

    const resultRaw = await fs.readFile(path.join(runDir, 'result.json'), 'utf8');
    const result = JSON.parse(resultRaw) as { terminationReasons: Record<string, string>; evidence: { stepCountByParticipant: Record<string, number> } };
    expect(Object.keys(result.terminationReasons)).toHaveLength(2);

    const summaryRaw = await fs.readFile(path.join(runDir, 'summary.md'), 'utf8');
    expect(summaryRaw).toContain('Run ');
    expect(summaryRaw).toContain('Self-reports');

    const eventsRaw = await fs.readFile(path.join(runDir, 'events.ndjson'), 'utf8');
    const eventLines = eventsRaw.trim().split('\n');
    expect(eventLines.length).toBeGreaterThan(0);
    // at least one termination event per participant
    const terminations = eventLines
      .map((l) => JSON.parse(l) as { type: string; participantId?: string })
      .filter((e) => e.type === 'termination');
    expect(terminations.length).toBe(2);
  }, 60_000);

  it('prints version', async () => {
    const out = await runCli([cliPath, '--version']);
    expect(out.code).toBe(0);
    expect(out.stdout.trim()).toBe('0.1.0');
  });
});

function runCli(command: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, command, { cwd: root });
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
