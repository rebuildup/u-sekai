/**
 * The disposition seam — where #64 plugs in (issue #66).
 *
 * ## Why this is a port and not an import
 *
 * Issue #64 owns `src/feedback/**` and this ticket owns
 * `src/service/**`. Branch `64` and branch `63` are **siblings**: both
 * fork from `c36dc4c`, and neither contains the other
 * (`git merge-base 63 origin/64` is `c36dc4c`, and
 * `git diff --stat 63 origin/64` shows #64 *removing* all of #63's
 * runtime). So at the point this ticket is built, `src/feedback/**` is
 * not on its base and importing it would not compile — and vendoring a
 * second copy of the ledger would be worse than useless, because two
 * transition tables that agree until someone edits one of them produce
 * an audit trail that accepts an illegal move.
 *
 * So the control plane declares the seam it needs and the composition
 * root wires it. `src/service/**` imports **nothing** from
 * `src/feedback/**`; a one-function adapter over #64's
 * `appendDisposition` / `currentDisposition` / `dispositionHistory` is
 * the whole integration, and it belongs wherever the composition root
 * lives (`src/index.ts`, #65's ticket).
 *
 * ## The service still enforces the transition itself
 *
 * It would be easy to delegate the legality question entirely to the
 * sink. This does not, because the guarantee "an illegal disposition
 * cannot be recorded through the service API" must hold even against a
 * sink that forgets to check. So the service:
 *
 * 1. reads the current state through {@link FeedbackSink.currentDisposition};
 * 2. checks the move against #61's own `assertDispositionTransition`;
 * 3. only then appends.
 *
 * The ledger checks again on its side. Two enforcers, one table — and
 * `test/integration/service/disposition.test.ts` proves the service's
 * check holds with a deliberately lax sink installed.
 *
 * ## The reference must resolve
 *
 * A disposition names a finding id. A sink that accepts an id nothing
 * ever produced records a judgement about a non-existent problem, and
 * the false-positive rate #64 computes over it becomes meaningless. So
 * the service resolves the id against its own run index first and
 * refuses `finding-not-found`.
 */

import type { ProductId } from '../product/index.js';
import type { Disposition, DispositionId, FindingId } from '../review/index.js';
import type { TenantId } from './identity.js';

export interface DispositionSubmission {
  readonly tenantId: TenantId;
  readonly productId: ProductId;
  /** Already validated by #61 and already transition-checked here. */
  readonly disposition: Disposition;
  /**
   * Client-declared request id, stable across a retry of the *same*
   * submission.
   *
   * This is what makes a double-clicked "Accept" one disposition rather
   * than two. Reusing it with a different body is refused
   * (`idempotency-conflict`) rather than silently deduplicated, because
   * two different judgements sharing one key is an upstream bug worth
   * seeing.
   */
  readonly requestId: string;
}

export interface DispositionAppendResult {
  readonly recorded: true;
  readonly dispositionId: DispositionId;
  /** True when this submission had already been recorded. */
  readonly duplicate: boolean;
}

/**
 * The feedback abstraction this control plane writes through.
 *
 * Implemented over #64's `DispositionLedger`; see the module docstring
 * for why it is injected rather than imported.
 */
export interface FeedbackSink {
  /**
   * The current disposition for a finding, or `undefined` when the
   * finding has never been dispositioned.
   *
   * `undefined` means `INITIAL_DISPOSITION_STATE` (`unreviewed`). It is
   * an answer, not an absence of one — the service needs it to decide
   * whether the requested move is legal at all.
   */
  currentDisposition(findingId: FindingId): Promise<Disposition | undefined>;

  /** Append. Must refuse a duplicate `requestId` rather than append twice. */
  appendDisposition(submission: DispositionSubmission): Promise<DispositionAppendResult>;

  /** Full history for one finding, oldest first. */
  dispositionHistory(findingId: FindingId): Promise<ReadonlyArray<Disposition>>;
}

/**
 * A sink that refuses every submission.
 *
 * The default a caller gets if they pass none, and the reason
 * `submitDisposition` cannot be forgotten into a silent no-op: a
 * control plane with no feedback ledger must say so, not report a
 * disposition as accepted and drop it.
 */
export class UnavailableFeedbackSink implements FeedbackSink {
  async currentDisposition(): Promise<Disposition | undefined> {
    return undefined;
  }

  async appendDisposition(): Promise<DispositionAppendResult> {
    throw new Error(
      'no FeedbackSink is configured: disposition submission requires the #64 feedback ledger',
    );
  }

  async dispositionHistory(): Promise<ReadonlyArray<Disposition>> {
    return Object.freeze([]);
  }
}
