/**
 * Review triggers as declared in `u-sekai.yml` (issue #58).
 *
 * ## A mapping, not a list, so "one per kind" is structural
 *
 * The durable model accepts an array of triggers and rejects two of the
 * same kind. Here `trigger:` is a *mapping* keyed by kind, which makes a
 * repeated kind impossible to write at all — and a repeated YAML key is
 * a hard parse error (see `yaml.ts`), so it cannot slip through as a
 * last-wins overwrite either. The illustrative shape in
 * `docs/product/configuration-and-authority.md` is a single-entry
 * mapping, so this is a widening of one example rather than a
 * departure from it.
 *
 * ## Named cadences, because `cadence: 1440` is unreadable
 *
 * A cadence may be one of three closed tokens or an explicit
 * `{ everyMinutes, timeZone }` object for anything else. The domain's
 * `MIN_CADENCE_MINUTES` floor and `MAX_CADENCE_MINUTES` ceiling are
 * enforced by `parseReviewProgram` after translation, so this module
 * does not restate them.
 *
 * ## `timeZone` defaults to UTC, and that default is visible
 *
 * A cadence anchored to an implicit local zone is not reproducible: the
 * same file would schedule differently on two machines. The default is
 * `UTC` rather than a *rejection*, because a daily review does not
 * need a timezone to be correct — but it is UTC rather than the
 * host's, and `cadenceSummary` reports the zone that was actually used.
 */

import {
  MAX_CADENCE_MINUTES,
  MAX_DEBOUNCE_MINUTES,
  MIN_CADENCE_MINUTES,
  TRIGGER_KINDS,
} from '../product/program.js';
import type { ReviewTrigger } from '../product/program.js';
import {
  rejectUnknownKeys,
  requireBoolean,
  requireInteger,
  requireMapping,
  requireNonEmptyString,
} from './validate.js';
import { UseSekaiConfigError } from './errors.js';

const TRIGGER_KEYS = [...TRIGGER_KINDS] as readonly string[];

/** Closed cadence vocabulary. Minutes are the domain's unit. */
const CADENCE_TOKENS: Readonly<Record<string, number>> = Object.freeze({
  hourly: 60,
  daily: 1_440,
  weekly: 10_080,
});

const CADENCE_KEYS = ['everyMinutes', 'timeZone'] as const;
const EVENT_KEYS = ['event', 'debounceMinutes'] as const;

/** Zone used when a cadence does not name one. */
export const DEFAULT_CADENCE_TIME_ZONE = 'UTC';

/**
 * Parse a `trigger:` block into the domain's trigger declarations.
 *
 * @param value the block; `undefined` is an error, because a Review
 *   Program with no trigger is a program that never runs
 */
export function parseTriggerBlock(value: unknown, field: string): ReadonlyArray<ReviewTrigger> {
  const raw = requireMapping(value, field);
  rejectUnknownKeys(raw, TRIGGER_KEYS, field);

  const declared = TRIGGER_KINDS.filter((kind) => raw[kind] !== undefined);
  if (declared.length === 0) {
    throw new UseSekaiConfigError(
      `${field} must declare at least one of: ${TRIGGER_KINDS.join(', ')}`,
      field,
      { reason: 'empty', allowed: [...TRIGGER_KINDS] },
    );
  }

  const triggers: ReviewTrigger[] = [];
  for (const kind of TRIGGER_KINDS) {
    const entry = raw[kind];
    if (entry === undefined) continue;
    const entryField = `${field}.${kind}`;
    if (kind === 'cadence') {
      triggers.push(parseCadenceTrigger(entry, entryField));
    } else if (kind === 'event') {
      triggers.push(parseEventTrigger(entry, entryField));
    } else {
      triggers.push(parseManualTrigger(entry, entryField));
    }
  }
  return Object.freeze(triggers);
}

function parseCadenceTrigger(value: unknown, field: string): ReviewTrigger {
  if (typeof value === 'string') {
    const minutes = CADENCE_TOKENS[value];
    if (minutes === undefined) {
      throw new UseSekaiConfigError(
        `${field} must be one of: ${Object.keys(CADENCE_TOKENS).sort().join(', ')}, ` +
          'or a mapping with everyMinutes and timeZone',
        field,
        { reason: 'unknown_cadence', received: value },
      );
    }
    return Object.freeze({
      kind: 'cadence' as const,
      intervalMinutes: minutes,
      timeZone: DEFAULT_CADENCE_TIME_ZONE,
    });
  }

  const raw = requireMapping(value, field);
  rejectUnknownKeys(raw, CADENCE_KEYS, field);
  // The domain's floor and ceiling, not a restatement of them. Checking
  // `1..43200` here and letting `parseReviewProgram` reject `1` a layer
  // later would mean the configuration layer accepts a cadence the model
  // does not, and the diagnostic would name a field the file never used.
  const everyMinutes = requireInteger(
    raw['everyMinutes'],
    `${field}.everyMinutes`,
    MIN_CADENCE_MINUTES,
    MAX_CADENCE_MINUTES,
  );
  const timeZone =
    raw['timeZone'] === undefined
      ? DEFAULT_CADENCE_TIME_ZONE
      : requireNonEmptyString(raw['timeZone'], `${field}.timeZone`, 64);
  return Object.freeze({ kind: 'cadence' as const, intervalMinutes: everyMinutes, timeZone });
}

function parseEventTrigger(value: unknown, field: string): ReviewTrigger {
  const raw = requireMapping(value, field);
  rejectUnknownKeys(raw, EVENT_KEYS, field);
  // The event *name* is validated by `parseReviewProgram`; this layer
  // only decides whether the name was supplied at all, so the domain
  // keeps sole ownership of the token grammar.
  if (raw['event'] === undefined) {
    throw new UseSekaiConfigError(`${field} must declare an event name`, field, {
      reason: 'missing_event_name',
    });
  }
  const debounceMinutes =
    raw['debounceMinutes'] === undefined
      ? 0
      : requireInteger(raw['debounceMinutes'], `${field}.debounceMinutes`, 0, MAX_DEBOUNCE_MINUTES);
  return Object.freeze({
    kind: 'event' as const,
    event: requireNonEmptyString(raw['event'], `${field}.event`, 200),
    debounceMinutes,
  });
}

function parseManualTrigger(value: unknown, field: string): ReviewTrigger {
  // `manual: true` is the only spelling. `manual: false` would declare a
  // trigger that is declared not to fire, which is a contradiction
  // rather than an absence.
  if (!requireBoolean(value, field)) {
    throw new UseSekaiConfigError(`${field}: false declares a trigger that never fires; omit it instead`, field, {
      reason: 'contradictory_trigger',
    });
  }
  return Object.freeze({ kind: 'manual' as const });
}

/** Human-readable one-line summary of a resolved trigger list. */
export function cadenceSummary(triggers: ReadonlyArray<ReviewTrigger>): string {
  const parts = triggers.map((trigger) => {
    if (trigger.kind === 'cadence') return `every ${trigger.intervalMinutes}min (${trigger.timeZone})`;
    if (trigger.kind === 'event') return `on ${trigger.event}`;
    return 'manually';
  });
  return parts.join(', ');
}

/** Exported for tests and callers that need to build a trigger list. */
export const SUPPORTED_CADENCE_TOKENS: ReadonlyArray<string> = Object.freeze(
  Object.keys(CADENCE_TOKENS).sort(),
);
