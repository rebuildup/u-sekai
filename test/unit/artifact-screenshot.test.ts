/**
 * Artifact writer contract (ADR-0007 layout, ADR-0009 evidence rules).
 *
 * Runs in the default HTTP-only CI: no browser required, because the
 * writer is fed the observation an adapter produced, not the adapter
 * itself. The browser suite proves a real PNG reaches this writer; this
 * suite proves what the writer then does with it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileArtifactIO, __testHelpers } from '../../src/evidence/artifact.js';
import type { ParticipantObservation } from '../../src/domain/observation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', '.tmp', 'artifact-unit');

/** Smallest valid PNG: 1x1 transparent pixel. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let io: FileArtifactIO;

beforeEach(async () => {
  await fs.rm(outDir, { recursive: true, force: true });
  io = new FileArtifactIO({ rootDir: outDir, runId: 'unit-run' });
});

afterEach(async () => {
  await fs.rm(outDir, { recursive: true, force: true });
});

function observationWith(
  stepIndex: number,
  visual: Partial<ParticipantObservation['visual']>,
): ParticipantObservation {
  return {
    stepIndex,
    url: 'http://127.0.0.1:1234/',
    title: 'Task Tracker',
    capturedAt: '2026-09-27T00:00:00.000Z',
    visual: {
      width: 1280,
      height: 800,
      visibleText: 'Task Tracker Add a task',
      focused: null,
      ...visual,
    },
    interactiveRegions: [{ label: 'Add', bbox: { x: 192, y: 167, width: 41, height: 21 } }],
  };
}

describe('FileArtifactIO observation + screenshot persistence', () => {
  it('writes a real PNG under screenshots/ and records a verifiable reference', async () => {
    const bytes = new Uint8Array(PNG_1X1);
    const sha = createHash('sha256').update(bytes).digest('hex');
    await io.writeObservation('p-one', 1, observationWith(1, { screenshotPng: bytes, screenshotHash: sha }));

    const pngPath = path.join(outDir, 'unit-run', 'screenshots', 'p-one', 'step-001.png');
    const written = await fs.readFile(pngPath);
    expect(Array.from(written.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(written.byteLength).toBe(bytes.byteLength);

    const jsonPath = path.join(outDir, 'unit-run', 'observations', 'p-one', 'step-001.json');
    const raw = await fs.readFile(jsonPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      visual: { width: number; height: number; screenshotHash?: string; screenshotPng?: unknown };
      screenshot?: { path: string; sha256: string; byteLength: number };
    };

    // Stable artifact-relative reference, POSIX separators.
    expect(parsed.screenshot?.path).toBe('screenshots/p-one/step-001.png');
    // Content hash of the bytes actually on disk.
    expect(parsed.screenshot?.sha256).toBe(createHash('sha256').update(written).digest('hex'));
    expect(parsed.screenshot?.byteLength).toBe(written.byteLength);
    // The adapter-reported hash and the artifact hash agree.
    expect(parsed.screenshot?.sha256).toBe(parsed.visual.screenshotHash);
    // The buffer itself is never inlined.
    expect(parsed.visual.screenshotPng).toBeUndefined();
    expect(raw).not.toContain('__bytes');
    expect(raw).not.toContain('screenshotPng');
    // The rest of the observation survives untouched.
    expect(parsed.visual.width).toBe(1280);
    expect(parsed.visual.height).toBe(800);
  });

  it('writes no screenshot reference for an adapter that captured no pixels', async () => {
    await io.writeObservation('p-http', 3, observationWith(3, {}));

    const raw = await fs.readFile(
      path.join(outDir, 'unit-run', 'observations', 'p-http', 'step-003.json'),
      'utf8',
    );
    expect(raw).not.toContain('"screenshot"');
    expect(JSON.parse(raw)).toMatchObject({ stepIndex: 3, url: 'http://127.0.0.1:1234/' });
    // No empty screenshot tree is created either.
    expect(await fs.readdir(path.join(outDir, 'unit-run', 'screenshots')).catch(() => [])).toEqual([]);
  });

  it('zero-pads step numbers so the artifact sorts chronologically', async () => {
    await io.writeObservation('p-order', 2, observationWith(2, {}));
    await io.writeObservation('p-order', 10, observationWith(10, {}));
    const files = (await fs.readdir(path.join(outDir, 'unit-run', 'observations', 'p-order'))).sort();
    expect(files).toEqual(['step-002.json', 'step-010.json']);
  });

  it('refuses to serialize binary instead of inlining it as a JSON array', () => {
    const replacer = __testHelpers.jsonReplacer;
    expect(() => replacer('visual', new Uint8Array([1, 2, 3]))).toThrow(/refusing to serialize binary Uint8Array/);
    expect(() => JSON.stringify({ visual: { screenshotPng: new Uint8Array([1, 2, 3]) } }, replacer)).toThrow(
      /write the bytes to their own file/,
    );
    // Non-binary values pass through untouched.
    expect(replacer('title', 'Task Tracker')).toBe('Task Tracker');
  });

  it('keeps other artifact files free of binary payloads', async () => {
    await io.writeManifest({ runId: 'unit-run', nested: { a: [1, 2, 3] } });
    await io.writeResult({
      runId: 'unit-run',
      experimentPath: outDir,
      seed: 'unit',
      startedAt: '2026-09-27T00:00:00.000Z',
      endedAt: '2026-09-27T00:00:01.000Z',
      terminationReasons: { 'p-one': 'finish' },
      participants: [],
      observer: {
        capturedAt: '2026-09-27T00:00:01.000Z',
        summary: 'ok',
        findings: [],
        terminationVerdict: { declared: 'finish', plausible: true, note: 'unit' },
      },
      evidence: {
        runId: 'unit-run',
        startedAt: '2026-09-27T00:00:00.000Z',
        endedAt: '2026-09-27T00:00:01.000Z',
        durationMs: 1000,
        stepCountByParticipant: {},
        actionSequencesByParticipant: {},
        navigationsByParticipant: {},
        runtimeErrors: [],
        terminationReasonByParticipant: {},
        participantConfigurations: [],
        experimentSummaryHash: 'abc',
      },
    });
    await io.finalize();
    for (const name of ['manifest.json', 'result.json', 'events.ndjson']) {
      const raw = await fs.readFile(path.join(outDir, 'unit-run', name), 'utf8');
      expect(raw).not.toContain('__bytes');
    }
  });
});
