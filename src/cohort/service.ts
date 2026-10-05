/**
 * `CohortStateService` — the durable store's public surface
 * (ADR-0011, issue #60).
 *
 * ## Where each concern lives
 *
 * ```text
 * service.ts   this file — orchestration, revisions, the public API
 * record.ts    envelope + schema version + migrations
 * store.ts     key <-> opaque bytes, no schema knowledge
 * file-store.ts the same, on disk
 * identity.ts  what an identity record means
 * cohort.ts    what a cohort record means, and how membership resolves
 * ```
 *
 * ## The load path is the deliverable
 *
 * A store that only *writes* satisfies "persists state" in a unit test
 * that never reads back. Every operation here is defined as
 * read-modify-write: the record is loaded from the store, the transition
 * applied, and the result stored under the **same** cross-release-stable
 * key. There is no code path that constructs a fresh id, which is what
 * makes "identity ids survive process restart" a structural property
 * rather than a convention — #57 provides no id *generator* to call.
 *
 * ## Corrupt state never degrades into a new identity
 *
 * `loadIdentity` on a missing id raises `identity_not_found`. It does not
 * mint a replacement, because a caller that silently received a fresh
 * identity would report a returning-user evaluation that never happened.
 * The same is true of a record whose bytes are damaged or whose schema
 * version is unbridgeable: every one of those raises.
 */

import type { SyntheticCohort, SyntheticIdentity, SyntheticIdentityId, CohortId } from '../product/index.js';
import { CohortStateError } from './errors.js';
import {
  buildDurableRecord,
  durableRecordKey,
  parseDurableRecord,
  type DurableRecord,
  type DurableRecordKind,
  type RecordMigration,
} from './record.js';
import type { RecordStore } from './store.js';
import {
  closeReleaseWindow,
  initialIdentityState,
  openReleaseWindow,
  parseIdentityState,
  recordObservation,
  resetRetainedState,
  retireIdentity as retireIdentityState,
  serializeIdentityState,
  touchRetainedState,
  type AccountRef,
  type EnvironmentObservation,
  type IdentityState,
  type RecordedObservation,
} from './identity.js';
import {
  canonicalJson,
  cohortDefinitionDigest,
  parseCohortState,
  resolveMembership,
  serializeCohortState,
  type CohortState,
  type ResolveOptions,
} from './cohort.js';

export interface CohortStateServiceOptions {
  readonly store: RecordStore;
  /** Registered single-step upgrades applied on every read. */
  readonly migrations?: readonly RecordMigration[];
  /** Injectable clock; defaults to the real one. Tests pass a fixed one. */
  readonly now?: () => string;
}

export interface SaveOptions {
  /**
   * Refuse the write unless the stored record is still at this revision.
   *
   * Omit for an unconditional write. Supplying it is how two concurrent
   * evaluators avoid silently overwriting each other's observations.
   */
  readonly expectedRevision?: number;
}

/**
 * How a value becomes a stored payload and back again.
 *
 * Holding both directions in one place is what lets the write path
 * verify a round-trip; see `put`.
 */
interface RecordCodec<T> {
  readonly serialize: (value: T) => Record<string, unknown>;
  readonly parse: (payload: unknown) => T;
}

const IDENTITY_CODEC: RecordCodec<IdentityState> = {
  serialize: serializeIdentityState,
  parse: parseIdentityState,
};

const COHORT_CODEC: RecordCodec<CohortState> = {
  serialize: serializeCohortState,
  parse: parseCohortState,
};

export class CohortStateService {
  private readonly store: RecordStore;
  private readonly migrations: readonly RecordMigration[];
  private readonly now: () => string;

  constructor(options: CohortStateServiceOptions) {
    this.store = options.store;
    this.migrations = options.migrations ?? [];
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /* ---------------------------------------------------------------------- */
  /* Identities                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Create an identity record, or return the one already stored.
   *
   * Idempotent for an *identical* declaration: redeclaring the same
   * identity returns the existing state untouched, so a configuration
   * reload cannot wipe an identity's accumulated history.
   *
   * A declaration that **differs** from the stored one is refused rather
   * than applied or ignored. Silently keeping the old one would mean an
   * edited persona or lifecycle never takes effect and the caller is told
   * nothing; silently applying it would let a lifecycle change strand the
   * retained state that #57's retention table promised.
   */
  async declareIdentity(
    identity: SyntheticIdentity,
    extra: { readonly accountRef?: AccountRef } = {},
  ): Promise<IdentityState> {
    const key = identityStateKey(identity.id);
    const existing = await this.tryLoadIdentity(identity.id);
    if (existing !== undefined) {
      if (canonicalJson(existing.identity) !== canonicalJson(identity)) {
        throw new CohortStateError(
          'already_exists',
          `identity ${identity.id} is already stored with a different declaration; its accumulated state is bound to the stored lifecycle, so amend the record explicitly rather than re-declaring it`,
          'identity',
          { identityId: identity.id },
        );
      }
      return existing;
    }

    const state: IdentityState = {
      ...initialIdentityState(identity),
      ...(extra.accountRef !== undefined ? { accountRef: extra.accountRef } : {}),
    };
    return this.put('identity', key, state, IDENTITY_CODEC);
  }

  /** Load an identity. Raises `identity_not_found` when absent. */
  async loadIdentity(id: SyntheticIdentityId): Promise<IdentityState> {
    const state = await this.tryLoadIdentity(id);
    if (state === undefined) {
      throw new CohortStateError(
        'identity_not_found',
        `no identity record for ${id} in this store; a missing identity is not replaced with a new one`,
        'identity.id',
        { identityId: id },
      );
    }
    return state;
  }

  async tryLoadIdentity(id: SyntheticIdentityId): Promise<IdentityState | undefined> {
    return this.load('identity', identityStateKey(id), (payload) => parseIdentityState(payload));
  }

  /** Every stored identity, ascending by id. */
  async loadAllIdentities(): Promise<ReadonlyArray<IdentityState>> {
    const keys = await this.store.list('identity');
    const states = await Promise.all(
      keys.map((key) => this.loadRequired('identity', key, (p) => parseIdentityState(p))),
    );
    return Object.freeze(
      states.sort((a, b) => (a.identity.id < b.identity.id ? -1 : a.identity.id > b.identity.id ? 1 : 0)),
    );
  }

  /** Append (or refresh) the observation for one run. */
  async recordRun(
    id: SyntheticIdentityId,
    observation: RecordedObservation,
    options: SaveOptions = {},
  ): Promise<IdentityState> {
    const state = await this.loadIdentity(id);
    return this.writeIdentity(recordObservation(state, observation), options);
  }

  /** Grow the identity's accumulation summary, if it retains state. */
  async touch(id: SyntheticIdentityId, at: string, options: SaveOptions = {}): Promise<IdentityState> {
    const state = await this.loadIdentity(id);
    return this.writeIdentity(touchRetainedState(state, { at }), options);
  }

  async openTransition(
    id: SyntheticIdentityId,
    input: { readonly fromVersion: string; readonly openedAt?: string },
  ): Promise<IdentityState> {
    const state = await this.loadIdentity(id);
    return this.writeIdentity(
      openReleaseWindow(state, {
        fromVersion: input.fromVersion,
        openedAt: input.openedAt ?? this.now(),
      }),
    );
  }

  /**
   * Close a release transition and drop the state it carried.
   *
   * The retained state survives from `openTransition` until this call, so
   * the second run of the transition meets a returning user; it is gone
   * afterwards.
   */
  async closeTransition(
    id: SyntheticIdentityId,
    input: { readonly toVersion: string; readonly closedAt?: string },
  ): Promise<IdentityState> {
    const state = await this.loadIdentity(id);
    return this.writeIdentity(
      closeReleaseWindow(state, { toVersion: input.toVersion, closedAt: input.closedAt ?? this.now() }),
    );
  }

  /** Return an identity to a fresh baseline, keeping its lineage. */
  async resetIdentity(id: SyntheticIdentityId, options: SaveOptions = {}): Promise<IdentityState> {
    const state = await this.loadIdentity(id);
    return this.writeIdentity(resetRetainedState(state), options);
  }

  /** Withdraw an identity from future evaluations. */
  async retireIdentity(
    id: SyntheticIdentityId,
    input: { readonly at?: string } = {},
  ): Promise<IdentityState> {
    const state = await this.loadIdentity(id);
    return this.writeIdentity(retireIdentityState(state, { at: input.at ?? this.now() }));
  }

  /* ---------------------------------------------------------------------- */
  /* Cohorts                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Create a cohort record, or return the one already stored.
   *
   * Idempotent for an identical definition. A cohort whose definition
   * **differs** from the stored one is refused, because its resolved
   * membership was derived from the old rule: applying the new definition
   * silently would leave a member list that no longer matches the
   * definition it claims to come from. Use
   * {@link updateCohortDefinition} to change it deliberately.
   */
  async declareCohort(cohort: SyntheticCohort): Promise<CohortState> {
    const key = cohortStateKey(cohort.id);
    const existing = await this.tryLoadCohort(cohort.id);
    if (existing !== undefined) {
      if (cohortDefinitionDigest(existing.cohort) !== cohortDefinitionDigest(cohort)) {
        throw new CohortStateError(
          'already_exists',
          `cohort ${cohort.id} is already stored with a different definition; its members were resolved from the stored rule, so call updateCohortDefinition to change it deliberately`,
          'cohort',
          { cohortId: cohort.id },
        );
      }
      return existing;
    }

    const state: CohortState = Object.freeze({
      cohort,
      definitionDigest: cohortDefinitionDigest(cohort),
    });
    return this.put('cohort', key, state, COHORT_CODEC);
  }

  /**
   * Replace a cohort's definition, discarding its resolved membership.
   *
   * The stale member list is dropped rather than carried over: it was
   * resolved from the previous rule, so keeping it would let a durable
   * record claim members its definition does not select. The caller
   * re-resolves by calling `resolveCohort`.
   */
  async updateCohortDefinition(cohort: SyntheticCohort): Promise<CohortState> {
    const key = cohortStateKey(cohort.id);
    const existing = await this.tryLoadCohort(cohort.id);
    if (existing === undefined) {
      throw new CohortStateError(
        'cohort_not_found',
        `no cohort record for ${cohort.id} in this store`,
        'cohort.id',
        { cohortId: cohort.id },
      );
    }
    const state: CohortState = Object.freeze({
      cohort,
      definitionDigest: cohortDefinitionDigest(cohort),
    });
    return this.put('cohort', key, state, COHORT_CODEC);
  }

  async loadCohort(id: CohortId): Promise<CohortState> {
    const state = await this.tryLoadCohort(id);
    if (state === undefined) {
      throw new CohortStateError(
        'cohort_not_found',
        `no cohort record for ${id} in this store`,
        'cohort.id',
        { cohortId: id },
      );
    }
    return state;
  }

  async tryLoadCohort(id: CohortId): Promise<CohortState | undefined> {
    return this.load('cohort', cohortStateKey(id), (payload) => parseCohortState(payload));
  }

  async loadAllCohorts(): Promise<ReadonlyArray<CohortState>> {
    const keys = await this.store.list('cohort');
    const states = await Promise.all(
      keys.map((key) => this.loadRequired('cohort', key, (p) => parseCohortState(p))),
    );
    return Object.freeze(
      states.sort((a, b) => (a.cohort.id < b.cohort.id ? -1 : a.cohort.id > b.cohort.id ? 1 : 0)),
    );
  }

  /**
   * Resolve a cohort's membership against the stored identities.
   *
   * Reads identity *declarations* only, and writes only the cohort
   * record — no identity record is opened for writing anywhere in this
   * call path. See `cohort.ts` for why that is the load-bearing
   * invariant.
   */
  async resolveCohort(
    id: CohortId,
    options: Partial<ResolveOptions> = {},
    saveOptions: SaveOptions = {},
  ): Promise<CohortState> {
    const state = await this.loadCohort(id);
    const identities = await this.loadAllIdentities();
    const resolved = resolveMembership(state, identities, {
      resolvedAt: options.resolvedAt ?? this.now(),
      ...(options.requireFullSizeTarget !== undefined
        ? { requireFullSizeTarget: options.requireFullSizeTarget }
        : {}),
    });
    return this.put('cohort', cohortStateKey(id), resolved, COHORT_CODEC, saveOptions);
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  private async writeIdentity(state: IdentityState, options: SaveOptions = {}): Promise<IdentityState> {
    return this.put('identity', identityStateKey(state.identity.id), state, IDENTITY_CODEC, options);
  }

  /**
   * Read-modify-write one record.
   *
   * The payload is parsed back before it is stored. That round-trip is
   * the write-path guard: it is what makes "nothing is persisted that this
   * build could not read back" true rather than aspirational. Without it,
   * a value assembled in memory — an `accountRef` that was never
   * validated, say — would be written happily and only surface as a
   * `corrupt_record` on the *next* run, long after the mistake.
   */
  private async put<T>(
    kind: DurableRecordKind,
    key: string,
    value: T,
    codec: RecordCodec<T>,
    options: SaveOptions = {},
  ): Promise<T> {
    const current = await this.readRecord(kind, key);
    if (options.expectedRevision !== undefined && current !== undefined) {
      if (current.revision !== options.expectedRevision) {
        throw new CohortStateError(
          'invalid_transition',
          `${kind} record ${key} is at revision ${current.revision}, not the expected ${options.expectedRevision}`,
          `${kind}.record.revision`,
          { key, expected: options.expectedRevision, actual: current.revision },
        );
      }
    }
    const payload = codec.serialize(value);
    // Throws before any write if the value would not survive a reload.
    codec.parse(payload);

    const record: DurableRecord = buildDurableRecord({
      kind,
      key,
      payload,
      revision: (current?.revision ?? 0) + 1,
      updatedAt: this.now(),
    });
    await this.store.write(kind, key, JSON.stringify(record));
    return value;
  }

  private async readRecord(kind: DurableRecordKind, key: string): Promise<DurableRecord | undefined> {
    const text = await this.store.read(kind, key);
    if (text === undefined) return undefined;
    const record = parseDurableRecord(text, kind, this.migrations);
    if (record.key !== key) {
      throw new CohortStateError(
        'key_mismatch',
        `stored ${kind} record declares key ${record.key} but was filed under ${key}`,
        `${kind}.record.key`,
        { expected: key, actual: record.key },
      );
    }
    return record;
  }

  private async load<T>(
    kind: DurableRecordKind,
    key: string,
    parse: (payload: unknown) => T,
  ): Promise<T | undefined> {
    const record = await this.readRecord(kind, key);
    return record === undefined ? undefined : parse(record.payload);
  }

  /**
   * `load` for keys that came from `list()`.
   *
   * A key that vanishes between the listing and the read means two
   * writers are racing, or the store is not consistent. Either way it is
   * reported rather than skipped, because silently dropping a record from
   * a cohort roll-up is the failure this whole package exists to prevent.
   */
  private async loadRequired<T>(
    kind: DurableRecordKind,
    key: string,
    parse: (payload: unknown) => T,
  ): Promise<T> {
    const value = await this.load(kind, key, parse);
    if (value === undefined) {
      throw new CohortStateError(
        'corrupt_record',
        `${kind} record ${key} was listed but could not be read back`,
        `${kind}.record`,
        { key },
      );
    }
    return value;
  }
}

/**
 * The persistence key of an identity record.
 *
 * Derived from the declared `SyntheticIdentityId` alone. No run id, no
 * timestamp, no build or release identifier, no schema version — so the
 * key a 0.4.0 process writes is byte-identical to the key a 0.5.0
 * process computes for the same identity.
 */
export function identityStateKey(id: SyntheticIdentityId): string {
  return durableRecordKey('identity', id);
}

/** The persistence key of a cohort record. Same stability argument. */
export function cohortStateKey(id: CohortId): string {
  return durableRecordKey('cohort', id);
}

export type { DurableRecord, RecordMigration, RecordStore };
export type { AccountRef, CohortState, EnvironmentObservation, IdentityState, SyntheticCohort, SyntheticIdentity };
