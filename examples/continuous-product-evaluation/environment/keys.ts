/**
 * Versioned environment identity (ADR-0011, issue #69).
 *
 * ## The gap this closes
 *
 * #57's `Environment` is the durable, customer-declared review target
 * (`env-staging`) and it carries **no version**. #62 models the version
 * as an `EnvironmentObservation` — a timestamped record of "this
 * environment answered as this version when it was looked at" — and is
 * explicit that this is lineage metadata, not identity.
 *
 * That leaves a real hole for ADR-0011's second evaluation mode. A
 * release-transition evaluation needs a persistent cohort to experience
 * an earlier version and then a newer one *of the same environment*.
 * Two observations of one `env-staging` cannot be compared without
 * something concrete to point at, because at any instant only one of
 * them is actually deployed. So this module introduces a third,
 * distinct notion:
 *
 * | Layer | Owner | Answers |
 * | --- | --- | --- |
 * | `EnvironmentId` (`env-staging`) | #57 `src/product` | *Which* deployable is under review |
 * | `EnvironmentObservation.version` | #62 `src/program` | What version it served when observed |
 * | `EnvironmentInstanceKey` (this module) | #69 | *Which concrete, runnable instance* was observed |
 *
 * Two instances coexist simultaneously, which is exactly what makes an
 * A→B comparison possible: an earlier version and a newer version of the
 * same environment both have to be live and addressable at the same
 * time, or comparing them destroys the thing being compared.
 *
 * ## Identity is derived, never minted
 *
 * An `EnvironmentInstanceKey` is a pure function of three *declared*
 * values — `name`, `version`, `seed`. There is no `generateKey()` and no
 * clock, no process id, no run id and no counter anywhere in this
 * module. Two processes that declare the same triple derive the same
 * key, which is what makes the identity durable across process
 * boundaries; a key that changed per run would not be an identity at
 * all, it would be a run label.
 *
 * This is deliberately *not* an id generator in the sense #57 forbids.
 * #57's durable ids are declared verbatim and never synthesised; nothing
 * there may invent a value that was not written down. A key here is
 * likewise never invented — it is a digest of a declaration that the
 * caller had to write down, and a declaration with a different field is
 * rejected at parse time rather than absorbed.
 *
 * ## Why `seed` is part of identity
 *
 * Issue #69 requires that "the environment's identity is determined by
 * version / seed". That is load-bearing rather than cosmetic: a
 * returning Synthetic Identity carries memory about the world it saw
 * last time (ubiquitous-evaluation.md, "The retained history is part of
 * the experimental condition"). If two instances declared the same
 * version but different seeds, they would present different world state
 * under one version label and a longitudinal finding could not tell a
 * product change from a fixture change. Folding the seed into identity
 * makes that ambiguity unrepresentable instead of merely discouraged.
 */

import { createHash } from 'node:crypto';

/** Nominal brand. The `__brand` key is never produced at runtime. */
export type Brand<T, TBrand extends string> = T & { readonly __brand: TBrand };

/**
 * Identity of one concrete, runnable versioned environment.
 *
 * Derived from `name` + `version` + `seed` + `product`; see the module
 * docstring. Branded so a raw string cannot be passed in its place.
 */
export type EnvironmentInstanceKey = Brand<string, 'EnvironmentInstanceKey'>;

/** Longest accepted value for any single declared component. */
export const MAX_COMPONENT_LENGTH = 128;

const KEY_PREFIX = 'envkey-';
const COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Thrown when a declaration cannot produce a valid instance key. */
export class EnvironmentKeyError extends Error {
  readonly field: string;
  readonly received: unknown;

  constructor(message: string, field: string, received: unknown) {
    super(message);
    this.name = 'EnvironmentKeyError';
    this.field = field;
    this.received = received;
  }
}

/**
 * The declared description of a versioned environment.
 *
 * Exactly four fields, all of them durable declarations. There is
 * deliberately no `createdAt`, `runId`, `pid` or any other value that
 * would vary between two runs of the same declaration: `parseInstanceDeclaration`
 * rejects unknown keys outright, so a caller cannot smuggle a
 * per-run value into identity through a side channel.
 */
export interface InstanceDeclaration {
  /** Owning product. Becomes the `ProductId` once #57 is merged. */
  readonly product: string;
  /** Durable environment name, e.g. `staging`. */
  readonly name: string;
  /** Opaque version label the deployment is serving. */
  readonly version: string;
  /** Deterministic seed for this environment's world state. */
  readonly seed: string;
}

const DECLARATION_FIELDS = ['product', 'name', 'version', 'seed'] as const;

export function parseInstanceDeclaration(input: unknown, field = 'declaration'): InstanceDeclaration {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new EnvironmentKeyError(
      `${field} must be an object with ${DECLARATION_FIELDS.join(', ')}`,
      field,
      input,
    );
  }
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(DECLARATION_FIELDS as readonly string[]).includes(key)) {
      throw new EnvironmentKeyError(
        `${field}.${key} is not a known field; identity is declared by ${DECLARATION_FIELDS.join(', ')} only`,
        `${field}.${key}`,
        raw[key],
      );
    }
  }
  return Object.freeze({
    product: requireComponent(raw['product'], `${field}.product`),
    name: requireComponent(raw['name'], `${field}.name`),
    version: requireComponent(raw['version'], `${field}.version`),
    seed: requireComponent(raw['seed'], `${field}.seed`),
  });
}

function requireComponent(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new EnvironmentKeyError(`${field} must be a string`, field, value);
  }
  if (value.length === 0) {
    throw new EnvironmentKeyError(`${field} must not be empty`, field, value);
  }
  if (value.length > MAX_COMPONENT_LENGTH) {
    throw new EnvironmentKeyError(
      `${field} must be at most ${MAX_COMPONENT_LENGTH} characters`,
      field,
      value.length,
    );
  }
  if (!COMPONENT_PATTERN.test(value)) {
    throw new EnvironmentKeyError(
      `${field} must match ${COMPONENT_PATTERN.source} (e.g. "staging", "2.1.0")`,
      field,
      value,
    );
  }
  return value;
}

/**
 * Derive the instance key for a declaration.
 *
 * Pure: the same declaration yields the same key in every process, on
 * every machine, forever. The length prefix on each component means
 * `['ab','c']` and `['a','bc']` cannot collide, so two distinct
 * declarations can never share a key.
 */
export function deriveInstanceKey(declaration: InstanceDeclaration): EnvironmentInstanceKey {
  const parts = [declaration.product, declaration.name, declaration.version, declaration.seed];
  const unambiguous = parts.map((p) => `${p.length}:${p}`).join('|');
  const digest = createHash('sha256').update(unambiguous, 'utf8').digest('hex');
  return `${KEY_PREFIX}${digest}` as EnvironmentInstanceKey;
}

/** Validate a key re-read from storage rather than freshly derived. */
export function parseInstanceKey(value: unknown, field = 'instanceKey'): EnvironmentInstanceKey {
  if (typeof value !== 'string' || !value.startsWith(KEY_PREFIX)) {
    throw new EnvironmentKeyError(
      `${field} must be a string starting with "${KEY_PREFIX}"`,
      field,
      value,
    );
  }
  const digest = value.slice(KEY_PREFIX.length);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new EnvironmentKeyError(
      `${field} must be "${KEY_PREFIX}" followed by a 64-character sha256 hex digest`,
      field,
      value,
    );
  }
  return value as EnvironmentInstanceKey;
}

/**
 * Idempotency key for a transition request.
 *
 * Derived from the three things that *define* the transition — which
 * cohort, from which instance, to which instance — and from nothing
 * else. In particular it excludes every timestamp: the same transition
 * requested twice, at any two wall-clock instants, in any two processes,
 * has the same key. That is what makes re-running a transition
 * detectable as a re-run rather than a second transition.
 *
 * See `transition.ts` for how the key is used to make apply idempotent.
 */
export function deriveTransitionKey(
  cohortId: string,
  fromKey: EnvironmentInstanceKey,
  toKey: EnvironmentInstanceKey,
): string {
  const parts = [cohortId, fromKey, toKey];
  const unambiguous = parts.map((p) => `${p.length}:${p}`).join('|');
  return createHash('sha256').update(unambiguous, 'utf8').digest('hex');
}
