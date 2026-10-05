/**
 * Synthetic Cohort — a managed population of Synthetic Identities
 * selected for an evaluation program (ADR-0011, issue #57).
 *
 * ## A cohort declares membership *intent*, not membership
 *
 * The three `CohortMembershipIntent` variants say how members are
 * *selected*; resolving that selection into a concrete list of
 * identities is #60's job (`src/cohort/**`). Keeping the declaration and
 * the resolution apart is what lets a persistent cohort keep its
 * selection rule stable while its members change underneath it.
 *
 * ## A cohort does not pin environments
 *
 * `SyntheticCohort` deliberately carries no environment reference. Per
 * ADR-0011 a Review Program is what "determines where, when, and under
 * which conditions evaluation runs" — the program binds an environment
 * to a cohort. A cohort scoped to one environment would make a
 * release-transition evaluation, where the same cohort must appear in
 * two environments, unrepresentable.
 *
 * ## Non-reality
 *
 * ADR-0011's non-reality boundary holds here: a large cohort is not
 * evidence of human representativeness. Nothing in this type claims
 * otherwise, and no field records a population estimate.
 */

import { ProductDomainError } from './errors.js';
import { IDENTITY_LIFECYCLES, IdentityLifecycle } from './identity.js';
import {
  CohortId,
  parseCohortId,
  parseProductId,
  parseSyntheticIdentityId,
  ProductId,
  SyntheticIdentityId,
} from './ids.js';
import {
  rejectDuplicates,
  rejectUnknownKeys,
  requireInteger,
  requireNonEmptyString,
  requireOneOf,
  requireRecord,
} from './validation.js';

export const MEMBERSHIP_INTENT_KINDS = ['explicit', 'byLifecycle', 'sizeTarget'] as const;
export type MembershipIntentKind = (typeof MEMBERSHIP_INTENT_KINDS)[number];

/** Selection rule naming exactly which identities belong. */
export interface ExplicitMembership {
  readonly kind: 'explicit';
  readonly identityIds: ReadonlyArray<SyntheticIdentityId>;
}

/** Selection rule taking every identity of a lifecycle. */
export interface LifecycleMembership {
  readonly kind: 'byLifecycle';
  readonly lifecycle: IdentityLifecycle;
}

/** Selection rule asking for a number of identities of a lifecycle. */
export interface SizeTargetMembership {
  readonly kind: 'sizeTarget';
  readonly lifecycle: IdentityLifecycle;
  readonly targetSize: number;
}

export type CohortMembershipIntent =
  | ExplicitMembership
  | LifecycleMembership
  | SizeTargetMembership;

export interface SyntheticCohort {
  readonly id: CohortId;
  readonly productId: ProductId;
  readonly name: string;
  readonly membership: CohortMembershipIntent;
  /** Free-form note. Never a secret. */
  readonly notes?: string;
}

const COHORT_FIELDS = ['id', 'productId', 'name', 'membership', 'notes'] as const;

export const MAX_EXPLICIT_MEMBERS = 10_000;
export const MAX_TARGET_SIZE = 10_000;

export function parseSyntheticCohort(input: unknown, field = 'cohort'): SyntheticCohort {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, COHORT_FIELDS, field);

  const id = parseCohortId(raw['id'], `${field}.id`);
  const productId = parseProductId(raw['productId'], `${field}.productId`);
  const name = requireNonEmptyString(raw['name'], `${field}.name`);
  const membership = parseCohortMembershipIntent(raw['membership'], `${field}.membership`);
  const notes = raw['notes'] === undefined
    ? undefined
    : requireNonEmptyString(raw['notes'], `${field}.notes`, 2_000);

  const result: { -readonly [K in keyof SyntheticCohort]: SyntheticCohort[K] } = {
    id,
    productId,
    name,
    membership,
  };
  if (notes !== undefined) {
    result.notes = notes;
  }
  return Object.freeze(result);
}

export function parseCohortMembershipIntent(
  input: unknown,
  field = 'cohort.membership',
): CohortMembershipIntent {
  const raw = requireRecord(input, field);
  const kind = requireOneOf(raw['kind'], MEMBERSHIP_INTENT_KINDS, `${field}.kind`);

  if (kind === 'explicit') {
    rejectUnknownKeys(raw, ['kind', 'identityIds'], field);
    const rawIds = raw['identityIds'];
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      throw new ProductDomainError(
        `${field}.identityIds must be a non-empty array`,
        `${field}.identityIds`,
      );
    }
    if (rawIds.length > MAX_EXPLICIT_MEMBERS) {
      throw new ProductDomainError(
        `${field}.identityIds must have at most ${MAX_EXPLICIT_MEMBERS} entries`,
        `${field}.identityIds`,
        { length: rawIds.length, maxLength: MAX_EXPLICIT_MEMBERS },
      );
    }
    const identityIds = rawIds.map((v, i) =>
      parseSyntheticIdentityId(v, `${field}.identityIds[${i}]`),
    );
    rejectDuplicates(identityIds, `${field}.identityIds`);
    return Object.freeze({ kind, identityIds: Object.freeze(identityIds) });
  }

  if (kind === 'byLifecycle') {
    rejectUnknownKeys(raw, ['kind', 'lifecycle'], field);
    const lifecycle = requireOneOf(raw['lifecycle'], IDENTITY_LIFECYCLES, `${field}.lifecycle`);
    return Object.freeze({ kind, lifecycle });
  }

  rejectUnknownKeys(raw, ['kind', 'lifecycle', 'targetSize'], field);
  const lifecycle = requireOneOf(raw['lifecycle'], IDENTITY_LIFECYCLES, `${field}.lifecycle`);
  const targetSize = requireInteger(raw['targetSize'], `${field}.targetSize`, 1, MAX_TARGET_SIZE);
  return Object.freeze({ kind, lifecycle, targetSize });
}
