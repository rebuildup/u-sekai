import { describe, it, expect } from 'vitest';
import {
  ALLOWED_STATE_RETENTION,
  assertRetentionAllowed,
  IDENTITY_LIFECYCLES,
  MAX_CONCURRENT_SESSIONS,
  parseIdentityCapabilityBounds,
  parseSyntheticIdentity,
  ProductDomainError,
  STATE_RETENTIONS,
} from '../../../src/product/index.js';

const base = {
  id: 'idn-alice',
  productId: 'prd-task-tracker',
  displayName: 'Alice',
  persona: 'A returning project lead.',
};

describe('Synthetic Identity construction', () => {
  it('declares all three ADR-0011 lifecycles', () => {
    expect(IDENTITY_LIFECYCLES).toEqual(['ephemeral', 'release', 'persistent']);
    expect(STATE_RETENTIONS).toEqual(['none', 'session', 'durable']);
  });

  it('accepts an ephemeral identity with no retained state', () => {
    const identity = parseSyntheticIdentity({
      ...base,
      lifecycle: 'ephemeral',
      capability: {
        maxConcurrentSessions: 1,
        stateRetention: 'none',
        permittedOrigins: ['https://staging.example'],
      },
    });
    expect(identity.lifecycle).toBe('ephemeral');
    expect('stateRef' in identity).toBe(false);
  });

  it('accepts a release identity with a state reference', () => {
    const identity = parseSyntheticIdentity({
      ...base,
      lifecycle: 'release',
      capability: {
        maxConcurrentSessions: 2,
        stateRetention: 'session',
        permittedOrigins: ['https://staging.example', 'https://beta.example'],
      },
      stateRef: 'alice:release:2026-10',
    });
    expect(identity.lifecycle).toBe('release');
    expect(identity.stateRef).toBe('alice:release:2026-10');
  });

  it('accepts a persistent identity with durable retention', () => {
    const identity = parseSyntheticIdentity({
      ...base,
      lifecycle: 'persistent',
      capability: {
        maxConcurrentSessions: 1,
        stateRetention: 'durable',
        permittedOrigins: ['https://staging.example'],
      },
      stateRef: 'alice/state/1',
    });
    expect(identity.capability.stateRetention).toBe('durable');
  });

  it('freezes the identity and its capability bounds', () => {
    const identity = parseSyntheticIdentity({
      ...base,
      lifecycle: 'persistent',
      capability: {
        maxConcurrentSessions: 1,
        stateRetention: 'durable',
        permittedOrigins: ['https://staging.example'],
      },
      stateRef: 'alice',
    });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.capability)).toBe(true);
    expect(Object.isFrozen(identity.capability.permittedOrigins)).toBe(true);
  });
});

describe('Synthetic Identity lifecycle / retention invariant', () => {
  const retentionFor = (lifecycle: string, stateRetention: string, stateRef?: string) =>
    () =>
      parseSyntheticIdentity({
        ...base,
        lifecycle,
        capability: {
          maxConcurrentSessions: 1,
          stateRetention,
          permittedOrigins: ['https://staging.example'],
        },
        ...(stateRef === undefined ? {} : { stateRef }),
      });

  it('permits exactly the documented retention matrix', () => {
    expect(ALLOWED_STATE_RETENTION).toEqual({
      ephemeral: ['none'],
      release: ['session', 'durable'],
      persistent: ['durable'],
    });
  });

  it('rejects every disallowed lifecycle/retention pair', () => {
    const disallowed: ReadonlyArray<[string, string]> = [
      ['ephemeral', 'session'],
      ['ephemeral', 'durable'],
      ['release', 'none'],
      ['persistent', 'none'],
      ['persistent', 'session'],
    ];
    for (const [lifecycle, stateRetention] of disallowed) {
      expect(
        retentionFor(lifecycle, stateRetention, 'ref'),
        `${lifecycle}/${stateRetention} must be rejected`,
      ).toThrow(/is not permitted for lifecycle/);
    }
  });

  it('permits every allowed lifecycle/retention pair', () => {
    const allowed: ReadonlyArray<[string, string]> = [
      ['ephemeral', 'none'],
      ['release', 'session'],
      ['release', 'durable'],
      ['persistent', 'durable'],
    ];
    for (const [lifecycle, stateRetention] of allowed) {
      const stateRef = stateRetention === 'none' ? undefined : 'ref';
      expect(
        retentionFor(lifecycle, stateRetention, stateRef),
        `${lifecycle}/${stateRetention} must be accepted`,
      ).not.toThrow();
    }
  });

  it('rejects a stateRef on an identity that may not retain state', () => {
    expect(retentionFor('ephemeral', 'none', 'alice')).toThrow(
      /must be absent when stateRetention is "none"/,
    );
  });

  it('requires a stateRef when the identity may retain state', () => {
    expect(retentionFor('persistent', 'durable')).toThrow(
      /stateRef is required when stateRetention is "durable"/,
    );
    expect(retentionFor('release', 'session')).toThrow(/stateRef is required/);
  });

  it('exposes the matrix for downstream resolution (#60)', () => {
    expect(() => assertRetentionAllowed('persistent', 'durable')).not.toThrow();
    expect(() => assertRetentionAllowed('persistent', 'none')).toThrow(ProductDomainError);
  });
});

describe('Synthetic Identity rejection', () => {
  it('rejects an unknown lifecycle or stateRetention', () => {
    expect(() =>
      parseSyntheticIdentity({
        ...base,
        lifecycle: 'forever',
        capability: { maxConcurrentSessions: 1, stateRetention: 'none', permittedOrigins: ['https://a.example'] },
      }),
    ).toThrow(/must be one of: ephemeral, release, persistent/);

    expect(() =>
      parseSyntheticIdentity({
        ...base,
        lifecycle: 'ephemeral',
        capability: {
          maxConcurrentSessions: 1,
          stateRetention: 'forever',
          permittedOrigins: ['https://a.example'],
        },
      }),
    ).toThrow(/must be one of: none, session, durable/);
  });

  it('rejects a missing, zero, negative or over-max session bound', () => {
    const withSessions = (maxConcurrentSessions: unknown) => () =>
      parseIdentityCapabilityBounds({
        maxConcurrentSessions,
        stateRetention: 'none',
        permittedOrigins: ['https://a.example'],
      });
    expect(withSessions(undefined)).toThrow(/must be an integer/);
    expect(withSessions(0)).toThrow(/between 1 and 16/);
    expect(withSessions(-1)).toThrow(/between 1 and 16/);
    expect(withSessions(1.5)).toThrow(/must be an integer/);
    expect(withSessions(MAX_CONCURRENT_SESSIONS + 1)).toThrow(/between 1 and 16/);
    expect(withSessions(MAX_CONCURRENT_SESSIONS)).not.toThrow();
  });

  it('rejects an empty, non-array, duplicate or malformed permittedOrigins', () => {
    const withOrigins = (permittedOrigins: unknown) => () =>
      parseIdentityCapabilityBounds({
        maxConcurrentSessions: 1,
        stateRetention: 'none',
        permittedOrigins,
      });
    expect(withOrigins([])).toThrow(/must be a non-empty array/);
    expect(withOrigins('https://a.example')).toThrow(/must be a non-empty array/);
    expect(withOrigins(['https://a.example', 'https://a.example/'])).toThrow(/duplicates/);
    expect(withOrigins(['not-a-url'])).toThrow(/must be an absolute URL/);
  });

  it('rejects an unknown field on the identity or its capability bounds', () => {
    expect(() =>
      parseSyntheticIdentity({
        ...base,
        lifecycle: 'ephemeral',
        capability: {
          maxConcurrentSessions: 1,
          stateRetention: 'none',
          permittedOrigins: ['https://a.example'],
        },
        password: 'x',
      }),
    ).toThrow(/unknown field\(s\): password/);

    expect(() =>
      parseIdentityCapabilityBounds({
        maxConcurrentSessions: 1,
        stateRetention: 'none',
        permittedOrigins: ['https://a.example'],
        canDeploy: true,
      }),
    ).toThrow(/unknown field\(s\): canDeploy/);
  });

  it('rejects a malformed stateRef', () => {
    for (const stateRef of ['', '  ', 'has space', 'has\nnewline', '?query=1']) {
      expect(() =>
        parseSyntheticIdentity({
          ...base,
          lifecycle: 'persistent',
          capability: {
            maxConcurrentSessions: 1,
            stateRetention: 'durable',
            permittedOrigins: ['https://a.example'],
          },
          stateRef,
        }),
        JSON.stringify(stateRef),
      ).toThrow(ProductDomainError);
    }
  });

  it('rejects an empty persona or displayName', () => {
    expect(() =>
      parseSyntheticIdentity({
        ...base,
        persona: '  ',
        lifecycle: 'ephemeral',
        capability: { maxConcurrentSessions: 1, stateRetention: 'none', permittedOrigins: ['https://a.example'] },
      }),
    ).toThrow(/persona must not be empty/);
  });
});
