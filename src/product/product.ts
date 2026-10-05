/**
 * Product — the customer-owned product being evaluated (ADR-0011).
 *
 * A Product is the root of the durable model. Environments, Synthetic
 * Identities, Cohorts and Review Programs are all scoped to exactly one
 * Product, and every reference between them is by durable id rather than
 * by position or by runtime handle.
 */

import { ProductDomainError } from './errors.js';
import { ProductId, parseProductId } from './ids.js';
import {
  optionalString,
  optionalStringArray,
  requireNonEmptyString,
  requireRecord,
  rejectDuplicates,
  rejectUnknownKeys,
} from './validation.js';

const PRODUCT_FIELDS = ['id', 'slug', 'displayName', 'description', 'owners', 'labels'] as const;

export interface Product {
  readonly id: ProductId;
  /** Lowercase, url-safe handle used in CLI output and artifact paths. */
  readonly slug: string;
  /** Human-facing name. */
  readonly displayName: string;
  readonly description?: string;
  /**
   * Free-form owner handles. Never an email address with credentials or
   * any other secret-bearing value — ADR-0011 keeps secret *values* out
   * of the repository-controlled configuration and stores references
   * only.
   */
  readonly owners?: ReadonlyArray<string>;
  /** Free-form classification tags. Not an enumeration. */
  readonly labels?: ReadonlyArray<string>;
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 48;
const MAX_TAGS = 32;

export function parseProduct(input: unknown, field = 'product'): Product {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, PRODUCT_FIELDS, field);

  const id = parseProductId(raw['id'], `${field}.id`);
  const slug = requireNonEmptyString(raw['slug'], `${field}.slug`, MAX_SLUG_LENGTH);
  if (!SLUG_PATTERN.test(slug)) {
    throw new ProductDomainError(
      `${field}.slug must be lowercase and hyphen-separated (e.g. "task-tracker")`,
      `${field}.slug`,
      { received: slug },
    );
  }
  const displayName = requireNonEmptyString(raw['displayName'], `${field}.displayName`);
  const description = optionalString(raw['description'], `${field}.description`, 2_000);
  const owners = optionalStringArray(raw['owners'], `${field}.owners`, (v, f) =>
    requireNonEmptyString(v, f, 200),
  );
  const labels = optionalStringArray(raw['labels'], `${field}.labels`, (v, f) =>
    requireNonEmptyString(v, f, 64),
  );
  if (labels !== undefined) {
    if (labels.length > MAX_TAGS) {
      throw new ProductDomainError(
        `${field}.labels must have at most ${MAX_TAGS} entries`,
        `${field}.labels`,
        { length: labels.length, maxLength: MAX_TAGS },
      );
    }
    rejectDuplicates(labels, `${field}.labels`);
  }
  if (owners !== undefined) {
    rejectDuplicates(owners, `${field}.owners`);
  }

  return buildProduct({ id, slug, displayName }, optionalBag({ description, owners, labels }));
}

/**
 * Drop `undefined` entries so an absent optional is absent rather than
 * explicitly undefined — `exactOptionalPropertyTypes` distinguishes the
 * two, and the distinction is what lets `JSON.stringify` round-trip a
 * domain value without inventing keys.
 */
function optionalBag<T extends object>(values: {
  readonly [K in keyof T]: T[K] | undefined;
}): Partial<T> {
  const out: { [K in keyof T]?: T[K] } = {};
  for (const key of Object.keys(values) as (keyof T)[]) {
    const v = values[key];
    if (v !== undefined) out[key] = v as T[keyof T];
  }
  return out;
}

/**
 * Assemble a `Product` from already-validated parts.
 *
 * Identity is passed in, never derived: a caller cannot obtain a Product
 * whose id differs from the one it intends to persist.
 */
export function buildProduct(
  core: { readonly id: ProductId; readonly slug: string; readonly displayName: string },
  optional: {
    readonly description?: string;
    readonly owners?: ReadonlyArray<string>;
    readonly labels?: ReadonlyArray<string>;
  } = {},
): Product {
  if (!SLUG_PATTERN.test(core.slug)) {
    throw new ProductDomainError('product.slug must be lowercase and hyphen-separated', 'product.slug', {
      received: core.slug,
    });
  }
  const result: {
    -readonly [K in keyof Product]: Product[K];
  } = {
    id: core.id,
    slug: core.slug,
    displayName: requireNonEmptyString(core.displayName, 'product.displayName'),
  };
  if (optional.description !== undefined) {
    result.description = optional.description;
  }
  if (optional.owners !== undefined) {
    result.owners = Object.freeze([...optional.owners]);
  }
  if (optional.labels !== undefined) {
    result.labels = Object.freeze([...optional.labels]);
  }
  return Object.freeze(result);
}

/** Type guard for an already-shaped value crossing a module boundary. */
export function isProduct(value: unknown): value is Product {
  try {
    parseProduct(value);
    return true;
  } catch {
    return false;
  }
}

export function productSummaryLine(product: Product): string {
  return `${product.id} (${product.displayName})`;
}
