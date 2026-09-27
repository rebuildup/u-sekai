/**
 * On-disk artifact layout (ADR-0007, ADR-0009).
 *
 * Screenshots are written as real PNG files under
 * `screenshots/<participantId>/step-NNN.png`. The observation JSON
 * carries a stable artifact-relative reference plus the SHA-256 of the
 * exact bytes on disk, and the in-memory `visual.screenshotPng` buffer
 * is stripped before serialization: a 1280x800 PNG must never be
 * inlined as a JSON integer array.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { RunResult } from '../domain/result.js';
import type { RunEvent } from '../domain/evidence.js';
import type { ParticipantObservation } from '../domain/observation.js';
import { sha256Hex } from './hash.js';

/**
 * Pointer from an observation JSON to the screenshot file that belongs
 * to it. Relative to the run artifact root, POSIX separators.
 */
export interface ObservationScreenshotRef {
  /** e.g. `screenshots/p-visual-short-memory/step-001.png` */
  readonly path: string;
  /** SHA-256 (hex) of the exact PNG bytes at `path`. */
  readonly sha256: string;
  readonly byteLength: number;
}

export interface ArtifactIO {
  readonly rootDir: string;
  writeManifest(manifest: Record<string, unknown>): Promise<void>;
  writeParticipants(participants: Record<string, unknown>): Promise<void>;
  writeEvents(events: ReadonlyArray<RunEvent>): Promise<void>;
  writeObservation(participantId: string, stepIndex: number, observation: ParticipantObservation): Promise<void>;
  writeSelfReport(participantId: string, report: unknown): Promise<void>;
  writeObserverReport(report: unknown): Promise<void>;
  writeResult(result: RunResult): Promise<void>;
  writeSummary(summary: string): Promise<void>;
  finalize(): Promise<void>;
}

export interface FileArtifactIOOptions {
  readonly rootDir: string;
  readonly runId: string;
}

export class FileArtifactIO implements ArtifactIO {
  readonly rootDir: string;
  private eventsBuffer: string[] = [];

  constructor(opts: FileArtifactIOOptions) {
    this.rootDir = path.resolve(opts.rootDir, opts.runId);
    // runId drives the artifact subdirectory; not stored on the instance.
  }

  async writeManifest(manifest: Record<string, unknown>): Promise<void> {
    await this.writeJson(this.path('manifest.json'), manifest);
  }

  async writeParticipants(participants: Record<string, unknown>): Promise<void> {
    await this.writeJson(this.path('participants.json'), participants);
  }

  async writeEvents(events: ReadonlyArray<RunEvent>): Promise<void> {
    for (const e of events) {
      this.eventsBuffer.push(JSON.stringify(e));
    }
    await fs.writeFile(this.path('events.ndjson'), this.eventsBuffer.join('\n') + (this.eventsBuffer.length ? '\n' : ''), 'utf8');
  }

  /**
   * Writes `observations/<participantId>/step-NNN.json` and, when the
   * adapter captured a real screenshot, the matching PNG under
   * `screenshots/<participantId>/step-NNN.png` (ADR-0007 layout).
   */
  async writeObservation(
    participantId: string,
    stepIndex: number,
    observation: ParticipantObservation,
  ): Promise<void> {
    const fileName = `step-${String(stepIndex).padStart(3, '0')}`;
    const screenshot = await this.writeScreenshot(participantId, fileName, observation);
    // `screenshotPng` is an in-memory-only field on the domain type; the
    // serialized form keeps the hash and points at the PNG on disk.
    const { screenshotPng: _screenshotPng, ...visual } = observation.visual;
    const payload: Record<string, unknown> = { ...observation, visual };
    if (screenshot) payload['screenshot'] = screenshot;
    await this.writeJson(this.path('observations', participantId, `${fileName}.json`), payload);
  }

  private async writeScreenshot(
    participantId: string,
    fileName: string,
    observation: ParticipantObservation,
  ): Promise<ObservationScreenshotRef | null> {
    const png = observation.visual.screenshotPng;
    if (!png || png.byteLength === 0) return null;
    const relPath = `screenshots/${participantId}/${fileName}.png`;
    const target = this.path('screenshots', participantId, `${fileName}.png`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, png);
    return { path: relPath, sha256: sha256Hex(png), byteLength: png.byteLength };
  }

  async writeSelfReport(participantId: string, report: unknown): Promise<void> {
    await fs.mkdir(this.path('self-report'), { recursive: true });
    await this.writeJson(this.path('self-report', `${participantId}.json`), report);
  }

  async writeObserverReport(report: unknown): Promise<void> {
    await this.writeJson(this.path('observer-report.json'), report);
  }

  async writeResult(result: RunResult): Promise<void> {
    await this.writeJson(this.path('result.json'), result);
  }

  async writeSummary(summary: string): Promise<void> {
    await fs.writeFile(this.path('summary.md'), summary, 'utf8');
  }

  async finalize(): Promise<void> {
    // flush any pending buffers; flush is already done by `writeEvents`.
    // We fsync the events file before declaring the artifact closed.
    const eventsPath = this.path('events.ndjson');
    const handle = await fs.open(eventsPath, 'a');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private path(...parts: string[]): string {
    return path.join(this.rootDir, ...parts);
  }

  private async writeJson(p: string, value: unknown): Promise<void> {
    const dir = path.dirname(p);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(p, JSON.stringify(value, jsonReplacer, 2), 'utf8');
  }
}

/**
 * Refuses to serialize binary payloads. Silently inlining a PNG as a
 * JSON integer array produced multi-megabyte, unreadable artifacts, so
 * an accidental binary field is now a loud failure that points at the
 * correct mechanism (write the file, record a reference).
 */
function jsonReplacer(key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    throw new Error(
      `refusing to serialize binary Uint8Array at "${key || '<root>'}": ` +
        'write the bytes to their own file in the artifact tree and record a { path, sha256, byteLength } reference instead',
    );
  }
  return value;
}

export const __testHelpers = { jsonReplacer };
