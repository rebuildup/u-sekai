/**
 * Identities for the product-review layer (issue #61).
 *
 * ## Findings, dispositions, verifications and setup failures are four
 * different things and are branded as four different things
 *
 * `FindingId` and `SetupFailureId` are separate nominal types on
 * purpose. A setup failure is not a finding (see `finding.ts` for the
 * full argument), and the cheapest way to keep that true is for the two
 * to be impossible to swap at a call site. Serialisation erases the
 * brand, so each id also carries a wire prefix (`fnd-`, `dsp-`,
 * `ver-`, `sf-`) and a parse function that rejects a value whose
 * prefix does not match the expected kind.
 *
 * ## Ids are derived, never randomly minted
 *
 * #57's rule is that durable ids are *declared*, never generated,
 * because nothing in the domain may mint a replacement for an id it
 * has already issued. A finding id has the same failure mode: if the
 * same run re-materialises its findings and produces different ids,
 * every disposition that referenced the first id is orphaned and
 * #64's disposition coverage silently drops.
 *
 * So the `derive*` helpers here are *deterministic functions of the
 * facts the finding already has* — run id and ordinal, finding id and
 * verification pass, and a caller-supplied seed for a record that has
 * no natural id (a runtime error). Replaying the same run yields the
 * same ids. There is no counter, no clock and no random source.
 *
 * Derived ids are *not* a substitute for validation: every `derive*`
 * function routes through the same parser as a hand-declared id, so a
 * derived value that would not survive a reload is rejected at
 * derivation time rather than at read time.
 */

import type { EvidenceId } from '../product/lineage.js';
import { ReviewContractError } from './errors.js';
import { requireInteger, requireNonEmptyString } from './validation.js';

/** Nominal brand marker, never produced at runtime. */
export type Brand<T, TBrand extends string> = T & { readonly __brand: TBrand };

export type FindingId = Brand<string, 'FindingId'>;
export type DispositionId = Brand<string, 'DispositionId'>;
export type VerificationId = Brand<string, 'VerificationId'>;
export type SetupFailureId = Brand<string, 'SetupFailureId'>;

/**
 * Durable reference to an event-family observation inside a run.
 *
 * Re-exported from `src/product/lineage.js` rather than redeclared:
 * a finding's evidence reference and a run lineage's evidence handle
 * must be the *same* type, or a finding could point at an evidence
 * handle the run lineage does not recognise.
 */
export type { EvidenceId } from '../product/lineage.js';

export const FINDING_ID_PATTERN = /^fnd-[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
export const DISPOSITION_ID_PATTERN = /^dsp-[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
export const VERIFICATION_ID_PATTERN = /^ver-[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
export const SETUP_FAILURE_ID_PATTERN = /^sf-[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

/** Maximum length of any serialised review id, prefix included. */
export const MAX_REVIEW_ID_LENGTH = 128;

const ID_KINDS = {
  finding: { typeName: 'FindingId', pattern: FINDING_ID_PATTERN },
  disposition: { typeName: 'DispositionId', pattern: DISPOSITION_ID_PATTERN },
  verification: { typeName: 'VerificationId', pattern: VERIFICATION_ID_PATTERN },
  setupFailure: { typeName: 'SetupFailureId', pattern: SETUP_FAILURE_ID_PATTERN },
} as const satisfies Record<string, { typeName: string; pattern: RegExp }>;

export type ReviewIdKindName = keyof typeof ID_KINDS;

export function findingId(value: string): FindingId {
  return brandedReviewId('finding', value);
}
export function dispositionId(value: string): DispositionId {
  return brandedReviewId('disposition', value);
}
export function verificationId(value: string): VerificationId {
  return brandedReviewId('verification', value);
}
export function setupFailureId(value: string): SetupFailureId {
  return brandedReviewId('setupFailure', value);
}

export function parseFindingId(value: unknown, field = 'findingId'): FindingId {
  return parseReviewId('finding', value, field) as FindingId;
}
export function parseDispositionId(value: unknown, field = 'dispositionId'): DispositionId {
  return parseReviewId('disposition', value, field) as DispositionId;
}
export function parseVerificationId(value: unknown, field = 'verificationId'): VerificationId {
  return parseReviewId('verification', value, field) as VerificationId;
}
export function parseSetupFailureId(value: unknown, field = 'setupFailureId'): SetupFailureId {
  return parseReviewId('setupFailure', value, field) as SetupFailureId;
}

export function brandedReviewId<K extends ReviewIdKindName>(
  kind: K,
  value: string,
  field: string = ID_KINDS[kind].typeName,
): Brand<string, (typeof ID_KINDS)[K]['typeName']> {
  const raw = requireNonEmptyString(value, field, MAX_REVIEW_ID_LENGTH);
  if (!ID_KINDS[kind].pattern.test(raw)) {
    throw new ReviewContractError(
      `${field} must match ${ID_KINDS[kind].pattern.source}`,
      field,
      { kind, received: raw, pattern: ID_KINDS[kind].pattern.source },
    );
  }
  return raw as Brand<string, (typeof ID_KINDS)[K]['typeName']>;
}

export function parseReviewId<K extends ReviewIdKindName>(
  kind: K,
  value: unknown,
  field: string = ID_KINDS[kind].typeName,
): Brand<string, (typeof ID_KINDS)[K]['typeName']> {
  if (typeof value !== 'string') {
    throw new ReviewContractError(
      `${field} must be a string`,
      field,
      {
        kind,
        received: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
      },
    );
  }
  return brandedReviewId(kind, value, field);
}

/**
 * Derive the id of the `ordinal`-th finding raised by a run.
 *
 * Ordinal is 1-based and is the producer's stable ordering within the
 * run. Two producers that disagree about the ordinal produce different
 * ids, which is why the ordinal must be a deterministic enumeration
 * (e.g. the sorted evidence-handle order) rather than a loop counter
 * over a hash map. The runtime (#63) owns that choice; this function
 * only guarantees the result is stable for a given `(runId, ordinal)`.
 */
export function deriveFindingId(runId: string, ordinal: number): FindingId {
  requirePositiveOrdinal(ordinal, 'ordinal');
  return parseFindingId(`fnd-${fnv1a32(`${runId}#${ordinal}`)}`, 'derivedFindingId');
}

/**
 * Derive the id of the `pass`-th independent verification of a finding.
 *
 * A first verification pass is pass `1`. Re-verification is a new pass,
 * not a new id for the same value, so #64 can count verification
 * survival per attempt.
 */
export function deriveVerificationId(finding: FindingId, pass: number): VerificationId {
  requirePositiveOrdinal(pass, 'pass');
  return parseVerificationId(`ver-${fnv1a32(`${finding}#pass-${pass}`)}`, 'derivedVerificationId');
}

/**
 * Derive a stable evidence handle for a record that has no natural id.
 *
 * The only intended caller is `setupFailureFromRuntimeError`, whose
 * input is `{ ts, where, message }` — a record that carries no handle
 * at all. Deriving the id from the record's own content means the same
 * failure in the same run always produces the same evidence reference,
 * so a setup failure cannot be double-counted because two callers
 * spelled its id differently.
 *
 * FNV-1a/32 is used rather than a cryptographic digest: this is a
 * short-content key for a local handle, not a security boundary. The
 * resulting id carries the same `ev-` shape as #57's evidence handles
 * so it is parseable by `parseEvidenceId`.
 */
export function deriveEvidenceId(seed: string): EvidenceId {
  const raw = requireNonEmptyString(seed, 'seed', 512);
  return `ev-${fnv1a32(raw)}` as EvidenceId;
}

export function requirePositiveOrdinal(value: unknown, field: string): number {
  return requireInteger(value, field, 1, 1_000_000);
}

/**
 * 32-bit FNV-1a, lowercase hex, 8 characters.
 *
 * Not exported: the hash is an implementation detail of id derivation,
 * and a caller that needs it should be given a `derive*` function with
 * a name that says what it is for.
 */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
