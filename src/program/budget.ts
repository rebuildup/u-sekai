/**
 * Budget enforcement for Review Program evaluation plans (issue #62).
 *
 * ## Accounting is not enforcement
 *
 * The distinction this module exists to enforce:
 *
 * - **Accounting** reports what was spent after the fact. It cannot stop
 *   anything, because by the time it knows, the money is gone.
 * - **Enforcement** decides *before* work starts whether it may start.
 *
 * So `reserve` is called before a plan is emitted, and a plan is emitted
 * **only** when a reservation is granted. A denied reservation returns
 * the ledger *unchanged* — there is no partial charge, no
 * "reserve now, correct later" path — and no plan exists for the caller
 * to execute. A budget that is only reported is not a budget; this
 * module's contract is that exceeding a ceiling means evaluation does
 * not start.
 *
 * ## The ledger is monotonic by construction
 *
 * The only state transition in this module is `reserve`, and on its
 * granted path it only ever *adds* to `costUnitsSpent` and `runsSpent`.
 * There is no `release`, no `refund`, no `reset`, no `reconcile`, and no
 * path that subtracts. A failed run is still a run that consumed a
 * reservation, and refunding it would mean a caller could loop on a
 * plan that always fails while the ledger reports zero spend — the
 * budget would then be an accounting fiction that stops nothing.
 *
 * A caller that loses the ledger loses idempotency and enforcement
 * together. That is a stated limitation (durable storage of the ledger
 * is the caller's concern, and #63's ticket), not an accident of this
 * implementation.
 *
 * ## Deduplication and budget are the same gate
 *
 * `reserve` checks the consumed-key set *before* the ceilings. A
 * redelivered trigger that was already planned is refused as
 * `duplicate-trigger` and charged nothing, so the same logical
 * evaluation can never be charged twice regardless of which path
 * re-presents it.
 *
 * ## What a run costs
 *
 * One plan is one run. Escalation (scout -> verification) is a *stage*
 * of that run, not a new run, so `runs` is charged once at plan time
 * and the escalation path never touches the ledger again. This is why
 * "escalation cannot double-charge" holds without any special-casing
 * in the escalation code: the escalation code has no ledger access.
 */

import { ProgramBudget, ReviewProgramId } from '../product/index.js';
import { ProgramPlanningError } from './errors.js';
import { IdempotencyKey, PlanKey } from './ids.js';

/** How much a reservation asks for. */
export interface BudgetSpendRequest {
  /** Cost units to reserve. Finite, >= 0. */
  readonly costUnits: number;
  /** Runs to charge. Integer, >= 0. */
  readonly runs: number;
  /** Delivery the runs originate from, for `maxRunsPerEvent`. */
  readonly deliveryId: string;
  /** When the spend occurred, recorded for the consumed key. */
  readonly at: string;
}

export interface BudgetWindow {
  readonly start: string;
  readonly end: string;
}

export interface BudgetLedger {
  readonly programId: ReviewProgramId;
  /** The rolling day this ledger accounts for. */
  readonly window: BudgetWindow;
  readonly ceilings: ProgramBudget;
  /** Monotonically non-decreasing. */
  readonly costUnitsSpent: number;
  /** Monotonically non-decreasing. */
  readonly runsSpent: number;
  /** Runs charged per delivery id, for `maxRunsPerEvent`. */
  readonly eventRuns: Readonly<Record<string, number>>;
  /** Idempotency keys already reserved. Append-only. */
  readonly consumedKeys: ReadonlyArray<string>;
  /** First reservation instant per consumed key. Append-only. */
  readonly keyPlannedAt: Readonly<Record<string, string>>;
}

export const BUDGET_DENIAL_REASONS = [
  'duplicate-trigger',
  'cost-budget-exhausted',
  'run-budget-exhausted',
  'event-run-budget-exhausted',
] as const;

export type BudgetDenialReason = (typeof BUDGET_DENIAL_REASONS)[number];

export type ReservationResult =
  | {
      readonly granted: true;
      readonly ledger: BudgetLedger;
      readonly committed: {
        readonly costUnits: number;
        readonly runs: number;
        readonly idempotencyKey: IdempotencyKey;
        readonly planKey: PlanKey;
      };
    }
  | {
      readonly granted: false;
      readonly reason: BudgetDenialReason;
      /** Byte-for-byte the ledger that was passed in. Nothing was charged. */
      readonly ledger: BudgetLedger;
      readonly attempted: {
        readonly costUnits: number;
        readonly runs: number;
        readonly spent: number;
        readonly ceiling: number;
      };
    };

/** Create an empty ledger for one program over one window. */
export function createBudgetLedger(
  programId: ReviewProgramId,
  ceilings: ProgramBudget,
  window: BudgetWindow,
): BudgetLedger {
  return Object.freeze({
    programId,
    window: Object.freeze({ start: window.start, end: window.end }),
    ceilings,
    costUnitsSpent: 0,
    runsSpent: 0,
    eventRuns: Object.freeze({}),
    consumedKeys: Object.freeze([]),
    keyPlannedAt: Object.freeze({}),
  });
}

/**
 * The rolling day containing `instant`.
 *
 * A calendar day in UTC, not a 24-hour window anchored to whenever the
 * ledger was created: an anchored window would let a caller reset its
 * budget simply by discarding the ledger and recreating it.
 */
export function defaultBudgetWindow(instant: string): BudgetWindow {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) {
    throw new ProgramPlanningError('budget window instant must be a real instant', 'window', {
      instant,
    });
  }
  const dayStart = new Date(ms);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  return { start: dayStart.toISOString(), end: dayEnd.toISOString() };
}

export function ledgerConsumes(ledger: BudgetLedger, key: string): boolean {
  return ledger.consumedKeys.includes(key);
}

export function ledgerPlannedAt(ledger: BudgetLedger, key: string): string | undefined {
  return hasOwn(ledger.keyPlannedAt, key) ? ledger.keyPlannedAt[key] : undefined;
}

/**
 * Own-property lookup on a record keyed by an externally supplied id.
 *
 * A bare `record[key] ?? fallback` reads through the prototype chain, and
 * the delivery ids and idempotency keys in this layer are
 * caller-supplied. A delivery id of `constructor` or `toString` — both
 * permitted by the handle grammar — would otherwise yield a function,
 * and `function + 1` is a string, so the `maxRunsPerEvent` comparison
 * would silently evaluate against the wrong value while the ceiling
 * still appeared satisfied.
 */
function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.hasOwn(record, key);
}

export function remainingCostUnits(ledger: BudgetLedger): number {
  return Math.max(0, ledger.ceilings.maxCostUnitsPerDay - ledger.costUnitsSpent);
}

export function remainingRuns(ledger: BudgetLedger): number {
  return Math.max(0, ledger.ceilings.maxRunsPerDay - ledger.runsSpent);
}

/**
 * The single state transition in this module.
 *
 * Grants or refuses; on refusal the input ledger is returned untouched.
 * On grant, spend only increases and the key is appended exactly once.
 */
export function reserve(
  ledger: BudgetLedger,
  request: BudgetSpendRequest,
  identity: { readonly idempotencyKey: IdempotencyKey; readonly planKey: PlanKey },
): ReservationResult {
  const idempotencyKey = identity.idempotencyKey;

  if (ledgerConsumes(ledger, idempotencyKey)) {
    return {
      granted: false,
      reason: 'duplicate-trigger',
      ledger,
      attempted: {
        costUnits: request.costUnits,
        runs: request.runs,
        spent: ledger.costUnitsSpent,
        ceiling: ledger.ceilings.maxCostUnitsPerDay,
      },
    };
  }

  if (ledger.costUnitsSpent + request.costUnits > ledger.ceilings.maxCostUnitsPerDay) {
    return {
      granted: false,
      reason: 'cost-budget-exhausted',
      ledger,
      attempted: {
        costUnits: request.costUnits,
        runs: request.runs,
        spent: ledger.costUnitsSpent,
        ceiling: ledger.ceilings.maxCostUnitsPerDay,
      },
    };
  }

  if (ledger.runsSpent + request.runs > ledger.ceilings.maxRunsPerDay) {
    return {
      granted: false,
      reason: 'run-budget-exhausted',
      ledger,
      attempted: {
        costUnits: request.costUnits,
        runs: request.runs,
        spent: ledger.runsSpent,
        ceiling: ledger.ceilings.maxRunsPerDay,
      },
    };
  }

  const eventRunsSoFar = hasOwn(ledger.eventRuns, request.deliveryId)
    ? (ledger.eventRuns[request.deliveryId] as number)
    : 0;
  if (eventRunsSoFar + request.runs > ledger.ceilings.maxRunsPerEvent) {
    return {
      granted: false,
      reason: 'event-run-budget-exhausted',
      ledger,
      attempted: {
        costUnits: request.costUnits,
        runs: request.runs,
        spent: eventRunsSoFar,
        ceiling: ledger.ceilings.maxRunsPerEvent,
      },
    };
  }

  const granted: BudgetLedger = Object.freeze({
    ...ledger,
    costUnitsSpent: ledger.costUnitsSpent + request.costUnits,
    runsSpent: ledger.runsSpent + request.runs,
    eventRuns: Object.freeze({ ...ledger.eventRuns, [request.deliveryId]: eventRunsSoFar + request.runs }),
    consumedKeys: Object.freeze([...ledger.consumedKeys, idempotencyKey]),
    keyPlannedAt: Object.freeze({ ...ledger.keyPlannedAt, [idempotencyKey]: request.at }),
  });

  return {
    granted: true,
    ledger: granted,
    committed: {
      costUnits: request.costUnits,
      runs: request.runs,
      idempotencyKey,
      planKey: identity.planKey,
    },
  };
}

/**
 * Validate a caller-supplied ledger is compatible with the program it
 * is about to be spent against.
 *
 * A ledger carrying another program's ceilings would enforce the wrong
 * budget, silently — a plausible outcome when several programs share a
 * store key namespace.
 */
export function assertLedgerMatchesProgram(ledger: BudgetLedger, programId: ReviewProgramId): void {
  if (ledger.programId !== programId) {
    throw new ProgramPlanningError(
      `ledger belongs to program ${ledger.programId}, not to ${programId}`,
      'input.ledger.programId',
      { expected: programId, received: ledger.programId },
    );
  }
}
