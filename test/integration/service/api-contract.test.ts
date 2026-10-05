/**
 * #66 acceptance: the API's shape.
 *
 * | criterion | observable asserted here |
 * | --- | --- |
 * | API contract is asynchronous-job shaped even if the first implementation executes locally | `submitTriggerEvaluation` resolves to a `queued` job and the executor is called **zero** times; a separate `runJob` is what executes |
 * | Customer-facing API never exposes model provider selection as required input | every endpoint refuses a body carrying `model` / `provider` / `modelId` / `apiKey` with `unknown-field` |
 * | Tenant/Product boundaries are explicit in request and storage interfaces | every request without `tenantId` is refused; a tenant's job is invisible and unfetchable from another tenant |
 *
 * Plus the "nothing ambient" property, which is what makes the first
 * two true at all: two services in one process, with different clocks
 * and different tenants, do not influence each other.
 */

import { describe, expect, it } from 'vitest';

import { isServiceError, type ServiceErrorCode } from '../../../src/service/index.js';
import {
  buildService,
  buildStore,
  expectedModel,
  fixedClock,
  manualTrigger,
  principal,
  PROGRAM_ID,
  PRODUCT_ID,
  registrationBody,
  stillClock,
} from './support/fixtures.js';
import { fakeExecutor } from './support/doubles.js';

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

async function codeAsync(fn: () => Promise<unknown>): Promise<ServiceErrorCode> {
  try {
    await fn();
  } catch (error) {
    if (isServiceError(error)) return error.code;
    throw error;
  }
  throw new Error('expected a ServiceError, nothing was thrown');
}

function registered(dir: string, clock?: () => string) {
  const executor = fakeExecutor();
  const store = buildStore();
  const service = buildService({ dir, store, executor, ...(clock ? { clock } : {}) });
  service.registerProduct(principal(), registrationBody(BASE_URL));
  return { service, store, executor };
}

describe('#66 API contract', () => {
  it('is asynchronous-job shaped: submitting returns a queued job and executes nothing', () => {
    const { service, executor } = registered('/tmp/svc-async');

    const result = service.submitTriggerEvaluation(
      principal(),
      manualTrigger('jb-async-1', 'dlv-async-1', '2026-10-05T09:00:00.000Z'),
    );

    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error('expected an accepted trigger');
    expect(result.job.status).toBe('queued');
    expect(result.job.outcome).toEqual({ kind: 'notStarted' });
    // The observable that makes the claim: the executor is reachable
    // and was not called.
    expect(executor.calls).toHaveLength(0);
  });

  it('never exposes model provider selection: every endpoint refuses one', () => {
    const { service } = registered('/tmp/svc-provider');
    const providerish = { model: 'gpt-4o', provider: 'openai', modelId: 'gpt-4o', apiKey: 'sk-test' };

    expect(code(() => service.submitTriggerEvaluation(principal(), {
      ...manualTrigger('jb-p-1', 'dlv-p-1', '2026-10-05T09:00:00.000Z'),
      ...providerish,
    }))).toBe('unknown-field');

    expect(code(() => service.registerProduct(principal(), {
      ...registrationBody(BASE_URL),
      ...providerish,
    }))).toBe('unknown-field');

    expect(code(() => service.listJobs(principal(), { tenantId: 'tn-acme', ...providerish }))).toBe(
      'unknown-field',
    );
    expect(code(() => service.getFindings(principal(), {
      tenantId: 'tn-acme',
      programId: PROGRAM_ID,
      ...providerish,
    }))).toBe('unknown-field');
    expect(code(() => service.cancelJob(principal(), {
      tenantId: 'tn-acme',
      jobId: 'jb-p-1',
      reason: 'not needed',
      ...providerish,
    }))).toBe('unknown-field');
    expect(code(() => service.getJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-p-1', ...providerish }))).toBe(
      'unknown-field',
    );
  });

  it('names a credential in the refusal, so a client is not left believing one was read', () => {
    const { service } = registered('/tmp/svc-cred');
    try {
      service.submitTriggerEvaluation(principal(), {
        ...manualTrigger('jb-c-1', 'dlv-c-1', '2026-10-05T09:00:00.000Z'),
        anthropicApiKey: 'sk-ant-should-never-be-here',
      });
      throw new Error('expected a refusal');
    } catch (error) {
      if (!isServiceError(error)) throw error;
      expect(error.code).toBe('unknown-field');
      expect(error.message).toContain('a credential is never read here');
    }
  });

  it('makes the tenant explicit: a request without one is refused', () => {
    const { service } = registered('/tmp/svc-tenant');
    expect(code(() => service.listJobs(principal(), { productId: PRODUCT_ID }))).toBe('invalid-request');
    expect(code(() => service.getFindings(principal(), { programId: PROGRAM_ID }))).toBe('invalid-request');
    expect(code(() => service.registerProduct(principal(), {
      ...registrationBody(BASE_URL),
      tenantId: undefined,
    }))).toBe('invalid-request');
  });

  it('makes the product boundary explicit in storage: one tenant cannot see another tenant\'s job', () => {
    const { service } = registered('/tmp/svc-iso', stillClock());
    service.submitTriggerEvaluation(
      principal(),
      manualTrigger('jb-iso-1', 'dlv-iso-1', '2026-10-05T09:00:00.000Z'),
    );

    const other = principal({ tenantId: 'tn-other' });
    expect(code(() => service.getJob(other, { tenantId: 'tn-other', jobId: 'jb-iso-1' }))).toBe(
      'job-not-found',
    );
    expect(code(() => service.getFindings(other, { tenantId: 'tn-other', jobId: 'jb-iso-1' }))).toBe(
      'job-not-found',
    );
    expect(service.listJobs(other, { tenantId: 'tn-other' })).toHaveLength(0);
    // ...and the cross-tenant read is refused at the authority layer,
    // not merely empty.
    expect(code(() => service.listJobs(other, { tenantId: 'tn-acme' }))).toBe('not-authorized');
  });

  it('holds the product boundary: an unregistered product cannot be triggered', () => {
    const { service } = registered('/tmp/svc-product');
    expect(code(() => service.submitTriggerEvaluation(principal(), {
      ...manualTrigger('jb-np-1', 'dlv-np-1', '2026-10-05T09:00:00.000Z'),
      productId: 'prd-not-registered',
    }))).toBe('product-not-found');
  });

  it('reads nothing ambient: two services in one process do not influence each other', async () => {
    const a = registered('/tmp/svc-ambient-a', fixedClock('2026-10-05T09:00:00.000Z'));
    const b = registered('/tmp/svc-ambient-b', fixedClock('2026-11-30T23:00:00.000Z'));

    const first = a.service.submitTriggerEvaluation(
      principal(),
      manualTrigger('jb-amb-a', 'dlv-amb-a', '2026-10-05T09:00:00.000Z'),
    );
    const second = b.service.submitTriggerEvaluation(
      principal(),
      manualTrigger('jb-amb-b', 'dlv-amb-b', '2026-11-30T23:00:00.000Z'),
    );

    if (!first.accepted || !second.accepted) throw new Error('expected both accepted');
    // Each service stamped its own clock, so neither read a process
    // clock and neither saw the other's work.
    expect(first.job.submittedAt.startsWith('2026-10-05')).toBe(true);
    expect(second.job.submittedAt.startsWith('2026-11-30')).toBe(true);
    expect(a.service.listJobs(principal(), { tenantId: 'tn-acme' }).map((j) => j.id)).toEqual([
      'jb-amb-a',
    ]);
    expect(b.service.listJobs(principal(), { tenantId: 'tn-acme' }).map((j) => j.id)).toEqual([
      'jb-amb-b',
    ]);
  });

  it('requires a declared cost unit to start, and applies no default', () => {
    expect(code(() => buildService({ dir: '/tmp/svc-nocost', cost: undefined }))).toBe(
      'missing-cost-policy',
    );
    expect(code(() => buildService({ dir: '/tmp/svc-nocost', cost: { reportableDecimals: 2 } }))).toBe(
      'invalid-request',
    );
    expect(code(() => buildService({ dir: '/tmp/svc-nocost', cost: { unit: 'x' } }))).toBe(
      'invalid-request',
    );
  });

  it('registers the same product twice without complaint, and refuses a changed one', () => {
    const { service } = registered('/tmp/svc-rereg');
    const again = service.registerProduct(principal(), registrationBody(BASE_URL));
    expect(again).toEqual(expectedModel(BASE_URL));

    expect(
      code(() =>
        service.registerProduct(principal(), {
          ...registrationBody(BASE_URL),
          product: { id: PRODUCT_ID, slug: 'task-tracker', displayName: 'Renamed Tracker' },
        }),
      ),
    ).toBe('duplicate-registration');
  });

  it('refuses to run a job when no executor is configured, rather than reporting success', async () => {
    const service = buildService({ dir: '/tmp/svc-noexec' });
    service.registerProduct(principal(), registrationBody(BASE_URL));
    const accepted = service.submitTriggerEvaluation(
      principal(),
      manualTrigger('jb-noexec', 'dlv-noexec', '2026-10-05T09:00:00.000Z'),
    );
    if (!accepted.accepted) throw new Error('expected an accepted trigger');

    expect(await codeAsync(() => service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-noexec' }))).toBe(
      'invalid-request',
    );
    // The refusal must not have advanced the job into a success.
    expect(service.getJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-noexec' }).status).toBe('queued');
  });
});
