/**
 * Runtime integration errors (issue #63).
 *
 * ## What this layer refuses, and what it merely reports
 *
 * The runtime is the seam where the durable model (#57), the cohort
 * store (#60), the World Operator boundary (#59), the review contract
 * (#61) and the plan envelope (#62) meet the existing experiment /
 * browser runtime. Two very different things can go wrong there and
 * they must not be conflated:
 *
 * - **A contract violation.** The plan names a Product the model does
 *   not declare, the caller supplies a run id #57 will not accept, a
 *   baseline that is not a release-transition comparison. These are
 *   programming errors: they cannot be observed, reported to a customer
 *   or recovered from at runtime, and they are raised as
 *   `RuntimeIntegrationError` so a caller has one type to catch.
 * - **A run that could not be completed.** The environment was
 *   unreachable, the World Operator denied a plan, the browser died.
 *   These are *observations*, not exceptions: they are returned as
 *   `SetupFailure` records through #61's `ReviewOutcome` seam, exactly
 *   as #61 requires, and `runEvaluation` resolves rather than rejects.
 *
 * The line between them is the whole point of this file. A runtime that
 * threw on an unreachable environment would force every caller into a
 * try/catch and would make "the product was broken" and "we could not
 * look" the same exception type — precisely the confusion #61's
 * `Finding` / `SetupFailure` split exists to remove.
 */

export type RuntimeErrorCode =
  /** The plan does not describe a Product/Environment/Cohort/Program the model declares. */
  | 'planNotInModel'
  /** A caller-supplied value failed a #57 / #61 / #62 parser. */
  | 'invalidInvocation'
  /** A declared baseline is not a joinable release-transition comparison. */
  | 'unjoinableBaseline'
  /** The plan's environment declares no endpoint to drive a browser at. */
  | 'noEnvironmentEndpoint'
  /** The plan names no version, and none can be resolved for the observation. */
  | 'noObservedVersion'
  /** The cohort resolved to no eligible member. */
  | 'emptyCohort'
  /** A durable store rejected a read-modify-write. */
  | 'cohortState';

export class RuntimeIntegrationError extends Error {
  readonly kind: 'runtime_integration_error' = 'runtime_integration_error' as const;

  constructor(
    message: string,
    readonly code: RuntimeErrorCode,
    readonly field: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'RuntimeIntegrationError';
  }
}

export function isRuntimeIntegrationError(value: unknown): value is RuntimeIntegrationError {
  return value instanceof RuntimeIntegrationError;
}
