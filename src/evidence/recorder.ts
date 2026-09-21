/**
 * Append-only event recorder. The recorder is the only writer allowed
 * for `events.ndjson`; the order of `append()` calls defines the order
 * in the artifact.
 */

import type { RunEvent } from '../domain/evidence.js';

export interface EvidenceRecorder {
  append(event: RunEvent): Promise<void>;
  snapshot(): Promise<ReadonlyArray<RunEvent>>;
  close(): Promise<void>;
}

export class InMemoryRecorder implements EvidenceRecorder {
  private events: RunEvent[] = [];

  async append(event: RunEvent): Promise<void> {
    this.events.push(event);
  }

  async snapshot(): Promise<ReadonlyArray<RunEvent>> {
    return [...this.events];
  }

  async close(): Promise<void> {
    /* nothing to flush */
  }
}

export class FileRecorder implements EvidenceRecorder {
  private buffer: RunEvent[] = [];
  private flushing = false;

  constructor(private readonly writer: (line: string) => Promise<void>) {
    /* nothing */
  }

  async append(event: RunEvent): Promise<void> {
    this.buffer.push(event);
    if (!this.flushing) {
      this.flushing = true;
      // Coalesce small bursts; flush once after the loop settles.
      setImmediate(() => {
        void this.flush();
      });
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      this.flushing = false;
      return;
    }
    const toWrite = this.buffer;
    this.buffer = [];
    const lines = toWrite.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await this.writer(lines);
    this.flushing = false;
  }

  async snapshot(): Promise<ReadonlyArray<RunEvent>> {
    await this.flush();
    return [...this.buffer];
  }

  async close(): Promise<void> {
    await this.flush();
  }
}

export function makeInMemoryRecorder(): InMemoryRecorder {
  return new InMemoryRecorder();
}

export const recorderHelpers = {
  /** Concatenates RunEvents into a deterministic string for hashing. */
  hash(events: ReadonlyArray<RunEvent>): string {
    return events.map((e) => `${e.type}@${e.ts}`).join('|');
  },
};
