/**
 * Trigger evaluation — turning a durable program's trigger
 * *declarations* into "an evaluation is due" (ADR-0011, issue #62).
 *
 * #57's `src/product/program.ts` is explicit that triggers are
 * declarations, not a scheduler: "Deciding when to actually run is #62's
 * ticket". This module is that decision, and it is a pure function of
 * `(program, now, signals, ledger)` — no timer, no cron registration,
 * no queue. A caller may call it on a schedule, on a webhook, or twice
 * in the same millisecond; the answer differs only where the inputs do.
 *
 * ## Cadence is derived, event and manual are delivered
 *
 * A cadence is not "delivered" — it becomes true when the clock passes
 * the next slot. A deployment event and a manual request *are*
 * delivered, from a queue or a webhook, and therefore arrive at-least-
 * once. Modelling the two the same way would either make cadence
 * depend on a delivery that may never come, or make a redelivered event
 * look like a new event. So:
 *
 * - `cadence` candidates are *computed* from the program's declaration
 *   and the planning instant;
 * - `event` and `manual` candidates are *signals* carrying a
 *   `deliveryId` that is stable across redelivery.
 *
 * ## Precedence when several triggers match
 *
 * A program may declare up to one trigger of each kind (#57 rejects two
 * cadences as an ambiguity a scheduler would otherwise resolve
 * arbitrarily), so three things can match at once. The rule is:
 *
 * > **One delivery yields at most one plan, and the most specific
 * > intent wins: `manual` > `event` > `cadence`.**
 *
 * Manual is an explicit instruction from a person, and is never
 * suppressed by an automated policy. An event is a concrete world
 * change with its own debounce semantics, and outranks the periodic
 * sweep that would otherwise absorb it. Cadence is the general policy
 * and yields to both.
 *
 * The order is a total order over kinds, and #57 guarantees at most one
 * trigger per kind, so resolution is total: identical inputs always
 * produce the same winner. Crucially, the losing candidates are
 * **reported** in `suppressed`, not dropped. Silent selection would
 * leave an operator unable to tell a suppressed trigger from one that
 * never existed.
 *
 * ## Within a kind, the most recent wins
 *
 * Two manual requests can be in flight, or two deployments can land
 * inside one debounce window. Ordering is by `(timestamp,
 * deliveryId)` descending — total, and independent of array order.
 *
 * ## Cadence slots are absolute offsets, not wall-clock
 *
 * Slots are `anchor + k * intervalMinutes` over absolute instants. The
 * `timeZone` on a `CadenceTrigger` is carried for operator legibility
 * but does not participate in the arithmetic. This is deliberate: a
 * wall-clock-anchored cadence ("09:00 local, daily") shifts across a DST
 * transition, so the same declared interval would silently become a
 * different interval twice a year and two plans would be due at
 * 08:00 and 10:00 local. Absolute offsets have no such discontinuity.
 * The cost is that a daily-at-local-09:00 cadence is not expressible
 * with `intervalMinutes` alone; that is recorded as a known limitation.
 */

import {
  CadenceTrigger,
  EventTrigger,
  ReviewProgram,
  ReviewTrigger,
  ReviewTriggerKind,
} from '../product/index.js';
import { requireIsoInstant, requireRecord, rejectUnknownKeys } from '../product/validation.js';
import { ProgramPlanningError } from './errors.js';
import { TriggerDeliveryId, idempotencyKey, parseTriggerDeliveryId } from './ids.js';

/** A delivered event that may satisfy an `EventTrigger`. */
export interface EventSignal {
  readonly kind: 'event';
  /** Transport-assigned id, stable across redelivery. */
  readonly deliveryId: TriggerDeliveryId;
  /** Opaque domain event name, matched against the declaration. */
  readonly event: string;
  /** When the condition actually happened (not when it was delivered). */
  readonly occurredAt: string;
}

/** A delivered request that always satisfies a `ManualTrigger`. */
export interface ManualSignal {
  readonly kind: 'manual';
  readonly deliveryId: TriggerDeliveryId;
  readonly requestedAt: string;
}

export type TriggerSignal = EventSignal | ManualSignal;

const EVENT_SIGNAL_FIELDS = ['kind', 'deliveryId', 'event', 'occurredAt'] as const;
const MANUAL_SIGNAL_FIELDS = ['kind', 'deliveryId', 'requestedAt'] as const;

export function parseTriggerSignal(input: unknown, field = 'signal'): TriggerSignal {
  const raw = requireRecord(input, field);
  const kind = raw['kind'];
  if (kind === 'event') {
    rejectUnknownKeys(raw, EVENT_SIGNAL_FIELDS, field);
    if (typeof raw['event'] !== 'string' || raw['event'] === '') {
      throw new ProgramPlanningError(`${field}.event must be a non-empty string`, `${field}.event`);
    }
    return Object.freeze({
      kind: 'event',
      deliveryId: parseTriggerDeliveryId(raw['deliveryId'], `${field}.deliveryId`),
      event: raw['event'],
      occurredAt: requireIsoInstant(raw['occurredAt'], `${field}.occurredAt`),
    });
  }
  if (kind === 'manual') {
    rejectUnknownKeys(raw, MANUAL_SIGNAL_FIELDS, field);
    return Object.freeze({
      kind: 'manual',
      deliveryId: parseTriggerDeliveryId(raw['deliveryId'], `${field}.deliveryId`),
      requestedAt: requireIsoInstant(raw['requestedAt'], `${field}.requestedAt`),
    });
  }
  throw new ProgramPlanningError(`${field}.kind must be one of: event, manual`, `${field}.kind`, {
    received: kind,
  });
}

/**
 * Parse a batch of delivered signals.
 *
 * Redelivery inside one batch is collapsed, and *only* when the copies
 * are identical. Two entries sharing a `deliveryId` but disagreeing on
 * `occurredAt` are a genuine upstream inconsistency — the same message
 * cannot have happened at two times — and collapsing them by array order
 * would make the plan depend on which copy arrived first. That is
 * rejected instead.
 */
export function parseTriggerSignals(
  input: unknown,
  field = 'input.signals',
): ReadonlyArray<TriggerSignal> {
  if (input === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(input)) {
    throw new ProgramPlanningError(`${field} must be an array`, field);
  }
  const signals = input.map((v, i) => parseTriggerSignal(v, `${field}[${i}]`));
  const byDeliveryId = new Map<string, TriggerSignal>();
  for (const signal of signals) {
    const existing = byDeliveryId.get(signal.deliveryId);
    if (existing === undefined) {
      byDeliveryId.set(signal.deliveryId, signal);
      continue;
    }
    if (!sameSignal(existing, signal)) {
      throw new ProgramPlanningError(
        `${field} contains conflicting copies of delivery ${signal.deliveryId}`,
        field,
        { deliveryId: signal.deliveryId },
      );
    }
  }
  return Object.freeze([...byDeliveryId.values()]);
}

/** Field-wise equality. Explicit rather than serialisation-based. */
function sameSignal(a: TriggerSignal, b: TriggerSignal): boolean {
  if (a.kind !== b.kind) return false;
  if (a.deliveryId !== b.deliveryId) return false;
  if (a.kind === 'event' && b.kind === 'event') {
    return a.event === b.event && a.occurredAt === b.occurredAt;
  }
  return a.kind === 'manual' && b.kind === 'manual' && a.requestedAt === b.requestedAt;
}

/**
 * The instant a cadence slot begins, or `undefined` when the cadence has
 * not started yet.
 *
 * `undefined` before `startAt` is a real state, not an error: a program
 * declared to begin next quarter is not due now.
 */
export function cadenceSlotAt(trigger: CadenceTrigger, nowMs: number): string | undefined {
  const anchorMs = trigger.startAt === undefined ? 0 : Date.parse(trigger.startAt);
  const intervalMs = trigger.intervalMinutes * 60_000;
  if (nowMs < anchorMs) {
    return undefined;
  }
  const slotMs = anchorMs + Math.floor((nowMs - anchorMs) / intervalMs) * intervalMs;
  return new Date(slotMs).toISOString();
}

/** The next slot strictly after `nowMs`, or `undefined` before `startAt`. */
export function nextCadenceSlot(trigger: CadenceTrigger, nowMs: number): string | undefined {
  const slot = cadenceSlotAt(trigger, nowMs);
  if (slot === undefined) {
    // Before the anchor: the anchor itself is the next slot.
    return trigger.startAt;
  }
  return new Date(Date.parse(slot) + trigger.intervalMinutes * 60_000).toISOString();
}

/** The instant an event becomes evaluable, after its declared debounce. */
export function eventDueAt(trigger: EventTrigger, occurredAt: string): string {
  return new Date(Date.parse(occurredAt) + trigger.debounceMinutes * 60_000).toISOString();
}

/**
 * One trigger occurrence that is eligible to produce a plan.
 *
 * `dueAt` is the *semantic* instant of the occurrence — the cadence
 * slot, the debounce end, the manual request — never the moment the
 * planner happened to be called. That is what makes the idempotency key
 * below stable under redelivery and under re-planning.
 */
export interface TriggerCandidate {
  readonly kind: ReviewTriggerKind;
  readonly dueAt: string;
  readonly deliveryId?: TriggerDeliveryId;
  readonly delivery: 'derived' | 'delivered';
  /** Idempotency key for this occurrence. */
  readonly idempotencyKey: ReturnType<typeof idempotencyKey>;
}

/** Precedence, most specific first. See the module docstring. */
export const TRIGGER_PRECEDENCE: ReadonlyArray<ReviewTriggerKind> = Object.freeze([
  'manual',
  'event',
  'cadence',
]);

/**
 * Whether a trigger declaration still has a chance of firing, and
 * whether it is a candidate right now.
 */
export interface TriggerResolution {
  /** Eligible candidates, most-precedent first, then most recent. */
  readonly candidates: ReadonlyArray<TriggerCandidate>;
  /**
   * Events that matched the declaration but are still inside their
   * debounce window. Reported so a caller can distinguish "nothing
   * matched" from "matched, waiting".
   */
  readonly pendingEvents: ReadonlyArray<{ readonly dueAt: string; readonly deliveryId: TriggerDeliveryId }>;
  /** Next cadence instant, for a `not-due` explanation. */
  readonly nextCadenceDueAt?: string;
}

export function resolveTriggers(
  program: ReviewProgram,
  signals: readonly TriggerSignal[],
  nowMs: number,
): TriggerResolution {
  const manualTrigger = program.triggers.find((t) => t.kind === 'manual');
  const eventTrigger = program.triggers.find((t) => t.kind === 'event');
  const cadenceTrigger = program.triggers.find((t) => t.kind === 'cadence');

  const candidates: TriggerCandidate[] = [];

  if (manualTrigger !== undefined) {
    const manuals = signals
      .filter((s): s is ManualSignal => s.kind === 'manual')
      .slice()
      .sort((a, b) => compareByInstantThenId(a.requestedAt, a.deliveryId, b.requestedAt, b.deliveryId));
    for (const signal of manuals) {
      candidates.push({
        kind: 'manual',
        dueAt: signal.requestedAt,
        deliveryId: signal.deliveryId,
        delivery: 'delivered',
        idempotencyKey: manualKey(program.id, signal),
      });
    }
  }

  const pendingEvents: { dueAt: string; deliveryId: TriggerDeliveryId }[] = [];
  if (eventTrigger !== undefined) {
    const matching = signals
      .filter((s): s is EventSignal => s.kind === 'event' && s.event === eventTrigger.event)
      .slice()
      .sort((a, b) => compareByInstantThenId(a.occurredAt, a.deliveryId, b.occurredAt, b.deliveryId));
    for (const signal of matching) {
      const dueAt = eventDueAt(eventTrigger, signal.occurredAt);
      if (Date.parse(dueAt) > nowMs) {
        pendingEvents.push({ dueAt, deliveryId: signal.deliveryId });
        continue;
      }
      candidates.push({
        kind: 'event',
        dueAt,
        deliveryId: signal.deliveryId,
        delivery: 'delivered',
        idempotencyKey: eventKey(program.id, eventTrigger, signal),
      });
    }
  }

  let nextCadenceDueAt: string | undefined;
  if (cadenceTrigger !== undefined) {
    nextCadenceDueAt = nextCadenceSlot(cadenceTrigger, nowMs);
    const slot = cadenceSlotAt(cadenceTrigger, nowMs);
    if (slot !== undefined) {
      candidates.push({
        kind: 'cadence',
        dueAt: slot,
        delivery: 'derived',
        idempotencyKey: cadenceKey(program.id, cadenceTrigger, slot),
      });
    }
  }

  const resolution: {
    candidates: ReadonlyArray<TriggerCandidate>;
    pendingEvents: ReadonlyArray<{ dueAt: string; deliveryId: TriggerDeliveryId }>;
    nextCadenceDueAt?: string;
  } = { candidates: Object.freeze(candidates), pendingEvents: Object.freeze(pendingEvents) };
  if (nextCadenceDueAt !== undefined) {
    resolution.nextCadenceDueAt = nextCadenceDueAt;
  }
  return Object.freeze(resolution);
}

/** Pick the trigger declaration of one kind, for callers that need it. */
export function declaredTrigger(
  program: ReviewProgram,
  kind: ReviewTriggerKind,
): ReviewTrigger | undefined {
  return program.triggers.find((t) => t.kind === kind);
}

/**
 * Total order: newer first, then by delivery id descending.
 *
 * Returns a negative number when `aInstant` should sort *before*
 * `bInstant`, so this is used directly as an `Array.prototype.sort`
 * comparator and the arguments are not swapped at the call sites.
 *
 * The id tiebreak is required. Two signals carrying the same instant
 * must still order deterministically, or which one wins would depend on
 * input array order and identical inputs could produce two different
 * plans.
 */
function compareByInstantThenId(
  aInstant: string,
  aId: string,
  bInstant: string,
  bId: string,
): number {
  const delta = Date.parse(bInstant) - Date.parse(aInstant);
  if (delta !== 0) return delta < 0 ? -1 : 1;
  if (aId === bId) return 0;
  return aId < bId ? 1 : -1;
}

/**
 * Cadence idempotency key: the *slot*, not the clock reading.
 *
 * Planning at 10:00:00 and again at 10:59:59 both land in the 10:00
 * slot and therefore produce the same key, which is what makes a
 * re-planned cadence slot a `duplicate` rather than a second run.
 */
export function cadenceKey(
  programId: string,
  trigger: CadenceTrigger,
  slotIso: string,
): ReturnType<typeof idempotencyKey> {
  return idempotencyKey([
    'cadence',
    programId,
    `interval=${trigger.intervalMinutes}`,
    `zone=${trigger.timeZone}`,
    `start=${trigger.startAt ?? 'epoch'}`,
    `slot=${slotIso}`,
  ]);
}

export function eventKey(
  programId: string,
  trigger: EventTrigger,
  signal: EventSignal,
): ReturnType<typeof idempotencyKey> {
  return idempotencyKey([
    'event',
    programId,
    trigger.event,
    `delivery=${signal.deliveryId}`,
    `occurred=${signal.occurredAt}`,
  ]);
}

export function manualKey(
  programId: string,
  signal: ManualSignal,
): ReturnType<typeof idempotencyKey> {
  return idempotencyKey(['manual', programId, `delivery=${signal.deliveryId}`]);
}
