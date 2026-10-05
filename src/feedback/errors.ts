/**
 * Ledger errors for the feedback loop (issue #64).
 *
 * ## Why this layer owns its own error type
 *
 * `src/review/**` (#61) deliberately keeps `ReviewContractError` separate
 * from #57's `ProductDomainError` so a caller can tell which layer
 * rejected a value. The same reasoning applies here, one layer up, and
 * for a sharper reason: `src/feedback/**` is a **stateful** layer.
 *
 * `ReviewContractError` means "this value is not a legal disposition" —
 * a statement about one document. `FeedbackContractError` means "this
 * append would corrupt the ledger" — a statement about the *sequence*
 * the document is being added to: an illegal transition from the
 * current head, a `supersedes` that points at nothing, a duplicate id
 * whose content differs from the id already recorded. A caller that
 * catches one of these needs to know which happened, because the two
 * have different recoveries: a contract error means fix the producer,
 * a ledger error means fix the write path.
 *
 * ## The one place the two meet
 *
 * Transition legality is owned by #61 (`assertDispositionTransition`,
 * which throws `ReviewContractError` with the table of states that
 * *were* available). `src/feedback/**` calls it and re-raises as a
 * `FeedbackContractError` that carries the original message verbatim,
 * so a caller of this layer has exactly one error type to catch while
 * the diagnosis #61 wrote is still readable. `detail.causeType` records
 * which layer produced the underlying verdict.
 */

export class FeedbackContractError extends Error {
  readonly kind = 'feedback_contract_error' as const;
  constructor(
    message: string,
    /** Dotted path of the offending element, e.g. `disposition.supersedes`. */
    readonly field?: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'FeedbackContractError';
  }
}

export function isFeedbackContractError(value: unknown): value is FeedbackContractError {
  return value instanceof FeedbackContractError;
}

/**
 * Re-raise a failure raised by another layer as a `FeedbackContractError`.
 *
 * Mirrors #61's `asReviewContractError`, for the same reason and with
 * the same asymmetry: a local check is never relabelled, so a genuine
 * `FeedbackContractError` thrown by the callback propagates unchanged
 * and only a foreign error is wrapped.
 */
export function asFeedbackContractError<T>(field: string, run: () => T): T {
  try {
    return run();
  } catch (cause) {
    if (cause instanceof FeedbackContractError) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new FeedbackContractError(
      `${field} was rejected by the feedback ledger: ${message}`,
      field,
      { causeType: cause instanceof Error ? cause.name : typeof cause },
    );
  }
}
