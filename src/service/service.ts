/**
 * The managed-service control plane (issue #66, ADR-0011).
 *
 * ## Shape
 *
 * ```text
 *   registerProduct / registerEnvironment / registerProgram   -> #57
 *   submitTriggerEvaluation                                   -> #62
 *   runJob                                                    -> #63 (via the gate in #59)
 *   getFindings                                               -> #61 records
 *   submitDisposition                                         -> #64 (via FeedbackSink)
 * ```
 *
 * The service is a **facade over injected collaborators**, not a new
 * domain. It holds no evaluation logic of its own: every decision it
 * reports was made by #57 (is this declaration valid?), #62 (is this
 * due, and may it be charged?), #61 (is this disposition legal?) or
 * #63/#59 (what happened, and was anything dispatched?). What this
 * layer owns is the part none of them can: tenancy, capability
 * checking, job lifecycle, idempotency, and the accounting that makes
 * "did not run" visible.
 *
 * ## Asynchronous-job shaped, even though it runs locally
 *
 * {@link EvaluationControlPlane.submitTriggerEvaluation} returns a
 * `queued` job and never executes. Execution is a separate,
 * explicitly-called step ({@link EvaluationControlPlane.runJob}). That
 * is not ceremony: it is what makes a queue, a worker fleet or a
 * webhook re-delivery a deployment change rather than a rewrite, and it
 * is why the duplicate-submission test can assert the executor was
 * never called.
 *
 * ## Nothing ambient
 *
 * No `process.env`, no `cwd`, no `Date.now()`, no module-level mutable
 * state, no default principal, no default cost unit, no singleton. The
 * clock is a required argument. A second tenant in the same process
 * cannot influence the first, and a test pins every instant.
 *
 * ## Concurrency
 *
 * Two protections, both structural:
 *
 * - **Idempotent submission.** #62 refuses a re-presented trigger as
 *   `duplicate` *before* any budget moves, so the ledger cannot be
 *   charged twice for one evaluation. The service stores the advanced
 *   ledger and binds the plan key to the job in the same synchronous
 *   turn, so two concurrent identical submissions cannot both read a
 *   zero-spend ledger.
 * - **Compare-and-set job transitions.** Every status change goes
 *   through `store.compareAndSetJob`, so `queued -> running` is
 *   takeable exactly once and a terminal status has no successor.
 *
 * ## The operator gate
 *
 * This package holds no connector, no operator and no privileged step
 * type, and has no import edge into `src/operator/**` at all. A run's
 * privileged effects are reached only through the injected executor,
 * which calls #63's `runEvaluation` — the single call site that hands a
 * plan to #59's gate. See `executor.ts` for the argument and
 * `test/integration/service/operator-boundary.test.ts` for the two
 * independent observations of it.
 */

import {
  buildProductModel,
  findEnvironment,
  findProgram,
  parseProductId,
  type Environment,
  type ProductModel,
  type ProductId,
  type ReviewProgram,
  type ReviewProgramId,
} from '../product/index.js';
import {
  authorityRef,
  createBudgetLedger,
  defaultBudgetWindow,
  parseStageCostRates,
  planEvaluation,
  type BudgetLedger,
  type EnvironmentObservation,
  type EvaluationPlan,
  type StageCostRates,
} from '../program/index.js';
import {
  assertDispositionTransition,
  INITIAL_DISPOSITION_STATE,
  parseDisposition,
  parseDispositionAction,
  type Disposition,
  type DispositionState,
  type Finding,
  type SetupFailure,
} from '../review/index.js';
import { declaredCost, parseServiceCostPolicy, type DeclaredCost, type ServiceCostPolicy } from './cost.js';
import { attempt, ServiceError, asServiceError, isServiceError } from './errors.js';
import type { EvaluationExecutor } from './executor.js';
import { UnavailableFeedbackSink, type FeedbackSink } from './feedback.js';
import {
  assertCapability,
  assertTenant,
  type JobId,
  type ServiceCapability,
  type ServicePrincipal,
  type TenantId,
} from './identity.js';
import { assertJobTransition, isTerminalJobStatus, type EvaluationJob, type JobStatus } from './job.js';
import {
  parseCancelJobRequest,
  parseGetFindingsRequest,
  parseGetJobRequest,
  parseListJobsRequest,
  parseRegisterEnvironmentRequest,
  parseRegisterProductRequest,
  parseRegisterProgramRequest,
  parseSubmitDispositionRequest,
  parseTriggerEvaluationRequest,


  type RegisterEnvironmentRequest,
  type RegisterProductRequest,
  type RegisterProgramRequest,

  type TriggerEvaluationRequest,
} from './requests.js';
import type { ServiceRunRecord } from './run-record.js';
import {
  InMemoryServiceStore,
  PlanKeyConflict,
  ServiceStoreMiss,
  StaleJobRevision,
  type JobFilter,
  type RunFilter,
  type ServiceStore,
} from './store.js';

/* -------------------------------------------------------------------------- */
/* Configuration                                                                 */
/* -------------------------------------------------------------------------- */

/** Planning policy. Service-level, never per request. */
export interface ServicePlanningConfig {
  /** Upper bound on identities one plan may cover. */
  readonly planningCeiling: number;
  /** Declared cost rates. Consumed by #62; never derived from telemetry. */
  readonly rates: StageCostRates;
  /** Cap on environment-mutating actions a plan may declare. */
  readonly maxMutatingActions: number;
  /** Opaque authority grants from #59. Passed through, never interpreted. */
  readonly operatorAuthorityRefs?: ReadonlyArray<string>;
  /**
   * Version observations available to the planner.
   *
   * Injected rather than read from a store so a release transition is a
   * function of evidence the caller holds, not of whatever the process
   * happens to have observed. Absent means "no version lineage is
   * known", which is an honest answer, not a default of `[]` pretending
   * a comparison happened.
   */
  readonly observations?: (
    productId: ProductId,
    programId: ReviewProgramId,
  ) => ReadonlyArray<EnvironmentObservation>;
}

export interface ServiceConfig {
  /**
   * The declared cost unit and its reportable precision.
   *
   * **Required, with no default.** `docs/product/kpis.md` names the
   * cost *sources* and not a unit, ADR-0011 forbids a vendor-
   * denominated one, and #64 routed the gap here. Until the product
   * decides, this service refuses to start without an explicit answer
   * rather than inventing a precision. See `cost.ts`.
   */
  readonly cost: unknown;
  readonly planning: ServicePlanningConfig;
  /** Storage. Defaults to an in-memory store; the issue scopes a database out. */
  readonly store?: ServiceStore;
  /** Runs a plan. Defaults to an executor that refuses. */
  readonly executor?: EvaluationExecutor;
  /** Disposition ledger. Defaults to one that refuses, loudly. */
  readonly feedback?: FeedbackSink;
  /**
   * The service's clock.
   *
   * Required. A control plane that read the wall clock would stamp
   * jobs with instants no test can pin, and would make "two submissions
   * of the same trigger" depend on how long the first one took.
   */
  readonly clock: () => string;
}

/* -------------------------------------------------------------------------- */
/* Results                                                                       */
/* -------------------------------------------------------------------------- */

export interface TriggerAccepted {
  readonly accepted: true;
  readonly job: EvaluationJob;
  /** True when this submission resolved to a job that already existed. */
  readonly deduplicated: boolean;
}

export interface TriggerNotDue {
  readonly accepted: false;
  readonly reason: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly nextDueAt?: string;
  /** Always empty. A trigger that is not due produced no work. */
  readonly job?: undefined;
}

export type TriggerResult = TriggerAccepted | TriggerNotDue;

export interface DispositionAccepted {
  readonly recorded: true;
  readonly disposition: Disposition;
  readonly duplicate: boolean;
  /** The state the finding was in immediately before this submission. */
  readonly previousState: DispositionState;
}

/**
 * Why a report is not simply a list of findings.
 *
 * `definitive` is the single question a consumer has to ask. It is
 * `false` when the scope contains **no job at all**, or whenever any
 * job in scope is still queued or running, or failed or was cancelled
 * without producing a run — because in every one of those cases "no
 * findings" means "we do not know", not "there was nothing". The
 * empty-scope case is called out because `every` over an empty array
 * is `true`, which would make a program that has never been evaluated
 * report a definitive zero. A report with `definitive: false` and an
 * empty `findings` array is the failure this project has hit before
 * (Issue #78 ran zero tests and exited green), so it is a first-class,
 * assertable state rather than something a reader has to infer.
 */
export interface FindingsReport {
  readonly tenantId: TenantId;
  readonly scope: { readonly jobId?: JobId; readonly productId?: ProductId; readonly programId?: ReviewProgramId };
  readonly jobs: ReadonlyArray<EvaluationJob>;
  readonly runs: ReadonlyArray<ServiceRunRecord>;
  readonly findings: ReadonlyArray<Finding>;
  /** Never merged into `findings`, and never in a KPI denominator. */
  readonly setupFailures: ReadonlyArray<SetupFailure>;
  /**
   * Jobs that produced no run, and why.
   *
   * `failed` and `cancelled` are distinguished from `pending` here, so
   * "did not run" is never a single undifferentiated bucket.
   */
  readonly unexecuted: ReadonlyArray<{
    readonly jobId: JobId;
    readonly status: JobStatus;
    readonly reason: string;
  }>;
  readonly coverage: {
    readonly jobsConsidered: number;
    readonly runsExecuted: number;
    readonly jobsPending: number;
    readonly jobsFailed: number;
    readonly jobsCancelled: number;
  };
  /** See the interface docstring. */
  readonly definitive: boolean;
  /** The declared unit and precision. Carried so no consumer guesses. */
  readonly costPolicy: ServiceCostPolicy;
  /**
   * Deliberately `undefined`.
   *
   * The quotient is #64's, and the reportable precision of a
   * cost-per-finding is the open product decision this ticket received
   * and did not answer. Publishing it here would state a scale nobody
   * chose. See `cost.ts`.
   */
  readonly costPerFinding: undefined;
}

/* -------------------------------------------------------------------------- */
/* The control plane                                                             */
/* -------------------------------------------------------------------------- */

export interface EvaluationControlPlane {
  registerProduct(principal: ServicePrincipal, request: unknown): ProductModel;
  registerEnvironment(principal: ServicePrincipal, request: unknown): ProductModel;
  registerProgram(principal: ServicePrincipal, request: unknown): ProductModel;
  getProduct(principal: ServicePrincipal, productId: string): ProductModel;

  submitTriggerEvaluation(principal: ServicePrincipal, request: unknown): TriggerResult;
  runJob(principal: ServicePrincipal, request: unknown): Promise<EvaluationJob>;
  cancelJob(principal: ServicePrincipal, request: unknown): EvaluationJob;
  getJob(principal: ServicePrincipal, request: unknown): EvaluationJob;
  listJobs(principal: ServicePrincipal, request: unknown): ReadonlyArray<EvaluationJob>;

  getFindings(principal: ServicePrincipal, request: unknown): FindingsReport;
  submitDisposition(principal: ServicePrincipal, request: unknown): Promise<DispositionAccepted>;
}

/**
 * Build the control plane.
 *
 * Refuses to construct without a declared cost unit. That is the one
 * validation done eagerly rather than lazily, because a service that
 * can start without a cost policy has already chosen one silently.
 */
export function createService(config: ServiceConfig): EvaluationControlPlane {
  const costPolicy = parseServiceCostPolicy(config.cost, 'config.cost');
  const store = config.store ?? new InMemoryServiceStore();
  const clock = config.clock;
  if (typeof clock !== 'function') {
    throw new ServiceError('config.clock must be a function', 'invalid-request', 'config.clock');
  }
  const planning = config.planning;
  const rates: StageCostRates = attempt(() => parseStageCostRates(planning.rates, 'config.planning.rates'),
    'config.planning.rates',
  );
  const executor = config.executor;
  const feedback = config.feedback ?? new UnavailableFeedbackSink();

  /* ---- registration ------------------------------------------------ */

  function registerProduct(
    principal: ServicePrincipal,
    raw: RegisterProductRequest,
  ): ProductModel {
    assertCapability(principal, 'product:register');
    assertTenant(principal, raw.tenantId);

    // #57 composes and enforces every cross-entity invariant, so a
    // program naming an undeclared environment fails here rather than
    // at trigger time with a confusing cause.
    const model = attempt(() =>
        buildProductModel({
          product: raw.product,
          environments: raw.environments,
          identities: raw.identities,
          cohorts: raw.cohorts,
          programs: raw.programs,
        }),
      'request',
    );

    const existing = store.getModel(raw.tenantId, model.product.id);
    if (existing !== undefined) {
      assertSameRegistration(existing, model, raw.tenantId);
      return existing;
    }
    store.putModel(raw.tenantId, model.product.id, model);
    return model;
  }

  function registerEnvironment(
    principal: ServicePrincipal,
    raw: RegisterEnvironmentRequest,
  ): ProductModel {
    assertCapability(principal, 'environment:register');
    assertTenant(principal, raw.tenantId);
    const current = requireModel(store, raw.tenantId, raw.productId);
    if (raw.environment.productId !== raw.productId) {
      throw new ServiceError(
        `environment ${raw.environment.id} belongs to product ${raw.environment.productId}, not ${raw.productId}`,
        'invalid-request',
        'request.environment.productId',
        { declared: raw.environment.productId, requested: raw.productId },
      );
    }
    if (findEnvironment(current, raw.environment.id) !== undefined) {
      throw new ServiceError(
        `environment ${raw.environment.id} is already registered for ${raw.productId}`,
        'duplicate-registration',
        'request.environment.id',
        { environmentId: raw.environment.id },
      );
    }
    // Re-composing re-runs #57's cross-entity invariants. The refusal
    // is wrapped so a client sees one error type: an incremental
    // registration that would dangle is the same class of problem as a
    // full one that does.
    const next = attempt(
      () => replaceModel(current, { environments: [...current.environments, raw.environment] }),
      'request.environment',
    );
    store.putModel(raw.tenantId, raw.productId, next);
    return next;
  }

  function registerProgram(principal: ServicePrincipal, raw: RegisterProgramRequest): ProductModel {
    assertCapability(principal, 'program:register');
    assertTenant(principal, raw.tenantId);
    const current = requireModel(store, raw.tenantId, raw.productId);
    if (raw.program.productId !== raw.productId) {
      throw new ServiceError(
        `program ${raw.program.id} belongs to product ${raw.program.productId}, not ${raw.productId}`,
        'invalid-request',
        'request.program.productId',
        { declared: raw.program.productId, requested: raw.productId },
      );
    }
    if (findProgram(current, raw.program.id) !== undefined) {
      throw new ServiceError(
        `program ${raw.program.id} is already registered for ${raw.productId}`,
        'duplicate-registration',
        'request.program.id',
        { programId: raw.program.id },
      );
    }
    // buildProductModel is the cross-entity check: a program naming an
    // undeclared cohort or environment is refused here, at
    // registration, where the caller can still fix it. Nothing is
    // stored when it refuses.
    const next = attempt(
      () => replaceModel(current, { programs: [...current.programs, raw.program] }),
      'request.program',
    );
    store.putModel(raw.tenantId, raw.productId, next);
    return next;
  }

  function getProduct(principal: ServicePrincipal, productId: string): ProductModel {
    assertCapability(principal, 'product:read');
    return requireModel(store, principal.tenantId, requireProductId(productId));
  }

  /* ---- triggering -------------------------------------------------- */

  /**
   * Accept a trigger and schedule a job.
   *
   * Asynchronous-job shaped: returns a `queued` job and never executes.
   * The whole read-plan-write sequence is synchronous (see
   * `store.ts`), which is what makes two concurrent identical
   * submissions safe.
   */
  function submitTriggerEvaluation(
    principal: ServicePrincipal,
    raw: TriggerEvaluationRequest,
  ): TriggerResult {
    assertCapability(principal, 'job:submit');
    assertTenant(principal, raw.tenantId);

    const model = requireModel(store, raw.tenantId, raw.productId);
    const program = findProgram(model, raw.programId);
    if (program === undefined) {
      throw new ServiceError(
        `program ${raw.programId} is not registered for ${raw.productId}`,
        'program-not-found',
        'request.programId',
        { programId: raw.programId, productId: raw.productId },
      );
    }

    const now = attempt(() => requireInstant(clock(), 'clock'), 'clock');

    // Already bound to a job: the same evaluation, already scheduled.
    // Returning the existing job is the whole point of the declared job
    // id plus #62's plan key; creating a second one would let one
    // trigger produce two runs and charge the budget twice.
    const ledger = ledgerFor(store, raw.tenantId, program, now);
    const observations = planning.observations?.(raw.productId, raw.programId) ?? [];

    const decision = attempt(() =>
        planEvaluation({
          model,
          programId: raw.programId,
          now,
          signals: [raw.signal],
          observations,
          planningCeiling: planning.planningCeiling,
          rates,
          maxMutatingActions: planning.maxMutatingActions,
          ...(planning.operatorAuthorityRefs !== undefined
            ? {
                operatorAuthorityRefs: planning.operatorAuthorityRefs.map((ref) =>
                  authorityRef(ref),
                ),
              }
            : {}),
          ledger,
        }),
      'request',
    );

    if (decision.outcome === 'not-due') {
      const notDue: {
        accepted: false;
        reason: string;
        detail: Readonly<Record<string, unknown>>;
        nextDueAt?: string;
      } = { accepted: false, reason: decision.reason, detail: decision.detail };
      if (decision.nextDueAt !== undefined) {
        notDue.nextDueAt = decision.nextDueAt;
      }
      return notDue;
    }

    if (decision.outcome === 'duplicate') {
      const bound = store.jobIdForPlanKey(raw.tenantId, decision.planKey);
      if (bound === undefined) {
        // #62 says this trigger was already planned, but this store has
        // no record of it. Reporting "deduplicated" with nothing to
        // point at would tell the caller its work is scheduled when it
        // is not, which is the failure this ticket exists to prevent.
        throw new ServiceError(
          `#62 reports plan ${decision.planKey} as a duplicate but no job is bound to it for ` +
            `${raw.productId}/${raw.programId}; the ledger and the job index disagree`,
          'invalid-request',
          'request.programId',
          { planKey: decision.planKey },
        );
      }
      const existing = requireJob(store, raw.tenantId, bound);
      return { accepted: true, job: existing, deduplicated: true };
    }

    const plan = decision.plan;
    const job = createJob({
      tenantId: raw.tenantId,
      jobId: raw.jobId,
      productId: raw.productId,
      programId: raw.programId,
      planKey: plan.planKey,
      idempotencyKey: plan.idempotencyKey,
      submittedAt: now,
    });

    // Bind first, write second. A conflicting binding is refused rather
    // than overwritten: two job ids claiming one evaluation is an
    // upstream bug, and silently keeping the first would leave the
    // second caller believing its job was scheduled.
    const bound = bindPlanKey(store, raw.tenantId, plan.planKey, raw.jobId);
    if (bound !== raw.jobId) {
      const existing = requireJob(store, raw.tenantId, bound);
      return { accepted: true, job: existing, deduplicated: true };
    }
    // The plan is stored with the job, so the run executes the
    // evaluation that was reserved and charged rather than one
    // re-planned from a program that may since have been edited.
    store.putPlan(raw.tenantId, raw.jobId, plan);
    if (!store.insertJob(raw.tenantId, job)) {
      throw new ServiceError(
        `job ${raw.jobId} already exists for ${raw.tenantId}`,
        'job-already-exists',
        'request.jobId',
        { jobId: raw.jobId },
      );
    }
    // #62's advanced ledger is committed only now, and only for a
    // `due` decision. A duplicate or a not-due never charges.
    store.putLedger(raw.tenantId, decision.ledger);

    return { accepted: true, job, deduplicated: false };
  }

  /* ---- execution --------------------------------------------------- */

  /**
   * Execute one queued job.
   *
   * `queued -> running` is a compare-and-set, so two concurrent calls
   * cannot both execute: the loser is refused with
   * `illegal-job-transition` (the job is no longer `queued`), not
   * silently handed a second run.
   */
  async function runJob(principal: ServicePrincipal, request: unknown): Promise<EvaluationJob> {
    assertCapability(principal, 'job:submit');
    const raw = parseGetJobRequest(request);
    assertTenant(principal, raw.tenantId);
    const current = requireJob(store, raw.tenantId, raw.jobId);
    if (executor === undefined) {
      throw new ServiceError(
        'no EvaluationExecutor is configured: a control plane cannot run a job without one',
        'invalid-request',
        'config.executor',
      );
    }

    const now = attempt(() => requireInstant(clock(), 'clock'), 'clock');
    const started: EvaluationJob = {
      ...current,
      status: 'running',
      revision: current.revision + 1,
      startedAt: now,
    };
    assertJobTransition(current.status, started.status, 'job.status');
    let running: EvaluationJob;
    try {
      running = store.compareAndSetJob(
        raw.tenantId,
        raw.jobId,
        { status: current.status, revision: current.revision },
        started,
      );
    } catch (error) {
      throw mapStoreError(error, raw.tenantId, raw.jobId);
    }

    const model = requireModel(store, raw.tenantId, running.productId);
    const plan = requirePlan(store, running);

    try {
      const { result } = await executor.execute({
        tenantId: running.tenantId,
        jobId: running.id,
        plan,
        model,
      });
      const endedAt = attempt(() => requireInstant(clock(), 'clock'), 'clock');
      const record = toRunRecord({
        tenantId: running.tenantId,
        jobId: running.id,
        result,
        cost: declaredCost(plan.budget.costUnits, costPolicy, 'plan.budget.costUnits'),
      });
      store.putRun(running.tenantId, record);
      const completed: EvaluationJob = {
        ...running,
        status: 'succeeded',
        revision: running.revision + 1,
        endedAt,
        outcome: { kind: 'completed', runId: result.runId },
      };
      assertJobTransition(running.status, completed.status, 'job.status');
      return store.compareAndSetJob(
        running.tenantId,
        running.id,
        { status: running.status, revision: running.revision },
        completed,
      );
    } catch (error) {
      // A failure is recorded on the job, never turned into a
      // `succeeded` job with an empty finding list. Issue #78 and
      // #179 in `ty-plus` are the same bug in a test runner.
      const endedAt = attempt(() => requireInstant(clock(), 'clock'), 'clock');
      const failed: EvaluationJob = {
        ...running,
        status: 'failed',
        revision: running.revision + 1,
        endedAt,
        outcome: { kind: 'failed', reason: describeFailure(error), at: endedAt },
      };
      assertJobTransition(running.status, failed.status, 'job.status');
      try {
        return store.compareAndSetJob(
          running.tenantId,
          running.id,
          { status: running.status, revision: running.revision },
          failed,
        );
      } catch (storeError) {
        throw mapStoreError(storeError, running.tenantId, running.id);
      }
    }
  }

  function cancelJob(principal: ServicePrincipal, request: unknown): EvaluationJob {
    assertCapability(principal, 'job:cancel');
    const raw = parseCancelJobRequest(request);
    assertTenant(principal, raw.tenantId);
    const current = requireJob(store, raw.tenantId, raw.jobId);
    const now = attempt(() => requireInstant(clock(), 'clock'), 'clock');
    const next: EvaluationJob = {
      ...current,
      status: 'cancelled',
      revision: current.revision + 1,
      endedAt: now,
      outcome: { kind: 'cancelled', reason: raw.reason, at: now },
    };
    assertJobTransition(current.status, next.status, 'job.status');
    try {
      return store.compareAndSetJob(
        raw.tenantId,
        raw.jobId,
        { status: current.status, revision: current.revision },
        next,
      );
    } catch (error) {
      throw mapStoreError(error, raw.tenantId, raw.jobId);
    }
  }

  function getJob(principal: ServicePrincipal, request: unknown): EvaluationJob {
    assertCapability(principal, 'job:read');
    const raw = parseGetJobRequest(request);
    assertTenant(principal, raw.tenantId);
    return requireJob(store, raw.tenantId, raw.jobId);
  }

  function listJobs(principal: ServicePrincipal, request: unknown): ReadonlyArray<EvaluationJob> {
    assertCapability(principal, 'job:read');
    const raw = parseListJobsRequest(request);
    assertTenant(principal, raw.tenantId);
    const filter: JobFilter = {
      ...(raw.productId !== undefined ? { productId: raw.productId } : {}),
      ...(raw.programId !== undefined ? { programId: raw.programId } : {}),
      ...(raw.status !== undefined ? { status: raw.status } : {}),
    };
    return store.listJobs(raw.tenantId, filter);
  }

  /* ---- findings ---------------------------------------------------- */

  function getFindings(principal: ServicePrincipal, request: unknown): FindingsReport {
    assertCapability(principal, 'finding:read');
    const raw = parseGetFindingsRequest(request);
    assertTenant(principal, raw.tenantId);

    let jobs: ReadonlyArray<EvaluationJob>;
    let runFilter: RunFilter;
    if (raw.jobId !== undefined) {
      // A job that was never scheduled is `job-not-found`, not an empty
      // report. This is the distinction the whole report shape is
      // built around.
      jobs = Object.freeze([requireJob(store, raw.tenantId, raw.jobId)]);
      runFilter = { jobId: raw.jobId };
    } else {
      jobs = store.listJobs(raw.tenantId, {
        ...(raw.productId !== undefined ? { productId: raw.productId } : {}),
        ...(raw.programId !== undefined ? { programId: raw.programId } : {}),
      });
      runFilter = {
        ...(raw.productId !== undefined ? { productId: raw.productId } : {}),
        ...(raw.programId !== undefined ? { programId: raw.programId } : {}),
      };
    }

    const runs = store.listRuns(raw.tenantId, runFilter);
    const jobsWithRuns = new Set(runs.map((r) => r.jobId));

    // "Did it run?" is answered by the **presence of a run record**, not
    // by the job's status. The two differ in one real case: a cancel
    // that lands while a job is executing. The run did happen and its
    // findings are real, so they belong in the report, and reporting
    // the job as `unexecuted` would be false. `job.status` is still
    // there in `jobs` and in `coverage`; what it must not do is decide
    // whether real evidence exists.
    const unexecuted = jobs
      .filter((job) => !jobsWithRuns.has(job.id))
      .map((job) => ({
        jobId: job.id,
        status: job.status,
        reason: unexecutedReason(job),
      }));

    const jobsPending = jobs.filter((j) => !isTerminalJobStatus(j.status)).length;
    const jobsFailed = jobs.filter((j) => j.status === 'failed').length;
    const jobsCancelled = jobs.filter((j) => j.status === 'cancelled').length;

    // Definitive means: at least one job was considered, and every one
    // of them produced a run. Both halves are load-bearing — an empty
    // job set is "nothing was ever scheduled", which is emphatically
    // not "there was nothing to find", and `every` over an empty array
    // is `true`, so a scope with no jobs would otherwise report a
    // definitive zero. See `failure-visibility.test.ts`.
    const definitive = jobs.length > 0 && jobs.every((job) => jobsWithRuns.has(job.id));

    const findings: Finding[] = [];
    const setupFailures: SetupFailure[] = [];
    for (const run of runs) {
      findings.push(...run.findings);
      setupFailures.push(...run.setupFailures);
    }

    return Object.freeze({
      tenantId: raw.tenantId,
      scope: {
        ...(raw.jobId !== undefined ? { jobId: raw.jobId } : {}),
        ...(raw.productId !== undefined ? { productId: raw.productId } : {}),
        ...(raw.programId !== undefined ? { programId: raw.programId } : {}),
      },
      jobs,
      runs,
      findings: Object.freeze(findings),
      setupFailures: Object.freeze(setupFailures),
      unexecuted: Object.freeze(unexecuted),
      coverage: {
        jobsConsidered: jobs.length,
        runsExecuted: runs.length,
        jobsPending,
        jobsFailed,
        jobsCancelled,
      },
      definitive,
      costPolicy,
      costPerFinding: undefined,
    });
  }

  /* ---- disposition ------------------------------------------------- */

  /**
   * Record a customer's answer to a finding.
   *
   * The transition is checked **here** as well as in the ledger, so the
   * guarantee holds against a sink that forgets to check. See
   * `feedback.ts`.
   */
  async function submitDisposition(
    principal: ServicePrincipal,
    request: unknown,
  ): Promise<DispositionAccepted> {
    assertCapability(principal, 'disposition:submit');
    const raw = parseSubmitDispositionRequest(request);
    assertTenant(principal, raw.tenantId);

    // The reference must resolve. A disposition about a finding nothing
    // produced is not a judgement, and #64's false-positive rate is
    // computed over what this records.
    const known = store
      .findingsForTenant(raw.tenantId)
      .find((f) => f.id === raw.findingId);
    if (known === undefined) {
      throw new ServiceError(
        `finding ${raw.findingId} has not been observed for ${raw.productId}; a disposition is a ` +
          `reference to a real finding, not a free-standing judgement`,
        'finding-not-found',
        'request.findingId',
        { findingId: raw.findingId, productId: raw.productId },
      );
    }
    if (known.target.productId !== raw.productId) {
      throw new ServiceError(
        `finding ${raw.findingId} belongs to product ${known.target.productId}, not ${raw.productId}`,
        'invalid-request',
        'request.productId',
        { findingId: raw.findingId, declared: raw.productId, actual: known.target.productId },
      );
    }

    const current = await feedback.currentDisposition(raw.findingId);
    const previousState: DispositionState = current?.state ?? INITIAL_DISPOSITION_STATE;

    // #61's `parseDisposition` validates the `kind`/`state` pair against
    // its own table. This layer deliberately does not restate that
    // mapping: a second copy of the rule is a second table that agrees
    // until somebody edits one of them.
    const disposition = attempt(() =>
        parseDisposition(
          {
            id: raw.dispositionId,
            findingId: raw.findingId,
            kind: raw.kind,
            state: raw.state,
            actor: raw.actor,
            decidedAt: raw.decidedAt,
            ...(raw.rationale !== undefined ? { rationale: raw.rationale } : {}),
            ...(raw.supersedes !== undefined ? { supersedes: raw.supersedes } : {}),
            ...(raw.action !== undefined
              ? { action: attempt(() => parseDispositionAction(raw.action), 'request.action') }
              : {}),
          },
          'request.disposition',
        ),
      'request.disposition',
    );

    try {
      assertDispositionTransition(previousState, disposition.state, 'request.disposition.state');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ServiceError(message, 'illegal-disposition-transition', 'request.disposition.state', {
        from: previousState,
        to: disposition.state,
      });
    }

    const existing = store.getDispositionReceipt(raw.tenantId, raw.requestId);
    if (existing !== undefined) {
      if (existing.dispositionId !== raw.dispositionId) {
        throw new ServiceError(
          `requestId ${raw.requestId} was already recorded for disposition ${existing.dispositionId}, ` +
            `not ${raw.dispositionId}`,
          'idempotency-conflict',
          'request.requestId',
          { requestId: raw.requestId },
        );
      }
      const recorded = await feedback.currentDisposition(raw.findingId);
      if (recorded === undefined) {
        throw new ServiceError(
          `requestId ${raw.requestId} has a receipt but the feedback ledger has no disposition for ` +
            `${raw.findingId}; the two disagree and neither can be trusted`,
          'invalid-request',
          'request.requestId',
          { requestId: raw.requestId },
        );
      }
      return { recorded: true, disposition: recorded, duplicate: true, previousState };
    }

    const appended = await feedback.appendDisposition({
      tenantId: raw.tenantId,
      productId: raw.productId,
      disposition,
      requestId: raw.requestId,
    });
    store.putDispositionReceipt({
      tenantId: raw.tenantId,
      requestId: raw.requestId,
      dispositionId: appended.dispositionId,
      productId: raw.productId,
    });
    return {
      recorded: true,
      disposition,
      duplicate: appended.duplicate,
      previousState,
    };
  }

  /* ---- surface ----------------------------------------------------- */

  return {
    registerProduct: (p, r) => registerProduct(p, parseRegisterProductRequest(r)),
    registerEnvironment: (p, r) => registerEnvironment(p, parseRegisterEnvironmentRequest(r)),
    registerProgram: (p, r) => registerProgram(p, parseRegisterProgramRequest(r)),
    getProduct,

    submitTriggerEvaluation: (p, r) => submitTriggerEvaluation(p, parseTriggerEvaluationRequest(r)),
    runJob,
    cancelJob,
    getJob,
    listJobs,

    getFindings,
    submitDisposition,
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A run's plan, plus the declarations it must still agree with.
 *
 * The plan is read from the store, not re-planned: it is the artefact
 * #62 reserved budget against, and re-planning at execution time would
 * run a possibly-different evaluation under an already-spent
 * reservation. The product and program are still required to be
 * registered, because #63 validates the plan against the model before
 * it provisions anything and a job whose declarations have been
 * withdrawn should fail as a registration defect rather than as a
 * runtime surprise.
 */
function requirePlan(store: ServiceStore, job: EvaluationJob): EvaluationPlan {
  const model = store.getModel(job.tenantId, job.productId);
  if (model === undefined) {
    throw new ServiceError(
      `product ${job.productId} is no longer registered for ${job.tenantId}`,
      'product-not-found',
      'job.productId',
    );
  }
  if (findProgram(model, job.programId) === undefined) {
    throw new ServiceError(
      `program ${job.programId} is no longer registered for ${job.productId}`,
      'program-not-found',
      'job.programId',
    );
  }
  const stored = store.planForJob(job.tenantId, job.id);
  if (stored === undefined) {
    throw new ServiceError(
      `job ${job.id} has no stored plan; a job that cannot name its plan is a store defect`,
      'invalid-request',
      'job.planKey',
    );
  }
  return stored;
}

function createJob(input: {
  readonly tenantId: TenantId;
  readonly jobId: JobId;
  readonly productId: ProductId;
  readonly programId: ReviewProgramId;
  readonly planKey: EvaluationPlan['planKey'];
  readonly idempotencyKey: EvaluationPlan['idempotencyKey'];
  readonly submittedAt: string;
}): EvaluationJob {
  return Object.freeze({
    id: input.jobId,
    tenantId: input.tenantId,
    productId: input.productId,
    programId: input.programId,
    planKey: input.planKey,
    idempotencyKey: input.idempotencyKey,
    status: 'queued' as const,
    revision: 1,
    outcome: Object.freeze({ kind: 'notStarted' as const }),
    submittedAt: input.submittedAt,
  });
}

/** #62's ledger for this program, or a fresh one for the current day. */
function ledgerFor(
  store: ServiceStore,
  tenantId: TenantId,
  program: ReviewProgram,
  now: string,
): BudgetLedger {
  const existing = store.getLedger(tenantId, program.id);
  if (existing !== undefined) {
    // The window may have rolled over since it was written; a ledger
    // from yesterday is not today's budget.
    const window = defaultBudgetWindow(now);
    if (existing.window.start !== window.start) {
      return createBudgetLedger(program.id, program.budget, window);
    }
    return existing;
  }
  return createBudgetLedger(program.id, program.budget, defaultBudgetWindow(now));
}

function requireModel(store: ServiceStore, tenantId: TenantId, productId: ProductId): ProductModel {
  const model = store.getModel(tenantId, productId);
  if (model === undefined) {
    throw new ServiceError(
      `product ${productId} is not registered for ${tenantId}`,
      'product-not-found',
      'request.productId',
      { productId, tenantId },
    );
  }
  return model;
}

function requireJob(store: ServiceStore, tenantId: TenantId, jobId: JobId): EvaluationJob {
  const job = store.getJob(tenantId, jobId);
  if (job === undefined) {
    // A named job that was never scheduled. Deliberately distinct from
    // an empty findings list.
    throw new ServiceError(
      `job ${jobId} has never been scheduled for ${tenantId}`,
      'job-not-found',
      'request.jobId',
      { jobId, tenantId },
    );
  }
  return job;
}

function bindPlanKey(
  store: ServiceStore,
  tenantId: TenantId,
  planKey: EvaluationPlan['planKey'],
  jobId: JobId,
): JobId {
  try {
    return store.bindPlanKey(tenantId, planKey, jobId, 'idempotency-conflict');
  } catch (error) {
    if (error instanceof PlanKeyConflict) {
      throw new ServiceError(error.message, error.code, 'request.jobId', {
        planKey,
        existingJobId: error.existingJobId,
        requestedJobId: error.requestedJobId,
      });
    }
    throw error;
  }
}

function mapStoreError(error: unknown, tenantId: TenantId, jobId: JobId): ServiceError {
  if (error instanceof StaleJobRevision) {
    return new ServiceError(
      `job ${jobId} was advanced concurrently to ${error.current.status} revision ${error.current.revision}`,
      'stale-job-revision',
      'job.revision',
      { current: error.current.status, revision: error.current.revision },
    );
  }
  if (error instanceof ServiceStoreMiss) {
    return new ServiceError(
      `job ${jobId} is not stored for ${tenantId}`,
      'job-not-found',
      'request.jobId',
      { jobId, tenantId },
    );
  }
  if (isServiceError(error)) {
    return error;
  }
  return asServiceError(error, `job:${jobId}`);
}

function replaceModel(
  current: ProductModel,
  patch: {
    readonly environments?: ReadonlyArray<Environment>;
    readonly programs?: ReadonlyArray<ReviewProgram>;
  },
): ProductModel {
  return buildProductModel({
    product: current.product,
    environments: patch.environments ?? current.environments,
    identities: current.identities,
    cohorts: current.cohorts,
    programs: patch.programs ?? current.programs,
  });
}

/**
 * A re-registration must be the *same* declaration.
 *
 * Re-registering an unchanged product is idempotent and returns the
 * stored model. Re-registering a *changed* one is refused rather than
 * overwriting, because a caller that believes it updated a program's
 * triggers while the stored model still has the old ones would get a
 * control plane whose behaviour does not match its configuration.
 */
function assertSameRegistration(existing: ProductModel, incoming: ProductModel, tenantId: TenantId): void {
  if (JSON.stringify(existing) === JSON.stringify(incoming)) {
    return;
  }
  throw new ServiceError(
    `product ${incoming.product.id} is already registered for ${tenantId} with a different declaration; ` +
      `re-registration must be identical`,
    'duplicate-registration',
    'request.product',
    { productId: incoming.product.id },
  );
}

/**
 * Why a job in scope has no run record.
 *
 * Only reachable for a job the report found no run for, so the
 * `completed` branch means the store lost a run it had written — a
 * defect, and it is named as one rather than reported as an empty
 * result.
 */
function unexecutedReason(job: EvaluationJob): string {
  switch (job.outcome.kind) {
    case 'notStarted':
      return job.status === 'queued'
        ? 'queued: the job has not started; its findings are not knowable yet'
        : 'running: the job is in flight; its findings are not knowable yet';
    case 'failed':
      return `failed: ${job.outcome.reason}`;
    case 'cancelled':
      return `cancelled: ${job.outcome.reason}`;
    case 'completed':
      return 'completed: the run record is missing from the store, which is a store defect';
  }
}

function describeFailure(error: unknown): string {
  if (isServiceError(error)) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function requireInstant(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ServiceError(`${field} must return an ISO-8601 instant`, 'invalid-request', field);
  }
  return new Date(value).toISOString();
}

function requireProductId(value: string): ProductId {
  return attempt(() => parseProductId(value, 'productId'), 'productId');
}

function toRunRecord(input: {
  readonly tenantId: TenantId;
  readonly jobId: JobId;
  readonly result: Awaited<ReturnType<EvaluationExecutor['execute']>>['result'];
  readonly cost: DeclaredCost;
}): ServiceRunRecord {
  const { result } = input;
  return Object.freeze({
    tenantId: input.tenantId,
    jobId: input.jobId,
    productId: result.target.productId,
    programId: result.target.programId,
    runId: result.runId,
    target: result.target,
    mode: result.mode,
    lineage: result.lineage,
    findings: result.findings,
    setupFailures: result.setupFailures,
    setupRefused: result.setupRefused,
    privilegedEffects: Object.freeze({
      declared: result.setup.status !== 'skipped',
      refused: result.setupRefused,
      auditRecordCount: result.operatorAudit.length,
    }),
    cost: input.cost,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    artifactDir: result.artifactDir,
  });
}

export type { ServiceCapability };
