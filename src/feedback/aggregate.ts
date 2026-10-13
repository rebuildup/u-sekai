/**
 * The aggregation boundary — where a mixed stream of run outcomes
 * becomes the `Finding[]` that every product KPI is computed over
 * (issue #64).
 *
 * ## The two guarantees, and why there are two mechanisms
 *
 * #61 makes `Finding` and `SetupFailure` separate types with literal
 * `outcome` discriminants, and pins the separation with
 * `@ts-expect-error` assertions in `test/unit/review/type-separation.test.ts`.
 * That is the *primary* guarantee: a caller who writes
 * `ReadonlyArray<Finding>` and hands over `[finding, failure]` gets a
 * compile error, and `npm run typecheck` fails. No runtime filter is
 * involved, so there is no "someone forgot to call the filter" failure
 * mode for typed callers.
 *
 * The compile-time guarantee does not cover one real caller: a run
 * produces `ReviewOutcome[]` (`Finding | SetupFailure`) and the
 * narrowing to `Finding[]` is the caller's to perform. A caller who
 * forgets produces a `Finding[]` that is *typed* correctly and
 * *populated* wrongly, and no type system can catch that. So this
 * module re-checks at the boundary.
 *
 * The runtime check is deliberately **not** a filter that silently
 * drops what it does not like. `splitReviewOutcomes` returns both
 * halves and counts the excluded ones, so "we ignored 3 dead-browser
 * setup failures this period" is a number a report can print. #61's
 * `finding.ts` names the exact harm this prevents: a dead browser
 * filed as a finding is a finding that is always false-positive, and
 * it drags the false-positive rate up while telling the customer their
 * product is broken.
 *
 * ## A `Finding[]` is not accepted unchecked
 *
 * `assertFindingSet` is the belt to the compile-time braces. It does
 * not re-validate the *contents* of a finding — `parseFinding` owns
 * that, and re-deriving it here would be a second, drifting copy of
 * #61's contract. It checks the one thing that matters at this
 * boundary and cannot be checked by types alone: that no element is a
 * `SetupFailure` wearing a `Finding`'s type.
 */

import { isFinding, isSetupFailure } from '../review/index.js';
import type { Finding, ReviewOutcome, SetupFailure } from '../review/index.js';
import { FeedbackContractError } from './errors.js';
import { requireArray } from './validation.js';

/** The two halves of a run's outcome stream. */
export interface SplitReviewOutcomes {
  readonly findings: ReadonlyArray<Finding>;
  /** Excluded from every product KPI, retained so the count is visible. */
  readonly setupFailures: ReadonlyArray<SetupFailure>;
}

/**
 * Split a run's outcomes into the product findings and the setup
 * failures, refusing a value that is neither.
 *
 * Ordered by input order within each half, so the split is a faithful
 * projection of the stream. Sorting happens in the KPI layer, which is
 * the only place that promises a total order; doing it here would make
 * the "this is the run's output, in order" view lossy for no benefit.
 */
export function splitReviewOutcomes(
  outcomes: ReadonlyArray<unknown>,
  field = 'outcomes',
): SplitReviewOutcomes {
  const arr = requireArray(outcomes, field);
  const findings: Finding[] = [];
  const setupFailures: SetupFailure[] = [];

  arr.forEach((entry, i) => {
    const at = `${field}[${i}]`;
    if (isFinding(entry)) {
      findings.push(entry);
      return;
    }
    if (isSetupFailure(entry)) {
      setupFailures.push(entry);
      return;
    }
    throw new FeedbackContractError(
      `${at} is neither a Finding nor a SetupFailure; every review outcome must carry an ` +
        `"outcome" discriminant of "productFinding" or "setupFailure"`,
      at,
      { received: (entry as { outcome?: unknown } | null)?.outcome ?? null },
    );
  });

  return Object.freeze({
    findings: Object.freeze(findings),
    setupFailures: Object.freeze(setupFailures),
  });
}

/**
 * Narrow a `ReviewOutcome[]` to its `Finding[]` half.
 *
 * The typed form of this operation. It exists so the common case —
 * "I have outcomes, I want findings" — does not need the split result
 * destructured by hand, and so the runtime check below is not optional.
 */
export function findingsFromOutcomes(
  outcomes: ReadonlyArray<ReviewOutcome>,
  field = 'outcomes',
): ReadonlyArray<Finding> {
  return splitReviewOutcomes(outcomes, field).findings;
}

/**
 * Refuse a collection that is not purely findings.
 *
 * The check `parseFinding` would perform on its discriminant, applied
 * to a list whose element type the compiler already believes. A caller
 * that reached this function with a `SetupFailure` in the list has
 * already defeated the type system — untyped JSON, a hand-rolled
 * narrowing, or an `any` — so the message names the offending id and
 * says what the KPI would have done with it.
 */
export function assertFindingSet(
  findings: ReadonlyArray<unknown>,
  field = 'findings',
): ReadonlyArray<Finding> {
  const arr = requireArray(findings, field);
  arr.forEach((entry, i) => {
    if (isFinding(entry)) return;
    if (isSetupFailure(entry)) {
      throw new FeedbackContractError(
        `${field}[${i}] is a SetupFailure (${entry.id}, cause "${entry.cause}"), not a product ` +
          `finding; a setup failure is not a product outcome and must never enter a product KPI's ` +
          `numerator or denominator — as a finding it would be counted as a false positive and ` +
          `would tell the customer their product is broken when their environment was`,
        `${field}[${i}]`,
        { setupFailureId: entry.id, cause: entry.cause },
      );
    }
    throw new FeedbackContractError(
      `${field}[${i}] is not a Finding; it must carry outcome "productFinding"`,
      `${field}[${i}]`,
      { received: (entry as { outcome?: unknown } | null)?.outcome ?? null },
    );
  });
  return findings as ReadonlyArray<Finding>;
}
