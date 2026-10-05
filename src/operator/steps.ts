/**
 * The World Operator step vocabulary (ADR-0011, issue #59).
 *
 * ## A closed vocabulary is the boundary
 *
 * `OperatorStep` is a closed discriminated union. There is no `extra`,
 * no `params: Record<string, unknown>`, and no string-keyed escape
 * hatch, because a permissive bag of attributes is where an authority
 * boundary leaks: anything the parser does not model is a capability
 * nobody reviewed. Every step therefore states exactly what it does, and
 * `parseOperatorStep` rejects anything else.
 *
 * ## Risk classes
 *
 * Each step carries a fixed risk class, declared here rather than
 * supplied by the caller. `docs/product/configuration-and-authority.md`
 * lists the classes that are "disabled by default and require explicit
 * narrow enablement": real-money purchase or refund, destructive
 * production mutation, irreversible account deletion, external messages,
 * and use of a real person's identity or credentials.
 *
 * Two of those are modelled as first-class:
 *
 * - **Real money is a distinct step kind, not a flag.**
 *   `billing.sandboxCharge` and `billing.realCharge` are separate
 *   members with separate connectors' worth of meaning. A boolean on one
 *   kind could be flipped by a caller or a config typo; a distinct kind
 *   cannot, because the `realMoney` authority check is a constant-folded
 *   property of which member was constructed.
 * - **Real identities have no representation at all.** No step has a
 *   field for an email address, a login, a credential or any real-user
 *   handle — the only actor handle any step accepts is a
 *   `SyntheticIdentityId` from the durable model. A request that tries to
 *   pass one is rejected as an unknown field.
 *
 * ## Destructive steps are ordinary steps
 *
 * Cleanup is not a special mode. `account.retire`, `fixture.reset` and
 * `entitlement.revoke` are steps like any other, which is what lets the
 * same authority gate, the same budget, and the same rollback cover both
 * setup and cleanup. A separate "admin" entry point would have been a
 * second, ungated path to the same connectors.
 */

import { parseSyntheticIdentityId, type SyntheticIdentityId } from '../product/index.js';
import { OperatorError } from './errors.js';
import {
  rejectUnknownKeys,
  requireFiniteNumber,
  requireInteger,
  requireNonEmptyString,
  requireRecord,
  requireToken,
} from './validation.js';

/** Create or retire a test account. */
export const OPERATOR_STEP_KINDS = [
  'account.create',
  'account.retire',
  'fixture.seed',
  'fixture.reset',
  'entitlement.grant',
  'entitlement.revoke',
  'inbox.read',
  'billing.sandboxCharge',
  'billing.realCharge',
] as const;

export type OperatorStepKind = (typeof OPERATOR_STEP_KINDS)[number];

/**
 * Risk classes, ordered.
 *
 * The order is load-bearing: `OPERATOR_RISK_ORDER` turns a step's class
 * and the policy's `maxRisk` into a comparison, so raising a ceiling is
 * the single lever that widens authority.
 */
export const OPERATOR_RISK_CLASSES = ['sandbox', 'mutating', 'destructive', 'external'] as const;
export type OperatorRiskClass = (typeof OPERATOR_RISK_CLASSES)[number];

const RISK_ORDER: Readonly<Record<OperatorRiskClass, number>> = Object.freeze({
  sandbox: 0,
  mutating: 1,
  destructive: 2,
  external: 3,
});

export function compareRisk(a: OperatorRiskClass, b: OperatorRiskClass): number {
  return RISK_ORDER[a] - RISK_ORDER[b];
}

export function riskAtLeast(class_: OperatorRiskClass, floor: OperatorRiskClass): boolean {
  return RISK_ORDER[class_] >= RISK_ORDER[floor];
}

/**
 * The fixed risk class of each step.
 *
 * Declared here so no caller, request or connector can describe a step
 * as less risky than it is.
 */
export const OPERATOR_STEP_RISK: Readonly<Record<OperatorStepKind, OperatorRiskClass>> =
  Object.freeze({
    'account.create': 'mutating',
    'account.retire': 'destructive',
    'fixture.seed': 'mutating',
    'fixture.reset': 'destructive',
    'entitlement.grant': 'mutating',
    'entitlement.revoke': 'destructive',
    'inbox.read': 'sandbox',
    'billing.sandboxCharge': 'mutating',
    'billing.realCharge': 'external',
  });

export function isOperatorStepKind(value: unknown): value is OperatorStepKind {
  return typeof value === 'string' && (OPERATOR_STEP_KINDS as readonly string[]).includes(value);
}

export function operatorStepRisk(kind: OperatorStepKind): OperatorRiskClass {
  return OPERATOR_STEP_RISK[kind];
}

/** Upper bound on `amountUnits` for any billing step. 1_000_000 mirrors `MAX_COST_UNITS_PER_DAY`. */
export const MAX_BILLING_UNITS = 1_000_000;
/** Upper bound on the number of messages a single inbox read may return. */
export const MAX_INBOX_MESSAGES = 100;

interface OperatorStepBase {
  /**
   * Caller-declared handle for the world resource this step produces or
   * consumes, unique within a plan. Declared, never generated: there is
   * no id generator in this package, so a resource cannot be addressed by
   * a value this layer invented.
   */
  readonly resourceKey: string;
  /**
   * Origin the step acts against. Checked against the environment
   * grant's allowed origins — crossing a configured origin is one of the
   * explicitly dangerous classes.
   */
  readonly origin: string;
}

export interface AccountCreateStep extends OperatorStepBase {
  readonly kind: 'account.create';
  /** The only actor handle any step accepts. Never a real identity. */
  readonly identityId: SyntheticIdentityId;
  readonly displayName: string;
}

export interface AccountRetireStep extends OperatorStepBase {
  readonly kind: 'account.retire';
}

export interface FixtureSeedStep extends OperatorStepBase {
  readonly kind: 'fixture.seed';
  readonly identityId: SyntheticIdentityId;
  /** Must appear in the policy's `allowedSeedTemplates`. */
  readonly template: string;
}

export interface FixtureResetStep extends OperatorStepBase {
  readonly kind: 'fixture.reset';
}

export interface EntitlementGrantStep extends OperatorStepBase {
  readonly kind: 'entitlement.grant';
  readonly identityId: SyntheticIdentityId;
  /** Sandbox plan/entitlement name. Never a live vendor plan id. */
  readonly entitlement: string;
}

export interface EntitlementRevokeStep extends OperatorStepBase {
  readonly kind: 'entitlement.revoke';
}

export interface InboxReadStep extends OperatorStepBase {
  readonly kind: 'inbox.read';
  readonly identityId: SyntheticIdentityId;
  /** Must appear in the policy's `allowedInboxFolders`. */
  readonly folder: string;
  readonly maxMessages: number;
}

export interface BillingSandboxChargeStep extends OperatorStepBase {
  readonly kind: 'billing.sandboxCharge';
  readonly identityId: SyntheticIdentityId;
  readonly amountUnits: number;
}

export interface BillingRealChargeStep extends OperatorStepBase {
  readonly kind: 'billing.realCharge';
  readonly identityId: SyntheticIdentityId;
  readonly amountUnits: number;
}

export type OperatorStep =
  | AccountCreateStep
  | AccountRetireStep
  | FixtureSeedStep
  | FixtureResetStep
  | EntitlementGrantStep
  | EntitlementRevokeStep
  | InboxReadStep
  | BillingSandboxChargeStep
  | BillingRealChargeStep;

const STEP_FIELDS: Readonly<Record<OperatorStepKind, readonly string[]>> = Object.freeze({
  'account.create': ['kind', 'resourceKey', 'origin', 'identityId', 'displayName'],
  'account.retire': ['kind', 'resourceKey', 'origin'],
  'fixture.seed': ['kind', 'resourceKey', 'origin', 'identityId', 'template'],
  'fixture.reset': ['kind', 'resourceKey', 'origin'],
  'entitlement.grant': ['kind', 'resourceKey', 'origin', 'identityId', 'entitlement'],
  'entitlement.revoke': ['kind', 'resourceKey', 'origin'],
  'inbox.read': ['kind', 'resourceKey', 'origin', 'identityId', 'folder', 'maxMessages'],
  'billing.sandboxCharge': ['kind', 'resourceKey', 'origin', 'identityId', 'amountUnits'],
  'billing.realCharge': ['kind', 'resourceKey', 'origin', 'identityId', 'amountUnits'],
});

/** Whether a step consumes `identityId`. Used by the plan validator and by tests. */
export function stepIdentityId(step: OperatorStep): SyntheticIdentityId | null {
  return 'identityId' in step ? step.identityId : null;
}

/** Whether a step produces a durable resource that compensation must release. */
export function stepProducesResource(step: OperatorStep): boolean {
  return step.kind !== 'inbox.read';
}

/** Whether a step consumes a resource produced earlier in the same plan. */
export function stepConsumesResource(step: OperatorStep): boolean {
  return step.kind === 'account.retire' || step.kind === 'fixture.reset' || step.kind === 'entitlement.revoke';
}

export function parseOperatorStep(input: unknown, field = 'step'): OperatorStep {
  const raw = requireRecord(input, field);
  if (!isOperatorStepKind(raw['kind'])) {
    throw new OperatorError(
      'invalidRequest',
      `${field}.kind must be one of: ${OPERATOR_STEP_KINDS.join(', ')}`,
      `${field}.kind`,
      { received: raw['kind'] === undefined ? 'missing' : typeof raw['kind'], allowed: [...OPERATOR_STEP_KINDS] },
    );
  }
  const kind = raw['kind'];
  rejectUnknownKeys(raw, STEP_FIELDS[kind], field);

  const resourceKey = requireToken(raw['resourceKey'], `${field}.resourceKey`);
  const origin = requireNonEmptyString(raw['origin'], `${field}.origin`, 200);

  switch (kind) {
    case 'account.create':
      return Object.freeze({
        kind,
        resourceKey,
        origin,
        identityId: parseSyntheticIdentityId(raw['identityId'], `${field}.identityId`),
        displayName: requireNonEmptyString(raw['displayName'], `${field}.displayName`, 120),
      });
    case 'account.retire':
    case 'fixture.reset':
    case 'entitlement.revoke':
      return Object.freeze({ kind, resourceKey, origin });
    case 'fixture.seed':
      return Object.freeze({
        kind,
        resourceKey,
        origin,
        identityId: parseSyntheticIdentityId(raw['identityId'], `${field}.identityId`),
        template: requireToken(raw['template'], `${field}.template`),
      });
    case 'entitlement.grant':
      return Object.freeze({
        kind,
        resourceKey,
        origin,
        identityId: parseSyntheticIdentityId(raw['identityId'], `${field}.identityId`),
        entitlement: requireToken(raw['entitlement'], `${field}.entitlement`),
      });
    case 'inbox.read':
      return Object.freeze({
        kind,
        resourceKey,
        origin,
        identityId: parseSyntheticIdentityId(raw['identityId'], `${field}.identityId`),
        folder: requireToken(raw['folder'], `${field}.folder`),
        maxMessages: requireInteger(raw['maxMessages'], `${field}.maxMessages`, 1, MAX_INBOX_MESSAGES),
      });
    case 'billing.sandboxCharge':
    case 'billing.realCharge':
      return Object.freeze({
        kind,
        resourceKey,
        origin,
        identityId: parseSyntheticIdentityId(raw['identityId'], `${field}.identityId`),
        amountUnits: requireFiniteNumber(raw['amountUnits'], `${field}.amountUnits`, 0),
      });
  }
}
