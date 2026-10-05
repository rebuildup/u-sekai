/**
 * Durable-ish storage for the control plane (issue #66).
 *
 * ## Tenant-prefixed keys, not tenant-filtered rows
 *
 * Every method takes `tenantId` as its first argument and every key is
 * built with {@link tenantKey}, so isolation is a property of the key
 * space rather than of a `WHERE tenant = ?` somebody has to remember. A
 * bug that forgets a filter produces a *missing* record, not a
 * neighbour's: a lookup for the wrong tenant finds nothing because that
 * key was never written.
 *
 * ## Synchronous on purpose
 *
 * The read-modify-write in `submitTriggerEvaluation` — read the
 * program ledger, plan against it, store the advanced ledger — is only
 * atomic if nothing can interleave inside it. With synchronous methods
 * the whole sequence runs to completion in one turn of the event loop,
 * so two concurrent identical submissions cannot both read a
 * zero-spend ledger and both charge. Making these methods `async` would
 * silently turn that guarantee off, so the interface is synchronous and
 * a durable implementation must provide the same property (a
 * transaction, a compare-and-set, or a single-writer queue).
 *
 * `test/integration/service/idempotency.test.ts` fires the duplicate
 * submissions concurrently rather than in sequence for exactly this
 * reason: a sequential test passes against a racy store too.
 *
 * ## The compare-and-set is the concurrency guard
 *
 * `compareAndSetJob` is the only way a job's status changes. It refuses
 * unless the stored record still matches the `(status, revision)` the
 * caller last read, which is what makes the `queued -> running` edge
 * takeable exactly once even while an executor is in flight.
 */

import type { ProductId, ProductModel, ReviewProgramId } from '../product/index.js';
import type { BudgetLedger, EvaluationPlan, PlanKey } from '../program/index.js';
import type { EvaluationJob, JobStatus } from './job.js';
import type { JobId, TenantId } from './identity.js';
import type {
  DeclaredFinding,
  DeclaredRunId,
  ServiceRunRecord,
} from './run-record.js';

/** Composite key. `|` cannot appear in a tenant id, so this is injective. */
export function tenantKey(tenantId: TenantId, rest: string): string {
  return `${tenantId}|${rest}`;
}

export interface JobFilter {
  readonly productId?: ProductId;
  readonly programId?: ReviewProgramId;
  readonly status?: JobStatus;
}

export interface RunFilter {
  readonly productId?: ProductId;
  readonly programId?: ReviewProgramId;
  readonly jobId?: JobId;
}

/** The identifier a disposition submission was first accepted under. */
export interface DispositionReceipt {
  readonly tenantId: TenantId;
  readonly requestId: string;
  readonly dispositionId: string;
  readonly productId: ProductId;
}

export interface ServiceStore {
  /* ---- durable model registry -------------------------------------- */

  getModel(tenantId: TenantId, productId: ProductId): ProductModel | undefined;
  putModel(tenantId: TenantId, productId: ProductId, model: ProductModel): void;

  /* ---- jobs --------------------------------------------------------- */

  getJob(tenantId: TenantId, jobId: JobId): EvaluationJob | undefined;
  listJobs(tenantId: TenantId, filter: JobFilter): ReadonlyArray<EvaluationJob>;
  /**
   * Insert a brand-new job.
   *
   * Returns `false` when a job with that id already exists for the
   * tenant, and writes nothing. The check and the write are one
   * operation, so a concurrent insert of the same id cannot both
   * succeed — a second "new job" with the same id would be a second
   * evaluation behind one identity.
   */
  insertJob(tenantId: TenantId, job: EvaluationJob): boolean;
  /**
   * Commit a status change, or refuse.
   *
   * @throws ServiceError `stale-job-revision` when the stored record is
   * not the one the caller read, and `illegal-job-transition` when the
   * move itself is not in {@link JOB_TRANSITIONS}.
   */
  compareAndSetJob(
    tenantId: TenantId,
    jobId: JobId,
    expected: { readonly status: JobStatus; readonly revision: number },
    next: EvaluationJob,
  ): EvaluationJob;

  /* ---- the plan a job executes ------------------------------------- */

  /**
   * Store the plan the job was created for.
   *
   * The plan is stored, not recomputed, and that is deliberate: it is
   * the artefact #62 reserved budget against and the only thing the job
   * is authorised to do. Re-planning at execution time would run a
   * possibly-different evaluation under an already-spent reservation,
   * and would make the answer depend on whether the program had been
   * edited in between.
   */
  putPlan(tenantId: TenantId, jobId: JobId, plan: EvaluationPlan): void;
  planForJob(tenantId: TenantId, jobId: JobId): EvaluationPlan | undefined;

  /* ---- plan / idempotency binding ---------------------------------- */

  jobIdForPlanKey(tenantId: TenantId, planKey: PlanKey): JobId | undefined;
  /**
   * Bind a plan key to a job.
   *
   * Idempotent when the binding already exists, and **refuses** when
   * the same plan key is bound to a *different* job id: that is two
   * jobs claiming one evaluation, and returning the first would make
   * the second caller believe its work was scheduled.
   */
  bindPlanKey(tenantId: TenantId, planKey: PlanKey, jobId: JobId, conflictCode: 'idempotency-conflict'): JobId;

  /* ---- budget ledger ------------------------------------------------ */

  getLedger(tenantId: TenantId, programId: ReviewProgramId): BudgetLedger | undefined;
  putLedger(tenantId: TenantId, ledger: BudgetLedger): void;

  /* ---- runs --------------------------------------------------------- */

  putRun(tenantId: TenantId, run: DeclaredRunRecord): void;
  getRun(tenantId: TenantId, runId: DeclaredRunId): DeclaredRunRecord | undefined;
  listRuns(tenantId: TenantId, filter: RunFilter): ReadonlyArray<DeclaredRunRecord>;

  /* ---- finding index ------------------------------------------------ */

  /**
   * Every finding the tenant holds, for disposition lookup.
   *
   * A separate index rather than a scan of `listRuns` because
   * `submitDisposition` must refuse an unknown finding id: a disposition
   * is a reference to a real finding (#61), and one pointing at nothing
   * is not a judgement.
   */
  findingsForTenant(tenantId: TenantId): ReadonlyArray<DeclaredFinding>;

  /* ---- disposition idempotency -------------------------------------- */

  getDispositionReceipt(tenantId: TenantId, requestId: string): DispositionReceipt | undefined;
  putDispositionReceipt(receipt: DispositionReceipt): void;
}

/** The run record a completed job produces. Defined in `run-record.ts`. */
export type DeclaredRunRecord = ServiceRunRecord;

/**
 * In-memory {@link ServiceStore}.
 *
 * The issue scopes a production database out of this ticket explicitly.
 * What is *not* scoped out is the isolation and concurrency property, so
 * this implementation keeps both: tenant-prefixed keys (inherited from
 * the key scheme) and synchronous compare-and-set writes.
 */
export class InMemoryServiceStore implements ServiceStore {
  readonly #models = new Map<string, ProductModel>();
  readonly #jobs = new Map<string, EvaluationJob>();
  readonly #plans = new Map<string, EvaluationPlan>();
  readonly #planKeyBindings = new Map<string, JobId>();
  readonly #ledgers = new Map<string, BudgetLedger>();
  readonly #runs = new Map<string, DeclaredRunRecord>();
  readonly #findings = new Map<string, DeclaredFinding>();
  readonly #receipts = new Map<string, DispositionReceipt>();

  getModel(tenantId: TenantId, productId: ProductId): ProductModel | undefined {
    return this.#models.get(tenantKey(tenantId, `model:${productId}`));
  }

  putModel(tenantId: TenantId, productId: ProductId, model: ProductModel): void {
    this.#models.set(tenantKey(tenantId, `model:${productId}`), model);
  }

  getJob(tenantId: TenantId, jobId: JobId): EvaluationJob | undefined {
    return this.#jobs.get(tenantKey(tenantId, `job:${jobId}`));
  }

  listJobs(tenantId: TenantId, filter: JobFilter): ReadonlyArray<EvaluationJob> {
    const prefix = `${tenantId}|job:`;
    const out: EvaluationJob[] = [];
    for (const [key, job] of this.#jobs) {
      if (!key.startsWith(prefix)) continue;
      if (filter.productId !== undefined && job.productId !== filter.productId) continue;
      if (filter.programId !== undefined && job.programId !== filter.programId) continue;
      if (filter.status !== undefined && job.status !== filter.status) continue;
      out.push(job);
    }
    return Object.freeze(out.sort(compareJobs));
  }

  insertJob(tenantId: TenantId, job: EvaluationJob): boolean {
    const key = tenantKey(tenantId, `job:${job.id}`);
    if (this.#jobs.has(key)) {
      return false;
    }
    this.#jobs.set(key, job);
    return true;
  }

  putPlan(tenantId: TenantId, jobId: JobId, plan: EvaluationPlan): void {
    this.#plans.set(tenantKey(tenantId, `planOf:${jobId}`), plan);
  }

  planForJob(tenantId: TenantId, jobId: JobId): EvaluationPlan | undefined {
    return this.#plans.get(tenantKey(tenantId, `planOf:${jobId}`));
  }

  compareAndSetJob(
    tenantId: TenantId,
    jobId: JobId,
    expected: { readonly status: JobStatus; readonly revision: number },
    next: EvaluationJob,
  ): EvaluationJob {
    const key = tenantKey(tenantId, `job:${jobId}`);
    const current = this.#jobs.get(key);
    if (current === undefined) {
      throw new ServiceStoreMiss(`job ${jobId} is not stored for ${tenantId}`);
    }
    if (current.status !== expected.status || current.revision !== expected.revision) {
      throw new StaleJobRevision(current, expected);
    }
    this.#jobs.set(key, next);
    return next;
  }

  jobIdForPlanKey(tenantId: TenantId, planKey: PlanKey): JobId | undefined {
    return this.#planKeyBindings.get(tenantKey(tenantId, `plan:${planKey}`));
  }

  bindPlanKey(
    tenantId: TenantId,
    planKey: PlanKey,
    jobId: JobId,
    conflictCode: 'idempotency-conflict',
  ): JobId {
    const key = tenantKey(tenantId, `plan:${planKey}`);
    const existing = this.#planKeyBindings.get(key);
    if (existing === undefined) {
      this.#planKeyBindings.set(key, jobId);
      return jobId;
    }
    if (existing === jobId) {
      return existing;
    }
    throw new PlanKeyConflict(planKey, existing, jobId, conflictCode);
  }

  getLedger(tenantId: TenantId, programId: ReviewProgramId): BudgetLedger | undefined {
    return this.#ledgers.get(tenantKey(tenantId, `ledger:${programId}`));
  }

  putLedger(tenantId: TenantId, ledger: BudgetLedger): void {
    this.#ledgers.set(tenantKey(tenantId, `ledger:${ledger.programId}`), ledger);
  }

  putRun(tenantId: TenantId, run: DeclaredRunRecord): void {
    this.#runs.set(tenantKey(tenantId, `run:${run.runId}`), run);
    for (const finding of run.findings) {
      this.#findings.set(tenantKey(tenantId, `finding:${finding.id}`), finding);
    }
  }

  getRun(tenantId: TenantId, runId: DeclaredRunId): DeclaredRunRecord | undefined {
    return this.#runs.get(tenantKey(tenantId, `run:${runId}`));
  }

  listRuns(tenantId: TenantId, filter: RunFilter): ReadonlyArray<DeclaredRunRecord> {
    const prefix = `${tenantId}|run:`;
    const out: DeclaredRunRecord[] = [];
    for (const [key, run] of this.#runs) {
      if (!key.startsWith(prefix)) continue;
      if (filter.productId !== undefined && run.productId !== filter.productId) continue;
      if (filter.programId !== undefined && run.programId !== filter.programId) continue;
      if (filter.jobId !== undefined && run.jobId !== filter.jobId) continue;
      out.push(run);
    }
    return Object.freeze(out.sort((a, b) => (a.startedAt === b.startedAt ? (a.runId < b.runId ? -1 : 1) : a.startedAt < b.startedAt ? -1 : 1)));
  }

  findingsForTenant(tenantId: TenantId): ReadonlyArray<DeclaredFinding> {
    const prefix = `${tenantId}|finding:`;
    const out: DeclaredFinding[] = [];
    for (const [key, finding] of this.#findings) {
      if (key.startsWith(prefix)) out.push(finding);
    }
    return Object.freeze(out);
  }

  getDispositionReceipt(tenantId: TenantId, requestId: string): DispositionReceipt | undefined {
    return this.#receipts.get(tenantKey(tenantId, `receipt:${requestId}`));
  }

  putDispositionReceipt(receipt: DispositionReceipt): void {
    this.#receipts.set(tenantKey(receipt.tenantId, `receipt:${receipt.requestId}`), receipt);
  }
}

/** Ordering for status listings: submission instant, then id. */
function compareJobs(a: EvaluationJob, b: EvaluationJob): number {
  if (a.submittedAt !== b.submittedAt) return a.submittedAt < b.submittedAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A job vanished between a read and a write. Internal; the service maps it. */
export class ServiceStoreMiss extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceStoreMiss';
  }
}

/** A concurrent writer advanced the job first. */
export class StaleJobRevision extends Error {
  constructor(
    readonly current: EvaluationJob,
    readonly expected: { readonly status: JobStatus; readonly revision: number },
  ) {
    super(
      `job is at ${current.status} revision ${current.revision}, not ${expected.status} revision ${expected.revision}`,
    );
    this.name = 'StaleJobRevision';
  }
}

/** Two different jobs claimed one plan key. */
export class PlanKeyConflict extends Error {
  constructor(
    readonly planKey: PlanKey,
    readonly existingJobId: JobId,
    readonly requestedJobId: JobId,
    readonly code: 'idempotency-conflict',
  ) {
    super(`plan ${planKey} is already bound to job ${existingJobId}, not ${requestedJobId}`);
    this.name = 'PlanKeyConflict';
  }
}
