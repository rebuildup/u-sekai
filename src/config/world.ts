/**
 * World Operator connectors declared per environment (issue #58).
 *
 * ## Setup surface, not user surface
 *
 * `docs/product/configuration-and-authority.md` separates the World
 * Operator (privileged setup: create an account, seed data, prepare a
 * test inbox) from the Participant (constrained exploration). This
 * module declares the *connectors* the Operator is allowed to use. It
 * grants the Operator nothing by itself: #59 owns the boundary, and the
 * authority envelope in `authority.ts` still governs what any of it may
 * do.
 *
 * ## Provider names are opaque tokens, not an enumeration
 *
 * ADR-0011 requires provider neutrality, so `provider` is a lowercase
 * dotted token and not a list of known vendors. A `stripe:` in a file
 * does not put Stripe in the domain; it is a label the customer's
 * connector implementation matches on. Adding a vendor therefore
 * needs no change here and no release.
 *
 * ## `live` billing is gated on real-money authority
 *
 * `docs/product/configuration-and-authority.md` ranks billing modes:
 * sandbox/test first, real transaction only "under explicit production
 * authority". So `mode: live` is refused unless the same environment
 * grants bounded real-money authority. Declaring live billing without
 * it is the exact conflation the document warns against, and it would
 * otherwise be a limit that a partially-written file can defeat.
 *
 * No default is supplied for `mode`: billing is the one connector where
 * "unset" is genuinely ambiguous between sandbox and real, so the file
 * has to say which.
 */

import { requireOrigin as requireOriginFromDomain } from '../product/validation.js';
import { EnvironmentAuthority } from './authority.js';
import { asConfigError, UseSekaiConfigError } from './errors.js';
import {
  rejectUnknownKeys,
  requireMapping,
  requireNonEmptyString,
  requireOneOf,
} from './validate.js';

export const WORLD_BILLING_MODES = ['test', 'live'] as const;
export type WorldBillingMode = (typeof WORLD_BILLING_MODES)[number];

/** Lowercase dotted token; matches the domain's event-name grammar. */
const PROVIDER_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

const WORLD_KEYS = ['accounts', 'email', 'billing'] as const;
const CONNECTOR_KEYS = ['provider', 'secret'] as const;
const ACCOUNT_CONNECTOR_KEYS = [...CONNECTOR_KEYS, 'endpoint'] as const;
const BILLING_CONNECTOR_KEYS = [...CONNECTOR_KEYS, 'mode'] as const;

export interface WorldConnector {
  /** Opaque label for the customer's connector implementation. */
  readonly provider: string;
  /** Registry key into the environment's `secrets:` block. */
  readonly secret?: string;
}

export interface WorldAccountConnector extends WorldConnector {
  /** The customer-provided test-support API. Never a Participant-reachable URL. */
  readonly endpoint: string;
}

export interface WorldBillingConnector extends WorldConnector {
  readonly mode: WorldBillingMode;
}

export interface WorldOperatorSurface {
  readonly accounts?: WorldAccountConnector;
  readonly email?: WorldConnector;
  readonly billing?: WorldBillingConnector;
}

/** What an environment that declares no `world:` block has. */
export function emptyWorldSurface(): WorldOperatorSurface {
  return Object.freeze({});
}

/**
 * Parse a `world:` block.
 *
 * @param value        the block, or `undefined`
 * @param field        dotted path used in diagnostics
 * @param secretNames  registry keys the environment's `secrets:` block declares
 * @param authority    the same environment's authority envelope, for the live-billing gate
 */
export function parseWorldOperatorSurface(
  value: unknown,
  field: string,
  secretNames: ReadonlySet<string>,
  authority: EnvironmentAuthority,
): WorldOperatorSurface {
  if (value === undefined) return emptyWorldSurface();

  const raw = requireMapping(value, field);
  rejectUnknownKeys(raw, WORLD_KEYS, field);

  const accountsRaw = raw['accounts'];
  const emailRaw = raw['email'];
  const billingRaw = raw['billing'];

  const accounts =
    accountsRaw === undefined
      ? undefined
      : parseAccountConnector(accountsRaw, `${field}.accounts`, secretNames);
  const email = emailRaw === undefined ? undefined : parseConnector(emailRaw, `${field}.email`, secretNames);
  const billing =
    billingRaw === undefined
      ? undefined
      : parseBillingConnector(billingRaw, `${field}.billing`, secretNames, authority);

  const result: { -readonly [K in keyof WorldOperatorSurface]: WorldOperatorSurface[K] } = {};
  if (accounts !== undefined) result.accounts = accounts;
  if (email !== undefined) result.email = email;
  if (billing !== undefined) result.billing = billing;
  return Object.freeze(result);
}

function parseConnector(
  value: unknown,
  field: string,
  secretNames: ReadonlySet<string>,
): WorldConnector {
  const raw = requireMapping(value, field);
  rejectUnknownKeys(raw, CONNECTOR_KEYS, field);
  const provider = requireProvider(raw['provider'], `${field}.provider`);
  const secret = readSecretName(raw['secret'], `${field}.secret`, secretNames);
  const result: { -readonly [K in keyof WorldConnector]: WorldConnector[K] } = { provider };
  if (secret !== undefined) result.secret = secret;
  return Object.freeze(result);
}

function parseAccountConnector(
  value: unknown,
  field: string,
  secretNames: ReadonlySet<string>,
): WorldAccountConnector {
  const raw = requireMapping(value, field);
  rejectUnknownKeys(raw, ACCOUNT_CONNECTOR_KEYS, field);
  const provider = requireProvider(raw['provider'], `${field}.provider`);
  const secret = readSecretName(raw['secret'], `${field}.secret`, secretNames);
  // The endpoint grammar is the domain's: an absolute http(s) URL with
  // no embedded credentials, query or fragment. Delegated rather than
  // restated so a file can never accept a URL the domain later refuses.
  const endpoint = asConfigError(
    () => requireOriginFromDomain(raw['endpoint'], `${field}.endpoint`),
    `${field}.endpoint`,
  );
  const result: { -readonly [K in keyof WorldAccountConnector]: WorldAccountConnector[K] } = {
    provider,
    endpoint,
  };
  if (secret !== undefined) result.secret = secret;
  return Object.freeze(result);
}

function parseBillingConnector(
  value: unknown,
  field: string,
  secretNames: ReadonlySet<string>,
  authority: EnvironmentAuthority,
): WorldBillingConnector {
  const raw = requireMapping(value, field);
  rejectUnknownKeys(raw, BILLING_CONNECTOR_KEYS, field);
  const provider = requireProvider(raw['provider'], `${field}.provider`);
  const mode = requireOneOf(raw['mode'], WORLD_BILLING_MODES, `${field}.mode`);
  const secret = readSecretName(raw['secret'], `${field}.secret`, secretNames);

  if (mode === 'live' && !authority.realMoney.enabled) {
    throw new UseSekaiConfigError(
      `${field}.mode: live requires authority.realMoney.enabled in the same environment; ` +
        'a real transaction without bounded real-money authority is not an authorized setup action. ' +
        'Use mode: test, or grant a bounded real-money budget explicitly.',
      `${field}.mode`,
      { reason: 'live_billing_without_authority', mode },
    );
  }

  const result: { -readonly [K in keyof WorldBillingConnector]: WorldBillingConnector[K] } = {
    provider,
    mode,
  };
  if (secret !== undefined) result.secret = secret;
  return Object.freeze(result);
}

function requireProvider(value: unknown, field: string): string {
  const provider = requireNonEmptyString(value, field, 128);
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new UseSekaiConfigError(
      `${field} must be a lowercase dotted token (e.g. "test-inbox")`,
      field,
      { reason: 'invalid_provider', received: provider },
    );
  }
  return provider;
}

function readSecretName(
  value: unknown,
  field: string,
  secretNames: ReadonlySet<string>,
): string | undefined {
  if (value === undefined) return undefined;
  const name = requireNonEmptyString(value, field, 64);
  if (!secretNames.has(name)) {
    throw new UseSekaiConfigError(
      `${field} references "${name}", which this environment's secrets: block does not declare`,
      field,
      { reason: 'unknown_secret_reference', name, declared: [...secretNames].sort() },
    );
  }
  return name;
}
