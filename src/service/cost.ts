/**
 * Declared cost of an evaluation run (issue #66).
 *
 * ## This module exists because a product decision is open
 *
 * `docs/product/kpis.md` defines "cost per verified finding" and "cost
 * per accepted finding" as `direct evaluation cost / findings`, and
 * names the cost *sources* (model, browser, storage, provider) without
 * ever naming a unit. ADR-0011 additionally requires provider
 * neutrality, so a unit denominated in one vendor's tokens or cents is
 * excluded by the architecture, and `docs/product/implementation-plan-0.4.0.md`
 * defers "customer billing for the u-sekai service" past the vertical
 * slice. There is therefore no unit to read out of the repository, and
 * #64 recorded the gap in `UNCOMPUTED_KPI_TERMS` rather than picking one.
 *
 * The decision was routed here because a control plane is the layer that
 * would *hold* the declared unit. This module takes that routing
 * literally and takes the smallest action that is honest:
 *
 * - the unit is a **required injected input** to `createService`, with
 *   no default anywhere in this package;
 * - every cost figure this service publishes carries the declared unit
 *   and the declared reportable precision, so no consumer has to guess;
 * - **this service publishes no cost-per-finding figure at all.** The
 *   quotient is #64's, and until the product names a precision, a
 *   rounded number here would be an invented scale. The report carries
 *   `costPerFinding: undefined` and the policy that would decide it.
 *
 * Picking "six decimal places" because #64's ratio constant happens to
 * be six would be exactly the failure this file documents: the number
 * would look specified and be unbacked.
 *
 * ## The open question, verbatim
 *
 * > In what declared unit is *direct evaluation cost* denominated, and
 * > how many decimal places of that unit are reportable in
 * > `cost per finding`?
 *
 * Until it is answered, the correct behaviour is to require the answer
 * at construction and to refuse to derive a figure without it.
 */

import { ServiceError } from './errors.js';

/** Bound on the declared precision, so a caller cannot ask for noise. */
export const MAX_REPORTABLE_DECIMALS = 12;

/**
 * The declared cost unit and its reportable precision.
 *
 * Injected into `createService` and required. There is no default, no
 * `DEFAULT_COST_POLICY`, and no optional field: a service that could
 * run without one would be a service that had already chosen a unit
 * silently.
 */
export interface ServiceCostPolicy {
  /**
   * The unit, by name, e.g. `'usd.micros'`. Provider-neutral by
   * requirement, so this is the operator's own accounting unit and not
   * a vendor's token count.
   */
  readonly unit: string;
  /**
   * Decimal places of `unit` that are reportable in a per-finding
   * quotient. Consumed by the KPI layer (#64), not applied here.
   */
  readonly reportableDecimals: number;
}

/**
 * A run's cost, as declared.
 *
 * Integer in the declared unit, so a run's own figure needs no rounding
 * at all — the precision question is a *ratio* question, and this type
 * is a numerator.
 */
export interface DeclaredCost {
  readonly amount: number;
  readonly unit: string;
  /** Carried so a consumer does not have to look the policy up. */
  readonly reportableDecimals: number;
}

/** Parse and validate a declared cost policy. Rejects anything implicit. */
export function parseServiceCostPolicy(
  input: unknown,
  field = 'config.cost',
): ServiceCostPolicy {
  if (input === undefined || input === null) {
    throw new ServiceError(
      'a declared cost unit is required: cost-per-finding reportable precision is an open ' +
        'product decision and this service applies no default for it',
      'missing-cost-policy',
      field,
    );
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ServiceError(`${field} must be an object`, 'invalid-request', field);
  }
  const raw = input as Record<string, unknown>;
  const unknownKeys = Object.keys(raw)
    .filter((k) => k !== 'unit' && k !== 'reportableDecimals')
    .sort();
  if (unknownKeys.length > 0) {
    throw new ServiceError(
      `${field} has unknown field(s): ${unknownKeys.join(', ')}`,
      'unknown-field',
      field,
      { unknown: unknownKeys },
    );
  }
  const unit = raw['unit'];
  if (typeof unit !== 'string' || unit.trim() === '' || unit.length > 64) {
    throw new ServiceError(
      `${field}.unit must be a non-empty string of at most 64 characters`,
      'invalid-request',
      `${field}.unit`,
    );
  }
  const decimals = raw['reportableDecimals'];
  if (
    typeof decimals !== 'number' ||
    !Number.isSafeInteger(decimals) ||
    decimals < 0 ||
    decimals > MAX_REPORTABLE_DECIMALS
  ) {
    throw new ServiceError(
      `${field}.reportableDecimals must be an integer in 0..${MAX_REPORTABLE_DECIMALS}`,
      'invalid-request',
      `${field}.reportableDecimals`,
      { received: decimals },
    );
  }
  return Object.freeze({ unit, reportableDecimals: decimals });
}

/**
 * Attach the declared unit and precision to an integer amount.
 *
 * The unit is taken from the policy and never from the amount's
 * provenance, so two runs cannot be summed into one figure that mixes
 * units — the failure that makes a cost-per-finding KPI meaningless
 * rather than merely wrong.
 */
export function declaredCost(amount: number, policy: ServiceCostPolicy, field = 'cost'): DeclaredCost {
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) {
    throw new ServiceError(
      `${field}.amount must be a non-negative safe integer in the declared unit`,
      'invalid-request',
      `${field}.amount`,
      { received: amount, unit: policy.unit },
    );
  }
  return Object.freeze({
    amount,
    unit: policy.unit,
    reportableDecimals: policy.reportableDecimals,
  });
}
