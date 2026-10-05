/**
 * Connector contract for the World Operator (ADR-0011, issue #59).
 *
 * ## What a connector is
 *
 * The preferred mechanism is an explicit customer-provided test-support
 * interface; UI automation is a fallback. Either way, the connector is
 * the only thing in u-sekai that can cause a privileged effect, and this
 * interface is the whole of what it is allowed to be asked to do. There
 * is no generic "send this request" method: the operator hands the
 * connector a *typed step* and the declared authority that permitted it.
 *
 * ## The connector classifies, it does not diagnose
 *
 * `ConnectorOutcome` separates three cases the operator must not
 * conflate:
 *
 * - `ok` — the world resource now exists (or the read returned).
 * - `productRejected` — the **product** refused. A duplicate account, an
 *   unknown plan, a declined sandbox card. This is an observation *of the
 *   product* and is reported through the product-failure branch of the
 *   taxonomy, never as a setup failure.
 * - `connectorFailed` — the setup could not be completed. The product
 *   was not meaningfully exercised, so the run has not evaluated it.
 *
 * A connector cannot report "a UX problem was found": there is no field
 * for one. That is the structural reason a provisioning failure cannot
 * become a product finding.
 *
 * ## Durability
 *
 * `ok` outcomes declare whether they created state that must be
 * released. A read such as `inbox.read` is not durable; an account is.
 * Compensation only walks durable outcomes, so rollback does not try to
 * "undo" a read that never wrote anything.
 */

import { OperatorError } from './errors.js';
import type { OperatorAuthorityRef } from './authority.js';
import type { OperatorLineage, ProvisionRequestId } from './request.js';
import type { OperatorStep, OperatorStepKind } from './steps.js';
import { requireNonEmptyString, requireToken } from './validation.js';
import type { Brand } from '../product/index.js';

/**
 * Opaque handle to a world resource the connector created.
 *
 * Returned by the connector, never minted here — this package contains no
 * id generator. The handle is what cleanup and compensation refer to, so
 * it is validated on the way back in rather than trusted.
 */
export type ResourceHandle = Brand<string, 'ResourceHandle'>;

const HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

export function parseResourceHandle(value: unknown, field = 'handle'): ResourceHandle {
  const raw = requireNonEmptyString(value, field, 256);
  if (!HANDLE_PATTERN.test(raw)) {
    throw new OperatorError(
      'invalidRequest',
      `${field} must be an opaque handle of letters, digits and . _ : @ / -`,
      field,
      { received: raw },
    );
  }
  return raw as ResourceHandle;
}

export interface ConnectorCommand {
  readonly requestId: ProvisionRequestId;
  readonly lineage: OperatorLineage;
  readonly stepIndex: number;
  readonly step: OperatorStep;
  /** The declared authority that permitted this step. */
  readonly authority: OperatorAuthorityRef;
}

export interface ConnectorReleaseCommand {
  readonly requestId: ProvisionRequestId;
  readonly lineage: OperatorLineage;
  readonly handle: ResourceHandle;
  /** The step kind that produced the resource being released. */
  readonly stepKind: OperatorStepKind;
  readonly resourceKey: string;
  readonly authority: OperatorAuthorityRef;
}

export type ConnectorOutcome =
  | {
      readonly status: 'ok';
      readonly handle: ResourceHandle;
      /** Whether the outcome created state that compensation must release. */
      readonly durable: boolean;
      /**
       * Bounded, deterministic description of the result, e.g. a seeded
       * record count. Never a credential or a secret value.
       */
      readonly value: string;
    }
  | {
      readonly status: 'productRejected';
      /** The product's own machine-readable code, e.g. `account_already_exists`. */
      readonly productCode: string;
      readonly message: string;
    }
  | {
      readonly status: 'connectorFailed';
      readonly message: string;
    };

export interface ConnectorReleaseOutcome {
  readonly released: boolean;
  readonly message: string;
}

/**
 * The privileged effect surface.
 *
 * Implemented by `ScriptedProvisioningProvider` in this package and by
 * customer test-support adapters later. A `WorldOperator` holds a
 * connector in an ECMAScript `#private` field and never returns it, so
 * the only way to reach these two methods is through the gate in
 * `operator.ts`.
 */
export interface ProvisioningConnector {
  /** Stable, non-secret connector identity, recorded on every audit record. */
  readonly connectorId: string;
  provision(command: ConnectorCommand): Promise<ConnectorOutcome>;
  release(command: ConnectorReleaseCommand): Promise<ConnectorReleaseOutcome>;
}

/**
 * A connector identity is a token, not a URL and not a credential.
 *
 * Validated centrally so a connector cannot introduce a secret into every
 * audit record simply by naming itself with one.
 */
export function assertConnectorId(value: unknown, field = 'connectorId'): string {
  return requireToken(value, field, 64);
}
