/**
 * Contract errors for the product-review layer (issue #61).
 *
 * The review layer owns its own error type rather than throwing
 * `ProductDomainError` from `src/product/**`. Two reasons:
 *
 * 1. `src/product/**` is #57's mutable surface. Raising its error type
 *    would make every #61 review-contract violation indistinguishable
 *    from a durable-domain violation, so a caller could not tell which
 *    layer rejected a value.
 * 2. The review contract is a *contract* violation, not a
 *    malformed-durable-value violation. A finding with no evidence, or
 *    an illegal disposition transition, is not something a customer
 *    configuration could have produced; it is something a producer did
 *    wrong. The distinct name makes that visible in a log line.
 *
 * The `field` / `detail` shape deliberately mirrors `ProductDomainError`
 * so a caller that already renders that shape can render this one
 * without special-casing.
 */

export class ReviewContractError extends Error {
  readonly kind = 'review_contract_error' as const;
  constructor(
    message: string,
    /** Dotted path of the offending field, e.g. `evidenceRefs[0].channel`. */
    readonly field?: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ReviewContractError';
  }
}

export function isReviewContractError(value: unknown): value is ReviewContractError {
  return value instanceof ReviewContractError;
}

/**
 * Re-raise a failure from another layer as a `ReviewContractError`.
 *
 * The review contract validates handles that #57 owns the grammar for
 * (`EvidenceId`, `RunLineage`, `ProductId`, ...), and those parsers
 * throw `ProductDomainError`. Callers of `parseFinding` should not have
 * to know which layer rejected the value in order to handle the
 * rejection, so every cross-layer parse in `src/review/**` is wrapped
 * in this helper and the whole contract has a single error surface.
 *
 * A `ReviewContractError` raised inside the callback is re-thrown
 * unchanged, so a local check is never relabelled.
 */
export function asReviewContractError<T>(field: string, parse: () => T): T {
  try {
    return parse();
  } catch (cause) {
    if (cause instanceof ReviewContractError) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ReviewContractError(
      `${field} was rejected by the durable product model: ${message}`,
      field,
      { causeType: cause instanceof Error ? cause.name : typeof cause },
    );
  }
}
