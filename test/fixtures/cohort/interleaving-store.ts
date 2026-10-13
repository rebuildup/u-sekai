/**
 * `RecordStore` wrappers that let a test *arrange* a race instead of
 * racing for one.
 *
 * ## Why a test needs this rather than two `await`s
 *
 * `CohortStateService` reads the record more than once per mutating
 * call: the public method loads it, and `put` re-reads it before
 * writing. Those reads and the write are all `await`ed, so a race *is*
 * reachable with ordinary concurrency — but reproducing it by timing is
 * a flaky test, and a flaky concurrency test is worse than none,
 * because a reviewer learns to re-run it instead of read it.
 *
 * So the race is staged. `InterleavingStore` runs a competing commit at
 * the exact point it matters, which is what lets a test assert on the
 * window a check-then-write guard exists to close rather than on a
 * timing coincidence.
 *
 * ## The competing writer uses a *different* gate over shared bytes
 *
 * Arming two writers against one gated store would recurse — the
 * competing commit's own `write` would fire the hook again. So writers
 * get separate `InterleavingStore` instances over one shared inner
 * store, and only the armed one is gated. Both still see the same bytes,
 * which is the point: a store that cannot see another writer's commit is
 * not modelling the shared state the guard is about.
 */

import type { DurableRecordKind, RecordStore } from '../../../src/cohort/index.js';

export class InterleavingStore implements RecordStore {
  private writeHook: (() => Promise<void>) | null = null;
  private readHook: { readonly afterReads: number; readonly commit: () => Promise<void> } | null = null;
  private reads = 0;

  /**
   * @param inner Shared backing bytes. Every writer must use the *same*
   *   instance, or they are not competing for the same record.
   */
  constructor(private readonly inner: RecordStore) {}

  /**
   * Run `commit` immediately before this store's next `write` lands.
   *
   * One-shot: disarms as it fires, so a hook cannot loop.
   */
  armBeforeWrite(commit: () => Promise<void>): void {
    this.writeHook = commit;
  }

  /**
   * Run `commit` before the (`afterReads` + 1)-th `read`.
   *
   * This is how the window *between* a method's own load and `put`'s
   * re-read is reached — the window in which the record can vanish, and
   * the one in which a competing writer can move the revision.
   */
  armBeforeRead(commit: () => Promise<void>, afterReads = 0): void {
    this.readHook = { afterReads, commit };
  }

  get armed(): boolean {
    return this.writeHook !== null || this.readHook !== null;
  }

  async read(kind: DurableRecordKind, key: string): Promise<string | undefined> {
    this.reads += 1;
    const hook = this.readHook;
    if (hook !== null && this.reads > hook.afterReads) {
      this.readHook = null;
      await hook.commit();
    }
    return this.inner.read(kind, key);
  }

  async write(kind: DurableRecordKind, key: string, text: string): Promise<void> {
    const hook = this.writeHook;
    if (hook !== null) {
      this.writeHook = null;
      await hook();
    }
    await this.inner.write(kind, key, text);
  }

  async delete(kind: DurableRecordKind, key: string): Promise<boolean> {
    return this.inner.delete(kind, key);
  }

  async list(kind: DurableRecordKind): Promise<ReadonlyArray<string>> {
    return this.inner.list(kind);
  }
}

/**
 * Every revision a key has been stored at, oldest first, per writer.
 *
 * A concurrent-write defect is often invisible in the *final* state
 * whenever the payload happens to end up right. The revision trace is
 * what shows the mechanism: it records each commit's revision, so a
 * test can show that two writers both wrote revision N+1 — the counter
 * was fooled too, which is exactly why a check-then-write guard cannot
 * be made sound by reading revisions alone.
 */
export class RevisionTrace {
  private readonly entries: Array<{ readonly label: string; readonly revision: number }> = [];

  record(entry: { readonly label: string; readonly revision: number }): void {
    this.entries.push(entry);
  }

  get commits(): ReadonlyArray<{ readonly label: string; readonly revision: number }> {
    return this.entries;
  }

  get labels(): ReadonlyArray<string> {
    return this.entries.map((e) => e.label);
  }

  get text(): string {
    return this.entries.map((e) => `${e.label} wrote revision ${e.revision}`).join('; ');
  }
}

/** A `RecordStore` that records the revision of every write it accepts. */
export class TracingRecordStore implements RecordStore {
  readonly trace = new RevisionTrace();

  constructor(
    private readonly inner: RecordStore,
    private readonly label: string,
  ) {}

  async read(kind: DurableRecordKind, key: string): Promise<string | undefined> {
    return this.inner.read(kind, key);
  }

  async write(kind: DurableRecordKind, key: string, text: string): Promise<void> {
    const parsed = JSON.parse(text) as { readonly revision?: unknown };
    this.trace.record({
      label: this.label,
      revision: typeof parsed.revision === 'number' ? parsed.revision : Number.NaN,
    });
    await this.inner.write(kind, key, text);
  }

  async delete(kind: DurableRecordKind, key: string): Promise<boolean> {
    return this.inner.delete(kind, key);
  }

  async list(kind: DurableRecordKind): Promise<ReadonlyArray<string>> {
    return this.inner.list(kind);
  }
}
