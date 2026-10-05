/**
 * What one completed evaluation run leaves behind (issue #66).
 *
 * ## The record has to answer "did it run?" on its own
 *
 * A consumer asking a control plane for findings gets one of three very
 * different situations, and a service that collapses any two of them
 * has a bug that only shows up as a wrong number months later:
 *
 * 1. the run happened and found problems;
 * 2. the run happened and found nothing;
 * 3. **the run did not happen.**
 *
 * (3) is the one this project keeps getting wrong (Issue #78 ran zero
 * tests and exited green; a `ty-plus` partition executed nothing and
 * reported success). So `ServiceRunRecord` exists as a *value*: a run
 * that happened is a record, and its absence is visible as an absent
 * record rather than as an empty array. `setupFailures` is a separate
 * field from `findings` for the same reason — a run where every
 * participant hit a setup failure has zero findings and a non-empty
 * failure list, and a reader can tell those apart without inspecting
 * anything else.
 *
 * `mode` and `lineage` are recorded rather than re-derived, because
 * `docs/product/kpis.md` and #57's release-transition joins both key
 * off them; a summary that recomputed them from a plan it no longer has
 * would be able to disagree with the run it describes.
 */

import type {
  EvaluationTargetRef,
  RunLineage,
} from '../product/index.js';
import type { Finding, SetupFailure } from '../review/index.js';
import type { EvaluationMode } from '../review/index.js';
import type { DeclaredCost } from './cost.js';
import type { JobId, TenantId } from './identity.js';
import type { ProductId, ReviewProgramId } from '../product/index.js';

/**
 * The run id, as this service records it.
 *
 * A string rather than #57's `EvaluationRunId` brand: the run id is
 * minted by the runtime (#63), not by the durable model, and this layer
 * stores whatever the executor returned without claiming to own its
 * grammar. It is still validated as a non-empty bounded string.
 */
export type DeclaredRunId = string & { readonly __runId?: never };

export type DeclaredFinding = Finding;
export type DeclaredSetupFailure = SetupFailure;
export type DeclaredMode = EvaluationMode;
export type DeclaredLineage = RunLineage;

export interface ServiceRunRecord {
  readonly tenantId: TenantId;
  readonly jobId: JobId;
  readonly productId: ProductId;
  readonly programId: ReviewProgramId;
  readonly runId: DeclaredRunId;
  /** The durable target the run observed. Reused, never recomputed. */
  readonly target: EvaluationTargetRef;
  readonly mode: DeclaredMode;
  readonly lineage: DeclaredLineage;
  readonly findings: ReadonlyArray<DeclaredFinding>;
  /**
   * Setup failures, kept apart from `findings` and never merged into
   * it. #61 makes the two types structurally non-assignable, and
   * #64's KPIs must never see a setup failure in a numerator or a
   * denominator.
   */
  readonly setupFailures: ReadonlyArray<DeclaredSetupFailure>;
  /** True when the World Operator refused setup and nobody explored. */
  readonly setupRefused: boolean;
  /**
   * World-state accounting, summarised rather than carried whole.
   *
   * The full #59 audit stays in the run's artifact directory. What the
   * control plane publishes is the count a caller needs to know that
   * privileged effects happened at all — including the zero case, which
   * is how "the gate refused, so nothing was dispatched" becomes
   * checkable from outside the operator package.
   */
  readonly privilegedEffects: {
    readonly declared: boolean;
    readonly refused: boolean;
    readonly auditRecordCount: number;
  };
  /** The plan's declared cost, in the service's declared unit. */
  readonly cost: DeclaredCost;
  readonly startedAt: string;
  readonly endedAt: string;
  /** Directory the runtime wrote the run artifact to. */
  readonly artifactDir: string;
}
