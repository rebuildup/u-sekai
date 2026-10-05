/**
 * Evidence references — the inspectable basis of a finding
 * (issue #61, ADR-0011).
 *
 * ## A finding is evidence-backed or it is not a finding
 *
 * `Finding.evidenceRefs` is required and must be non-empty
 * (`parseFinding`, `finding.ts`). An empty array, a missing key and an
 * unknown-key-shaped placeholder all fail at construction, so the
 * "evidence-backed" guarantee is a property of the value rather than
 * a reviewer's habit.
 *
 * Each reference is a *reference*: an `EvidenceId` minted by the run
 * plus a `locator` naming where inside the run's evidence to look. A
 * reference never carries a copy of the evidence. That is what lets
 * #64 reconstruct a disposition's lineage without the lineage drifting
 * away from the evidence that justified it.
 *
 * ## Channels may disagree, and the disagreement is kept
 *
 * Every reference carries a `channel` and a `stance`. A participant
 * self-report and an observer may see the same flow and disagree, and
 * a deterministic check may refute what a model asserted. The contract
 * stores both and never resolves them into a single number:
 *
 * - there is no aggregate, no weighting and no combined score field,
 *   and `rejectUnknownKeys` makes adding one a contract violation;
 * - `docs/product/kpis.md` lists a universal scalar UX score as an
 *   **anti-metric**, so a scalar here would be a KPI regression
 *   implemented in the data model;
 * - `contradictingEvidence()` / `isChannelConflict()` are provided so
 *   #64 can *count* disagreement, which is a legitimate use, without a
 *   field that *asserts* a resolution.
 *
 * A finding must cite at least one `supports` reference. A finding
 * whose every reference is `inconclusive` or `contradicts` is not
 * evidence-backed in any useful sense, and accepting it would let a
 * refuted claim enter the KPI base.
 */

import { parseEvidenceId } from '../product/lineage.js';
import type { EvidenceId } from '../product/lineage.js';
import { asReviewContractError, ReviewContractError } from './errors.js';
import {
  rejectDuplicates,
  rejectUnknownKeys,
  requireIsoInstant,
  requireNonEmptyArray,
  requireNonEmptyString,
  requireOneOf,
  requireRecord,
} from './validation.js';

/**
 * Where a piece of evidence came from.
 *
 * These are *channels*, not weights. `participantSelfReport` and
 * `observer` are the two model-facing channels ADR-0005/0006 keep
 * separate; `deterministicCheck` is a machine check that does not
 * involve a model at all and can therefore contradict a model finding
 * outright; `productionSignal` and `humanReport` are customer-side
 * channels that u-sekai does not own and cannot re-derive.
 *
 * ### `productResponse` vs `productionSignal` — not the same thing
 *
 * These two are one word apart and mean opposite things, so the
 * distinction is load-bearing:
 *
 * - `productResponse` is the product under test **answering**: it
 *   refused a duplicate account, returned a validation error, rejected
 *   a permission. The observation is u-sekai's own interaction with
 *   the product, and u-sekai can re-derive it. #59's World Operator
 *   projects this as `channel: 'productSignal'`; the concept is the
 *   same one and the name here is deliberately distinct from
 *   #59's so the two do not read as aliases.
 * - `productionSignal` is the customer's **production environment**
 *   reporting: telemetry, an incident, a support ticket. u-sekai does
 *   not own it and cannot re-derive it, and a finding citing it is
 *   making a claim the customer can check but u-sekai cannot.
 *
 * A finding may cite either, and citing both is normal: a
 * `productResponse` shows the refusal happened, a `productionSignal`
 * shows it mattered. Collapsing them would let a claim look
 * independently corroborated when it is only the same observation
 * recorded twice.
 */
export const EVIDENCE_CHANNELS = [
  'participantSelfReport',
  'observer',
  'structuredTrace',
  'deterministicCheck',
  'productResponse',
  'productionSignal',
  'humanReport',
  'environmentProbe',
] as const;
export type EvidenceChannel = (typeof EVIDENCE_CHANNELS)[number];

/** What a channel's evidence says about the claim it is cited for. */
export const EVIDENCE_STANCES = ['supports', 'contradicts', 'inconclusive'] as const;
export type EvidenceStance = (typeof EVIDENCE_STANCES)[number];

export interface EvidenceRef {
  /** Handle minted by the run that produced the evidence. */
  readonly id: EvidenceId;
  readonly channel: EvidenceChannel;
  readonly stance: EvidenceStance;
  /**
   * Where to look inside the run evidence: an event-family name, an
   * artifact path, a step index. Required — a reference that cannot be
   * followed is not inspectable, and "inspectable" is the whole
   * property `docs/product/kpis.md` asks evidence completeness for.
   */
  readonly locator: string;
  readonly observedAt: string;
  /** Short human-readable restatement. Never a secret. */
  readonly summary: string;
}

const EVIDENCE_REF_FIELDS = [
  'id',
  'channel',
  'stance',
  'locator',
  'observedAt',
  'summary',
] as const;

export const MAX_LOCATOR_LENGTH = 256;
export const MAX_EVIDENCE_SUMMARY_LENGTH = 500;

export function parseEvidenceRef(input: unknown, field = 'evidenceRef'): EvidenceRef {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, EVIDENCE_REF_FIELDS, field);
  return Object.freeze({
    id: asReviewContractError(`${field}.id`, () => parseEvidenceId(raw['id'], `${field}.id`)),
    channel: requireOneOf(raw['channel'], EVIDENCE_CHANNELS, `${field}.channel`),
    stance: requireOneOf(raw['stance'], EVIDENCE_STANCES, `${field}.stance`),
    locator: requireNonEmptyString(raw['locator'], `${field}.locator`, MAX_LOCATOR_LENGTH),
    observedAt: requireIsoInstant(raw['observedAt'], `${field}.observedAt`),
    summary: requireNonEmptyString(
      raw['summary'],
      `${field}.summary`,
      MAX_EVIDENCE_SUMMARY_LENGTH,
    ),
  });
}

/**
 * Parse a non-empty, duplicate-free list of evidence references.
 *
 * Duplicate handles are rejected rather than de-duplicated: the same
 * evidence id appearing twice with two different stances is a
 * contradiction *inside one finding's own citation list*, and silently
 * keeping one of them would hide it.
 */
export function parseEvidenceRefs(input: unknown, field = 'evidenceRefs'): ReadonlyArray<EvidenceRef> {
  const arr = requireNonEmptyArray(input, field);
  const refs = arr.map((v, i) => parseEvidenceRef(v, `${field}[${i}]`));
  rejectDuplicates(
    refs.map((r) => r.id),
    field,
  );
  return Object.freeze(refs);
}

/**
 * Assert that a citation list actually backs a claim.
 *
 * Applied to `Finding.evidenceRefs` and `SetupFailure.evidenceRefs`: in
 * both, the claim is the thing being asserted, and a list with nothing
 * supporting it is not evidence-backed in any useful sense.
 *
 * Deliberately *not* applied to `Verification.evidenceRefs`. A
 * verification pass is evidence about the finding, and a pass that
 * refuted the finding cites `contradicts` by definition — requiring a
 * `supports` reference there would reject exactly the verification that
 * #64's false-positive rate most needs to see.
 */
export function assertSupportsClaim(refs: ReadonlyArray<EvidenceRef>, field: string): void {
  if (!refs.some((ref) => ref.stance === 'supports')) {
    throw new ReviewContractError(
      `${field} must contain at least one reference with stance "supports"`,
      field,
      { stances: refs.map((r) => r.stance), channels: channelsOf(refs) },
    );
  }
}

/** Sorted unique channels present in a citation list. */
export function channelsOf(refs: ReadonlyArray<EvidenceRef>): ReadonlyArray<EvidenceChannel> {
  return Object.freeze([...new Set(refs.map((r) => r.channel))].sort());
}

/** References that argue against the claim, in input order. */
export function contradictingEvidence(
  refs: ReadonlyArray<EvidenceRef>,
): ReadonlyArray<EvidenceRef> {
  return Object.freeze(refs.filter((r) => r.stance === 'contradicts'));
}

/**
 * Whether the citation list contains a live disagreement: something
 * supports the claim and something contradicts it.
 *
 * A contradiction with no support is not a disagreement, it is a
 * refuted claim, and `assertSupportsClaim` is what rejects that.
 */
export function isChannelConflict(refs: ReadonlyArray<EvidenceRef>): boolean {
  return refs.some((r) => r.stance === 'supports') && refs.some((r) => r.stance === 'contradicts');
}

/**
 * References from a single channel, in input order.
 *
 * Provided so #64 can report per-channel coverage (an evaluation-quality
 * KPI) without inventing a cross-channel aggregate.
 */
export function evidenceForChannel(
  refs: ReadonlyArray<EvidenceRef>,
  channel: EvidenceChannel,
): ReadonlyArray<EvidenceRef> {
  return Object.freeze(refs.filter((r) => r.channel === channel));
}
