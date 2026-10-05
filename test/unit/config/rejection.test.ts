/**
 * The rejecting side of the schema: an unrecognised key, a missing
 * required key, a wrong type, or a reference that resolves to nothing
 * is a hard failure (issue #58).
 *
 * The property under test throughout is that nothing is *silently
 * dropped*. Every case here would, under a lenient loader, produce a
 * configuration that looks valid while a setting the file named was
 * ignored — which is the failure mode that makes a "validated"
 * configuration surface worse than an unvalidated one.
 */

import { describe, expect, it } from 'vitest';
import { ProductDomainError } from '../../../src/product/index.js';
import { asConfigError, parseUseSekaiConfigText, UseSekaiConfigError } from '../../../src/config/index.js';
import { buildConfig, configFrom, expectConfigError } from './support.js';

const provenance = { configPath: '/synthetic/u-sekai.yml', configPathSource: 'default' as const };
const load = (overrides: Record<string, unknown> = {}) =>
  parseUseSekaiConfigText(buildConfig(overrides), provenance);

/** A document with one staging environment, a cohort and a program. */
function fullDocument(): Record<string, unknown> {
  return {
    environments: {
      staging: {
        class: 'staging',
        url: 'https://staging.example.com',
        secrets: { factory: '${secret:FACTORY}' },
        world: { accounts: { provider: 'http', endpoint: 'https://staging.example.com/support' } },
      },
    },
    cohorts: { regulars: { lifecycle: 'persistent', size: 5 } },
    reviewPrograms: {
      continuous: { environment: 'staging', cohort: 'regulars', trigger: { manual: true } },
    },
  };
}

describe('unknown keys', () => {
  it('rejects an unknown root key', () => {
    const error = expectConfigError(() => load({ browsers: { chromium: {} } }));
    expect(error.message).toMatch(/unknown key\(s\): browsers/);
    expect(error.detail['reason']).toBe('unknown_key');
  });

  it('rejects an unknown product key', () => {
    const error = expectConfigError(() => load({ product: { id: 'acme', model: 'gpt-4' } }));
    expect(error.message).toMatch(/unknown key\(s\): model/);
  });

  it('rejects a model or browser choice, which ADR-0011 keeps internal', () => {
    // A customer pasting a vendor choice into the file is the most likely
    // source of a key that means nothing here. It must fail loudly rather
    // than be dropped, so the file cannot read as though it took effect.
    for (const key of ['model', 'browser', 'provider', 'reasoner']) {
      const error = expectConfigError(() => load({ [key]: 'anything' }));
      expect(error.message).toMatch(/unknown key/);
    }
  });

  it('rejects an unknown environment key', () => {
    const error = expectConfigError(() =>
      load({ environments: { develop: { class: 'develop', url: 'https://d.example.com', branch: 'main' } } }),
    );
    expect(error.message).toMatch(/unknown key\(s\): branch/);
  });

  it('rejects a Git-shaped environment, which ADR-0011 refuses to model', () => {
    const error = expectConfigError(() =>
      load({
        environments: {
          develop: {
            class: 'develop',
            url: 'https://d.example.com',
            deployment: { ref: 'refs/heads/main', commitSha: 'deadbeef' },
          },
        },
      }),
    );
    expect(error.message).toMatch(/unknown key\(s\): deployment/);
  });

  it('rejects an unknown identity, cohort and program key', () => {
    const identity = expectConfigError(() =>
      load({ identities: { avery: { lifecycle: 'ephemeral', persona: 'A visitor.', traits: ['x'] } } }),
    );
    expect(identity.message).toMatch(/unknown key\(s\): traits/);

    const cohort = expectConfigError(() =>
      load({ cohorts: { regulars: { lifecycle: 'persistent', size: 5, region: 'eu' } } }),
    );
    expect(cohort.message).toMatch(/unknown key\(s\): region/);

    const program = expectConfigError(() =>
      load({
        ...fullDocument(),
        reviewPrograms: {
          continuous: { environment: 'staging', cohort: 'regulars', trigger: { manual: true }, onFailure: 'retry' },
        },
      }),
    );
    expect(program.message).toMatch(/unknown key\(s\): onFailure/);
  });

  it('rejects an unknown authority key', () => {
    const error = expectConfigError(() =>
      load({ environments: { develop: { class: 'develop', url: 'https://d.example.com', authority: { destructive: true } } } }),
    );
    expect(error.message).toMatch(/unknown key\(s\): destructive/);
  });

  it('rejects an unknown World connector key', () => {
    const error = expectConfigError(() =>
      load({
        environments: {
          develop: {
            class: 'develop',
            url: 'https://d.example.com',
            world: { accounts: { provider: 'http', endpoint: 'https://d.example.com/s', retries: 3 } },
          },
        },
      }),
    );
    expect(error.message).toMatch(/unknown key\(s\): retries/);
  });

  it('rejects an unknown World connector', () => {
    const error = expectConfigError(() =>
      load({
        environments: {
          develop: {
            class: 'develop',
            url: 'https://d.example.com',
            world: { database: { provider: 'sql' } },
          },
        },
      }),
    );
    expect(error.message).toMatch(/unknown key\(s\): database/);
  });

  it('rejects an unknown budget key', () => {
    const error = expectConfigError(() =>
      load({
        ...fullDocument(),
        reviewPrograms: {
          continuous: {
            environment: 'staging',
            cohort: 'regulars',
            trigger: { manual: true },
            budget: { maxSpendInCents: 500 },
          },
        },
      }),
    );
    expect(error.message).toMatch(/unknown key\(s\): maxSpendInCents/);
  });

  it('rejects an unknown trigger key', () => {
    const error = expectConfigError(() =>
      load({
        ...fullDocument(),
        reviewPrograms: {
          continuous: { environment: 'staging', cohort: 'regulars', trigger: { schedule: { daily: true } } },
        },
      }),
    );
    expect(error.message).toMatch(/unknown key\(s\): schedule/);
  });
});

describe('missing required keys', () => {
  it('rejects a document with no version', () => {
    const text = buildConfig();
    const error = expectConfigError(() => parseUseSekaiConfigText(text.replace('version: 1\n', ''), provenance));
    expect(error.message).toMatch(/version must be an integer/);
  });

  it('rejects an unsupported schema version', () => {
    const error = expectConfigError(() => load({ version: 2 }));
    expect(error.message).toMatch(/version 2 is not supported/);
  });

  it('rejects a document with no product', () => {
    const error = expectConfigError(() => parseUseSekaiConfigText(buildConfig({ product: undefined }), provenance));
    expect(error.message).toMatch(/product must be a mapping/);
  });

  it('rejects a product with no id', () => {
    const error = expectConfigError(() => load({ product: { id: undefined, displayName: 'Acme' } }));
    expect(error.message).toMatch(/product\.id must be/);
  });

  it('rejects a document with no environments', () => {
    const error = expectConfigError(() => load({ environments: undefined }));
    expect(error.message).toMatch(/environments must be a mapping/);
  });

  it('rejects an empty environments block', () => {
    const error = expectConfigError(() =>
      parseUseSekaiConfigText(configFrom({ version: 1, product: { id: 'acme' }, environments: {} }), provenance),
    );
    expect(error.message).toMatch(/environments must declare at least one entry/);
  });

  it('rejects an environment with no class', () => {
    // Deliberate: inferring `production` from a name would make the most
    // consequential distinction in the model a function of a word typed.
    const error = expectConfigError(() =>
      load({ environments: { develop: { class: undefined, url: 'https://d.example.com' } } }),
    );
    expect(error.message).toMatch(/class must be a string/);
  });

  it('rejects an environment with no url', () => {
    // An absent url is caught as a wrong type before the domain's URL
    // grammar is reached; a *malformed* url is reported by that grammar
    // and is covered separately below.
    const error = expectConfigError(() => load({ environments: { develop: { class: 'develop', url: undefined } } }));
    expect(error.message).toMatch(/url must be a string/);
  });

  it('rejects an identity with no persona', () => {
    // There is no safe default persona: a configuration that invented one
    // would produce evidence about nobody.
    const error = expectConfigError(() => load({ identities: { avery: { lifecycle: 'ephemeral' } } }));
    expect(error.message).toMatch(/persona must be a string/);
  });

  it('rejects a cohort with no lifecycle', () => {
    const error = expectConfigError(() => load({ cohorts: { regulars: { size: 5 } } }));
    expect(error.message).toMatch(/lifecycle must be a string/);
  });

  it('rejects a program with no trigger', () => {
    const error = expectConfigError(() =>
      load({
        ...fullDocument(),
        reviewPrograms: { continuous: { environment: 'staging', cohort: 'regulars' } },
      }),
    );
    expect(error.message).toMatch(/must declare a trigger/);
  });

  it('rejects a program with no environment', () => {
    const error = expectConfigError(() =>
      load({
        ...fullDocument(),
        reviewPrograms: { continuous: { cohort: 'regulars', trigger: { manual: true } } },
      }),
    );
    expect(error.message).toMatch(/must declare the environment\(s\)/);
  });

  it('rejects a program with no cohort', () => {
    const error = expectConfigError(() =>
      load({
        ...fullDocument(),
        reviewPrograms: { continuous: { environment: 'staging', trigger: { manual: true } } },
      }),
    );
    expect(error.message).toMatch(/must declare a cohort/);
  });

  it('rejects a trigger block that declares no trigger', () => {
    const error = expectConfigError(() =>
      load({
        ...fullDocument(),
        reviewPrograms: { continuous: { environment: 'staging', cohort: 'regulars', trigger: {} } },
      }),
    );
    expect(error.message).toMatch(/must declare at least one of/);
  });
});

describe('wrong types', () => {
  it('rejects a string where a mapping belongs', () => {
    const error = expectConfigError(() => load({ environments: 'staging' }));
    expect(error.message).toMatch(/environments must be a mapping/);
  });

  it('rejects a list where a scalar belongs', () => {
    const error = expectConfigError(() => load({ product: { id: ['acme'] } }));
    expect(error.message).toMatch(/id must be a name|must be a string/);
  });

  it('rejects a mapping where a list belongs', () => {
    const error = expectConfigError(() =>
      load({
        ...fullDocument(),
        reviewPrograms: { continuous: { environment: 'staging', cohort: 'regulars', trigger: { manual: true } } },
        environments: {
          staging: {
            class: 'staging',
            url: 'https://staging.example.com',
            allowedOrigins: { primary: 'https://staging.example.com' },
          },
        },
      }),
    );
    expect(error.message).toMatch(/allowedOrigins must be a list/);
  });

  it('rejects a quoted number where an integer belongs', () => {
    const error = expectConfigError(() => load({ cohorts: { regulars: { lifecycle: 'persistent', size: '5' } } }));
    expect(error.message).toMatch(/size must be an integer/);
  });

  it('rejects a fractional cohort size', () => {
    const error = expectConfigError(() => load({ cohorts: { regulars: { lifecycle: 'persistent', size: 2.5 } } }));
    expect(error.message).toMatch(/size must be an integer/);
  });

  it('rejects a truthy string where a boolean permission belongs', () => {
    // `destructiveActions: "false"` must not be read as enabled, and
    // `destructiveActions: "true"` must not be either. Both are errors, so
    // a typo cannot quietly grant or revoke a permission.
    const error = expectConfigError(() =>
      load({
        environments: {
          develop: {
            class: 'develop',
            url: 'https://d.example.com',
            authority: { destructiveActions: 'true' },
          },
        },
      }),
    );
    expect(error.message).toMatch(/destructiveActions must be true or false/);
  });

  it('rejects a YAML 1.1 truthy spelling of a permission', () => {
    const text = buildConfig();
    const error = expectConfigError(() =>
      parseUseSekaiConfigText(
        `${text}    authority:\n      destructiveActions: yes\n`,
        provenance,
      ),
    );
    expect(error.message).toMatch(/destructiveActions must be true or false/);
  });
});

describe('references that resolve to nothing', () => {
  it('rejects a program naming an environment the file does not declare', () => {
    const error = expectConfigError(() =>
      load({
        ...fullDocument(),
        reviewPrograms: { continuous: { environment: 'production', cohort: 'regulars', trigger: { manual: true } } },
      }),
    );
    expect(error.message).toMatch(/does not declare|unknown environment/i);
  });

  it('rejects a program naming a cohort the file does not declare', () => {
    const error = expectConfigError(() =>
      load({
        ...fullDocument(),
        reviewPrograms: { continuous: { environment: 'staging', cohort: 'ghosts', trigger: { manual: true } } },
      }),
    );
    expect(error.message).toMatch(/does not declare|unknown cohort/i);
  });

  it('rejects an explicit cohort member the file does not declare', () => {
    const error = expectConfigError(() =>
      load({
        ...fullDocument(),
        cohorts: { regulars: { lifecycle: 'persistent', members: ['avery'] } },
      }),
    );
    expect(error.message).toMatch(/does not declare|unknown identity/i);
  });

  it('rejects a World connector naming a secret the registry does not declare', () => {
    const error = expectConfigError(() =>
      load({
        environments: {
          staging: {
            class: 'staging',
            url: 'https://staging.example.com',
            secrets: { other: '${secret:OTHER}' },
            world: {
              accounts: {
                provider: 'http',
                endpoint: 'https://staging.example.com/support',
                secret: 'factory',
              },
            },
          },
        },
      }),
    );
    expect(error.message).toMatch(/secrets: block does not declare/);
  });

  it('rejects an identity permitted to act on an undeclared origin', () => {
    const error = expectConfigError(() =>
      load({
        ...fullDocument(),
        identities: {
          avery: {
            lifecycle: 'ephemeral',
            persona: 'A first-time visitor.',
            permittedOrigins: ['https://someone-elses-site.example'],
          },
        },
      }),
    );
    expect(error.message).toMatch(/may only contain origins some environment declares/);
  });
});

describe('origin validation', () => {
  it('rejects a url that is not an absolute URL', () => {
    const error = expectConfigError(() =>
      load({ environments: { develop: { class: 'develop', url: '/relative/path' } } }),
    );
    expect(error.message).toMatch(/must be an absolute URL/);
  });

  it('rejects a non-http scheme', () => {
    for (const url of ['ftp://d.example.com', 'file:///etc/passwd', 'javascript:alert(1)']) {
      const error = expectConfigError(() =>
        load({ environments: { develop: { class: 'develop', url } } }),
      );
      expect(error.message).toMatch(/must use http or https/);
    }
  });

  it('rejects credentials embedded in a url', () => {
    const error = expectConfigError(() =>
      load({ environments: { develop: { class: 'develop', url: 'https://user:pw@d.example.com' } } }),
    );
    expect(error.message).toMatch(/must not embed credentials/);
    // The message must not have copied the password into the diagnostic.
    expect(error.message).not.toContain('pw');
    expect(JSON.stringify(error.detail)).not.toContain('pw');
  });

  it('rejects a wildcard host, which new URL accepts', () => {
    // `new URL('https://*.example.com')` parses, so this is the one
    // origin shape the domain's own check does not catch.
    const error = expectConfigError(() =>
      load({ environments: { develop: { class: 'develop', url: 'https://*.example.com' } } }),
    );
    expect(error.message).toMatch(/wildcard host/);
  });

  it('rejects a wildcard origin in allowedOrigins', () => {
    const error = expectConfigError(() =>
      load({
        environments: {
          develop: {
            class: 'develop',
            url: 'https://develop.example.com',
            allowedOrigins: ['https://develop.example.com', 'https://*.example.com'],
          },
        },
      }),
    );
    expect(error.message).toMatch(/wildcard host/);
  });

  it('rejects allowedOrigins that omits the environment url', () => {
    const error = expectConfigError(() =>
      load({
        environments: {
          staging: {
            class: 'staging',
            url: 'https://staging.example.com',
            allowedOrigins: ['https://unrelated.example.com'],
          },
        },
      }),
    );
    expect(error.message).toMatch(/must include this environment's url/);
  });

  it('rejects a repeated origin', () => {
    const error = expectConfigError(() =>
      load({
        environments: {
          develop: {
            class: 'develop',
            url: 'https://develop.example.com',
            allowedOrigins: ['https://develop.example.com', 'https://develop.example.com/'],
          },
        },
      }),
    );
    expect(error.message).toMatch(/must not repeat/);
  });

  it('canonicalises a bare-origin trailing slash so two spellings compare equal', () => {
    const config = parseUseSekaiConfigText(
      buildConfig({ environments: { develop: { class: 'develop', url: 'https://develop.example.com/' } } }),
      provenance,
    );
    expect(config.model.environments[0]?.endpoint.baseUrl).toBe('https://develop.example.com');
  });
});

describe('declared names', () => {
  it('rejects a name carrying its own id prefix', () => {
    const error = expectConfigError(() =>
      load({ environments: { 'env-develop': { class: 'develop', url: 'https://d.example.com' } } }),
    );
    expect(error.message).toMatch(/must not include the "env-" id prefix/);
  });

  it('rejects an uppercase name, because a durable id cannot carry one', () => {
    const error = expectConfigError(() =>
      load({ environments: { Develop: { class: 'develop', url: 'https://d.example.com' } } }),
    );
    expect(error.message).toMatch(/lowercase and hyphen-separated/);
  });

  it('rejects a name with a space', () => {
    const error = expectConfigError(() =>
      load({ environments: { 'my env': { class: 'develop', url: 'https://d.example.com' } } }),
    );
    expect(error.message).toMatch(/lowercase and hyphen-separated/);
  });
});

describe('cohort membership', () => {
  it('rejects a cohort declaring both a size and explicit members', () => {
    const error = expectConfigError(() =>
      load({
        identities: { avery: { lifecycle: 'ephemeral', persona: 'A visitor.' } },
        cohorts: { regulars: { lifecycle: 'persistent', size: 5, members: ['avery'] } },
      }),
    );
    expect(error.message).toMatch(/either size or members, not both/);
  });

  it('rejects an unknown lifecycle', () => {
    const error = expectConfigError(() => load({ cohorts: { regulars: { lifecycle: 'immortal', size: 5 } } }));
    expect(error.message).toMatch(/lifecycle must be one of/);
  });

  it('rejects a size of zero', () => {
    const error = expectConfigError(() => load({ cohorts: { regulars: { lifecycle: 'persistent', size: 0 } } }));
    expect(error.message).toMatch(/size must be between 1 and 10000/);
  });

  it('accepts a cohort that names only a lifecycle', () => {
    const config = load({ cohorts: { regulars: { lifecycle: 'release' } } });
    expect(config.model.cohorts[0]?.membership).toEqual({ kind: 'byLifecycle', lifecycle: 'release' });
  });
});

describe('review programs', () => {
  it('rejects both environment and environments', () => {
    const error = expectConfigError(() =>
      load({
        ...fullDocument(),
        reviewPrograms: {
          continuous: {
            environment: 'staging',
            environments: ['staging'],
            cohort: 'regulars',
            trigger: { manual: true },
          },
        },
      }),
    );
    expect(error.message).toMatch(/either environment or environments, not both/);
  });

  it('rejects manual: false, which declares a trigger that never fires', () => {
    const error = expectConfigError(() =>
      load({
        ...fullDocument(),
        reviewPrograms: {
          continuous: { environment: 'staging', cohort: 'regulars', trigger: { manual: false } },
        },
      }),
    );
    expect(error.message).toMatch(/manual: false declares a trigger that never fires/);
  });

  it('rejects an unknown cadence token', () => {
    const error = expectConfigError(() =>
      load({
        ...fullDocument(),
        reviewPrograms: {
          continuous: { environment: 'staging', cohort: 'regulars', trigger: { cadence: 'fortnightly' } },
        },
      }),
    );
    expect(error.message).toMatch(/must be one of: daily, hourly, weekly/);
  });

  it('rejects an event trigger with no event name', () => {
    const error = expectConfigError(() =>
      load({
        ...fullDocument(),
        reviewPrograms: {
          continuous: {
            environment: 'staging',
            cohort: 'regulars',
            trigger: { event: { debounceMinutes: 5 } },
          },
        },
      }),
    );
    expect(error.message).toMatch(/must declare an event name/);
  });

  it('rejects a cadence below the domain floor rather than clamping it', () => {
    const error = expectConfigError(() =>
      load({
        ...fullDocument(),
        reviewPrograms: {
          continuous: {
            environment: 'staging',
            cohort: 'regulars',
            trigger: { cadence: { everyMinutes: 1 } },
          },
        },
      }),
    );
    // Clamping to the floor would load a program that runs four times
    // more often than the file asked for.
    expect(error.message).toMatch(/everyMinutes must be between/);
  });
});

describe('nothing is dropped silently', () => {
  it('rejects rather than ignores a misspelled permission', () => {
    // `destructiveAction` (singular) is the realistic typo. If unknown
    // keys were discarded, the environment would load with
    // `destructiveActions: false` and the file would read as though the
    // permission had been declined rather than misspelled.
    const error = expectConfigError(() =>
      load({
        environments: {
          develop: {
            class: 'develop',
            url: 'https://d.example.com',
            authority: { destructiveAction: true },
          },
        },
      }),
    );
    expect(error.message).toMatch(/destructiveAction/);
  });

  it('rejects rather than ignores a misspelled environment class', () => {
    const error = expectConfigError(() =>
      load({ environments: { develop: { class: 'stagng', url: 'https://d.example.com' } } }),
    );
    expect(error.message).toMatch(/class must be one of/);
  });

  it('reports every unknown key at once, not only the first', () => {
    const error = expectConfigError(() => load({ browsers: {}, model: 'x', schedules: {} }));
    expect(error.message).toMatch(/browsers, model, schedules/);
  });
});

describe('domain errors surface as configuration errors', () => {
  // `asConfigError` is what keeps one grammar for the grammars #57 owns.
  // The conversion has to preserve the domain's field path, or a customer
  // reading a diagnostic would be sent to a field the file does not have.
  it('re-throws a domain rejection as a config error carrying the same field', () => {
    const error = expectConfigError(() =>
      load({ environments: { develop: { class: 'develop', url: 'https://d.example.com', notes: 42 } } }),
    );
    expect(error).toBeInstanceOf(UseSekaiConfigError);
    // The path is rooted at the file it came from, so a diagnostic both
    // names the offending key and the file to edit.
    expect(error.field).toBe('/synthetic/u-sekai.yml.environments.develop.notes');
    expect(error.message).toMatch(/notes must be a string/);
  });

  it('keeps the domain error as the cause, so the origin is traceable', () => {
    const error = expectConfigError(() =>
      load({ environments: { develop: { class: 'develop', url: 'gopher://d.example.com' } } }),
    );
    expect(error.domainCause?.name).toBe('ProductDomainError');
    expect(error.domainCause).toBeInstanceOf(ProductDomainError);
  });

  it('does not reclassify an unrelated error as a configuration problem', () => {
    // The conversion is `instanceof`-based, so a genuine bug in u-sekai
    // still surfaces as itself rather than as "your file is wrong".
    let thrown: unknown;
    try {
      asConfigError(() => {
        throw new TypeError('a real bug, not a bad file');
      }, 'field');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).not.toBeInstanceOf(UseSekaiConfigError);
  });
});

describe('serialisation round trip', () => {
  it('rejects a document whose environment block is a scalar', () => {
    const error = expectConfigError(() =>
      parseUseSekaiConfigText(configFrom({ version: 1, product: { id: 'acme' }, environments: 3 }), provenance),
    );
    expect(error.message).toMatch(/environments must be a mapping/);
  });
});
