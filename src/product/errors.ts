/**
 * Domain errors for the durable product model (ADR-0011).
 *
 * The product layer owns its own error type rather than reusing
 * `ExperimentConfigError` from `src/domain/errors.ts`. That keeps the
 * durable model independent of the experiment runtime, which is the
 * first acceptance criterion of #57: a Product must be expressible
 * without an `ExperimentDefinition` existing.
 */

export class ProductDomainError extends Error {
  readonly kind: 'product_domain_error' = 'product_domain_error' as const;
  constructor(
    message: string,
    /** Dotted path of the offending field, e.g. `budget.maxRunsPerDay`. */
    readonly field?: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ProductDomainError';
  }
}
