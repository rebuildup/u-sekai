/**
 * The authority gate (ADR-0011, issue #59).
 *
 * ## Where the boundary actually is
 *
 * This module is the boundary. `operator.ts` holds the connector in an
 * ECMAScript `#private` field, so no caller can reach it, and the only
 * path to a privileged effect is `WorldOperator.provision` — which calls
 * `authorizeStep` for every step in the plan **before** it dispatches
 * anything. A denial therefore means zero connector calls, not a call
 * that was made and then undone.
 *
 * The gate is a pure function of `(policy, environmentGrant, step)`. It
 * takes no clock, no connector and no ambient state, so it can be tested
 * exhaustively without constructing an operator, and its verdict cannot
 * depend on anything a second caller could influence.
 *
 * ## The rules, in evaluation order
 *
 * 1. **Environment declared.** An environment absent from the policy has
 *    no authority at all. Granting a step kind grants it *for the
 *    declared environments*, not for every environment a connector knows.
 * 2. **Step granted.** The step kind must appear in `grantedSteps`.
 * 3. **Risk ceiling.** The step's fixed risk class must be at or below
 *    `maxRisk`. Independent of rule 2 — see `policy.ts`.
 * 4. **Destructive opt-in.** A destructive step needs
 *    `destructiveAllowed` on the environment grant.
 * 5. **Production opt-in.** A destructive step on a `production`
 *    environment additionally needs `productionDestructive`, and a real
 *    -money step on production additionally needs
 *    `realMoney.allowProduction`.
 * 6. **Real money opt-in.** `billing.realCharge` needs
 *    `realMoney.mode === 'enabled'`. Because real money is a distinct
 *    step kind rather than a flag, this rule is a property of which
 *    member of the union was constructed, not of a value that could be
 *    set incorrectly.
 * 7. **Origin containment.** The step's origin must be one the
 *    environment grant permits. Crossing a configured origin is one of
 *    the explicitly dangerous classes.
 * 8. **Allow-listed detail.** `fixture.seed` templates and `inbox.read`
 *    folders must appear in the policy's allow-lists. An absent
 *    allow-list denies, because "not configured" and "anything" must not
 *    be the same value.
 *
 * Every rule is a *hard* rejection. There is no warn mode, no
 * downgrading, and no path that returns `permitted` alongside a warning.
 */

import {
  environmentIncludesOrigin,
  parseEnvironment,
  productId,
  type Environment,
  type EnvironmentClass,
} from '../product/index.js';
import type { OperatorSetupFailureKind } from './errors.js';
import { grantOrigins, stepCost, type OperatorAuthorityPolicy, type OperatorEnvironmentGrant } from './policy.js';
import {
  compareRisk,
  operatorStepRisk,
  riskAtLeast,
  type OperatorRiskClass,
  type OperatorStep,
  type OperatorStepKind,
} from './steps.js';

/**
 * The declared authority that permitted an action.
 *
 * Recorded on every connector command and every audit record, because
 * `docs/product/configuration-and-authority.md` requires a privileged
 * action to be attributable to "the configured authority that permitted
 * the action" — without this, an incident review can show *what* happened
 * but not *under whose declared permission*.
 *
 * The `undeclared` / `none` sentinels exist because a denial is also an
 * audit event: when the environment was not declared, or the plan was
 * refused before a step could be identified, there is no grant and no
 * step to name. Recording the sentinel says exactly that, rather than
 * leaving the field out and making the reader guess.
 */
export interface OperatorAuthorityRef {
  readonly policyId: string;
  readonly environmentId: string;
  readonly environmentClass: EnvironmentClass | 'undeclared';
  /** The step kind that was authorised, or `none` when the plan was refused first. */
  readonly stepKind: OperatorStepKind | 'none';
  readonly risk: OperatorRiskClass;
  /** The policy's declared ceiling at the time of the decision. */
  readonly maxRisk: OperatorRiskClass;
  /** Whether the policy permitted real money, independent of this step. */
  readonly realMoney: 'denied' | 'enabled';
  /** Units this step costs under the policy. 0 when no step was evaluated. */
  readonly units: number;
}

/**
 * Authority reference for a refusal, including a refusal that happened
 * before any environment grant or step could be resolved.
 *
 * This is the only way an undeclared environment is ever recorded: it
 * says the policy existed and named no authority, which is a materially
 * different fact from "the environment was unknown to u-sekai".
 */
export function denialAuthorityRef(
  policy: OperatorAuthorityPolicy,
  environmentId: string,
  stepKind: OperatorStepKind | null,
): OperatorAuthorityRef {
  return Object.freeze({
    policyId: policy.policyId,
    environmentId,
    environmentClass: 'undeclared' as const,
    stepKind: stepKind ?? ('none' as const),
    risk: stepKind === null ? ('sandbox' as const) : operatorStepRisk(stepKind),
    maxRisk: policy.maxRisk,
    realMoney: policy.realMoney.mode,
    units: 0,
  });
}

export type AuthorityDecision =
  | { readonly permitted: true; readonly ref: OperatorAuthorityRef }
  | {
      readonly permitted: false;
      readonly failureKind: Extract<OperatorSetupFailureKind, 'authorityDenied' | 'riskNotPermitted'>;
      readonly message: string;
      readonly detail: Readonly<Record<string, unknown>>;
    };

/** Look up an environment grant, or `undefined` when the environment has no declared authority. */
export function findEnvironmentGrant(
  policy: OperatorAuthorityPolicy,
  environmentId: string,
): OperatorEnvironmentGrant | undefined {
  return policy.environments.find((grant) => grant.environmentId === environmentId);
}

/**
 * Decide whether one step may be dispatched, without dispatching it.
 *
 * Pure: the same policy, grant and step always produce the same verdict,
 * and nothing outside its arguments can influence the result.
 */
export function authorizeStep(
  policy: OperatorAuthorityPolicy,
  grant: OperatorEnvironmentGrant,
  step: OperatorStep,
): AuthorityDecision {
  const risk = operatorStepRisk(step.kind);

  // Rule 2 — explicit opt-in.
  if (!policy.grantedSteps.includes(step.kind)) {
    return denied(
      'authorityDenied',
      `step "${step.kind}" is not granted by policy "${policy.policyId}"`,
      { stepKind: step.kind, grantedSteps: [...policy.grantedSteps] },
    );
  }

  // Rule 3 — risk ceiling, independent of rule 2.
  if (compareRisk(risk, policy.maxRisk) > 0) {
    return denied(
      'riskNotPermitted',
      `step "${step.kind}" has risk "${risk}", above policy "${policy.policyId}" ceiling "${policy.maxRisk}"`,
      { stepKind: step.kind, risk, maxRisk: policy.maxRisk },
    );
  }

  // Rule 4 — destructive steps need an explicit environment opt-in.
  if (riskAtLeast(risk, 'destructive') && !grant.destructiveAllowed) {
    return denied(
      'authorityDenied',
      `step "${step.kind}" is destructive and environment "${grant.environmentId}" does not allow destructive steps`,
      { stepKind: step.kind, environmentId: grant.environmentId, risk },
    );
  }

  // Rule 5 — destructive in production needs a second, separate key.
  if (
    riskAtLeast(risk, 'destructive') &&
    grant.environmentClass === 'production' &&
    !grant.productionDestructive
  ) {
    return denied(
      'authorityDenied',
      `step "${step.kind}" is destructive in production and environment "${grant.environmentId}" does not allow it`,
      { stepKind: step.kind, environmentId: grant.environmentId, environmentClass: 'production' },
    );
  }

  // Rule 6 — real money.
  if (risk === 'external' && policy.realMoney.mode !== 'enabled') {
    return denied(
      'authorityDenied',
      `step "${step.kind}" requires realMoney.mode "enabled"; policy "${policy.policyId}" declares it denied`,
      { stepKind: step.kind, realMoney: policy.realMoney.mode },
    );
  }
  if (
    risk === 'external' &&
    policy.realMoney.mode === 'enabled' &&
    grant.environmentClass === 'production' &&
    !policy.realMoney.allowProduction
  ) {
    return denied(
      'authorityDenied',
      `step "${step.kind}" would spend real money in production, which policy "${policy.policyId}" does not allow`,
      { stepKind: step.kind, environmentClass: 'production' },
    );
  }

  // Rule 7 — origin containment.
  if (!environmentAllowsOrigin(grant, step.origin)) {
    return denied(
      'authorityDenied',
      `step "${step.kind}" targets origin outside environment "${grant.environmentId}"`,
      { stepKind: step.kind, origin: step.origin, allowedOrigins: [...grantOrigins(grant)] },
    );
  }

  // Rule 8 — allow-listed detail.
  if (step.kind === 'fixture.seed') {
    if (policy.allowedSeedTemplates === undefined || !policy.allowedSeedTemplates.includes(step.template)) {
      return denied(
        'authorityDenied',
        `seed template "${step.template}" is not permitted by policy "${policy.policyId}"`,
        { stepKind: step.kind, template: step.template, allowed: [...(policy.allowedSeedTemplates ?? [])] },
      );
    }
  }
  if (step.kind === 'inbox.read') {
    if (policy.allowedInboxFolders === undefined || !policy.allowedInboxFolders.includes(step.folder)) {
      return denied(
        'authorityDenied',
        `inbox folder "${step.folder}" is not permitted by policy "${policy.policyId}"`,
        { stepKind: step.kind, folder: step.folder, allowed: [...(policy.allowedInboxFolders ?? [])] },
      );
    }
  }

  return {
    permitted: true,
    ref: Object.freeze({
      policyId: policy.policyId,
      environmentId: grant.environmentId,
      environmentClass: grant.environmentClass,
      stepKind: step.kind,
      risk,
      maxRisk: policy.maxRisk,
      realMoney: policy.realMoney.mode,
      units: stepCost(policy, step.kind),
    }),
  };
}

/**
 * Product id for the throwaway `Environment` built only to reuse #57's
 * origin canonicalisation. It names no real product and is never
 * persisted, exported or sent anywhere; `parseEnvironment` requires a
 * product id, and the check only reads the endpoint.
 */
const AUTHORITY_PROBE_PRODUCT_ID = productId('prd-authority-probe');

/**
 * Whether an origin is one the environment grant permits.
 *
 * Builds a real `Environment` from the grant and reuses #57's
 * `environmentIncludesOrigin`, so the operator cannot drift from the
 * durable model's canonicalisation. The synthetic `Environment` is a
 * local construction from already-validated grant data; it is never
 * exposed and never reaches a connector.
 */
function environmentAllowsOrigin(grant: OperatorEnvironmentGrant, origin: string): boolean {
  const environment: Environment = parseEnvironment({
    id: grant.environmentId,
    productId: AUTHORITY_PROBE_PRODUCT_ID,
    name: 'authority-probe',
    environmentClass: grant.environmentClass,
    deploymentKind: 'continuous',
    endpoint: {
      baseUrl: grant.baseUrl,
      additionalOrigins: grant.additionalOrigins,
    },
  });
  return environmentIncludesOrigin(environment, origin);
}

function denied(
  failureKind: Extract<OperatorSetupFailureKind, 'authorityDenied' | 'riskNotPermitted'>,
  message: string,
  detail: Record<string, unknown>,
): AuthorityDecision {
  return { permitted: false, failureKind, message, detail: Object.freeze(detail) };
}
