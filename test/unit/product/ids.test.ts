import { describe, it, expect } from 'vitest';
import {
  cohortId,
  environmentId,
  MAX_ID_LENGTH,
  parseCohortId,
  parseEnvironmentId,
  parseProductId,
  parseReviewProgramId,
  parseSyntheticIdentityId,
  productId,
  ProductDomainError,
  reviewProgramId,
  syntheticIdentityId,
} from '../../../src/product/index.js';

describe('durable id construction', () => {
  it('accepts a well-formed id of each kind', () => {
    expect(productId('prd-task-tracker')).toBe('prd-task-tracker');
    expect(environmentId('env-staging')).toBe('env-staging');
    expect(syntheticIdentityId('idn-alice-2')).toBe('idn-alice-2');
    expect(cohortId('coh-beta-returners')).toBe('coh-beta-returners');
    expect(reviewProgramId('rp-continuous-staging')).toBe('rp-continuous-staging');
  });

  it('accepts a single-segment slug', () => {
    expect(productId('prd-a')).toBe('prd-a');
    expect(environmentId('env-1')).toBe('env-1');
  });

  it('brands are erased at runtime: a value is its own string', () => {
    const id = productId('prd-task-tracker');
    expect(typeof id).toBe('string');
    expect(JSON.stringify({ id })).toBe('{"id":"prd-task-tracker"}');
  });
});

describe('durable id rejection', () => {
  it('rejects an id missing its kind prefix', () => {
    expect(() => productId('task-tracker')).toThrow(ProductDomainError);
    expect(() => environmentId('staging')).toThrow(/must match/);
  });

  it('rejects an id carrying the wrong kind prefix', () => {
    // A ProductId reloaded as an EnvironmentId is exactly the cross-kind
    // confusion the prefix exists to catch.
    expect(() => environmentId('prd-task-tracker')).toThrow(ProductDomainError);
    expect(() => cohortId('env-staging')).toThrow(ProductDomainError);
    expect(() => reviewProgramId('coh-beta')).toThrow(ProductDomainError);
  });

  it('rejects uppercase, whitespace, leading/trailing separators and empty segments', () => {
    for (const bad of [
      'PRD-task-tracker',
      'prd-Task-Tracker',
      'prd-task-tracker ',
      ' prd-task-tracker',
      'prd--task',
      'prd-task-',
      '-prd-task',
      'prd-',
      'prd_task_tracker',
      'prd task tracker',
      'prd.task.tracker',
      'prd/task',
      'prd-task_tracker!',
    ]) {
      expect(() => productId(bad), `should reject ${JSON.stringify(bad)}`).toThrow(ProductDomainError);
    }
  });

  it('rejects an empty string and a non-string', () => {
    expect(() => productId('')).toThrow(ProductDomainError);
    expect(() => productId(undefined as unknown as string)).toThrow(/must be a string/);
    expect(() => productId(42 as unknown as string)).toThrow(/must be a string/);
  });

  it('rejects an id longer than MAX_ID_LENGTH', () => {
    const tooLong = `prd-${'a'.repeat(MAX_ID_LENGTH)}`;
    expect(tooLong.length).toBeGreaterThan(MAX_ID_LENGTH);
    expect(() => productId(tooLong)).toThrow(new RegExp(`at most ${MAX_ID_LENGTH} characters`));

    const atLimit = `prd-${'a'.repeat(MAX_ID_LENGTH - 'prd-'.length)}`;
    expect(atLimit).toHaveLength(MAX_ID_LENGTH);
    expect(() => productId(atLimit)).not.toThrow();
  });
});

describe('durable id re-read from unknown input', () => {
  it('accepts a string re-read from storage', () => {
    expect(parseProductId('prd-task-tracker')).toBe('prd-task-tracker');
    expect(parseEnvironmentId('env-staging')).toBe('env-staging');
    expect(parseSyntheticIdentityId('idn-alice')).toBe('idn-alice');
    expect(parseCohortId('coh-beta')).toBe('coh-beta');
    expect(parseReviewProgramId('rp-continuous')).toBe('rp-continuous');
  });

  it('rejects non-string input rather than coercing it', () => {
    for (const bad of [null, undefined, 42, true, {}, [], ['prd-a']]) {
      expect(() => parseProductId(bad), `should reject ${JSON.stringify(bad) ?? 'undefined'}`).toThrow(
        /must be a string/,
      );
    }
  });

  it('rejects a string of the wrong kind', () => {
    expect(() => parseProductId('env-staging')).toThrow(/must match/);
  });

  it('reports the offending field in the error', () => {
    try {
      parseEnvironmentId('nope', 'program.environmentIds[3]');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProductDomainError);
      expect((err as ProductDomainError).field).toBe('program.environmentIds[3]');
      expect((err as ProductDomainError).kind).toBe('product_domain_error');
    }
  });
});

describe('durable id stability across a reload', () => {
  it('returns the identical value for identical input, repeatedly', () => {
    for (let i = 0; i < 1000; i += 1) {
      expect(productId('prd-task-tracker')).toBe('prd-task-tracker');
    }
  });

  it('round-trips through JSON without change', () => {
    const ids = {
      product: productId('prd-task-tracker'),
      environment: environmentId('env-staging'),
      identity: syntheticIdentityId('idn-alice'),
      cohort: cohortId('coh-beta'),
      program: reviewProgramId('rp-continuous'),
    };
    const reloaded = JSON.parse(JSON.stringify(ids)) as typeof ids;
    expect(parseProductId(reloaded.product)).toBe(ids.product);
    expect(parseEnvironmentId(reloaded.environment)).toBe(ids.environment);
    expect(parseSyntheticIdentityId(reloaded.identity)).toBe(ids.identity);
    expect(parseCohortId(reloaded.cohort)).toBe(ids.cohort);
    expect(parseReviewProgramId(reloaded.program)).toBe(ids.program);
  });
});
