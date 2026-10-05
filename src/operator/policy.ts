/**
 * Declared authority for the World Operator (ADR-0011, issue #59).
 *
 * ## The policy is the boundary
 *
 * `docs/product/configuration-and-authority.md` separates *human-declared
 * authority* from *World Operator execution*, and states that "no agent
 * may create new authority merely because additional access would make a
 * run easier". This module is that human-declared authority as data. The
 * operator (`operator.ts`) can only reach a connector through
 * `authorizeStep`, and `authorizeStep` reads only from here.
 *
 * **There is no implicit policy.** A `WorldOperator` cannot be
 * constructed without one, so "authority not configured" resolves to "no
 * operator exists" rather than to a default grant. Deny-by-default is
 * therefore a property of the construction path, not of a default value
 * that a future edit could relax.
 *
 * ## Two independent guards
 *
 * A step is authorised only if it survives two checks that are computed
 * from *different* fields:
 *
 * 1. `grantedSteps` — the step kind must be listed. This is the explicit
 *    opt-in.
 * 2. `maxRisk` — the step's fixed risk class must be at or below the
 *    declared ceiling.
 *
 * They are independent on purpose. A policy that grants `fixture.reset`
 * but leaves the ceiling at `mutating` is refused, and a policy that
 * raises the ceiling to `destructive` without granting
 * `account.retire` is refused too. Either field can only widen authority
 * for step kinds the other also permits, so a single mistaken edit does
 * not silently grant the destructive step of the same risk class.
 *
 * ## Required, not defaulted
 *
 * `maxRisk` and `realMoney` are **required** fields. A policy author must
 * state the risk ceiling and the real-money decision rather than relying
 * on a default. This is the same discipline #57 applies to identity
 * state retention: the value that decides how much authority exists is
 * never inferred from its absence.
 *
 * ## Real money
 *
 * `realMoney` is a discriminated union, not a boolean with a limit. The
 * denied form has no `maxUnitsPerDay` field at all, so there is no value
 * to accidentally read as a limit while the mode is `denied`, and the
 * compiler narrows the enabled form to a policy that genuinely declared
 * a bound.
 */

import {
  ENVIRONMENT_CLASSES,
  parseEnvironmentEndpoint,
  type EnvironmentClass,
  type EnvironmentId,
} from '../product/index.js';
import { parseEnvironmentId } from '../product/index.js';
import { OperatorError } from './errors.js';
import {
  OPERATOR_RISK_CLASSES,
  OPERATOR_STEP_KINDS,
  type OperatorRiskClass,
  type OperatorStepKind,
} from './steps.js';
import {
  optionalString,
  rejectDuplicates,
  rejectUnknownKeys,
  requireArray,
  requireFiniteNumber,
  requireInteger,
  requireNonEmptyArray,
  requireOneOf,
  requireRecord,
  requireToken,
} from './validation.js';

export const MAX_ENVIRONMENT_GRANTS = 64;
export const MAX_GRANTED_STEPS = OPERATOR_STEP_KINDS.length;
export const MAX_TOKENS_PER_ENVIRONMENT = 64;
export const MAX_STEPS_PER_DAY = 100_000;
export const MAX_UNITS_PER_DAY = 10_000_000;

/**
 * What a policy says about one environment.
 *
 * An environment absent from `environments` has **no** authority at all,
 * even if a step kind is granted. That is the least-privilege default:
 * granting `account.create` grants it *for the declared environments*,
 * not for every environment the connector happens to know about.
 */
export interface OperatorEnvironmentGrant {
  readonly environmentId: EnvironmentId;
  /**
   * Declared classification. Required, and never inferred from a URL:
   * a connector that could classify the environment itself would be
   * reading the authority decision from the thing it is being judged
   * against.
   */
  readonly environmentClass: EnvironmentClass;
  /** Origins this environment may be touched on. Non-empty. */
  readonly baseUrl: string;
  readonly additionalOrigins?: ReadonlyArray<string>;
  /** Whether destructive steps may run here at all. Must be stated. */
  readonly destructiveAllowed: boolean;
  /**
   * A second, separate key required before a destructive step may run on
   * a `production` environment.
   *
   * Split from `destructiveAllowed` on purpose. "Destructive" and
   * "destructive *in production*" are separate decisions for a customer
   * to make, and a destructive grant for a staging fixture should not
   * carry the authority to delete production state.
   */
  readonly productionDestructive: boolean;
}

export interface OperatorBudget {
  /** Ceiling on steps dispatched per UTC day. 1..100000. */
  readonly maxStepsPerDay: number;
  /**
   * Ceiling on abstract cost units per UTC day. 1..10000000.
   *
   * The unit is deliberately undefined, matching #57's
   * `maxCostUnitsPerDay`: ADR-0011 requires provider neutrality, so a
   * budget may not be denominated in one vendor's cents or tokens.
   */
  readonly maxUnitsPerDay: number;
}

export type RealMoneyAuthority =
  | { readonly mode: 'denied' }
  | {
      readonly mode: 'enabled';
      /** 1..10000000. Bound required before real money is permitted at all. */
      readonly maxUnitsPerDay: number;
      /** Whether real money may be spent against a `production` environment. */
      readonly allowProduction: boolean;
    };

export interface OperatorAuthorityPolicy {
  readonly policyId: string;
  readonly environments: ReadonlyArray<OperatorEnvironmentGrant>;
  /** Step kinds the policy opts in to. Required; may be empty. */
  readonly grantedSteps: ReadonlyArray<OperatorStepKind>;
  /** Ceiling applied to every step's fixed risk class. Required. */
  readonly maxRisk: OperatorRiskClass;
  /** Per-kind abstract cost. A step not listed here costs 0 units. */
  readonly stepUnits: Readonly<Record<string, number>>;
  readonly realMoney: RealMoneyAuthority;
  readonly budget: OperatorBudget;
  /**
   * Seed templates `fixture.seed` may use. Absent means **no** template is
   * permitted, not "any": an unconfigured allow-list denies.
   */
  readonly allowedSeedTemplates?: ReadonlyArray<string>;
  /**
   * Inbox folders `inbox.read` may read. Absent means **no** folder is
   * permitted. There is no implicit "the account's own inbox".
   */
  readonly allowedInboxFolders?: ReadonlyArray<string>;
  readonly notes?: string;
}

const POLICY_FIELDS = [
  'policyId',
  'environments',
  'grantedSteps',
  'maxRisk',
  'stepUnits',
  'realMoney',
  'budget',
  'allowedSeedTemplates',
  'allowedInboxFolders',
  'notes',
] as const;

const ENVIRONMENT_FIELDS = [
  'environmentId',
  'environmentClass',
  'baseUrl',
  'additionalOrigins',
  'destructiveAllowed',
  'productionDestructive',
] as const;

const BUDGET_FIELDS = ['maxStepsPerDay', 'maxUnitsPerDay'] as const;
const REAL_MONEY_DENIED_FIELDS = ['mode'] as const;
const REAL_MONEY_ENABLED_FIELDS = ['mode', 'maxUnitsPerDay', 'allowProduction'] as const;

export function parseOperatorAuthorityPolicy(input: unknown, field = 'authority'): OperatorAuthorityPolicy {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, POLICY_FIELDS, field);

  const policyId = requireToken(raw['policyId'], `${field}.policyId`);
  const environments = parseEnvironmentGrants(raw['environments'], `${field}.environments`);
  const grantedSteps = parseGrantedSteps(raw['grantedSteps'], `${field}.grantedSteps`);
  const maxRisk = requireOneOf(raw['maxRisk'], OPERATOR_RISK_CLASSES, `${field}.maxRisk`);
  const stepUnits = parseStepUnits(raw['stepUnits'], `${field}.stepUnits`);
  const realMoney = parseRealMoneyAuthority(raw['realMoney'], `${field}.realMoney`);
  const budget = parseOperatorBudget(raw['budget'], `${field}.budget`);
  const allowedSeedTemplates = parseOptionalTokens(
    raw['allowedSeedTemplates'],
    `${field}.allowedSeedTemplates`,
  );
  const allowedInboxFolders = parseOptionalTokens(
    raw['allowedInboxFolders'],
    `${field}.allowedInboxFolders`,
  );
  const notes = optionalString(raw['notes'], `${field}.notes`, 2_000);

  // A production grant is meaningless unless the environment is declared
  // production: catching it here stops a policy that looks more careful
  // than it is.
  for (const grant of environments) {
    if (grant.productionDestructive && grant.environmentClass !== 'production') {
      throw new OperatorError(
        'invalidRequest',
        `${field}.environments: productionDestructive is only meaningful for a production environment`,
        `${field}.environments`,
        { environmentId: grant.environmentId, environmentClass: grant.environmentClass },
      );
    }
  }

  const result: { -readonly [K in keyof OperatorAuthorityPolicy]: OperatorAuthorityPolicy[K] } = {
    policyId,
    environments,
    grantedSteps,
    maxRisk,
    stepUnits,
    realMoney,
    budget,
  };
  if (allowedSeedTemplates !== undefined) result.allowedSeedTemplates = allowedSeedTemplates;
  if (allowedInboxFolders !== undefined) result.allowedInboxFolders = allowedInboxFolders;
  if (notes !== undefined) result.notes = notes;
  return Object.freeze(result);
}

export function parseEnvironmentGrants(
  value: unknown,
  field = 'authority.environments',
): ReadonlyArray<OperatorEnvironmentGrant> {
  const arr = requireNonEmptyArray(value, field);
  if (arr.length > MAX_ENVIRONMENT_GRANTS) {
    throw new OperatorError(
      'invalidRequest',
      `${field} must have at most ${MAX_ENVIRONMENT_GRANTS} entries`,
      field,
      { length: arr.length, maxLength: MAX_ENVIRONMENT_GRANTS },
    );
  }
  const grants = arr.map((entry, i) => parseEnvironmentGrant(entry, `${field}[${i}]`));
  rejectDuplicates(grants.map((g) => g.environmentId), field);
  return Object.freeze(grants);
}

function parseEnvironmentGrant(input: unknown, field: string): OperatorEnvironmentGrant {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, ENVIRONMENT_FIELDS, field);

  const environmentId = parseEnvironmentId(raw['environmentId'], `${field}.environmentId`);
  const environmentClass = requireOneOf(
    raw['environmentClass'],
    ENVIRONMENT_CLASSES,
    `${field}.environmentClass`,
  );
  // Reuse #57's endpoint parser so the operator's origin canonicalisation
  // is literally the durable model's, not a second implementation that
  // could drift from it.
  const endpoint = parseEnvironmentEndpoint(
    { baseUrl: raw['baseUrl'], additionalOrigins: raw['additionalOrigins'] },
    field,
  );

  const destructiveAllowed = requireBoolean(raw['destructiveAllowed'], `${field}.destructiveAllowed`);
  const productionDestructive = requireBoolean(
    raw['productionDestructive'],
    `${field}.productionDestructive`,
  );

  const result: { -readonly [K in keyof OperatorEnvironmentGrant]: OperatorEnvironmentGrant[K] } = {
    environmentId,
    environmentClass,
    baseUrl: endpoint.baseUrl,
    destructiveAllowed,
    productionDestructive,
  };
  if (endpoint.additionalOrigins !== undefined) {
    result.additionalOrigins = endpoint.additionalOrigins;
  }
  return Object.freeze(result);
}

/** Every origin the grant permits, canonicalised. */
export function grantOrigins(grant: OperatorEnvironmentGrant): ReadonlyArray<string> {
  return [grant.baseUrl, ...(grant.additionalOrigins ?? [])];
}

function parseGrantedSteps(value: unknown, field: string): ReadonlyArray<OperatorStepKind> {
  // An empty list is a valid, meaningful declaration: "this policy
  // grants no privileged step". Rejecting it would force a sentinel
  // policy to express the safest state, which is the opposite of
  // helpful. It is still a required field — the point is that the
  // decision is written down, not that it must be non-empty.
  const arr = requireArray(value, field);
  if (arr.length > MAX_GRANTED_STEPS) {
    throw new OperatorError(
      'invalidRequest',
      `${field} must have at most ${MAX_GRANTED_STEPS} entries`,
      field,
      { length: arr.length, maxLength: MAX_GRANTED_STEPS },
    );
  }
  const steps = arr.map((v, i) => requireOneOf(v, OPERATOR_STEP_KINDS, `${field}[${i}]`));
  rejectDuplicates(steps, field);
  return Object.freeze(steps);
}

function parseStepUnits(value: unknown, field: string): Readonly<Record<string, number>> {
  const raw = requireRecord(value, field);
  const out: Record<string, number> = {};
  for (const key of Object.keys(raw).sort()) {
    // A key naming a step kind that does not exist is a typo, not a
    // silently-ignored cost. Failing closed means it must be an error.
    const kind = requireOneOf(key, OPERATOR_STEP_KINDS, `${field}.${key}`);
    out[kind] = requireFiniteNumber(raw[key], `${field}.${key}`, 0);
  }
  return Object.freeze(out);
}

export function parseOperatorBudget(input: unknown, field = 'authority.budget'): OperatorBudget {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, BUDGET_FIELDS, field);
  return Object.freeze({
    maxStepsPerDay: requireInteger(raw['maxStepsPerDay'], `${field}.maxStepsPerDay`, 1, MAX_STEPS_PER_DAY),
    maxUnitsPerDay: requireInteger(raw['maxUnitsPerDay'], `${field}.maxUnitsPerDay`, 1, MAX_UNITS_PER_DAY),
  });
}

export function parseRealMoneyAuthority(input: unknown, field = 'authority.realMoney'): RealMoneyAuthority {
  const raw = requireRecord(input, field);
  const mode = requireOneOf(raw['mode'], ['denied', 'enabled'] as const, `${field}.mode`);
  if (mode === 'denied') {
    rejectUnknownKeys(raw, REAL_MONEY_DENIED_FIELDS, field);
    return Object.freeze({ mode });
  }
  rejectUnknownKeys(raw, REAL_MONEY_ENABLED_FIELDS, field);
  return Object.freeze({
    mode,
    maxUnitsPerDay: requireInteger(
      raw['maxUnitsPerDay'],
      `${field}.maxUnitsPerDay`,
      1,
      MAX_UNITS_PER_DAY,
    ),
    allowProduction: requireBoolean(raw['allowProduction'], `${field}.allowProduction`),
  });
}

/** Units a step costs under a policy. Unlisted steps cost 0. */
export function stepCost(policy: OperatorAuthorityPolicy, kind: OperatorStepKind): number {
  return policy.stepUnits[kind] ?? 0;
}

function parseOptionalTokens(value: unknown, field: string): ReadonlyArray<string> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new OperatorError('invalidRequest', `${field} must be an array`, field);
  }
  if (value.length > MAX_TOKENS_PER_ENVIRONMENT) {
    throw new OperatorError(
      'invalidRequest',
      `${field} must have at most ${MAX_TOKENS_PER_ENVIRONMENT} entries`,
      field,
      { length: value.length, maxLength: MAX_TOKENS_PER_ENVIRONMENT },
    );
  }
  const tokens = value.map((v, i) => requireToken(v, `${field}[${i}]`));
  rejectDuplicates(tokens, field);
  return Object.freeze(tokens);
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new OperatorError('invalidRequest', `${field} must be a boolean`, field, {
      received: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
    });
  }
  return value;
}
