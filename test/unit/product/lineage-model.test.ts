import { describe, it, expect } from 'vitest';
import {
  buildProduct,
  buildProductModel,
  findCohort,
  findEnvironment,
  findIdentity,
  findProgram,
  isReleaseTransitionComparison,
  parseCohortId,
  parseEnvironment,
  parseEnvironmentId,
  parseEvaluationRunId,
  parseEvidenceId,
  parseProduct,
  parseProductId,
  parseProductModel,
  parseReviewProgram,
  parseRunLineage,
  parseSyntheticCohort,
  parseSyntheticIdentity,
  ProductDomainError,
  sameTarget,
  targetKey,
} from '../../../src/product/index.js';

const target = {
  productId: parseProduct({ id: 'prd-a', slug: 'a', displayName: 'A' }).id,
  environmentId: 'env-staging' as const,
  cohortId: 'coh-a' as const,
  programId: 'rp-a' as const,
};

describe('run lineage', () => {
  const lineage = {
    runId: 'run-2026-10-01-0001',
    ...target,
    identityIds: ['idn-alice', 'idn-bob'],
    startedAt: '2026-10-01T00:00:00Z',
  };

  it('records the durable target, the resolved identities and the run window', () => {
    const l = parseRunLineage(lineage);
    expect(l.runId).toBe('run-2026-10-01-0001');
    expect(l.identityIds).toEqual(['idn-alice', 'idn-bob']);
    expect(l.startedAt).toBe('2026-10-01T00:00:00Z');
    expect('endedAt' in l).toBe(false);
  });

  it('accepts an end instant and evidence handles', () => {
    const l = parseRunLineage({
      ...lineage,
      endedAt: '2026-10-01T00:30:00Z',
      evidenceIds: ['ev-1', 'ev-2'],
    });
    expect(l.endedAt).toBe('2026-10-01T00:30:00Z');
    expect(l.evidenceIds).toEqual(['ev-1', 'ev-2']);
  });

  it('rejects an end instant before the start', () => {
    expect(() =>
      parseRunLineage({ ...lineage, startedAt: '2026-10-01T01:00:00Z', endedAt: '2026-10-01T00:00:00Z' }),
    ).toThrow(/must not precede startedAt/);
  });

  it('rejects an empty or duplicate identityIds list', () => {
    expect(() => parseRunLineage({ ...lineage, identityIds: [] })).toThrow(/must be a non-empty array/);
    expect(() => parseRunLineage({ ...lineage, identityIds: ['idn-alice', 'idn-alice'] })).toThrow(
      /duplicates: idn-alice/,
    );
  });

  it('rejects duplicate evidenceIds', () => {
    expect(() => parseRunLineage({ ...lineage, evidenceIds: ['ev-1', 'ev-1'] })).toThrow(
      /duplicates: ev-1/,
    );
  });

  it('rejects a target reference of the wrong kind', () => {
    expect(() => parseRunLineage({ ...lineage, environmentId: 'prd-a' })).toThrow(/must match/);
    expect(() => parseRunLineage({ ...lineage, cohortId: 'env-staging' })).toThrow(/must match/);
    expect(() => parseRunLineage({ ...lineage, identityIds: ['prd-a'] })).toThrow(/must match/);
  });

  it('rejects a non-ISO startedAt', () => {
    expect(() => parseRunLineage({ ...lineage, startedAt: '2026-10-01' })).toThrow(/explicit UTC offset/);
  });

  it('rejects an unknown field', () => {
    expect(() => parseRunLineage({ ...lineage, gitCommit: 'abc123' })).toThrow(/unknown field/);
  });

  it('rejects a malformed run or evidence handle', () => {
    expect(() => parseEvaluationRunId('run 1')).toThrow(/must be a valid EvaluationRunId handle/);
    expect(() => parseEvidenceId('')).toThrow(/must not be empty/);
    expect(() => parseEvidenceId(42)).toThrow(/must be a string/);
  });

  it('keeps the run id opaque: any well-formed foreign handle is accepted', () => {
    for (const runId of ['run-1', '2026-10-01T00:00:00Z', 'r/1', 'R_1', 'run:7@host']) {
      expect(parseEvaluationRunId(runId)).toBe(runId);
    }
  });
});

describe('lineage joins for a release transition', () => {
  const before = parseRunLineage({
    runId: 'run-a',
    productId: 'prd-task-tracker',
    environmentId: 'env-staging',
    cohortId: 'coh-beta',
    programId: 'rp-continuous',
    identityIds: ['idn-alice', 'idn-bob'],
    startedAt: '2026-10-01T00:00:00Z',
  });
  const after = parseRunLineage({
    runId: 'run-b',
    productId: 'prd-task-tracker',
    environmentId: 'env-staging',
    cohortId: 'coh-beta',
    programId: 'rp-continuous',
    identityIds: ['idn-alice', 'idn-carol'],
    startedAt: '2026-10-08T00:00:00Z',
  });

  it('joins two runs on the durable target', () => {
    expect(sameTarget(before, after)).toBe(true);
    expect(targetKey(before)).toBe('prd-task-tracker|env-staging|coh-beta|rp-continuous');
  });

  it('identifies a release-transition comparison by a shared identity', () => {
    expect(isReleaseTransitionComparison(before, after)).toBe(true);
  });

  it('does not treat a disjoint identity set as a returning-user observation', () => {
    const disjoint = parseRunLineage({
      runId: 'run-c',
      productId: 'prd-task-tracker',
      environmentId: 'env-staging',
      cohortId: 'coh-beta',
      programId: 'rp-continuous',
      identityIds: ['idn-dan', 'idn-erin'],
      startedAt: '2026-10-08T00:00:00Z',
    });
    expect(isReleaseTransitionComparison(before, disjoint)).toBe(false);
  });

  it('does not compare across different targets or a run with itself', () => {
    const otherEnv = parseRunLineage({
      runId: 'run-d',
      productId: 'prd-task-tracker',
      environmentId: 'env-production-like',
      cohortId: 'coh-beta',
      programId: 'rp-continuous',
      identityIds: ['idn-alice'],
      startedAt: '2026-10-08T00:00:00Z',
    });
    expect(sameTarget(before, otherEnv)).toBe(false);
    expect(isReleaseTransitionComparison(before, otherEnv)).toBe(false);
    expect(isReleaseTransitionComparison(before, before)).toBe(false);
  });
});

function modelParts() {
  const product = parseProduct({ id: 'prd-a', slug: 'a', displayName: 'A' });
  const environment = parseEnvironment({
    id: 'env-staging',
    productId: 'prd-a',
    name: 'Staging',
    environmentClass: 'staging',
    deploymentKind: 'continuous',
    endpoint: { baseUrl: 'https://staging.example' },
  });
  const identity = parseSyntheticIdentity({
    id: 'idn-alice',
    productId: 'prd-a',
    displayName: 'Alice',
    lifecycle: 'persistent',
    persona: 'A returning lead.',
    capability: {
      maxConcurrentSessions: 1,
      stateRetention: 'durable',
      permittedOrigins: ['https://staging.example'],
    },
    stateRef: 'alice',
  });
  const cohort = parseSyntheticCohort({
    id: 'coh-a',
    productId: 'prd-a',
    name: 'A',
    membership: { kind: 'explicit', identityIds: ['idn-alice'] },
  });
  const program = parseReviewProgram({
    id: 'rp-a',
    productId: 'prd-a',
    name: 'A',
    environmentIds: ['env-staging'],
    cohortId: 'coh-a',
    triggers: [{ kind: 'manual' }],
    budget: { maxRunsPerDay: 10, maxRunsPerEvent: 1, maxCostUnitsPerDay: 10 },
  });
  return { product, environment, identity, cohort, program };
}

describe('ProductModel referential integrity', () => {
  it('builds a model and resolves every reference', () => {
    const p = modelParts();
    const model = buildProductModel({
      product: p.product,
      environments: [p.environment],
      identities: [p.identity],
      cohorts: [p.cohort],
      programs: [p.program],
    });
    expect(findEnvironment(model, p.environment.id)).toBe(p.environment);
    expect(findIdentity(model, p.identity.id)).toBe(p.identity);
    expect(findCohort(model, p.cohort.id)).toBe(p.cohort);
    expect(findProgram(model, p.program.id)).toBe(p.program);
    expect(findEnvironment(model, parseEnvironmentId('env-missing'))).toBeUndefined();
    expect(findCohort(model, parseCohortId('coh-missing'))).toBeUndefined();
  });

  it('rejects an entity owned by another product', () => {
    const p = modelParts();
    const foreign = parseEnvironment({
      id: 'env-other',
      productId: 'prd-other',
      name: 'Other',
      environmentClass: 'staging',
      deploymentKind: 'continuous',
      endpoint: { baseUrl: 'https://other.example' },
    });
    expect(() =>
      buildProductModel({
        product: p.product,
        environments: [foreign],
        identities: [],
        cohorts: [],
        programs: [],
      }),
    ).toThrow(/belongs to prd-other, not to prd-a/);
  });

  it('rejects a duplicate id of the same kind', () => {
    const p = modelParts();
    expect(() =>
      buildProductModel({
        product: p.product,
        environments: [p.environment, p.environment],
        identities: [],
        cohorts: [],
        programs: [],
      }),
    ).toThrow(/duplicate id\(s\): env-staging/);
  });

  it('rejects a program pointing at a cohort outside the model', () => {
    const p = modelParts();
    expect(() =>
      buildProductModel({
        product: p.product,
        environments: [p.environment],
        identities: [p.identity],
        cohorts: [], // cohort omitted
        programs: [p.program],
      }),
    ).toThrow(/cohortId coh-a is not in this model/);
  });

  it('rejects a program pointing at an environment outside the model', () => {
    const p = modelParts();
    expect(() =>
      buildProductModel({
        product: p.product,
        environments: [], // environment omitted
        identities: [p.identity],
        cohorts: [p.cohort],
        programs: [p.program],
      }),
    ).toThrow(/environmentIds references env-staging, which is not in this model/);
  });

  it('rejects an explicit cohort membership naming a phantom identity', () => {
    const p = modelParts();
    expect(() =>
      buildProductModel({
        product: p.product,
        environments: [p.environment],
        identities: [], // identity omitted
        cohorts: [p.cohort],
        programs: [p.program],
      }),
    ).toThrow(/identityIds references idn-alice, which is not in this model/);
  });

  it('accepts a lifecycle-selected cohort with no identity list to resolve', () => {
    const p = modelParts();
    const byLifecycle = parseSyntheticCohort({
      id: 'coh-b',
      productId: 'prd-a',
      name: 'B',
      membership: { kind: 'byLifecycle', lifecycle: 'persistent' },
    });
    expect(() =>
      buildProductModel({
        product: p.product,
        environments: [p.environment],
        identities: [],
        cohorts: [byLifecycle],
        programs: [],
      }),
    ).not.toThrow();
  });

  it('freezes the model and its collections', () => {
    const p = modelParts();
    const model = buildProductModel({
      product: p.product,
      environments: [p.environment],
      identities: [p.identity],
      cohorts: [p.cohort],
      programs: [p.program],
    });
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.environments)).toBe(true);
    expect(Object.isFrozen(model.programs)).toBe(true);
  });

  it('round-trips through parseProductModel unchanged', () => {
    const p = modelParts();
    const model = buildProductModel({
      product: p.product,
      environments: [p.environment],
      identities: [p.identity],
      cohorts: [p.cohort],
      programs: [p.program],
    });
    const reloaded = parseProductModel(JSON.parse(JSON.stringify(model)));
    expect(reloaded).toEqual(model);
  });

  it('rejects an unknown field on the model', () => {
    const p = modelParts();
    expect(() =>
      parseProductModel({
        product: p.product,
        environments: [],
        identities: [],
        cohorts: [],
        programs: [],
        worldState: {},
      }),
    ).toThrow(/unknown field\(s\): worldState/);
  });

  it('rejects a model that is not an object', () => {
    expect(() => parseProductModel(null)).toThrow(ProductDomainError);
  });

  // Regression: parseProductModel used to `as`-cast each collection and
  // defer to buildProductModel, so a malformed element escaped validation
  // and surfaced as a raw TypeError ("environments.map is not a
  // function"). A caller catching ProductDomainError would miss it.
  it('deep-parses every element instead of casting it', () => {
    const malformed: ReadonlyArray<[string, unknown]> = [
      ['product', 'not-a-product'],
      ['environments', 'nope'],
      ['identities', 42],
      ['cohorts', {}],
      ['programs', 'x'],
    ];
    for (const [key, badValue] of malformed) {
      const model: Record<string, unknown> = {
        product: modelParts().product,
        environments: [],
        identities: [],
        cohorts: [],
        programs: [],
      };
      model[key] = badValue;
      let thrown: unknown;
      try {
        parseProductModel(model);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `${key} must be rejected`).toBeInstanceOf(ProductDomainError);
    }
  });

  it('reports the offending element path when a nested entity is malformed', () => {
    expect(() =>
      parseProductModel({
        product: modelParts().product,
        environments: [
          { id: 'env-staging', productId: 'prd-a', name: 'Staging' }, // missing class/endpoint
        ],
        identities: [],
        cohorts: [],
        programs: [],
      }),
    ).toThrow(/productModel\.environments\[0\]\.environmentClass/);
  });

  it('rejects a malformed element nested inside an otherwise valid model', () => {
    expect(() =>
      parseProductModel({
        product: modelParts().product,
        environments: [],
        identities: [
          {
            id: 'idn-alice',
            productId: 'prd-a',
            displayName: 'Alice',
            lifecycle: 'ephemeral',
            persona: 'p',
            // stateRetention contradicts the ephemeral lifecycle.
            capability: {
              maxConcurrentSessions: 1,
              stateRetention: 'durable',
              permittedOrigins: ['https://a.example'],
            },
            stateRef: 'alice',
          },
        ],
        cohorts: [],
        programs: [],
      }),
    ).toThrow(/is not permitted for lifecycle "ephemeral"/);
  });

  it('buildProduct applies the same constraints as parseProduct', () => {
    // Regression: buildProduct re-checked slug/displayName but not the
    // array constraints, so it accepted duplicates parseProduct rejects.
    expect(() =>
      buildProduct(
        { id: parseProductId('prd-a'), slug: 'a', displayName: 'A' },
        { labels: ['x', 'x'] },
      ),
    ).toThrow(/duplicates: x/);
    expect(() =>
      buildProduct({ id: parseProductId('prd-a'), slug: 'A', displayName: 'A' }),
    ).toThrow(/lowercase and hyphen-separated/);
  });

  it('omits absent optionals from a built product rather than storing undefined', () => {
    const p = buildProduct({ id: parseProductId('prd-a'), slug: 'a', displayName: 'A' }, {
      description: undefined as unknown as string,
    });
    expect('description' in p).toBe(false);
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });
});
