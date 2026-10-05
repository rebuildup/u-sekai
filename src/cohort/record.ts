/**
 * The durable record envelope (ADR-0011, issue #60).
 *
 * ## The key is the whole point
 *
 * Every record is filed under a `key` that is derived *only* from a
 * durable identity declared in configuration — `idn-…`, `coh-…`, or an
 * opaque `stateRef`. It is deliberately **not** derived from:
 *
 * - an `EvaluationRunId` (a per-run handle, new on every execution),
 * - a build / commit / release identifier,
 * - a wall-clock timestamp,
 * - the schema version.
 *
 * #57's `ids.ts` is what makes this stable rather than merely intended:
 * there is no `generateProductId()` / `newCohortId()` anywhere in the
 * domain, so a new release *cannot* mint a replacement id for an existing
 * identity — it can only re-read the one that was declared. A key that
 * included a build hash or a run id would turn "persist across releases"
 * into "persist until the next run", which is the failure mode this
 * module is written to make impossible.
 *
 * ## Two different strictness rules, on purpose
 *
 * The envelope is validated **strictly**: an unmodelled key on the
 * envelope, a missing `key`, or a non-integer `schemaVersion` is
 * corruption, and corruption must be loud (see `errors.ts`).
 *
 * The **payload** is validated **tolerantly**: keys this build does not
 * know are ignored rather than rejected. That is the difference between
 * a declaration (where #57's `rejectUnknownKeys` catches a typo at the
 * boundary) and a stored record (where the next release adds a field and
 * every older record must still load). `projectDeclaredKeys` implements
 * that by down-projecting the stored payload to exactly the keys #57
 * declares, then handing those to #57's own `parse*` — so every
 * invariant #57 enforces still runs, and none of its contract is
 * re-implemented here.
 *
 * ## Migrations are explicit, never implicit
 *
 * A record written at version N is brought to the current version by a
 * registered chain of single-step migrations. If a step is missing the
 * read fails with `missing_migration`. There is no "best effort" path:
 * a silently un-migrated record would re-enter the domain and either
 * violate an invariant or, worse, be re-saved in a shape that silently
 * dropped fields.
 */

import { CohortStateError } from './errors.js';

/** Record kinds this store persists. Adding one is a schema change. */
export const DURABLE_RECORD_KINDS = ['identity', 'cohort'] as const;
export type DurableRecordKind = (typeof DURABLE_RECORD_KINDS)[number];

/**
 * Current on-disk schema version for both record kinds.
 *
 * 0.4.0 writes version 1. The first additive field in 0.5.0 becomes
 * version 2 plus a registered `v1 -> v2` migration — never a silent
 * reinterpretation of version-1 bytes.
 */
export const DURABLE_RECORD_SCHEMA_VERSION = 1;

const RECORD_FIELDS = ['schemaVersion', 'kind', 'key', 'revision', 'updatedAt', 'payload'] as const;

/**
 * The stored envelope.
 *
 * `payload` is `unknown` on purpose: the envelope layer does not know
 * the shape of a cohort or an identity, and must not be able to
 * accidentally impose one. `parseDurableRecord` hands it to the caller
 * unchanged.
 */
export interface DurableRecord {
  readonly schemaVersion: number;
  readonly kind: DurableRecordKind;
  /** Cross-release-stable identity of this record. See the module docstring. */
  readonly key: string;
  /**
   * Monotonic per key, starting at 1. Lets a caller detect a lost
   * concurrent write without a full compare-and-swap implementation.
   */
  readonly revision: number;
  /** ISO-8601 instant with an explicit offset. Informational only. */
  readonly updatedAt: string;
  readonly payload: unknown;
}

/** One single-step upgrade of a stored payload. */
export interface RecordMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  /**
   * Upgrade a stored payload by exactly one version.
   *
   * Receives and returns a *record* payload object. Must be pure: it is
   * run on every read, including reads by a later release, so it must not
   * depend on the current process state or on the clock.
   */
  migrate(payload: Record<string, unknown>, kind: DurableRecordKind): Record<string, unknown>;
}

export function isDurableRecordKind(value: unknown): value is DurableRecordKind {
  return typeof value === 'string' && (DURABLE_RECORD_KINDS as readonly string[]).includes(value);
}

/**
 * Build a new envelope for storage.
 *
 * Callers supply `revision`; the store does not invent one, so that a
 * caller performing a read-modify-write can pass the revision it read and
 * have a stale write be visible rather than silently overwriting.
 */
export function buildDurableRecord(input: {
  readonly kind: DurableRecordKind;
  readonly key: string;
  readonly payload: unknown;
  readonly revision: number;
  readonly updatedAt: string;
  readonly schemaVersion?: number;
}): DurableRecord {
  return Object.freeze({
    schemaVersion: input.schemaVersion ?? DURABLE_RECORD_SCHEMA_VERSION,
    kind: input.kind,
    key: input.key,
    revision: input.revision,
    updatedAt: input.updatedAt,
    payload: input.payload,
  });
}

/**
 * Parse stored bytes into an envelope, applying migrations.
 *
 * `text` is the raw stored document. Anything that is not a well-formed
 * envelope is `corrupt_record`; a version this build cannot interpret is
 * `unsupported_schema_version`; an unbridgeable version gap is
 * `missing_migration`. All three throw — none returns a default.
 */
export function parseDurableRecord(
  text: string,
  kind: DurableRecordKind,
  migrations: readonly RecordMigration[] = [],
): DurableRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new CohortStateError(
      'corrupt_record',
      `stored ${kind} record is not valid JSON`,
      `${kind}.record`,
      { reason: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CohortStateError(
      'corrupt_record',
      `stored ${kind} record must be a JSON object`,
      `${kind}.record`,
      { received: parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed },
    );
  }
  const raw = parsed as Record<string, unknown>;

  // Strict: an unmodelled envelope key means the bytes are not what this
  // build writes, which is corruption rather than a newer record.
  const unknownEnvelopeKeys = Object.keys(raw)
    .filter((k) => !(RECORD_FIELDS as readonly string[]).includes(k))
    .sort();
  if (unknownEnvelopeKeys.length > 0) {
    throw new CohortStateError(
      'corrupt_record',
      `stored ${kind} record has unknown envelope field(s): ${unknownEnvelopeKeys.join(', ')}`,
      `${kind}.record`,
      { unknownEnvelopeKeys, allowed: [...RECORD_FIELDS] },
    );
  }

  const storedKind = raw['kind'];
  if (!isDurableRecordKind(storedKind)) {
    throw new CohortStateError(
      'unknown_record_kind',
      `stored record kind must be one of: ${DURABLE_RECORD_KINDS.join(', ')}`,
      `${kind}.record.kind`,
      { received: storedKind },
    );
  }
  if (storedKind !== kind) {
    throw new CohortStateError(
      'key_mismatch',
      `expected a ${kind} record but the stored record is a ${storedKind}`,
      `${kind}.record.kind`,
      { expected: kind, actual: storedKind },
    );
  }

  const key = requireKey(raw['key'], `${kind}.record.key`);
  const revision = raw['revision'];
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    throw new CohortStateError(
      'corrupt_record',
      `stored ${kind} record revision must be an integer >= 1`,
      `${kind}.record.revision`,
      { received: revision },
    );
  }
  const updatedAt = raw['updatedAt'];
  if (typeof updatedAt !== 'string' || updatedAt === '') {
    throw new CohortStateError(
      'corrupt_record',
      `stored ${kind} record updatedAt must be a non-empty string`,
      `${kind}.record.updatedAt`,
      { received: updatedAt },
    );
  }
  if (typeof raw['payload'] !== 'object' || raw['payload'] === null || Array.isArray(raw['payload'])) {
    throw new CohortStateError(
      'corrupt_record',
      `stored ${kind} record payload must be a JSON object`,
      `${kind}.record.payload`,
      { received: raw['payload'] === null ? 'null' : Array.isArray(raw['payload']) ? 'array' : typeof raw['payload'] },
    );
  }

  const { schemaVersion, payload } = upgradePayload(
    raw['schemaVersion'],
    raw['payload'] as Record<string, unknown>,
    kind,
    key,
    migrations,
  );

  return Object.freeze({ schemaVersion, kind, key, revision, updatedAt, payload });
}

/**
 * Bring a stored payload up to `toVersion`.
 *
 * A stored version *newer* than this build is refused rather than
 * guessed at: a 0.5.0 field may carry meaning 0.4.0 cannot honour, and
 * re-saving it under version 1 would erase it.
 *
 * Exported so the chain-walking behaviour can be tested directly. On its
 * own it is a pure function of its arguments; `parseDurableRecord` calls
 * it with {@link DURABLE_RECORD_SCHEMA_VERSION}.
 */
export function applyMigrationChain(input: {
  readonly storedVersion: number;
  readonly targetVersion: number;
  readonly payload: Record<string, unknown>;
  readonly kind: DurableRecordKind;
  readonly key: string;
  readonly migrations: readonly RecordMigration[];
}): Record<string, unknown> {
  const { storedVersion, targetVersion, kind, key, migrations } = input;
  if (!Number.isInteger(storedVersion) || storedVersion < 1) {
    throw new CohortStateError(
      'corrupt_record',
      `stored ${kind} record schemaVersion must be an integer >= 1`,
      `${kind}.record.schemaVersion`,
      { received: storedVersion },
    );
  }
  if (storedVersion > targetVersion) {
    throw new CohortStateError(
      'unsupported_schema_version',
      `stored ${kind} record ${key} is at schema version ${storedVersion}, but this build reads at most ${targetVersion}; upgrade the build rather than rewriting the record`,
      `${kind}.record.schemaVersion`,
      { key, storedVersion, supportedVersion: targetVersion },
    );
  }

  let version = storedVersion;
  let current = input.payload;
  while (version < targetVersion) {
    const step = migrations.find((m) => m.fromVersion === version && m.toVersion === version + 1);
    if (step === undefined) {
      throw new CohortStateError(
        'missing_migration',
        `no migration registered from schema version ${version} to ${version + 1} for ${kind} record ${key}`,
        `${kind}.record.schemaVersion`,
        {
          key,
          fromVersion: version,
          toVersion: version + 1,
          registered: migrations.map((m) => `${m.fromVersion}->${m.toVersion}`),
        },
      );
    }
    current = step.migrate(current, kind);
    version = step.toVersion;
  }
  return current;
}

/**
 * Validate and migrate the envelope fields of a stored document.
 *
 * Envelope validation is strict; payload interpretation belongs to the
 * caller.
 */
function upgradePayload(
  storedVersionRaw: unknown,
  payload: Record<string, unknown>,
  kind: DurableRecordKind,
  key: string,
  migrations: readonly RecordMigration[],
): { schemaVersion: number; payload: Record<string, unknown> } {
  if (
    typeof storedVersionRaw !== 'number' ||
    !Number.isInteger(storedVersionRaw) ||
    storedVersionRaw < 1
  ) {
    throw new CohortStateError(
      'corrupt_record',
      `stored ${kind} record schemaVersion must be an integer >= 1`,
      `${kind}.record.schemaVersion`,
      { received: storedVersionRaw },
    );
  }
  return {
    schemaVersion: storedVersionRaw,
    payload: applyMigrationChain({
      storedVersion: storedVersionRaw,
      targetVersion: DURABLE_RECORD_SCHEMA_VERSION,
      payload,
      kind,
      key,
      migrations,
    }),
  };
}

/**
 * Down-project a stored payload to the keys a declaration parser knows.
 *
 * This is the forward-compatibility hinge. A record written by 0.5.0
 * with an extra key still loads under 0.4.0: the extra key is dropped
 * *for the purpose of validating the #57 entity*, and the declared
 * subset is then handed to #57's own parser, so every invariant #57
 * enforces (lifecycle/retention agreement, `stateRef` presence, cohort
 * membership shape) is still enforced here.
 *
 * Note what is **not** dropped: a key the *current* build declares but
 * finds malformed is still an error. Only genuinely unmodelled keys are
 * tolerated.
 */
export function projectDeclaredKeys(
  payload: Record<string, unknown>,
  declared: readonly string[],
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of declared) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      projected[field] = payload[field];
    }
  }
  return projected;
}

/**
 * The cross-release-stable key for a record.
 *
 * Exported so a caller (and a test) can assert that the key depends only
 * on the durable identity — never on a run id, a timestamp or a build.
 */
export function durableRecordKey(kind: DurableRecordKind, id: string): string {
  return `${kind}:${id}`;
}

function requireKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new CohortStateError(
      'corrupt_record',
      `stored record key must be a non-empty string`,
      field,
      { received: value },
    );
  }
  return value;
}
