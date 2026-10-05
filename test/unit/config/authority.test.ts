/**
 * The authority envelope: what `u-sekai.yml` permits, and the rule that
 * nothing is permitted unless it is written down (issue #58).
 *
 * ADR-0011 requires that "real-money transactions, destructive
 * production mutation, irreversible actions, external communications,
 * or use of real identities require explicit opt-in", and the 0.4.0
 * product document adds that an enabled dangerous capability must carry
 * "an enforceable quantitative or categorical boundary" and that
 * "natural-language instruction alone is not an adequate authorization
 * mechanism".
 *
 * So the properties asserted here are: absent is denied, a permission
 * without a bound is refused, and the one permission that has no bounded
 * form cannot be granted at all.
 */

import { describe, expect, it } from 'vitest';
import { deniedAuthority, findConfiguredEnvironmentByName } from '../../../src/config/index.js';
import { buildConfig, configFrom, expectConfigError } from './support.js';
import { parseUseSekaiConfigText } from '../../../src/config/index.js';

const provenance = { configPath: '/synthetic/u-sekai.yml', configPathSource: 'default' as const };

/** Load a document with one `staging` environment carrying `authority`. */
function withAuthority(authority?: unknown) {
  return parseUseSekaiConfigText(
    buildConfig({
      environments: {
        develop: {
          class: 'staging',
          url: 'https://staging.example.com',
          ...(authority === undefined ? {} : { authority }),
        },
      },
    }),
    provenance,
  );
}

const authorityOfDevelop = () => findConfiguredEnvironmentByName(withAuthority(), 'develop')?.authority;

describe('absent is denied', () => {
  it('denies everything when no environment declares an authority block', () => {
    expect(authorityOfDevelop()).toEqual({
      destructiveActions: false,
      externalCommunication: false,
      realMoney: { enabled: false, maxAmount: 0 },
    });
  });

  it('records that the envelope came from the default, not the file', () => {
    const environment = findConfiguredEnvironmentByName(withAuthority(), 'develop');
    expect(environment?.authoritySource).toBe('default');
  });

  it('records that an explicit block came from the file', () => {
    const environment = findConfiguredEnvironmentByName(
      withAuthority({ destructiveActions: false }),
      'develop',
    );
    expect(environment?.authoritySource).toBe('file');
  });

  it('denies each permission individually when its key is absent', () => {
    // A block that grants one thing must not silently grant the others:
    // the omitted keys resolve to denied, and the granted one is honoured.
    const onlyDestructive = findConfiguredEnvironmentByName(
      withAuthority({ destructiveActions: true }),
      'develop',
    )?.authority;

    expect(onlyDestructive).toEqual({
      destructiveActions: true,
      externalCommunication: false,
      realMoney: { enabled: false, maxAmount: 0 },
    });
  });

  it('denies real money when the block is present but realMoney is absent', () => {
    // A block that names one permission leaves the others denied; the
    // omitted one must not inherit a grant from the block's presence.
    const authority = findConfiguredEnvironmentByName(
      withAuthority({ externalCommunication: false }),
      'develop',
    )?.authority;
    expect(authority?.realMoney).toEqual({ enabled: false, maxAmount: 0 });
  });

  it('rejects an empty authority block rather than reading it as "all denied by choice"', () => {
    // An empty block is a customer who believes they wrote something.
    // Denying it is the same outcome, so rejecting it costs nothing and
    // surfaces the mistake.
    const error = expectConfigError(() => withAuthority({}));
    expect(error.message).toMatch(/must declare at least one entry/);
  });

  it('exposes the same denied envelope as a constant', () => {
    expect(deniedAuthority()).toEqual({
      destructiveActions: false,
      externalCommunication: false,
      realMoney: { enabled: false, maxAmount: 0 },
    });
  });
});

describe('permissions require an explicit opt-in', () => {
  it('grants destructive actions when written down', () => {
    const authority = findConfiguredEnvironmentByName(
      withAuthority({ destructiveActions: true }),
      'develop',
    )?.authority;
    expect(authority?.destructiveActions).toBe(true);
  });

  it('grants external communication when written down', () => {
    const authority = findConfiguredEnvironmentByName(
      withAuthority({ externalCommunication: true }),
      'develop',
    )?.authority;
    expect(authority?.externalCommunication).toBe(true);
  });

  it('grants destructive actions against production, which is a supported opt-in', () => {
    // ADR-0011 permits production under explicit opt-in. The envelope is
    // where that opt-in lives, so refusing it here would remove a
    // capability the ADR deliberately allows.
    const config = parseUseSekaiConfigText(
      buildConfig({
        environments: {
          production: {
            class: 'production',
            url: 'https://app.example.com',
            authority: { destructiveActions: true },
          },
        },
      }),
      provenance,
    );
    const authority = findConfiguredEnvironmentByName(config, 'production')?.authority;
    expect(authority?.destructiveActions).toBe(true);
  });
});

describe('real money is bounded or refused', () => {
  it('rejects an enabled real-money permission with no ceiling', () => {
    // The central rule from the 0.4.0 product document: an unbounded
    // grant is not an authorization, so it is an error rather than a
    // grant with an implicit limit.
    const error = expectConfigError(() => withAuthority({ realMoney: { enabled: true } }));
    expect(error.message).toMatch(/unbounded real-money grant is not an authorization/);
  });

  it('rejects an enabled real-money permission with a zero ceiling', () => {
    const error = expectConfigError(() => withAuthority({ realMoney: { enabled: true, maxAmount: 0 } }));
    expect(error.message).toMatch(/must be greater than 0 when real-money authority is enabled/);
  });

  it('accepts an enabled real-money permission with a ceiling', () => {
    const authority = findConfiguredEnvironmentByName(
      withAuthority({ realMoney: { enabled: true, maxAmount: 25 } }),
      'develop',
    )?.authority;
    expect(authority?.realMoney).toEqual({ enabled: true, maxAmount: 25 });
  });

  it('keeps a note beside a real-money grant', () => {
    const authority = findConfiguredEnvironmentByName(
      withAuthority({ realMoney: { enabled: true, maxAmount: 25, note: 'One refund rehearsal per sprint.' } }),
      'develop',
    )?.authority;
    expect(authority?.realMoney.note).toBe('One refund rehearsal per sprint.');
  });

  it('rejects a ceiling with the permission off, which is ambiguous', () => {
    const error = expectConfigError(() => withAuthority({ realMoney: { enabled: false, maxAmount: 500 } }));
    expect(error.message).toMatch(/requires `enabled: true`/);
  });

  it('rejects a negative ceiling', () => {
    const error = expectConfigError(() => withAuthority({ realMoney: { enabled: true, maxAmount: -1 } }));
    expect(error.message).toMatch(/maxAmount must be >= 0/);
  });

  it('rejects a real-money block that is not a mapping', () => {
    const error = expectConfigError(() => withAuthority({ realMoney: true }));
    expect(error.message).toMatch(/realMoney must be a mapping/);
  });

  it('rejects an unknown key inside realMoney', () => {
    const error = expectConfigError(() =>
      withAuthority({ realMoney: { enabled: true, maxAmount: 5, currency: 'JPY' } }),
    );
    expect(error.message).toMatch(/unknown key\(s\): currency/);
  });
});

describe('cross-origin access cannot be granted', () => {
  it('rejects an explicit true', () => {
    // 0.4.0 has no bounded form of cross-origin authority, so the only
    // honest answer is to refuse the grant rather than accept an
    // unbounded one.
    const error = expectConfigError(() => withAuthority({ crossOriginAccess: true }));
    expect(error.message).toMatch(/no bounded form of cross-origin authority/);
  });

  it('accepts an explicit false, so the refusal can be written down', () => {
    const authority = findConfiguredEnvironmentByName(
      withAuthority({ crossOriginAccess: false }),
      'develop',
    )?.authority;
    expect(authority?.destructiveActions).toBe(false);
    expect(authority?.externalCommunication).toBe(false);
  });

  it('is refused by a non-boolean too, rather than being read as false', () => {
    const error = expectConfigError(() => withAuthority({ crossOriginAccess: 'no' }));
    expect(error.message).toMatch(/must be true or false/);
  });
});

describe('no implicit cross-origin permission', () => {
  it('confines an identity that names no origins to the declared ones', () => {
    const config = parseUseSekaiConfigText(
      configFrom({
        version: 1,
        product: { id: 'acme' },
        environments: {
          staging: { class: 'staging', url: 'https://staging.example.com' },
          production: { class: 'production', url: 'https://app.example.com' },
        },
        identities: { avery: { lifecycle: 'ephemeral', persona: 'A visitor.' } },
      }),
      provenance,
    );
    // The union of declared environment origins, sorted — never the whole
    // internet, and never one environment's origins implicitly.
    expect(config.model.identities[0]?.capability.permittedOrigins).toEqual([
      'https://app.example.com',
      'https://staging.example.com',
    ]);
  });

  it('refuses an identity scoped to an origin no environment declares', () => {
    const error = expectConfigError(() =>
      parseUseSekaiConfigText(
        buildConfig({
          environments: { staging: { class: 'staging', url: 'https://staging.example.com' } },
          identities: {
            avery: {
              lifecycle: 'ephemeral',
              persona: 'A visitor.',
              permittedOrigins: ['https://third-party.example'],
            },
          },
        }),
        provenance,
      ),
    );
    expect(error.message).toMatch(/may only contain origins some environment declares/);
  });
});

describe('billing mode is gated on real-money authority', () => {
  const withBilling = (mode: string, authority?: unknown) =>
    parseUseSekaiConfigText(
      buildConfig({
        environments: {
          develop: {
            class: 'staging',
            url: 'https://staging.example.com',
            ...(authority === undefined ? {} : { authority }),
            world: { billing: { provider: 'stripe', mode } },
          },
        },
      }),
      provenance,
    );

  it('accepts sandbox billing with no authority at all', () => {
    // The documented preference order starts with sandbox/test mode, so
    // the common case must not require opting into anything.
    const world = findConfiguredEnvironmentByName(withBilling('test'), 'develop')?.world;
    expect(world?.billing).toEqual({ provider: 'stripe', mode: 'test' });
  });

  it('rejects live billing with no real-money authority', () => {
    // The conflation the 0.4.0 product document warns against: a real
    // transaction authorised by nothing but a billing connector.
    const error = expectConfigError(() => withBilling('live'));
    expect(error.message).toMatch(/requires authority\.realMoney\.enabled/);
  });

  it('rejects live billing when real money is enabled without a ceiling', () => {
    const error = expectConfigError(() => withBilling('live', { realMoney: { enabled: true } }));
    // The unbounded grant is refused first, for the same reason it is
    // refused anywhere else.
    expect(error.message).toMatch(/unbounded real-money grant/);
  });

  it('accepts live billing once real money is bounded', () => {
    const world = findConfiguredEnvironmentByName(
      withBilling('live', { realMoney: { enabled: true, maxAmount: 10 } }),
      'develop',
    )?.world;
    expect(world?.billing).toEqual({ provider: 'stripe', mode: 'live' });
  });

  it('rejects a billing connector with no mode', () => {
    // "unset" is genuinely ambiguous between sandbox and real, so there
    // is no default for it.
    const error = expectConfigError(() =>
      parseUseSekaiConfigText(
        buildConfig({
          environments: {
            develop: {
              class: 'staging',
              url: 'https://staging.example.com',
              world: { billing: { provider: 'stripe' } },
            },
          },
        }),
        provenance,
      ),
    );
    expect(error.message).toMatch(/billing\.mode must be a string/);
  });

  it('rejects an unknown billing mode', () => {
    const error = expectConfigError(() => withBilling('prod'));
    expect(error.message).toMatch(/mode must be one of: test, live/);
  });

  it('rejects an account connector with no endpoint', () => {
    const error = expectConfigError(() =>
      parseUseSekaiConfigText(
        buildConfig({
          environments: {
            develop: {
              class: 'staging',
              url: 'https://staging.example.com',
              world: { accounts: { provider: 'http' } },
            },
          },
        }),
        provenance,
      ),
    );
    expect(error.message).toMatch(/accounts\.endpoint must be a string/);
  });

  it('rejects a non-lowercase provider token', () => {
    const error = expectConfigError(() =>
      parseUseSekaiConfigText(
        buildConfig({
          environments: {
            develop: {
              class: 'staging',
              url: 'https://staging.example.com',
              world: { email: { provider: 'Test Inbox' } },
            },
          },
        }),
        provenance,
      ),
    );
    expect(error.message).toMatch(/must be a lowercase dotted token/);
  });
});

describe('dangerous classes with no representation', () => {
  // `docs/product/configuration-and-authority.md` lists irreversible
  // account deletion and use of a real person's identity among the
  // explicitly dangerous classes. 0.4.0 has modelled no key that can
  // enable either, which means they cannot be enabled at all. These
  // tests pin that: adding a later ticket that models one must also
  // revisit this expectation.
  it('has no key that enables irreversible account deletion', () => {
    for (const key of ['irreversibleDeletion', 'deleteAccounts', 'accountDeletion']) {
      const error = expectConfigError(() => withAuthority({ [key]: true }));
      expect(error.message).toMatch(/unknown key/);
    }
  });

  it('has no key that enables using a real identity', () => {
    for (const key of ['realIdentities', 'impersonation', 'useRealCredentials']) {
      const error = expectConfigError(() => withAuthority({ [key]: true }));
      expect(error.message).toMatch(/unknown key/);
    }
  });

  it('has no key that enables posting publicly', () => {
    for (const key of ['publicPosting', 'postPublicly']) {
      const error = expectConfigError(() => withAuthority({ [key]: true }));
      expect(error.message).toMatch(/unknown key/);
    }
  });
});
