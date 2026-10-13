/**
 * KPI primitives: the arithmetic of `docs/product/kpis.md`.
 *
 * Issue #64 acceptance criteria covered here:
 *
 * - "Aggregation never treats unresolved findings as accepted." —
 *   `describe('unresolved is a third state')`
 * - "KPI functions define zero/empty-set behavior explicitly." —
 *   `describe('empty and zero-denominator behaviour')`
 *
 * ## The failure these tests exist to catch
 *
 * An acceptance rate is a ratio, and a ratio has three degenerate
 * cases that are easy to collapse into each other by accident:
 *
 * - treating an unresolved finding as accepted → the rate reads 1.0
 *   for a product nobody reviewed;
 * - treating it as rejected → the rate reads 0.0, a *defined* claim
 *   that the customer refused everything;
 * - dropping it from the denominator → same 0.0, and now invisible.
 *
 * The first flatters the product and the last two libel it. The correct
 * answer for "we dispositioned nothing" is that the measurement is
 * *undefined*, and the tests below assert the undefined case
 * specifically rather than only the populated one — an assertion that
 * only checks the happy path is what let the ambiguity exist.
 *
 * The other structural guarantee is that a `SetupFailure` never reaches
 * a product KPI; see `type-separation.test.ts` and the
 * `describe('setup failure containment')` block below.
 */

import { describe, it, expect } from 'vitest';
import { DISPOSITION_KINDS, isSetupFailure } from '../../../src/review/index.js';
import type { Finding, ReviewOutcome } from '../../../src/review/index.js';
import {
  acceptedFindingCount,
  actionRate,
  computeKpiSnapshot,
  costPerAcceptedFinding,
  costPerVerifiedFinding,
  dispositionCoverage,
  falsePositiveRate,
  findingAcceptanceRate,
  FeedbackContractError,
  isFeedbackContractError,
  kpiSnapshotFromOutcomes,
  KPI_RATIO_DECIMALS,
  notAlreadyKnownAcceptedFindingCount,
  parseEvaluationCost,
  roundRatioHalfUp,
  UNCOMPUTED_KPI_TERMS,
} from '../../../src/feedback/index.js';
import {
  acceptedFor,
  dispositionFor,
  dispositionInputFor,
  findingFor,
  findingIdFor,
  findingWithVerification,
  ledgerOf,
  needsResearchFor,
  setupFailureFor,
  unresolvedFor,
  unverifiedFindingFor,
} from './support/fixtures.js';

const dispositionIdFor = (n: number) => dispositionFor(n, 'accepted').id;
const SECOND = 'dsp-000000090002';

/** Depth-first scan for any number that is not finite. */
function nonFiniteNumbers(value: unknown, path = '$', found: string[] = []): string[] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) found.push(`${path} = ${value}`);
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, i) => nonFiniteNumbers(entry, `${path}[${i}]`, found));
    return found;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      nonFiniteNumbers(entry, `${path}.${key}`, found);
    }
  }
  return found;
}

describe('unresolved is a third state, not a missing one', () => {
  it('keeps a never-dispositioned finding out of both the numerator and the denominator', () => {
    // Two accepted, one never looked at.
    const input = { findings: [findingFor(1), findingFor(2), findingFor(3)], ledger: ledgerOf(acceptedFor(1), acceptedFor(2)) };
    const rate = findingAcceptanceRate(input);

    expect(rate.numerator).toBe(2);
    expect(rate.denominator).toBe(2);
    expect(rate.value).toBe(1);
    expect(rate.basis.noDisposition).toBe(1);
    expect(rate.basis.totalFindings).toBe(3);
  });

  it('keeps an unresolved finding out of both the numerator and the denominator', () => {
    // Two accepted, one explicitly recorded as unresolved.
    const input = {
      findings: [findingFor(1), findingFor(2), findingFor(3)],
      ledger: ledgerOf(acceptedFor(1), acceptedFor(2), unresolvedFor(3)),
    };
    const rate = findingAcceptanceRate(input);

    expect(rate.numerator).toBe(2);
    expect(rate.denominator).toBe(2);
    expect(rate.value).toBe(1);
    expect(rate.basis.openDisposition).toBe(1);
    expect(rate.basis.noDisposition).toBe(0);
    // It must not appear among the ids in the numerator.
    expect(rate.numeratorFindingIds).not.toContain(findingIdFor(3));
  });

  it('does not read a ledger of only unresolved findings as "0% accepted"', () => {
    // The load-bearing case. Every one of the three wrong readings
    // produces a number here; the right one produces no number.
    const input = {
      findings: [findingFor(1), findingFor(2)],
      ledger: ledgerOf(unresolvedFor(1), needsResearchFor(2)),
    };
    const rate = findingAcceptanceRate(input);

    expect(rate.denominator).toBe(0);
    expect(rate.value).toBeNull();
    expect(rate.rounded).toBeNull();
    expect(rate.defined).toBe(false);
    expect(rate.reason).toBe('emptyDenominator');
    expect(acceptedFindingCount(input).value).toBe(0);
  });

  it('distinguishes "no decision" from "rejected" on the false-positive rate', () => {
    const input = {
      findings: [findingFor(1), findingFor(2)],
      ledger: ledgerOf(unresolvedFor(1), dispositionFor(2, 'invalid')),
    };
    const rate = falsePositiveRate(input);
    // The unresolved finding is in neither the numerator nor the
    // denominator, so the *only* decision the customer reached was the
    // false positive. Counting it would report 0.5 and understate the
    // false-positive rate against a customer who reviewed one thing.
    expect(rate.numerator).toBe(1);
    expect(rate.denominator).toBe(1);
    expect(rate.value).toBe(1);
    expect(rate.basis.openDisposition).toBe(1);
    expect(rate.numeratorFindingIds).toEqual([findingIdFor(2)]);
  });

  it('does not count alreadyKnown or wontFix as false positives', () => {
    // A service that surfaces only problems the customer already filed
    // would look perfectly precise if these counted as invalid.
    const input = {
      findings: [findingFor(1), findingFor(2), findingFor(3)],
      ledger: ledgerOf(
        dispositionFor(1, 'alreadyKnown'),
        dispositionFor(2, 'wontFix'),
        dispositionFor(3, 'invalid'),
      ),
    };
    const rate = falsePositiveRate(input);
    expect(rate.numerator).toBe(1);
    expect(rate.denominator).toBe(3);
    expect(rate.value).toBeCloseTo(1 / 3, 12);
  });

  it('accounts for every finding in exactly one of the three buckets', () => {
    const input = {
      findings: [findingFor(1), findingFor(2), findingFor(3), findingFor(4), findingFor(5)],
      ledger: ledgerOf(
        acceptedFor(1),
        dispositionFor(2, 'invalid'),
        unresolvedFor(3),
        needsResearchFor(4),
      ),
    };
    const { basis } = findingAcceptanceRate(input);
    expect(basis.customerDecisions + basis.noDisposition + basis.openDisposition).toBe(
      basis.totalFindings,
    );
    expect(basis).toEqual({
      totalFindings: 5,
      customerDecisions: 2,
      noDisposition: 1,
      openDisposition: 2,
    });
  });

  it('reports the three buckets on the snapshot as separate lists', () => {
    const snapshot = computeKpiSnapshot({
      findings: [findingFor(1), findingFor(2), findingFor(3)],
      ledger: ledgerOf(acceptedFor(1), unresolvedFor(2)),
    });
    expect(snapshot.undispositionedFindingIds).toEqual([findingIdFor(3)]);
    expect(snapshot.dispositioned.map(([id]) => id)).toEqual([findingIdFor(1), findingIdFor(2)]);
    // The undispositioned finding is still in the *denominator* of the
    // one KPI whose subject is that it was never looked at.
    expect(snapshot.dispositionCoverage.denominator).toBe(3);
  });

  it('counts an open disposition as coverage, because recording it is feedback', () => {
    const input = {
      findings: [findingFor(1), findingFor(2)],
      ledger: ledgerOf(unresolvedFor(1)),
    };
    const coverage = dispositionCoverage(input);
    expect(coverage.numerator).toBe(1);
    expect(coverage.denominator).toBe(2);
    expect(coverage.value).toBe(0.5);
    // The same figure the snapshot reports — one tally, not two.
    expect(computeKpiSnapshot(input).dispositionCoverage.value).toBe(coverage.value);
  });

  it('lists an open finding in the snapshot dispositions, not only its count', () => {
    // A report enumerating "what did the customer say about each
    // finding" must not omit the ones where the answer was "nobody has
    // decided" — that exclusion would be invisible in the listing.
    const snapshot = computeKpiSnapshot({
      findings: [findingFor(1), findingFor(2)],
      ledger: ledgerOf(unresolvedFor(1)),
    });
    expect(snapshot.dispositioned.map(([id, d]) => [id, d.kind])).toEqual([
      [findingIdFor(1), 'unresolved'],
    ]);
    expect(snapshot.findingAcceptanceRate.basis.openDisposition).toBe(1);
    expect(snapshot.undispositionedFindingIds).toEqual([findingIdFor(2)]);
  });

  it('keeps an unresolved finding out of the accepted set even after reproduction', () => {
    // "Never counted as accepted, at any confidence level and however
    // many identities reproduced the finding."
    const input = {
      findings: [findingFor(1)],
      ledger: ledgerOf(unresolvedFor(1)),
    };
    expect(acceptedFindingCount(input).value).toBe(0);
    expect(acceptedFindingCount(input).findingIds).toEqual([]);
    expect(actionRate(input).defined).toBe(false);
  });
});

describe('empty and zero-denominator behaviour', () => {
  const empty = computeKpiSnapshot({ findings: [], ledger: ledgerOf() });

  it('defines every ratio as undefined rather than NaN, Infinity or 0', () => {
    for (const ratio of [
      empty.findingAcceptanceRate,
      empty.falsePositiveRate,
      empty.actionRate,
      empty.dispositionCoverage,
    ]) {
      expect(ratio.value).toBeNull();
      expect(ratio.rounded).toBeNull();
      expect(ratio.defined).toBe(false);
      expect(ratio.reason).toBe('emptyDenominator');
      expect(ratio.denominator).toBe(0);
    }
  });

  it('defines every count as zero, which is a real measurement', () => {
    expect(empty.acceptedFindingCount.value).toBe(0);
    expect(empty.notAlreadyKnownAcceptedFindingCount.value).toBe(0);
    expect(empty.acceptedFindingCount.findingIds).toEqual([]);
    expect(empty.undispositionedFindingIds).toEqual([]);
    expect(empty.excludedSetupFailures).toEqual([]);
  });

  it('zeroes every kind count with all keys present', () => {
    expect(Object.keys(empty.byKind)).toEqual([...DISPOSITION_KINDS]);
    expect(Object.values(empty.byKind).every((n) => n === 0)).toBe(true);
  });

  it('never produces a non-finite number anywhere in a snapshot', () => {
    // The property, not the individual values: a chart consuming any
    // field of any snapshot must never see NaN or Infinity.
    const inputs = [
      { findings: [], ledger: ledgerOf() },
      { findings: [findingFor(1)], ledger: ledgerOf() },
      { findings: [findingFor(1)], ledger: ledgerOf(unresolvedFor(1)) },
      {
        findings: [findingFor(1)],
        ledger: ledgerOf(acceptedFor(1)),
        evaluationCost: parseEvaluationCost({ amount: 12.5, unit: 'usd.micros' }),
      },
      {
        findings: [findingFor(1)],
        ledger: ledgerOf(acceptedFor(1)),
        evaluationCost: parseEvaluationCost({ amount: 0, unit: 'usd.micros' }),
      },
    ];
    for (const input of inputs) {
      expect(nonFiniteNumbers(computeKpiSnapshot(input))).toEqual([]);
    }
  });

  it('reports "no cost data" separately from "cost but nothing accepted"', () => {
    const noCost = costPerAcceptedFinding({ findings: [findingFor(1)], ledger: ledgerOf() });
    expect(noCost.reason).toBe('noCostData');
    expect(noCost.defined).toBe(false);
    expect(noCost.cost).toBeNull();
    expect(noCost.unit).toBeNull();

    const costNoAcceptance = costPerAcceptedFinding({
      findings: [findingFor(1)],
      ledger: ledgerOf(),
      evaluationCost: parseEvaluationCost({ amount: 10, unit: 'usd.micros' }),
    });
    // A recorded cost divided by zero accepted findings is not
    // Infinity — it is an unmeasured ratio.
    expect(costNoAcceptance.reason).toBe('emptyDenominator');
    expect(costNoAcceptance.value).toBeNull();
    expect(costNoAcceptance.count).toBe(0);
    expect(costNoAcceptance.cost).not.toBeNull();
  });

  it('refuses to round against a zero denominator at all', () => {
    expect(() => roundRatioHalfUp(1, 0, 6)).toThrow(FeedbackContractError);
    expect(() => roundRatioHalfUp(1, 0, 6)).toThrow(/non-zero denominator/);
  });
});

describe('rounding and units', () => {
  it('rounds half-up at the declared precision', () => {
    expect(KPI_RATIO_DECIMALS).toBe(6);
    expect(roundRatioHalfUp(1, 3, 6)).toBe(0.333333);
    expect(roundRatioHalfUp(2, 3, 6)).toBe(0.666667);
    // An exact tie must go up, never to even the way `toFixed` can.
    expect(roundRatioHalfUp(1, 2, 0)).toBe(1);
    expect(roundRatioHalfUp(1, 4, 1)).toBe(0.3);
    expect(roundRatioHalfUp(3, 4, 1)).toBe(0.8);
  });

  it('reports `rounded` alongside the unrounded `value`', () => {
    const rate = findingAcceptanceRate({
      findings: [findingFor(1), findingFor(2), findingFor(3)],
      ledger: ledgerOf(acceptedFor(1), acceptedFor(2), dispositionFor(3, 'invalid')),
    });
    expect(rate.value).toBeCloseTo(2 / 3, 15);
    expect(rate.rounded).toBe(0.666667);
  });

  it('refuses a negative numerator, for which the name would be a lie', () => {
    // `Math.round` is round-half-toward-+Infinity; it is round-half-up
    // only for a non-negative operand. Rather than return a wrong
    // answer, the helper refuses.
    expect(() => roundRatioHalfUp(-1, 2, 0)).toThrow(/round-half-up/);
    expect(() => roundRatioHalfUp(NaN, 2, 0)).toThrow(/finite operands/);
    expect(() => roundRatioHalfUp(1, Infinity, 0)).toThrow(/finite operands/);
  });

  it('echoes the declared cost unit without naming a currency', () => {
    const cost = costPerAcceptedFinding({
      findings: [findingFor(1)],
      ledger: ledgerOf(acceptedFor(1)),
      evaluationCost: parseEvaluationCost({ amount: 4, unit: 'credit.units' }),
    });
    expect(cost.unit).toBe('credit.units/finding');
    expect(cost.value).toBe(4);
    expect(cost.cost?.unit).toBe('credit.units');
  });

  it('refuses a negative, infinite or unitless cost', () => {
    expect(() => parseEvaluationCost({ amount: -1, unit: 'usd' })).toThrow(/must not be negative/);
    expect(() => parseEvaluationCost({ amount: Infinity, unit: 'usd' })).toThrow(/finite/);
    expect(() => parseEvaluationCost({ amount: NaN, unit: 'usd' })).toThrow(/finite/);
    expect(() => parseEvaluationCost({ amount: 1, unit: '  ' })).toThrow(/must not be empty/);
    expect(() => parseEvaluationCost({ amount: 1, unit: 'x'.repeat(41) })).toThrow(/at most 40/);
    expect(() => parseEvaluationCost(5)).toThrow(/must be an object/);
  });

  it('declares the cost precision as unspecified rather than picking one', () => {
    // The doc names no unit, so this ticket must not assert a scale.
    const terms = UNCOMPUTED_KPI_TERMS.map((t) => t.term);
    expect(terms).toContain('the reportable precision of a cost-per-finding');
    expect(terms).toContain('the currency and scale of "direct evaluation cost"');
    for (const term of UNCOMPUTED_KPI_TERMS) {
      expect(term.clause).not.toBe('');
      expect(term.why).not.toBe('');
      expect(term.needs).not.toBe('');
    }
  });
});

describe('determinism', () => {
  const findings = [findingFor(1), findingFor(2), findingFor(3), findingFor(4)];
  const ledger = ledgerOf(
    acceptedFor(1, { kind: 'issue', reference: 'u-sekai#1' }),
    dispositionFor(2, 'invalid'),
    unresolvedFor(3),
    dispositionFor(4, 'wontFix'),
  );

  it('is permutation-invariant in the findings array, including key order', () => {
    const order = [findings[3]!, findings[1]!, findings[0]!, findings[2]!];
    const a = computeKpiSnapshot({ findings, ledger, evaluationCost: parseEvaluationCost({ amount: 9, unit: 'u' }) });
    const b = computeKpiSnapshot({ findings: order, ledger, evaluationCost: parseEvaluationCost({ amount: 9, unit: 'u' }) });

    // JSON.stringify rather than toEqual: the record key order is part
    // of the contract, and toEqual would not notice it changing.
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('is invariant to the order dispositions were appended in', () => {
    const a = computeKpiSnapshot({ findings, ledger });
    const b = computeKpiSnapshot({
      findings,
      ledger: ledgerOf(
        dispositionFor(4, 'wontFix'),
        unresolvedFor(3),
        acceptedFor(1, { kind: 'issue', reference: 'u-sekai#1' }),
        dispositionFor(2, 'invalid'),
      ),
    });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('keys the kind breakdown in DISPOSITION_KINDS order', () => {
    const snapshot = computeKpiSnapshot({ findings, ledger });
    expect(Object.keys(snapshot.byKind)).toEqual([...DISPOSITION_KINDS]);
    expect(snapshot.byKind.accepted).toBe(1);
    expect(snapshot.byKind.invalid).toBe(1);
    expect(snapshot.byKind.wontFix).toBe(1);
    // Open kinds have no current *kind* in a customer-decision
    // breakdown, so they stay zero rather than appearing.
    expect(snapshot.byKind.unresolved).toBe(0);
  });

  it('returns sorted id lists rather than input order', () => {
    const snapshot = computeKpiSnapshot({ findings, ledger });
    const ids = snapshot.dispositioned.map(([id]) => id);
    expect(ids).toEqual([...ids].sort());
    const numerator = snapshot.findingAcceptanceRate.numeratorFindingIds;
    expect(numerator).toEqual([...numerator].sort());
  });

  it('returns no Map, whose iteration order is insertion order', () => {
    const snapshot = computeKpiSnapshot({ findings, ledger });
    const walk = (value: unknown): void => {
      if (value instanceof Map || value instanceof Set) {
        expect.unreachable('a snapshot leaked a Map/Set, whose key order is insertion order');
      }
      if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === 'object') {
        Object.values(value as Record<string, unknown>).forEach(walk);
      }
    };
    walk(snapshot);
  });

  it('freezes the snapshot so a shared report cannot be mutated', () => {
    const snapshot = computeKpiSnapshot({ findings, ledger });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.byKind)).toBe(true);
    expect(Object.isFrozen(snapshot.findingAcceptanceRate)).toBe(true);
  });
});

describe('the ratios the metric doc actually defines', () => {
  it('computes acceptance as accepted over customer-decided', () => {
    const rate = findingAcceptanceRate({
      findings: [findingFor(1), findingFor(2), findingFor(3)],
      ledger: ledgerOf(acceptedFor(1), acceptedFor(2), dispositionFor(3, 'wontFix')),
    });
    expect(rate.value).toBeCloseTo(2 / 3, 12);
  });

  it('makes the action rate conditional on acceptance, not on all decisions', () => {
    // Denominator is the accepted set: a decision the customer refused
    // is not a finding that failed to produce a follow-up.
    const rate = actionRate({
      findings: [findingFor(1), findingFor(2), findingFor(3)],
      ledger: ledgerOf(
        acceptedFor(1, { kind: 'change', reference: 'u-sekai#2' }),
        acceptedFor(2),
        dispositionFor(3, 'invalid'),
      ),
    });
    expect(rate.numerator).toBe(1);
    expect(rate.denominator).toBe(2);
    expect(rate.value).toBe(0.5);
  });

  it('counts only confirmed verification passes as verified', () => {
    const findings = [
      findingWithVerification(1, 'confirmed'),
      findingWithVerification(2, 'refuted'),
      findingWithVerification(3, 'inconclusive'),
      findingWithVerification(4, 'notRun'),
      unverifiedFindingFor(5),
    ];
    const cost = parseEvaluationCost({ amount: 10, unit: 'u' });
    expect(costPerVerifiedFinding({ findings, ledger: ledgerOf(), evaluationCost: cost }).count).toBe(1);
    // Denominator is every finding, not the dispositioned subset: the
    // stated purpose is routing spend before disposition exists.
    expect(costPerVerifiedFinding({ findings, ledger: ledgerOf(), evaluationCost: cost }).value).toBe(10);
  });

  it('excludes a finding ever marked alreadyKnown, even after a later acceptance', () => {
    // "Not already known" is not in the current disposition; it is in
    // the history. Read from the head it would be vacuously "accepted".
    const first = dispositionFor(1, 'alreadyKnown');
    const second = dispositionFor(1, 'accepted', { id: SECOND, supersedes: first.id });
    const input = {
      findings: [findingFor(1), findingFor(2)],
      ledger: ledgerOf(first, second, acceptedFor(2)),
    };

    expect(acceptedFindingCount(input).value).toBe(2);
    expect(notAlreadyKnownAcceptedFindingCount(input).value).toBe(1);
    expect(notAlreadyKnownAcceptedFindingCount(input).findingIds).toEqual([findingIdFor(2)]);
  });

  it('counts an accepted finding never previously flagged as not-already-known', () => {
    const input = {
      findings: [findingFor(1)],
      ledger: ledgerOf(acceptedFor(1)),
    };
    expect(notAlreadyKnownAcceptedFindingCount(input).value).toBe(1);
  });
});

describe('setup failure containment', () => {
  const finding = findingFor(1);
  const failure = setupFailureFor(1);

  it('splits a mixed outcome stream and counts what it excluded', () => {
    const outcomes: ReadonlyArray<ReviewOutcome> = [finding, failure];
    const snapshot = kpiSnapshotFromOutcomes(outcomes, ledgerOf(acceptedFor(1)));

    expect(snapshot.excludedSetupFailures).toHaveLength(1);
    expect(snapshot.excludedSetupFailures[0]!.id).toBe(failure.id);
    // The KPI is over the one finding, not over two outcomes.
    expect(snapshot.findingAcceptanceRate.denominator).toBe(1);
    expect(snapshot.findingAcceptanceRate.basis.totalFindings).toBe(1);
  });

  it('refuses a findings array carrying a setup failure', () => {
    // The runtime backstop for the one caller the type system cannot
    // reach: untyped JSON, a hand-rolled narrowing, or `any`.
    const contaminated = [finding, failure] as unknown as ReadonlyArray<Finding>;
    expect(() =>
      computeKpiSnapshot({ findings: contaminated, ledger: ledgerOf(acceptedFor(1)) }),
    ).toThrow(/is a SetupFailure/);
    expect(() =>
      computeKpiSnapshot({ findings: contaminated, ledger: ledgerOf(acceptedFor(1)) }),
    ).toThrow(/never enter a product KPI/);
  });

  it('refuses an outcome that is neither a finding nor a setup failure', () => {
    expect(() => kpiSnapshotFromOutcomes([{ outcome: 'somethingElse' }], ledgerOf())).toThrow(
      /neither a Finding nor a SetupFailure/,
    );
    expect(() => kpiSnapshotFromOutcomes([42], ledgerOf())).toThrow(FeedbackContractError);
  });

  it('leaves the setup failure out of every denominator', () => {
    const snapshot = kpiSnapshotFromOutcomes(
      [finding, failure],
      ledgerOf(acceptedFor(1)),
    );
    const bases = [
      snapshot.findingAcceptanceRate.basis,
      snapshot.falsePositiveRate.basis,
      snapshot.actionRate.basis,
      snapshot.dispositionCoverage.basis,
      snapshot.acceptedFindingCount.basis,
    ];
    for (const basis of bases) {
      expect(basis.totalFindings).toBe(1);
      expect(basis.customerDecisions + basis.noDisposition + basis.openDisposition).toBe(1);
    }
  });
});

describe('a ledger reference the aggregation cannot resolve', () => {
  it('refuses rather than silently measuring a subset', () => {
    // A ledger can legitimately outlive the findings array it is
    // queried with; the honest answer is an error naming the orphan,
    // not a rate computed over a subset nobody chose.
    expect(() =>
      computeKpiSnapshot({ findings: [findingFor(1)], ledger: ledgerOf(acceptedFor(1), acceptedFor(2)) }),
    ).toThrow(/is not in the aggregation input/);
  });

  it('refuses a duplicate finding id as a feedback error, not a review error', () => {
    const duplicated = [findingFor(1), findingFor(1)] as ReadonlyArray<Finding>;
    try {
      computeKpiSnapshot({ findings: duplicated, ledger: ledgerOf(acceptedFor(1)) });
      expect.unreachable('expected a FeedbackContractError');
    } catch (error) {
      expect(isFeedbackContractError(error)).toBe(true);
      expect((error as FeedbackContractError).message).toMatch(/duplicate finding id/);
    }
  });
});

describe('the snapshot is internally consistent', () => {
  it('computes every KPI from one tally', () => {
    // Two independent calls into the same ledger inside one report
    // cannot disagree; the snapshot is a single derivation.
    const findings = [findingFor(1), findingFor(2), findingFor(3)];
    const ledger = ledgerOf(
      acceptedFor(1, { kind: 'issue', reference: 'u-sekai#1' }),
      dispositionFor(2, 'invalid'),
      unresolvedFor(3),
    );
    const snapshot = computeKpiSnapshot({ findings, ledger });

    expect(snapshot.findingAcceptanceRate.value).toBe(snapshot.findingAcceptanceRate.numerator / 2);
    expect(snapshot.falsePositiveRate.value).toBe(0.5);
    expect(snapshot.actionRate.value).toBe(1);
    // Every finding has at least one recorded disposition, including
    // the unresolved one, so coverage is 1 — not 2/3.
    expect(snapshot.dispositionCoverage.value).toBe(1);
    expect(snapshot.costPerAcceptedFinding.count).toBe(
      snapshot.acceptedFindingCount.value,
    );
  });

  it('is frozen and independent of a later mutation of its inputs', () => {
    const findings = [findingFor(1)];
    const snapshot = computeKpiSnapshot({ findings, ledger: ledgerOf(acceptedFor(1)) });
    expect(() => {
      (findings as Finding[]).push(findingFor(2));
    }).not.toThrow();
    expect(snapshot.findingAcceptanceRate.basis.totalFindings).toBe(1);
  });

  it('rejects a non-disposition with this layer error type, not #61s', () => {
    const notADisposition = setupFailureFor(2);
    // A setup failure is not a disposition; the ledger must say so
    // with this layer's error type rather than #61's, so a caller has
    // one `catch` clause.
    try {
      computeKpiSnapshot({
        findings: [findingFor(1)],
        ledger: ledgerOf(notADisposition as never),
      });
      expect.unreachable('expected a FeedbackContractError');
    } catch (error) {
      expect(isFeedbackContractError(error)).toBe(true);
    }
    expect(isSetupFailure(notADisposition)).toBe(true);
    expect(dispositionInputFor(1, 'accepted').kind).toBe('accepted');
    expect(dispositionIdFor(1)).toBe(dispositionInputFor(1, 'accepted')['id']);
  });
});
