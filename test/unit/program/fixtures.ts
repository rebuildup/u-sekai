/**
 * Shared fixtures for the #62 planning tests.
 *
 * Everything here is built through #57's public `parse*` entry points,
 * which is the documented way for a downstream ticket to assemble a
 * model. No field is hand-assembled into a domain type, so a fixture
 * that would be rejected in production is rejected here too.
 *
 * Not a `.test.ts` file, so vitest does not collect it as a suite.
 */

import {
  environmentId,
  parseEnvironment,
  parseProduct,
  parseProductModel,
  parseReviewProgram,
  parseSyntheticCohort,
  parseSyntheticIdentity,
  reviewProgramId,
  type ProgramBudget,
  type ProductModel,
  type ReviewProgram,
} from '../../../src/product/index.js';
import {
  environmentVersion,
  observationId,
  parseTriggerSignal,
  type EnvironmentObservation,
  type StageCostRates,
} from '../../../src/program/index.js';

export { environmentId, reviewProgramId };

export const PRODUCT_ID = 'prd-task-tracker';
export const STAGING_ID = environmentId('env-staging');
export const PROD_LIKE_ID = environmentId('env-production-like');

export const STAGING_ORIGIN = 'https://staging.task-tracker.example';
export const PROD_LIKE_ORIGIN = 'https://preprod.task-tracker.example';

/**
 * Declared, provider-neutral cost rates.
 *
 * Scout 10, verification 50 per identity. With a planning ceiling of 5
 * a full plan costs 5*10 + 5*50 = 300 units, which makes the budget
 * arithmetic in the tests legible without hiding it behind a
 * helper.
 */
export const RATES: StageCostRates = Object.freeze({
  scoutUnitsPerIdentity: 10,
  verificationUnitsPerIdentity: 50,
});

export const IDENTITY_IDS = ['idn-ada', 'idn-bo', 'idn-cho'] as const;

export const DEFAULT_BUDGET: ProgramBudget = Object.freeze({
  maxRunsPerDay: 24,
  maxRunsPerEvent: 1,
  maxCostUnitsPerDay: 10_000,
});

function baseProduct() {
  return parseProduct({
    id: PRODUCT_ID,
    slug: 'task-tracker',
    displayName: 'Task Tracker',
  });
}

function baseEnvironments() {
  return [
    parseEnvironment({
      id: STAGING_ID,
      productId: PRODUCT_ID,
      name: 'Staging',
      environmentClass: 'staging',
      deploymentKind: 'continuous',
      endpoint: { baseUrl: STAGING_ORIGIN },
    }),
    parseEnvironment({
      id: PROD_LIKE_ID,
      productId: PRODUCT_ID,
      name: 'Production-like',
      environmentClass: 'productionLike',
      deploymentKind: 'versioned',
      endpoint: { baseUrl: PROD_LIKE_ORIGIN, additionalOrigins: ['https://www.task-tracker.example'] },
    }),
  ];
}

function baseIdentities() {
  return IDENTITY_IDS.map((id, i) =>
    parseSyntheticIdentity({
      id,
      productId: PRODUCT_ID,
      displayName: `Identity ${i + 1}`,
      lifecycle: 'release',
      persona: 'A returning user of a task tracker.',
      capability: {
        maxConcurrentSessions: 1,
        stateRetention: 'durable',
        permittedOrigins: [STAGING_ORIGIN, PROD_LIKE_ORIGIN],
      },
      stateRef: `state://${id}`,
    }),
  );
}

function baseCohorts() {
  return [
    // Resolvable count: the declaration names two identities.
    parseSyntheticCohort({
      id: 'coh-explicit',
      productId: PRODUCT_ID,
      name: 'Explicit pair',
      membership: { kind: 'explicit', identityIds: ['idn-ada', 'idn-bo'] },
    }),
    // Unresolvable count without #60: names a lifecycle, no size.
    parseSyntheticCohort({
      id: 'coh-release',
      productId: PRODUCT_ID,
      name: 'All release identities',
      membership: { kind: 'byLifecycle', lifecycle: 'release' },
    }),
    // Declared size.
    parseSyntheticCohort({
      id: 'coh-size',
      productId: PRODUCT_ID,
      name: 'Twenty release identities',
      membership: { kind: 'sizeTarget', lifecycle: 'release', targetSize: 20 },
    }),
  ];
}

export interface ModelOptions {
  readonly programs: ReadonlyArray<ReviewProgram>;
}

/** Assemble a model with the shared product/environments/identities/cohorts. */
export function makeModel(options: ModelOptions): ProductModel {
  return parseProductModel({
    product: baseProduct(),
    environments: baseEnvironments(),
    identities: baseIdentities(),
    cohorts: baseCohorts(),
    programs: options.programs,
  });
}

export interface ProgramOptions {
  readonly id: string;
  readonly triggers: ReadonlyArray<unknown>;
  readonly environmentIds?: ReadonlyArray<string>;
  readonly cohortId?: string;
  readonly budget?: Partial<ProgramBudget>;
  readonly notes?: string;
}

export function makeProgram(options: ProgramOptions): ReviewProgram {
  return parseReviewProgram({
    id: options.id,
    productId: PRODUCT_ID,
    name: `Program ${options.id}`,
    environmentIds: options.environmentIds ?? [STAGING_ID],
    cohortId: options.cohortId ?? 'coh-release',
    triggers: options.triggers,
    budget: { ...DEFAULT_BUDGET, ...options.budget },
    ...(options.notes !== undefined ? { notes: options.notes } : {}),
  });
}

/** A cadence-only program: 60 minutes, anchored at 2026-03-02T00:00Z. */
export const CADENCE_60M = Object.freeze({
  kind: 'cadence',
  intervalMinutes: 60,
  timeZone: 'Asia/Tokyo',
  startAt: '2026-03-02T00:00:00.000Z',
});

/** A deployment event trigger with a 10 minute quiet period. */
export const DEPLOYMENT_TRIGGER = Object.freeze({
  kind: 'event',
  event: 'deployment.completed',
  debounceMinutes: 10,
});

export const MANUAL_TRIGGER = Object.freeze({ kind: 'manual' });

/** The slot grid the 60-minute cadence produces around the test instants. */
export const ANCHOR = '2026-03-02T00:00:00.000Z';

/** A typed environment observation, built through the declaration helpers. */
export function observation(input: {
  readonly observationId: string;
  readonly environmentId: string;
  readonly version: string;
  readonly observedAt: string;
}): EnvironmentObservation {
  return {
    observationId: observationId(input.observationId),
    environmentId: environmentId(input.environmentId),
    version: environmentVersion(input.version),
    observedAt: input.observedAt,
  };
}

/** A delivered manual request. */
export function manualSignal(deliveryId: string, requestedAt: string) {
  return parseTriggerSignal({ kind: 'manual', deliveryId, requestedAt });
}

/** A delivered deployment completion. */
export function deploymentSignal(
  deliveryId: string,
  occurredAt: string,
  event = 'deployment.completed',
) {
  return parseTriggerSignal({ kind: 'event', deliveryId, event, occurredAt });
}
