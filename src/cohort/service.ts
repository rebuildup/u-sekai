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
   * Supplying it is how two concurrent evaluators avoid silently
   * overwriting each other's observations. Read it with
   * {@link CohortStateService.currentRevision} immediately before the
   * write; passing a revision read any earlier narrows the guard to the
   * window between the read and this write, which is the window that
   * exists.
   *
   * `0` means "the record must not exist yet". It is a truthful
   * encoding rather than a sentinel convenience: `parseDurableRecord`
   * rejects any stored revision below 1, so no real record can collide
   * with it, and it is what lets the create-race be guarded instead of
   * being an unguarded overwrite.
   */
  readonly expectedRevision?: number;
}

/* -------------------------------------------------------------------------- */
/* Why `expectedRevision` is optional — read this before adding a mutator     */
/* -------------------------------------------------------------------------- */

/**
 * Issue #103 item 2 asked whether `SaveOptions.expectedRevision` should
 * be **required**. The decision is: **it stays optional, and that is a
 * deliberate decision with a bounded set of exemptions, not an
 * oversight.** The reasoning, so the next reader does not have to
 * re-derive it:
 *
 * 1. **It cannot be made required without breaking every caller.** Every
 *    mutator here takes `options: SaveOptions = {}` so that a caller may
 *    omit it, and `src/runtime/persistence.ts` calls `recordRun`,
 *    `touch`, `openTransition`, `closeTransition` and `resolveCohort`
 *    without the argument. Removing the default makes those calls fail
 *    to typecheck, and the runtime is #63's surface, not this ticket's.
 *    A guard this strong therefore cannot be landed from this layer
 *    without a coordinated change on both sides.
 *
 * 2. **The create-only paths have no revision to ask for.** An
 *    identical redeclaration returns the stored record untouched, and a
 *    declaration that differs raises `already_exists`, so a caller
 *    re-declaring has nothing to guard — what it read is what it gets.
 *    `declareIdentity` is the one place that *creates*, and it is the
 *    one place that does guard: it writes under `expectedRevision: 0`,
 *    so a concurrent first declaration is refused instead of silently
 *    overwriting the winner. `declareCohort` carries no
 *    caller-supplied extra and its create is therefore not reachable
 *    with a differing payload; it is left as it was.
 *
 * 3. **Every other mutator takes the option and enforces it.** The
 *    exemption list is closed and is enforced by a test that reflects
 *    over this class's public methods, so a mutator added later without
 *    a guard fails the suite instead of quietly reintroducing
 *    last-write-wins. That test is the load-bearing part of this
 *    decision: the justification above is only true while the list stays
 *    closed.
 *
 * The residual risk is explicit, and it is the risk #92 was created to
 * remove: a *future* caller that forgets the argument writes
 * unconditionally. What changed in #103 is that the hole is no longer
 * reachable through the two release-transition writes or through
 * `retireIdentity` / `updateCohortDefinition`, and a new mutator cannot
 * be added without being classified.
 */

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
   *
   * ## Why the create is guarded, and why that is not a contradiction
   *
   * This is one of the two create-only paths that the "why
   * `expectedRevision` is optional" note above exempts from having to
   * *accept* a revision. It still has one window of its own, and closing
   * it is why the exemption is safe:
   *
   * The read above and the write below are separate awaits, so two
   * concurrent first declarations of the same id both see "absent" and
   * both write. The second would silently win — and because `extra`
   * carries an `accountRef` the stored record may or may not have, the
   * loser's `accountRef` disappears with no error. That is the same
   * last-write-wins shape this package exists to prevent, wearing a
   * create path's clothes.
   *
   * So the create passes `expectedRevision: 0` — "the record must not
   * exist yet" — and a writer that lost the create race is refused with
   * `revision_conflict` instead of overwriting the winner. A caller that
   * genuinely wants to re-declare takes the branch above, which is
   * already idempotent.
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
    return this.put('identity', key, state, IDENTITY_CODEC, { expectedRevision: 0 });
  }

  /**
   * The revision currently stored for one identity.
   *
   * `IdentityState` deliberately carries no revision — the revision is
   * an envelope fact, not a property of the identity — so a caller that
   * wants to write under a guard has no other way to learn what to
   * guard against. Reading it and passing it to
   * {@link SaveOptions.expectedRevision} is the whole optimistic-concurrency
   * protocol, and a protocol whose first half is unreachable is not a
   * protocol.
   *
   * `undefined` means the store holds no record for this id, which is
   * the state a first write legitimately expects. A caller that wants
   * to guard that case as well should pass `0`; see
   * {@link SaveOptions}.
   */
  async currentRevision(id: SyntheticIdentityId): Promise<number | undefined> {
    const record = await this.readRecord('identity', identityStateKey(id));
    return record?.revision;
  }

  /**
   * The revision currently stored for one identity.
   *
   * `IdentityState` deliberately carries no revision — the revision is
   * an envelope fact, not a property of the identity — so a caller that
   * wants to write under a guard has no other way to learn what to
   * guard against. Reading it and passing it to
   * {@link SaveOptions.expectedRevision} is the whole optimistic-concurrency
   * protocol, and a protocol whose first half is unreachable is not a
   * protocol.
   *
   * `undefined` means the store holds no record for this id, which is
   * the state a first write legitimately expects.
   */
  async currentRevision(id: SyntheticIdentityId): Promise<number | undefined> {
    const record = await this.readRecord('identity', identityStateKey(id));
    return record?.revision;
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

  /**
   * Open the transition window for a `release` identity.
   *
   * Takes a guard like every other mutator, and for the same reason as
   * `closeTransition` below: the transition writes are the ones a
   * concurrent run of the *same* identity is most likely to collide
   * with, because a release identity is by definition the one being
   * evaluated by more than one run — one per environment.
   */
  async openTransition(
    id: SyntheticIdentityId,
    input: { readonly fromVersion: string; readonly openedAt?: string },
    options: SaveOptions = {},
  ): Promise<IdentityState> {
    const state = await this.loadIdentity(id);
    return this.writeIdentity(
      openReleaseWindow(state, {
        fromVersion: input.fromVersion,
        openedAt: input.openedAt ?? this.now(),
      }),
      options,
    );
  }

  /**
   * Close a release transition and drop the state it carried.
   *
   * The retained state survives from `openTransition` until this call, so
   * the second run of the transition meets a returning user; it is gone
   * afterwards.
   *
   * ## Why the guard matters more here than anywhere else
   *
   * This is the most destructive write in the package. It *drops*
   * `retainedState`, so a stale write does not merely lose a field — it
   * deletes the state that made the second run of the transition a
   * returning-user observation at all, and with it the evidence #61's
   * release-transition comparison joins on. That is why the guard is
   * threaded through rather than left to the caller to remember, and
   * why a caller that cannot thread it should not be running two
   * evaluations of one release identity concurrently.
   */
  async closeTransition(
    id: SyntheticIdentityId,
    input: { readonly toVersion: string; readonly closedAt?: string },
    options: SaveOptions = {},
  ): Promise<IdentityState> {
    const state = await this.loadIdentity(id);
    return this.writeIdentity(
      closeReleaseWindow(state, { toVersion: input.toVersion, closedAt: input.closedAt ?? this.now() }),
      options,
    );
  }

  /** Return an identity to a fresh baseline, keeping its lineage. */
  async resetIdentity(id: SyntheticIdentityId, options: SaveOptions = {}): Promise<IdentityState> {
    const state = await this.loadIdentity(id);
    return this.writeIdentity(resetRetainedState(state), options);
  }

  /**
   * Withdraw an identity from future evaluations.
   *
   * Guarded like the rest. #103 named only the two transition writes,
   * but this is the same defect in the same file — a mutator with no way
   * for a caller to detect a lost update — and leaving one of three
   * identical unguarded mutators behind would be the half-fix this whole
   * investigation exists to reject.
   */
  async retireIdentity(
    id: SyntheticIdentityId,
    input: { readonly at?: string } = {},
    options: SaveOptions = {},
  ): Promise<IdentityState> {
    const state = await this.loadIdentity(id);
    return this.writeIdentity(retireIdentityState(state, { at: input.at ?? this.now() }), options);
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
   *
   * Guarded because it discards a membership resolution another writer
   * may have just computed — the cohort-side twin of the transition
   * writes, and for the same reason.
   */
  async updateCohortDefinition(cohort: SyntheticCohort, options: SaveOptions = {}): Promise<CohortState> {
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
    return this.put('cohort', key, state, COHORT_CODEC, options);
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
   *
   * ## What the revision guard does and does not guarantee
   *
   * It closes the window between the caller's read and this one. It does
   * **not** make the write atomic, and the reason is worth stating
   * precisely rather than approximately, because a half-guarantee stated
   * as a whole one is the defect class this package exists to prevent:
   *
   * - `RecordStore` exposes only `read` / `write` / `delete` / `list`.
   *   There is no compare-and-swap primitive, so between this read and
   *   `store.write` below, another writer can commit. That writer's
   *   payload is then overwritten by a value derived from a snapshot
   *   taken before it, and — because the revision is computed from the
   *   `current` read here — **both writers store the same revision
   *   number.** The counter is fooled along with the payload, so no
   *   amount of reading revisions afterwards can detect the loss.
   * - `FileRecordStore.write` renames a temporary file over the target,
   *   which is atomic for a *single* write: a reader sees the whole old
   *   record or the whole new one, never a torn mixture. It is not
   *   conditional — nothing about the rename says "only if the revision
   *   is still N".
   * - `InMemoryRecordStore` could support a conditional write trivially
   *   (a single-threaded `Map` compare is atomic), but the interface
   *   gives it no way to say so, and a capability only one implementation
   *   has is not a capability of the store.
   *
   * So: **the guard detects a writer that moved the record before this
   * read. It does not detect one that moves it after.** Closing the
   * second window needs a CAS primitive on `RecordStore` — a change to
   * the store contract that belongs to #60, not to a guard fix. Issue
   * #103 records that decision; it does not pretend the gap is closed.
   *
   * What the guard *can* close at this layer, and does, is the
   * absent-record case: an expected revision above 0 with no record
   * present is a conflict, not an excuse to create one.
   *
   * One note on the `expectedRevision: 0` branch below. It is the
   * documented encoding for "the record must not exist yet", and it is
   * what makes the *other* direction guardable — a caller that saw no
   * record and then finds one has lost the create-race and is refused.
   * `declareIdentity` is the caller: it creates under `0`, so a
   * concurrent first declaration of the same id is refused rather than
   * silently overwriting the winner's `accountRef`. Both halves of the
   * encoding are therefore load-bearing and both are exercised — the
   * successful create by every identity in the suite, the refusal by
   * `create-only declarations are guarded too`.
   */
  private async put<T>(
    kind: DurableRecordKind,
    key: string,
    value: T,
    codec: RecordCodec<T>,
    options: SaveOptions = {},
  ): Promise<T> {
    const current = await this.readRecord(kind, key);
    if (options.expectedRevision !== undefined) {
      if (current === undefined) {
        // Only `expectedRevision: 0` — "the record must not exist yet" —
        // is satisfied by an absent record. Any other expectation means
        // the record the caller read is gone, which is a lost update
        // like any other and must not be answered by recreating the
        // record from a stale snapshot at revision 1.
        if (options.expectedRevision !== 0) {
          throw new CohortStateError(
            'revision_conflict',
            `${kind} record ${key} no longer exists, but the caller expected revision ${options.expectedRevision}`,
            `${kind}.record.revision`,
            { key, expected: options.expectedRevision, actual: undefined },
          );
        }
      } else if (current.revision !== options.expectedRevision) {
        throw new CohortStateError(
          'revision_conflict',
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
