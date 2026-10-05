/**
 * Customer disposition — the durable answer to "is this a real
 * product problem?" (issue #61).
 *
 * ## Disposition is a state machine, not free text
 *
 * The six disposition kinds in `docs/product/kpis.md` are a taxonomy,
 * not a lifecycle. On their own they allow nonsense sequences:
 * accepting a finding and then marking it invalid with no record of the
 * reversal, or closing a finding that was never decided. Both would
 * corrupt #64's *disposition history is auditable* and *corrections do
 * not lose history* acceptance criteria in ways no downstream check
 * could detect, because a single current-value field cannot represent
 * a reversal.
 *
 * So a disposition carries both a `kind` and a `state`, the two are
 * validated against each other, and `DISPOSITION_TRANSITIONS` is the
 * only legal move table. An illegal transition throws
 * (`assertDispositionTransition`) rather than being silently accepted.
 *
 * | state                | meaning                                                  |
 * | -------------------- | -------------------------------------------------------- |
 * | `unreviewed`         | no disposition exists yet. Not materialisable: a `Disposition` value is by definition past review, so `parseDisposition` rejects it. |
 * | `needsHumanResearch` | open: nobody has decided, or a decision needs a person.   |
 * | `decided`            | a decision exists and is current.                         |
 * | `closed`             | the decision is settled and review has stopped.           |
 *
 * | state                | may become                                              |
 * | -------------------- | ------------------------------------------------------- |
 * | `unreviewed`         | `decided`, `needsHumanResearch`                          |
 * | `needsHumanResearch` | `decided`, `needsHumanResearch`                          |
 * | `decided`            | `decided`, `needsHumanResearch`, `closed`                |
 * | `closed`             | `decided`, `needsHumanResearch`                          |
 *
 * Read the table for what it forbids rather than what it allows:
 *
 * - `unreviewed → closed` is illegal: there is no such thing as
 *   closing a finding nobody looked at.
 * - `decided → decided` and `closed → decided` are legal and are the
 *   *correction* path. #64 records them as new dispositions that
 *   supersede the previous one; this layer only guarantees the
 *   sequence is well-formed and that the older value still refers to
 *   the same finding.
 * - Every state has at least one outgoing edge, so there is no
 *   terminal state and no way for a finding to become un-dispositionable
 *   by accident.
 *
 * ## The unresolved / decided split is the important one
 *
 * `unresolved` and `needsHumanResearch` are the two open kinds, and
 * they are the only kinds legal in `needsHumanResearch`. Conversely
 * `accepted`, `invalid`, `alreadyKnown` and `won'tFix` are the only
 * kinds legal in `decided` / `closed`. A disposition therefore cannot
 * claim to be a decision while carrying a kind that says no decision
 * has been made — which is exactly the "aggregation never treats
 * unresolved findings as accepted" requirement, enforced at
 * construction rather than left to the aggregation function.
 *
 * ## Automation may not decide
 *
 * `docs/product/kpis.md` counts acceptance and false-positive rates
 * over *customer* dispositions. An automated classifier that could
 * record `accepted` could inflate every one of those numbers. So
 * `actor.kind === 'automation'` is restricted to the two open kinds:
 * a triage bot can escalate to human research, and cannot accept or
 * dismiss anything.
 *
 * ## A disposition is a reference, never a copy
 *
 * `findingId` is a real reference. A `Disposition` never carries a
 * copy of the finding's title, severity or evidence, so it cannot go
 * stale relative to the finding it judges. `lineage.ts` resolves the
 * reference back to the finding and its evidence.
 *
 * ## What #64 owns
 *
 * #64 (`src/feedback/**`) owns persistence, immutability of the
 * event log, duplicate-event idempotency, and KPI aggregation. This
 * module owns the vocabulary, the legality of a value, and the
 * transition table — everything the ledger needs in order to refuse an
 * invalid append.
 */

import { ReviewContractError } from './errors.js';
import { DispositionId, FindingId, parseDispositionId, parseFindingId } from './ids.js';
import {
  rejectUnknownKeys,
  requireIsoInstant,
  requireNonEmptyString,
  requireOneOf,
  requireRecord,
} from './validation.js';

export const DISPOSITION_KINDS = [
  'accepted',
  'invalid',
  'alreadyKnown',
  'wontFix',
  'needsHumanResearch',
  'unresolved',
] as const;
export type DispositionKind = (typeof DISPOSITION_KINDS)[number];

/** The lifecycle position of a disposition. See the table above. */
export const DISPOSITION_STATES = ['unreviewed', 'needsHumanResearch', 'decided', 'closed'] as const;
export type DispositionState = (typeof DISPOSITION_STATES)[number];

/** The state a finding starts in, before any disposition exists. */
export const INITIAL_DISPOSITION_STATE: DispositionState = 'unreviewed';

/**
 * The complete legal transition table. Every entry is checked;
 * anything absent is illegal and `assertDispositionTransition` throws.
 */
export const DISPOSITION_TRANSITIONS: Readonly<
  Record<DispositionState, ReadonlyArray<DispositionState>>
> = Object.freeze({
  unreviewed: Object.freeze(['decided', 'needsHumanResearch'] as const),
  needsHumanResearch: Object.freeze(['decided', 'needsHumanResearch'] as const),
  decided: Object.freeze(['decided', 'needsHumanResearch', 'closed'] as const),
  closed: Object.freeze(['decided', 'needsHumanResearch'] as const),
});

/** Kinds that represent an actual decision. */
export const DECIDED_DISPOSITION_KINDS = [
  'accepted',
  'invalid',
  'alreadyKnown',
  'wontFix',
] as const satisfies ReadonlyArray<DispositionKind>;
export type DecidedDispositionKind = (typeof DECIDED_DISPOSITION_KINDS)[number];

/** Kinds that explicitly mean no decision has been reached. */
export const OPEN_DISPOSITION_KINDS = [
  'needsHumanResearch',
  'unresolved',
] as const satisfies ReadonlyArray<DispositionKind>;
export type OpenDispositionKind = (typeof OPEN_DISPOSITION_KINDS)[number];

/**
 * Kinds that require a written reason.
 *
 * `invalid` and `won'tFix` are the two ways a real problem gets
 * discarded. Requiring a rationale is what keeps "dismissed as a false
 * positive" from becoming the path of least resistance for a reader
 * who did not look, and it gives #64's false-positive audit something
 * to sample.
 */
export const RATIONALE_REQUIRED_KINDS = [
  'invalid',
  'alreadyKnown',
  'wontFix',
] as const satisfies ReadonlyArray<DispositionKind>;
export type RationaleRequiredKind = (typeof RATIONALE_REQUIRED_KINDS)[number];

/** Who recorded the disposition. */
export const DISPOSITION_ACTOR_KINDS = ['customer', 'reviewer', 'automation'] as const;
export type DispositionActorKind = (typeof DISPOSITION_ACTOR_KINDS)[number];

/** Opaque reference to the follow-up a decision produced. */
export const ACTION_KINDS = [
  'issue',
  'change',
  'research',
  'regressionTest',
  'instrumentation',
  'riskAccepted',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export interface DispositionAction {
  readonly kind: ActionKind;
  /**
   * Opaque handle to the follow-up, e.g. `u-sekai#123`.
   *
   * Deliberately not parsed: u-sekai must not adopt one issue tracker's
   * URL or identifier grammar. `kind` tells a consumer how to read it.
   */
  readonly reference: string;
  readonly label?: string;
}

export interface DispositionActor {
  readonly kind: DispositionActorKind;
  /** Opaque actor handle, e.g. a customer workspace name. Never a secret. */
  readonly reference: string;
}

export interface Disposition {
  readonly id: DispositionId;
  /** Reference to the finding judged. Never a copy of it. */
  readonly findingId: FindingId;
  readonly kind: DispositionKind;
  /** Excludes `unreviewed`: a materialised disposition is past review. */
  readonly state: Exclude<DispositionState, 'unreviewed'>;
  readonly actor: DispositionActor;
  readonly decidedAt: string;
  readonly rationale?: string;
  /** The disposition this one corrects. Enables audit without a copy. */
  readonly supersedes?: DispositionId;
  readonly action?: DispositionAction;
}

const DISPOSITION_FIELDS = [
  'id',
  'findingId',
  'kind',
  'state',
  'actor',
  'decidedAt',
  'rationale',
  'supersedes',
  'action',
] as const;
const ACTOR_FIELDS = ['kind', 'reference'] as const;
const ACTION_FIELDS = ['kind', 'reference', 'label'] as const;

export const MAX_DISPOSITION_RATIONALE_LENGTH = 2000;
export const MAX_ACTOR_REFERENCE_LENGTH = 200;
export const MAX_ACTION_REFERENCE_LENGTH = 500;
export const MAX_ACTION_LABEL_LENGTH = 300;

/** States a disposition materialised by `parseDisposition` may carry. */
const MATERIALISED_STATES = ['needsHumanResearch', 'decided', 'closed'] as const;

export function parseDisposition(input: unknown, field = 'disposition'): Disposition {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, DISPOSITION_FIELDS, field);

  const kind = requireOneOf(raw['kind'], DISPOSITION_KINDS, `${field}.kind`);
  const state = requireOneOf(
    raw['state'],
    MATERIALISED_STATES,
    `${field}.state`,
  ) as Disposition['state'];
  const actor = parseDispositionActor(raw['actor'], `${field}.actor`);

  const rationale =
    raw['rationale'] === undefined
      ? undefined
      : requireNonEmptyString(
          raw['rationale'],
          `${field}.rationale`,
          MAX_DISPOSITION_RATIONALE_LENGTH,
        );

  assertKindMatchesState(kind, state, field);
  assertRationalePresent(kind, rationale, field);
  assertActorMayRecordKind(actor.kind, kind, field);

  const id = parseDispositionId(raw['id'], `${field}.id`);

  let supersedes: DispositionId | undefined;
  if (raw['supersedes'] !== undefined) {
    supersedes = parseDispositionId(raw['supersedes'], `${field}.supersedes`);
    if (supersedes === id) {
      throw new ReviewContractError(
        `${field}.supersedes must not be the disposition's own id`,
        `${field}.supersedes`,
        { id },
      );
    }
  }

  const result: { -readonly [K in keyof Disposition]: Disposition[K] } = {
    id,
    findingId: parseFindingId(raw['findingId'], `${field}.findingId`),
    kind,
    state,
    actor,
    decidedAt: requireIsoInstant(raw['decidedAt'], `${field}.decidedAt`),
  };
  if (rationale !== undefined) result.rationale = rationale;
  if (supersedes !== undefined) result.supersedes = supersedes;
  if (raw['action'] !== undefined) {
    result.action = parseDispositionAction(raw['action'], `${field}.action`);
  }
  return Object.freeze(result);
}

export function parseDispositionActor(input: unknown, field = 'actor'): DispositionActor {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, ACTOR_FIELDS, field);
  return Object.freeze({
    kind: requireOneOf(raw['kind'], DISPOSITION_ACTOR_KINDS, `${field}.kind`),
    reference: requireNonEmptyString(
      raw['reference'],
      `${field}.reference`,
      MAX_ACTOR_REFERENCE_LENGTH,
    ),
  });
}

export function parseDispositionAction(input: unknown, field = 'action'): DispositionAction {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, ACTION_FIELDS, field);
  const result: { -readonly [K in keyof DispositionAction]: DispositionAction[K] } = {
    kind: requireOneOf(raw['kind'], ACTION_KINDS, `${field}.kind`),
    reference: requireNonEmptyString(
      raw['reference'],
      `${field}.reference`,
      MAX_ACTION_REFERENCE_LENGTH,
    ),
  };
  if (raw['label'] !== undefined) {
    result.label = requireNonEmptyString(raw['label'], `${field}.label`, MAX_ACTION_LABEL_LENGTH);
  }
  return Object.freeze(result);
}

/** Whether `to` may legally follow `from`. */
export function isLegalDispositionTransition(from: DispositionState, to: DispositionState): boolean {
  return DISPOSITION_TRANSITIONS[from].includes(to);
}

/**
 * Throw unless `to` may legally follow `from`.
 *
 * The failure message names both states and the states that were
 * available, so a ledger rejecting an append says what the caller
 * could have done instead.
 */
export function assertDispositionTransition(
  from: DispositionState,
  to: DispositionState,
  field = 'disposition.state',
): void {
  if (!isLegalDispositionTransition(from, to)) {
    throw new ReviewContractError(
      `${field}: illegal disposition transition ${from} -> ${to}; allowed from ${from}: ` +
        `${DISPOSITION_TRANSITIONS[from].join(', ')}`,
      field,
      { from, to, allowed: [...DISPOSITION_TRANSITIONS[from]] },
    );
  }
}

/** States reachable in one step from `from`. */
export function nextDispositionStates(from: DispositionState): ReadonlyArray<DispositionState> {
  return DISPOSITION_TRANSITIONS[from];
}

/**
 * Whether the transition re-records a decision that already exists.
 *
 * #64 uses this to recognise a correction (a new disposition that
 * supersedes an earlier one) as opposed to forward progress, and to
 * test that the history was preserved.
 */
export function isDispositionCorrection(
  from: DispositionState,
  to: DispositionState,
): boolean {
  return to === 'decided' && from !== 'unreviewed';
}

/**
 * Whether a disposition counts as a customer decision for KPI
 * purposes.
 *
 * Exported rather than left implicit so #64 does not re-derive the
 * rule: only a `decided` or `closed` state carrying a decided kind
 * counts. `needsHumanResearch` and `unresolved` never do, at any
 * confidence level and however many identities reproduced it.
 */
export function isCustomerDecision(disposition: Disposition): boolean {
  return (
    (disposition.state === 'decided' || disposition.state === 'closed') &&
    (DECIDED_DISPOSITION_KINDS as ReadonlyArray<string>).includes(disposition.kind)
  );
}

/** Whether the kind means "no decision has been reached". */
export function isOpenDisposition(kind: DispositionKind): boolean {
  return (OPEN_DISPOSITION_KINDS as ReadonlyArray<string>).includes(kind);
}

function assertKindMatchesState(
  kind: DispositionKind,
  state: Disposition['state'],
  field: string,
): void {
  const open = isOpenDisposition(kind);
  if (open && state !== 'needsHumanResearch') {
    throw new ReviewContractError(
      `${field}: kind "${kind}" means no decision has been reached, so it cannot carry state ` +
        `"${state}"; an unresolved finding must not be aggregated as a decision`,
      `${field}.state`,
      { kind, state },
    );
  }
  if (!open && state === 'needsHumanResearch') {
    throw new ReviewContractError(
      `${field}: kind "${kind}" is a decision, so it cannot carry state "needsHumanResearch"`,
      `${field}.state`,
      { kind, state },
    );
  }
}

function assertRationalePresent(
  kind: DispositionKind,
  rationale: string | undefined,
  field: string,
): void {
  if (
    (RATIONALE_REQUIRED_KINDS as ReadonlyArray<string>).includes(kind) &&
    rationale === undefined
  ) {
    throw new ReviewContractError(
      `${field}.rationale is required for kind "${kind}": dismissing a finding as invalid, ` +
        `already-known or won't-fix must record why, or the cheapest disposition becomes the ` +
        `default one`,
      `${field}.rationale`,
      { kind },
    );
  }
}

function assertActorMayRecordKind(
  actorKind: DispositionActorKind,
  dispositionKind: DispositionKind,
  field: string,
): void {
  if (
    actorKind === 'automation' &&
    (DECIDED_DISPOSITION_KINDS as ReadonlyArray<string>).includes(dispositionKind)
  ) {
    throw new ReviewContractError(
      `${field}.actor: automation may not record kind "${dispositionKind}". Acceptance and ` +
        `false-positive rates are counted over customer dispositions, so a classifier must not ` +
        `be able to decide; it may only escalate to ${OPEN_DISPOSITION_KINDS.join(' or ')}`,
      `${field}.actor.kind`,
      { actorKind, dispositionKind },
    );
  }
}
