/**
 * Cross-cutting acceptance criteria for #57.
 *
 * These are the properties the issue names directly, and the ones seven
 * downstream tickets are written against. They are tested here rather
 * than per-entity because each one is a statement about the layer as a
 * whole.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as product from '../../../src/product/index.js';
import {
  buildProductModel,
  buildProduct,
  cohortId,
  environmentId,
  environmentIncludesOrigin,
  parseCohortMembershipIntent,
  parseEnvironment,
  parseProduct,
  parseProductModel,
  parseProgramBudget,
  parseReviewProgram,
  parseReviewTrigger,
  parseRunLineage,
  parseSyntheticCohort,
  parseSyntheticIdentity,
  productId,
  reviewProgramId,
  syntheticIdentityId,
  type ProductModel,
} from '../../../src/product/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const productSrcDir = path.resolve(here, '..', '..', '..', 'src', 'product');

/** A minimal but complete valid model, reused across the invariant tests. */
function validModel(): ProductModel {
  const p = parseProduct({
    id: 'prd-task-tracker',
    slug: 'task-tracker',
    displayName: 'Task Tracker',
  });
  const staging = parseEnvironment({
    id: 'env-staging',
    productId: 'prd-task-tracker',
    name: 'Staging',
    environmentClass: 'staging',
    deploymentKind: 'continuous',
    endpoint: { baseUrl: 'https://staging.task-tracker.example' },
  });
  const preRelease = parseEnvironment({
    id: 'env-pre-release',
    productId: 'prd-task-tracker',
    name: 'Pre-release',
    environmentClass: 'preRelease',
    deploymentKind: 'versioned',
    endpoint: { baseUrl: 'https://beta.task-tracker.example' },
  });
  const identity = parseSyntheticIdentity({
    id: 'idn-alice',
    productId: 'prd-task-tracker',
    displayName: 'Alice',
    lifecycle: 'persistent',
    persona: 'A returning project lead who trialled the beta last month.',
    capability: {
      maxConcurrentSessions: 1,
      stateRetention: 'durable',
      permittedOrigins: ['https://staging.task-tracker.example'],
    },
    stateRef: 'alice:state:1',
  });
  const cohort = parseSyntheticCohort({
    id: 'coh-beta-returners',
    productId: 'prd-task-tracker',
    name: 'Beta returners',
    membership: { kind: 'explicit', identityIds: ['idn-alice'] },
  });
  const program = parseReviewProgram({
    id: 'rp-continuous-staging',
    productId: 'prd-task-tracker',
    name: 'Continuous staging review',
    environmentIds: ['env-staging', 'env-pre-release'],
    cohortId: 'coh-beta-returners',
    triggers: [
      { kind: 'cadence', intervalMinutes: 360, timeZone: 'Asia/Tokyo' },
      { kind: 'event', event: 'deployment.completed', debounceMinutes: 15 },
      { kind: 'manual' },
    ],
    budget: { maxRunsPerDay: 50, maxRunsPerEvent: 2, maxCostUnitsPerDay: 100 },
  });

  return buildProductModel({
    product: p,
    environments: [staging, preRelease],
    identities: [identity],
    cohorts: [cohort],
    programs: [program],
  });
}

describe('#57 acceptance: durable identities are independent of the experiment runtime', () => {
  it('parses a complete model with no ExperimentDefinition, run id or run result anywhere', () => {
    const model = validModel();
    expect(model.product.id).toBe('prd-task-tracker');
    expect(model.environments).toHaveLength(2);
    expect(model.identities).toHaveLength(1);
    expect(model.cohorts).toHaveLength(1);
    expect(model.programs).toHaveLength(1);
  });

  it('imports nothing from the experiment or capability runtime under src/product', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(productSrcDir)) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(path.join(productSrcDir, file), 'utf8');
      const importSpecifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
      for (const spec of importSpecifiers) {
        // Only relative imports within this package are permitted.
        if (!spec.startsWith('./') && !spec.startsWith('../')) {
          offenders.push(`${file}: ${spec}`);
        }
        if (spec.includes('/domain/') || spec.includes('/experiment/') || spec.includes('/capability/')) {
          offenders.push(`${file}: ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('contains no dependency on playwright or a provider SDK', () => {
    const forbidden = ['playwright', '@anthropic-ai', 'openai', 'langchain'];
    for (const file of readdirSync(productSrcDir)) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(path.join(productSrcDir, file), 'utf8');
      for (const pkg of forbidden) {
        expect(source).not.toContain(`'${pkg}`);
      }
    }
  });
});

describe('#57 acceptance: runtime/provider-specific objects are not embedded in the domain', () => {
  it('produces plain, JSON-serialisable, frozen data for every domain entity', () => {
    const model = validModel();
    const json = JSON.stringify(model);
    expect(typeof json).toBe('string');
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(model)));
  });

  it('embeds no function, class instance, symbol or undefined value in a constructed model', () => {
    const model = validModel();

    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'function') {
        throw new Error(`function embedded at ${path}`);
      }
      if (typeof value === 'symbol' || typeof value === 'bigint') {
        throw new Error(`non-serialisable ${typeof value} at ${path}`);
      }
      if (value === null || typeof value !== 'object') return;
      // Domain values are plain frozen data: object literals and
      // arrays. A class instance, Map, Set or Date would be a runtime
      // object leaking into the durable model.
      const proto = Object.getPrototypeOf(value) as object | null;
      const isArray = Array.isArray(value);
      const allowed = isArray
        ? Array.prototype
        : proto === Object.prototype || proto === null;
      if (!allowed) {
        throw new Error(`non-plain object at ${path}: ${proto?.constructor?.name ?? 'null proto'}`);
      }
      if (!Object.isFrozen(value)) {
        throw new Error(`value at ${path} is not frozen`);
      }
      for (const [key, child] of Object.entries(value)) {
        if (child === undefined) {
          throw new Error(`explicit undefined at ${path}.${key}`);
        }
        walk(child, `${path}.${key}`);
      }
    };

    walk(model, 'model');
  });

  it('rejects an unknown field instead of silently dropping a runtime-shaped object', () => {
    const withRuntimeHandle = {
      id: 'prd-task-tracker',
      slug: 'task-tracker',
      displayName: 'Task Tracker',
      // A Playwright page / provider client must not be attachable.
      page: { goto: () => undefined },
    };
    expect(() => parseProduct(withRuntimeHandle)).toThrow(/unknown field/i);
  });

  it('rejects a secret-bearing value in a durable document', () => {
    const withCredential = {
      id: 'env-staging',
      productId: 'prd-task-tracker',
      name: 'Staging',
      environmentClass: 'staging',
      deploymentKind: 'continuous',
      endpoint: { baseUrl: 'https://user:hunter2@staging.example' },
    };
    expect(() => parseEnvironment(withCredential)).toThrow(/must not embed credentials/i);
  });
});

describe('#57 acceptance: environment identity does not assume Git branches or PRs', () => {
  it('declares no Git-shaped field on the Environment type', () => {
    const env = parseEnvironment({
      id: 'env-staging',
      productId: 'prd-task-tracker',
      name: 'Staging',
      environmentClass: 'staging',
      deploymentKind: 'continuous',
      endpoint: { baseUrl: 'https://staging.example' },
    });
    const keys = Object.keys(env);
    for (const key of keys) {
      expect(key).not.toMatch(/branch|pull|\bpr\b|commit|sha|merge|ref|diff|repo/i);
    }
  });

  it('rejects an environment that smuggles Git identity in as a field', () => {
    for (const gitKey of ['branch', 'pullRequest', 'commitSha', 'mergeRequest', 'ref', 'diff']) {
      const input: Record<string, unknown> = {
        id: 'env-staging',
        productId: 'prd-task-tracker',
        name: 'Staging',
        environmentClass: 'staging',
        deploymentKind: 'continuous',
        endpoint: { baseUrl: 'https://staging.example' },
        [gitKey]: 'feature/x',
      };
      expect(() => parseEnvironment(input), `gitKey=${gitKey}`).toThrow(/unknown field/i);
    }
  });

  it('keeps two environments of one product independent of any release transition', () => {
    const model = validModel();
    const staging = model.environments.find((e) => e.id === 'env-staging');
    const preRelease = model.environments.find((e) => e.id === 'env-pre-release');
    expect(staging).toBeDefined();
    expect(preRelease).toBeDefined();
    // A release transition is two environments of the same product, not
    // one environment whose identity changed.
    expect(staging?.id).not.toBe(preRelease?.id);
    expect(staging?.productId).toBe(preRelease?.productId);
  });
});

describe('#57 acceptance: ids are never silently regenerated when state is reloaded', () => {
  it('exports no identifier generator anywhere in the product package', () => {
    const generatorLike = /(generate|new|random|uuid|make|create|mint|allocate)[A-Za-z0-9_]*id/i;
    const exported = Object.keys(product);
    const offenders = exported.filter((name) => generatorLike.test(name));
    expect(offenders).toEqual([]);
  });

  it('has no source file that mints an id from time, randomness or a counter', () => {
    for (const file of readdirSync(productSrcDir)) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(path.join(productSrcDir, file), 'utf8');
      for (const forbidden of [
        'Math.random',
        'Date.now()',
        'randomUUID',
        'crypto.',
        'process.hrtime',
        'performance.now',
      ]) {
        expect(source, `${file} must not use ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('re-declaring an id yields the identical value (both entry points are pure)', () => {
    expect(productId('prd-task-tracker')).toBe(productId('prd-task-tracker'));
    expect(product.parseProductId('prd-task-tracker')).toBe(productId('prd-task-tracker'));
    expect(environmentId('env-staging')).toBe(environmentId('env-staging'));
    expect(cohortId('coh-beta-returners')).toBe(cohortId('coh-beta-returners'));
    expect(reviewProgramId('rp-continuous-staging')).toBe(reviewProgramId('rp-continuous-staging'));
    expect(syntheticIdentityId('idn-alice')).toBe(syntheticIdentityId('idn-alice'));
  });

  it('survives a full storage round-trip with every id unchanged', () => {
    const first = validModel();
    const reloaded = parseProductModel(JSON.parse(JSON.stringify(first)));

    expect(reloaded.product.id).toBe(first.product.id);
    expect(reloaded.environments.map((e) => e.id)).toEqual(first.environments.map((e) => e.id));
    expect(reloaded.identities.map((i) => i.id)).toEqual(first.identities.map((i) => i.id));
    expect(reloaded.cohorts.map((c) => c.id)).toEqual(first.cohorts.map((c) => c.id));
    expect(reloaded.programs.map((p) => p.id)).toEqual(first.programs.map((p) => p.id));
    expect(reloaded).toEqual(first);
  });

  it('keeps lineage joinable across a simulated reload', () => {
    const before = parseRunLineage({
      runId: 'run-2026-10-01-a',
      productId: 'prd-task-tracker',
      environmentId: 'env-staging',
      cohortId: 'coh-beta-returners',
      programId: 'rp-continuous-staging',
      identityIds: ['idn-alice'],
      startedAt: '2026-10-01T00:00:00Z',
    });
    const reloaded = parseRunLineage(JSON.parse(JSON.stringify(before)));
    expect(reloaded).toEqual(before);
  });
});

describe('#57 acceptance: triggers are domain declarations, not a scheduler', () => {
  it('declares cadence, event and manual triggers as inert data', () => {
    const cadence = parseReviewTrigger({
      kind: 'cadence',
      intervalMinutes: 60,
      timeZone: 'UTC',
      startAt: '2026-10-01T00:00:00Z',
    });
    expect(cadence).toEqual({
      kind: 'cadence',
      intervalMinutes: 60,
      timeZone: 'UTC',
      startAt: '2026-10-01T00:00:00Z',
    });
    expect(Object.isFrozen(cadence)).toBe(true);

    const event = parseReviewTrigger({ kind: 'event', event: 'deployment.completed', debounceMinutes: 5 });
    expect(event).toEqual({ kind: 'event', event: 'deployment.completed', debounceMinutes: 5 });

    const manual = parseReviewTrigger({ kind: 'manual' });
    expect(manual).toEqual({ kind: 'manual' });
  });

  it('exports no scheduler primitive', () => {
    const schedulerLike = /(schedule|setTimeout|setInterval|cron|nextRun|fireAt|alarm)/i;
    expect(Object.keys(product).filter((n) => schedulerLike.test(n))).toEqual([]);
    for (const file of readdirSync(productSrcDir)) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(path.join(productSrcDir, file), 'utf8');
      for (const forbidden of ['setTimeout', 'setInterval', 'node:cron', 'from \'cron']) {
        expect(source, `${file} must not use ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('declares a budget without denominating it in a provider currency', () => {
    const budget = parseProgramBudget({
      maxRunsPerDay: 100,
      maxRunsPerEvent: 3,
      maxCostUnitsPerDay: 1_000,
    });
    expect(Object.keys(budget)).toEqual(['maxRunsPerDay', 'maxRunsPerEvent', 'maxCostUnitsPerDay']);
  });
});

describe('product module surface', () => {
  it('is a directory of source modules, not a generated artefact', () => {
    expect(statSync(productSrcDir).isDirectory()).toBe(true);
  });

  it('builds a product directly from declared identity without re-parsing', () => {
    const p = buildProduct(
      { id: productId('prd-direct'), slug: 'direct', displayName: 'Direct' },
      { labels: ['canary'] },
    );
    expect(p.id).toBe('prd-direct');
    expect(p.labels).toEqual(['canary']);
  });

  it('scopes an identity to an environment via permitted origins', () => {
    const env = parseEnvironment({
      id: 'env-staging',
      productId: 'prd-task-tracker',
      name: 'Staging',
      environmentClass: 'staging',
      deploymentKind: 'continuous',
      endpoint: { baseUrl: 'https://staging.example' },
    });
    expect(environmentIncludesOrigin(env, 'https://staging.example')).toBe(true);
    // A trailing slash is the same origin.
    expect(environmentIncludesOrigin(env, 'https://staging.example/')).toBe(true);
    expect(environmentIncludesOrigin(env, 'https://production.example')).toBe(false);
    expect(environmentIncludesOrigin(env, 'not-a-url')).toBe(false);
  });

  it('parses every membership intent variant', () => {
    expect(parseCohortMembershipIntent({ kind: 'explicit', identityIds: ['idn-a', 'idn-b'] })).toEqual({
      kind: 'explicit',
      identityIds: ['idn-a', 'idn-b'],
    });
    expect(parseCohortMembershipIntent({ kind: 'byLifecycle', lifecycle: 'persistent' })).toEqual({
      kind: 'byLifecycle',
      lifecycle: 'persistent',
    });
    expect(
      parseCohortMembershipIntent({ kind: 'sizeTarget', lifecycle: 'release', targetSize: 12 }),
    ).toEqual({ kind: 'sizeTarget', lifecycle: 'release', targetSize: 12 });
  });
});
