/**
 * The World Operator — the privileged setup boundary (ADR-0011, issue #59).
 *
 * ## What "authority boundary" means here
 *
 * ADR-0011 requires that "Synthetic Participants must not receive
 * privileged setup powers merely because the service needs them", and
 * that a separate World Operator "may receive narrowly scoped
 * capabilities for setup and cleanup". This class is that separate
 * boundary, and it is separated three ways:
 *
 * 1. **The connector is unreachable from outside.** It is held in an
 *    ECMAScript `#private` field (`#connector`). `#` fields are not
 *    enumerable, are not returned by `Object.getOwnPropertyNames`, and
 *    have no reflection API, so no caller can reach the privileged
 *    effect surface without going through `provision` / `cleanup`. The
 *    concrete class is not exported; callers receive the narrow
 *    `WorldOperator` interface.
 * 2. **Every plan is authorised in full before anything is dispatched.**
 *    `authorizeStep` runs for every step up front. A denial therefore
 *    means *zero* connector calls, not a call that was made and undone.
 * 3. **No ambient authority.** The policy, the connector and the clock
 *    are all constructor arguments. This module reads no environment
 *    variable, no working directory, no module-level mutable state and
 *    no system clock, so neither a test nor a second caller can widen
 *    what the operator is permitted to do by influencing global state.
 *
 * ## Idempotency
 *
 * A plan carries a caller-declared `requestId`. Re-issuing the same plan
 * under the same id returns the recorded result and dispatches nothing.
 * Re-using an id with a *different* plan is refused rather than replayed,
 * because returning the first result would let a caller believe a second
 * plan had been applied.
 *
 * ## Compensation
 *
 * A plan is applied in order. On failure the operator releases what it
 * applied, in reverse order, before returning. If any release fails the
 * result is `rollbackFailed` and names the orphaned keys — the one
 * condition in the taxonomy that can leave state behind, so it is never
 * collapsed into the failure that caused it.
 *
 * ## Outcomes are returned, not thrown
 *
 * Denials, budget exhaustion and connector or product failures are
 * return values. Even a malformed request is reported as a `rejected`
 * result rather than an exception. Throwing would let a caller swallow a
 * denial as an ordinary error, which is how an authority boundary
 * quietly stops being one.
 */

import {
  authorizeStep,
  denialAuthorityRef,
  findEnvironmentGrant,
  type OperatorAuthorityRef,
} from './authority.js';
import {
  parseResourceHandle,
  type ConnectorOutcome,
  type ProvisioningConnector,
  type ResourceHandle,
} from './connector.js';
import { OperatorError, type OperatorProductFailure, type OperatorSetupFailure } from './errors.js';
import type { OperatorAuditRecord } from './evidence.js';
import { parseOperatorAuthorityPolicy, type OperatorAuthorityPolicy } from './policy.js';
import {
  lineageProgramKey,
  parseOperatorLineage,
  parseProvisionRequest,
  parseProvisionRequestId,
  requestDigest,
  requestJournalKey,
  type OperatorLineage,
  type ProvisionRequest,
  type ProvisionRequestId,
} from './request.js';
import { stepProducesResource, type OperatorStep, type OperatorStepKind } from './steps.js';
import { rejectUnknownKeys, requireRecord } from './validation.js';

/**
 * Injected time source.
 *
 * There is deliberately no default and no system-clock implementation in
 * this package: a budget window that reads the ambient clock is a budget
 * a test cannot pin, and a determinism guarantee nobody can check.
 */
export interface OperatorClock {
  /** ISO-8601 instant with an explicit UTC offset. */
  now(): string;
}

export interface WorldOperator {
  /** Identity of the policy this operator enforces. */
  readonly policyId: string;
  /**
   * Apply a provisioning plan.
   *
   * Accepts `unknown` and parses internally, so a caller cannot skip
   * validation by constructing the request some other way.
   */
  provision(request: unknown, field?: string): Promise<OperatorResult>;
  /** Release every resource this operator applied for one request id. */
  cleanup(request: unknown, field?: string): Promise<OperatorCleanupResult>;
  /** Frozen copy of the setup audit log, oldest first. */
  audit(): ReadonlyArray<OperatorAuditRecord>;
  /** Live resource keys this operator still holds, per journal key. */
  liveResourceKeys(): ReadonlyArray<string>;
}

/** Everything needed to build a setup failure, gathered before it is frozen. */
interface SetupFailureInit {
  readonly ts: string;
  readonly failureKind: OperatorSetupFailure['failureKind'];
  readonly where: string;
  readonly message: string;
  readonly stepIndex: number;
  readonly stepKind: OperatorStepKind | null;
  readonly resourceKey: string | null;
  readonly rolledBack: boolean;
  readonly orphanedResourceKeys: ReadonlyArray<string>;
  readonly detail: Record<string, unknown>;
}

export interface OperatorProvisionedResult {
  readonly status: 'provisioned';
  readonly ts: string;
  readonly requestId: ProvisionRequestId;
  readonly lineage: OperatorLineage;
  /** Authority of the first step; every step is authorised and recorded individually. */
  readonly authority: OperatorAuthorityRef;
  readonly connectorId: string;
  readonly resourceKeys: ReadonlyArray<string>;
  readonly dispatchedSteps: number;
  readonly spendUnits: number;
  /** True when returned from the journal without dispatching anything. */
  readonly replayed: boolean;
}

/**
 * The request was understood and refused before anything was dispatched.
 *
 * Covers every refusal of a well-formed plan: the step or environment is
 * outside declared authority, its risk exceeds the ceiling, the budget
 * cannot cover it, or the `requestId` was already used for a different
 * plan. The common invariant is `dispatchedSteps: 0` — none of these
 * reached a connector.
 */
export interface OperatorDeniedResult {
  readonly status: 'denied';
  readonly ts: string;
  readonly requestId: ProvisionRequestId;
  readonly lineage: OperatorLineage;
  readonly authority: OperatorAuthorityRef;
  readonly failure: OperatorSetupFailure;
  /** Always 0: a denial is decided before dispatch. */
  readonly dispatchedSteps: 0;
}

export interface OperatorFailedResult {
  readonly status: 'failed';
  readonly ts: string;
  readonly requestId: ProvisionRequestId;
  readonly lineage: OperatorLineage;
  readonly authority: OperatorAuthorityRef;
  readonly failure: OperatorSetupFailure | OperatorProductFailure;
  readonly dispatchedSteps: number;
  readonly spendUnits: number;
  readonly appliedResourceKeys: ReadonlyArray<string>;
  readonly releasedResourceKeys: ReadonlyArray<string>;
  /** Non-empty only when compensation could not release everything. */
  readonly orphanedResourceKeys: ReadonlyArray<string>;
}

/** The request was not a well-formed provisioning plan. Nothing was attempted. */
export interface OperatorRejectedRequestResult {
  readonly status: 'rejected';
  readonly ts: string;
  readonly failure: OperatorSetupFailure;
  readonly dispatchedSteps: 0;
}

export type OperatorResult =
  | OperatorProvisionedResult
  | OperatorDeniedResult
  | OperatorFailedResult
  | OperatorRejectedRequestResult;

/**
 * The result branches that carry a classified failure.
 *
 * Named so a caller can write `function handle(r: OperatorFailureResult)`
 * and have the compiler route it into `projectOperatorFailure` without
 * first checking for `provisioned`.
 */
export type OperatorFailureResult = OperatorDeniedResult | OperatorFailedResult;

export type OperatorCleanupResult =
  | {
      readonly status: 'cleaned';
      readonly ts: string;
      readonly requestId: ProvisionRequestId;
      readonly lineage: OperatorLineage;
      readonly authority: OperatorAuthorityRef;
      readonly releasedResourceKeys: ReadonlyArray<string>;
      readonly unresolvedResourceKeys: readonly [];
      readonly dispatchedSteps: 0;
    }
  | {
      readonly status: 'partiallyCleaned';
      readonly ts: string;
      readonly requestId: ProvisionRequestId;
      readonly lineage: OperatorLineage;
      readonly authority: OperatorAuthorityRef;
      readonly releasedResourceKeys: ReadonlyArray<string>;
      /** The world still holds state this operator created. */
      readonly unresolvedResourceKeys: ReadonlyArray<string>;
      /** Always `rollbackFailed`; this is the orphaned-state condition. */
      readonly failure: OperatorSetupFailure;
      readonly dispatchedSteps: number;
    }
  | {
      readonly status: 'denied';
      readonly ts: string;
      readonly requestId: ProvisionRequestId;
      readonly lineage: OperatorLineage;
      readonly authority: OperatorAuthorityRef;
      readonly failure: OperatorSetupFailure;
      readonly dispatchedSteps: 0;
    }
  | {
      readonly status: 'rejected';
      readonly ts: string;
      readonly failure: OperatorSetupFailure;
      readonly dispatchedSteps: 0;
    };

interface AppliedResource {
  readonly stepIndex: number;
  readonly stepKind: OperatorStepKind;
  readonly resourceKey: string;
  readonly handle: ResourceHandle;
  readonly authority: OperatorAuthorityRef;
}

interface JournalEntry {
  readonly digest: string;
  readonly result: OperatorProvisionedResult;
}

interface BudgetState {
  day: string;
  steps: number;
  units: number;
  realMoneyUnits: number;
}

interface Compensation {
  readonly released: ReadonlyArray<string>;
  readonly orphaned: ReadonlyArray<string>;
}

export interface CreateWorldOperatorOptions {
  /** Parsed here via `parseOperatorAuthorityPolicy`; an invalid policy is refused. */
  readonly policy: unknown;
  /** Held privately; never returned, exposed or reachable. */
  readonly connector: ProvisioningConnector;
  readonly clock: OperatorClock;
}

export function createWorldOperator(options: CreateWorldOperatorOptions): WorldOperator {
  // No default policy exists. "Authority not configured" resolves to
  // "no operator can be constructed", so deny-by-default is a property
  // of the construction path rather than of a value a later edit could
  // relax.
  const policy = parseOperatorAuthorityPolicy(options.policy);
  return new GatedWorldOperator(policy, options.connector, options.clock);
}

class GatedWorldOperator implements WorldOperator {
  readonly #policy: OperatorAuthorityPolicy;
  readonly #connector: ProvisioningConnector;
  readonly #clock: OperatorClock;
  readonly #audit: OperatorAuditRecord[] = [];
  readonly #journal = new Map<string, JournalEntry>();
  readonly #live = new Map<string, ReadonlyArray<AppliedResource>>();
  #budget: BudgetState = { day: '', steps: 0, units: 0, realMoneyUnits: 0 };

  constructor(policy: OperatorAuthorityPolicy, connector: ProvisioningConnector, clock: OperatorClock) {
    this.#policy = policy;
    this.#connector = connector;
    this.#clock = clock;
  }

  get policyId(): string {
    return this.#policy.policyId;
  }

  audit(): ReadonlyArray<OperatorAuditRecord> {
    return Object.freeze([...this.#audit]);
  }

  liveResourceKeys(): ReadonlyArray<string> {
    return Object.freeze([...this.#live.values()].flatMap((entries) => entries.map((e) => e.resourceKey)));
  }

  async provision(request: unknown, field = 'provisionRequest'): Promise<OperatorResult> {
    const ts = this.#now();
    const where = 'operator.provision';

    let parsed: ProvisionRequest;
    try {
      parsed = parseProvisionRequest(request, field);
    } catch (error) {
      return rejectedResult(ts, error, where);
    }

    const { requestId, lineage, steps } = parsed;
    const journalKey = requestJournalKey(lineage.environmentId, requestId);
    const digest = requestDigest(parsed);

    // --- Idempotency, before authorisation: a retry must be free. ---
    const existing = this.#journal.get(journalKey);
    if (existing !== undefined) {
      if (existing.digest !== digest) {
        return this.#deny(ts, requestId, lineage, {
          ts,
          failureKind: 'invalidRequest',
          where,
          message: `requestId "${requestId}" was already used in environment "${lineage.environmentId}" for a different plan`,
          stepIndex: -1,
          stepKind: null,
          resourceKey: null,
          rolledBack: true,
          orphanedResourceKeys: [],
          detail: { journalKey, existingDigest: existing.digest, submittedDigest: digest },
        });
      }
      this.#audit.push({
        kind: 'planReplayed',
        ts,
        requestId,
        lineage,
        programScope: lineageProgramKey(lineage),
        authority: existing.result.authority,
        connectorId: this.#connector.connectorId,
        requestDigest: digest,
        resourceKeys: existing.result.resourceKeys,
      });
      // The world was set up at `existing.result.ts`; this run is
      // observing that it already happened, so the returned result is
      // attributed to the *calling* run while keeping the original
      // application instant. Attributing it to the original run would
      // make a retry look like it happened in a run that never issued it.
      return Object.freeze({ ...existing.result, lineage, replayed: true });
    }

    // --- Rule 1: the environment must have declared authority at all. ---
    const grant = findEnvironmentGrant(this.#policy, lineage.environmentId);
    if (grant === undefined) {
      return this.#deny(ts, requestId, lineage, {
        ts,
        failureKind: 'authorityDenied',
        where,
        message: `environment "${lineage.environmentId}" is not declared in policy "${this.#policy.policyId}"`,
        stepIndex: -1,
        stepKind: null,
        resourceKey: null,
        rolledBack: true,
        orphanedResourceKeys: [],
        detail: { policyId: this.#policy.policyId, environmentId: lineage.environmentId },
      });
    }

    // --- Rules 2..8, for the whole plan, before any dispatch. ---
    const decisions: OperatorAuthorityRef[] = [];
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i]!;
      const decision = authorizeStep(this.#policy, grant, step);
      if (!decision.permitted) {
        return this.#deny(ts, requestId, lineage, {
          ts,
          failureKind: decision.failureKind,
          where: `${where}.steps[${i}]`,
          message: decision.message,
          stepIndex: i,
          stepKind: step.kind,
          resourceKey: step.resourceKey,
          rolledBack: true,
          orphanedResourceKeys: [],
          detail: { ...decision.detail },
        });
      }
      decisions.push(decision.ref);
    }
    const firstRef = decisions[0]!;

    // --- Budget, for the whole plan, before any dispatch. ---
    const budgetDenial = this.#checkBudget(ts, steps, decisions, where);
    if (budgetDenial !== null) {
      return this.#deny(ts, requestId, lineage, budgetDenial);
    }

    // --- Dispatch. ---
    const applied: AppliedResource[] = [];
    const liveKeys: string[] = [];
    let dispatchedSteps = 0;
    let dispatchedUnits = 0;
    let dispatchedRealMoneyUnits = 0;

    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i]!;
      const ref = decisions[i]!;
      // Sequential by necessity: the plan is an ordered sequence and the
      // compensation that follows a failure depends on exactly which
      // steps were applied and in what order. There is nothing here to
      // parallelise.
      const outcome = await this.#dispatch(i, step, ref, requestId, lineage);
      dispatchedSteps += 1;
      dispatchedUnits += ref.units;
      if (step.kind === 'billing.realCharge') dispatchedRealMoneyUnits += step.amountUnits;

      if (outcome.status === 'ok') {
        // Already validated by #dispatch; a read never wrote anything,
        // so only durable outcomes create rollback state.
        const handle = outcome.handle;
        if (stepProducesResource(step) && outcome.durable) {
          applied.push({
            stepIndex: i,
            stepKind: step.kind,
            resourceKey: step.resourceKey,
            handle,
            authority: ref,
          });
          liveKeys.push(step.resourceKey);
        }
        continue;
      }

      const compensation = await this.#compensate(applied, requestId, lineage);
      this.#chargeBudget(dispatchedSteps, dispatchedUnits, dispatchedRealMoneyUnits);

      const failure: OperatorSetupFailure | OperatorProductFailure =
        outcome.status === 'productRejected'
          ? productFailure(ts, `${where}.steps[${i}]`, outcome, i, step)
          : setupFailure(
              compensation.orphaned.length > 0
                ? {
                    ts,
                    failureKind: 'rollbackFailed',
                    where: `${where}.steps[${i}]`,
                    message: `compensation after "${outcome.message}" could not release: ${compensation.orphaned.join(', ')}`,
                    stepIndex: i,
                    stepKind: step.kind,
                    resourceKey: step.resourceKey,
                    rolledBack: false,
                    orphanedResourceKeys: compensation.orphaned,
                    detail: { causedBy: 'connectorFailed' },
                  }
                : {
                    ts,
                    failureKind: 'connectorFailed',
                    where: `${where}.steps[${i}]`,
                    message: outcome.message,
                    stepIndex: i,
                    stepKind: step.kind,
                    resourceKey: step.resourceKey,
                    rolledBack: true,
                    orphanedResourceKeys: [],
                    detail: {},
                  },
            );

      this.#audit.push({
        kind: 'planFailed',
        ts,
        requestId,
        lineage,
        programScope: lineageProgramKey(lineage),
        authority: ref,
        connectorId: this.#connector.connectorId,
        failure,
        appliedResourceKeys: Object.freeze(applied.map((a) => a.resourceKey)),
        releasedResourceKeys: compensation.released,
      });
      return Object.freeze({
        status: 'failed' as const,
        ts,
        requestId,
        lineage,
        authority: ref,
        failure,
        dispatchedSteps,
        spendUnits: dispatchedUnits,
        appliedResourceKeys: Object.freeze(applied.map((a) => a.resourceKey)),
        releasedResourceKeys: compensation.released,
        orphanedResourceKeys: compensation.orphaned,
      });
    }

    this.#chargeBudget(dispatchedSteps, dispatchedUnits, dispatchedRealMoneyUnits);
    const result: OperatorProvisionedResult = Object.freeze({
      status: 'provisioned',
      ts,
      requestId,
      lineage,
      authority: firstRef,
      connectorId: this.#connector.connectorId,
      resourceKeys: Object.freeze(liveKeys),
      dispatchedSteps,
      spendUnits: dispatchedUnits,
      replayed: false,
    });
    this.#journal.set(journalKey, { digest, result });
    this.#live.set(journalKey, Object.freeze([...applied]));
    this.#audit.push({
      kind: 'planProvisioned',
      ts,
      requestId,
      lineage,
      programScope: lineageProgramKey(lineage),
      authority: firstRef,
      connectorId: this.#connector.connectorId,
      resourceKeys: result.resourceKeys,
      dispatchedSteps,
      spendUnits: dispatchedUnits,
    });
    return result;
  }

  async cleanup(request: unknown, field = 'cleanupRequest'): Promise<OperatorCleanupResult> {
    const ts = this.#now();
    const where = 'operator.cleanup';

    let requestId: ProvisionRequestId;
    let lineage: OperatorLineage;
    try {
      const raw = requireRecord(request, field);
      rejectUnknownKeys(raw, ['requestId', 'lineage'], field);
      requestId = parseProvisionRequestId(raw['requestId'], `${field}.requestId`);
      lineage = parseOperatorLineage(raw['lineage'], `${field}.lineage`);
    } catch (error) {
      return rejectedCleanupResult(ts, error, where);
    }

    const grant = findEnvironmentGrant(this.#policy, lineage.environmentId);
    if (grant === undefined) {
      return this.#denyCleanup(
        ts,
        requestId,
        lineage,
        {
          ts,
          failureKind: 'authorityDenied',
          where,
          message: `environment "${lineage.environmentId}" is not declared in policy "${this.#policy.policyId}"`,
          stepIndex: -1,
          stepKind: null,
          resourceKey: null,
          rolledBack: false,
          orphanedResourceKeys: [],
          detail: { policyId: this.#policy.policyId, environmentId: lineage.environmentId },
        },
      );
    }

    // Cleanup releases resources, so it is destructive and passes through
    // the same gate as a destructive step. A separate ungated "admin"
    // entry point would be exactly the second path around the boundary
    // this ticket exists to close.
    const probe = CLEANUP_PROBE(grant.baseUrl);
    const decision = authorizeStep(this.#policy, grant, probe);
    if (!decision.permitted) {
      return this.#denyCleanup(ts, requestId, lineage, {
        ts,
        failureKind: decision.failureKind,
        where,
        message: decision.message,
        stepIndex: -1,
        stepKind: probe.kind,
        resourceKey: probe.resourceKey,
        rolledBack: false,
        orphanedResourceKeys: [],
        detail: { ...decision.detail },
      });
    }

    const journalKey = requestJournalKey(lineage.environmentId, requestId);
    const applied = this.#live.get(journalKey) ?? [];
    const compensation = await this.#compensate(applied, requestId, lineage);
    const authority = decision.ref;

    this.#audit.push({
      kind: 'cleanupCompleted',
      ts,
      requestId,
      lineage,
      programScope: lineageProgramKey(lineage),
      authority,
      connectorId: this.#connector.connectorId,
      releasedResourceKeys: compensation.released,
      unresolvedResourceKeys: compensation.orphaned,
    });

    if (compensation.orphaned.length === 0) {
      this.#live.delete(journalKey);
      this.#journal.delete(journalKey);
      return Object.freeze({
        status: 'cleaned' as const,
        ts,
        requestId,
        lineage,
        authority,
        releasedResourceKeys: compensation.released,
        unresolvedResourceKeys: Object.freeze([]) as readonly [],
        dispatchedSteps: 0 as const,
      });
    }

    return Object.freeze({
      status: 'partiallyCleaned' as const,
      ts,
      requestId,
      lineage,
      authority,
      releasedResourceKeys: compensation.released,
      unresolvedResourceKeys: compensation.orphaned,
      failure: setupFailure({
        ts,
        failureKind: 'rollbackFailed',
        where,
        message: `cleanup could not release: ${compensation.orphaned.join(', ')}`,
        stepIndex: -1,
        stepKind: null,
        resourceKey: null,
        rolledBack: false,
        orphanedResourceKeys: compensation.orphaned,
        detail: {},
      }),
      dispatchedSteps: applied.length,
    });
  }

  // ------------------------------------------------------------- internals

  #now(): string {
    return this.#clock.now();
  }

  /**
   * Run one step against the connector, converting every way it can fail
   * into a classified outcome.
   *
   * A connector is third-party code: it may throw, or it may return a
   * handle that is not a handle. Neither may escape as an exception,
   * because `provision` returning a value rather than throwing is what
   * makes a denial impossible to swallow as an ordinary error. A handle
   * that does not parse is a *setup* failure, not a crash.
   */
  async #dispatch(
    stepIndex: number,
    step: OperatorStep,
    ref: OperatorAuthorityRef,
    requestId: ProvisionRequestId,
    lineage: OperatorLineage,
  ): Promise<ConnectorOutcome> {
    let outcome: ConnectorOutcome;
    try {
      outcome = await this.#connector.provision({
        requestId,
        lineage,
        stepIndex,
        step,
        authority: ref,
      });
    } catch (error) {
      return { status: 'connectorFailed', message: describeThrown(error) };
    }
    if (outcome.status === 'ok') {
      try {
        parseResourceHandle(outcome.handle, `connector.outcome.handle[${stepIndex}]`);
      } catch (error) {
        return {
          status: 'connectorFailed',
          message: `connector returned an unusable handle: ${
            error instanceof OperatorError ? error.message : describeThrown(error)
          }`,
        };
      }
    }
    return outcome;
  }

  /**
   * Release applied resources in reverse application order.
   *
   * `released` and `orphaned` are reported in *release* order, which is
   * the reverse of `appliedResourceKeys`. That pairing is the useful one:
   * "applied A, B, C; released C, B, A" says what happened, whereas
   * re-sorting the released list back into application order would hide
   * the very ordering that made the compensation safe.
   */
  async #compensate(
    applied: ReadonlyArray<AppliedResource>,
    requestId: ProvisionRequestId,
    lineage: OperatorLineage,
  ): Promise<Compensation> {
    const released: string[] = [];
    const orphaned: string[] = [];
    for (let i = applied.length - 1; i >= 0; i -= 1) {
      const entry = applied[i]!;
      let outcome: { released: boolean; message: string };
      try {
        outcome = await this.#connector.release({
          requestId,
          lineage,
          handle: entry.handle,
          stepKind: entry.stepKind,
          resourceKey: entry.resourceKey,
          authority: entry.authority,
        });
      } catch (error) {
        // A connector that throws during compensation has not released
        // the resource. Treating a throw as success would orphan state
        // silently, which is the one outcome compensation exists to stop.
        outcome = { released: false, message: describeThrown(error) };
      }
      (outcome.released ? released : orphaned).push(entry.resourceKey);
      this.#audit.push({
        kind: 'stepRolledBack',
        ts: this.#now(),
        requestId,
        lineage,
        programScope: lineageProgramKey(lineage),
        authority: entry.authority,
        connectorId: this.#connector.connectorId,
        stepIndex: entry.stepIndex,
        stepKind: entry.stepKind,
        resourceKey: entry.resourceKey,
        released: outcome.released,
        message: outcome.message,
      });
    }
    return {
      released: Object.freeze(released),
      orphaned: Object.freeze(orphaned),
    };
  }

  #checkBudget(
    ts: string,
    steps: ReadonlyArray<OperatorStep>,
    decisions: ReadonlyArray<OperatorAuthorityRef>,
    where: string,
  ): SetupFailureInit | null {
    this.#rollBudgetWindow(ts);
    const plannedSteps = steps.length;
    const plannedUnits = decisions.reduce((sum, ref) => sum + ref.units, 0);
    const plannedRealMoney = steps.reduce(
      (sum, step) => (step.kind === 'billing.realCharge' ? sum + step.amountUnits : sum),
      0,
    );

    const exceeded = (
      failureKind: 'budgetExhausted',
      message: string,
      detail: Record<string, unknown>,
    ): SetupFailureInit => ({
      ts,
      failureKind,
      where,
      message,
      stepIndex: -1,
      stepKind: null,
      resourceKey: null,
      rolledBack: true,
      orphanedResourceKeys: [],
      detail,
    });

    const { maxStepsPerDay, maxUnitsPerDay } = this.#policy.budget;
    if (this.#budget.steps + plannedSteps > maxStepsPerDay) {
      return exceeded(
        'budgetExhausted',
        `plan needs ${plannedSteps} steps but policy "${this.#policy.policyId}" allows ${maxStepsPerDay} per day (${this.#budget.steps} used)`,
        { limit: maxStepsPerDay, used: this.#budget.steps, requested: plannedSteps, unit: 'stepsPerDay' },
      );
    }
    if (this.#budget.units + plannedUnits > maxUnitsPerDay) {
      return exceeded(
        'budgetExhausted',
        `plan needs ${plannedUnits} units but policy "${this.#policy.policyId}" allows ${maxUnitsPerDay} per day (${this.#budget.units} used)`,
        { limit: maxUnitsPerDay, used: this.#budget.units, requested: plannedUnits, unit: 'unitsPerDay' },
      );
    }
    // Real money carries its own, separate bound. This is the
    // "enforceable quantitative boundary" the authority contract requires
    // for the explicitly dangerous classes, and it is checked before the
    // first dispatch like every other budget.
    if (this.#policy.realMoney.mode === 'enabled') {
      const limit = this.#policy.realMoney.maxUnitsPerDay;
      if (this.#budget.realMoneyUnits + plannedRealMoney > limit) {
        return exceeded(
          'budgetExhausted',
          `plan needs ${plannedRealMoney} real-money units but policy "${this.#policy.policyId}" allows ${limit} per day (${this.#budget.realMoneyUnits} used)`,
          {
            limit,
            used: this.#budget.realMoneyUnits,
            requested: plannedRealMoney,
            unit: 'realMoneyUnitsPerDay',
          },
        );
      }
    }
    return null;
  }

  /** Reset counters when the injected clock crosses a UTC day. */
  #rollBudgetWindow(ts: string): void {
    const day = ts.slice(0, 10);
    if (this.#budget.day !== day) {
      this.#budget = { day, steps: 0, units: 0, realMoneyUnits: 0 };
    }
  }

  #chargeBudget(steps: number, units: number, realMoneyUnits: number): void {
    this.#budget.steps += steps;
    this.#budget.units += units;
    this.#budget.realMoneyUnits += realMoneyUnits;
  }

  #deny(
    ts: string,
    requestId: ProvisionRequestId,
    lineage: OperatorLineage,
    init: SetupFailureInit,
  ): OperatorDeniedResult {
    const authority = denialAuthorityRef(this.#policy, lineage.environmentId, init.stepKind);
    const failure = setupFailure(init);
    this.#audit.push({
      kind: 'planDenied',
      ts,
      requestId,
      lineage,
      programScope: lineageProgramKey(lineage),
      authority,
      connectorId: this.#connector.connectorId,
      failure,
    });
    return Object.freeze({
      status: 'denied' as const,
      ts,
      requestId,
      lineage,
      authority,
      failure,
      dispatchedSteps: 0 as const,
    });
  }

  #denyCleanup(
    ts: string,
    requestId: ProvisionRequestId,
    lineage: OperatorLineage,
    init: SetupFailureInit,
  ): OperatorCleanupResult {
    const authority = denialAuthorityRef(this.#policy, lineage.environmentId, init.stepKind);
    const failure = setupFailure(init);
    this.#audit.push({
      kind: 'planDenied',
      ts,
      requestId,
      lineage,
      programScope: lineageProgramKey(lineage),
      authority,
      connectorId: this.#connector.connectorId,
      failure,
    });
    return Object.freeze({
      status: 'denied' as const,
      ts,
      requestId,
      lineage,
      authority,
      failure,
      dispatchedSteps: 0 as const,
    });
  }
}

/**
 * A minimal destructive step, used only to ask the gate whether
 * destructive authority exists for an environment. It is never dispatched
 * — `authorizeStep` is a pure decision function.
 */
function CLEANUP_PROBE(baseUrl: string): OperatorStep {
  return { kind: 'fixture.reset', resourceKey: 'cleanup-probe', origin: baseUrl };
}

function setupFailure(init: SetupFailureInit): OperatorSetupFailure {
  return Object.freeze({
    subject: 'operatorSetup' as const,
    failureKind: init.failureKind,
    ts: init.ts,
    where: init.where,
    message: init.message,
    detail: Object.freeze(init.detail),
    stepIndex: init.stepIndex,
    stepKind: init.stepKind,
    resourceKey: init.resourceKey,
    rolledBack: init.rolledBack,
    orphanedResourceKeys: Object.freeze([...init.orphanedResourceKeys]),
  });
}

function productFailure(
  ts: string,
  where: string,
  outcome: { productCode: string; message: string },
  stepIndex: number,
  step: OperatorStep,
): OperatorProductFailure {
  return Object.freeze({
    subject: 'productResponse' as const,
    failureKind: 'productRejected' as const,
    ts,
    where,
    message: outcome.message,
    detail: Object.freeze({ productCode: outcome.productCode, stepKind: step.kind }),
    stepIndex,
    stepKind: step.kind,
    resourceKey: step.resourceKey,
    productCode: outcome.productCode,
  });
}

function rejectedResult(ts: string, error: unknown, where: string): OperatorRejectedRequestResult {
  // No audit record: an audit record requires attribution, and a request
  // that could not be parsed has no lineage to attribute it to. Inventing
  // one would defeat the purpose of the log.
  return Object.freeze({
    status: 'rejected' as const,
    ts,
    failure: setupFailure({
      ts,
      failureKind: 'invalidRequest',
      where,
      message: error instanceof OperatorError ? error.message : 'provision request could not be parsed',
      stepIndex: -1,
      stepKind: null,
      resourceKey: null,
      rolledBack: true,
      orphanedResourceKeys: [],
      detail:
        error instanceof OperatorError
          ? { field: error.field ?? null, ...error.detail }
          : { received: typeof error },
    }),
    dispatchedSteps: 0 as const,
  });
}

function rejectedCleanupResult(ts: string, error: unknown, where: string): OperatorCleanupResult {
  return Object.freeze({
    status: 'rejected' as const,
    ts,
    failure: setupFailure({
      ts,
      failureKind: 'invalidRequest',
      where,
      message: error instanceof OperatorError ? error.message : 'cleanup request could not be parsed',
      stepIndex: -1,
      stepKind: null,
      resourceKey: null,
      rolledBack: true,
      orphanedResourceKeys: [],
      detail: error instanceof OperatorError ? { field: error.field ?? null, ...error.detail } : {},
    }),
    dispatchedSteps: 0 as const,
  });
}

function describeThrown(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `non-Error thrown: ${typeof error}`;
}
