/**
 * A→B environment transition (ADR-0011, issue #69).
 *
 * ## What ADR-0011 actually says a transition is
 *
 * ADR-0011's second evaluation mode: "a persistent cohort experiences an
 * earlier version and then a newer version so changes in behavior,
 * memory, confidence, and mental model can be observed." The diagram in
 * `docs/product/ubiquitous-evaluation.md` spells out the shape —
 *
 * ```text
 * Environment/version A
 *         ↓
 * interaction + retained state
 *         ↓
 * release/promotion
 *         ↓
 * Environment/version B
 *         ↓
 * returning-user interaction
 * ```
 *
 * — and adds the constraint that makes it different from two fresh
 * agents: "The retained history is part of the experimental condition."
 *
 * So the transition modelled here is exactly that and nothing more: a
 * promotion that moves a cohort from one version of an environment to
 * another, recorded so the promotion itself is observable. It is
 * explicitly **not** a claim about whether B is better, whether the
 * cohort's confidence rose, or what any of it means. Those are
 * evaluation findings (#61/#64) and KPI primitives, not part of a
 * transition record; inventing a scoring rule here would be inventing
 * product semantics this module has no authority over. The
 * `transition_semantics` question "when is a transition legitimate?"
 * therefore has a specified answer — *any promotion between two
 * distinct versions of the same environment, for the same cohort* — and
 * a deliberately empty one for "did it improve anything", which stays out
 * of scope.
 *
 * ## Durability: a two-phase journal, not a flag
 *
 * A transition that only lived in memory would be unobservable by
 * anything that matters (`server.ts:22` builds fresh state per
 * process), so the record is written to a directory. The write is
 * two-phase — an `intent` record naming both endpoints, then a
 * `committed` record — and that is what gives the ticket its recovery
 * point:
 *
 * ```text
 * crash before intent      → no record at all      → clean "never started"
 * crash after intent       → intent, no commit     → "incomplete", resumable
 * crash after commit       → intent + commit       → done, idempotent
 * ```
 *
 * A half-applied transition that cannot resume is worse than one that
 * refuses to start, so the incomplete case is a first-class outcome that
 * `resumeIncomplete` can finish, not an error to be swallowed.
 *
 * ## Idempotency comes from the key, not from bookkeeping
 *
 * The transition key is derived from (cohort, from-instance,
 * to-instance) and contains no timestamp, so the same request at any
 * two instants in any two processes is the same key. Applying a key
 * that already has a `committed` record is a no-op that reports
 * `already-committed`. This is why the key derivation, not a
 * "have I done this before?" flag, is what makes re-running safe.
 *
 * ## "Never ran" is not "nothing to report"
 *
 * This project has been bitten repeatedly by empty-success semantics
 * (Issue #78: a test script that discovers zero files; `ty-plus` #179: a
 * partition that runs zero tests and reports success). So
 * `readTransition` returns an explicit discriminated union —
 * `never-started` / `incomplete` / `committed` / `rejected` — and never
 * `undefined` for "no idea". A caller that renders a transition report
 * cannot accidentally render a rejected transition as a success.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import {
  deriveTransitionKey,
  parseInstanceKey,
  type EnvironmentInstanceKey,
} from './keys.js';
import type { EnvironmentPair } from './instance.js';

/** Thrown for transition contract violations. */
export class TransitionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TransitionError';
    this.code = code;
  }
}

/** Both endpoints, named. A transition is meaningless without them. */
export interface TransitionEndpoints {
  readonly fromKey: EnvironmentInstanceKey;
  readonly toKey: EnvironmentInstanceKey;
}

/** What was requested, and what was stored. */
export interface TransitionRecord extends TransitionEndpoints {
  /** Derived from (cohort, from, to). Stable across processes. */
  readonly transitionKey: string;
  readonly cohortId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
}

/** Why a transition was refused. Never silently dropped. */
export type RejectionReason =
  | 'same-version'
  | 'unknown-endpoint'
  | 'not-a-forward-transition'
  | 'incomplete-conflict';

export const REJECTION_EXPLANATIONS: Readonly<Record<RejectionReason, string>> = Object.freeze({
  'same-version': 'both endpoints declare the same version, so nothing transitioned',
  'unknown-endpoint': 'the cohort has no durable record of the starting environment',
  'not-a-forward-transition': 'the target is not a newer version than the current environment',
  'incomplete-conflict': 'a different incomplete transition is already pending for this cohort',
});

/**
 * The state of a requested transition.
 *
 * Four arms, all of them reportable. The union is the point: a caller
 * that switches over it is forced by the type system to handle "never
 * started" and "rejected" separately from "committed", so neither can
 * be silently rendered as success.
 */
export type TransitionState =
  | { readonly status: 'never-started'; readonly cohortId: string }
  | { readonly status: 'incomplete'; readonly record: TransitionRecord }
  | { readonly status: 'committed'; readonly record: TransitionRecord }
  | {
      readonly status: 'rejected';
      readonly cohortId: string;
      readonly reason: RejectionReason;
      readonly detail: string;
    };

export interface ApplyOutcome {
  readonly state: TransitionState;
  /**
   * True when this call performed the commit, false when it observed a
   * transition that had already been committed. This is the observable
   * difference between "applied" and "re-ran", and it is what the
   * idempotency test asserts.
   */
  readonly applied: boolean;
}

/** Cohort -> the environment it is on, and any transition in flight. */
interface CohortState {
  /** The instance the cohort is currently pointed at. */
  currentKey: EnvironmentInstanceKey;
  /**
   * Transition that has a durable intent but no commit yet.
   *
   * This field is the recovery point. Its presence means a transition
   * started and did not finish, which is a state a caller must be able
   * to see; its absence together with an existing `currentKey` means
   * everything that was started has finished. Keeping it on the cohort
   * record rather than scanning the transition directory is what makes
   * "a *different* transition is already pending" answerable.
   */
  pending?: { transitionKey: string; fromKey: EnvironmentInstanceKey; toKey: EnvironmentInstanceKey };
}

/**
 * Durable transition store, rooted at a directory.
 *
 * Files are named from a SHA-256 of the transition key and the cohort
 * id, following the same defence #66's `FileRecordStore` uses: the real
 * key is stored *inside* the envelope, and the filename never comes from
 * untrusted input.
 */
export class TransitionStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    if (typeof rootDir !== 'string' || rootDir.trim() === '') {
      throw new TransitionError('invalid-root', 'TransitionStore requires a non-empty rootDir');
    }
    this.rootDir = path.resolve(rootDir);
  }

  private filePath(name: string): string {
    return path.join(this.rootDir, `${name}.json`);
  }

  private transitionPath(transitionKey: string): string {
    return this.filePath(
      `transition-${createHash('sha256').update(transitionKey, 'utf8').digest('hex')}`,
    );
  }

  private cohortPath(cohortId: string): string {
    return this.filePath(
      `cohort-${createHash('sha256').update(cohortId, 'utf8').digest('hex')}`,
    );
  }

  private async writeJson(target: string, value: unknown): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    // Temp file in the same directory so the rename is a same-filesystem
    // atomic replace: a reader sees the whole old value or the whole
    // new one, never a torn mixture.
    const tmp = path.join(this.rootDir, `.${path.basename(target)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
      await fs.rename(tmp, target);
    } catch (cause) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw new TransitionError(
        'write-failed',
        `failed to write ${path.basename(target)}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  private async readJson<T>(target: string): Promise<T | undefined> {
    let text: string;
    try {
      text = await fs.readFile(target, 'utf8');
    } catch (cause) {
      if (isNotFound(cause)) return undefined;
      throw new TransitionError(
        'read-failed',
        `failed to read ${path.basename(target)}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new TransitionError(
        'corrupt-record',
        `stored record ${path.basename(target)} is not valid JSON`,
      );
    }
  }

  /** The durable cohort record, or undefined if the cohort is unknown. */
  async readCohortState(cohortId: string): Promise<CohortState | undefined> {
    const raw = await this.readJson<CohortState>(this.cohortPath(cohortId));
    if (raw === undefined) return undefined;
    return {
      currentKey: parseInstanceKey(raw.currentKey, 'cohort.currentKey'),
      ...(raw.pending === undefined
        ? {}
        : {
            pending: {
              transitionKey: raw.pending.transitionKey,
              fromKey: parseInstanceKey(raw.pending.fromKey, 'cohort.pending.fromKey'),
              toKey: parseInstanceKey(raw.pending.toKey, 'cohort.pending.toKey'),
            },
          }),
    };
  }

  async writeCohortState(cohortId: string, state: CohortState): Promise<void> {
    await this.writeJson(this.cohortPath(cohortId), state);
  }

  async writeIntent(record: TransitionRecord): Promise<void> {
    await this.writeJson(this.transitionPath(record.transitionKey), {
      phase: 'intent',
      record,
    });
  }

  async writeCommit(record: TransitionRecord): Promise<void> {
    await this.writeJson(this.transitionPath(record.transitionKey), {
      phase: 'commit',
      record,
    });
  }

  /**
   * Read one transition envelope.
   *
   * The phase is returned rather than collapsing both to "exists": an
   * intent with no commit is an incomplete transition, and the caller
   * has to be able to tell that apart from a finished one.
   */
  async readEnvelope(
    transitionKey: string,
  ): Promise<{ phase: 'intent' | 'commit'; record: TransitionRecord } | undefined> {
    return this.readJson(this.transitionPath(transitionKey));
  }
}

function isNotFound(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * Build the endpoints for a promotion, or explain the refusal.
 *
 * Called only once the durable record has been consulted. Deciding
 * legitimacy *after* the idempotency check is deliberate: a cohort that
 * has already completed A→B is on `after`, and a naive "is it already
 * there?" rule would reject the re-run that idempotency requires.
 *
 * The only legitimacy rule applied is the one ADR-0011 states: the two
 * sides must be different versions, and the cohort must be on an
 * endpoint of this pair. Nothing here judges whether the promotion was
 * *good* — that is a finding, not a transition.
 */
function resolveTransition(
  pair: EnvironmentPair,
  currentKey: EnvironmentInstanceKey | undefined,
): { ok: true; endpoints: TransitionEndpoints } | { ok: false; reason: RejectionReason; detail: string } {
  if (pair.before.version === pair.after.version) {
    return {
      ok: false,
      reason: 'same-version',
      detail: `both endpoints serve version "${pair.before.version}"`,
    };
  }
  if (currentKey !== undefined) {
    const known = [pair.before.key, pair.after.key];
    if (!known.includes(currentKey)) {
      return {
        ok: false,
        reason: 'unknown-endpoint',
        detail: `cohort is bound to ${currentKey}, which is not an endpoint of this pair`,
      };
    }
  }
  return {
    ok: true,
    endpoints: { fromKey: pair.before.key, toKey: pair.after.key },
  };
}

function makeRecord(cohortId: string, endpoints: TransitionEndpoints, pair: EnvironmentPair): TransitionRecord {
  return Object.freeze({
    ...endpoints,
    transitionKey: deriveTransitionKey(cohortId, endpoints.fromKey, endpoints.toKey),
    cohortId,
    fromVersion: pair.before.version,
    toVersion: pair.after.version,
  });
}

function rejected(cohortId: string, reason: RejectionReason, detail: string): ApplyOutcome {
  return { state: { status: 'rejected', cohortId, reason, detail }, applied: false };
}

/**
 * Apply a transition: observable, idempotent, resumable.
 *
 * ## Order of operations is the recovery story
 *
 * 1. Derive the key from (cohort, from, to) — no clock, so a re-run is
 *    recognisably the same request.
 * 2. Consult the durable record. A commit means this already happened:
 *    report it and change nothing. That is what makes the operation
 *    idempotent, and it has to come *before* any legitimacy rule.
 * 3. A pending intent means a previous attempt got part-way. Finish it.
 * 4. Otherwise write the intent **before** moving the pointer, so a
 *    crash between the two leaves a resumable record rather than a
 *    moved pointer with nothing explaining it.
 */
export async function applyTransition(
  store: TransitionStore,
  cohortId: string,
  pair: EnvironmentPair,
): Promise<ApplyOutcome> {
  const endpoints: TransitionEndpoints = { fromKey: pair.before.key, toKey: pair.after.key };
  const record = makeRecord(cohortId, endpoints, pair);
  const cohortState = await store.readCohortState(cohortId);
  const existing = await store.readEnvelope(record.transitionKey);

  // Idempotency: the transition already committed. Report it as a
  // committed transition that this call did not perform.
  if (existing?.phase === 'commit') {
    return { state: { status: 'committed', record: existing.record }, applied: false };
  }

  // Resume: an intent for exactly this transition is on disk. Complete
  // it rather than starting a second one.
  if (existing?.phase === 'intent') {
    return finish(store, cohortId, pair, record);
  }

  // A different transition is already in flight for this cohort.
  // Completing this one would move the pointer underneath the pending
  // record, which would then resume into a state nobody asked for.
  if (cohortState?.pending !== undefined) {
    return rejected(
      cohortId,
      'incomplete-conflict',
      `a different transition is pending (${cohortState.pending.fromKey} -> ${cohortState.pending.toKey})`,
    );
  }

  const resolved = resolveTransition(pair, cohortState?.currentKey);
  if (!resolved.ok) {
    return rejected(cohortId, resolved.reason, resolved.detail);
  }

  // Intent first, pointer second, commit last.
  await store.writeIntent(record);
  await store.writeCohortState(cohortId, {
    currentKey: cohortState?.currentKey ?? record.fromKey,
    pending: { transitionKey: record.transitionKey, fromKey: record.fromKey, toKey: record.toKey },
  });
  return finish(store, cohortId, pair, record);
}

/**
 * Move the pointer and commit, clearing the pending marker.
 *
 * Split out because both the fresh path and the resume path end here,
 * and a resume that took a different code path would be a second thing
 * to keep correct.
 */
async function finish(
  store: TransitionStore,
  cohortId: string,
  pair: EnvironmentPair,
  record: TransitionRecord,
): Promise<ApplyOutcome> {
  pair.advancePointer();
  await store.writeCohortState(cohortId, { currentKey: record.toKey });
  await store.writeCommit(record);
  return { state: { status: 'committed', record }, applied: true };
}

/**
 * Read a transition's state without changing anything.
 *
 * Returns a discriminated union rather than `undefined`, so "no record"
 * is reported as `never-started` and a pending intent as `incomplete` —
 * neither is confusable with `committed`.
 */
export async function readTransition(
  store: TransitionStore,
  cohortId: string,
  endpoints: TransitionEndpoints,
): Promise<TransitionState> {
  const transitionKey = deriveTransitionKey(cohortId, endpoints.fromKey, endpoints.toKey);
  const envelope = await store.readEnvelope(transitionKey);
  if (envelope === undefined) {
    return { status: 'never-started', cohortId };
  }
  return envelope.phase === 'commit'
    ? { status: 'committed', record: envelope.record }
    : { status: 'incomplete', record: envelope.record };
}

/**
 * Finish a transition that was left incomplete.
 *
 * Refuses when the pending record is not the transition being asked
 * for: a pending A→C must not be silently completed by a caller asking
 * about A→B, or the durable record would name one transition while the
 * pointer moved for another.
 */
export async function resumeIncomplete(
  store: TransitionStore,
  cohortId: string,
  pair: EnvironmentPair,
): Promise<ApplyOutcome> {
  const cohortState = await store.readCohortState(cohortId);
  const endpoints: TransitionEndpoints = { fromKey: pair.before.key, toKey: pair.after.key };
  const record = makeRecord(cohortId, endpoints, pair);

  const pending = cohortState?.pending;
  if (pending === undefined) {
    // Nothing pending: this is a first attempt, not a resume.
    return applyTransition(store, cohortId, pair);
  }
  if (pending.transitionKey !== record.transitionKey) {
    return rejected(
      cohortId,
      'incomplete-conflict',
      `a different transition is pending (${pending.fromKey} -> ${pending.toKey})`,
    );
  }

  const envelope = await store.readEnvelope(record.transitionKey);
  if (envelope?.phase === 'commit') {
    await store.writeCohortState(cohortId, { currentKey: record.toKey });
    return { state: { status: 'committed', record: envelope.record }, applied: false };
  }
  if (envelope === undefined) {
    // The cohort record claims a pending transition whose envelope is
    // gone. Treated as a conflict rather than a fresh start: something
    // removed durable state, and silently restarting would hide that.
    return rejected(
      cohortId,
      'incomplete-conflict',
      `cohort record names pending transition ${record.transitionKey} but no intent envelope exists`,
    );
  }
  return finish(store, cohortId, pair, envelope.record);
}

/** Re-validate a key read back from the durable store. */
export function coerceStoredKey(value: unknown, field = 'storedKey'): EnvironmentInstanceKey {
  return parseInstanceKey(value, field);
}
