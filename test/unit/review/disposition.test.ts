/**
 * Disposition contract: the vocabulary, the state machine, and the
 * guards that keep a KPI-corrupting value from being constructible.
 *
 * Issue #61 acceptance criteria covered here:
 * - "Customer disposition is distinct from model confidence."
 * - "Unit tests cover schema validation, evidence requirement, and
 *   longitudinal references" (longitudinal is `longitudinal.test.ts`).
 *
 * The transition table itself is exercised exhaustively below rather
 * than by sampling, because "which transitions are legal" is the whole
 * content of the state machine and a sampled table is a table nobody
 * has checked.
 */

import { describe, it, expect } from 'vitest';
import {
  assertDispositionTransition,
  DECIDED_DISPOSITION_KINDS,
  DISPOSITION_STATES,
  DISPOSITION_TRANSITIONS,
  INITIAL_DISPOSITION_STATE,
  isCustomerDecision,
  isDispositionCorrection,
  isLegalDispositionTransition,
  isOpenDisposition,
  nextDispositionStates,
  OPEN_DISPOSITION_KINDS,
  parseDisposition,
  ReviewContractError,
} from '../../../src/review/index.js';
import { dispositionInput } from './support/fixtures.js';

const ALL_KINDS = [...DECIDED_DISPOSITION_KINDS, ...OPEN_DISPOSITION_KINDS];

describe('the transition table is total and closed', () => {
  it('lists every declared state', () => {
    for (const state of DISPOSITION_STATES) {
      expect(DISPOSITION_TRANSITIONS[state]).toBeDefined();
    }
    expect(Object.keys(DISPOSITION_TRANSITIONS).sort()).toEqual([...DISPOSITION_STATES].sort());
  });

  it('never lists a target state that is not declared', () => {
    for (const state of DISPOSITION_STATES) {
      for (const next of DISPOSITION_TRANSITIONS[state]) {
        expect(DISPOSITION_STATES).toContain(next);
      }
    }
  });

  it('gives every state at least one way out, so a finding can never be stranded', () => {
    for (const state of DISPOSITION_STATES) {
      expect(DISPOSITION_TRANSITIONS[state].length).toBeGreaterThan(0);
    }
  });

  it('refuses an illegal transition instead of silently accepting it', () => {
    for (const from of DISPOSITION_STATES) {
      for (const to of DISPOSITION_STATES) {
        const legal = DISPOSITION_TRANSITIONS[from].includes(to);
        expect(isLegalDispositionTransition(from, to)).toBe(legal);
        if (legal) {
          expect(() => assertDispositionTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertDispositionTransition(from, to)).toThrow(ReviewContractError);
        }
      }
    }
  });

  it('refuses to close a finding nobody has looked at', () => {
    expect(isLegalDispositionTransition('unreviewed', 'closed')).toBe(false);
    expect(() => assertDispositionTransition('unreviewed', 'closed')).toThrow(
      /illegal disposition transition unreviewed -> closed/,
    );
  });

  it('allows a decision to be corrected, and says so', () => {
    expect(isLegalDispositionTransition('decided', 'decided')).toBe(true);
    expect(isDispositionCorrection('decided', 'decided')).toBe(true);
    expect(isDispositionCorrection('closed', 'decided')).toBe(true);
  });

  it('does not call reaching a decision for the first time a correction', () => {
    // Three rounds of research then a decision is one decision, not
    // three corrections. Counting it as a correction would make a
    // slowly-reviewed finding look repeatedly reversed.
    expect(isDispositionCorrection('unreviewed', 'decided')).toBe(false);
    expect(isDispositionCorrection('needsHumanResearch', 'decided')).toBe(false);
    expect(isLegalDispositionTransition('needsHumanResearch', 'decided')).toBe(true);
  });

  it('does not call escalation to research a correction', () => {
    expect(isDispositionCorrection('decided', 'needsHumanResearch')).toBe(false);
    expect(isDispositionCorrection('unreviewed', 'needsHumanResearch')).toBe(false);
  });

  it('allows a closed decision to be reopened', () => {
    expect(isLegalDispositionTransition('closed', 'decided')).toBe(true);
    expect(isLegalDispositionTransition('closed', 'needsHumanResearch')).toBe(true);
  });

  it('names the legal successors in the failure message', () => {
    expect(() => assertDispositionTransition('unreviewed', 'closed')).toThrow(
      /allowed from unreviewed: decided, needsHumanResearch/,
    );
  });

  it('starts a finding unreviewed', () => {
    expect(INITIAL_DISPOSITION_STATE).toBe('unreviewed');
    expect(nextDispositionStates(INITIAL_DISPOSITION_STATE)).toEqual([
      'decided',
      'needsHumanResearch',
    ]);
  });
});

describe('a materialised disposition is never unreviewed', () => {
  it('rejects the unreviewed state', () => {
    expect(() => parseDisposition(dispositionInput({ state: 'unreviewed' }))).toThrow(
      /state must be one of: needsHumanResearch, decided, closed/,
    );
  });
});

describe('kind and state must agree', () => {
  it('rejects an unresolved kind claiming to be a decision', () => {
    expect(() =>
      parseDisposition(dispositionInput({ kind: 'unresolved', state: 'decided' })),
    ).toThrow(/means no decision has been reached/);
    expect(() =>
      parseDisposition(dispositionInput({ kind: 'unresolved', state: 'closed' })),
    ).toThrow(/means no decision has been reached/);
  });

  it('rejects a decided kind parked in the open state', () => {
    for (const kind of DECIDED_DISPOSITION_KINDS) {
      expect(() =>
        parseDisposition(
          dispositionInput({
            kind,
            state: 'needsHumanResearch',
            ...(kind === 'accepted' ? {} : { rationale: 'because' }),
          }),
        ),
      ).toThrow(/is a decision, so it cannot carry state "needsHumanResearch"/);
    }
  });

  it('accepts each open kind in the open state', () => {
    for (const kind of OPEN_DISPOSITION_KINDS) {
      const d = parseDisposition(
        dispositionInput({ kind, state: 'needsHumanResearch', rationale: 'needs a human' }),
      );
      expect(d.kind).toBe(kind);
      expect(d.state).toBe('needsHumanResearch');
    }
  });

  it('accepts each decided kind in the decided state', () => {
    for (const kind of DECIDED_DISPOSITION_KINDS) {
      const d = parseDisposition(
        dispositionInput({ kind, state: 'decided', rationale: 'because' }),
      );
      expect(d.kind).toBe(kind);
      expect(isCustomerDecision(d)).toBe(true);
    }
  });

  it('never reports an open kind as a customer decision', () => {
    for (const kind of OPEN_DISPOSITION_KINDS) {
      const d = parseDisposition(
        dispositionInput({ kind, state: 'needsHumanResearch', rationale: 'undecided' }),
      );
      expect(isOpenDisposition(kind)).toBe(true);
      expect(isCustomerDecision(d)).toBe(false);
    }
  });

  it('classifies every declared kind as exactly one of decided or open', () => {
    for (const kind of ALL_KINDS) {
      const decided = (DECIDED_DISPOSITION_KINDS as ReadonlyArray<string>).includes(kind);
      expect(decided).toBe(!isOpenDisposition(kind));
    }
  });
});

describe('dismissals must say why', () => {
  for (const kind of ['invalid', 'alreadyKnown', 'wontFix'] as const) {
    it(`requires a rationale for "${kind}"`, () => {
      const input = dispositionInput({ kind });
      delete input['rationale'];
      expect(() => parseDisposition(input)).toThrow(
        new RegExp(`rationale is required for kind "${kind}"`),
      );
    });
  }

  it('accepts an accepted disposition with no rationale', () => {
    const input = dispositionInput({ kind: 'accepted' });
    delete input['rationale'];
    const d = parseDisposition(input);
    expect('rationale' in d).toBe(false);
  });

  it('rejects an empty rationale', () => {
    expect(() => parseDisposition(dispositionInput({ rationale: '  ' }))).toThrow(
      /rationale must not be empty/,
    );
  });
});

describe('automation may not decide', () => {
  for (const kind of DECIDED_DISPOSITION_KINDS) {
    it(`refuses to let automation record "${kind}"`, () => {
      expect(() =>
        parseDisposition(
          dispositionInput({
            kind,
            actor: { kind: 'automation', reference: 'triage-classifier-v2' },
            rationale: 'because',
          }),
        ),
      ).toThrow(/automation may not record kind/);
    });
  }

  it('lets automation escalate to human research', () => {
    const d = parseDisposition(
      dispositionInput({
        kind: 'needsHumanResearch',
        state: 'needsHumanResearch',
        actor: { kind: 'automation', reference: 'triage-classifier-v2' },
        rationale: 'Confidence below the review threshold.',
      }),
    );
    expect(d.actor.kind).toBe('automation');
    expect(isCustomerDecision(d)).toBe(false);
  });

  it('lets a reviewer, not just a customer, record a decision', () => {
    const d = parseDisposition(
      dispositionInput({ actor: { kind: 'reviewer', reference: 'reviewer@example.test' } }),
    );
    expect(d.actor.kind).toBe('reviewer');
  });
});

describe('a disposition is a reference, never a copy', () => {
  it('carries a finding id and nothing describing the finding', () => {
    const d = parseDisposition(dispositionInput());
    expect(d.findingId).toBe('fnd-0000abcd');
    expect(Object.keys(d).sort()).toEqual(
      [
        'action',
        'actor',
        'decidedAt',
        'findingId',
        'id',
        'kind',
        'rationale',
        'state',
      ].filter((k) => k in d).sort(),
    );
  });

  it('refuses a confidence field — confidence is the producer\'s, not the customer\'s', () => {
    expect(() => parseDisposition(dispositionInput({ confidence: { level: 'high' } }))).toThrow(
      /unknown field\(s\): confidence/,
    );
  });

  it('refuses a severity field copied off the finding', () => {
    expect(() => parseDisposition(dispositionInput({ severity: 'high' }))).toThrow(
      /unknown field\(s\): severity/,
    );
  });

  it('refuses an evidenceRefs copy that could drift from the finding', () => {
    expect(() => parseDisposition(dispositionInput({ evidenceRefs: [] }))).toThrow(
      /unknown field\(s\): evidenceRefs/,
    );
  });
});

describe('disposition schema validation', () => {
  it('accepts a complete disposition', () => {
    const d = parseDisposition(dispositionInput());
    expect(d.id).toBe('dsp-0000abcd');
    expect(d.kind).toBe('accepted');
    expect(d.state).toBe('decided');
    expect(d.decidedAt).toBe('2026-10-02T09:00:00Z');
    expect(Object.isFrozen(d)).toBe(true);
  });

  it('rejects a finding id that is not a finding id', () => {
    expect(() => parseDisposition(dispositionInput({ findingId: 'finding-1' }))).toThrow(
      /findingId must match/,
    );
  });

  it('rejects a disposition id that is not a disposition id', () => {
    expect(() => parseDisposition(dispositionInput({ id: 'fnd-0000abcd' }))).toThrow(
      /id must match/,
    );
  });

  it('rejects a decidedAt that is not an instant', () => {
    expect(() => parseDisposition(dispositionInput({ decidedAt: 'yesterday' }))).toThrow(
      /decidedAt must be an ISO-8601 instant/,
    );
  });

  it('rejects an unknown disposition kind', () => {
    expect(() => parseDisposition(dispositionInput({ kind: 'acknowledged' }))).toThrow(
      /kind must be one of/,
    );
  });

  it('rejects a disposition that supersedes itself', () => {
    expect(() =>
      parseDisposition(dispositionInput({ supersedes: 'dsp-0000abcd' })),
    ).toThrow(/must not be the disposition's own id/);
  });

  it('accepts a correction that supersedes an earlier disposition', () => {
    const d = parseDisposition(
      dispositionInput({ id: 'dsp-0000ffff', kind: 'invalid', supersedes: 'dsp-0000abcd' }),
    );
    expect(d.supersedes).toBe('dsp-0000abcd');
  });

  it('accepts an opaque action reference without adopting a tracker grammar', () => {
    const d = parseDisposition(
      dispositionInput({
        action: { kind: 'issue', reference: 'https://tracker.example.test/U-1' },
      }),
    );
    expect(d.action?.kind).toBe('issue');
    expect(d.action?.reference).toBe('https://tracker.example.test/U-1');
  });

  it('rejects an action with no reference', () => {
    expect(() =>
      parseDisposition(dispositionInput({ action: { kind: 'issue' } })),
    ).toThrow(/action.reference/);
  });

  it('rejects an unknown action kind', () => {
    expect(() =>
      parseDisposition(dispositionInput({ action: { kind: 'tweet', reference: 'x' } })),
    ).toThrow(/action.kind must be one of/);
  });

  it('rejects an empty actor reference', () => {
    expect(() =>
      parseDisposition(dispositionInput({ actor: { kind: 'customer', reference: '' } })),
    ).toThrow(/actor.reference must not be empty/);
  });
});
