/**
 * World Operator setup and bounded cleanup (issue #63).
 *
 * ## The runtime holds no privileged capability of its own
 *
 * The `ProvisioningConnector` a caller supplies reaches exactly one
 * place in this package: the `createWorldOperator` call in
 * {@link buildWorldOperator}. From that moment on the connector lives
 * in #59's ECMAScript `#private` field, and the only things this module
 * can do with it are `provision` and `cleanup` — both of which #59
 * authorises in full before dispatching anything.
 *
 * That is why there is no "provision one step" helper here. A
 * per-step entry point would be a second path around the gate, and the
 * whole point of #59 is that there is exactly one.
 *
 * ## A denied plan is a `SetupFailure`, never a finding
 *
 * Every non-`provisioned` outcome is projected through #59's own
 * `projectOperatorFailure` and then turned into a #61 `SetupFailure`.
 * Two details are load-bearing:
 *
 * - A `productRejected` outcome is **still** a `SetupFailure`. The
 *   product refused to be set up, so no participant ran and the run
 *   produced no product observation. Filing the refusal as a `Finding`
 *   would be exactly the false positive #61's split exists to prevent:
 *   the customer's dashboard would show a finding about their product
 *   for a run that never evaluated it. What the product *said* is not
 *   lost — it is cited as a `productResponse` evidence reference on the
 *   failure, so the refusal is inspectable without being counted.
 * - The cause is mapped from #59's `failureKind` **explicitly**, not
 *   inferred from the message text. #61's `inferSetupFailureCause`
 *   exists for records that have no better source, and this is a record
 *   that has one.
 */

import {
  createWorldOperator,
  projectOperatorFailure,
  type OperatorAuditRecord,
  type OperatorClock,
  type OperatorCleanupResult,
  type OperatorFailure,
  type OperatorResult,
  type OperatorSetupFailureKind,
  type OperatorStep,
  type ProvisioningConnector,
  type WorldOperator,
} from '../operator/index.js';
import {
  deriveEvidenceId,
  parseEvidenceRef,
  inferSetupFailureCause,
  parseSetupFailure,
  setupFailureFromRuntimeError,
  setupFailureId,
  type EvidenceRef,
  type SetupFailure,
  type SetupFailureCause,
  type SetupFailureId,
} from '../review/index.js';
import type {
  EvaluationRunId,
  EvaluationTargetRef,
  SyntheticIdentityId,
} from '../product/index.js';
import { RuntimeIntegrationError } from './errors.js';
import { deriveRequestId, runToken } from './lineage.js';
import type { EvaluationPlan } from '../program/index.js';

/**
 * The connector a setup phase ran against.
 *
 * A handle rather than the connector itself: the runtime reports which
 * connector performed the setup (it is on every #59 audit record) and
 * never hands the object back to a caller.
 */
export interface ConnectorIdentity {
  readonly connectorId: string;
}

export interface SetupPhaseInput {
  readonly plan: EvaluationPlan;
  readonly target: EvaluationTargetRef;
  readonly runId: EvaluationRunId;
  readonly identityIds: ReadonlyArray<SyntheticIdentityId>;
  /** Declared provisioning steps. Empty means "no privileged setup". */
  readonly steps: ReadonlyArray<OperatorStep>;
  readonly policy: unknown;
  readonly connector: ProvisioningConnector;
  readonly clock: OperatorClock;
  readonly reason?: string;
}

export interface SetupPhaseResult {
  /** The operator's own verdict, verbatim. `skipped` when no plan was declared. */
  readonly status: 'provisioned' | 'denied' | 'failed' | 'rejected' | 'skipped';
  readonly requestId?: string;
  readonly connector: ConnectorIdentity;
  /** Resource keys the world still holds, in application order. */
  readonly resourceKeys: ReadonlyArray<string>;
  readonly spendUnits: number;
  /** Everything #59 recorded, oldest first. Never summarised away. */
  readonly audit: ReadonlyArray<OperatorAuditRecord>;
  /** The failures the operator classified, in the order it reported them. */
  readonly failures: ReadonlyArray<OperatorFailure>;
}

/**
 * Construct the operator.
 *
 * The connector is passed in and not kept. `WorldOperator` is the
 * narrow interface #59 exports, and its concrete class is not, so there
 * is nothing for a caller to reach through even if it wanted to.
 */
export function buildWorldOperator(input: {
  readonly policy: unknown;
  readonly connector: ProvisioningConnector;
  readonly clock: OperatorClock;
}): WorldOperator {
  try {
    return createWorldOperator({
      policy: input.policy,
      connector: input.connector,
      clock: input.clock,
    });
  } catch (error) {
    // #59 refuses to construct an operator without a valid policy. That
    // is a configuration error the caller must fix, not a run outcome,
    // so it surfaces as a contract violation rather than as a
    // `SetupFailure` nobody can act on.
    throw new RuntimeIntegrationError(
      `the World Operator policy was refused: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'invalidInvocation',
      'authority',
    );
  }
}

/**
 * Run the declared provisioning plan.
 *
 * Resolves for every verdict. #59 already decided that a denial is a
 * return value rather than an exception, and this module does not undo
 * that: converting a denial into a thrown error is how an authority
 * boundary stops being one, because a caller can then swallow it as an
 * ordinary fault and carry on with an un-set-up world.
 */
export async function runSetupPhase(
  operator: WorldOperator,
  input: SetupPhaseInput,
): Promise<SetupPhaseResult> {
  if (input.steps.length === 0) {
    return Object.freeze({
      status: 'skipped' as const,
      connector: Object.freeze({ connectorId: 'none' }),
      resourceKeys: Object.freeze([]),
      spendUnits: 0,
      audit: operator.audit(),
      failures: Object.freeze([]),
    });
  }

  const requestId = deriveRequestId(input.plan);
  const result: OperatorResult = await operator.provision({
    requestId,
    lineage: { ...input.target, runId: input.runId },
    steps: input.steps,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });

  return Object.freeze({
    status: result.status,
    requestId,
    connector: Object.freeze({ connectorId: auditConnectorId(operator) }),
    resourceKeys: result.status === 'provisioned' ? result.resourceKeys : Object.freeze([]),
    spendUnits: result.status === 'provisioned' || result.status === 'failed' ? result.spendUnits : 0,
    audit: operator.audit(),
    failures: result.status === 'denied' || result.status === 'failed' ? [result.failure] : [],
  });
}

/** Release what the run set up, through the same gate. */
export async function runCleanupPhase(
  operator: WorldOperator,
  input: {
    readonly plan: EvaluationPlan;
    readonly target: EvaluationTargetRef;
    readonly runId: EvaluationRunId;
  },
): Promise<OperatorCleanupResult> {
  return operator.cleanup({
    requestId: deriveRequestId(input.plan),
    lineage: { ...input.target, runId: input.runId },
  });
}

/**
 * #59 records the connector identity on every audit record; the runtime
 * reads it from there rather than holding the connector.
 *
 * Read *after* the plan has been submitted. #59 appends its record as
 * part of deciding the outcome, so a read taken beforehand sees an
 * empty log and reports the connector as unknown — which is a
 * misreport, not an absence: the connector demonstrably acted.
 */
function auditConnectorId(operator: WorldOperator): string {
  const last = operator.audit().at(-1);
  return last?.connectorId ?? 'unknown';
}

/**
 * #59's `failureKind` onto #61's `SetupFailureCause`.
 *
 * The mapping is exhaustive and total by construction — every member of
 * `OPERATOR_SETUP_FAILURE_KINDS` appears — so adding a kind to #59
 * without deciding what it means for a review record becomes a
 * compile-time error here rather than a silently `unknown` cause in a
 * customer-facing record.
 */
const SETUP_CAUSE_BY_OPERATOR_FAILURE: Readonly<
  Record<OperatorSetupFailureKind, SetupFailureCause>
> = Object.freeze({
  // The environment or the step is outside declared authority: the
  // World Operator boundary refused to consider the plan at all.
  authorityDenied: 'worldOperatorDenied',
  // The step kind is granted, but the policy's risk ceiling is below
  // its fixed risk class. Still the World Operator refusing, and
  // reported as such: whoever has to fix it has to change the World
  // Operator's policy, not a runtime flag.
  riskNotPermitted: 'worldOperatorDenied',
  // The declared quantitative budget cannot cover the plan.
  budgetExhausted: 'budgetExhausted',
  // A malformed plan is a caller mistake, refused before dispatch.
  // `policyDenied` is the honest #61 cause: the request was not
  // permitted to proceed, and nothing about the product was observed.
  invalidRequest: 'policyDenied',
  // The connector could not create the world state. This is the
  // `could not seed` / `missing fixture` family.
  connectorFailed: 'worldStateUnavailable',
  // Compensation left state behind. A leak is never reported as an
  // ordinary setup failure, and it is never collapsed into the failure
  // that caused it — #59 already keeps those two records separate, and
  // the orphaned keys survive on the audit record the runtime returns.
  rollbackFailed: 'worldStateUnavailable',
});

/**
 * Turn an operator failure into a #61 `SetupFailure`.
 *
 * The `evidenceRefs` carry the projected failure as an
 * `environmentProbe` — a setup failure is an observation about the
 * evaluation, which is exactly what #59's `runtimeError` channel
 * projects. When the product itself refused (`productRejected`), a
 * second reference is added on the `productResponse` channel so the
 * refusal is inspectable, and #61's two channels are then free to
 * disagree about it downstream without the runtime having resolved
 * them into anything.
 */
export function setupFailureFromOperator(
  failure: OperatorFailure,
  input: {
    readonly runId: EvaluationRunId;
    readonly target: EvaluationTargetRef;
    readonly identityIds: ReadonlyArray<SyntheticIdentityId>;
    readonly ordinal: number;
    /** Short discriminator, so setup and cleanup failures never collide. */
    readonly kind?: 'op' | 'cleanup';
  },
): SetupFailure {
  const projection = projectOperatorFailure(failure);
  // Bounded and validated, not spelled from the run id: see `runToken`.
  // `setupFailureId` is the authority, so an id #61 would refuse is
  // caught here rather than reaching a consumer as a cast.
  const id: SetupFailureId = setupFailureId(
    `sf-${runToken(input.runId)}-${input.kind ?? 'op'}-${input.ordinal}`,
  );

  if (projection.channel === 'runtimeError') {
    return setupFailureFromRuntimeError(
      { ts: projection.ts, where: projection.where, message: projection.message },
      {
        id,
        cause: SETUP_CAUSE_BY_OPERATOR_FAILURE[projection.setupFailure.failureKind],
        target: input.target,
        runId: input.runId,
        identityIds: input.identityIds,
        index: input.ordinal,
      },
    );
  }

  // A product refusal. The cause is still a setup failure, because the
  // world could not be established and so no product observation was
  // made; the product's own code rides along as evidence rather than as
  // a claim. #59's `productSignal` projection carries no `message` of
  // its own — the message belongs to the `OperatorProductFailure`
  // behind it — so the runtime reads it from there rather than
  // widening the projection.
  const refusal = projection.productFailure;
  const base = setupFailureFromRuntimeError(
    { ts: projection.ts, where: projection.where, message: refusal.message },
    {
      id,
      cause: 'worldStateUnavailable',
      target: input.target,
      runId: input.runId,
      identityIds: input.identityIds,
      index: input.ordinal,
    },
  );

  const productRef: EvidenceRef = parseEvidenceRef({
    id: deriveEvidenceId(`${input.runId}|productResponse|${refusal.productCode}`),
    channel: 'productResponse',
    stance: 'supports',
    locator: `operator-audit.json#${projection.where}`,
    observedAt: projection.ts,
    summary:
      `product refused world setup with code "${refusal.productCode}": ` +
      `${refusal.message}`.slice(0, 500),
  });

  return parseSetupFailure({
    ...base,
    evidenceRefs: [...base.evidenceRefs, productRef],
  });
}

/**
 * Why a runtime-error record is a setup failure rather than a product
 * observation.
 *
 * `where` carries `axis=` for a runtime-enforced `capability.violation`
 * and `participant=` for a participant's own failure diagnostic. The
 * first is the capability boundary refusing the participant, which the
 * runtime can say exactly. The second is narrowed once more when the
 * message names a failing adapter call, and otherwise handed to #61's
 * own `inferSetupFailureCause` rather than to a second keyword list
 * here.
 *
 * Delegating matters: #61's inference is ordered most-specific-first
 * precisely so that a message naming the World Operator is not filed as
 * a plain `policyDenied`. A local list would drift from it the first
 * time #61 adds a keyword.
 */
export function setupFailureCauseForRuntimeError(
  record: { where: string; message: string },
): SetupFailureCause {
  if (/\baxis=/.test(record.where)) {
    // The participant reached for a primitive its capability profile
    // forbids. The boundary refusing is a policy outcome, not a product
    // defect, and filing it as one would tell the customer their
    // product has a problem when the product was never at fault.
    return 'policyDenied';
  }
  // `adapter.open failed: ...` is the adapter reporting that it could
  // not reach the target at all. #61 has a cause for exactly this and
  // it is more precise than the keyword fallback: Node's `fetch`
  // reports only "fetch failed" and keeps `ECONNREFUSED` in
  // `error.cause`, so a keyword scan of the message would file a dead
  // environment as `unknown` — the one answer that tells whoever has to
  // fix it nothing at all.
  if (/\badapter\.[a-z]+ failed\b/i.test(record.message)) return 'adapterError';
  return inferSetupFailureCause(record.message);
}
