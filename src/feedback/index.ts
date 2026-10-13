/**
 * Feedback loop — durable disposition history and KPI primitives
 * (issue #64, ADR-0011, `docs/product/kpis.md`).
 *
 * This module is the public surface of `src/feedback/**`. It is not
 * re-exported from `src/index.ts`: the package entrypoint belongs to
 * #65's ticket, and #64 must not compete for it — the same boundary
 * #61 declared for `src/review/**`.
 *
 * ## Layering
 *
 * `src/feedback/**` imports from `src/review/**` (#61) and from
 * nothing else. In particular it does not reach into `src/domain/**`,
 * `src/evidence/**`, `src/experiment/**` or any provider, so the
 * feedback ledger and its KPIs can be computed and stored with no
 * experiment runtime existing.
 *
 * ## What this layer owns, and what it refuses to own
 *
 * #61 owns the *vocabulary*: which disposition kinds exist, which may
 * carry which lifecycle state, which actor may record which kind, and
 * the legal transition table. This layer owns the *sequence* and the
 * *arithmetic*: whether an append is well-formed against what is
 * already recorded, and what the recorded history says numerically.
 *
 * The division is deliberate in both directions:
 *
 * - The ledger calls #61's `assertDispositionTransition` and
 *   `parseDisposition` rather than keeping its own copy of either.
 *   Two transition tables that agree until someone edits one of them
 *   would produce an audit trail that accepts an illegal move.
 * - The KPI layer calls #61's `isCustomerDecision` rather than
 *   re-deriving "is this a decision". That single predicate is what
 *   makes "aggregation never treats unresolved findings as accepted" a
 *   structural property instead of a per-function `if`.
 *
 * ## The three things a caller must not get wrong
 *
 * 1. **A `SetupFailure` in a finding list.** #61's `Finding` and
 *    `SetupFailure` are separate types, so the type system refuses it
 *    — but only for callers who are actually type-checked. The
 *    aggregation boundary re-checks at runtime so an untyped caller
 *    cannot smuggle one in, and `kpiSnapshotFromOutcomes` returns the
 *    count of what it excluded rather than dropping it silently. See
 *    `aggregate.ts`.
 * 2. **Treating "no disposition" as a decision.** It is not one, and
 *    it is not the same as "unresolved" either. Every result carries a
 *    `basis` that accounts for all three states, and the identity is
 *    asserted on every aggregation.
 * 3. **Reading a `null` KPI as zero.** A `null` value with a named
 *    `reason` means the measurement is undefined, which is not the
 *    same as a measured zero.
 *
 * ## Errors
 *
 * `FeedbackContractError` for anything this layer rejects, including a
 * `ReviewContractError` re-raised from a #61 call so a caller of this
 * layer has exactly one error type to catch. See `errors.ts`.
 */

export {
  asFeedbackContractError,
  FeedbackContractError,
  isFeedbackContractError,
} from './errors.js';

export {
  appendDisposition,
  compareHandles,
  currentDisposition,
  currentDispositions,
  dispositionedFindingIds,
  dispositionHistory,
  emptyLedger,
  EMPTY_LEDGER,
  eventCountByKind,
  ledgerFromEvents,
  type DispositionEvent,
  type DispositionLedger,
} from './ledger.js';

export {
  assertFindingSet,
  findingsFromOutcomes,
  splitReviewOutcomes,
  type SplitReviewOutcomes,
} from './aggregate.js';

export {
  acceptedFindingCount,
  actionRate,
  computeKpiSnapshot,
  costPerAcceptedFinding,
  costPerVerifiedFinding,
  dispositionCoverage,
  falsePositiveRate,
  findingAcceptanceRate,
  kpiSnapshotFromOutcomes,
  MAX_COST_UNIT_LENGTH,
  notAlreadyKnownAcceptedFindingCount,
  parseEvaluationCost,
  roundRatioHalfUp,
  KPI_RATIO_DECIMALS,
  UNCOMPUTED_KPI_TERMS,
  type CostPerFindingKpi,
  type CountKpi,
  type DispositionBasis,
  type EvaluationCost,
  type KpiInput,
  type KpiSnapshot,
  type RatioKpi,
  type UndefinedKpiReason,
} from './kpi.js';
