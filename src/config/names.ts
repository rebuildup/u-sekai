/**
 * Declared names → durable ids (issue #58).
 *
 * ## Why a name becomes an id here
 *
 * `docs/product/configuration-and-authority.md` shows `u-sekai.yml`
 * keyed by human names — `environments: { staging: ... }`,
 * `cohorts: { returning-users: ... }` — because "a normal customer
 * should be able to express what u-sekai may do without scripting".
 * The durable model (#57) meanwhile requires prefixed ids (`env-…`,
 * `coh-…`) so a value cannot be mistaken for a different kind when it
 * is re-read from storage.
 *
 * This module is the one place the two meet, and it derives rather than
 * invents: the name is prefixed and then handed to the domain's own
 * `brandedId`, which owns the grammar. The prefixes below are literals
 * in the domain's wire format, not a second copy of its patterns — a
 * mismatch is caught by `brandedId` throwing, not by a config that
 * loads and then behaves oddly.
 *
 * ## A name may not already carry its prefix
 *
 * `env-staging` as an environment name would derive to
 * `env-env-staging`. Rejecting it is a one-line guard that keeps
 * "read the name, find the id" true without a lookup table.
 *
 * ## Names are sorted, so the derived model is deterministic
 *
 * The issue's first acceptance criterion is that a minimal valid
 * configuration "loads deterministically". Iterating a YAML mapping in
 * declaration order would make the *arrays* in the resolved model
 * depend on how the file happened to be written. Names are therefore
 * sorted before anything is built, so the same file always yields
 * byte-identical `JSON.stringify` output regardless of key order.
 */

import { MAX_ID_LENGTH, brandedId } from '../product/ids.js';
import type {
  CohortId,
  EnvironmentId,
  IdKindName,
  ProductId,
  ReviewProgramId,
  SyntheticIdentityId,
} from '../product/ids.js';
import { asConfigError, UseSekaiConfigError } from './errors.js';

/** Wire-format prefix per id kind, as declared by `src/product/ids.ts`. */
const ID_PREFIXES: Readonly<Record<IdKindName, string>> = Object.freeze({
  product: 'prd-',
  environment: 'env-',
  identity: 'idn-',
  cohort: 'coh-',
  program: 'rp-',
});

/** Lowercase and hyphen-separated, matching the durable id grammar. */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Readable in a diagnostic; a name is a short label, not a description. */
const MAX_NAME_LENGTH = 48;

/**
 * Derive the durable id for a declared name.
 *
 * @param kind  which id grammar the domain should enforce
 * @param name  the human-authored, unprefixed name
 * @param field dotted path used in diagnostics
 */
export function deriveId<K extends IdKindName>(
  kind: K,
  name: unknown,
  field: string,
): ReturnType<typeof brandedId<K>> {
  if (typeof name !== 'string') {
    throw new UseSekaiConfigError(`${field} must be a name`, field, {
      reason: 'wrong_type',
    });
  }
  const prefix = ID_PREFIXES[kind];
  if (name.length > MAX_NAME_LENGTH) {
    throw new UseSekaiConfigError(
      `${field} must be at most ${MAX_NAME_LENGTH} characters`,
      field,
      { reason: 'too_long', length: name.length, maxLength: MAX_NAME_LENGTH },
    );
  }
  if (!NAME_PATTERN.test(name)) {
    throw new UseSekaiConfigError(
      `${field} must be lowercase and hyphen-separated (e.g. "staging", "returning-users")`,
      field,
      { reason: 'invalid_name' },
    );
  }
  if (name.startsWith(prefix)) {
    throw new UseSekaiConfigError(
      `${field} must not include the "${prefix}" id prefix; write the name as "${name.slice(prefix.length)}"`,
      field,
      { reason: 'prefixed_name', prefix },
    );
  }
  const full = `${prefix}${name}`;
  if (full.length > MAX_ID_LENGTH) {
    throw new UseSekaiConfigError(
      `${field} is too long once the "${prefix}" prefix is added`,
      field,
      { reason: 'too_long', length: full.length, maxLength: MAX_ID_LENGTH },
    );
  }
  return asConfigError(() => brandedId(kind, full, field), field);
}

export function deriveProductId(name: unknown, field: string): ProductId {
  return deriveId('product', name, field) as ProductId;
}

export function deriveEnvironmentId(name: unknown, field: string): EnvironmentId {
  return deriveId('environment', name, field) as EnvironmentId;
}

export function deriveSyntheticIdentityId(name: unknown, field: string): SyntheticIdentityId {
  return deriveId('identity', name, field) as SyntheticIdentityId;
}

export function deriveCohortId(name: unknown, field: string): CohortId {
  return deriveId('cohort', name, field) as CohortId;
}

export function deriveReviewProgramId(name: unknown, field: string): ReviewProgramId {
  return deriveId('program', name, field) as ReviewProgramId;
}

/** Sorted mapping keys, so a resolved configuration never depends on file key order. */
export function sortedNames(raw: Record<string, unknown>): ReadonlyArray<string> {
  return Object.keys(raw).sort();
}
