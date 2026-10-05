/**
 * Customer disposition and KPI aggregation for Issue #67.
 *
 * ## The one thing this fixture is careful about
 *
 * A disposition is a **reference** to a finding, not a copy of it
 * (`src/review/disposition.ts`). The scenario therefore snapshots the
 * finding before recording a decision and compares it byte for byte
 * afterwards: if recording a disposition could edit the finding, the
 * customer would be able to change history, and every longitudinal claim
 * downstream would be unreviewable.
 *
 * ## Every value goes through the layer that owns its grammar
 *
 * A `Disposition` is built by #61's `parseDisposition` through #64's
 * `appendDisposition`, and a `KpiSnapshot` comes from #64's
 * `computeKpiSnapshot`. Nothing here hand-assembles either, so the
 * scenario cannot demonstrate a KPI the implementation would refuse to
 * produce.
 */

import {
  appendDisposition,
  computeKpiSnapshot,
  emptyLedger,
  kpiSnapshotFromOutcomes,
  type DispositionLedger,
  type KpiSnapshot,
} from '../../../src/feedback/index.js';
import { parseDisposition, type Disposition, type Finding, type ReviewOutcome } from '../../../src/review/index.js';

/** The customer workspace that records the decision. Never a secret. */
export const CUSTOMER_ACTOR = 'acme-product-workspace';

export interface DispositionInput {
  readonly findingId: string;
  readonly kind: Disposition['kind'];
  readonly state: Disposition['state'];
  readonly dispositionId: string;
  readonly decidedAt: string;
  readonly actorKind?: Disposition['actor']['kind'];
  readonly actorReference?: string;
  readonly rationale?: string;
  readonly action?: { readonly kind: string; readonly reference: string; readonly label: string };
  readonly supersedes?: string;
}

/**
 * A `Disposition` through #61's parser, with the `exactOptionalPropertyTypes`
 * discipline applied: an omitted optional is *absent*, not `undefined`.
 */
export function makeDisposition(input: DispositionInput): Disposition {
  return parseDisposition({
    id: input.dispositionId,
    findingId: input.findingId,
    kind: input.kind,
    state: input.state,
    actor: {
      kind: input.actorKind ?? 'customer',
      reference: input.actorReference ?? CUSTOMER_ACTOR,
    },
    decidedAt: input.decidedAt,
    ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
    ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
    ...(input.action === undefined
      ? {}
      : { action: { kind: input.action.kind, reference: input.action.reference } }),
  });
}

export function recordDisposition(ledger: DispositionLedger, disposition: Disposition): DispositionLedger {
  return appendDisposition(ledger, disposition);
}

export function kpiFor(
  findings: ReadonlyArray<Finding>,
  ledger: DispositionLedger,
): KpiSnapshot {
  return computeKpiSnapshot({ findings, ledger });
}

/**
 * The same snapshot from a run's mixed outcome stream.
 *
 * The one that *records* the setup failures it excluded, so a report
 * built from a run's raw outcomes cannot quietly drop a setup failure
 * into a rate.
 */
export function kpiFromOutcomes(
  outcomes: ReadonlyArray<ReviewOutcome>,
  ledger: DispositionLedger,
): KpiSnapshot {
  return kpiSnapshotFromOutcomes(outcomes, ledger);
}

export { emptyLedger };
export type { DispositionLedger, KpiSnapshot };
