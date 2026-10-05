/**
 * Planning-layer error for the Review Program planner (issue #62).
 *
 * ## Why a second error type
 *
 * `src/product/**` (issue #57) owns `ProductDomainError` for the durable
 * declarations. This layer owns a different failure class: not "this
 * declaration is malformed" but "these *planning inputs* do not describe
 * a plan we are willing to emit" — a program id that is not in the
 * model, an observation whose lineage is not a transition, a planning
 * ceiling above the module maximum.
 *
 * Reusing `ProductDomainError` would blur "the durable model is invalid"
 * with "this scheduling decision cannot be made", and a caller that
 * catches one would silently accept the other.
 *
 * ## Budget exhaustion is *not* an error
 *
 * A program that has exhausted its budget is a normal, expected state of
 * a durable program, not an exception. It is reported as a
 * `not-due` decision with reason `budget-exhausted`, never thrown.
 * Throwing would make "ran out of money" indistinguishable from "the
 * caller passed garbage", and would encourage a caller to catch-and-
 * retry, which is exactly the loop a budget exists to stop.
 *
 * This module owns no timers, no I/O, and no provider. Planning is a
 * pure function of its inputs; durability of the ledger is the
 * caller's storage concern.
 */

export class ProgramPlanningError extends Error {
  readonly kind: 'program_planning_error' = 'program_planning_error' as const;

  constructor(
    message: string,
    /** Dotted path of the offending field, e.g. `input.planningCeiling`. */
    readonly field?: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ProgramPlanningError';
  }
}
