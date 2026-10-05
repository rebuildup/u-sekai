/**
 * The execution seam — the only way a control plane reaches a run
 * (issue #66).
 *
 * ## One call site, and it is not this package's
 *
 * The control plane does not know how a run happens. It hands a plan to
 * an {@link EvaluationExecutor} and receives a result. The only
 * implementation shipped here, {@link createRuntimeExecutor}, calls
 * #63's `runEvaluation` — and `runEvaluation` is what constructs the
 * World Operator, hands the plan to #59's gate, and lets the gate
 * decide what dispatches.
 *
 * That is the whole boundary argument, and it is worth being precise
 * about because "the control plane respects the operator gate" is
 * usually only a convention:
 *
 * - **`src/service/**` contains no import of `src/operator/**` at
 *   all** — not the connector, not the operator, not a step type, not
 *   an error type. So there is no value in this package that a
 *   privileged effect could be reached through.
 * - The only member of the executor port is
 *   `execute(ExecutionRequest)`, and its request carries a `plan`, a
 *   `model` and a clock — no connector, no policy, no step list.
 * - A `ProvisioningConnector` is reachable from exactly one call site in
 *   the repository (#63's `createWorldOperator`), and this package is
 *   not it.
 *
 * `test/integration/service/operator-boundary.test.ts` asserts the
 * first bullet by walking the import graph, and the second and third
 * behaviourally: a run whose plan asks for a step the policy does not
 * grant must produce a `SetupFailure` and **zero** connector
 * dispatches, observed from the control plane.
 *
 * ## Provider selection is not reachable from here either
 *
 * The executor port's request has no model, provider or credential
 * field. #63 owns reasoner construction and reads its `ReasonerConfig`
 * from the injected {@link RuntimeConfiguration}, which the composition
 * root supplies. A control-plane request therefore cannot reach a
 * vendor, which is the same property the customer-facing API needs and
 * for the same ADR-0011 reason.
 */

import type { ProductModel } from '../product/index.js';
import type { EvaluationPlan } from '../program/index.js';
import {
  runEvaluation,
  type EvaluationRunResult,
  type RuntimeConfiguration,
} from '../runtime/index.js';
import type { TenantId } from './identity.js';
import type { JobId } from './identity.js';

export interface ExecutionRequest {
  readonly tenantId: TenantId;
  readonly jobId: JobId;
  /** The plan #62 emitted. Carries the authority envelope; not a script. */
  readonly plan: EvaluationPlan;
  /** The durable model this tenant registered. */
  readonly model: ProductModel;
}

export interface ExecutionResult {
  readonly result: EvaluationRunResult;
}

export interface EvaluationExecutor {
  /**
   * Execute one plan.
   *
   * May return a result whose `setupFailures` is non-empty — a run
   * failure is a *result*, not a throw, per #63's own boundary. What
   * this must never do is swallow a defect: an exception here becomes a
   * `failed` job with the reason recorded, never a `succeeded` job with
   * an empty finding list.
   */
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}

/**
 * The production executor: #63's runtime, unchanged.
 *
 * `base` supplies everything the runtime needs *except* the model, which
 * comes from the request, because the model is per-tenant registry
 * state and the rest of the configuration is process-level wiring the
 * composition root owns.
 *
 * No default and no ambient clock: `RuntimeConfiguration.now` is the
 * runtime's clock, and a service that read the wall clock directly
 * would stamp a run with an instant no test could pin.
 */
export function createRuntimeExecutor(base: RuntimeConfiguration): EvaluationExecutor {
  return {
    async execute(request: ExecutionRequest): Promise<ExecutionResult> {
      const config: RuntimeConfiguration = { ...base, model: request.model };
      const result = await runEvaluation(config, {
        plan: request.plan,
        runId: request.jobId,
      });
      return { result };
    },
  };
}
