/**
 * Request parsing for the control plane (issue #66).
 *
 * ## Every public method takes `unknown`
 *
 * That is the point of this file. A service boundary receives
 * untrusted input — from HTTP, from a queue consumer, from another
 * process — and the acceptance criterion "the customer-facing API never
 * exposes model provider selection as a required input" is only
 * structurally true if a *request* carrying `model` is an error rather
 * than an ignored key.
 *
 * So every `parse*Request` here enumerates the keys it accepts and
 * raises `unknown-field` for anything else, and every public service
 * method takes `unknown` and parses. A typed signature
 * (`request: TriggerEvaluationRequest`) would move the guarantee to
 * compile time — where an HTTP adapter deserialising a body is not
 * type-checked — which is precisely where it would not hold.
 *
 * `test/integration/service/api-contract.test.ts` fires a body
 * containing `model`, `provider` and `apiKey` at every endpoint and
 * requires each to be refused.
 *
 * ## Requests are thin
 *
 * A request carries identity, the durable ids it acts on, and the
 * trigger signal. It does **not** carry a planning ceiling, a cost
 * rate table, an operator authority list or a mutable-action cap: those
 * are service configuration, supplied once to `createService`, because
 * they are the operator's policy and letting a request restate them
 * would let a caller spend budget it was not granted.
 */

import {
  parseEnvironment,
  parseProduct,
  parseProductId,
  parseReviewProgram,
  parseReviewProgramId,
  parseSyntheticCohort,
  parseSyntheticIdentity,
  type Environment,
  type Product,
  type ProductId,
  type ReviewProgram,
  type ReviewProgramId,
  type SyntheticCohort,
  type SyntheticIdentity,
} from '../product/index.js';
import { parseTriggerSignal, type TriggerSignal } from '../program/index.js';
import {
  DISPOSITION_KINDS,
  parseDispositionActor,
  parseFindingId,
  type DispositionActor,
  type DispositionKind,
  type DispositionState,
  type FindingId,
} from '../review/index.js';
import { attempt, ServiceError } from './errors.js';
import { parseJobId, parseTenantId, type JobId, type TenantId } from './identity.js';
import { JOB_STATUSES, type JobStatus } from './job.js';

/* -------------------------------------------------------------------------- */
/* Field helpers                                                                  */
/* -------------------------------------------------------------------------- */

function requireObject(input: unknown, field: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ServiceError(`${field} must be an object`, 'invalid-request', field);
  }
  return input as Record<string, unknown>;
}

/**
 * Reject any key the request shape does not declare.
 *
 * The same rule #57 applies to domain values, for the same reason: a
 * silently discarded key leaves the sender believing a constraint was
 * applied. `apiKey` is named explicitly in the error because a client
 * that put one there needs to be told it will never be read, rather
 * than left believing a credential was in play.
 */
function rejectUnknown(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const unknown = Object.keys(raw)
    .filter((key) => !allowed.includes(key))
    .sort();
  if (unknown.length > 0) {
    const credentialish = unknown.filter((k) => /key|token|secret|password|credential/i.test(k));
    const suffix = credentialish.length > 0 ? ' (a credential is never read here)' : '';
    throw new ServiceError(
      `${field} has unknown field(s): ${unknown.join(', ')}${suffix}`,
      'unknown-field',
      field,
      { unknown, allowed: [...allowed] },
    );
  }
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ServiceError(`${field} must be an array`, 'invalid-request', field);
  }
  return value;
}

/**
 * An optional raw field, passed through for its caller to parse.
 *
 * The cast is safe because every use below hands the value straight to
 * a `parse*` that takes `unknown`; the field name is carried for the
 * caller's own error message.
 */
function optional(value: unknown): unknown {
  return value;
}

function requireIsoInstant(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '' || Number.isNaN(Date.parse(value))) {
    throw new ServiceError(`${field} must be an ISO-8601 instant`, 'invalid-request', field);
  }
  return new Date(value).toISOString();
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                  */
/* -------------------------------------------------------------------------- */

const REGISTER_PRODUCT_FIELDS = [
  'tenantId',
  'product',
  'environments',
  'identities',
  'cohorts',
  'programs',
] as const;

export interface RegisterProductRequest {
  readonly tenantId: TenantId;
  readonly product: Product;
  readonly environments: ReadonlyArray<Environment>;
  readonly identities: ReadonlyArray<SyntheticIdentity>;
  readonly cohorts: ReadonlyArray<SyntheticCohort>;
  readonly programs: ReadonlyArray<ReviewProgram>;
}

/**
 * Parse a full product registration.
 *
 * The durable entities are parsed by #57's own parsers, so a
 * registration can never describe a value the domain would reject. The
 * cross-entity invariants (`buildProductModel`) run in `service.ts`,
 * after the model is composed, because a program that names an
 * undeclared environment is a registration error rather than a parse
 * error.
 */
export function parseRegisterProductRequest(
  input: unknown,
  field = 'request',
): RegisterProductRequest {
  const raw = requireObject(input, field);
  rejectUnknown(raw, REGISTER_PRODUCT_FIELDS, field);
  return {
    tenantId: parseTenantId(raw['tenantId'], `${field}.tenantId`),
    product: attempt(() => parseProduct(raw['product'], `${field}.product`), `${field}.product`),
    environments: requireArray(raw['environments'], `${field}.environments`).map((v, i) =>
      attempt(() => parseEnvironment(v, `${field}.environments[${i}]`), `${field}.environments[${i}]`),
    ),
    identities: requireArray(raw['identities'], `${field}.identities`).map((v, i) =>
      attempt(() => parseSyntheticIdentity(v, `${field}.identities[${i}]`),
        `${field}.identities[${i}]`,
      ),
    ),
    cohorts: requireArray(raw['cohorts'], `${field}.cohorts`).map((v, i) =>
      attempt(() => parseSyntheticCohort(v, `${field}.cohorts[${i}]`), `${field}.cohorts[${i}]`),
    ),
    programs: requireArray(raw['programs'], `${field}.programs`).map((v, i) =>
      attempt(() => parseReviewProgram(v, `${field}.programs[${i}]`), `${field}.programs[${i}]`),
    ),
  };
}

const REGISTER_ENVIRONMENT_FIELDS = ['tenantId', 'productId', 'environment'] as const;

export interface RegisterEnvironmentRequest {
  readonly tenantId: TenantId;
  readonly productId: ProductId;
  readonly environment: Environment;
}

export function parseRegisterEnvironmentRequest(
  input: unknown,
  field = 'request',
): RegisterEnvironmentRequest {
  const raw = requireObject(input, field);
  rejectUnknown(raw, REGISTER_ENVIRONMENT_FIELDS, field);
  return {
    tenantId: parseTenantId(raw['tenantId'], `${field}.tenantId`),
    productId: attempt(() => parseProductId(raw['productId'], `${field}.productId`), `${field}.productId`),
    environment: attempt(() => parseEnvironment(raw['environment'], `${field}.environment`),
      `${field}.environment`,
    ),
  };
}

const REGISTER_PROGRAM_FIELDS = ['tenantId', 'productId', 'program'] as const;

export interface RegisterProgramRequest {
  readonly tenantId: TenantId;
  readonly productId: ProductId;
  readonly program: ReviewProgram;
}

export function parseRegisterProgramRequest(input: unknown, field = 'request'): RegisterProgramRequest {
  const raw = requireObject(input, field);
  rejectUnknown(raw, REGISTER_PROGRAM_FIELDS, field);
  return {
    tenantId: parseTenantId(raw['tenantId'], `${field}.tenantId`),
    productId: attempt(() => parseProductId(raw['productId'], `${field}.productId`), `${field}.productId`),
    program: attempt(() => parseReviewProgram(raw['program'], `${field}.program`),
      `${field}.program`,
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Triggering                                                                    */
/* -------------------------------------------------------------------------- */

const TRIGGER_FIELDS = ['tenantId', 'jobId', 'productId', 'programId', 'signal'] as const;

export interface TriggerEvaluationRequest {
  readonly tenantId: TenantId;
  /**
   * Caller-declared job id.
   *
   * Declared, not generated, for #57's reason: nothing in this package
   * can mint a job identity, so a reloaded job comes back as the same
   * job. It is also what makes a resubmission visibly the *same*
   * submission rather than a second one.
   */
  readonly jobId: JobId;
  readonly productId: ProductId;
  readonly programId: ReviewProgramId;
  /** The delivered trigger. Parsed by #62. */
  readonly signal: TriggerSignal;
}

export function parseTriggerEvaluationRequest(
  input: unknown,
  field = 'request',
): TriggerEvaluationRequest {
  const raw = requireObject(input, field);
  rejectUnknown(raw, TRIGGER_FIELDS, field);
  return {
    tenantId: parseTenantId(raw['tenantId'], `${field}.tenantId`),
    jobId: parseJobId(raw['jobId'], `${field}.jobId`),
    productId: attempt(() => parseProductId(raw['productId'], `${field}.productId`), `${field}.productId`),
    programId: attempt(() => parseReviewProgramId(raw['programId'], `${field}.programId`),
      `${field}.programId`,
    ),
    signal: attempt(() => parseTriggerSignal(raw['signal'], `${field}.signal`), `${field}.signal`),
  };
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                       */
/* -------------------------------------------------------------------------- */

const GET_JOB_FIELDS = ['tenantId', 'jobId'] as const;

export interface GetJobRequest {
  readonly tenantId: TenantId;
  readonly jobId: JobId;
}

export function parseGetJobRequest(input: unknown, field = 'request'): GetJobRequest {
  const raw = requireObject(input, field);
  rejectUnknown(raw, GET_JOB_FIELDS, field);
  return {
    tenantId: parseTenantId(raw['tenantId'], `${field}.tenantId`),
    jobId: parseJobId(raw['jobId'], `${field}.jobId`),
  };
}

const LIST_JOBS_FIELDS = ['tenantId', 'productId', 'programId', 'status'] as const;

export interface ListJobsRequest {
  readonly tenantId: TenantId;
  readonly productId?: ProductId;
  readonly programId?: ReviewProgramId;
  readonly status?: JobStatus;
}

export function parseListJobsRequest(input: unknown, field = 'request'): ListJobsRequest {
  const raw = requireObject(input, field);
  rejectUnknown(raw, LIST_JOBS_FIELDS, field);
  const status = optional(raw['status']);
  if (status !== undefined && (typeof status !== 'string' || !(JOB_STATUSES as ReadonlyArray<string>).includes(status))) {
    throw new ServiceError(
      `${field}.status must be one of: ${JOB_STATUSES.join(', ')}`,
      'invalid-request',
      `${field}.status`,
    );
  }
  const result: {
    tenantId: TenantId;
    productId?: ProductId;
    programId?: ReviewProgramId;
    status?: JobStatus;
  } = { tenantId: parseTenantId(raw['tenantId'], `${field}.tenantId`) };
  const productId = optional(raw['productId']);
  if (productId !== undefined) {
    result.productId = attempt(() => parseProductId(productId, `${field}.productId`),
      `${field}.productId`,
    );
  }
  const programId = optional(raw['programId']);
  if (programId !== undefined) {
    result.programId = attempt(() => parseReviewProgramId(programId, `${field}.programId`),
      `${field}.programId`,
    );
  }
  if (status !== undefined) {
    result.status = status as JobStatus;
  }
  return result;
}

const CANCEL_JOB_FIELDS = ['tenantId', 'jobId', 'reason'] as const;

export interface CancelJobRequest {
  readonly tenantId: TenantId;
  readonly jobId: JobId;
  readonly reason: string;
}

export function parseCancelJobRequest(input: unknown, field = 'request'): CancelJobRequest {
  const raw = requireObject(input, field);
  rejectUnknown(raw, CANCEL_JOB_FIELDS, field);
  const reason = raw['reason'];
  if (typeof reason !== 'string' || reason.trim() === '' || reason.length > 500) {
    throw new ServiceError(
      `${field}.reason must be a non-empty string of at most 500 characters`,
      'invalid-request',
      `${field}.reason`,
    );
  }
  return {
    tenantId: parseTenantId(raw['tenantId'], `${field}.tenantId`),
    jobId: parseJobId(raw['jobId'], `${field}.jobId`),
    reason,
  };
}

/* -------------------------------------------------------------------------- */
/* Findings                                                                      */
/* -------------------------------------------------------------------------- */

const GET_FINDINGS_FIELDS = ['tenantId', 'jobId', 'productId', 'programId'] as const;

export interface GetFindingsRequest {
  readonly tenantId: TenantId;
  /** Exactly one scope. A job id names one job; product+program names a window. */
  readonly jobId?: JobId;
  readonly productId?: ProductId;
  readonly programId?: ReviewProgramId;
}

export function parseGetFindingsRequest(input: unknown, field = 'request'): GetFindingsRequest {
  const raw = requireObject(input, field);
  rejectUnknown(raw, GET_FINDINGS_FIELDS, field);
  const result: {
    tenantId: TenantId;
    jobId?: JobId;
    productId?: ProductId;
    programId?: ReviewProgramId;
  } = { tenantId: parseTenantId(raw['tenantId'], `${field}.tenantId`) };
  const jobId = optional(raw['jobId']);
  const productId = optional(raw['productId']);
  const programId = optional(raw['programId']);
  if (jobId !== undefined) {
    result.jobId = parseJobId(jobId, `${field}.jobId`);
  }
  if (productId !== undefined) {
    result.productId = attempt(() => parseProductId(productId, `${field}.productId`),
      `${field}.productId`,
    );
  }
  if (programId !== undefined) {
    result.programId = attempt(() => parseReviewProgramId(programId, `${field}.programId`),
      `${field}.programId`,
    );
  }
  // Exactly one scope, and `productId` only narrows a program scope.
  // Naming a job *and* a program is contradictory, and naming a
  // product alongside a job would be silently ignored — a caller who
  // wrote both would get one answer and believe it was the other.
  const namedJob = result.jobId !== undefined;
  const namedProgram = result.programId !== undefined;
  if (!namedJob && !namedProgram) {
    throw new ServiceError(
      `${field} must scope the query with jobId, or with programId`,
      'invalid-request',
      field,
    );
  }
  if (namedJob && namedProgram) {
    throw new ServiceError(
      `${field} must name either a job or a program, not both`,
      'invalid-request',
      field,
    );
  }
  if (namedJob && result.productId !== undefined) {
    throw new ServiceError(
      `${field}.productId narrows a program scope and cannot be combined with jobId`,
      'invalid-request',
      `${field}.productId`,
    );
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Disposition                                                                   */
/* -------------------------------------------------------------------------- */

const SUBMIT_DISPOSITION_FIELDS = [
  'tenantId',
  'requestId',
  'productId',
  'findingId',
  'dispositionId',
  'kind',
  'state',
  'actor',
  'decidedAt',
  'rationale',
  'action',
  'supersedes',
] as const;

/**
 * States a caller may declare.
 *
 * `unreviewed` is absent because it means "no disposition exists", and
 * a submission is by definition past review. The *pair* of `kind` and
 * `state` is validated by #61's `parseDisposition`, which owns the
 * table — this layer does not restate it, and there is no
 * kind-to-state mapping anywhere in `src/service/**` for exactly that
 * reason.
 */
const MATERIALISED_DISPOSITION_STATES = ['needsHumanResearch', 'decided', 'closed'] as const;

export interface SubmitDispositionRequest {
  readonly tenantId: TenantId;
  /** Client-declared, stable across a retry of the same submission. */
  readonly requestId: string;
  readonly productId: ProductId;
  readonly findingId: FindingId;
  /** Caller-declared disposition id. #57 declares, never mints. */
  readonly dispositionId: string;
  readonly kind: DispositionKind;
  /** The lifecycle position the caller is recording. #61 checks the pair. */
  readonly state: Exclude<DispositionState, 'unreviewed'>;
  readonly actor: DispositionActor;
  readonly decidedAt: string;
  readonly rationale?: string;
  readonly action?: unknown;
  readonly supersedes?: string;
}

export function parseSubmitDispositionRequest(
  input: unknown,
  field = 'request',
): SubmitDispositionRequest {
  const raw = requireObject(input, field);
  rejectUnknown(raw, SUBMIT_DISPOSITION_FIELDS, field);
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !(DISPOSITION_KINDS as ReadonlyArray<string>).includes(kind)) {
    throw new ServiceError(
      `${field}.kind must be one of: ${DISPOSITION_KINDS.join(', ')}`,
      'invalid-request',
      `${field}.kind`,
    );
  }
  const state = raw['state'];
  if (
    typeof state !== 'string' ||
    !(MATERIALISED_DISPOSITION_STATES as ReadonlyArray<string>).includes(state)
  ) {
    throw new ServiceError(
      `${field}.state must be one of: ${MATERIALISED_DISPOSITION_STATES.join(', ')}`,
      'invalid-request',
      `${field}.state`,
    );
  }
  const requestId = raw['requestId'];
  if (typeof requestId !== 'string' || requestId.trim() === '' || requestId.length > 128) {
    throw new ServiceError(
      `${field}.requestId must be a non-empty string of at most 128 characters`,
      'invalid-request',
      `${field}.requestId`,
    );
  }
  const dispositionId = raw['dispositionId'];
  if (typeof dispositionId !== 'string' || dispositionId.trim() === '' || dispositionId.length > 64) {
    throw new ServiceError(
      `${field}.dispositionId must be a non-empty string of at most 64 characters`,
      'invalid-request',
      `${field}.dispositionId`,
    );
  }
  const result: {
    tenantId: TenantId;
    requestId: string;
    productId: ProductId;
    findingId: FindingId;
    dispositionId: string;
    kind: DispositionKind;
    state: Exclude<DispositionState, 'unreviewed'>;
    actor: DispositionActor;
    decidedAt: string;
    rationale?: string;
    action?: unknown;
    supersedes?: string;
  } = {
    tenantId: parseTenantId(raw['tenantId'], `${field}.tenantId`),
    requestId,
    productId: attempt(() => parseProductId(raw['productId'], `${field}.productId`),
      `${field}.productId`,
    ),
    findingId: attempt(() => parseFindingId(raw['findingId'], `${field}.findingId`),
      `${field}.findingId`,
    ),
    dispositionId,
    kind: kind as DispositionKind,
    state: state as Exclude<DispositionState, 'unreviewed'>,
    actor: attempt(() => parseDispositionActor(raw['actor'], `${field}.actor`),
      `${field}.actor`,
    ),
    decidedAt: requireIsoInstant(raw['decidedAt'], `${field}.decidedAt`),
  };
  const rationale = raw['rationale'];
  if (rationale !== undefined) {
    if (typeof rationale !== 'string' || rationale.length > 2_000) {
      throw new ServiceError(
        `${field}.rationale must be a string of at most 2000 characters`,
        'invalid-request',
        `${field}.rationale`,
      );
    }
    result.rationale = rationale;
  }
  if (raw['supersedes'] !== undefined) {
    const supersedes = raw['supersedes'];
    if (typeof supersedes !== 'string' || supersedes.trim() === '') {
      throw new ServiceError(
        `${field}.supersedes must be a disposition id`,
        'invalid-request',
        `${field}.supersedes`,
      );
    }
    result.supersedes = supersedes;
  }
  if (raw['action'] !== undefined) {
    result.action = raw['action'];
  }
  return result;
}
