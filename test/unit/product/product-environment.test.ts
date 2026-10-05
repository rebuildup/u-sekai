import { describe, it, expect } from 'vitest';
import {
  buildProduct,
  ENVIRONMENT_CLASSES,
  environmentOrigins,
  isProduct,
  parseEnvironment,
  parseEnvironmentEndpoint,
  parseProduct,
  ProductDomainError,
  productId,
  productSummaryLine,
} from '../../../src/product/index.js';

describe('Product construction', () => {
  it('accepts a minimal product', () => {
    const p = parseProduct({
      id: 'prd-task-tracker',
      slug: 'task-tracker',
      displayName: 'Task Tracker',
    });
    expect(p.id).toBe('prd-task-tracker');
    expect(p.slug).toBe('task-tracker');
    expect(p.displayName).toBe('Task Tracker');
    expect('description' in p).toBe(false);
    expect('owners' in p).toBe(false);
    expect('labels' in p).toBe(false);
  });

  it('accepts the full optional set and omits nothing that was absent', () => {
    const p = parseProduct({
      id: 'prd-task-tracker',
      slug: 'task-tracker',
      displayName: 'Task Tracker',
      description: 'A small task tracking product.',
      owners: ['team-platform'],
      labels: ['b2b', 'web'],
    });
    expect(p.description).toBe('A small task tracking product.');
    expect(p.owners).toEqual(['team-platform']);
    expect(p.labels).toEqual(['b2b', 'web']);
    expect(Object.keys(p).sort()).toEqual([
      'description',
      'displayName',
      'id',
      'labels',
      'owners',
      'slug',
    ]);
  });

  it('builds directly from declared identity', () => {
    const p = buildProduct(
      { id: productId('prd-a'), slug: 'a', displayName: 'A' },
      { description: 'x' },
    );
    expect(p.id).toBe('prd-a');
    expect(productSummaryLine(p)).toBe('prd-a (A)');
  });

  it('recognises a product shape', () => {
    expect(isProduct({ id: 'prd-a', slug: 'a', displayName: 'A' })).toBe(true);
    expect(isProduct({ id: 'bad', slug: 'a', displayName: 'A' })).toBe(false);
    expect(isProduct(null)).toBe(false);
  });
});

describe('Product rejection', () => {
  it('rejects a non-object', () => {
    for (const bad of [null, undefined, 42, 'prd-a', [], true]) {
      expect(() => parseProduct(bad)).toThrow(/must be an object/);
    }
  });

  it('rejects a missing required field', () => {
    expect(() => parseProduct({ slug: 'a', displayName: 'A' })).toThrow(/product\.id must be a string/);
    expect(() => parseProduct({ id: 'prd-a', displayName: 'A' })).toThrow(/slug must be a string/);
    expect(() => parseProduct({ id: 'prd-a', slug: 'a' })).toThrow(/displayName must be a string/);
  });

  it('rejects an empty or whitespace-only displayName', () => {
    expect(() => parseProduct({ id: 'prd-a', slug: 'a', displayName: '' })).toThrow(/must not be empty/);
    expect(() => parseProduct({ id: 'prd-a', slug: 'a', displayName: '   ' })).toThrow(/must not be empty/);
  });

  it('rejects a slug that is not lowercase-hyphenated', () => {
    for (const bad of ['Task-Tracker', 'task_tracker', '-a', 'a-', 'a--b', 'a b', 'a.b']) {
      expect(() => parseProduct({ id: 'prd-a', slug: bad, displayName: 'A' }), bad).toThrow(
        ProductDomainError,
      );
    }
  });

  it('rejects duplicate labels and owners', () => {
    expect(() =>
      parseProduct({ id: 'prd-a', slug: 'a', displayName: 'A', labels: ['x', 'x'] }),
    ).toThrow(/duplicates: x/);
    expect(() =>
      parseProduct({ id: 'prd-a', slug: 'a', displayName: 'A', owners: ['t', 't'] }),
    ).toThrow(/duplicates: t/);
  });

  it('rejects too many labels and an over-long label', () => {
    const many = Array.from({ length: 33 }, (_, i) => `l${i}`);
    expect(() => parseProduct({ id: 'prd-a', slug: 'a', displayName: 'A', labels: many })).toThrow(
      /at most 32 entries/,
    );
    expect(() =>
      parseProduct({ id: 'prd-a', slug: 'a', displayName: 'A', labels: ['x'.repeat(65)] }),
    ).toThrow(/at most 64 characters/);
  });

  it('rejects a non-array owners/labels value', () => {
    expect(() => parseProduct({ id: 'prd-a', slug: 'a', displayName: 'A', labels: 'x' })).toThrow(
      /must be an array/,
    );
    expect(() => parseProduct({ id: 'prd-a', slug: 'a', displayName: 'A', owners: {} })).toThrow(
      /must be an array/,
    );
  });

  it('rejects an unknown field', () => {
    expect(() =>
      parseProduct({ id: 'prd-a', slug: 'a', displayName: 'A', secret: 'x' }),
    ).toThrow(/unknown field\(s\): secret/);
  });
});

describe('Environment construction', () => {
  it('accepts each environment class named in ADR-0011', () => {
    for (const environmentClass of ENVIRONMENT_CLASSES) {
      const env = parseEnvironment({
        id: 'env-x',
        productId: 'prd-a',
        name: 'X',
        environmentClass,
        deploymentKind: 'continuous',
        endpoint: { baseUrl: 'https://x.example' },
      });
      expect(env.environmentClass).toBe(environmentClass);
    }
    expect(ENVIRONMENT_CLASSES).toEqual([
      'develop',
      'preRelease',
      'staging',
      'productionLike',
      'production',
    ]);
  });

  it('accepts a minimal environment', () => {
    const env = parseEnvironment({
      id: 'env-staging',
      productId: 'prd-task-tracker',
      name: 'Staging',
      environmentClass: 'staging',
      deploymentKind: 'continuous',
      endpoint: { baseUrl: 'https://staging.example' },
    });
    expect(env.id).toBe('env-staging');
    expect(env.productId).toBe('prd-task-tracker');
    expect('notes' in env).toBe(false);
  });

  it('canonicalises a bare-origin trailing slash but preserves a path slash', () => {
    expect(parseEnvironmentEndpoint({ baseUrl: 'https://a.example/' }).baseUrl).toBe('https://a.example');
    expect(parseEnvironmentEndpoint({ baseUrl: 'https://a.example' }).baseUrl).toBe('https://a.example');
    expect(parseEnvironmentEndpoint({ baseUrl: 'https://a.example/app/' }).baseUrl).toBe(
      'https://a.example/app/',
    );
  });

  it('keeps http and a non-default port', () => {
    expect(parseEnvironmentEndpoint({ baseUrl: 'http://localhost:3000' }).baseUrl).toBe(
      'http://localhost:3000',
    );
  });

  it('collects additional origins after the base URL', () => {
    const endpoint = parseEnvironmentEndpoint({
      baseUrl: 'https://a.example',
      additionalOrigins: ['https://b.example', 'https://c.example/app'],
    });
    const env = parseEnvironment({
      id: 'env-a',
      productId: 'prd-a',
      name: 'A',
      environmentClass: 'staging',
      deploymentKind: 'continuous',
      endpoint,
    });
    expect(environmentOrigins(env)).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example/app',
    ]);
  });
});

describe('Environment rejection', () => {
  const base = {
    id: 'env-staging',
    productId: 'prd-task-tracker',
    name: 'Staging',
    environmentClass: 'staging',
    deploymentKind: 'continuous',
    endpoint: { baseUrl: 'https://staging.example' },
  };

  it('rejects an unknown environment class or deployment kind', () => {
    expect(() => parseEnvironment({ ...base, environmentClass: 'qa' })).toThrow(
      /must be one of: develop, preRelease/,
    );
    expect(() => parseEnvironment({ ...base, deploymentKind: 'docker' })).toThrow(
      /must be one of: continuous, versioned, static/,
    );
  });

  it('rejects a relative or non-http URL', () => {
    for (const baseUrl of ['/staging', 'staging.example', 'ftp://a.example', 'file:///etc/passwd', '']) {
      expect(() => parseEnvironment({ ...base, endpoint: { baseUrl } }), baseUrl).toThrow(
        ProductDomainError,
      );
    }
  });

  it('rejects credentials, a query string and a fragment in an origin', () => {
    expect(() => parseEnvironmentEndpoint({ baseUrl: 'https://u:p@a.example' })).toThrow(
      /must not embed credentials/,
    );
    expect(() => parseEnvironmentEndpoint({ baseUrl: 'https://a.example?token=x' })).toThrow(
      /must not contain a query string/,
    );
    expect(() => parseEnvironmentEndpoint({ baseUrl: 'https://a.example#top' })).toThrow(
      /must not contain a fragment/,
    );
  });

  it('rejects duplicate additionalOrigins and one repeating baseUrl', () => {
    expect(() =>
      parseEnvironmentEndpoint({
        baseUrl: 'https://a.example',
        additionalOrigins: ['https://b.example', 'https://b.example/'],
      }),
    ).toThrow(/duplicates/);
    expect(() =>
      parseEnvironmentEndpoint({
        baseUrl: 'https://a.example',
        additionalOrigins: ['https://a.example/'],
      }),
    ).toThrow(/must not repeat baseUrl/);
  });

  it('rejects a missing or non-object endpoint', () => {
    expect(() => parseEnvironment({ ...base, endpoint: undefined })).toThrow(/must be an object/);
    expect(() => parseEnvironment({ ...base, endpoint: 'https://a.example' })).toThrow(
      /must be an object/,
    );
  });

  it('rejects an unknown field on the environment or its endpoint', () => {
    expect(() => parseEnvironment({ ...base, secretKey: 'x' })).toThrow(/unknown field/);
    expect(() =>
      parseEnvironment({ ...base, endpoint: { baseUrl: 'https://a.example', headers: {} } }),
    ).toThrow(/unknown field\(s\): headers/);
  });
});
