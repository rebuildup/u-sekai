/**
 * Operator failure taxonomy (ADR-0011, issue #59).
 *
 * ## Why this layer owns its own error type
 *
 * `src/domain/evidence.ts` has a closed seven-member
 * `TerminationReason` union and a coarse
 * `runtimeErrors: { ts, where, message }` list. That shape cannot express
 * the distinction this ticket exists to protect: **a provisioning failure
 * is a setup failure**, and a setup failure recorded as a product finding
 * corrupts every downstream KPI computed from it. Rather than widen a
 * contract five other tickets share, this module models the distinction
 * inside `src/operator/**` and projects it (see `evidence.ts`).
 *
 * ## The split
 *
 * Every operator failure answers exactly one question: *who failed?*
 *
 * - `operatorSetup` — u-sekai could not put the world into the state the
 *   evaluation needed. The product was never really exercised, so no
 *   conclusion about the product may be drawn from this run. The
 *   environment/authority/connector was the thing that failed.
 * - `productResponse` — the product under test itself refused or
 *   rejected the setup. This is a genuine observation *of the product*
 *   (duplicate account, unknown plan, declined sandbox card), and it is
 *   the connector that observed it, not this layer guessing.
 *
 * The two are separate interfaces, not one interface with a literal
 * discriminator, so they are structurally non-assignable to each other.
 * `test/unit/operator/acceptance-invariants.test.ts` pins that with
 * `@ts-expect-error` assertions.
 *
 * ## Neither branch is a UX finding
 *
 * The taxonomy deliberately has no finding branch. The operator has no
 * channel through which a Setup or Participant observation could be
 * emitted, so a provisioning failure cannot become a product finding by
 * construction. Generalising the evidence contract to carry this split is
 * Issue #72's ticket; this module is the seam it will widen.
 */

import type { OperatorStepKind } from './steps.js';

/**
 * Failure kinds where **u-sekai** failed to establish the world.
 *
 * Not product outcomes. A run that failed this way has not evaluated
 * the product, and `docs/product/configuration-and-authority.md`
 * requires it to be failed explicitly rather than reported as a result.
 */
export const OPERATOR_SETUP_FAILURE_KINDS = [
  /** The request is not a well-formed provisioning plan. */
  'invalidRequest',
  /** The step, or the environment it names, is outside declared authority. */
  'authorityDenied',
  /** The step is granted, but its risk class exceeds the policy's ceiling. */
  'riskNotPermitted',
  /** The configured quantitative budget cannot cover the plan. */
  'budgetExhausted',
  /** The connector itself failed. */
  'connectorFailed',
  /**
   * Compensation after a mid-plan failure did not fully release what had
   * already been applied. This is deliberately the loudest kind in the
   * taxonomy: it is the only one that can leave state behind, so it must
   * never be collapsed into the failure that triggered it.
   */
  'rollbackFailed',
] as const;

export type OperatorSetupFailureKind = (typeof OPERATOR_SETUP_FAILURE_KINDS)[number];

/**
 * Failure kinds that are the **product's own response** to a setup
 * attempt.
 *
 * Kept to a single kind on purpose. A product that refuses to create a
 * duplicate account is evidence about the product; a product that is
 * merely unreachable is a setup failure and is reported as
 * `connectorFailed`. Conflating the two is the corruption this taxonomy
 * exists to prevent.
 */
export const OPERATOR_PRODUCT_FAILURE_KINDS = ['productRejected'] as const;

export type OperatorProductFailureKind = (typeof OPERATOR_PRODUCT_FAILURE_KINDS)[number];

export type OperatorFailureKind = OperatorSetupFailureKind | OperatorProductFailureKind;

/** Which side of the boundary failed. Discriminates the union below. */
export const OPERATOR_FAILURE_SUBJECTS = ['operatorSetup', 'productResponse'] as const;
export type OperatorFailureSubject = (typeof OPERATOR_FAILURE_SUBJECTS)[number];

/**
 * Subject implied by each failure kind.
 *
 * Exported so a reader of a stored record can check the pairing, and so
 * `projectOperatorFailure` never has to restate it.
 */
export const OPERATOR_FAILURE_SUBJECT: Readonly<Record<OperatorFailureKind, OperatorFailureSubject>> =
  Object.freeze({
    invalidRequest: 'operatorSetup',
    authorityDenied: 'operatorSetup',
    riskNotPermitted: 'operatorSetup',
    budgetExhausted: 'operatorSetup',
    connectorFailed: 'operatorSetup',
    rollbackFailed: 'operatorSetup',
    productRejected: 'productResponse',
  });

interface OperatorFailureBase {
  /** ISO-8601 instant, taken from the injected clock. Never ambient. */
  readonly ts: string;
  /** Dotted path where the failure happened, e.g. `operator.provision.steps[2]`. */
  readonly where: string;
  readonly message: string;
  /** Bounded, non-secret diagnostic. Never contains a credential value. */
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * u-sekai failed to establish the requested world state.
 *
 * A run that ends here has **not** evaluated the product. Callers must
 * fail the affected evaluation explicitly rather than continue with a
 * partially prepared world.
 */
export interface OperatorSetupFailure extends OperatorFailureBase {
  readonly subject: 'operatorSetup';
  readonly failureKind: OperatorSetupFailureKind;
  /** Index into the plan's steps; `-1` when the whole plan was refused. */
  readonly stepIndex: number;
  /** `null` when the plan was refused before any step could be identified. */
  readonly stepKind: OperatorStepKind | null;
  readonly resourceKey: string | null;
  /** Whether every step applied before the failure was released. */
  readonly rolledBack: boolean;
  /**
   * Resources that compensation could not release. Non-empty exactly when
   * `failureKind` is `rollbackFailed`.
   */
  readonly orphanedResourceKeys: ReadonlyArray<string>;
}

/** The product under test rejected the setup. A product observation, not a setup failure. */
export interface OperatorProductFailure extends OperatorFailureBase {
  readonly subject: 'productResponse';
  readonly failureKind: OperatorProductFailureKind;
  readonly stepIndex: number;
  readonly stepKind: OperatorStepKind;
  readonly resourceKey: string;
  /** The product's own machine-readable code, e.g. `account_already_exists`. */
  readonly productCode: string;
}

export type OperatorFailure = OperatorSetupFailure | OperatorProductFailure;

/** Narrowing helper. */
export function isOperatorSetupFailure(failure: OperatorFailure): failure is OperatorSetupFailure {
  return failure.subject === 'operatorSetup';
}

export function isOperatorProductFailure(failure: OperatorFailure): failure is OperatorProductFailure {
  return failure.subject === 'productResponse';
}

/**
 * Thrown only for *contract* violations detected while parsing a policy,
 * a plan, or a lineage — the same role `ProductDomainError` plays in the
 * durable model. Runtime outcomes (denial, budget exhaustion, connector
 * or product failure) are returned, not thrown, so a caller cannot
 * accidentally treat a denial as an exception to be swallowed.
 */
export class OperatorError extends Error {
  readonly kind: 'operator_error' = 'operator_error' as const;
  readonly failureKind: OperatorFailureKind;
  /** Derived from `OPERATOR_FAILURE_SUBJECT`, so the two cannot disagree. */
  readonly subject: OperatorFailureSubject;
  constructor(
    failureKind: OperatorFailureKind,
    message: string,
    readonly field?: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'OperatorError';
    this.failureKind = failureKind;
    this.subject = OPERATOR_FAILURE_SUBJECT[failureKind];
  }
}
