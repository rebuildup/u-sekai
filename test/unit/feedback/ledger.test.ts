/**
 * Disposition ledger: append-only history, idempotent replay, and
 * corrections that keep the record they replace.
 *
 * Issue #64 acceptance criteria covered here:
 *
 * - "Disposition history is auditable and does not overwrite prior
 *   events silently." — `describe('the log is append-only')`
 * - "Duplicate disposition event IDs are idempotent." —
 *   `describe('duplicate ids')`
 * - "Tests cover corrections/re-disposition without losing history." —
 *   `describe('corrections and re-disposition')`
 *
 * ## What these tests are for
 *
 * A ledger is the artifact an audit reads after the fact, so the
 * properties that matter are not "does append work" but "can a value be
 * lost, rewritten or made to depend on read order". Each assertion
 * below is aimed at one of those, and the identity assertions
 * (`before.events[0] === after.events[0]`) are the reason: a *copy* that
 * happened to be deep-equal would still pass a `toEqual`, and a copy is
 * exactly the drift a shared ledger would suffer.
 */

import { describe, it, expect } from 'vitest';
import {
  DISPOSITION_KINDS,
  dispositionId,
  parseDisposition,
  ReviewContractError,
} from '../../../src/review/index.js';
import {
  appendDisposition,
  compareHandles,
  currentDisposition,
  currentDispositions,
  dispositionedFindingIds,
  dispositionHistory,
  emptyLedger,
  eventCountByKind,
  isFeedbackContractError,
  ledgerFromEvents,
} from '../../../src/feedback/index.js';
import { FeedbackContractError } from '../../../src/feedback/errors.js';
import {
  acceptedFor,
  dispositionFor,
  dispositionInputFor,
  findingIdFor,
  ledgerOf,
  needsResearchFor,
  unresolvedFor,
} from './support/fixtures.js';

/** A second event on the same finding needs its own id. */
const SECOND = dispositionId('dsp-000000090002');
const THIRD = dispositionId('dsp-000000090003');

describe('the log is append-only', () => {
  it('returns a new ledger and leaves the old one untouched', () => {
    const before = ledgerOf(acceptedFor(1));
    const after = appendDisposition(before, dispositionFor(2, 'invalid'));

    expect(after).not.toBe(before);
    expect(before.events).toHaveLength(1);
    expect(after.events).toHaveLength(2);
  });

  it('reuses the identical earlier event objects, not copies', () => {
    const before = ledgerOf(acceptedFor(1));
    const after = appendDisposition(before, dispositionFor(2, 'invalid'));

    // A deep-equal copy would satisfy `toEqual` but is precisely the
    // drift a shared ledger must not have: a reader holding `before`
    // would see a different object than the one the KPI layer reads.
    expect(after.events[0]).toBe(before.events[0]);
  });

  it('freezes the ledger, the event array and each event', () => {
    const ledger = ledgerOf(acceptedFor(1));
    expect(Object.isFrozen(ledger)).toBe(true);
    expect(Object.isFrozen(ledger.events)).toBe(true);
    expect(Object.isFrozen(ledger.events[0])).toBe(true);
  });

  it('assigns a 1-based sequence that equals the position in the log', () => {
    const ledger = ledgerOf(acceptedFor(1), dispositionFor(2, 'wontFix'), needsResearchFor(3));
    expect(ledger.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    ledger.events.forEach((event, i) => {
      expect(event.sequence).toBe(i + 1);
    });
  });

  it('records the state the finding was in before each event', () => {
    const first = acceptedFor(1);
    const correction = dispositionFor(1, 'invalid', { id: SECOND, supersedes: first.id });
    const ledger = ledgerOf(first, correction);

    expect(ledger.events[0]!.fromState).toBe('unreviewed');
    expect(ledger.events[1]!.fromState).toBe('decided');
  });

  it('mirrors the disposition reference rather than copying the finding', () => {
    const ledger = ledgerOf(acceptedFor(1));
    expect(ledger.events[0]!.findingId).toBe(findingIdFor(1));
    expect(ledger.events[0]!.disposition.findingId).toBe(findingIdFor(1));
  });

  it('starts from exactly one shared empty value', () => {
    expect(emptyLedger().events).toHaveLength(0);
    expect(emptyLedger()).toBe(emptyLedger());
  });
});

describe('duplicate ids', () => {
  it('treats a byte-identical replay as a no-op returning the identical ledger', () => {
    const before = ledgerOf(acceptedFor(1));
    const replayed = appendDisposition(before, acceptedFor(1));

    // `toBe`, not `toEqual`: idempotent means "nothing happened", and
    // a rebuilt-but-equal ledger would be a second, distinct value.
    expect(replayed).toBe(before);
    expect(replayed.events).toHaveLength(1);
  });

  it('is still idempotent after other findings have been appended', () => {
    let ledger = ledgerOf(acceptedFor(1));
    const snapshot = ledger;
    ledger = appendDisposition(ledger, acceptedFor(2));
    ledger = appendDisposition(ledger, dispositionFor(3, 'invalid'));

    // Replaying the first event after the log has moved on must not
    // re-insert it or disturb the later events.
    expect(appendDisposition(ledger, acceptedFor(1))).toBe(ledger);
    expect(ledger.events).toHaveLength(3);
    expect(appendDisposition(ledger, acceptedFor(1)).events[0]).toBe(snapshot.events[0]);
  });

  it('refuses the same id carrying different content, naming both documents', () => {
    const ledger = ledgerOf(acceptedFor(1));
    const conflict = dispositionFor(1, 'accepted', { decidedAt: '2026-10-03T09:00:00Z' });

    expect(() => appendDisposition(ledger, conflict)).toThrow(FeedbackContractError);
    expect(() => appendDisposition(ledger, conflict)).toThrow(
      /already recorded with different content/,
    );
    // The message must name what was recorded, or the audit trail is
    // not diagnosable from the log alone.
    try {
      appendDisposition(ledger, conflict);
      expect.unreachable('expected a FeedbackContractError');
    } catch (error) {
      const detail = (error as FeedbackContractError).detail as {
        recorded: string;
        received: string;
      };
      expect(detail.recorded).toContain('2026-10-02T09:00:00Z');
      expect(detail.received).toContain('2026-10-03T09:00:00Z');
    }
  });

  it('refuses a conflict rather than letting read order decide the head', () => {
    const ledger = ledgerOf(acceptedFor(1));
    const conflict = dispositionFor(1, 'accepted', { rationale: 'a different reason entirely' });
    expect(() => appendDisposition(ledger, conflict)).toThrow(/depend on the order the log/);
  });

  it('replays a whole stored log through ledgerFromEvents to the same value', () => {
    const ledger = ledgerOf(acceptedFor(1), dispositionFor(2, 'invalid'), needsResearchFor(3));
    const events = ledger.events.map((e) => ({
      sequence: e.sequence,
      disposition: e.disposition,
    }));

    const replayed = ledgerFromEvents(events);
    expect(replayed.events).toHaveLength(3);
    replayed.events.forEach((event, i) => {
      expect(event.disposition.id).toBe(ledger.events[i]!.disposition.id);
    });
  });

  it('re-validates a stored log rather than trusting it', () => {
    const first = acceptedFor(1);
    // A stored log whose first entry claims to be at position 2 is
    // corrupt, and must be refused rather than silently renumbered.
    expect(() =>
      ledgerFromEvents([{ sequence: 2, disposition: first }]),
    ).toThrow(/must equal its 1-based position/);
  });

  it('refuses a stored log whose sequence is internally inconsistent', () => {
    const first = acceptedFor(1);
    const second = dispositionFor(2, 'invalid');
    expect(() =>
      ledgerFromEvents([
        { sequence: 1, disposition: first },
        { sequence: 3, disposition: second },
      ]),
    ).toThrow(FeedbackContractError);
  });
});

describe('corrections and re-disposition', () => {
  it('keeps the superseded event in the history', () => {
    const first = acceptedFor(1);
    const correction = dispositionFor(1, 'invalid', {
      id: SECOND,
      supersedes: first.id,
      decidedAt: '2026-10-09T09:00:00Z',
    });
    const ledger = ledgerOf(first, correction);

    // Issue #64 acceptance criterion: corrections do not lose history.
    const history = dispositionHistory(ledger, findingIdFor(1));
    expect(history).toHaveLength(2);
    expect(history[0]!.disposition.kind).toBe('accepted');
    expect(history[1]!.disposition.kind).toBe('invalid');
    // The superseded event is preserved verbatim. Note the ledger
    // stores its own re-parse of the document rather than the caller's
    // object, so the identity claim is between two *reads* of the
    // log, not between the log and the value that was handed in.
    expect(history[0]!.disposition.rationale).toBe(first.rationale);
    expect(history[0]!.disposition.decidedAt).toBe('2026-10-02T09:00:00Z');
    // A full replay of the log reproduces the superseded event too.
    expect(ledgerFromEvents(ledger.events).events[0]!.disposition).toEqual(history[0]!.disposition);
  });

  it('marks the correction as a correction and the first event as not one', () => {
    const first = acceptedFor(1);
    const ledger = ledgerOf(
      first,
      dispositionFor(1, 'invalid', { id: SECOND, supersedes: first.id }),
    );
    expect(ledger.events[0]!.isCorrection).toBe(false);
    expect(ledger.events[1]!.isCorrection).toBe(true);
  });

  it('makes the last event in append order the current one, whatever decidedAt says', () => {
    const first = acceptedFor(1, { kind: 'issue', reference: 'u-sekai#100' });
    // A reviewer whose clock is skewed records a correction dated
    // *before* the decision it corrects. Append order is the record of
    // what happened; `decidedAt` is a wall clock that can disagree.
    const correction = dispositionFor(1, 'invalid', {
      id: SECOND,
      supersedes: first.id,
      decidedAt: '2026-10-01T00:00:01Z',
    });
    const ledger = ledgerOf(first, correction);

    expect(currentDisposition(ledger, findingIdFor(1))?.kind).toBe('invalid');
    // ...while the time-based reading stays available for analysis.
    expect(dispositionHistory(ledger, findingIdFor(1))).toHaveLength(2);
  });

  it('supports a three-step correction chain with every link intact', () => {
    const first = acceptedFor(1);
    const second = dispositionFor(1, 'invalid', { id: SECOND, supersedes: first.id });
    const third = dispositionFor(1, 'wontFix', { id: THIRD, supersedes: second.id });
    const ledger = ledgerOf(first, second, third);

    expect(dispositionHistory(ledger, findingIdFor(1))).toHaveLength(3);
    expect(currentDisposition(ledger, findingIdFor(1))?.id).toBe(THIRD);
    // Each event points at its own predecessor, not at the head.
    expect(ledger.events[1]!.disposition.supersedes).toBe(first.id);
    expect(ledger.events[2]!.disposition.supersedes).toBe(SECOND);
  });

  it('re-dispositioning forward from an open state is progress, not a correction', () => {
    // `needsHumanResearch -> decided` is the research concluding. It
    // must not require `supersedes`, and must not be counted as a
    // correction, or a finding that took three research rounds would
    // look corrected three times.
    const open = needsResearchFor(1);
    const decided = dispositionFor(1, 'accepted', { id: SECOND });
    const ledger = ledgerOf(open, decided);

    expect(ledger.events[1]!.isCorrection).toBe(false);
    expect(currentDisposition(ledger, findingIdFor(1))?.kind).toBe('accepted');
  });

  it('treats a correction back out of closed as a correction', () => {
    const accepted = acceptedFor(1);
    const closed = dispositionFor(1, 'accepted', { id: SECOND, state: 'closed' });
    const reopened = dispositionFor(1, 'wontFix', { id: THIRD, supersedes: SECOND });
    const ledger = ledgerOf(accepted, closed, reopened);

    expect(ledger.events[1]!.isCorrection).toBe(false);
    expect(ledger.events[2]!.isCorrection).toBe(true);
    expect(currentDisposition(ledger, findingIdFor(1))?.state).toBe('decided');
  });

  it('refuses a correction that does not say which decision it replaces', () => {
    const ledger = ledgerOf(acceptedFor(1));
    expect(() => appendDisposition(ledger, dispositionFor(1, 'invalid', { id: SECOND }))).toThrow(
      /supersedes is required for a correction/,
    );
  });

  it('refuses a correction pointing at anything but the current head', () => {
    const first = acceptedFor(1);
    const second = dispositionFor(1, 'wontFix', { id: SECOND, supersedes: first.id });
    const ledger = ledgerOf(first, second);

    // Pointing at the already-superseded event would assert a chain
    // that never happened.
    expect(() =>
      appendDisposition(ledger, dispositionFor(1, 'invalid', { id: THIRD, supersedes: first.id })),
    ).toThrow(/must be the disposition currently recorded/);
  });

  it('refuses supersedes on forward progress', () => {
    const open = needsResearchFor(1);
    const ledger = ledgerOf(open);
    // `needsHumanResearch -> decided` is forward progress. Asserting a
    // supersedes here would claim a prior decision that was never made.
    expect(() =>
      appendDisposition(
        ledger,
        dispositionFor(1, 'accepted', { id: SECOND, supersedes: open.id }),
      ),
    ).toThrow(/is forward progress, not a correction/);
  });
});

describe('legality is owned by #61, not re-derived here', () => {
  it('re-raises an illegal transition as a feedback error naming the move', () => {
    const ledger = ledgerOf(acceptedFor(1));
    // `unreviewed -> closed` is illegal: there is no such thing as
    // closing a finding nobody looked at. The verdict and the states
    // that were available come from #61's table, verbatim.
    try {
      appendDisposition(ledger, dispositionFor(2, 'accepted', { state: 'closed' }));
      expect.unreachable('expected a FeedbackContractError');
    } catch (error) {
      expect(isFeedbackContractError(error)).toBe(true);
      const detail = (error as FeedbackContractError).detail as Record<string, unknown>;
      expect(detail['fromState']).toBe('unreviewed');
      expect(detail['toState']).toBe('closed');
      expect(detail['causeType']).toBe('ReviewContractError');
    }
  });

  it('surfaces a rejected disposition as a feedback error, not a review error', () => {
    const ledger = emptyLedger();
    // #61 refuses a decided kind in an open state. A caller of this
    // layer catches exactly one error type.
    try {
      appendDisposition(ledger, dispositionInputFor(1, 'accepted', { state: 'needsHumanResearch' }));
      expect.unreachable('expected a FeedbackContractError');
    } catch (error) {
      expect(isFeedbackContractError(error)).toBe(true);
      expect(error).not.toBeInstanceOf(ReviewContractError);
    }
  });
});

describe('deterministic ordering', () => {
  it('returns current dispositions in finding-id order regardless of append order', () => {
    const ledger = ledgerOf(
      dispositionFor(3, 'invalid'),
      dispositionFor(1, 'accepted'),
      dispositionFor(2, 'wontFix'),
    );
    const ids = currentDispositions(ledger).map(([id]) => id);
    expect(ids).toEqual([...ids].sort(compareHandles));
    expect(new Set(ids).size).toBe(3);
  });

  it('keeps only the last event per finding in the current set', () => {
    const first = acceptedFor(1);
    const ledger = ledgerOf(
      dispositionFor(2, 'invalid'),
      first,
      dispositionFor(1, 'wontFix', { id: SECOND, supersedes: first.id }),
    );
    const current = currentDispositions(ledger);
    expect(current).toHaveLength(2);
    expect(currentDisposition(ledger, findingIdFor(1))?.kind).toBe('wontFix');
  });

  it('keys kind counts in DISPOSITION_KINDS order, not insertion order', () => {
    const ledger = ledgerOf(
      dispositionFor(1, 'unresolved'),
      dispositionFor(2, 'accepted'),
      dispositionFor(3, 'wontFix'),
    );
    const counts = eventCountByKind(ledger);

    // The record's key order is part of its contract: a snapshot
    // serialised twice must be byte-identical.
    expect(Object.keys(counts)).toEqual([...DISPOSITION_KINDS]);
    expect(counts.accepted).toBe(1);
    expect(counts.wontFix).toBe(1);
    expect(counts.unresolved).toBe(1);
    expect(counts.invalid).toBe(0);
    expect(counts.alreadyKnown).toBe(0);
    expect(counts.needsHumanResearch).toBe(0);
  });

  it('lists dispositioned finding ids once each, in id order', () => {
    const first = acceptedFor(1);
    const ledger = ledgerOf(
      first,
      dispositionFor(2, 'invalid'),
      dispositionFor(1, 'wontFix', { id: SECOND, supersedes: first.id }),
    );
    const ids = dispositionedFindingIds(ledger);
    expect(ids).toEqual([...ids].sort(compareHandles));
    expect(ids).toEqual([findingIdFor(1), findingIdFor(2)]);
  });

  it('reports no history for a finding nobody dispositioned', () => {
    const ledger = ledgerOf(acceptedFor(1));
    expect(dispositionHistory(ledger, findingIdFor(9))).toEqual([]);
    // `null`, not a synthetic "unreviewed" placeholder: never
    // dispositioned and explicitly unresolved are different facts.
    expect(currentDisposition(ledger, findingIdFor(9))).toBeNull();
  });

  it('produces the same value for the same log on two independent reads', () => {
    const ledger = ledgerOf(acceptedFor(1), unresolvedFor(2), dispositionFor(3, 'wontFix'));
    expect(JSON.stringify(eventCountByKind(ledger))).toBe(
      JSON.stringify(eventCountByKind(ledgerFromEvents(
        ledger.events.map((e) => ({ sequence: e.sequence, disposition: e.disposition })),
      ))),
    );
  });
});

describe('the ledger persists references it does not resolve', () => {
  it('records a disposition for a finding it has never been shown', () => {
    // #61 owns the reference; #64 persists it. Refusing here would make
    // the ledger unusable for a log replayed before the findings it
    // judges have been loaded. The aggregation layer is where a
    // dangling reference becomes a wrong number, and `kpi.test.ts`
    // covers the refusal there.
    const ledger = ledgerOf(acceptedFor(1));
    expect(currentDisposition(ledger, findingIdFor(404))).toBeNull();
    expect(dispositionedFindingIds(ledger)).toEqual([findingIdFor(1)]);
  });

  it('stores its own parse of the document rather than the caller object', () => {
    // Defensive: the ledger must not hold a reference a caller could
    // keep mutating in place, even though `parseDisposition` freezes
    // what it returns.
    const handed = parseDisposition(dispositionInputFor(1, 'accepted'));
    const ledger = appendDisposition(emptyLedger(), handed);
    expect(ledger.events[0]!.disposition).not.toBe(handed);
    expect(ledger.events[0]!.disposition.id).toBe(handed.id);
  });
});
