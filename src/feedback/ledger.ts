/**
 * Disposition ledger — the durable, append-only record of how a
 * customer's feedback on a finding changed over time (issue #64).
 *
 * ## What #61 owns and what this module owns
 *
 * #61 (`src/review/**`) owns the *vocabulary* of a disposition: which
 * kinds exist, which kinds may carry which lifecycle state, which
 * actor may record which kind, and the legal transition table. This
 * module owns the *sequence*: given a ledger and a proposed append,
 * is this append well-formed against everything already recorded?
 *
 * That split is why this file calls `assertDispositionTransition` and
 * `parseDisposition` rather than re-implementing either. Re-deriving
 * the transition table here would be the classic drift bug — two
 * tables that agree until someone edits one of them, and then an audit
 * trail that accepts an illegal move.
 *
 * ## Immutability is a type-level property, not a convention
 *
 * Every append returns a **new** `DispositionLedger`. No function in
 * this module mutates an existing one, every array and object is
 * `Object.freeze`d, and the events reachable from a ledger value are
 * the same frozen instances the caller already holds. So
 * "history is not overwritten silently" is checkable as an identity
 * assertion (`before.events[0] === after.events[0]`), not as a code
 * review.
 *
 * ## Order of authority: append order, not `decidedAt`
 *
 * The head disposition of a finding — the one every KPI reads — is the
 * **last event in append order**, not the event with the greatest
 * `decidedAt`. Two reasons:
 *
 * 1. The log *is* the record of what happened in what order. A clock
 *    that disagrees with the sequence would make the audit trail say
 *    something the customer never did.
 * 2. `decidedAt` is a wall clock. Two reviewers correcting each other
 *    across a daylight-saving boundary, or a reviewer whose clock is
 *    skewed, would otherwise silently rewrite which decision is
 *    current.
 *
 * `decidedAt` is still recorded on every event and is exposed through
 * `dispositionHistory`, so time-based analysis remains possible. It
 * just does not decide *currency*.
 *
 * ## Idempotency is content-aware
 *
 * Replaying a transport that retried an append must be safe, so a
 * duplicate `Disposition.id` is a no-op that returns the **identical**
 * ledger value (`===`), not merely an equal one. But a duplicate id
 * carrying *different* content is not a replay — it is two events
 * claiming one identity, which would make the current disposition of a
 * finding depend on iteration order. That is refused, loudly, with both
 * documents named so the conflict is diagnosable.
 *
 * Comparison is field-by-field rather than `JSON.stringify`, because
 * stringify is sensitive to key insertion order and would turn a
 * harmless re-parse of the same document into a conflict.
 *
 * ## Corrections keep the previous value
 *
 * #61's `isDispositionCorrection` distinguishes a *correction*
 * (`decided -> decided`, `closed -> decided`) from forward progress
 * (`needsHumanResearch -> decided`). This module makes the distinction
 * load-bearing: a correction **must** carry `supersedes` pointing at the
 * current head, and a disposition that carries `supersedes` **must** be
 * a correction. Either error loses the audit link, so both are refused
 * at append time rather than discovered during a later audit.
 */

import {
  assertDispositionTransition,
  DISPOSITION_KINDS,
  INITIAL_DISPOSITION_STATE,
  isDispositionCorrection,
  parseDisposition,
} from '../review/index.js';
import type { Disposition, DispositionKind, DispositionState } from '../review/index.js';
import type { FindingId } from '../review/index.js';
import { FeedbackContractError, asFeedbackContractError } from './errors.js';
import { rejectDuplicates, requireArray, requireRecord } from './validation.js';

/**
 * One recorded disposition and the state it moved the finding from.
 *
 * `toState` is deliberately absent: it is `disposition.state` by
 * construction, and a second copy of that fact on the event is a field
 * that can disagree with the one it was derived from.
 */
export interface DispositionEvent {
  /** 1-based position in the log. Stable across derived ledgers. */
  readonly sequence: number;
  readonly disposition: Disposition;
  /** Mirrors `disposition.findingId`, for keyed lookups. */
  readonly findingId: FindingId;
  /** The finding's lifecycle state *before* this event was applied. */
  readonly fromState: DispositionState;
  /** Whether this event re-recorded an existing decision. */
  readonly isCorrection: boolean;
}

/**
 * The whole record. Immutable: `events` is frozen and each event is
 * frozen, so a ledger value is safe to share, cache and re-read.
 */
export interface DispositionLedger {
  readonly events: ReadonlyArray<DispositionEvent>;
}

/** A ledger with no events. There is exactly one empty value. */
export const EMPTY_LEDGER: DispositionLedger = Object.freeze({
  events: Object.freeze([]) as ReadonlyArray<DispositionEvent>,
});

export function emptyLedger(): DispositionLedger {
  return EMPTY_LEDGER;
}

/**
 * Build a ledger from events already in sequence order.
 *
 * The entry point for replaying a persisted log. The events are
 * **re-validated** against each other rather than trusted: a log
 * loaded from disk has had its transition legality checked by whoever
 * wrote it, and this is the only place that can check whether the
 * sequence as stored is internally consistent. `trust: 'stored'`
 * does not skip that.
 */
export function ledgerFromEvents(
  events: ReadonlyArray<unknown>,
  field = 'events',
): DispositionLedger {
  const arr = requireArray(events, field);
  let ledger = EMPTY_LEDGER;
  arr.forEach((entry, i) => {
    const record = requireRecord(entry, `${field}[${i}]`);
    ledger = appendDisposition(ledger, record['disposition'], `${field}[${i}].disposition`);
    const expected = record['sequence'];
    if (expected !== ledger.events.length) {
      throw new FeedbackContractError(
        `${field}[${i}].sequence must equal its 1-based position in the log; a stored log whose ` +
          `sequence numbers disagree with its order is corrupt`,
        `${field}[${i}].sequence`,
        { expected: ledger.events.length, received: expected },
      );
    }
  });
  return ledger;
}

/**
 * Record a disposition.
 *
 * ## Idempotency
 *
 * A disposition whose id is already in the log is a replay when its
 * content matches the recorded event and a conflict when it does not.
 * The replay case returns the identical ledger value; the conflict
 * case throws.
 *
 * ## What is checked
 *
 * 1. The value is a legal `Disposition` (`parseDisposition`, #61's rules).
 * 2. The transition out of the finding's current state is legal
 *    (#61's `assertDispositionTransition`).
 * 3. A correction carries `supersedes` pointing at the current head,
 *    and a `supersedes` is only legal on a correction.
 * 4. The id is not already recorded with different content.
 */
export function appendDisposition(
  ledger: DispositionLedger,
  input: unknown,
  field = 'disposition',
): DispositionLedger {
  // #61 refuses an illegal `Disposition` with a `ReviewContractError`.
  // Re-raised here so a caller of this layer has exactly one error type
  // to catch, with #61's diagnosis still readable in the message — the
  // contract `errors.ts` states and `index.ts` publishes.
  const disposition = asFeedbackContractError(field, () => parseDisposition(input, field));
  const existingIndex = ledger.events.findIndex((e) => e.disposition.id === disposition.id);

  if (existingIndex >= 0) {
    const existing = ledger.events[existingIndex]!;
    if (sameDisposition(existing.disposition, disposition)) {
      return ledger;
    }
    throw new FeedbackContractError(
      `${field}.id ${disposition.id} is already recorded with different content; a disposition id ` +
        `is the identity of one event, so two events claiming it would make the current ` +
        `disposition of ${disposition.findingId} depend on the order the log was read in`,
      `${field}.id`,
      {
        dispositionId: disposition.id,
        sequence: existing.sequence,
        recorded: describeDisposition(existing.disposition),
        received: describeDisposition(disposition),
      },
    );
  }

  const head = headEventFor(ledger, disposition.findingId);
  const fromState = head === undefined ? INITIAL_DISPOSITION_STATE : head.disposition.state;

  try {
    assertDispositionTransition(fromState, disposition.state, `${field}.state`);
  } catch (cause) {
    throw new FeedbackContractError(
      `cannot append disposition ${disposition.id} for finding ${disposition.findingId}: ` +
        (cause instanceof Error ? cause.message : String(cause)),
      `${field}.state`,
      {
        dispositionId: disposition.id,
        findingId: disposition.findingId,
        fromState,
        toState: disposition.state,
        causeType: cause instanceof Error ? cause.name : typeof cause,
      },
    );
  }

  assertSupersedesChain(disposition, head, fromState, field);

  const event: DispositionEvent = Object.freeze({
    sequence: ledger.events.length + 1,
    disposition,
    findingId: disposition.findingId,
    fromState,
    isCorrection: isDispositionCorrection(fromState, disposition.state),
  });

  return Object.freeze({ events: Object.freeze([...ledger.events, event]) });
}

/**
 * The current disposition of one finding, or `null` when it has none.
 *
 * `null` — rather than a synthetic "unreviewed" placeholder — is what
 * makes "never dispositioned" distinguishable from "explicitly left
 * unresolved" all the way into the KPI layer. The two are different
 * facts about a customer and `docs/product/kpis.md` counts them
 * differently.
 */
export function currentDisposition(
  ledger: DispositionLedger,
  findingId: FindingId,
): Disposition | null {
  return headEventFor(ledger, findingId)?.disposition ?? null;
}

/** Every finding's current disposition, ordered by finding id. */
export function currentDispositions(
  ledger: DispositionLedger,
): ReadonlyArray<readonly [FindingId, Disposition]> {
  const heads = new Map<FindingId, Disposition>();
  for (const event of ledger.events) {
    // Later events overwrite earlier ones: this loop is the "last one
    // wins" rule, and it does not depend on the events being contiguous
    // in the log.
    heads.set(event.findingId, event.disposition);
  }
  return Object.freeze(
    [...heads.entries()].sort((a, b) => compareHandles(a[0], b[0])),
  );
}

/**
 * The full history of one finding, in append order.
 *
 * The oldest event first, so an auditor reads the story forwards. Every
 * event for the finding is present — this is the "corrections do not
 * lose history" surface, and a correction appears here as an
 * additional event with `isCorrection === true`, never as a
 * replacement.
 */
export function dispositionHistory(
  ledger: DispositionLedger,
  findingId: FindingId,
): ReadonlyArray<DispositionEvent> {
  return Object.freeze(ledger.events.filter((e) => e.findingId === findingId));
}

/** Distinct finding ids with at least one event, in id order. */
export function dispositionedFindingIds(ledger: DispositionLedger): ReadonlyArray<FindingId> {
  const ids = [...new Set(ledger.events.map((e) => e.findingId))];
  rejectDuplicates(ids, 'ledger.findingIds');
  return Object.freeze(ids.sort(compareHandles));
}

/**
 * How many events each disposition kind was recorded with.
 *
 * Keyed in `DISPOSITION_KINDS` declaration order, not insertion order,
 * so the record's key order is a fixed total order rather than
 * whatever order the log happened to be written in.
 */
export function eventCountByKind(
  ledger: DispositionLedger,
): Readonly<Record<DispositionKind, number>> {
  const counts = emptyKindCounts();
  for (const event of ledger.events) {
    const kind = event.disposition.kind;
    counts[kind] += 1;
  }
  return Object.freeze(counts);
}

/**
 * A zero-filled count record with every `DispositionKind` present.
 *
 * Written as an object literal typed as `Record<DispositionKind, number>`
 * on purpose. `Object.fromEntries(...)` would typecheck against any
 * number of kinds and would silently produce a record *missing* a kind
 * if #61 ever adds one; here, a new kind in #61 is a compile error
 * until this function is updated. `test/unit/feedback/ledger.test.ts`
 * pins the key order against `DISPOSITION_KINDS` so a reordering is
 * caught too, not just an addition.
 *
 * The literal is in `DISPOSITION_KINDS` order on purpose — that order
 * is the total order the record's keys are returned in — and
 * `assertKindCountKeyOrder` checks it at runtime, because the *type*
 * pins the set of keys but cannot pin their order.
 *
 * Exported (not re-exported from `src/feedback/index.ts`) so `kpi.ts`
 * derives its kind breakdown from this one literal rather than keeping
 * a second copy that could drift.
 */
export function emptyKindCounts(): Record<DispositionKind, number> {
  const counts: Record<DispositionKind, number> = {
    accepted: 0,
    invalid: 0,
    alreadyKnown: 0,
    wontFix: 0,
    needsHumanResearch: 0,
    unresolved: 0,
  };
  assertKindCountKeyOrder(counts);
  return counts;
}

/**
 * Refuse a kind-count record whose key order is not #61's.
 *
 * The declared type makes a *missing* or *extra* key a compile error;
 * it says nothing about order, and this module promises a total order
 * rather than an insertion order. Comparing position by position — not
 * as a set — is the whole point.
 */
function assertKindCountKeyOrder(counts: Record<DispositionKind, number>): void {
  const declared = [...DISPOSITION_KINDS];
  const actual = Object.keys(counts);
  const ordered = actual.length === declared.length && actual.every((key, i) => key === declared[i]);
  if (!ordered) {
    throw new FeedbackContractError(
      `kind-count keys must be in DISPOSITION_KINDS order so the record has a total key order; ` +
        `expected [${declared.join(', ')}] but the literal is [${actual.join(', ')}]`,
      'kindCounts',
      { expected: declared, received: actual },
    );
  }
}

/** Total order on handle strings, used for every sorted output. */
export function compareHandles(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function headEventFor(
  ledger: DispositionLedger,
  findingId: FindingId,
): DispositionEvent | undefined {
  for (let i = ledger.events.length - 1; i >= 0; i -= 1) {
    const event = ledger.events[i]!;
    if (event.findingId === findingId) return event;
  }
  return undefined;
}

function assertSupersedesChain(
  disposition: Disposition,
  head: DispositionEvent | undefined,
  fromState: DispositionState,
  field: string,
): void {
  const isCorrection = isDispositionCorrection(fromState, disposition.state);
  const expected =
    isCorrection && head !== undefined ? head.disposition.id : undefined;

  if (disposition.supersedes !== undefined && !isCorrection) {
    throw new FeedbackContractError(
      `${field}.supersedes is ${disposition.supersedes} but the move ${fromState} -> ` +
        `${disposition.state} is forward progress, not a correction; superseding a decision from a ` +
        `state that holds no decision would assert a history that never happened`,
      `${field}.supersedes`,
      { fromState, toState: disposition.state, supersedes: disposition.supersedes },
    );
  }

  if (disposition.supersedes !== undefined && disposition.supersedes !== expected) {
    throw new FeedbackContractError(
      `${field}.supersedes must be the disposition currently recorded for ${disposition.findingId}` +
        (expected === undefined ? '' : `, which is ${expected}`),
      `${field}.supersedes`,
      { expected: expected ?? null, received: disposition.supersedes },
    );
  }

  if (isCorrection && disposition.supersedes === undefined) {
    throw new FeedbackContractError(
      `${field}.supersedes is required for a correction (${fromState} -> ${disposition.state}); a ` +
        `re-decision that does not say which decision it replaces leaves the history unauditable`,
      `${field}.supersedes`,
      { fromState, toState: disposition.state },
    );
  }
}

/**
 * Structural equality over a `Disposition`.
 *
 * Written out field by field rather than delegated to
 * `JSON.stringify`, for two reasons: stringify is sensitive to key
 * insertion order, so the same logical document could compare unequal
 * after a re-parse; and it would silently start ignoring fields that
 * are `undefined` in one document and absent in the other, which is
 * the exact shape of a "same id, different content" conflict.
 */
function sameDisposition(a: Disposition, b: Disposition): boolean {
  return (
    a.id === b.id &&
    a.findingId === b.findingId &&
    a.kind === b.kind &&
    a.state === b.state &&
    a.decidedAt === b.decidedAt &&
    a.rationale === b.rationale &&
    a.supersedes === b.supersedes &&
    a.actor.kind === b.actor.kind &&
    a.actor.reference === b.actor.reference &&
    sameOptionalAction(a.action, b.action)
  );
}

function sameOptionalAction(
  a: Disposition['action'],
  b: Disposition['action'],
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.kind === b.kind && a.reference === b.reference && a.label === b.label;
}

/** Compact, deterministic rendering used only in conflict messages. */
function describeDisposition(d: Disposition): string {
  return `${d.kind}/${d.state}@${d.decidedAt}`;
}
