/**
 * File-backed `RecordStore` (ADR-0011, issue #60).
 *
 * ## Keys are never used as filenames
 *
 * #57's `IdentityStateRef` is validated against
 * `^[A-Za-z0-9][A-Za-z0-9._:@/-]*$`. That grammar permits `/` and `.`, so
 * it admits strings such as `a/../../etc/passwd` — the leading character
 * must be alphanumeric, but everything after it is unconstrained. A
 * store that joined such a key straight onto a root directory would
 * therefore be a path-traversal primitive, reachable with a value that
 * #57 considers perfectly valid.
 *
 * Rather than tighten #57's grammar (it is the durable contract other
 * tickets are written against) or sanitize-and-hope, this store derives
 * every filename from a SHA-256 of the key:
 *
 * ```text
 * <root>/<kind>/<slug>-<sha256(key)>.json
 * ```
 *
 * The slug is a cosmetic prefix built only from `[a-z0-9-]`, and the
 * hash makes it collision-free in practice. The real key is stored
 * *inside* the envelope, which is how `list()` recovers it. A traversal
 * attempt is consequently just an ordinary, harmless key.
 *
 * ## Durability of a single write
 *
 * Writes go to a temporary file in the same directory and are then
 * `rename`d over the target, which is atomic on POSIX within a
 * filesystem: a reader sees either the whole previous record or the whole
 * new one, never a truncated mixture. The data is not `fsync`ed — that
 * would cost a device flush per write, and the records here are small
 * configuration-scale documents. This store survives process exit and
 * machine reboot in the normal case; it does not claim to survive a
 * power loss that loses unsynced filesystem pages.
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { CohortStateError } from './errors.js';
import type { DurableRecordKind } from './record.js';
import type { RecordStore } from './store.js';

export interface FileRecordStoreOptions {
  /** Directory that will hold `<kind>/<file>.json` trees. Created on write. */
  readonly rootDir: string;
}

const FILE_SUFFIX = '.json';

export class FileRecordStore implements RecordStore {
  readonly rootDir: string;

  constructor(options: FileRecordStoreOptions) {
    if (typeof options.rootDir !== 'string' || options.rootDir.trim() === '') {
      throw new CohortStateError(
        'corrupt_record',
        'FileRecordStore requires a non-empty rootDir',
        'rootDir',
      );
    }
    this.rootDir = path.resolve(options.rootDir);
  }

  async read(kind: DurableRecordKind, key: string): Promise<string | undefined> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath(kind, key), 'utf8');
    } catch (cause) {
      if (isNotFound(cause)) return undefined;
      throw new CohortStateError(
        'corrupt_record',
        `failed to read ${kind} record ${key} from ${this.rootDir}`,
        `${kind}.record`,
        { key, reason: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    return text;
  }

  async write(kind: DurableRecordKind, key: string, text: string): Promise<void> {
    const target = this.filePath(kind, key);
    const dir = path.dirname(target);
    await fs.mkdir(dir, { recursive: true });
    // Same-directory temp file so the rename stays within one filesystem
    // and is therefore atomic.
    const tmp = path.join(dir, `.${path.basename(target)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(tmp, text, 'utf8');
      await fs.rename(tmp, target);
    } catch (cause) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw new CohortStateError(
        'corrupt_record',
        `failed to write ${kind} record ${key} to ${this.rootDir}`,
        `${kind}.record`,
        { key, reason: cause instanceof Error ? cause.message : String(cause) },
      );
    }
  }

  async delete(kind: DurableRecordKind, key: string): Promise<boolean> {
    try {
      await fs.unlink(this.filePath(kind, key));
      return true;
    } catch (cause) {
      if (isNotFound(cause)) return false;
      throw new CohortStateError(
        'corrupt_record',
        `failed to delete ${kind} record ${key} from ${this.rootDir}`,
        `${kind}.record`,
        { key, reason: cause instanceof Error ? cause.message : String(cause) },
      );
    }
  }

  /**
   * Recover keys by reading each file's envelope.
   *
   * Only the `key` field is needed, and it is read tolerantly so a record
   * written by a *later* schema version still lists. A file that cannot
   * yield a key is corruption and is raised, not skipped: silently
   * omitting it would make a corrupted identity disappear from a cohort
   * roll-up, which is the "silently creating a new identity" failure the
   * acceptance criteria forbid.
   */
  async list(kind: DurableRecordKind): Promise<ReadonlyArray<string>> {
    const dir = path.join(this.rootDir, kind);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (cause) {
      if (isNotFound(cause)) return [];
      throw new CohortStateError(
        'corrupt_record',
        `failed to list ${kind} records in ${dir}`,
        `${kind}.record`,
        { reason: cause instanceof Error ? cause.message : String(cause) },
      );
    }

    const keys: string[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(FILE_SUFFIX) || name.startsWith('.')) continue;
      const text = await fs.readFile(path.join(dir, name), 'utf8');
      keys.push(extractKey(text, kind, name));
    }
    return keys.sort();
  }

  /**
   * Absolute path of the file backing `key`.
   *
   * Exposed for diagnostics and for the traversal regression test; it is
   * a pure function of the key and performs no I/O.
   */
  filePath(kind: DurableRecordKind, key: string): string {
    return path.join(this.rootDir, kind, `${safeSlug(key)}-${sha256Hex(key)}${FILE_SUFFIX}`);
  }
}

/** SHA-256 (hex) of a UTF-8 string. Local so this module owns no dep. */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Cosmetic filename prefix.
 *
 * Every character outside `[a-z0-9]` becomes `-`, so the result can
 * contain neither a path separator nor a `.`. It is never the sole
 * discriminator: the hash is.
 */
function safeSlug(key: string): string {
  const lowered = key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return lowered.length > 0 ? lowered.slice(0, 40) : 'record';
}

function extractKey(text: string, kind: DurableRecordKind, fileName: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new CohortStateError(
      'corrupt_record',
      `stored ${kind} record file ${fileName} is not valid JSON`,
      `${kind}.record`,
      { fileName, reason: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CohortStateError(
      'corrupt_record',
      `stored ${kind} record file ${fileName} must be a JSON object`,
      `${kind}.record`,
      { fileName },
    );
  }
  const key = (parsed as Record<string, unknown>)['key'];
  if (typeof key !== 'string' || key === '') {
    throw new CohortStateError(
      'corrupt_record',
      `stored ${kind} record file ${fileName} has no usable key`,
      `${kind}.record.key`,
      { fileName },
    );
  }
  return key;
}

function isNotFound(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
