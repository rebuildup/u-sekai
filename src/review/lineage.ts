/**
 * Lineage — reconstructing what a disposition actually refers to
 * (issue #61).
 *
 * ## The problem this solves
 *
 * #64 computes acceptance rate, false-positive rate, cost per accepted
 * finding and disposition coverage. Every one of those numbers is a
 * join between a disposition and the finding it judges. If a
 * disposition embedded a copy of the finding's severity, title or
 * evidence list, the join would be a string comparison between two
 * values that could drift, and the only way to detect the drift would
 * be to re-derive the finding and compare — which nobody does.
 *
 * So `Disposition` carries `findingId` and nothing else, and
 * `resolveDispositionLineage` walks that reference back to the finding
 * and hands back the *same* evidence objects the finding carries. The
 * evidence in a lineage is `===` the evidence in the finding, not a
 * re-parse of it.
 *
 * ## What a lineage deliberately does not do
 *
 * It does not decide whether the disposition was correct, whether a
 * later disposition superseded it, or what the finding is worth. Those
 * are #64's ledger and KPI concerns. This module answers one question
 * — *what did this disposition refer to?* — and answers it in a way
 * that cannot be stale.
 */

import type { EvaluationRunId, EvaluationTargetRef } from '../product/lineage.js';
import type { SyntheticIdentityId } from '../product/ids.js';
import type { Disposition } from './disposition.js';
import { isCustomerDecision } from './disposition.js';
import { ReviewContractError } from './errors.js';
import type { EvidenceRef } from './evidence.js';
import type { Finding } from './finding.js';
import type { DispositionId, FindingId } from './ids.js';

/**
 * Everything a disposition points at, resolved.
 *
 * `evidenceRefs` is the same array instance the finding holds, so
 * `lineage.evidenceRefs === finding.evidenceRefs`. That identity is the
 * guarantee: there is no second copy to fall out of date.
 */
export interface FindingLineage {
  readonly dispositionId: DispositionId;
  /** The finding itself, not a projection of it. */
  readonly finding: Finding;
  /** Convenience mirror of `finding.id`, for keyed lookups. */
  readonly findingId: FindingId;
  /** Identical array instance to `finding.evidenceRefs`. */
  readonly evidenceRefs: ReadonlyArray<EvidenceRef>;
  readonly target: EvaluationTargetRef;
  readonly runId: EvaluationRunId;
  readonly identityIds: ReadonlyArray<SyntheticIdentityId>;
  readonly observedAt: string;
  /** The finding's longitudinal change, by reference. */
  readonly longitudinal: Finding['longitudinal'];
  /**
   * Whether this disposition counts as a customer decision. Re-exported
   * from `disposition.ts` so a consumer that has resolved a lineage
   * does not need a second import to answer the KPI question.
   */
  readonly isDecision: boolean;
}

/** Index findings by id, rejecting duplicate ids. */
export function indexFindings(findings: ReadonlyArray<Finding>): ReadonlyMap<FindingId, Finding> {
  const index = new Map<FindingId, Finding>();
  for (const finding of findings) {
    if (index.has(finding.id)) {
      throw new ReviewContractError(
        `findings contains a duplicate finding id: ${finding.id}`,
        'findings',
        { findingId: finding.id },
      );
    }
    index.set(finding.id, finding);
  }
  return index;
}

/** Resolve one finding by id, or `null` when it is not present. */
export function findFinding(
  findings: ReadonlyArray<Finding>,
  findingId: FindingId,
): Finding | null {
  return findings.find((f) => f.id === findingId) ?? null;
}

/**
 * Resolve a disposition back to the finding it judged and that
 * finding's evidence.
 *
 * Throws when the finding is absent rather than returning `null`. A
 * disposition pointing at a finding nobody holds is a broken ledger,
 * and silently returning a partial lineage would let #64 count it in a
 * denominator with no numerator contribution.
 */
export function resolveDispositionLineage(
  disposition: Disposition,
  findings: ReadonlyArray<Finding>,
): FindingLineage {
  const finding = findFinding(findings, disposition.findingId);
  if (finding === null) {
    throw new ReviewContractError(
      `disposition ${disposition.id} refers to finding ${disposition.findingId}, which is not ` +
        `present; a disposition may not be aggregated without the finding it judged`,
      'disposition.findingId',
      { dispositionId: disposition.id, findingId: disposition.findingId },
    );
  }
  return Object.freeze({
    dispositionId: disposition.id,
    finding,
    findingId: finding.id,
    // Same instance, deliberately. See the module docstring.
    evidenceRefs: finding.evidenceRefs,
    target: finding.target,
    runId: finding.observedIn,
    identityIds: finding.identityIds,
    observedAt: finding.observedAt,
    longitudinal: finding.longitudinal,
    isDecision: isCustomerDecision(disposition),
  });
}

/**
 * Resolve every disposition, in input order.
 *
 * Fails on the first unresolvable disposition rather than skipping it:
 * a partially resolved lineage list is the shape of a report that
 * under-counts, and a KPI that quietly shrinks its denominator is
 * worse than one that fails loudly.
 */
export function resolveAllDispositionLineages(
  dispositions: ReadonlyArray<Disposition>,
  findings: ReadonlyArray<Finding>,
): ReadonlyArray<FindingLineage> {
  return Object.freeze(
    dispositions.map((d) => resolveDispositionLineage(d, findings)),
  );
}
