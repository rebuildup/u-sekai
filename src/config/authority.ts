/**
 * The authority envelope declared per environment (issue #58).
 *
 * ## Fail-closed means absent is denied
 *
 * ADR-0011: "Real-money transactions, destructive production
 * mutation, irreversible actions, external communications, or use of
 * real identities require explicit opt-in". Every permission in this
 * module therefore defaults to *denied* and can only be granted by
 * writing it out.
 *
 * That is a stronger statement than "the defaults are off". It holds
 * for a missing `authority:` block, for a missing key inside a present
 * block, and for a key present with a non-boolean value — all three are
 * denied, and the two latter two are errors rather than denials,
 * because a typo in a permission name must not read as a refusal the
 * customer believes they have opted in to.
 *
 * ## A permission without a bound is not a permission
 *
 * `docs/product/configuration-and-authority.md` requires that an
 * enabled dangerous capability "provide an enforceable quantitative or
 * categorical boundary. Natural-language instruction alone is not an
 * adequate authorization mechanism." Hence `realMoney.enabled: true`
 * without a positive `maxAmount` is rejected, and
 * `crossOriginAccess: true` is rejected outright — 0.4.0 has no bounded
 * form of it, and an unbounded grant would be exactly the thing the ADR
 * forbids.
 *
 * ## This is a declaration, not an enforcement point
 *
 * Nothing here *performs* an action. This type records what the
 * repository authorises; #59's World Operator (`src/operator/**`) is
 * what consults it, and #63's runtime is what acts on it. Keeping the
 * declaration separate is what lets the envelope be reviewed as a
 * document — "what may u-sekai do here?" is answerable by reading this
 * file alone.
 */

import { UseSekaiConfigError } from './errors.js';
import {
  optionalString,
  rejectUnknownKeys,
  requireBoolean,
  requireFiniteNumber,
  requireMapping,
  requireNonEmptyMapping,
} from './validate.js';

export const AUTHORITY_KEYS = ['destructiveActions', 'externalCommunication', 'realMoney'] as const;

/**
 * Key a customer would reach for to allow acting outside the origins
 * the environment declares. Accepted only as `false`; see
 * `assertCrossOriginNotGranted`.
 */
export const CROSS_ORIGIN_KEY = 'crossOriginAccess';

/** Real-money authority, which is meaningless unless bounded. */
export interface RealMoneyAuthority {
  readonly enabled: boolean;
  /**
   * Ceiling in the currency the configured billing connector runs in.
   * Always `0` while `enabled` is `false`: a disabled permission with a
   * non-zero ceiling is a document that reads as more permissive than
   * it is.
   */
  readonly maxAmount: number;
  /** Optional free-text note; never a secret. */
  readonly note?: string;
}

export interface EnvironmentAuthority {
  /**
   * Allow irreversible or destructive mutation of this environment.
   * Includes irreversible account deletion and fixture resets.
   */
  readonly destructiveActions: boolean;
  /** Allow sending anything to a party outside the evaluation, e.g. a real inbox. */
  readonly externalCommunication: boolean;
  /** Allow spending real money. Always `{ enabled: false, maxAmount: 0 }` by default. */
  readonly realMoney: RealMoneyAuthority;
}

/** What the whole envelope denies when a file says nothing. */
export function deniedAuthority(): EnvironmentAuthority {
  return Object.freeze({
    destructiveActions: false,
    externalCommunication: false,
    realMoney: Object.freeze({ enabled: false, maxAmount: 0 }),
  });
}

/**
 * Parse an `authority:` block.
 *
 * @param value  the block, or `undefined` when the environment declares none
 * @param field  dotted path used in diagnostics
 * @returns `'file'` when the block was present, `'default'` when it was omitted
 */
export function parseEnvironmentAuthority(
  value: unknown,
  field: string,
): { readonly authority: EnvironmentAuthority; readonly source: 'file' | 'default' } {
  if (value === undefined) {
    return { authority: deniedAuthority(), source: 'default' };
  }

  const raw = requireNonEmptyMapping(value, field);
  rejectUnknownKeys(raw, [...AUTHORITY_KEYS, CROSS_ORIGIN_KEY], field);

  assertCrossOriginNotGranted(raw[CROSS_ORIGIN_KEY], `${field}.${CROSS_ORIGIN_KEY}`);

  const destructiveActions = readPermission(
    raw['destructiveActions'],
    `${field}.destructiveActions`,
  );
  const externalCommunication = readPermission(
    raw['externalCommunication'],
    `${field}.externalCommunication`,
  );
  const realMoney = parseRealMoneyAuthority(raw['realMoney'], `${field}.realMoney`);

  return {
    source: 'file',
    authority: Object.freeze({ destructiveActions, externalCommunication, realMoney }),
  };
}

function readPermission(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  return requireBoolean(value, field);
}

function parseRealMoneyAuthority(value: unknown, field: string): RealMoneyAuthority {
  if (value === undefined) {
    return Object.freeze({ enabled: false, maxAmount: 0 });
  }

  const raw = requireMapping(value, field);
  rejectUnknownKeys(raw, ['enabled', 'maxAmount', 'note'], field);

  const enabled = raw['enabled'] === undefined ? false : requireBoolean(raw['enabled'], `${field}.enabled`);
  const hasMaxAmount = raw['maxAmount'] !== undefined;
  const maxAmount =
    hasMaxAmount
      ? requireFiniteNumber(raw['maxAmount'], `${field}.maxAmount`, 0)
      : 0;
  const note = optionalString(raw['note'], `${field}.note`, 500);

  if (enabled && maxAmount <= 0) {
    throw new UseSekaiConfigError(
      `${field}.maxAmount must be greater than 0 when real-money authority is enabled; ` +
        'an unbounded real-money grant is not an authorization',
      `${field}.maxAmount`,
      { reason: 'unbounded_permission', enabled },
    );
  }
  if (!enabled && maxAmount > 0) {
    throw new UseSekaiConfigError(
      `${field}.maxAmount requires \`enabled: true\`; a ceiling with the permission off is ambiguous`,
      `${field}.maxAmount`,
      { reason: 'unreachable_budget', enabled, maxAmount },
    );
  }

  const result: { -readonly [K in keyof RealMoneyAuthority]: RealMoneyAuthority[K] } = {
    enabled,
    maxAmount: enabled ? maxAmount : 0,
  };
  if (note !== undefined) {
    result.note = note;
  }
  return Object.freeze(result);
}

/**
 * `crossOriginAccess` is accepted only as an explicit `false`.
 *
 * The key exists so the refusal is legible in the file: a customer who
 * wants to reach past the environment's declared origins gets told
 * exactly that 0.4.0 cannot bound it, instead of getting a key that
 * silently does nothing. Omitting the key is the same as `false`.
 */
function assertCrossOriginNotGranted(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!requireBoolean(value, field)) return;
  throw new UseSekaiConfigError(
    `${field}: true is not supported. An identity may only operate within origins its ` +
      'environment declares; 0.4.0 has no bounded form of cross-origin authority, so it cannot be granted.',
    field,
    { reason: 'unbounded_permission' },
  );
}
