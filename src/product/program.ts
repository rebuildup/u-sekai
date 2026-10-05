/**
 * Review Program — a durable policy determining *where*, *when* and
 * *under which conditions* evaluation runs (ADR-0011, issue #57).
 *
 * ## Triggers are declarations, not a scheduler
 *
 * `ReviewTrigger` states *that* evaluation should happen on a cadence,
 * on an event, or only when a person asks. Nothing here computes the
 * next fire time, registers a timer, or talks to a scheduler. Deciding
 * when to actually run is #62's ticket (`src/program/**`); this layer
 * only has to be able to *say* it, so that the intent survives being
 * written to configuration and read back.
 *
 * Keeping the declaration free of scheduling state is also what makes
 * the cadence comparable across a release transition: a cadence is a
 * property of the durable program, not of the process that happened to
 * be running.
 *
 * ## Cadence floor
 *
 * `MIN_CADENCE_MINUTES` is 5. ADR-0011 is explicit that "ubiquitous
 * evaluation" does not mean continuously burning compute, and a durable
 * program that can ask for a sub-minute cadence is a cost defect
 * waiting to happen. The floor is a declaration-level guard, not an
 * enforcement mechanism — nothing in this layer spends anything.
 *
 * ## Event names are opaque
 *
 * An event trigger names a domain event, nothing more. Whether that
 * event is emitted by a deployment pipeline, a repository host or a
 * customer webhook is decided outside this layer (ADR-0011: a Git
 * integration "may trigger evaluation" but "does not define the review
 * target"). The name is validated as a token, not interpreted.
 */

import { ProductDomainError } from './errors.js';
import { parseCohortId, parseEnvironmentId, parseProductId, parseReviewProgramId } from './ids.js';
import type { CohortId, EnvironmentId, ProductId, ReviewProgramId } from './ids.js';
import {
  optionalString,
  rejectDuplicates,
  rejectUnknownKeys,
  requireFiniteNumber,
  requireInteger,
  requireIsoInstant,
  requireNonEmptyString,
  requireOneOf,
  requireRecord,
  requireString,
  requireTimeZone,
} from './validation.js';

export const TRIGGER_KINDS = ['cadence', 'event', 'manual'] as const;
export type ReviewTriggerKind = (typeof TRIGGER_KINDS)[number];

export interface CadenceTrigger {
  readonly kind: 'cadence';
  /** Minutes between evaluations. `MIN_CADENCE_MINUTES`..`MAX_CADENCE_MINUTES`. */
  readonly intervalMinutes: number;
  /** IANA zone the cadence is anchored in. */
  readonly timeZone: string;
  /** Optional first evaluation instant. */
  readonly startAt?: string;
}

export interface EventTrigger {
  readonly kind: 'event';
  /** Opaque domain event name, e.g. `deployment.completed`. */
  readonly event: string;
  /** Quiet period after an event before evaluating. 0..1440. */
  readonly debounceMinutes: number;
}

export interface ManualTrigger {
  readonly kind: 'manual';
}

export type ReviewTrigger = CadenceTrigger | EventTrigger | ManualTrigger;

export interface ProgramBudget {
  /** Hard ceiling on evaluations started per rolling day. 1..10000. */
  readonly maxRunsPerDay: number;
  /** Ceiling on evaluations started from one trigger event. 1..1000. */
  readonly maxRunsPerEvent: number;
  /**
   * Ceiling on service-internal cost units per day.
   *
   * The unit is deliberately undefined by this layer: ADR-0011 requires
   * provider neutrality, so a durable budget may not be denominated in
   * one vendor's tokens or cents. #62 owns the accounting unit; the
   * budget here is a declared ceiling for that accounting to enforce.
   */
  readonly maxCostUnitsPerDay: number;
}

export interface ReviewProgram {
  readonly id: ReviewProgramId;
  readonly productId: ProductId;
  readonly name: string;
  /** Where: the environments this program evaluates. Non-empty. */
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  /** Who: the cohort this program evaluates. */
  readonly cohortId: CohortId;
  /** When: trigger declarations. Non-empty, at most one per kind. */
  readonly triggers: ReadonlyArray<ReviewTrigger>;
  /** Under which conditions: declared cost and volume ceilings. */
  readonly budget: ProgramBudget;
  readonly notes?: string;
}

const PROGRAM_FIELDS = ['id', 'productId', 'name', 'environmentIds', 'cohortId', 'triggers', 'budget', 'notes'] as const;
const BUDGET_FIELDS = ['maxRunsPerDay', 'maxRunsPerEvent', 'maxCostUnitsPerDay'] as const;

export const MIN_CADENCE_MINUTES = 5;
export const MAX_CADENCE_MINUTES = 43_200; // 30 days
export const MAX_DEBOUNCE_MINUTES = 1_440; // 1 day
export const MAX_PROGRAM_ENVIRONMENTS = 64;
export const MAX_RUNS_PER_DAY = 10_000;
export const MAX_RUNS_PER_EVENT = 1_000;
export const MAX_COST_UNITS_PER_DAY = 1_000_000;

/** Dotted lowercase token. Kept permissive: the domain does not own an event catalogue. */
const EVENT_NAME_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export function parseReviewProgram(input: unknown, field = 'program'): ReviewProgram {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, PROGRAM_FIELDS, field);

  const id = parseReviewProgramId(raw['id'], `${field}.id`);
  const productId = parseProductId(raw['productId'], `${field}.productId`);
  const name = requireNonEmptyString(raw['name'], `${field}.name`);
  const environmentIds = parseEnvironmentIdList(raw['environmentIds'], `${field}.environmentIds`);
  const cohortId = parseCohortId(raw['cohortId'], `${field}.cohortId`);
  const triggers = parseReviewTriggers(raw['triggers'], `${field}.triggers`);
  const budget = parseProgramBudget(raw['budget'], `${field}.budget`);
  const notes = optionalString(raw['notes'], `${field}.notes`, 2_000);

  const result: { -readonly [K in keyof ReviewProgram]: ReviewProgram[K] } = {
    id,
    productId,
    name,
    environmentIds,
    cohortId,
    triggers,
    budget,
  };
  if (notes !== undefined) {
    result.notes = notes;
  }
  return Object.freeze(result);
}

function parseEnvironmentIdList(value: unknown, field: string): ReadonlyArray<EnvironmentId> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProductDomainError(`${field} must be a non-empty array`, field);
  }
  if (value.length > MAX_PROGRAM_ENVIRONMENTS) {
    throw new ProductDomainError(
      `${field} must have at most ${MAX_PROGRAM_ENVIRONMENTS} entries`,
      field,
      { length: value.length, maxLength: MAX_PROGRAM_ENVIRONMENTS },
    );
  }
  const ids = value.map((v, i) => parseEnvironmentId(v, `${field}[${i}]`));
  rejectDuplicates(ids, field);
  return Object.freeze(ids);
}

export function parseReviewTriggers(value: unknown, field = 'program.triggers'): ReadonlyArray<ReviewTrigger> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProductDomainError(`${field} must be a non-empty array`, field);
  }
  if (value.length > TRIGGER_KINDS.length) {
    throw new ProductDomainError(
      `${field} must have at most ${TRIGGER_KINDS.length} entries (one per kind)`,
      field,
      { length: value.length, kinds: [...TRIGGER_KINDS] },
    );
  }
  const triggers = value.map((v, i) => parseReviewTrigger(v, `${field}[${i}]`));
  // One trigger per kind. Two cadences on a program is an ambiguity a
  // scheduler would have to resolve arbitrarily, and an arbitrary
  // resolution is a silent behavioural change in a durable policy.
  rejectDuplicates(triggers.map((t) => t.kind), field);
  return Object.freeze(triggers);
}

export function parseReviewTrigger(input: unknown, field = 'trigger'): ReviewTrigger {
  const raw = requireRecord(input, field);
  const kind = requireOneOf(raw['kind'], TRIGGER_KINDS, `${field}.kind`);

  if (kind === 'cadence') {
    rejectUnknownKeys(raw, ['kind', 'intervalMinutes', 'timeZone', 'startAt'], field);
    const intervalMinutes = requireInteger(
      raw['intervalMinutes'],
      `${field}.intervalMinutes`,
      MIN_CADENCE_MINUTES,
      MAX_CADENCE_MINUTES,
    );
    const timeZone = requireTimeZone(raw['timeZone'], `${field}.timeZone`);
    const startAt =
      raw['startAt'] === undefined
        ? undefined
        : requireIsoInstant(raw['startAt'], `${field}.startAt`);
    const result: { -readonly [K in keyof CadenceTrigger]: CadenceTrigger[K] } = {
      kind,
      intervalMinutes,
      timeZone,
    };
    if (startAt !== undefined) {
      result.startAt = startAt;
    }
    return Object.freeze(result);
  }

  if (kind === 'event') {
    rejectUnknownKeys(raw, ['kind', 'event', 'debounceMinutes'], field);
    const event = requireString(raw['event'], `${field}.event`);
    if (!EVENT_NAME_PATTERN.test(event)) {
      throw new ProductDomainError(
        `${field}.event must be a lowercase dotted token (e.g. "deployment.completed")`,
        `${field}.event`,
        { received: event },
      );
    }
    const debounceMinutes = requireInteger(
      raw['debounceMinutes'],
      `${field}.debounceMinutes`,
      0,
      MAX_DEBOUNCE_MINUTES,
    );
    return Object.freeze({ kind, event, debounceMinutes });
  }

  rejectUnknownKeys(raw, ['kind'], field);
  return Object.freeze({ kind });
}

export function parseProgramBudget(input: unknown, field = 'program.budget'): ProgramBudget {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, BUDGET_FIELDS, field);
  return Object.freeze({
    maxRunsPerDay: requireInteger(raw['maxRunsPerDay'], `${field}.maxRunsPerDay`, 1, MAX_RUNS_PER_DAY),
    maxRunsPerEvent: requireInteger(
      raw['maxRunsPerEvent'],
      `${field}.maxRunsPerEvent`,
      1,
      MAX_RUNS_PER_EVENT,
    ),
    maxCostUnitsPerDay: requireFiniteNumber(
      raw['maxCostUnitsPerDay'],
      `${field}.maxCostUnitsPerDay`,
      0,
    ),
  });
}

/** Whether the program declares the given trigger kind. */
export function programHasTrigger(program: ReviewProgram, kind: ReviewTriggerKind): boolean {
  return program.triggers.some((t) => t.kind === kind);
}
