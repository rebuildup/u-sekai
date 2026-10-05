/**
 * Managed-service control plane (issue #66, ADR-0011).
 *
 * The public surface of `src/service/**`. A client registers its
 * durable evaluation objects, triggers a job, inspects its status,
 * retrieves findings, and records a disposition — all through one
 * tenant-scoped API whose execution is provider-neutral.
 *
 * ## Dependencies, and the one that is deliberately absent
 *
 * ```text
 *   src/service ──> src/product   (#57)  durable declarations
 *               ──> src/program   (#62)  triggers, plans, budgets
 *               ──> src/review    (#61)  findings, dispositions
 *               ──> src/runtime   (#63)  runEvaluation, through the gate
 *               ──> src/feedback  (#64)  NOT IMPORTED — see feedback.ts
 *               ──> src/operator  (#59)  NOT IMPORTED AT ALL
 * ```
 *
 * The two absences are the load-bearing part of the boundary.
 *
 * **No edge into `src/operator/**`.** Not the connector, not the
 * operator, not a step type, not an error type. There is therefore no
 * value in this package a privileged effect could be reached through.
 * A run's world-state effects are reached only by handing a plan to the
 * injected executor, which calls #63's `runEvaluation` — the one call
 * site that gives a plan to #59's gate, which authorises the whole plan
 * before the first dispatch.
 * `test/integration/service/operator-boundary.test.ts` walks the import
 * graph to assert the absence, and observes the gate's denial from
 * outside as `provisionCalls === 0`.
 *
 * **No edge into `src/feedback/**`.** Branches `63` and `64` are
 * siblings — both fork from `c36dc4c`, neither contains the other — so
 * #64 is not on this ticket's base. The seam is declared instead of
 * vendored; see `feedback.ts`. The service still enforces #61's
 * transition table itself, so the guarantee does not depend on which
 * sink is wired.
 *
 * ## What this package decides, and what it delegates
 *
 * It decides tenancy, capability, job lifecycle, idempotency, and the
 * accounting that keeps "did not run" visible. It delegates every
 * domain question: is this declaration valid (#57), is this trigger due
 * and may it be charged (#62), is this disposition legal (#61), what
 * happened during the run (#63/#59).
 *
 * ## Not re-exported from `src/index.ts`
 *
 * The package entrypoint is #65's ticket, and #66 must not compete
 * for it.
 */

export {
  asServiceError,
  isServiceError,
  ServiceError,
  SERVICE_ERROR_CODES,
  type ServiceErrorCode,
} from './errors.js';

export {
  assertCapability,
  isServiceCapability,
  jobId,
  JOB_ID_PATTERN,
  parseJobId,
  parseTenantId,
  principalHasCapability,
  SERVICE_CAPABILITIES,
  TENANT_ID_PATTERN,
  tenantId,
  type JobId,
  type ServiceCapability,
  type ServicePrincipal,
  type TenantId,
} from './identity.js';

export {
  declaredCost,
  MAX_REPORTABLE_DECIMALS,
  parseServiceCostPolicy,
  type DeclaredCost,
  type ServiceCostPolicy,
} from './cost.js';

export {
  assertJobTransition,
  isLegalJobTransition,
  isTerminalJobStatus,
  JOB_STATUSES,
  JOB_TRANSITIONS,
  TERMINAL_JOB_STATUSES,
  type EvaluationJob,
  type JobOutcome,
  type JobStatus,
  type TerminalJobStatus,
} from './job.js';

export type { ServiceRunRecord, DeclaredRunId } from './run-record.js';

export {
  InMemoryServiceStore,
  PlanKeyConflict,
  ServiceStoreMiss,
  StaleJobRevision,
  tenantKey,
  type DispositionReceipt,
  type JobFilter,
  type RunFilter,
  type ServiceStore,
} from './store.js';

export {
  UnavailableFeedbackSink,
  type DispositionAppendResult,
  type DispositionSubmission,
  type FeedbackSink,
} from './feedback.js';

export {
  createRuntimeExecutor,
  type EvaluationExecutor,
  type ExecutionRequest,
  type ExecutionResult,
} from './executor.js';

export {
  parseCancelJobRequest,
  parseGetFindingsRequest,
  parseGetJobRequest,
  parseListJobsRequest,
  parseRegisterEnvironmentRequest,
  parseRegisterProductRequest,
  parseRegisterProgramRequest,
  parseSubmitDispositionRequest,
  parseTriggerEvaluationRequest,
  type CancelJobRequest,
  type GetFindingsRequest,
  type GetJobRequest,
  type ListJobsRequest,
  type RegisterEnvironmentRequest,
  type RegisterProductRequest,
  type RegisterProgramRequest,
  type SubmitDispositionRequest,
  type TriggerEvaluationRequest,
} from './requests.js';

export {
  createService,
  type DispositionAccepted,
  type EvaluationControlPlane,
  type FindingsReport,
  type ServiceConfig,
  type ServicePlanningConfig,
  type TriggerAccepted,
  type TriggerNotDue,
  type TriggerResult,
} from './service.js';
