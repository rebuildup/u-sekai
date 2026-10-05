/**
 * The accepting side of `u-sekai.yml`: what a valid file resolves to.
 *
 * The issue's first and fifth acceptance criteria are covered here — a
 * minimal valid configuration loads deterministically, and the
 * illustrative staging + persistent cohort + sandbox billing case from
 * #55 loads as a real configuration rather than as a shape test.
 */

import { describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify } from 'yaml';
import { buildProductModel, syntheticIdentityId } from '../../../src/product/index.js';
import {
  findConfiguredEnvironmentByName,
  findSecretReference,
  parseUseSekaiConfigText,
  type UseSekaiConfig,
} from '../../../src/config/index.js';
import { loadFixture, readFixtureText } from './support.js';

const provenance = (name: string) => ({
  configPath: `/synthetic/${name}/u-sekai.yml`,
  configPathSource: 'default' as const,
});

describe('minimal valid configuration', () => {
  it('loads and resolves to the durable product model', async () => {
    const config = await loadFixture('minimal');

    expect(config.schemaVersion).toBe(1);
    expect(config.model.product.id).toBe('prd-acme');
    expect(config.model.product.slug).toBe('acme');
    expect(config.model.environments).toHaveLength(1);

    const environment = config.model.environments[0];
    expect(environment?.id).toBe('env-develop');
    expect(environment?.environmentClass).toBe('develop');
    expect(environment?.endpoint.baseUrl).toBe('https://develop.acme.example');
  });

  it('declares nothing it was not given', async () => {
    const config = await loadFixture('minimal');

    expect(config.model.identities).toEqual([]);
    expect(config.model.cohorts).toEqual([]);
    expect(config.model.programs).toEqual([]);

    const environment = findConfiguredEnvironmentByName(config, 'develop');
    expect(environment?.world).toEqual({});
    expect(environment?.secrets).toEqual([]);
    expect(environment?.origins).toEqual(['https://develop.acme.example']);
  });

  it('is frozen, so a caller cannot widen what the file authorised', async () => {
    const config = await loadFixture('minimal');
    const environment = findConfiguredEnvironmentByName(config, 'develop');

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.model)).toBe(true);
    expect(Object.isFrozen(config.model.environments)).toBe(true);
    expect(Object.isFrozen(environment?.authority)).toBe(true);
    expect(Object.isFrozen(environment?.authority.realMoney)).toBe(true);
  });

  it('loads the same bytes to the same bytes every time', async () => {
    const first = JSON.stringify(await loadFixture('minimal'));
    const second = JSON.stringify(await loadFixture('minimal'));
    expect(second).toBe(first);
  });
});

describe('key order does not change the resolved configuration', () => {
  it('produces identical output for two orderings of the same document', async () => {
    const source = await readFixtureText('runnable');
    // Rebuild the same document with every mapping's keys in the
    // opposite order. Names are sorted before anything is constructed, so
    // the resolved arrays — and therefore the serialised result — must be
    // byte-identical. A loader that iterated declaration order would
    // produce different arrays here.
    const reversed = stringify(reverseKeyOrder(parseYaml(source)) as unknown, {
      aliasDuplicateObjects: false,
    });

    const forwards = parseUseSekaiConfigText(source, provenance('run'));
    const backwards = parseUseSekaiConfigText(reversed, provenance('run'));

    expect(reversed).not.toBe(source);
    expect(JSON.stringify(backwards)).toBe(JSON.stringify(forwards));
  });
});

describe('the illustrative case from #55', () => {
  // docs/product/configuration-and-authority.md: staging, a persistent
  // returning-user cohort, and a sandboxed billing connector.
  it('loads', async () => {
    const config = await loadFixture('illustrative');
    expect(config.model.environments.map((e) => e.id)).toEqual(['env-staging']);
    expect(config.model.cohorts.map((c) => c.id)).toEqual(['coh-new-users', 'coh-returning-users']);
    expect(config.model.programs.map((p) => p.id)).toEqual(['rp-staging-continuous']);
  });

  it('keeps the persistent cohort persistent and the new-user cohort ephemeral', async () => {
    const config = await loadFixture('illustrative');
    const newUsers = config.model.cohorts.find((c) => c.id === 'coh-new-users');
    const returningUsers = config.model.cohorts.find((c) => c.id === 'coh-returning-users');

    expect(newUsers?.membership).toEqual({
      kind: 'sizeTarget',
      lifecycle: 'ephemeral',
      targetSize: 10,
    });
    expect(returningUsers?.membership).toEqual({
      kind: 'sizeTarget',
      lifecycle: 'persistent',
      targetSize: 10,
    });
  });

  it('binds the program to the staging environment and the returning-user cohort', async () => {
    const config = await loadFixture('illustrative');
    const program = config.model.programs[0];

    expect(program?.environmentIds).toEqual(['env-staging']);
    expect(program?.cohortId).toBe('coh-returning-users');
    expect(program?.triggers).toEqual([{ kind: 'cadence', intervalMinutes: 1_440, timeZone: 'UTC' }]);
  });

  it('keeps the billing connector in sandbox mode', async () => {
    const config = await loadFixture('illustrative');
    const staging = findConfiguredEnvironmentByName(config, 'staging');

    expect(staging?.world.billing).toEqual({ provider: 'stripe', mode: 'test' });
    expect(staging?.world.email).toEqual({ provider: 'test-inbox' });
    expect(staging?.world.accounts).toEqual({
      provider: 'http',
      endpoint: 'https://staging.example.com/test-support/users',
    });
  });

  it('applies the fail-closed budget, because the document declares none', async () => {
    const config = await loadFixture('illustrative');
    // The illustrative file has no budget. The resolved ceiling is the
    // smallest the domain admits, including a zero cost allowance, so an
    // omitted budget authorises no spend rather than a comfortable one.
    expect(config.model.programs[0]?.budget).toEqual({
      maxRunsPerDay: 1,
      maxRunsPerEvent: 1,
      maxCostUnitsPerDay: 0,
    });
  });

  it('requires no model, browser or provider choice to be a valid config', async () => {
    // ADR-0011's managed-service boundary: a normal customer expresses
    // what u-sekai may do, not which vendor runs it. The illustrative
    // file names none, and the loaded configuration contains none.
    const config = await loadFixture('illustrative');
    const serialised = JSON.stringify(config).toLowerCase();
    for (const forbidden of ['openai', 'anthropic', 'gpt-', 'claude-', 'playwright', 'chromium']) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});

describe('a fully declared configuration', () => {
  it('resolves a release transition across two environments', async () => {
    const config = await loadFixture('runnable');
    const program = config.model.programs.find((p) => p.id === 'rp-release-transition');

    expect(program?.environmentIds).toEqual(['env-staging', 'env-pre-release']);
    expect(program?.cohortId).toBe('coh-long-time-users');
    expect(program?.triggers).toEqual([{ kind: 'manual' }]);
  });

  it('carries the declared budget rather than the default', async () => {
    const config = await loadFixture('runnable');
    const program = config.model.programs.find((p) => p.id === 'rp-staging-continuous');
    expect(program?.budget).toEqual({
      maxRunsPerDay: 96,
      maxRunsPerEvent: 8,
      maxCostUnitsPerDay: 600,
    });
  });

  it('translates a cadence mapping and an event trigger together', async () => {
    const config = await loadFixture('runnable');
    const program = config.model.programs.find((p) => p.id === 'rp-staging-continuous');
    expect(program?.triggers).toEqual([
      { kind: 'cadence', intervalMinutes: 720, timeZone: 'Asia/Tokyo' },
      { kind: 'event', event: 'deployment.completed', debounceMinutes: 15 },
    ]);
  });

  it('resolves explicit membership to identities declared in the same file', async () => {
    const config = await loadFixture('runnable');
    const cohort = config.model.cohorts.find((c) => c.id === 'coh-long-time-users');
    expect(cohort?.membership).toEqual({ kind: 'explicit', identityIds: ['idn-avery', 'idn-blake'] });
  });

  it('derives retention from lifecycle and keeps the declared stateRef', async () => {
    const config = await loadFixture('runnable');
    const identities = new Map(config.model.identities.map((i) => [i.id, i]));

    // Declared implicitly: an ephemeral identity may retain nothing, so
    // the loader picks the only retention its lifecycle admits.
    expect(identities.get(syntheticIdentityId('idn-casey'))?.capability.stateRetention).toBe('none');
    expect(identities.get(syntheticIdentityId('idn-casey'))?.stateRef).toBeUndefined();

    expect(identities.get(syntheticIdentityId('idn-blake'))?.capability.stateRetention).toBe('session');
    expect(identities.get(syntheticIdentityId('idn-blake'))?.stateRef).toBe('identity/blake');
    expect(identities.get(syntheticIdentityId('idn-avery'))?.stateRef).toBe('identity/avery');
  });

  it('confines an identity to origins some environment declares', async () => {
    const config = await loadFixture('runnable');
    const avery = config.model.identities.find((i) => i.id === syntheticIdentityId('idn-avery'));
    expect(avery?.capability.permittedOrigins).toEqual([
      'https://staging.task-tracker.example',
      'https://prerelease.task-tracker.example',
    ]);

    // No `permittedOrigins` declared, so the identity is confined to the
    // union of declared environment origins — never wider.
    const casey = config.model.identities.find((i) => i.id === syntheticIdentityId('idn-casey'));
    expect(casey?.capability.permittedOrigins).toEqual([
      'https://eu.staging.task-tracker.example',
      'https://prerelease.task-tracker.example',
      'https://staging.task-tracker.example',
    ]);
  });

  it('collects every origin an environment answers on', async () => {
    const config = await loadFixture('runnable');
    expect(findConfiguredEnvironmentByName(config, 'staging')?.origins).toEqual([
      'https://staging.task-tracker.example',
      'https://eu.staging.task-tracker.example',
    ]);
    expect(findConfiguredEnvironmentByName(config, 'pre-release')?.origins).toEqual([
      'https://prerelease.task-tracker.example',
    ]);
  });

  it('links a World connector to the secret registry it names', async () => {
    const config = await loadFixture('runnable');
    const staging = findConfiguredEnvironmentByName(config, 'staging');

    expect(staging?.world.accounts?.secret).toBe('accountFactoryToken');
    expect(staging?.world.billing?.secret).toBe('billingSandboxKey');
    expect(findSecretReference(config, staging!.id, 'billingSandboxKey')).toBe(
      '${secret:BILLING_SANDBOX_KEY}',
    );
  });
});

describe('the resolved model is the domain model', () => {
  it('reconstructs from its own entities under the domain builder', async () => {
    const config = await loadFixture('runnable');
    // The loader did not assemble a look-alike: what it returns is
    // exactly what `buildProductModel` produces from the same entities,
    // so every cross-entity invariant in #57 was enforced at load time.
    const rebuilt = buildProductModel({
      product: config.model.product,
      environments: config.model.environments,
      identities: config.model.identities,
      cohorts: config.model.cohorts,
      programs: config.model.programs,
    });
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(config.model));
  });

  it('reports provenance without inventing a source for the authority', async () => {
    const config: UseSekaiConfig = await loadFixture('minimal');
    expect(config.provenance).toEqual({
      configPath: expect.stringContaining('test/fixtures/config/minimal.yml'),
      configPathSource: 'explicit',
    });
    expect(findConfiguredEnvironmentByName(config, 'develop')?.authoritySource).toBe('default');
  });
});

/** Rebuild a value with every mapping's keys in reverse insertion order. */
function reverseKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeyOrder);
  if (value === null || typeof value !== 'object') return value;

  const entries = Object.entries(value as Record<string, unknown>).reverse();
  const out: Record<string, unknown> = {};
  for (const [key, entry] of entries) out[key] = reverseKeyOrder(entry);
  return out;
}
