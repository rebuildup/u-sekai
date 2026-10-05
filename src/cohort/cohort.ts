/**
 * Persisted Synthetic Cohort state and membership resolution
 * (ADR-0011, issue #60).
 *
 * ## A cohort is a *definition*, and the members are derived from it
 *
 * #57's `SyntheticCohort` states a selection rule, not a list. This
 * module resolves that rule into a concrete member list and persists
 * both, together with a digest of the definition.
 *
 * The digest is what makes "a cohort is reproducible from its persisted
 * definition" checkable rather than aspirational: resolving the cohort
 * twice must produce the same members, and a definition that has drifted
 * since the last resolution is detected by recomputing the digest instead
 * of quietly resolving against a stale rule.
 *
 * ## Resolution never touches identity state
 *
 * `resolveMembership` takes identity records as *input* and returns a new
 * cohort record. It reads only `identity.lifecycle` and `identity.retiredAt`
 * — never `retainedState`, never `observations`, and it never returns a
 * modified identity. This is the structural reason a re-run of an
 * evaluation cannot corrupt an identity: there is no code path from a
 * cohort operation to an identity write. `test/unit/cohort/separation.test.ts`
 * asserts it by hashing every identity record before and after a
 * resolution.
 *
 * ## Selection is deterministic
 *
 * `byLifecycle` and `sizeTarget` pick from a set whose order is
 * otherwise filesystem-dependent. Both therefore sort candidates by
 * identity id before selecting, so the same stored identities always
 * yield the same members on any machine and in any release. A cohort
 * whose membership would change merely because a directory listing
 * changed would make every downstream evidence join unreliable.
 */

import { createHash } from 'node:crypto';

import {
  parseSyntheticCohort,
  type SyntheticCohort,
  type SyntheticIdentityId,
} from '../product/index.js';
import { requireRecord, requireIsoInstant } from '../product/validation.js';
import { CohortStateError } from './errors.js';
import type { IdentityState } from './identity.js';
import { projectDeclaredKeys } from './record.js';

const COHORT_STATE_FIELDS = [
  'cohort',
  'definitionDigest',
  'members',
  'excluded',
  'resolvedAt',
] as const;

/** Why a member was excluded, kept alongside the member list. */
export interface ExcludedIdentity {
  readonly identityId: SyntheticIdentityId;
  readonly reason: 'retired';
}

export interface ResolvedMembership {
  /** Eligible members, ascending by id. */
  readonly members: ReadonlyArray<SyntheticIdentityId>;
  /** Ids the rule matched but that were excluded, ascending by id. */
  readonly excluded: ReadonlyArray<ExcludedIdentity>;
  readonly resolvedAt: string;
}

export interface CohortState {
  /** The #57 declaration, validated by #57's own parser. */
  readonly cohort: SyntheticCohort;
  /**
   * SHA-256 (hex) over the canonical form of `cohort`.
   *
   * Recomputed on read to detect a definition that changed without a
   * re-resolution.
   */
  readonly definitionDigest: string;
  /** Absent until the cohort has been resolved at least once. */
  readonly membership?: ResolvedMembership;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Parse a stored cohort record.
 *
 * Unmodelled keys are dropped before validation so a record written by a
 * later release still loads; the `cohort` sub-object is down-projected
 * onto #57's declared keys and validated by #57's parser, so every
 * invariant #57 declares about cohorts still holds here.
 */
export function parseCohortState(input: unknown, field = 'cohortState'): CohortState {
  const raw = requireRecord(input, field);
  const projected = projectDeclaredKeys(raw, COHORT_STATE_FIELDS);

  const cohort = parseSyntheticCohort(projected['cohort'], `${field}.cohort`);

  const storedDigest = projected['definitionDigest'];
  if (typeof storedDigest !== 'string' || storedDigest === '') {
    throw new CohortStateError(
      'corrupt_record',
      `${field}.definitionDigest must be a non-empty string`,
      `${field}.definitionDigest`,
      { received: storedDigest },
    );
  }
  const actualDigest = cohortDefinitionDigest(cohort);
  if (actualDigest !== storedDigest) {
    throw new CohortStateError(
      'integrity_mismatch',
      `${field}.definitionDigest does not match the persisted cohort definition; the definition was edited without re-resolving the cohort`,
      `${field}.definitionDigest`,
      { stored: storedDigest, actual: actualDigest, cohortId: cohort.id },
    );
  }

  const membership =
    projected['members'] === undefined
      ? undefined
      : parseMembership(projected, field);

  const result: { -readonly [K in keyof CohortState]: CohortState[K] } = {
    cohort,
    definitionDigest: actualDigest,
  };
  if (membership !== undefined) result.membership = membership;
  return Object.freeze(result);
}

function parseMembership(projected: Record<string, unknown>, field: string): ResolvedMembership {
  const membersRaw = projected['members'];
  if (!Array.isArray(membersRaw)) {
    throw new CohortStateError(
      'corrupt_record',
      `${field}.members must be an array when the cohort has been resolved`,
      `${field}.members`,
    );
  }
  const members = membersRaw.map((v, i) => {
    if (typeof v !== 'string' || v === '') {
      throw new CohortStateError(
        'corrupt_record',
        `${field}.members[${i}] must be a non-empty identity id`,
        `${field}.members[${i}]`,
        { received: v },
      );
    }
    return v as SyntheticIdentityId;
  });
  // `excluded` is persisted alongside `members` so a reload reports the
  // same picture the resolution did. Defaulting it to `[]` would make a
  // retired member look like it was never part of the cohort.
  const excludedRaw = projected['excluded'] === undefined ? [] : projected['excluded'];
  if (!Array.isArray(excludedRaw)) {
    throw new CohortStateError(
      'corrupt_record',
      `${field}.excluded must be an array when present`,
      `${field}.excluded`,
    );
  }
  const excluded = excludedRaw.map((v, i) => parseExcludedIdentity(v, `${field}.excluded[${i}]`));
  return Object.freeze({
    members: Object.freeze(members),
    excluded: Object.freeze(excluded),
    resolvedAt: requireIsoInstant(projected['resolvedAt'], `${field}.resolvedAt`),
  });
}

const EXCLUSION_REASONS = ['retired'] as const;

function parseExcludedIdentity(value: unknown, field: string): ExcludedIdentity {
  const raw = requireRecord(value, field);
  const identityId = raw['identityId'];
  if (typeof identityId !== 'string' || identityId === '') {
    throw new CohortStateError(
      'corrupt_record',
      `${field}.identityId must be a non-empty identity id`,
      `${field}.identityId`,
      { received: identityId },
    );
  }
  const reason = raw['reason'];
  if (typeof reason !== 'string' || !(EXCLUSION_REASONS as readonly string[]).includes(reason)) {
    throw new CohortStateError(
      'corrupt_record',
      `${field}.reason must be one of: ${EXCLUSION_REASONS.join(', ')}`,
      `${field}.reason`,
      { received: reason },
    );
  }
  return Object.freeze({
    identityId: identityId as SyntheticIdentityId,
    reason: reason as ExcludedIdentity['reason'],
  });
}

/* -------------------------------------------------------------------------- */
/* Serialisation and integrity                                                 */
/* -------------------------------------------------------------------------- */

export function serializeCohortState(state: CohortState): Record<string, unknown> {
  const out: Record<string, unknown> = {
    cohort: JSON.parse(JSON.stringify(state.cohort)) as unknown,
    definitionDigest: state.definitionDigest,
  };
  if (state.membership !== undefined) {
    out['members'] = [...state.membership.members];
    out['excluded'] = state.membership.excluded.map((e) => ({ ...e }));
    out['resolvedAt'] = state.membership.resolvedAt;
  }
  return out;
}

/**
 * SHA-256 (hex) over the canonical JSON form of a cohort definition.
 *
 * The canonical form sorts object keys recursively so the digest depends
 * on the *content* of the definition, not on the order a serialiser
 * happened to emit its properties in. Without that, an identical cohort
 * written by two different releases could produce two different digests
 * and every integrity check would fire spuriously.
 */
export function cohortDefinitionDigest(cohort: SyntheticCohort): string {
  return createHash('sha256')
    .update(canonicalJson(JSON.parse(JSON.stringify(cohort)) as unknown), 'utf8')
    .digest('hex');
}

/** Deterministic JSON: object keys sorted, arrays left in order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

export interface ResolveOptions {
  /** The instant the resolution is attributed to. */
  readonly resolvedAt: string;
  /**
   * Whether a `sizeTarget` rule that cannot be met is an error.
   *
   * Defaults to `true`: returning a short cohort would mean the durable
   * record claims a population it does not have, and a release-transition
   * comparison built on it would join on identities that were never
   * evaluated. Callers that genuinely want best-effort must opt in
   * explicitly.
   */
  readonly requireFullSizeTarget?: boolean;
}

/**
 * Resolve a cohort's membership rule against the stored identities.
 *
 * Pure: takes identities, returns a new `CohortState`, and mutates
 * nothing. See the module docstring for why that separation is the whole
 * point of the module boundary.
 */
export function resolveMembership(
  state: CohortState,
  identities: ReadonlyArray<IdentityState>,
  options: ResolveOptions,
): CohortState {
  const { cohort } = state;
  const byId = new Map<string, IdentityState>();
  for (const candidate of identities) {
    const id = candidate.identity.id;
    if (candidate.identity.productId !== cohort.productId) {
      throw new CohortStateError(
        'membership_unsatisfiable',
        `cohort ${cohort.id} belongs to ${cohort.productId} but identity ${id} belongs to ${candidate.identity.productId}`,
        'cohort.membership',
        { cohortId: cohort.id, identityId: id },
      );
    }
    byId.set(id, candidate);
  }

  const eligible = (s: IdentityState): boolean => s.retiredAt === undefined;
  const excluded: ExcludedIdentity[] = [];

  let members: SyntheticIdentityId[];

  if (cohort.membership.kind === 'explicit') {
    members = [];
    for (const id of cohort.membership.identityIds) {
      const found = byId.get(id);
      if (found === undefined) {
        throw new CohortStateError(
          'membership_unsatisfiable',
          `cohort ${cohort.id} names identity ${id}, which is not in this store`,
          'cohort.membership.identityIds',
          { cohortId: cohort.id, identityId: id },
        );
      }
      if (eligible(found)) {
        members.push(id);
      } else {
        excluded.push({ identityId: id, reason: 'retired' });
      }
    }
    members.sort();
  } else {
    const { lifecycle, targetSize } =
      cohort.membership.kind === 'byLifecycle'
        ? { lifecycle: cohort.membership.lifecycle, targetSize: undefined }
        : { lifecycle: cohort.membership.lifecycle, targetSize: cohort.membership.targetSize };

    const pool = identities
      .filter((s) => s.identity.lifecycle === lifecycle)
      .sort((a, b) => compareIds(a.identity.id, b.identity.id));

    members = [];
    for (const s of pool) {
      if (targetSize !== undefined && members.length >= targetSize) break;
      if (eligible(s)) {
        members.push(s.identity.id);
      } else {
        excluded.push({ identityId: s.identity.id, reason: 'retired' });
      }
    }

    if (targetSize !== undefined && members.length < targetSize) {
      const shortfall = targetSize - members.length;
      const message =
        `cohort ${cohort.id} targets ${targetSize} "${lifecycle}" identities but only ${members.length} are available`;
      if (options.requireFullSizeTarget ?? true) {
        throw new CohortStateError(
          'membership_unsatisfiable',
          message,
          'cohort.membership.targetSize',
          { cohortId: cohort.id, lifecycle, targetSize, available: members.length, shortfall },
        );
      }
    }
  }

  excluded.sort((a, b) => compareIds(a.identityId, b.identityId));

  const membership: ResolvedMembership = Object.freeze({
    members: Object.freeze(members),
    excluded: Object.freeze(excluded),
    resolvedAt: options.resolvedAt,
  });

  return Object.freeze({ cohort, definitionDigest: state.definitionDigest, membership });
}

/** Re-resolve only when the definition digest still matches what was stored. */
export function cohortIsResolvable(state: CohortState): boolean {
  return state.definitionDigest === cohortDefinitionDigest(state.cohort);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
