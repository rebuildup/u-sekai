/**
 * Evaluation job lifecycle (issue #66).
 *
 * ## The state machine, and the property it exists to guarantee
 *
 * ```text
 *            ┌──────────────► cancelled ◄──────────┐
 *            │                  ▲   ▲               │
 *   queued ─┼─► running ───────┘   └───────┐       │
 *            │     │  │                     │       │
 *            │     │  └────► failed ◄────────┘       │
 *            └─────┴───────► succeeded             │
 *                  ▲                                │
 *                  └────────────────────────────────┘
 *                        (failed, from queued)
 * ```
 *
 * Read it for what it forbids. `succeeded`, `failed` and `cancelled`
 * have **empty outgoing sets**, so no path returns to `queued` or
 * `running` — there is no re-entrant edge to take by accident, and
 * {@link assertJobTransition} refuses every one of them.
 *
 * ## Enforced, not merely documented
 *
 * A transition table is only worth the paper if the check is on the
 * write path. Two independent guards, both observable from outside:
 *
 * 1. {@link assertJobTransition} raises `illegal-job-transition` before
 *    a transition is even attempted.
 * 2. `store.ts` performs every job write as a compare-and-set against
 *    the record's `(status, revision)`. A second writer that read the
 *    job before the first one advanced it cannot commit, and gets
 *    `stale-job-revision` instead. This is what makes concurrent
 *    `runJob` calls safe even though the executor is asynchronous: the
 *    `queued -> running` edge can be taken exactly once.
 *
 * Neither guard is a convention a caller has to remember. Both are
 * exercised in `test/integration/service/job-lifecycle.test.ts`.
 *
 * ## `outcome` is separate from `status`, and that is the point
 *
 * `status` says where the job is; `outcome` says what happened to the
 * work. They are not redundant: a job that was **never scheduled** and a
 * job that **ran and produced nothing** both have an empty run list,
 * and conflating them is how "did not run" gets recorded as "nothing
 * to report". So:
 *
 * - `notStarted` — no execution was attempted. Covers `queued` and
 *   `running`, and is the *only* outcome a terminal state may not
 *   carry, because a terminal state always knows what happened.
 * - `completed` — a run exists. It may still have found nothing; that
 *   is a different fact and lives in the run record.
 * - `failed` — execution was attempted and did not finish.
 * - `cancelled` — deliberately stopped before or during execution.
 *
 * `succeeded` is defined as "a run exists", not "a run found
 * something". A run whose every participant hit a `SetupFailure` is a
 * successful *job* with a reportable *failure*, and the two are
 * recorded in two different fields precisely so neither is lost.
 */

import type { EvaluationRunId, ProductId, ReviewProgramId } from '../product/index.js';
import type { IdempotencyKey, PlanKey } from '../program/index.js';
import { ServiceError } from './errors.js';
import type { JobId, TenantId } from './identity.js';

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses no transition may leave. */
export const TERMINAL_JOB_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;
export type TerminalJobStatus = (typeof TERMINAL_JOB_STATUSES)[number];

export function isTerminalJobStatus(status: JobStatus): status is TerminalJobStatus {
  return (TERMINAL_JOB_STATUSES as ReadonlyArray<string>).includes(status);
}

/**
 * The complete legal move table. Every entry is checked; anything
 * absent is illegal.
 *
 * `queued -> failed` exists because an executor can be *unavailable* at
 * dispatch time (a provider refused to construct a Reasoner), which is
 * a failure of the job and not of a run — there is no run to attach it
 * to. `queued -> cancelled` exists for the same reason: cancelling work
 * that has not started is the ordinary case.
 */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, ReadonlyArray<JobStatus>>> = Object.freeze({
  queued: Object.freeze(['running', 'failed', 'cancelled'] as const),
  running: Object.freeze(['succeeded', 'failed', 'cancelled'] as const),
  succeeded: Object.freeze([] as const),
  failed: Object.freeze([] as const),
  cancelled: Object.freeze([] as const),
});

export function isLegalJobTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

/** Throw unless `to` may legally follow `from`. */
export function assertJobTransition(from: JobStatus, to: JobStatus, field = 'job.status'): void {
  if (!isLegalJobTransition(from, to)) {
    const allowed = JOB_TRANSITIONS[from];
    throw new ServiceError(
      allowed.length === 0
        ? `${field}: job status ${from} is terminal and has no legal successor (requested ${to})`
        : `${field}: illegal job transition ${from} -> ${to}; allowed from ${from}: ${allowed.join(', ')}`,
      'illegal-job-transition',
      field,
      { from, to, allowed: [...allowed] },
    );
  }
}

/** What happened to the work, independent of where the job now sits. */
export type JobOutcome =
  | {
      /** No execution was attempted. The only outcome `queued`/`running` may carry. */
      readonly kind: 'notStarted';
    }
  | {
      /** A run exists. It may have found nothing; see the run record. */
      readonly kind: 'completed';
      readonly runId: EvaluationRunId;
    }
  | {
      /** Execution was attempted and did not finish. */
      readonly kind: 'failed';
      readonly reason: string;
      readonly at: string;
    }
  | {
      readonly kind: 'cancelled';
      readonly reason: string;
      readonly at: string;
    };

export interface EvaluationJob {
  readonly id: JobId;
  readonly tenantId: TenantId;
  readonly productId: ProductId;
  readonly programId: ReviewProgramId;
  /**
   * The plan this job will run.
   *
   * #62 derived it, and it is the job's idempotent identity: two
   * submissions that resolve to the same plan key are the same job,
   * whichever job id the caller declared.
   */
  readonly planKey: PlanKey;
  readonly idempotencyKey: IdempotencyKey;
  readonly status: JobStatus;
  /**
   * Monotonic writer counter, bumped by every committed transition.
   *
   * The compare-and-set guard in `store.ts` compares this, so a
   * concurrent writer is refused rather than overwriting.
   */
  readonly revision: number;
  readonly outcome: JobOutcome;
  readonly submittedAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
}
