/**
 * The cost model for an evaluation plan (issue #62).
 *
 * ## What a "cost unit" is
 *
 * #57's `ProgramBudget.maxCostUnitsPerDay` is a ceiling on
 * "service-internal cost units" and is deliberately left undefined by
 * that layer, because ADR-0011 requires provider neutrality: a durable
 * budget may not be denominated in one vendor's tokens or cents. This
 * module defines the unit as a **declared internal unit of work** — one
 * unit is whatever the managed service charges itself for one unit of
 * declared evaluation effort, whatever model, browser or provider that
 * effort turns out to consume.
 *
 * ## The model is arithmetic on declared integers, never on measurement
 *
 * ```
 * scoutCostUnits       = plannedIdentities * scoutUnitsPerIdentity
 * verificationCostUnits= maxVerifications * verificationUnitsPerIdentity
 * totalCostUnits       = scoutCostUnits + verificationCostUnits
 * ```
 *
 * Every input is a number the program *declared*: how many identities
 * the plan covers, how many of them may escalate, and the rate table.
 * Nothing is sampled from an LLM response, a token count, a wall-clock
 * reading or a network call. That is deliberate, not a simplification:
 *
 * - a cost estimated from token counts is non-deterministic, so the
 *   same plan could be priced differently on every planning attempt,
 *   and a budget that moves is not a budget;
 * - actual cost is only knowable *after* the run, which is far too late
 *   to decide whether the run may start. Enforcing a ceiling requires a
 *   pre-commit figure, so the pre-commit figure has to be derived from
 *   declarations.
 *
 * The runtime (#63) may record actual spend afterwards; this module
 * never feeds measurement back into a plan.
 *
 * ## Verification is reserved at the worst case, deliberately
 *
 * `totalCostUnits` charges the full escalation envelope up front, even
 * though most scouts do not escalate. Reserving only the scout cost and
 * charging verification on the way up would be cheaper on average, but
 * it splits the budget across two moments and needs a second "reserved
 * but unspent" counter — which is precisely where an over-commit or a
 * double-charge bug would live. One counter, one reservation, charged
 * once, is the structure that makes "escalation cannot double-charge"
 * true by construction rather than by review.
 *
 * The cost of that choice is over-reservation: a program spends its
 * daily ceiling faster than it burns real service cost. This is
 * recorded as a known limitation in the PR, not hidden.
 */

import { ProgramPlanningError } from './errors.js';

export interface StageCostRates {
  /** Declared cost of scouting one identity. Finite, >= 0. */
  readonly scoutUnitsPerIdentity: number;
  /** Declared cost of verifying one escalated identity. Finite, >= 0. */
  readonly verificationUnitsPerIdentity: number;
}

export interface PlanCost {
  readonly scoutCostUnits: number;
  readonly verificationCostUnits: number;
  /** The amount reserved against the daily ceiling. */
  readonly totalCostUnits: number;
}

export function parseStageCostRates(input: unknown, field = 'input.rates'): StageCostRates {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ProgramPlanningError(`${field} must be an object`, field);
  }
  const raw = input as Record<string, unknown>;
  return Object.freeze({
    scoutUnitsPerIdentity: requireRate(raw['scoutUnitsPerIdentity'], `${field}.scoutUnitsPerIdentity`),
    verificationUnitsPerIdentity: requireRate(
      raw['verificationUnitsPerIdentity'],
      `${field}.verificationUnitsPerIdentity`,
    ),
  });
}

/**
 * Compute the plan's cost envelope.
 *
 * @param plannedIdentities identities the plan will scout. A declared
 *   ceiling or a resolvable membership size, never a measured count.
 * @param maxVerifications identities permitted to escalate. Bounded by
 *   `plannedIdentities`, so verification can never exceed the scout.
 */
export function planCost(
  plannedIdentities: number,
  maxVerifications: number,
  rates: StageCostRates,
): PlanCost {
  const scoutCostUnits = plannedIdentities * rates.scoutUnitsPerIdentity;
  const verificationCostUnits = maxVerifications * rates.verificationUnitsPerIdentity;
  return Object.freeze({
    scoutCostUnits,
    verificationCostUnits,
    totalCostUnits: scoutCostUnits + verificationCostUnits,
  });
}

function requireRate(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProgramPlanningError(`${field} must be a finite number`, field, { received: value });
  }
  if (value < 0) {
    throw new ProgramPlanningError(`${field} must be >= 0`, field, { received: value });
  }
  return value;
}
