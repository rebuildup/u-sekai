/**
 * A `RecordStore` that can park one reader mid-flight (Issue #92).
 *
 * ## Why a store-level gate rather than a sleep
 *
 * "Two concurrent `persistRun` calls" is not something a test can obtain
 * by starting two promises and awaiting them together. On a store whose
 * operations resolve without yielding to real I/O, the first call runs
 * to completion before the second one starts, so there is no
 * interleaving to observe and no conflict to detect. Adding a delay
 * would trade a deterministic test for a flaky one.
 *
 * What is needed is control over *when* a particular read completes, and
 * that is exactly a scheduling concern, which is where a store belongs.
 * The gate below decides **when a read resolves**; it decides nothing
 * about what is read or written. The revision arithmetic, the guard and
 * the write all run for real against a real `FileRecordStore`, so a test
 * that passes here is a statement about the product and not about a
 * stub.
 *
 * ## The two writers are two services, not one
 *
 * A shared service serialises through one object graph, which is not
 * what two evaluation processes do. Each writer therefore gets its own
 * `GatedRecordStore` over one shared inner store: two services that
 * share nothing but the bytes on disk. That is the same "fresh process"
 * shape `persistent-identity-retention` uses for its restart claim, and
 * it is the only shape in which a concurrency bug is honest.
 */

import type { DurableRecordKind, RecordStore } from '../../../../src/cohort/index.js';

export class GatedRecordStore implements RecordStore {
  private readCount = 0;
  private holdAt: number | undefined;
  private resumeHeld: (() => void) | undefined;
  private notify: Array<() => void> = [];

  constructor(private readonly inner: RecordStore) {}

  async read(kind: DurableRecordKind, key: string): Promise<string | undefined> {
    this.readCount += 1;
    const index = this.readCount;
    const waiting = this.notify;
    this.notify = [];
    for (const resolve of waiting) resolve();

    if (this.holdAt === index) {
      // Parked *before* the inner read, so the value this reader sees is
      // whatever is on disk when the test releases it. That is what makes
      // the interleaving real rather than replayed.
      await new Promise<void>((resolve) => {
        this.resumeHeld = resolve;
      });
    }
    return this.inner.read(kind, key);
  }

  write(kind: DurableRecordKind, key: string, text: string): Promise<void> {
    return this.inner.write(kind, key, text);
  }

  delete(kind: DurableRecordKind, key: string): Promise<boolean> {
    return this.inner.delete(kind, key);
  }

  list(kind: DurableRecordKind): Promise<ReadonlyArray<string>> {
    return this.inner.list(kind);
  }

  /** Resolve once `count` reads have been issued by this store. */
  async afterReads(count: number): Promise<void> {
    while (this.readCount < count) {
      await new Promise<void>((resolve) => this.notify.push(resolve));
    }
  }

  /**
   * Park the next read this store issues.
   *
   * Call it *after* `afterReads(1)` to get the interleaving a concurrency
   * test needs: the writer has already observed the record's revision,
   * and is now held while the other writer commits on top of it. Arming
   * it any earlier parks the observation itself, and the writer would
   * then correctly succeed against the newer revision — a different
   * scenario, not a lost update.
   */
  holdNextRead(): void {
    this.holdAt = this.readCount + 1;
  }

  /** Resolve once the held read has actually parked. */
  async held(): Promise<void> {
    while (this.resumeHeld === undefined) {
      await new Promise<void>((resolve) => this.notify.push(resolve));
    }
  }

  /** Let a parked read proceed. */
  release(): void {
    const resume = this.resumeHeld;
    this.resumeHeld = undefined;
    this.holdAt = undefined;
    resume?.();
  }
}
