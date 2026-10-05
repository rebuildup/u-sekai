/**
 * The durable record store abstraction (ADR-0011, issue #60).
 *
 * ## The store is deliberately ignorant
 *
 * A `RecordStore` moves *opaque bytes* between a key and a slot. It knows
 * nothing about schema versions, migrations, cohorts, identities or
 * JSON. That is the point:
 *
 * - The schema lives in `record.ts` and is applied by `service.ts`, so a
 *   future store (SQL, object storage, a remote managed service) does not
 *   have to reimplement migration policy.
 * - "Corrupt JSON" is raised in exactly one place, by the service, so it
 *   cannot be handled inconsistently by two backends.
 * - The store can be exercised directly in a unit test with no filesystem,
 *   which is what makes the persistence *semantics* testable separately
 *   from the persistence *mechanism*.
 *
 * Returning the raw stored text (rather than a parsed value) is what
 * keeps this honest: a store that called `JSON.parse` would have to decide
 * what to do about malformed bytes, and that decision belongs to the
 * schema layer.
 *
 * ## Keys
 *
 * Keys are the cross-release-stable strings produced by
 * `durableRecordKey()` in `record.ts`. A store must treat them as opaque:
 * `FileRecordStore` deliberately does *not* use them as filenames, because
 * #57's `IdentityStateRef` grammar permits `/` and `.` (see the note
 * there).
 */

import type { DurableRecordKind } from './record.js';

export interface RecordStore {
  /** Raw stored text for `key`, or `undefined` when the key is absent. */
  read(kind: DurableRecordKind, key: string): Promise<string | undefined>;
  /** Create or replace the stored text for `key`. */
  write(kind: DurableRecordKind, key: string, text: string): Promise<void>;
  /** Remove `key`. Resolves to `false` when it was already absent. */
  delete(kind: DurableRecordKind, key: string): Promise<boolean>;
  /** Every key currently held for `kind`, in ascending order. */
  list(kind: DurableRecordKind): Promise<ReadonlyArray<string>>;
}

/**
 * In-memory `RecordStore`.
 *
 * Shipped as part of the module rather than as a test helper because the
 * issue asks for "a local durable store abstraction and file-backed MVP":
 * the abstraction is only real if a second implementation exists, and
 * this is the one that lets the file backend be proven to be a correct
 * implementation of the interface rather than the interface itself.
 */
export class InMemoryRecordStore implements RecordStore {
  private readonly data = new Map<string, Map<string, string>>();

  async read(kind: DurableRecordKind, key: string): Promise<string | undefined> {
    return this.bucket(kind).get(key);
  }

  async write(kind: DurableRecordKind, key: string, text: string): Promise<void> {
    this.bucket(kind).set(key, text);
  }

  async delete(kind: DurableRecordKind, key: string): Promise<boolean> {
    return this.bucket(kind).delete(key);
  }

  async list(kind: DurableRecordKind): Promise<ReadonlyArray<string>> {
    return [...this.bucket(kind).keys()].sort();
  }

  private bucket(kind: DurableRecordKind): Map<string, string> {
    let existing = this.data.get(kind);
    if (existing === undefined) {
      existing = new Map<string, string>();
      this.data.set(kind, existing);
    }
    return existing;
  }
}
