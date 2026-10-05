/**
 * KPI primitives — the arithmetic that decides whether u-sekai is a
 * useful evaluation service or an expensive stream of AI opinions
 * (issue #64, `docs/product/kpis.md`, ADR-0011).
 *
 * ## Every number here comes from a clause of `docs/product/kpis.md`
 *
 * The metric doc is the specification; this file is its transcription
 * into arithmetic. Each function's docstring names the clause it comes
 * from, and where the doc does **not** define something precisely, this
 * file says so rather than substituting a plausible formula — see
 * `UNCOMPUTED_KPI_TERMS`. The doc is explicit that "Numeric targets
 * should be calibrated from real design-partner data rather than
 * invented before a baseline exists", so nothing here asserts a
 * target, a threshold or a business number.
 *
 * ## Unresolved is a third state, not a missing one
 *
 * The acceptance criterion "aggregation never treats unresolved findings
 * as accepted" is met structurally, in three layers, not by one `if`:
 *
 * 1. **#61's construction rule.** `parseDisposition` refuses a
 *    `Disposition` whose `kind` is `unresolved` or `needsHumanResearch`
 *    while carrying state `decided`. A disposition cannot claim to be a
 *    decision while its kind says no decision was reached.
 * 2. **#61's predicate.** `isCustomerDecision` is `true` only for
 *    state `decided`/`closed` with a decided kind. This module never
 *    re-derives it — it is imported, not reimplemented.
 * 3. **The denominators below.** Every ratio the doc defines over
 *    *dispositioned* findings divides by the customer-decision count,
 *    so an open finding is in neither the numerator nor the
 *    denominator.
 *
 * But excluding an open finding is only correct if the exclusion is
 * *visible*. A denominator that quietly shrank is the failure mode
 * #61's `resolveAllDispositionLineages` warns about, so every result
 * carries a `basis` that accounts for **all** findings:
 *
 * ```text
 * totalFindings === customerDecisions + noDisposition + openDisposition
 * ```
 *
 * `assertBasisAccountsForEveryFinding` enforces that identity on every
 * aggregation, so a future change that drops a finding from the
 * accounting fails loudly instead of quietly flattering a rate.
 * `dispositionCoverage` is the one KPI whose denominator *is* every
 * finding, so the undispositioned ones are its subject rather than an
 * exclusion from it.
 *
 * ## Units and rounding are declared, not implied
 *
 * - A **count** is a non-negative integer. No rounding.
 * - A **ratio** is a unitless number in `[0, 1]`.
 * - A **cost-per-finding** is `<cost unit> / finding`, where the unit is
 *   supplied by the caller and echoed back unchanged. ADR-0011 requires
 *   provider neutrality, so this file never names a currency.
 *
 * Every ratio is derived from two non-negative operands, and rounding
 * is applied to `numerator * 10^d / denominator` rather than to a
 * pre-divided double. `Math.round` on a non-negative value is
 * round-half-up — a total, locale-independent rule that never falls
 * back to "round to even" the way `toFixed` can — so `rounded` is
 * identical on every platform and every run. The scaled product is
 * exact for any integer count; for a caller-supplied cost it is exact
 * only while it stays within the exactly-representable integer range.
 * See `roundRatioHalfUp` for both bounds.
 *
 * ## Empty denominators are `null`, never `NaN` and never skipped
 *
 * `0 / 0` is `NaN` and `n / 0` is `Infinity`, and both are the worst
 * possible values for a metric that reaches a chart: a `NaN` row
 * usually renders as a gap, and an `Infinity` row often renders as
 * "infinite cost", which reads as a product failure rather than an
 * absence of data. So a KPI with an empty denominator returns
 * `value: null` with `defined: false` and a named `reason`, and the
 * aggregate still returns a complete, fully zero-filled result — a
 * consumer gets a row it can render as "no data", never a missing one.
 * `roundRatioHalfUp` throws on a zero denominator rather than
 * returning a number, so the undefined case cannot be reached by
 * accident through a helper.
 *
 * ## Determinism
 *
 * Two guarantees, both testable:
 *
 * - **Permutation invariance.** `findings` is sorted by id on entry, so
 *   the same set in a different array order produces an identical
 *   result. Any aggregation that inherited insertion order would make
 *   "identical input" depend on how a run happened to emit its results.
 * - **Total order on every key.** Records are built by inserting keys
 *   in a declared order — `DISPOSITION_KINDS` for kind counts, sorted
 *   finding ids for per-finding breakdowns — never by insertion order.
 *   No `Map` is ever returned, because a `Map`'s iteration order *is*
 *   insertion order and would leak the sort straight back out.
 *
 * ## What is deliberately not here
 *
 * No business target, no threshold, no pass/fail verdict, and no
 * cross-KPI aggregate. A KPI that says `0.62` is a measurement; a
 * function that says `0.62 is bad` is a business decision, and the
 * metric doc defers those until design-partner data exists.
 */

import { indexFindings, isCustomerDecision } from '../review/index.js';
import type { Disposition, DispositionKind, Finding, SetupFailure } from '../review/index.js';
import { assertFindingSet, splitReviewOutcomes } from './aggregate.js';
import { FeedbackContractError, asFeedbackContractError } from './errors.js';
import {
  compareHandles,
  currentDispositions,
  emptyKindCounts,
  type DispositionLedger,
} from './ledger.js';
import {
  requireNonEmptyString,
  requireNonNegativeFinite,
  requireRecord,
} from './validation.js';

/** Decimal places every `rounded` ratio and cost figure is reported at. */
export const KPI_RATIO_DECIMALS = 6;

/**
 * Direct evaluation cost for a measurement window.
 *
 * `docs/product/kpis.md` defines the numerator of both cost KPIs as
 * "Direct model, browser/execution, storage, and provider cost per
 * Evaluation Run and Review Program period" — a *quantity in an
 * unstated unit*. The doc deliberately does not name a currency, and
 * ADR-0011 requires provider neutrality, so `unit` is an opaque caller
 * label echoed into the result rather than parsed. Two
 * `EvaluationCost`s in different units are not comparable, and this
 * type does not pretend to make them so.
 */
export interface EvaluationCost {
  readonly amount: number;
  /** Opaque declared unit, e.g. `usd.micros`. Never parsed. */
  readonly unit: string;
}

export const MAX_COST_UNIT_LENGTH = 40;

/** Parse and bound a cost figure supplied by the caller. */
export function parseEvaluationCost(input: unknown, field = 'evaluationCost'): EvaluationCost {
  const raw = requireRecord(input, field);
  return Object.freeze({
    amount: requireNonNegativeFinite(raw['amount'], `${field}.amount`),
    unit: requireNonEmptyString(raw['unit'], `${field}.unit`, MAX_COST_UNIT_LENGTH),
  });
}

/** Inputs shared by every KPI. */
export interface KpiInput {
  /** The product findings under measurement. Never contains a setup failure. */
  readonly findings: ReadonlyArray<Finding>;
  /** The disposition log to read current decisions from. */
  readonly ledger: DispositionLedger;
  /**
   * Direct evaluation cost for this window, when cost data exists.
   *
   * The cost KPIs return `reason: 'noCostData'` when this is absent,
   * which is distinct from `reason: 'emptyDenominator'`: "we did not
   * record the cost" and "we recorded a cost but accepted nothing" are
   * different findings about the service.
   */
  readonly evaluationCost?: EvaluationCost | undefined;
}

/**
 * Why a KPI has no value. Named, never inferred by the consumer: a
 * chart that renders `null` needs to know which of the two it is.
 */
export type UndefinedKpiReason = 'emptyDenominator' | 'noCostData';

/**
 * How a denominator was assembled.
 *
 * Present on every result so that "the rate went up" is always
 * answerable as "the rate went up, or the denominator changed" — the
 * first question about any rate, and the one a bare `0.62` cannot
 * answer.
 */
export interface DispositionBasis {
  /** Every finding handed to the aggregation. */
  readonly totalFindings: number;
  /**
   * Findings whose current disposition is a customer decision. This is
   * the denominator of every rate the doc defines over *dispositioned*
   * findings.
   */
  readonly customerDecisions: number;
  /** Findings with no disposition event at all. */
  readonly noDisposition: number;
  /**
   * Findings whose current disposition is open — `unresolved` or
   * `needsHumanResearch`. Never counted as accepted, at any confidence
   * level and however many identities reproduced the finding.
   */
  readonly openDisposition: number;
}

/** A unitless ratio in `[0, 1]`. */
export interface RatioKpi {
  readonly numerator: number;
  readonly denominator: number;
  /** `numerator / denominator`, or `null` when the denominator is 0. */
  readonly value: number | null;
  /** `value` rounded half-up to `KPI_RATIO_DECIMALS`. */
  readonly rounded: number | null;
  readonly defined: boolean;
  readonly reason?: UndefinedKpiReason;
  readonly basis: DispositionBasis;
  /** The finding ids in the numerator, in id order. */
  readonly numeratorFindingIds: ReadonlyArray<string>;
}

/** A count. Not a ratio; never rounded, never divided. */
export interface CountKpi {
  readonly value: number;
  readonly basis: DispositionBasis;
  /** The contributing finding ids, in id order. */
  readonly findingIds: ReadonlyArray<string>;
}

/** A cost per finding, in the caller's declared cost unit. */
export interface CostPerFindingKpi {
  readonly cost: EvaluationCost | null;
  readonly count: number;
  /** `cost.amount / count`, or `null` when there is no cost or no count. */
  readonly value: number | null;
  readonly rounded: number | null;
  readonly defined: boolean;
  readonly reason?: UndefinedKpiReason;
  /** `<cost unit> / finding`, or `null` when there is no cost data. */
  readonly unit: string | null;
}

// ---------------------------------------------------------------------------
// Customer-value KPIs
// ---------------------------------------------------------------------------

/**
 * `accepted findings / dispositioned findings`.
 *
 * Source: `docs/product/kpis.md`, *Customer-value KPIs → Finding
 * acceptance rate*.
 *
 * "Dispositioned" is read as *carries a customer decision*
 * (`isCustomerDecision`), not as *has a row in the log*. A finding
 * whose only disposition is `unresolved` has not been dispositioned in
 * the sense this ratio requires, and counting it in the denominator
 * would make an unreviewed product look like a rejected one.
 */
export function findingAcceptanceRate(input: KpiInput): RatioKpi {
  return acceptanceRateOf(tallyDecisions(input));
}

function acceptanceRateOf(t: DecisionTally): RatioKpi {
  return ratioKpi(
    t.accepted.length,
    t.customerDecisions.length,
    t.basis,
    t.accepted.map((f) => f.finding.id),
  );
}

// ---------------------------------------------------------------------------
// Evaluation-quality KPIs
// ---------------------------------------------------------------------------

/**
 * `Findings dispositioned as invalid or unsupported divided by
 * dispositioned findings`.
 *
 * Source: `docs/product/kpis.md`, *Evaluation-quality KPIs → False-
 * positive rate*: "Low false-positive rate protects scarce human
 * attention."
 *
 * Mapping the doc's wording onto #61's vocabulary: "invalid or
 * unsupported" is the `invalid` kind alone. `alreadyKnown` means the
 * problem is real and the team already tracks it — not a false positive
 * — and `wontFix` means the problem is real and the customer chose not
 * to fix it. Counting either would let a service that surfaces only
 * problems the customer had already filed look perfectly precise.
 */
export function falsePositiveRate(input: KpiInput): RatioKpi {
  return falsePositiveRateOf(tallyDecisions(input));
}

function falsePositiveRateOf(t: DecisionTally): RatioKpi {
  return ratioKpi(
    t.invalid.length,
    t.customerDecisions.length,
    t.basis,
    t.invalid.map((f) => f.finding.id),
  );
}

// ---------------------------------------------------------------------------
// Customer-value KPIs (action, uniqueness)
// ---------------------------------------------------------------------------

/**
 * `Share of accepted findings that lead to a concrete follow-up`.
 *
 * Source: `docs/product/kpis.md`, *Customer-value KPIs → Action rate*.
 *
 * The denominator is the accepted set, so unlike the two rates above
 * this is conditional on acceptance. A follow-up is recorded as
 * `Disposition.action`, and #61's `ACTION_KINDS` enumerates exactly
 * the doc's list — issue, change, research, regressionTest,
 * instrumentation, riskAccepted — so no kind needs interpreting here.
 */
export function actionRate(input: KpiInput): RatioKpi {
  return actionRateOf(tallyDecisions(input));
}

function actionRateOf(t: DecisionTally): RatioKpi {
  const withAction = t.accepted.filter((d) => d.action !== undefined);
  return ratioKpi(
    withAction.length,
    t.accepted.length,
    t.basis,
    withAction.map((d) => d.finding.id),
  );
}

/**
 * The count of findings the customer currently accepts.
 *
 * Source: `docs/product/kpis.md`, *North-star metric* and
 * *Customer-value KPIs* — the "accepted findings" term both use.
 *
 * ## This is not the north star, and the name does not pretend to be
 *
 * The doc defines the north star as *unique* accepted findings with
 * three conditions beyond acceptance: materially distinct from other
 * findings in the window, not already known to the team, and not a
 * restatement of a known deterministic test failure. Only the middle
 * one is computable — see `notAlreadyKnownAcceptedFindingCount` and
 * `UNCOMPUTED_KPI_TERMS`. Computing this count and labelling it the
 * north star would be the exact failure the doc describes: a metric
 * easier to inflate than the one it replaced.
 */
export function acceptedFindingCount(input: KpiInput): CountKpi {
  return acceptedFindingCountOf(tallyDecisions(input));
}

function acceptedFindingCountOf(t: DecisionTally): CountKpi {
  return countKpi(t, t.accepted.map((d) => d.finding.id));
}

/**
 * Accepted findings the team had not already flagged as known.
 *
 * Source: `docs/product/kpis.md`, *Customer-value KPIs → Unique
 * accepted finding rate*: "Accepted findings that were not already
 * known to the team or trivially reported by existing deterministic
 * checks."
 *
 * ## What is computable, and why it needs the ledger
 *
 * The "not already known" half is computable, but **not from the
 * current disposition alone**: a finding carries exactly one current
 * kind, so "accepted and not alreadyKnown" over the head alone is
 * vacuously just "accepted" — arithmetic that would look rigorous and
 * mean nothing. The signal lives in the *history*, which is what #64
 * persists: a finding whose ledger contains an `alreadyKnown` event at
 * any point was reported by the team independently of this evaluation,
 * and stays excluded even after a later correction accepts it.
 *
 * The "or trivially reported by existing deterministic checks" half is
 * **not** computable. The review contract records which evidence
 * channels a finding cites, but nothing in the durable model records
 * what the customer's existing deterministic suite already covers, so
 * there is no test to apply. See `UNCOMPUTED_KPI_TERMS`.
 *
 * The denominator the doc's heading implies is also unstated: this
 * returns a **count**, which the clause does define, rather than a
 * rate, whose base it does not.
 */
export function notAlreadyKnownAcceptedFindingCount(input: KpiInput): CountKpi {
  return notAlreadyKnownAcceptedFindingCountOf(tallyDecisions(input));
}

function notAlreadyKnownAcceptedFindingCountOf(t: DecisionTally): CountKpi {
  const ids = t.accepted
    .filter((d) => !t.knownBefore.has(d.finding.id))
    .map((d) => d.finding.id);
  return countKpi(t, ids);
}

// ---------------------------------------------------------------------------
// Adoption KPI
// ---------------------------------------------------------------------------

/**
 * Customer disposition coverage: findings that receive explicit
 * feedback.
 *
 * Source: `docs/product/kpis.md`, *Adoption and retention KPIs*.
 *
 * This is the one KPI here whose denominator is **every finding**, not
 * the decisioned ones. A finding with no disposition is precisely what
 * coverage measures, so `noDisposition` is the gap this number exists
 * to expose rather than an exclusion from it. This is the KPI that
 * answers "what happens to a finding nobody ever looked at": it is
 * counted here, in the denominator, and it drags the number down.
 *
 * "Explicit feedback" is read as *at least one recorded disposition*,
 * and an open `unresolved` row counts: someone deliberately recorded
 * that nobody has decided, which is feedback. Absence of any row is
 * not.
 */
export function dispositionCoverage(input: KpiInput): RatioKpi {
  return dispositionCoverageOf(tallyDecisions(input));
}

function dispositionCoverageOf(t: DecisionTally): RatioKpi {
  const covered = [...t.customerDecisions, ...t.openDisposition].map((d) => d.finding.id);
  return ratioKpi(covered.length, t.basis.totalFindings, t.basis, covered);
}

// ---------------------------------------------------------------------------
// Unit-economics KPIs
// ---------------------------------------------------------------------------

/**
 * `direct evaluation cost / verified findings`.
 *
 * Source: `docs/product/kpis.md`, *Unit-economics KPIs → Cost per
 * verified finding*: "Useful for internal routing before customer
 * disposition is available."
 *
 * "Verified" is a finding carrying a `Verification` whose outcome is
 * `confirmed` (#61's `VerificationOutcome`). `refuted`, `inconclusive`
 * and `notRun` are attempts that did not establish the claim, and the
 * `attemptedNotReproduced` / `blockedBySetup` reproduction statuses
 * likewise do not count. The purpose of this KPI is routing spend
 * toward what survives checking, so a refuted pass must not help the
 * ratio.
 */
export function costPerVerifiedFinding(input: KpiInput): CostPerFindingKpi {
  return costPerVerifiedFindingFrom(tallyDecisions(input), input.evaluationCost);
}

/**
 * `direct evaluation cost / accepted findings`.
 *
 * Source: `docs/product/kpis.md`, *Unit-economics KPIs → Cost per
 * accepted finding*: "This is a critical service metric. Lowering
 * token price alone is irrelevant if finding quality falls."
 */
export function costPerAcceptedFinding(input: KpiInput): CostPerFindingKpi {
  return costPerFindingKpi(input.evaluationCost, tallyDecisions(input).accepted.length);
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * Every KPI above, computed over one input.
 *
 * The tally is computed **once** and shared, rather than each KPI
 * re-deriving it, so a snapshot is internally consistent by
 * construction: two calls into the same ledger inside one report cannot
 * disagree. Frozen, so a consumer cannot mutate a snapshot two reports
 * share.
 */
export interface KpiSnapshot {
  readonly findingAcceptanceRate: RatioKpi;
  readonly falsePositiveRate: RatioKpi;
  readonly actionRate: RatioKpi;
  readonly dispositionCoverage: RatioKpi;
  readonly acceptedFindingCount: CountKpi;
  readonly notAlreadyKnownAcceptedFindingCount: CountKpi;
  readonly costPerVerifiedFinding: CostPerFindingKpi;
  readonly costPerAcceptedFinding: CostPerFindingKpi;
  /** Current-disposition counts per kind, keyed in `DISPOSITION_KINDS` order. */
  readonly byKind: Readonly<Record<DispositionKind, number>>;
  /**
   * Findings with a current disposition, in id order.
   *
   * Includes *open* dispositions (`unresolved`, `needsHumanResearch`):
   * a report enumerating "what did the customer say about each finding"
   * must not silently omit the ones where the answer was "nobody has
   * decided", which is the exclusion `DispositionBasis` exists to make
   * visible. Which of these are *decisions* is `basis`'s job, and the
   * decision-only subset is what each rate's `numeratorFindingIds`
   * and denominator describe.
   */
  readonly dispositioned: ReadonlyArray<readonly [string, Disposition]>;
  /** Findings with no disposition at all, in id order. */
  readonly undispositionedFindingIds: ReadonlyArray<string>;
  /**
   * Setup failures excluded from every number above. Empty unless the
   * caller used `kpiSnapshotFromOutcomes`, which exists so the
   * exclusion is *recorded* rather than silent.
   */
  readonly excludedSetupFailures: ReadonlyArray<SetupFailure>;
}

export function computeKpiSnapshot(input: KpiInput): KpiSnapshot {
  const t = tallyDecisions(input);
  return Object.freeze({
    findingAcceptanceRate: acceptanceRateOf(t),
    falsePositiveRate: falsePositiveRateOf(t),
    actionRate: actionRateOf(t),
    dispositionCoverage: dispositionCoverageOf(t),
    acceptedFindingCount: acceptedFindingCountOf(t),
    notAlreadyKnownAcceptedFindingCount: notAlreadyKnownAcceptedFindingCountOf(t),
    costPerVerifiedFinding: costPerVerifiedFindingFrom(t, input.evaluationCost),
    costPerAcceptedFinding: costPerFindingKpi(
      input.evaluationCost,
      t.accepted.length,
    ),
    byKind: kindCountsOf(t),
    dispositioned: Object.freeze(
      [...t.decisions.values(), ...t.openDisposition]
        .map((entry) => [entry.finding.id, entry.disposition] as const)
        .sort((a, b) => compareHandles(a[0], b[0])),
    ),
    undispositionedFindingIds: Object.freeze(
      t.noDisposition.map((f) => f.id).sort(compareHandles),
    ),
    excludedSetupFailures: Object.freeze([]),
  });
}

/**
 * The same snapshot, from a run's mixed outcome stream.
 *
 * The split happens here rather than in the caller's hands so the
 * excluded setup failures end up **in the result**. A caller who
 * splits by hand and keeps only the findings produces correct KPIs
 * with no record that three dead-browser failures were dropped — which
 * is the state #61's `finding.ts` says makes the false-positive rate
 * lie while telling the customer their product is broken.
 */
export function kpiSnapshotFromOutcomes(
  outcomes: ReadonlyArray<unknown>,
  ledger: DispositionLedger,
  options: { readonly evaluationCost?: EvaluationCost | undefined } = {},
): KpiSnapshot {
  const split = splitReviewOutcomes(outcomes);
  const base = computeKpiSnapshot({
    findings: split.findings,
    ledger,
    evaluationCost: options.evaluationCost,
  });
  return Object.freeze({ ...base, excludedSetupFailures: split.setupFailures });
}

// ---------------------------------------------------------------------------
// Terms the specification does not define
// ---------------------------------------------------------------------------

/**
 * Terms of `docs/product/kpis.md` that are not computable from the
 * current data model.
 *
 * Recorded as data rather than only as prose so the gap is visible to a
 * consumer and to a test, and so a future ticket that closes one of
 * them has something concrete to remove. Each entry names the clause,
 * why it cannot be computed, and what would be needed.
 *
 * Nothing here is worked around in the functions above. Where a
 * definition was incomplete, this module reports the part that *is*
 * defined and leaves the rest visibly absent.
 */
export const UNCOMPUTED_KPI_TERMS: ReadonlyArray<{
  readonly term: string;
  readonly clause: string;
  readonly why: string;
  readonly needs: string;
}> = Object.freeze([
  Object.freeze({
    term: '"materially distinct from other findings in the measurement window"',
    clause: 'North-star metric, second condition',
    why:
      'Two findings are materially distinct when they describe different causes. The review ' +
      'contract records a title, a kind, an affected-condition list and an evidence set, but ' +
      'defines no similarity relation between two findings, so no test can tell a genuine ' +
      'recurrence of one problem from two problems stated differently.',
    needs:
      'A declared similarity key on Finding (or a producer-supplied comparison function) plus a ' +
      'declared threshold. Both are contract changes to #61, not aggregation.',
  }),
  Object.freeze({
    term: '"not merely a restatement of a known deterministic test failure"',
    clause: 'North-star metric, fourth condition',
    why:
      'A finding may cite the deterministicCheck channel, which says a check ran and refutes the ' +
      'claim — it does not record which tests the customer already has. Nothing in the durable ' +
      'model indexes the customer\'s existing suite, so a finding duplicating an existing ' +
      'regression test is indistinguishable from a novel one.',
    needs:
      "An inventory of the customer's deterministic checks as durable product data, and a join " +
      'from a finding to the check it duplicates. That is a #57 durable-model concern.',
  }),
  Object.freeze({
    term: 'the denominator of the "Unique accepted finding rate"',
    clause: 'Customer-value KPIs, Unique accepted finding rate',
    why:
      'The clause is a one-sentence definition with no formula and no stated base. Accepted ' +
      'findings, all dispositioned findings and all findings are each a defensible denominator, ' +
      'and they give materially different numbers.',
    needs:
      'A product decision on the measurement base. Until then this module reports the count, ' +
      'which the same clause does define, and not a rate.',
  }),
  Object.freeze({
    term: 'the currency and scale of "direct evaluation cost"',
    clause: 'Unit-economics KPIs, cost per verified / accepted finding',
    why:
      'ADR-0011 requires provider neutrality, so the doc names the cost *sources* (model, ' +
      'browser, storage, provider) but no unit. Inventing one would bake a vendor into the ' +
      'contract.',
    needs:
      'A declared cost unit in the service configuration (#66), which the caller then supplies as ' +
      'EvaluationCost.unit.',
  }),
  Object.freeze({
    term: 'the reportable precision of a cost-per-finding',
    clause: 'Unit-economics KPIs, cost per verified / accepted finding',
    why:
      'CostPerFindingKpi.rounded carries a ratio precision (KPI_RATIO_DECIMALS), not a currency ' +
      'precision, because the unit is undeclared — see the entry above. "0.5 per finding" and ' +
      '"500000 micros per finding" are the same quotient in different units, and no clause says ' +
      'how many decimal places of an undeclared unit are reportable. Rounding to six places ' +
      'asserts a scale the specification has not chosen.',
    needs:
      'The declared cost unit from the service configuration (#66). Once a unit is declared, the ' +
      'rounding rule for that unit is a product decision to state alongside it — this ticket ' +
      'does not get to pick one.',
  }),
  Object.freeze({
    term: 'the numerator of "Time to first useful finding"',
    clause: 'Customer-value KPIs, Time to first useful finding',
    why:
      'The clock starts at "a usable Environment being connected", which is an event the durable ' +
      'model does not yet record. Out of scope for this ticket, listed so the omission is a ' +
      'stated decision rather than an oversight.',
    needs:
      'An environment-connected instant in the durable model (#57) before this KPI is computable.',
  }),
]);

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface DecidedEntry {
  readonly finding: Finding;
  readonly disposition: Disposition;
  readonly action: Disposition['action'];
}

interface DecisionTally {
  /** Accounts for every finding. See `assertBasisAccountsForEveryFinding`. */
  readonly basis: DispositionBasis;
  /** Every finding, sorted by id. The permutation-invariant input order. */
  readonly all: ReadonlyArray<Finding>;
  /** Customer decisions keyed by finding id. */
  readonly decisions: ReadonlyMap<string, DecidedEntry>;
  readonly customerDecisions: ReadonlyArray<DecidedEntry>;
  readonly accepted: ReadonlyArray<DecidedEntry>;
  readonly invalid: ReadonlyArray<DecidedEntry>;
  readonly noDisposition: ReadonlyArray<Finding>;
  readonly openDisposition: ReadonlyArray<DecidedEntry>;
  /**
   * Finding ids whose ledger history contains an `alreadyKnown` event
   * at any point — including before a later correction accepted them.
   */
  readonly knownBefore: ReadonlySet<string>;
}

/**
 * Join the findings to their current dispositions, once.
 *
 * ## The join cannot produce a dangling row
 *
 * The current disposition of every finding is read from the ledger
 * (which owns the "last event wins" rule, so this module never
 * re-derives currency). A disposition naming a finding absent from the
 * input is then **refused**, not ignored: a ledger can legitimately
 * outlive the findings array it is queried with, and the honest answer
 * is an error naming the orphan rather than a rate computed over a
 * subset nobody chose.
 *
 * ## Why the sort happens here
 *
 * `indexFindings` rejects a duplicate finding id — a duplicate would
 * make every denominator depend on which copy the map happened to
 * keep — and the id order it yields is the total order every returned
 * array and record key is built from. That is what makes the whole
 * module permutation-invariant.
 */
function tallyDecisions(input: KpiInput): DecisionTally {
  const raw = assertFindingSet(input.findings);
  // `indexFindings` refuses a duplicate id with a `ReviewContractError`;
  // re-raised so a caller catches one error type, per `errors.ts`.
  const index = asFeedbackContractError('findings', () => indexFindings(raw));
  // Sorted once, on entry: every derived list inherits a total order
  // from here rather than re-sorting or trusting input order.
  const all = [...index.values()].sort((a, b) => compareHandles(a.id, b.id));

  const decisions = new Map<string, DecidedEntry>();
  const openDisposition: DecidedEntry[] = [];
  const openIds = new Set<string>();

  for (const [findingId, disposition] of currentDispositions(input.ledger)) {
    const finding = index.get(findingId);
    if (finding === undefined) {
      throw new FeedbackContractError(
        `disposition ${disposition.id} refers to finding ${findingId}, which is not in the ` +
          `aggregation input; measuring a disposition without the finding it judged would move ` +
          `every rate by an amount no consumer could see`,
        'ledger',
        { dispositionId: disposition.id, findingId },
      );
    }
    const entry: DecidedEntry = { finding, disposition, action: disposition.action };
    if (isCustomerDecision(disposition)) {
      decisions.set(findingId, entry);
    } else {
      // The only other possibility: #61's `parseDisposition` refuses an
      // open kind in a decided state and `isCustomerDecision` excludes
      // open kinds, so a disposition reaching here that is not a
      // decision is open by construction.
      openDisposition.push(entry);
      openIds.add(findingId);
    }
  }

  const noDisposition = all.filter((f) => !decisions.has(f.id) && !openIds.has(f.id));
  const customerDecisions = [...decisions.values()];

  const basis: DispositionBasis = Object.freeze({
    totalFindings: all.length,
    customerDecisions: customerDecisions.length,
    noDisposition: noDisposition.length,
    openDisposition: openDisposition.length,
  });
  assertBasisAccountsForEveryFinding(basis);

  return Object.freeze({
    basis,
    all,
    decisions,
    customerDecisions: Object.freeze(customerDecisions),
    accepted: Object.freeze(
      customerDecisions.filter((d) => d.disposition.kind === 'accepted'),
    ),
    invalid: Object.freeze(
      customerDecisions.filter((d) => d.disposition.kind === 'invalid'),
    ),
    noDisposition: Object.freeze(noDisposition),
    openDisposition: Object.freeze(openDisposition),
    knownBefore: knownBeforeIds(input.ledger),
  });
}

/**
 * Finding ids the team has flagged as already known at any point.
 *
 * Read from the full event list rather than the current dispositions,
 * which is what makes this distinct from "the current kind is
 * `alreadyKnown`" — see `notAlreadyKnownAcceptedFindingCount`.
 */
function knownBeforeIds(ledger: DispositionLedger): ReadonlySet<string> {
  const known = new Set<string>();
  for (const event of ledger.events) {
    if (event.disposition.kind === 'alreadyKnown') known.add(event.findingId);
  }
  return known;
}

/**
 * The accounting identity, asserted rather than assumed.
 *
 * A KPI whose denominator silently lost a finding is the failure this
 * module exists to prevent, and it is invisible in the number itself.
 * Checking it here means a future change to the partitioning fails on
 * the first aggregation rather than on a customer's report.
 */
function assertBasisAccountsForEveryFinding(basis: DispositionBasis): void {
  const accounted = basis.customerDecisions + basis.noDisposition + basis.openDisposition;
  if (accounted !== basis.totalFindings) {
    throw new FeedbackContractError(
      `disposition basis does not account for every finding: ${basis.customerDecisions} decided + ` +
        `${basis.noDisposition} with no disposition + ${basis.openDisposition} open != ` +
        `${basis.totalFindings} total; a finding in none of the three buckets has been dropped ` +
        `from the measurement`,
      'basis',
      { ...basis, accounted },
    );
  }
}

/**
 * Build a ratio result.
 *
 * The `null` cases are decided here, once, for every ratio in the
 * module. An empty denominator is a real and common state — a quiet
 * week, a product nobody has reviewed yet — and it must be a *defined
 * answer*, not an absent row and not `NaN`.
 */
function ratioKpi(
  numerator: number,
  denominator: number,
  basis: DispositionBasis,
  numeratorFindingIds: ReadonlyArray<string>,
): RatioKpi {
  const defined = denominator > 0;
  return Object.freeze({
    numerator,
    denominator,
    value: defined ? numerator / denominator : null,
    rounded: defined ? roundRatioHalfUp(numerator, denominator, KPI_RATIO_DECIMALS) : null,
    defined,
    ...(defined ? {} : { reason: 'emptyDenominator' as const }),
    basis,
    numeratorFindingIds: Object.freeze([...numeratorFindingIds].sort(compareHandles)),
  });
}

function countKpi(t: DecisionTally, findingIds: ReadonlyArray<string>): CountKpi {
  const ids = Object.freeze([...findingIds].sort(compareHandles));
  return Object.freeze({ value: ids.length, basis: t.basis, findingIds: ids });
}

function costPerFindingKpi(
  cost: EvaluationCost | undefined,
  count: number,
): CostPerFindingKpi {
  if (cost === undefined) {
    return Object.freeze({
      cost: null,
      count,
      value: null,
      rounded: null,
      defined: false,
      reason: 'noCostData' as const,
      unit: null,
    });
  }
  const defined = count > 0;
  return Object.freeze({
    cost,
    count,
    value: defined ? cost.amount / count : null,
    rounded: defined ? roundRatioHalfUp(cost.amount, count, KPI_RATIO_DECIMALS) : null,
    defined,
    ...(defined ? {} : { reason: 'emptyDenominator' as const }),
    unit: `${cost.unit}/finding`,
  });
}

function costPerVerifiedFindingFrom(
  t: DecisionTally,
  cost: EvaluationCost | undefined,
): CostPerFindingKpi {
  return costPerFindingKpi(cost, verifiedFindingCount(t));
}

/**
 * How many findings a verification pass confirmed.
 *
 * Only `confirmed` counts. `refuted`, `inconclusive` and `notRun` are
 * attempts that did not establish the claim, and a *refuted* pass must
 * not lower the cost of a verified finding — the whole point of this
 * KPI is to route spend toward what survives checking.
 *
 * Over `t.all` (every finding), not the dispositioned subset: the
 * metric doc's stated purpose is routing spend "before customer
 * disposition is available".
 */
function verifiedFindingCount(t: DecisionTally): number {
  return t.all.filter((f) => f.verification?.outcome === 'confirmed').length;
}

/**
 * Current-disposition kind counts, keyed in `DISPOSITION_KINDS` order.
 *
 * The zero-filled literal lives in `ledger.ts` (`emptyKindCounts`) and
 * is imported rather than restated, so a kind added to #61 is a
 * compile error in exactly one place and the two kind-count surfaces
 * cannot drift apart. Open kinds are absent from `decisions` and so
 * stay zero — an open finding has no current *kind* for a
 * customer-value breakdown, only an open state.
 */
function kindCountsOf(t: DecisionTally): Readonly<Record<DispositionKind, number>> {
  const counts = emptyKindCounts();
  for (const entry of t.decisions.values()) {
    counts[entry.disposition.kind] += 1;
  }
  return Object.freeze(counts);
}

/**
 * Round `numerator / denominator` half-up to `decimals` places.
 *
 * Rounding the ratio of the operands rather than a pre-divided double
 * avoids one source of platform variance. `Math.round` rounds toward
 * `+Infinity`, so it is round-half-up **only for a non-negative
 * operand**; for `-1 / 2` it returns `-0` rather than the `-1` the name
 * promises. Every KPI in this module has a non-negative numerator
 * (a count, or a cost already refused by `requireNonNegativeFinite`),
 * so rather than leave a public helper whose behaviour depends on the
 * sign of its argument, the non-negative case is the whole contract
 * and anything else is refused.
 *
 * ## Where the result is exact, and where it is merely deterministic
 *
 * The scaled product `numerator * 10 ** decimals` is exact for every
 * count-based operand here, and for a cost while that product stays
 * within the exactly-representable integer range (`2 ** 53 - 1`). Past
 * that the product rounds, and the returned figure is still identical
 * on every run and every platform — IEEE-754 arithmetic is
 * deterministic — but it is no longer an exactly-rounded quotient. A
 * caller reporting a currency at a scale where this matters should not
 * trust `rounded`; see `UNCOMPUTED_KPI_TERMS`, which records that the
 * cost unit is not yet declared and that `rounded` on a
 * `CostPerFindingKpi` is therefore a ratio-precision figure and not a
 * currency-precision one.
 */
export function roundRatioHalfUp(
  numerator: number,
  denominator: number,
  decimals: number,
): number {
  if (denominator === 0) {
    throw new FeedbackContractError(
      'roundRatioHalfUp requires a non-zero denominator; an empty denominator is reported as ' +
        'value: null with reason "emptyDenominator" rather than as a number',
      'denominator',
      { denominator },
    );
  }
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    throw new FeedbackContractError(
      'roundRatioHalfUp requires finite operands; NaN or Infinity would propagate silently into ' +
        'a reported KPI',
      'numerator',
      { numerator, denominator },
    );
  }
  if (numerator < 0) {
    throw new FeedbackContractError(
      `roundRatioHalfUp is round-half-up, which Math.round only implements for a non-negative ` +
        `operand; received ${numerator}. A KPI numerator is a count or an already-validated ` +
        `non-negative cost, so a negative one is a caller error rather than a value to round`,
      'numerator',
      { numerator, denominator, decimals },
    );
  }
  const factor = 10 ** decimals;
  return Math.round((numerator * factor) / denominator) / factor;
}
