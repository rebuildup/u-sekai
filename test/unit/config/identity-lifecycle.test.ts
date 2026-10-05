/**
 * The identity lifecycle / state-retention matrix as `u-sekai.yml`
 * expresses it (issue #58, against #57's discriminated `SyntheticIdentity`).
 *
 * ## Why this file exists
 *
 * #57 models `SyntheticIdentity` as a union discriminated on `lifecycle`,
 * so narrowing on the lifecycle makes `capability.stateRetention` a
 * literal type. That is a compile-time guarantee for code that *builds* an
 * identity — and `u-sekai.yml` is not code, so the runtime check stays
 * authoritative for it. That creates the specific hazard this suite
 * exists to close: a validator that narrows or casts an identity to get
 * past the type system has defeated its own purpose, because the value
 * then arrives at the durable model unvalidated.
 *
 * Every case below is therefore stated as a *literal an author could
 * actually write*, fed through the real loader, and asserted to be
 * rejected with a typed `UseSekaiConfigError`. None of them is a cast, and
 * none is a hand-built domain value.
 */

import { describe, expect, it } from 'vitest';
import {
  ALLOWED_STATE_RETENTION,
  IDENTITY_LIFECYCLES,
  STATE_RETENTIONS,
  parseSyntheticIdentity,
  type IdentityLifecycle,
  type StateRetention,
} from '../../../src/product/index.js';
import { parseUseSekaiConfigText, UseSekaiConfigError } from '../../../src/config/index.js';
import { buildConfig, expectConfigError } from './support.js';

const provenance = { configPath: '/synthetic/u-sekai.yml', configPathSource: 'default' as const };

/** A document whose single identity carries `identity` verbatim. */
function withIdentity(identity: Record<string, unknown>): string {
  return buildConfig({
    identities: { avery: identity },
  });
}

const loadIdentity = (identity: Record<string, unknown>) =>
  parseUseSekaiConfigText(withIdentity(identity), provenance);

/** Every (lifecycle, retention) pair the file could state. */
const MATRIX: ReadonlyArray<readonly [IdentityLifecycle, StateRetention]> = (
  ['ephemeral', 'release', 'persistent'] as const
).flatMap((lifecycle) =>
  (['none', 'session', 'durable'] as const).map(
    (retention) => [lifecycle, retention] as const,
  ),
);

describe('a lifecycle is required, and must be one the domain knows', () => {
  it('rejects an identity that omits lifecycle', () => {
    // The literal a cast would let through. `lifecycle` is what
    // discriminates the union, so an identity without one has no defined
    // retention and must not reach the model.
    const error = expectConfigError(() =>
      loadIdentity({ persona: 'A long-time user.', stateRetention: 'durable' }),
    );
    expect(error).toBeInstanceOf(UseSekaiConfigError);
    expect(error.field).toBe('/synthetic/u-sekai.yml.identities.avery.lifecycle');
    expect(error.message).toMatch(/lifecycle must be a string/);
  });

  it('rejects a lifecycle the domain does not define', () => {
    const error = expectConfigError(() =>
      loadIdentity({ lifecycle: 'immortal', persona: 'A long-time user.' }),
    );
    expect(error.message).toMatch(/lifecycle must be one of: ephemeral, release, persistent/);
    expect(error.detail['reason']).toBe('not_in_enum');
  });

  it.each(IDENTITY_LIFECYCLES)('accepts the defined lifecycle "%s"', (lifecycle) => {
    const needsStateRef = ALLOWED_STATE_RETENTION[lifecycle][0] !== 'none';
    expect(() =>
      loadIdentity({
        lifecycle,
        persona: 'A simulated person in a specific situation.',
        ...(needsStateRef ? { stateRef: 'identity/avery' } : {}),
      }),
    ).not.toThrow();
  });
});

describe('retention is a function of the lifecycle', () => {
  it.each(MATRIX)('rejects or accepts %s + %s exactly as the domain does', (lifecycle, retention) => {
    const permitted = ALLOWED_STATE_RETENTION[lifecycle].includes(retention);
    const identity = {
      lifecycle,
      persona: 'A simulated person in a specific situation.',
      stateRetention: retention,
      // Retaining anything at all requires somewhere to keep it.
      ...(retention === 'none' ? {} : { stateRef: 'identity/avery' }),
    };

    if (permitted) {
      const config = loadIdentity(identity);
      const parsed = config.model.identities[0];
      expect(parsed?.capability.stateRetention).toBe(retention);
      expect(parsed?.lifecycle).toBe(lifecycle);
      return;
    }

    // The mismatch is rejected here, in the configuration layer, with the
    // file's own field — not left to the domain to notice one layer down,
    // and never widened or cast into agreement.
    const error = expectConfigError(() => loadIdentity(identity));
    expect(error.field).toBe('/synthetic/u-sekai.yml.identities.avery.stateRetention');
    expect(error.message).toContain(retention);
    expect(error.message).toContain(lifecycle);
  });

  it('rejects a uniform retention, which is wrong for two of three lifecycles', () => {
    // The mistake this rule exists to catch: an author who writes the
    // same stateRetention for every identity. `durable` is illegal for an
    // ephemeral identity, so the file is refused as a whole rather than
    // loading with one identity quietly mis-declared.
    const error = expectConfigError(() =>
      parseUseSekaiConfigText(
        buildConfig({
          identities: {
            avery: {
              lifecycle: 'persistent',
              persona: 'A long-time user.',
              stateRetention: 'durable',
              stateRef: 'identity/avery',
            },
            casey: {
              lifecycle: 'ephemeral',
              persona: 'A first-time visitor.',
              stateRetention: 'durable',
              stateRef: 'identity/casey',
            },
          },
        }),
        provenance,
      ),
    );
    expect(error.field).toBe('/synthetic/u-sekai.yml.identities.casey.stateRetention');
    expect(error.message).toMatch(/not permitted for lifecycle "ephemeral"/);
  });

  it('rejects a retention value that is not a retention at all', () => {
    const error = expectConfigError(() =>
      loadIdentity({
        lifecycle: 'persistent',
        persona: 'A long-time user.',
        stateRetention: 'forever',
        stateRef: 'identity/avery',
      }),
    );
    expect(error.message).toMatch(/stateRetention must be one of: none, session, durable/);
  });
});

describe('an omitted retention defaults to the least the lifecycle admits', () => {
  it.each([
    ['ephemeral', 'none'],
    ['release', 'session'],
    ['persistent', 'durable'],
  ] as const)('gives a %s identity "%s"', (lifecycle, expected) => {
    const needsStateRef = expected !== 'none';
    const config = loadIdentity({
      lifecycle,
      persona: 'A simulated person in a specific situation.',
      ...(needsStateRef ? { stateRef: 'identity/avery' } : {}),
    });
    expect(config.model.identities[0]?.capability.stateRetention).toBe(expected);
  });

  it('prefers session over durable for a release identity, which may retain both', () => {
    // Both are legal for `release`, so this is a real choice rather than a
    // forced one: `session` is the lesser, and durable retention across a
    // release has to be written down.
    const config = loadIdentity({
      lifecycle: 'release',
      persona: 'A user who signed up during a trial.',
      stateRef: 'identity/avery',
    });
    expect(config.model.identities[0]?.capability.stateRetention).toBe('session');
  });
});

describe('the default and the domain table cannot drift apart', () => {
  // `defaultRetentionFor` switches on the lifecycle rather than indexing
  // `ALLOWED_STATE_RETENTION`, because the switch lets the compiler check
  // it against `IDENTITY_LIFECYCLES` and fail if a lifecycle is added. The
  // cost of that is a four-line copy of the table, and this is what stops
  // the copy going stale.
  it.each(IDENTITY_LIFECYCLES)(
    'the configured default for "%s" is the first retention the domain admits',
    async (lifecycle) => {
      const first = ALLOWED_STATE_RETENTION[lifecycle][0];
      expect(first).toBeDefined();
      const needsStateRef = first !== 'none';
      const config = loadIdentity({
        lifecycle,
        persona: 'A simulated person in a specific situation.',
        ...(needsStateRef ? { stateRef: 'identity/avery' } : {}),
      });
      expect(config.model.identities[0]?.capability.stateRetention).toBe(first);
    },
  );
});

describe('stateRef agrees with the resolved retention', () => {
  it('rejects a retained identity with no stateRef', () => {
    // The loader will not invent a storage location for durable state;
    // that is #60's to define.
    const error = expectConfigError(() =>
      loadIdentity({ lifecycle: 'persistent', persona: 'A long-time user.' }),
    );
    expect(error.message).toMatch(/stateRef is required for an identity that retains state/);
  });

  it('rejects a stateRef on an identity that retains nothing', () => {
    const error = expectConfigError(() =>
      loadIdentity({ lifecycle: 'ephemeral', persona: 'A visitor.', stateRef: 'identity/avery' }),
    );
    expect(error.message).toMatch(/stateRef must be absent when stateRetention is "none"/);
  });
});

describe('the loader validates rather than casts', () => {
  // The load-bearing property behind every case above: what reaches the
  // domain is a plain object the loader built from validated parts, and
  // the domain's own parser — not a narrowed or asserted identity —
  // decides whether it is well-formed.
  it('hands the domain a plain object, not a pre-typed identity', () => {
    // A shape the loader could only produce by asserting a type: a
    // lifecycle/retention contradiction. The domain rejects it, which is
    // only observable because the loader passed `unknown` through rather
    // than a narrowed identity type.
    expect(() =>
      parseSyntheticIdentity(
        { lifecycle: 'ephemeral', capability: { stateRetention: 'durable' } },
        'literal',
      ),
    ).toThrow();

    // And the same contradiction arriving through the file is rejected
    // before it can be built at all.
    expect(() =>
      loadIdentity({
        lifecycle: 'ephemeral',
        persona: 'A visitor.',
        stateRef: 'identity/avery',
        stateRetention: 'durable',
      }),
    ).toThrow(UseSekaiConfigError);
  });

  it('reports a retention contradiction as a config error, never as a TypeError', () => {
    let thrown: unknown;
    try {
      loadIdentity({
        lifecycle: 'persistent',
        persona: 'A long-time user.',
        stateRetention: 'session',
        stateRef: 'identity/avery',
      });
    } catch (error) {
      thrown = error;
    }
    // #57's deep-parsing change means malformed input yields a typed
    // domain error rather than a raw TypeError; the configuration layer
    // must not be the thing that reintroduces one.
    expect(thrown).toBeInstanceOf(UseSekaiConfigError);
    expect(thrown).not.toBeInstanceOf(TypeError);
  });

  it('rejects an identity with no persona, since a persona has no safe default', () => {
    const error = expectConfigError(() => loadIdentity({ lifecycle: 'ephemeral' }));
    expect(error.field).toBe('/synthetic/u-sekai.yml.identities.avery.persona');
  });

  it.each(STATE_RETENTIONS)('resolves retention "%s" for an ephemeral identity', (retention) => {
    // Every retention reaches the same validation point, and each one
    // either loads or is refused as a typed config error with a
    // file-relative field. `none` is the only one legal here, so it is the
    // case that must load rather than throw.
    const legal = ALLOWED_STATE_RETENTION['ephemeral'].includes(retention);
    let thrown: unknown;
    try {
      loadIdentity({
        lifecycle: 'ephemeral',
        persona: 'A visitor.',
        stateRetention: retention,
        ...(retention === 'none' ? {} : { stateRef: 'identity/avery' }),
      });
    } catch (error) {
      thrown = error;
    }

    if (legal) {
      expect(thrown, `retention "${retention}" should load`).toBeUndefined();
      return;
    }
    expect(thrown, `retention "${retention}" should be rejected`).toBeInstanceOf(UseSekaiConfigError);
    expect((thrown as UseSekaiConfigError).field).toContain('identities.avery.stateRetention');
  });
});
