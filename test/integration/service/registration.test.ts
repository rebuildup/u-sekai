/**
 * #66 acceptance: Product and Environment registration (#57).
 *
 * Registration is the only place the control plane accepts new durable
 * declarations, so it is where a bad declaration has to be caught. The
 * claims are narrow and each has its own observable:
 *
 * - a registration is validated by #57's parsers, so the service cannot
 *   store a product #57 would refuse;
 * - a registration is validated by #57's *cross-entity* rules, so a
 *   program naming an undeclared cohort or environment fails at
 *   registration rather than at trigger time;
 * - registering an environment or a program afterwards composes a model
 *   #57 still accepts, and the composed model is what is stored;
 * - a duplicate registration of the *same* declaration is idempotent,
 *   and a *changed* one is refused rather than overwriting;
 * - an entity belonging to another product is refused, so a program
 *   cannot be attached to a product it was not declared under.
 *
 * Registration is also a **declaration only**. It does not seed #60's
 * durable identity store; that is the composition root's wiring (see
 * `support/fixtures.ts`). A run whose cohort was never declared into
 * #60 fails visibly as a `failed` job, which is the right place for
 * that fact to surface.
 */

import { describe, expect, it } from 'vitest';

import { isServiceError, type ServiceErrorCode } from '../../../src/service/index.js';
import { buildProductModel, parseEnvironment, parseReviewProgram } from '../../../src/product/index.js';
import {
  buildService,
  buildStore,
  ENV_ID,
  expectedModel,
  makeIdentity,
  principal,
  PRODUCT_ID,
  PROGRAM_ID,
  registrationBody,
} from './support/fixtures.js';

const BASE_URL = 'http://127.0.0.1:65535';

function code(fn: () => unknown): ServiceErrorCode {
  try {
    fn();
  } catch (error) {
    if (isServiceError(error)) return error.code;
    throw error;
  }
  throw new Error('expected a ServiceError, nothing was thrown');
}

describe('#66 Product and Environment registration', () => {
  it('stores a model #57 accepts, and reads it back unchanged', () => {
    const service = buildService({ dir: '/tmp/svc-reg-1' });
    const model = service.registerProduct(principal(), registrationBody(BASE_URL));

    expect(model).toEqual(expectedModel(BASE_URL));
    // The stored model is the registered one, not a re-derivation.
    expect(service.getProduct(principal(), PRODUCT_ID)).toEqual(model);
    expect(model.environments[0]?.id).toBe(ENV_ID);
    expect(model.environments[0]?.productId).toBe(PRODUCT_ID);
  });

  it('refuses a declaration #57\'s own parser rejects', () => {
    const service = buildService({ dir: '/tmp/svc-reg-2' });
    expect(
      code(() =>
        service.registerProduct(principal(), {
          ...registrationBody(BASE_URL),
          product: { id: 'not-a-branded-id', slug: 'x', displayName: 'X' },
        }),
      ),
    ).toBe('invalid-request');
    expect(code(() => service.getProduct(principal(), PRODUCT_ID))).toBe('product-not-found');
  });

  it('refuses a program naming a cohort that is not in the model, at registration time', () => {
    const service = buildService({ dir: '/tmp/svc-reg-3' });
    const body = registrationBody(BASE_URL);
    expect(
      code(() =>
        service.registerProduct(principal(), {
          ...body,
          programs: [
            parseReviewProgram({
              id: PROGRAM_ID,
              productId: PRODUCT_ID,
              name: 'Dangling program',
              environmentIds: [ENV_ID],
              // The registration declares `coh-returning` and nothing
              // else, so this reference cannot resolve.
              cohortId: 'coh-never-declared',
              triggers: [{ kind: 'manual' }],
              budget: { maxRunsPerDay: 10, maxRunsPerEvent: 1, maxCostUnitsPerDay: 100 },
            }),
          ],
        }),
      ),
    ).toBe('invalid-request');
  });

  it('refuses a program naming an environment that is not in the model', () => {
    const service = buildService({ dir: '/tmp/svc-reg-4' });
    expect(
      code(() =>
        service.registerProduct(principal(), {
          ...registrationBody(BASE_URL),
          programs: [
            parseReviewProgram({
              id: PROGRAM_ID,
              productId: PRODUCT_ID,
              name: 'Dangling program',
              environmentIds: ['env-never-declared'],
              cohortId: 'coh-returning',
              triggers: [{ kind: 'manual' }],
              budget: { maxRunsPerDay: 10, maxRunsPerEvent: 1, maxCostUnitsPerDay: 100 },
            }),
          ],
        }),
      ),
    ).toBe('invalid-request');
  });

  it('adds an environment afterwards and stores a model #57 still accepts', () => {
    const service = buildService({ dir: '/tmp/svc-reg-5' });
    service.registerProduct(principal(), registrationBody(BASE_URL));

    const next = service.registerEnvironment(principal(), {
      tenantId: 'tn-acme',
      productId: PRODUCT_ID,
      environment: parseEnvironment({
        id: 'env-production-like',
        productId: PRODUCT_ID,
        name: 'Production-like',
        environmentClass: 'productionLike',
        deploymentKind: 'versioned',
        endpoint: { baseUrl: 'https://prod.example' },
      }),
    });

    expect(next.environments.map((e) => e.id)).toEqual([ENV_ID, 'env-production-like']);
    expect(service.getProduct(principal(), PRODUCT_ID)).toEqual(next);
    // The composition is re-validated, so the stored model is one #57
    // would build itself.
    expect(() => buildProductModel({
      product: next.product,
      environments: next.environments,
      identities: next.identities,
      cohorts: next.cohorts,
      programs: next.programs,
    })).not.toThrow();
  });

  it('refuses to register the same environment twice', () => {
    const service = buildService({ dir: '/tmp/svc-reg-6' });
    service.registerProduct(principal(), registrationBody(BASE_URL));
    const env = {
      id: 'env-production-like',
      productId: PRODUCT_ID,
      name: 'Production-like',
      environmentClass: 'productionLike',
      deploymentKind: 'versioned',
      endpoint: { baseUrl: 'https://prod.example' },
    };
    service.registerEnvironment(principal(), { tenantId: 'tn-acme', productId: PRODUCT_ID, environment: env });
    expect(
      code(() =>
        service.registerEnvironment(principal(), {
          tenantId: 'tn-acme',
          productId: PRODUCT_ID,
          environment: env,
        }),
      ),
    ).toBe('duplicate-registration');
  });

  it('refuses an environment belonging to another product', () => {
    const service = buildService({ dir: '/tmp/svc-reg-7' });
    service.registerProduct(principal(), registrationBody(BASE_URL));
    expect(
      code(() =>
        service.registerEnvironment(principal(), {
          tenantId: 'tn-acme',
          productId: PRODUCT_ID,
          environment: parseEnvironment({
            id: 'env-foreign',
            productId: 'prd-someone-else',
            name: 'Foreign',
            environmentClass: 'staging',
            deploymentKind: 'versioned',
            endpoint: { baseUrl: 'https://foreign.example' },
          }),
        }),
      ),
    ).toBe('invalid-request');
  });

  it('refuses to add an environment to a product that was never registered', () => {
    const service = buildService({ dir: '/tmp/svc-reg-8' });
    expect(
      code(() =>
        service.registerEnvironment(principal(), {
          tenantId: 'tn-acme',
          productId: PRODUCT_ID,
          environment: parseEnvironment({
            id: 'env-x',
            productId: PRODUCT_ID,
            name: 'X',
            environmentClass: 'staging',
            deploymentKind: 'versioned',
            endpoint: { baseUrl: 'https://x.example' },
          }),
        }),
      ),
    ).toBe('product-not-found');
  });

  it('adds a Review Program afterwards and keeps the model consistent', () => {
    const service = buildService({ dir: '/tmp/svc-reg-9' });
    const body = registrationBody(BASE_URL);
    service.registerProduct(principal(), { ...body, programs: [] });

    const next = service.registerProgram(principal(), {
      tenantId: 'tn-acme',
      productId: PRODUCT_ID,
      program: parseReviewProgram({
        id: 'rp-nightly',
        productId: PRODUCT_ID,
        name: 'Nightly sweep',
        environmentIds: [ENV_ID],
        cohortId: 'coh-returning',
        triggers: [
          { kind: 'cadence', intervalMinutes: 60, timeZone: 'UTC' },
          { kind: 'event', event: 'deployment.completed', debounceMinutes: 5 },
        ],
        budget: { maxRunsPerDay: 24, maxRunsPerEvent: 2, maxCostUnitsPerDay: 5_000 },
      }),
    });

    expect(next.programs.map((p) => p.id)).toEqual(['rp-nightly']);
    expect(next.programs[0]?.triggers).toHaveLength(2);
    expect(next.programs[0]?.budget.maxRunsPerDay).toBe(24);
    expect(service.getProduct(principal(), PRODUCT_ID)).toEqual(next);
  });

  it('refuses a program that names a cohort the product does not declare', () => {
    const service = buildService({ dir: '/tmp/svc-reg-10' });
    service.registerProduct(principal(), { ...registrationBody(BASE_URL), programs: [] });
    expect(
      code(() =>
        service.registerProgram(principal(), {
          tenantId: 'tn-acme',
          productId: PRODUCT_ID,
          program: parseReviewProgram({
            id: 'rp-dangling',
            productId: PRODUCT_ID,
            name: 'Dangling',
            environmentIds: [ENV_ID],
            cohortId: 'coh-never-declared',
            triggers: [{ kind: 'manual' }],
            budget: { maxRunsPerDay: 1, maxRunsPerEvent: 1, maxCostUnitsPerDay: 10 },
          }),
        }),
      ),
    ).toBe('invalid-request');
    // The refused registration left nothing behind.
    expect(service.getProduct(principal(), PRODUCT_ID).programs).toHaveLength(0);
  });

  it('refuses a program belonging to another product', () => {
    const service = buildService({ dir: '/tmp/svc-reg-11' });
    service.registerProduct(principal(), { ...registrationBody(BASE_URL), programs: [] });
    expect(
      code(() =>
        service.registerProgram(principal(), {
          tenantId: 'tn-acme',
          productId: PRODUCT_ID,
          program: parseReviewProgram({
            id: 'rp-foreign',
            productId: 'prd-someone-else',
            name: 'Foreign',
            environmentIds: [ENV_ID],
            cohortId: 'coh-returning',
            triggers: [{ kind: 'manual' }],
            budget: { maxRunsPerDay: 1, maxRunsPerEvent: 1, maxCostUnitsPerDay: 10 },
          }),
        }),
      ),
    ).toBe('invalid-request');
  });

  it('scopes registration to the tenant: two tenants may register the same product id', () => {
    const store = buildStore();
    const service = buildService({ dir: '/tmp/svc-reg-12', store });

    const a = service.registerProduct(principal({ tenantId: 'tn-acme' }), registrationBody(BASE_URL));
    const b = service.registerProduct(
      principal({ tenantId: 'tn-other' }),
      registrationBody('https://other.example', ['idn-ava'], {}, 'tn-other'),
    );

    // Same `productId`, two tenants, two independent models. The key
    // space is tenant-prefixed, so this is isolation rather than a
    // collision.
    expect(a.product.id).toBe(b.product.id);
    expect(a.environments[0]?.endpoint.baseUrl).toBe(BASE_URL);
    expect(b.environments[0]?.endpoint.baseUrl).toBe('https://other.example');
    expect(service.getProduct(principal({ tenantId: 'tn-acme' }), PRODUCT_ID)).toEqual(a);
    expect(service.getProduct(principal({ tenantId: 'tn-other' }), PRODUCT_ID)).toEqual(b);
  });

  it('re-registering the same declaration in a different order is idempotent, not a change', () => {
    const service = buildService({ dir: '/tmp/svc-reg-order' });
    const first = service.registerProduct(principal(), registrationBody(BASE_URL));
    // A second environment, so the reordering is observable.
    service.registerEnvironment(principal(), {
      tenantId: 'tn-acme',
      productId: PRODUCT_ID,
      environment: parseEnvironment({
        id: 'env-production-like',
        productId: PRODUCT_ID,
        name: 'Production-like',
        environmentClass: 'productionLike',
        deploymentKind: 'versioned',
        endpoint: { baseUrl: 'https://prod.example' },
      }),
    });

    const reordered = registrationBody(BASE_URL);
    const again = service.registerProduct(principal(), {
      ...reordered,
      // Same entities, opposite order, and the extra one included.
      environments: [
        {
          id: 'env-production-like',
          productId: PRODUCT_ID,
          name: 'Production-like',
          environmentClass: 'productionLike',
          deploymentKind: 'versioned',
          endpoint: { baseUrl: 'https://prod.example' },
        },
        ...reordered.environments,
      ],
    });

    // An ordering difference is not a declaration difference. Comparing
    // the raw serialisations would refuse this, which reads as "the
    // service is finicky about ordering" rather than as a bug.
    expect(again.environments.map((e) => e.id)).toEqual([
      'env-staging',
      'env-production-like',
    ]);
    expect(first.environments).toHaveLength(1);
  });

  it('requires the capability to register, and does not infer it from a neighbouring one', () => {
    const service = buildService({ dir: '/tmp/svc-reg-13' });
    const readOnly = principal({ capabilities: ['product:read', 'job:read'] });
    try {
      service.registerProduct(readOnly, registrationBody(BASE_URL));
      throw new Error('expected a refusal');
    } catch (error) {
      if (!isServiceError(error)) throw error;
      expect(error.code).toBe('not-authorized');
      expect(error.field).toBe('principal.capabilities');
    }
    // ...and reading still works, so the capability is not all-or-nothing.
    expect(code(() => service.getProduct(readOnly, PRODUCT_ID))).toBe('product-not-found');
  });

  it('requires the identity the registration names to be well formed', () => {
    const service = buildService({ dir: '/tmp/svc-reg-14' });
    // The identity id carries the wrong brand prefix. #57 refuses it,
    // and the refusal is a `ProductDomainError` re-raised as a
    // `ServiceError` with its field preserved.
    try {
      service.registerProduct(principal(), {
        ...registrationBody(BASE_URL, ['idn-ava']),
        identities: [{ ...makeIdentity('idn-ava'), id: 'usr-ava' }],
      });
      throw new Error('expected a refusal');
    } catch (error) {
      if (!isServiceError(error)) throw error;
      expect(error.code).toBe('invalid-request');
      expect(error.detail['cause']).toBe('ProductDomainError');
      expect(error.field).toContain('identities[0]');
    }
  });
});
