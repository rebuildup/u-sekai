/**
 * ProductModel — the durable model of one Product and everything scoped
 * to it (ADR-0011, issue #57).
 *
 * ## Why an aggregate
 *
 * Each identity in this package validates its *own* fields. An aggregate
 * adds the cross-entity invariants that only exist once the whole model
 * is assembled — and it is those invariants that make evidence lineage
 * trustworthy:
 *
 * - every environment, identity, cohort and program belongs to this
 *   product, so a `ProductId` in a `RunLineage` really does identify one
 *   product;
 * - ids are unique within their kind, so a reference resolves to exactly
 *   one entity;
 * - a program's `environmentIds` and `cohortId` resolve inside the model,
 *   so a program can never point at a cohort that does not exist;
 * - a cohort's explicit `identityIds` resolve inside the model, so an
 *   explicit membership rule cannot name a phantom identity.
 *
 * A dangling reference would be invisible per-entity and would surface
 * much later as evidence that cannot be joined. Checking it at
 * construction is the cheap place to catch it.
 *
 * ## Non-scope
 *
 * This type holds declarations only. It resolves no cohort membership,
 * starts no run and stores no identity state — #60, #62 and #63 own
 * those.
 */

import { SyntheticCohort } from './cohort.js';
import { Environment } from './environment.js';
import { ProductDomainError } from './errors.js';
import { SyntheticIdentity } from './identity.js';
import { Product } from './product.js';
import { ReviewProgram } from './program.js';
import { rejectUnknownKeys, requireRecord } from './validation.js';

export interface ProductModel {
  readonly product: Product;
  readonly environments: ReadonlyArray<Environment>;
  readonly identities: ReadonlyArray<SyntheticIdentity>;
  readonly cohorts: ReadonlyArray<SyntheticCohort>;
  readonly programs: ReadonlyArray<ReviewProgram>;
}

const MODEL_FIELDS = ['product', 'environments', 'identities', 'cohorts', 'programs'] as const;

export function parseProductModel(input: unknown, field = 'productModel'): ProductModel {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, MODEL_FIELDS, field);
  return buildProductModel({
    product: raw['product'] as Product,
    environments: raw['environments'] as Environment[],
    identities: raw['identities'] as SyntheticIdentity[],
    cohorts: raw['cohorts'] as SyntheticCohort[],
    programs: raw['programs'] as ReviewProgram[],
  });
}

/**
 * Assemble a model from already-parsed entities and enforce every
 * cross-entity invariant.
 */
export function buildProductModel(input: {
  readonly product: Product;
  readonly environments: ReadonlyArray<Environment>;
  readonly identities: ReadonlyArray<SyntheticIdentity>;
  readonly cohorts: ReadonlyArray<SyntheticCohort>;
  readonly programs: ReadonlyArray<ReviewProgram>;
}): ProductModel {
  const { product, environments, identities, cohorts, programs } = input;

  assertUnique(environments.map((e) => e.id), `${product.id} environments`);
  assertUnique(identities.map((i) => i.id), `${product.id} identities`);
  assertUnique(cohorts.map((c) => c.id), `${product.id} cohorts`);
  assertUnique(programs.map((p) => p.id), `${product.id} programs`);

  for (const env of environments) {
    assertOwned(env.productId, product.id, `environment ${env.id}`);
  }
  for (const identity of identities) {
    assertOwned(identity.productId, product.id, `identity ${identity.id}`);
  }

  const identityIds = new Set(identities.map((i) => i.id));
  const environmentIds = new Set(environments.map((e) => e.id));
  const cohortIds = new Set(cohorts.map((c) => c.id));

  for (const cohort of cohorts) {
    assertOwned(cohort.productId, product.id, `cohort ${cohort.id}`);
    if (cohort.membership.kind === 'explicit') {
      for (const id of cohort.membership.identityIds) {
        if (!identityIds.has(id)) {
          throw new ProductDomainError(
            `cohort ${cohort.id}: identityIds references ${id}, which is not in this model`,
            `cohort ${cohort.id}.membership.identityIds`,
            { missing: id },
          );
        }
      }
    }
  }

  for (const program of programs) {
    assertOwned(program.productId, product.id, `program ${program.id}`);
    if (!cohortIds.has(program.cohortId)) {
      throw new ProductDomainError(
        `program ${program.id}: cohortId ${program.cohortId} is not in this model`,
        `program ${program.id}.cohortId`,
        { missing: program.cohortId },
      );
    }
    for (const envId of program.environmentIds) {
      if (!environmentIds.has(envId)) {
        throw new ProductDomainError(
          `program ${program.id}: environmentIds references ${envId}, which is not in this model`,
          `program ${program.id}.environmentIds`,
          { missing: envId },
        );
      }
    }
  }

  return Object.freeze({
    product,
    environments: Object.freeze([...environments]),
    identities: Object.freeze([...identities]),
    cohorts: Object.freeze([...cohorts]),
    programs: Object.freeze([...programs]),
  });
}

/** Look up an environment by id, or `undefined` when absent. */
export function findEnvironment(
  model: ProductModel,
  id: Environment['id'],
): Environment | undefined {
  return model.environments.find((e) => e.id === id);
}

export function findIdentity(
  model: ProductModel,
  id: SyntheticIdentity['id'],
): SyntheticIdentity | undefined {
  return model.identities.find((i) => i.id === id);
}

export function findCohort(model: ProductModel, id: SyntheticCohort['id']): SyntheticCohort | undefined {
  return model.cohorts.find((c) => c.id === id);
}

export function findProgram(model: ProductModel, id: ReviewProgram['id']): ReviewProgram | undefined {
  return model.programs.find((p) => p.id === id);
}

function assertOwned(actual: string, expected: string, what: string): void {
  if (actual !== expected) {
    throw new ProductDomainError(
      `${what} belongs to ${actual}, not to ${expected}`,
      what,
      { expected, actual },
    );
  }
}

function assertUnique(ids: readonly string[], field: string): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  if (duplicates.size > 0) {
    throw new ProductDomainError(
      `${field} contains duplicate id(s): ${[...duplicates].sort().join(', ')}`,
      field,
      { duplicates: [...duplicates].sort() },
    );
  }
}
