/**
 * Deterministic in-memory provisioning provider (issue #59).
 *
 * ## Why the first ticket ships its own connector
 *
 * The issue requires "a deterministic in-memory/scripted provider for
 * tests", and a real Stripe integration is explicitly out of scope for
 * this ticket. A scripted provider is also what makes the authority
 * boundary *testable at all*: without a connector whose every call can be
 * counted, "a denial dispatched nothing" is an assertion about nothing.
 *
 * ## Determinism
 *
 * Handles are derived from `(connectorId, requestId, resourceKey)` and
 * nothing else. The provider reads no clock, no random source, no
 * environment variable and no network. Two runs of the same plan produce
 * identical handles, identical values and identical call counts, so an
 * idempotency test asserts a property rather than a coincidence.
 *
 * ## Scripting failures
 *
 * Failure modes are declared up front by `resourceKey` or `stepKind`:
 *
 * - `failProvision` — the connector cannot complete the setup.
 * - `rejectProduct` — the **product** refuses. This is the only way to
 *   produce a `productRejected` outcome, and it exists so the taxonomy's
 *   product branch is exercised by a real dispatch rather than a
 *   hand-built failure object.
 * - `failRelease` — compensation fails, which is the orphaned-state case.
 *
 * ## State
 *
 * `liveResourceKeys` is the connector's own view of what it created, not
 * the operator's bookkeeping. The orphan-freedom test asserts against
 * this, so a bug that loses track of a resource on the operator side but
 * still released it cannot pass, and neither can one that "released" a
 * resource the connector never dropped.
 */

import type {
  ConnectorCommand,
  ConnectorOutcome,
  ConnectorReleaseCommand,
  ConnectorReleaseOutcome,
  ProvisioningConnector,
  ResourceHandle,
} from './connector.js';
import type { OperatorStepKind } from './steps.js';

type FailureScript = ReadonlyMap<string, string>;
type RejectScript = ReadonlyMap<string, string>;

export interface ScriptedProviderOptions {
  readonly connectorId?: string;
  /** `resourceKey` or `stepKind` -> connector failure message. */
  readonly failProvision?: FailureScript;
  /** `resourceKey` or `stepKind` -> product rejection code. */
  readonly rejectProduct?: RejectScript;
  /** `resourceKey` or `stepKind` -> compensation failure message. */
  readonly failRelease?: FailureScript;
  /** Seed records per seeded fixture. Deterministic. 0..1000. */
  readonly recordsPerSeed?: number;
}

export class ScriptedProvisioningProvider implements ProvisioningConnector {
  readonly connectorId: string;
  readonly #failProvision: FailureScript;
  readonly #rejectProduct: RejectScript;
  readonly #failRelease: FailureScript;
  readonly #recordsPerSeed: number;
  readonly #live = new Map<string, { readonly stepKind: OperatorStepKind; readonly resourceKey: string }>();
  #provisionCalls = 0;
  #releaseCalls = 0;

  constructor(options: ScriptedProviderOptions = {}) {
    this.connectorId = options.connectorId ?? 'scripted';
    this.#failProvision = options.failProvision ?? new Map();
    this.#rejectProduct = options.rejectProduct ?? new Map();
    this.#failRelease = options.failRelease ?? new Map();
    this.#recordsPerSeed = options.recordsPerSeed ?? 3;
  }

  /** How many times `provision` was called. The "no dispatch on denial" assertion. */
  get provisionCalls(): number {
    return this.#provisionCalls;
  }

  /** How many times `release` was called. */
  get releaseCalls(): number {
    return this.#releaseCalls;
  }

  /** Resources the connector still holds, sorted. */
  liveResourceKeys(): ReadonlyArray<string> {
    return Object.freeze([...this.#live.keys()].sort());
  }

  async provision(command: ConnectorCommand): Promise<ConnectorOutcome> {
    this.#provisionCalls += 1;
    const { step } = command;

    const rejection = this.#rejectProduct.get(step.resourceKey) ?? this.#rejectProduct.get(step.kind);
    if (rejection !== undefined) {
      return Object.freeze({
        status: 'productRejected' as const,
        productCode: rejection,
        message: `product rejected "${step.kind}" with code ${rejection}`,
      });
    }

    const failure = this.#failProvision.get(step.resourceKey) ?? this.#failProvision.get(step.kind);
    if (failure !== undefined) {
      return Object.freeze({ status: 'connectorFailed' as const, message: failure });
    }

    const handle = this.#handleFor(command, step.resourceKey);

    // A read creates no state, so it declares itself non-durable and
    // compensation will not attempt to undo it.
    if (step.kind === 'inbox.read') {
      return Object.freeze({
        status: 'ok' as const,
        handle,
        durable: false,
        value: `inbox:${step.folder}:${step.maxMessages}`,
      });
    }

    this.#live.set(step.resourceKey, { stepKind: step.kind, resourceKey: step.resourceKey });
    return Object.freeze({
      status: 'ok' as const,
      handle,
      durable: true,
      value: valueFor(step.kind, step.resourceKey, this.#recordsPerSeed),
    });
  }

  async release(command: ConnectorReleaseCommand): Promise<ConnectorReleaseOutcome> {
    this.#releaseCalls += 1;
    const failure = this.#failRelease.get(command.resourceKey) ?? this.#failRelease.get(command.stepKind);
    if (failure !== undefined) {
      return Object.freeze({ released: false, message: failure });
    }
    const existed = this.#live.delete(command.resourceKey);
    return Object.freeze({
      released: existed,
      message: existed ? `released ${command.resourceKey}` : `${command.resourceKey} was not live`,
    });
  }

  #handleFor(command: ConnectorCommand, resourceKey: string): ResourceHandle {
    return `${this.connectorId}:${command.requestId}:${resourceKey}` as ResourceHandle;
  }
}

function valueFor(kind: OperatorStepKind, resourceKey: string, recordsPerSeed: number): string {
  switch (kind) {
    case 'account.create':
      return `account:${resourceKey}`;
    case 'account.retire':
      return `retired:${resourceKey}`;
    case 'fixture.seed':
      return `seeded:${resourceKey}:${recordsPerSeed}`;
    case 'fixture.reset':
      return `reset:${resourceKey}`;
    case 'entitlement.grant':
      return `entitled:${resourceKey}`;
    case 'entitlement.revoke':
      return `revoked:${resourceKey}`;
    case 'billing.sandboxCharge':
      return `sandbox-charge:${resourceKey}`;
    case 'billing.realCharge':
      return `real-charge:${resourceKey}`;
    case 'inbox.read':
      return `inbox:${resourceKey}`;
  }
}

/** Build a `Map` from a plain object, for readable test declarations. */
export function script(entries: Readonly<Record<string, string>>): Map<string, string> {
  return new Map(Object.entries(entries));
}
