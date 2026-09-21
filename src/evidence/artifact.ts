/**
 * On-disk artifact layout (ADR-0007).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { RunResult } from '../domain/result.js';
import type { RunEvent } from '../domain/evidence.js';
import type { ParticipantObservation } from '../domain/observation.js';

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

  async writeObservation(
    participantId: string,
    stepIndex: number,
    observation: ParticipantObservation,
  ): Promise<void> {
    const dir = this.path('observations', participantId);
    await fs.mkdir(dir, { recursive: true });
    await this.writeJson(path.join(dir, `step-${String(stepIndex).padStart(3, '0')}.json`), observation);
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

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { __bytes: Array.from(value) };
  }
  return value;
}

export const __testHelpers = { jsonReplacer };
