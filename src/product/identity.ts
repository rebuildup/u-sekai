/**
 * Synthetic Identity — a durable simulated user identity with bounded
 * capabilities and retained state (ADR-0011, issue #57).
 *
 * ## Lifecycle
 *
 * The three lifecycles are the axis ADR-0011's three evaluation modes
 * turn on:
 *
 * - `ephemeral` — a throwaway identity for one exploration. Nothing
 *   carries over, so it cannot participate in a release-transition
 *   comparison.
 * - `release` — an identity that spans one release transition: it
 *   experiences version A, then returns to the same identity on version
 *   B. This is the identity that makes "a returning user reacts
 *   differently from a fresh user" observable.
 * - `persistent` — an identity that accumulates state across many
 *   evaluations and many releases.
 *
 * ## Lifecycle / state-retention invariant
 *
 * Retention is a property of the lifecycle, not a free choice, so the
 * two are validated together:
 *
 * | lifecycle    | permitted `stateRetention` |
 * | ------------ | -------------------------- |
 * | `ephemeral`  | `none`                     |
 * | `release`    | `session`, `durable`       |
 * | `persistent` | `durable`                  |
 *
 * This is the invariant that makes the three evaluation modes actually
 * mean what ADR-0011 says they mean. An `ephemeral` identity that
 * retained durable state would silently become a persistent one, and a
 * release-transition evaluation would lose the control case it depends
 * on.
 *
 * ## Scope note
 *
 * This module declares the identity and a *reference* to the state
 * retained for it. It does not store, load or mutate that state:
 * durable Synthetic Identity state is #60's ticket (`src/cohort/**`).
 * `stateRef` is the seam between the two.
 */

import { ProductDomainError } from './errors.js';
import {
  Brand,
  parseProductId,
  parseSyntheticIdentityId,
  ProductId,
  SyntheticIdentityId,
} from './ids.js';
import {
  rejectUnknownKeys,
  requireInteger,
  requireNonEmptyString,
  requireOrigin,
  requireRecord,
} from './validation.js';

export const IDENTITY_LIFECYCLES = ['ephemeral', 'release', 'persistent'] as const;
export type IdentityLifecycle = (typeof IDENTITY_LIFECYCLES)[number];

export const STATE_RETENTIONS = ['none', 'session', 'durable'] as const;
export type StateRetention = (typeof STATE_RETENTIONS)[number];

/** The retention each lifecycle admits. See the module docstring. */
export const ALLOWED_STATE_RETENTION: Readonly<Record<IdentityLifecycle, ReadonlyArray<StateRetention>>> =
  Object.freeze({
    ephemeral: Object.freeze(['none'] as const),
    release: Object.freeze(['session', 'durable'] as const),
    persistent: Object.freeze(['durable'] as const),
  });

/**
 * Opaque, stable handle to the state retained for this identity.
 *
 * Never a URL, credential or storage path chosen by this layer — the
 * durable model states that such a reference exists and leaves where it
 * lives to #60.
 */
export type IdentityStateRef = Brand<string, 'IdentityStateRef'>;

/** Parse an opaque state reference re-read from storage. */
export function parseIdentityStateRef(value: unknown, field = 'identity.stateRef'): IdentityStateRef {
  const raw = requireNonEmptyString(value, field, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(raw)) {
    throw new ProductDomainError(
      `${field} must be an opaque handle of letters, digits and . _ : @ / -`,
      field,
      { received: raw },
    );
  }
  return raw as IdentityStateRef;
}

export interface IdentityCapabilityBounds<TRetention extends StateRetention = StateRetention> {
  /** Concurrent sessions this identity may hold. 1..16. */
  readonly maxConcurrentSessions: number;
  /**
   * How much this identity may retain. Constrained by `lifecycle`;
   * see the module docstring. The type parameter is what makes that
   * constraint visible to the compiler rather than only at runtime.
   */
  readonly stateRetention: TRetention;
  /**
   * Origins the identity may operate within. Non-empty, and an identity
   * is only ever evaluated inside an environment whose origin appears
   * here — that check belongs to the runtime (#63), not to this layer.
   */
  readonly permittedOrigins: ReadonlyArray<string>;
}

/** The retention a lifecycle admits, as a type. Mirrors `ALLOWED_STATE_RETENTION`. */
export type RetentionForLifecycle<TLifecycle extends IdentityLifecycle> = TLifecycle extends 'ephemeral'
  ? 'none'
  : TLifecycle extends 'release'
    ? 'session' | 'durable'
    : TLifecycle extends 'persistent'
      ? 'durable'
      : StateRetention;

interface SyntheticIdentityBase {
  readonly id: SyntheticIdentityId;
  readonly productId: ProductId;
  readonly displayName: string;
  /** Free-form persona / situation description. */
  readonly persona: string;
  /**
   * Opaque reference to retained state. Present when and only when
   * `capability.stateRetention` is not `none`.
   */
  readonly stateRef?: IdentityStateRef;
}

/**
 * A Synthetic Identity, discriminated on `lifecycle`.
 *
 * Modelling this as a union rather than a flat interface is what lets
 * the lifecycle/retention matrix be a compile-time guarantee. A caller
 * that reaches for `lifecycle === 'persistent'` has a
 * `capability.stateRetention` the compiler knows is `'durable'`, so an
 * `ephemeral`/`durable` contradiction is a type error and not only a
 * runtime one.
 *
 * The runtime check in `parseSyntheticIdentity` remains authoritative:
 * this union constrains code that builds a value, not one that arrives
 * from configuration.
 */
export type SyntheticIdentity =
  | (SyntheticIdentityBase & {
      readonly lifecycle: 'ephemeral';
      readonly capability: IdentityCapabilityBounds<'none'>;
    })
  | (SyntheticIdentityBase & {
      readonly lifecycle: 'release';
      readonly capability: IdentityCapabilityBounds<'session' | 'durable'>;
    })
  | (SyntheticIdentityBase & {
      readonly lifecycle: 'persistent';
      readonly capability: IdentityCapabilityBounds<'durable'>;
    });

const IDENTITY_FIELDS = ['id', 'productId', 'displayName', 'lifecycle', 'persona', 'capability', 'stateRef'] as const;
const CAPABILITY_FIELDS = ['maxConcurrentSessions', 'stateRetention', 'permittedOrigins'] as const;

export const MAX_CONCURRENT_SESSIONS = 16;
export const MAX_PERMITTED_ORIGINS = 32;

export function parseSyntheticIdentity(input: unknown, field = 'identity'): SyntheticIdentity {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, IDENTITY_FIELDS, field);

  const id = parseSyntheticIdentityId(raw['id'], `${field}.id`);
  const productId = parseProductId(raw['productId'], `${field}.productId`);
  const displayName = requireNonEmptyString(raw['displayName'], `${field}.displayName`);
  const lifecycle = requireLifecycle(raw['lifecycle'], `${field}.lifecycle`);
  const persona = requireNonEmptyString(raw['persona'], `${field}.persona`, 4_000);
  const capability = parseIdentityCapabilityBounds(raw['capability'], `${field}.capability`, lifecycle);

  const stateRefRaw = raw['stateRef'];
  const stateRef =
    stateRefRaw === undefined ? undefined : parseIdentityStateRef(stateRefRaw, `${field}.stateRef`);

  // Retention and stateRef must agree in both directions: a reference to
  // state an identity may not retain is a contradiction, and a retained
  // identity with no reference cannot be reloaded.
  if (capability.stateRetention === 'none' && stateRef !== undefined) {
    throw new ProductDomainError(
      `${field}.stateRef must be absent when stateRetention is "none"`,
      `${field}.stateRef`,
      { lifecycle },
    );
  }
  if (capability.stateRetention !== 'none' && stateRef === undefined) {
    throw new ProductDomainError(
      `${field}.stateRef is required when stateRetention is "${capability.stateRetention}"`,
      `${field}.stateRef`,
      { lifecycle },
    );
  }

  const base: SyntheticIdentityBase = {
    id,
    productId,
    displayName,
    persona,
    ...(stateRef === undefined ? {} : { stateRef }),
  };

  // The narrowing casts below are sound because `parseIdentityCapabilityBounds`
  // was called with `lifecycle` and therefore already proved, at runtime,
  // that this retention is the one that lifecycle admits. TypeScript cannot
  // carry that proof from a runtime check, so it is re-asserted here.
  switch (lifecycle) {
    case 'ephemeral':
      return Object.freeze({
        ...base,
        lifecycle,
        capability: capability as IdentityCapabilityBounds<'none'>,
      });
    case 'release':
      return Object.freeze({
        ...base,
        lifecycle,
        capability: capability as IdentityCapabilityBounds<'session' | 'durable'>,
      });
    case 'persistent':
      return Object.freeze({
        ...base,
        lifecycle,
        capability: capability as IdentityCapabilityBounds<'durable'>,
      });
  }
}

export function parseIdentityCapabilityBounds<TLifecycle extends IdentityLifecycle = IdentityLifecycle>(
  input: unknown,
  field = 'identity.capability',
  lifecycle?: TLifecycle,
): IdentityCapabilityBounds<RetentionForLifecycle<TLifecycle>> {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, CAPABILITY_FIELDS, field);

  const maxConcurrentSessions = requireInteger(
    raw['maxConcurrentSessions'],
    `${field}.maxConcurrentSessions`,
    1,
    MAX_CONCURRENT_SESSIONS,
  );
  const stateRetention = requireStateRetention(raw['stateRetention'], `${field}.stateRetention`);
  if (lifecycle !== undefined) {
    assertRetentionAllowed(lifecycle, stateRetention, `${field}.stateRetention`);
  }

  const permittedOriginsRaw = raw['permittedOrigins'];
  if (!Array.isArray(permittedOriginsRaw) || permittedOriginsRaw.length === 0) {
    throw new ProductDomainError(
      `${field}.permittedOrigins must be a non-empty array`,
      `${field}.permittedOrigins`,
    );
  }
  if (permittedOriginsRaw.length > MAX_PERMITTED_ORIGINS) {
    throw new ProductDomainError(
      `${field}.permittedOrigins must have at most ${MAX_PERMITTED_ORIGINS} entries`,
      `${field}.permittedOrigins`,
      { length: permittedOriginsRaw.length, maxLength: MAX_PERMITTED_ORIGINS },
    );
  }
  const permittedOrigins = permittedOriginsRaw.map((v, i) =>
    requireOrigin(v, `${field}.permittedOrigins[${i}]`),
  );
  if (new Set(permittedOrigins).size !== permittedOrigins.length) {
    throw new ProductDomainError(
      `${field}.permittedOrigins must not contain duplicates`,
      `${field}.permittedOrigins`,
    );
  }

  // Sound for the same reason as the narrowing in parseSyntheticIdentity:
  // `assertRetentionAllowed` above already proved this retention is the one
  // `lifecycle` admits, but the proof is a runtime fact.
  return Object.freeze({
    maxConcurrentSessions,
    stateRetention,
    permittedOrigins: Object.freeze(permittedOrigins),
  }) as IdentityCapabilityBounds<RetentionForLifecycle<TLifecycle>>;
}

/**
 * Whether a lifecycle admits a retention level.
 *
 * Exported so #60 can decide an identity's retention from its lifecycle
 * without duplicating the table.
 */
export function assertRetentionAllowed(
  lifecycle: IdentityLifecycle,
  stateRetention: StateRetention,
  field = 'identity.capability.stateRetention',
): void {
  if (!ALLOWED_STATE_RETENTION[lifecycle].includes(stateRetention)) {
    throw new ProductDomainError(
      `${field} "${stateRetention}" is not permitted for lifecycle "${lifecycle}"; allowed: ${ALLOWED_STATE_RETENTION[lifecycle].join(', ')}`,
      field,
      { lifecycle, stateRetention, allowed: [...ALLOWED_STATE_RETENTION[lifecycle]] },
    );
  }
}

function requireLifecycle(value: unknown, field: string): IdentityLifecycle {
  if (typeof value !== 'string' || !(IDENTITY_LIFECYCLES as readonly string[]).includes(value)) {
    throw new ProductDomainError(
      `${field} must be one of: ${IDENTITY_LIFECYCLES.join(', ')}`,
      field,
      { received: value, allowed: [...IDENTITY_LIFECYCLES] },
    );
  }
  return value as IdentityLifecycle;
}

function requireStateRetention(value: unknown, field: string): StateRetention {
  if (typeof value !== 'string' || !(STATE_RETENTIONS as readonly string[]).includes(value)) {
    throw new ProductDomainError(
      `${field} must be one of: ${STATE_RETENTIONS.join(', ')}`,
      field,
      { received: value, allowed: [...STATE_RETENTIONS] },
    );
  }
  return value as StateRetention;
}
