/**
 * Secret references: the configuration stores a reference and nothing
 * else (ADR-0011, issue #58).
 *
 * The properties asserted here are that a reference survives loading
 * byte-for-byte, that a value pasted where a reference belongs is
 * rejected, and — the one that is easy to get wrong — that *no
 * diagnostic ever contains the text it rejected*. A validation message
 * that echoes a leaked credential copies it into CI logs, test
 * snapshots and issue trackers, which is how a validation layer becomes
 * the thing that spreads the secret it was meant to catch.
 */

import { describe, expect, it } from 'vitest';
import {
  findConfiguredEnvironmentByName,
  findSecretReference,
  parseSecretReference,
  parseUseSekaiConfigText,
  UseSekaiConfigError,
} from '../../../src/config/index.js';
import { buildConfig, expectConfigError } from './support.js';

const provenance = { configPath: '/synthetic/u-sekai.yml', configPathSource: 'default' as const };

/** A document with one environment whose `secrets:` block is `secrets`. */
function withSecrets(secrets: unknown) {
  return parseUseSekaiConfigText(
    buildConfig({
      environments: {
        develop: { class: 'staging', url: 'https://staging.example.com', secrets },
      },
    }),
    provenance,
  );
}

const secretsOfDevelop = (secrets: unknown) =>
  findConfiguredEnvironmentByName(withSecrets(secrets), 'develop')?.secrets;

describe('a reference is preserved exactly', () => {
  it('round-trips a reference byte-for-byte', () => {
    const declared = secretsOfDevelop({ factory: '${secret:ACCOUNT_FACTORY_TOKEN}' });
    expect(declared).toEqual([{ name: 'factory', reference: '${secret:ACCOUNT_FACTORY_TOKEN}' }]);
  });

  it('preserves the reference through a full load', () => {
    const config = withSecrets({ factory: '${secret:ACCOUNT_FACTORY_TOKEN}' });
    const environment = findConfiguredEnvironmentByName(config, 'develop');
    expect(findSecretReference(config, environment!.id, 'factory')).toBe(
      '${secret:ACCOUNT_FACTORY_TOKEN}',
    );
  });

  it('keeps a reference unchanged whether or not the file quotes it', () => {
    // Quoting is a YAML-level spelling; the reference is the same string
    // either way, so reformatting a file changes nothing about what is
    // stored. Written by hand because the structured builder cannot
    // express a quoting difference — the JS value is identical.
    const bare = secretsOfDevelop({ factory: '${secret:ACCOUNT_FACTORY_TOKEN}' });
    const quoted = parseUseSekaiConfigText(
      [
        'version: 1',
        'product:',
        '  id: acme',
        'environments:',
        '  develop:',
        '    class: staging',
        '    url: https://staging.example.com',
        '    secrets:',
        "      factory: '${secret:ACCOUNT_FACTORY_TOKEN}'",
        '',
      ].join('\n'),
      provenance,
    );
    expect(bare?.[0]?.reference).toBe('${secret:ACCOUNT_FACTORY_TOKEN}');
    expect(
      findConfiguredEnvironmentByName(quoted, 'develop')?.secrets[0]?.reference,
    ).toBe('${secret:ACCOUNT_FACTORY_TOKEN}');
  });

  it('orders the registry by name, so the loaded form is order-independent', () => {
    const declared = secretsOfDevelop({
      zeta: '${secret:ZETA}',
      alpha: '${secret:ALPHA}',
    });
    expect(declared?.map((entry) => entry.name)).toEqual(['alpha', 'zeta']);
  });

  it('accepts an empty secrets block', () => {
    expect(secretsOfDevelop({})).toEqual([]);
  });
});

describe('a value pasted where a reference belongs is rejected', () => {
  it('rejects a bare string', () => {
    const error = expectConfigError(() => withSecrets({ factory: 'hunter2-correct-horse' }));
    expect(error.message).toMatch(/must be a \$\{secret:NAME\} reference/);
  });

  it('rejects a value without echoing it', () => {
    const secret = 'sk-live-DO-NOT-LOG-THIS-VALUE';
    const error = expectConfigError(() => withSecrets({ factory: secret }));
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.detail)).not.toContain(secret);
    expect(error.detail['reason']).toBe('not_a_secret_reference');
  });

  it('names the field, so an operator knows which entry to fix', () => {
    const error = expectConfigError(() => withSecrets({ billingKey: 'a-real-looking-value' }));
    expect(error.field).toContain('billingKey');
  });

  it('rejects a base64 blob, which is what a real credential looks like', () => {
    const error = expectConfigError(() => withSecrets({ factory: 'c2tfbGl2ZS1hYmMxMjM0NTY3ODkw' }));
    expect(error.message).toMatch(/never stores a secret value/);
  });

  it('rejects an inline assignment', () => {
    const error = expectConfigError(() => withSecrets({ factory: 'token=hunter2' }));
    expect(error.message).toMatch(/never stores a secret value/);
  });
});

describe('the reference grammar is closed', () => {
  it('rejects an env-var form, which is not an approved secret authority', () => {
    // The process environment is inherited by every child process, CI job
    // and log-capturing wrapper, so it is deliberately not a supported
    // reference target. Widening this needs its own threat model.
    const error = expectConfigError(() => withSecrets({ factory: '${env:ACCOUNT_FACTORY_TOKEN}' }));
    expect(error.message).toMatch(/never stores a secret value/);
  });

  it('rejects a file path', () => {
    const error = expectConfigError(() => withSecrets({ factory: '/etc/secrets/token' }));
    expect(error.message).toMatch(/never stores a secret value/);
  });

  it('rejects a URL', () => {
    const error = expectConfigError(() => withSecrets({ factory: 'https://secrets.example/token' }));
    expect(error.message).toMatch(/never stores a secret value/);
  });

  it('rejects an empty reference name', () => {
    const error = expectConfigError(() => withSecrets({ factory: '${secret:}' }));
    expect(error.message).toMatch(/never stores a secret value/);
  });

  it('rejects a lower-case reference name', () => {
    const error = expectConfigError(() => withSecrets({ factory: '${secret:account_token}' }));
    expect(error.message).toMatch(/uppercase reference name/);
  });

  it('rejects two references in one value', () => {
    const error = expectConfigError(() => withSecrets({ factory: '${secret:A}-${secret:B}' }));
    expect(error.message).toMatch(/never stores a secret value/);
  });

  it('rejects a reference with surrounding whitespace', () => {
    const error = expectConfigError(() => withSecrets({ factory: ' ${secret:A}' }));
    expect(error.message).toMatch(/never stores a secret value/);
  });

  it('rejects a non-string reference', () => {
    const error = expectConfigError(() => withSecrets({ factory: 12345 }));
    expect(error.message).toMatch(/must be a string holding a \$\{secret:NAME\} reference/);
  });

  it('rejects a registry name that is not a name', () => {
    const error = expectConfigError(() => withSecrets({ 'not-a-valid name': '${secret:A}' }));
    expect(error.message).toMatch(/must be a name of letters, digits and underscores/);
  });

  it('rejects a secrets block that is not a mapping', () => {
    const error = expectConfigError(() => withSecrets(['${secret:A}']));
    expect(error.message).toMatch(/secrets must be a mapping/);
  });
});

describe('one reference has one name', () => {
  it('rejects two registry entries naming the same reference', () => {
    // Otherwise "what is factory?" has two answers depending on which key
    // a reader happened to look at, and renaming one silently changes
    // what the other means.
    const error = expectConfigError(() =>
      withSecrets({ factory: '${secret:TOKEN}', fallback: '${secret:TOKEN}' }),
    );
    expect(error.message).toMatch(/already declares \$\{secret:TOKEN\}/);
  });
});

describe('the parser on its own', () => {
  it('returns the reference it was given', () => {
    expect(parseSecretReference('${secret:A_TOKEN_1}', 'x')).toBe('${secret:A_TOKEN_1}');
  });

  it('throws for anything else, without echoing it', () => {
    for (const bad of ['nope', '${secret:}', '${env:A}', '${secret:lower}', 'a-real-token', '']) {
      let thrown: unknown;
      try {
        parseSecretReference(bad, 'field');
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `expected a rejection for ${JSON.stringify(bad)}`).toBeInstanceOf(
        UseSekaiConfigError,
      );
      // An empty string is trivially "contained" in anything, so it is
      // excluded from the echo assertion; it is still asserted to throw.
      if (bad !== '') expect(JSON.stringify(thrown)).not.toContain(bad);
    }
  });
});
