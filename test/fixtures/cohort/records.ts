/**
 * Byte-level fixtures: records as they actually sit on disk.
 *
 * A durability test that only ever round-trips a record through the
 * current code proves nothing about durability — it would pass just as
 * happily against a store that cannot read anything it did not write in
 * the same process. These helpers let a test take a real record, edit
 * its *bytes* the way a different release would have, and re-read it.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { FileRecordStore, type DurableRecordKind } from '../../../src/cohort/index.js';

export function storeFor(dir: string): FileRecordStore {
  return new FileRecordStore({ rootDir: dir });
}

export function recordPath(dir: string, kind: DurableRecordKind, key: string): string {
  return storeFor(dir).filePath(kind, key);
}

export async function readRawRecord(
  dir: string,
  kind: DurableRecordKind,
  key: string,
): Promise<string> {
  return fs.readFile(recordPath(dir, kind, key), 'utf8');
}

export async function writeRawRecord(
  dir: string,
  kind: DurableRecordKind,
  key: string,
  text: string,
): Promise<void> {
  const target = recordPath(dir, kind, key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text, 'utf8');
}

/** Read, edit and rewrite one envelope field, preserving the rest. */
export async function patchRecord(
  dir: string,
  kind: DurableRecordKind,
  key: string,
  patch: (record: Record<string, unknown>) => Record<string, unknown>,
): Promise<string> {
  const current = JSON.parse(await readRawRecord(dir, kind, key)) as Record<string, unknown>;
  const next = patch(current);
  const text = JSON.stringify(next);
  await writeRawRecord(dir, kind, key, text);
  return text;
}

/**
 * Add a field to the *payload* only, as a hypothetical later release
 * would when it adds an attribute.
 */
export async function addPayloadField(
  dir: string,
  kind: DurableRecordKind,
  key: string,
  field: string,
  value: unknown,
): Promise<string> {
  return patchRecord(dir, kind, key, (record) => {
    const payload = { ...(record['payload'] as Record<string, unknown>) };
    payload[field] = value;
    return { ...record, payload };
  });
}

/** Set the envelope's declared schema version. */
export async function setSchemaVersion(
  dir: string,
  kind: DurableRecordKind,
  key: string,
  version: number,
): Promise<string> {
  return patchRecord(dir, kind, key, (record) => ({ ...record, schemaVersion: version }));
}

/** Every file the store has written, as paths relative to `dir`. */
export async function listStoreFiles(dir: string): Promise<ReadonlyArray<string>> {
  const out: string[] = [];
  for (const kind of ['identity', 'cohort'] as const) {
    const kindDir = path.join(dir, kind);
    let names: string[];
    try {
      names = await fs.readdir(kindDir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      out.push(path.posix.join(kind, name));
    }
  }
  return out;
}
