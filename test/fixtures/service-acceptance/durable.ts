/**
 * Durable declarations for the 0.4.0 acceptance scenario (Issue #67).
 *
 * ## Every value here goes through the layer that owns its grammar
 *
 * A `Product`, `Environment`, `SyntheticIdentity`, `SyntheticCohort` and
 * `ReviewProgram` are built by #57 (`src/product/**`); an `EvaluationPlan`
 * by #62 (`src/program/**`); an operator authority policy by #59
 * (`src/operator/**`). Nothing in this file hand-assembles an object of
 * those shapes, so a fixture cannot describe a value the real contract
 * would refuse — the scenario would fail here, loudly, rather than
 * passing on a shape no deployment could produce.
 *
 * ## Why two environments and one environment *name*
 *
 * #69's `EnvironmentInstanceKey` is derived from
 * `(product, name, version, seed)`, so "two versions of the same
 * environment" is expressible as two instances sharing a `name`. But
 * #57's `Environment` — the durable model the runtime resolves a run's
 * target URL from — carries **no version**, and one `EnvironmentId` has
 * exactly one `endpoint.baseUrl`. Two simultaneously live deployments of
 * the same environment therefore have to be declared as two
 * `EnvironmentId`s, and the thing that ties them together as *versions of
 * one environment* is the shared declared `name` plus #69's instance
 * keys, both asserted by the scenario.
 *
 * This is reported, not worked around. See the PR's known limitations:
 * `RunLineage` carries no version identity either (Issue #83), so the
 * version boundary is observable in the durable cohort state and the
 * transition journal, and **not** on the lineage a finding carries.
 *
 * ## Determinism
 *
 * One monotonic clock drives every instant in the scenario, and it is
 * shared with the World Operator's `OperatorClock`, so the run lineage
 * and the operator audit cannot disagree about ordering. A scenario that
 * reads well on a fast machine and fails on a slow one is a flaky test,
 * and a flaky test is worse than none.
 */

import {
  buildProduct,
  buildProductModel,
  environmentId,
  parseEnvironment,
  parseReviewProgram,
  parseSyntheticCohort,
  parseSyntheticIdentity,
  productId,
  reviewProgramId,
  type CohortId,
  type EnvironmentId,
  type ProductId,
  type ProductModel,
  type ReviewProgramId,
  type StateRetention,
  type SyntheticCohort,
  type SyntheticIdentity,
  type SyntheticIdentityId,
} from '../../../src/product/index.js';
import {
  authorityRef,
  buildEvaluationPlan,
  environmentVersion,
  idempotencyKey,
  observationId,
  planKeyFrom,
  triggerDeliveryId,
  type EnvironmentObservation,
  type EvaluationMode,
  type EvaluationPlan,
} from '../../../src/program/index.js';

/* -------------------------------------------------------------------------- */
/* Declared identities of this scenario                                          */
/* -------------------------------------------------------------------------- */

export const PRODUCT_ID: ProductId = productId('prd-task-tracker');

/** Version A. The earlier deployment, live for the whole comparison. */
export const VERSION_A = '2026.10.1';
/** Version B. Promoted over A by the scenario's A->B transition. */
export const VERSION_B = '2026.10.2';

/**
 * The declared environment *name* both instances share. It is the field
 * that makes the two `EnvironmentId`s two versions of one environment
 * rather than two unrelated products' deployments.
 */
export const ENVIRONMENT_NAME = 'staging';

export const ENV_A: EnvironmentId = environmentId('env-staging-version-a');
export const ENV_B: EnvironmentId = environmentId('env-staging-version-b');

/** Cohort that holds an ephemeral and a persistent identity at once. */
export const MIXED_COHORT_ID: CohortId = 'coh-mixed' as CohortId;
/** Cohort that spans the A->B transition. */
export const RETURNING_COHORT_ID: CohortId = 'coh-returning' as CohortId;
/** Control cohort: same environment, no retained history behind it. */
export const CONTROL_COHORT_ID: CohortId = 'coh-control' as CohortId;

export const MIXED_PROGRAM_ID: ReviewProgramId = reviewProgramId('rp-continuous');
export const RETURNING_PROGRAM_ID: ReviewProgramId = reviewProgramId('rp-transition');
export const CONTROL_PROGRAM_ID: ReviewProgramId = reviewProgramId('rp-control');

export const EPHEMERAL_ID: SyntheticIdentityId = 'idn-ephemeral-nova' as SyntheticIdentityId;
export const PERSISTENT_ID: SyntheticIdentityId = 'idn-persistent-iris' as SyntheticIdentityId;
export const RETURNING_ID: SyntheticIdentityId = 'idn-returning-leo' as SyntheticIdentityId;
export const CONTROL_ID: SyntheticIdentityId = 'idn-control-fresh' as SyntheticIdentityId;

export type Lifecycle = 'ephemeral' | 'release' | 'persistent';

export interface IdentitySpec {
  readonly id: SyntheticIdentityId;
  readonly lifecycle: Lifecycle;
  readonly displayName: string;
  readonly persona: string;
  /** Origins the identity is permitted to reach. */
  readonly permittedOrigins: ReadonlyArray<string>;
}

/**
 * A `SyntheticIdentity` through #57's own parser.
 *
 * The retention default follows #57's lifecycle/retention table, which is
 * the point: this fixture cannot declare an `ephemeral` identity that
 * claims durable state, because #57 refuses it here.
 */
export function makeIdentity(spec: IdentitySpec): SyntheticIdentity {
  const retention: StateRetention = spec.lifecycle === 'ephemeral' ? 'none' : 'durable';
  return parseSyntheticIdentity({
    id: spec.id,
    productId: PRODUCT_ID,
    displayName: spec.displayName,
    lifecycle: spec.lifecycle,
    persona: spec.persona,
    capability: {
      maxConcurrentSessions: 1,
      stateRetention: retention,
      permittedOrigins: [...spec.permittedOrigins],
    },
    ...(retention === 'none' ? {} : { stateRef: `state://${spec.id}` }),
  });
}

/** The three identity declarations the scenario uses, with real origins. */
export function scenarioIdentities(baseUrlA: string, baseUrlB: string): {
  readonly ephemeral: IdentitySpec;
  readonly persistent: IdentitySpec;
  readonly returning: IdentitySpec;
  readonly control: IdentitySpec;
} {
  const origins = [baseUrlA, baseUrlB];
  return {
    ephemeral: {
      id: EPHEMERAL_ID,
      lifecycle: 'ephemeral',
      displayName: 'Nova (ephemeral)',
      persona:
        'A first-time visitor to this task tracker. You have no history here and you ' +
        'assume a task list starts empty.',
      permittedOrigins: origins,
    },
    persistent: {
      id: PERSISTENT_ID,
      lifecycle: 'persistent',
      displayName: 'Iris (persistent)',
      persona:
        'A Synthetic User who keeps coming back to this task tracker across review ' +
        'programmes. You remember what you did in earlier sessions.',
      permittedOrigins: origins,
    },
    returning: {
      id: RETURNING_ID,
      lifecycle: 'release',
      displayName: 'Leo (returning)',
      persona:
        'A Synthetic User who used the previous version of this task tracker and is ' +
        'returning to the newer one. You remember the task you created last time.',
      permittedOrigins: origins,
    },
    control: {
      id: CONTROL_ID,
      lifecycle: 'persistent',
      displayName: 'Control (no prior history)',
      persona:
        'A Synthetic User seeing this task tracker for the first time. You have no ' +
        'history here and you assume a task list starts empty.',
      permittedOrigins: origins,
    },
  };
}

function makeCohort(id: CohortId, name: string, identityIds: ReadonlyArray<SyntheticIdentityId>): SyntheticCohort {
  return parseSyntheticCohort({
    id,
    productId: PRODUCT_ID,
    name,
    membership: { kind: 'explicit', identityIds: [...identityIds] },
  });
}

function makeProgram(
  id: ReviewProgramId,
  name: string,
  cohortId: CohortId,
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReturnType<typeof parseReviewProgram> {
  return parseReviewProgram({
    id,
    productId: PRODUCT_ID,
    name,
    environmentIds: [...environmentIds],
    cohortId,
    triggers: [{ kind: 'manual' }],
    budget: { maxRunsPerDay: 100, maxRunsPerEvent: 10, maxCostUnitsPerDay: 10_000 },
  });
}

export interface ModelInput {
  readonly baseUrlA: string;
  readonly baseUrlB: string;
  readonly identities: ReadonlyArray<SyntheticIdentity>;
}

/**
 * The durable model, assembled through #57's own builder.
 *
 * The two environments' `endpoint.baseUrl` values are the two live
 * #69 instances' origins, so the model the runtime resolves targets
 * against is literally the pair the scenario started.
 */
export function buildScenarioModel(input: ModelInput): ProductModel {
  const environments = [ENV_A, ENV_B].map((id) =>
    parseEnvironment({
      id,
      productId: PRODUCT_ID,
      // The same declared name on both sides: two versions of one
      // environment, not two environments.
      name: ENVIRONMENT_NAME,
      environmentClass: 'staging',
      deploymentKind: 'versioned',
      endpoint: { baseUrl: id === ENV_A ? input.baseUrlA : input.baseUrlB },
    }),
  );

  return buildProductModel({
    product: buildProduct(
      { id: PRODUCT_ID, slug: 'task-tracker', displayName: 'Task Tracker' },
      { description: 'Acceptance-scenario product for issue #67.' },
    ),
    environments,
    identities: [...input.identities],
    cohorts: [
      makeCohort(MIXED_COHORT_ID, 'Ephemeral and persistent, side by side', [
        EPHEMERAL_ID,
        PERSISTENT_ID,
      ]),
      makeCohort(RETURNING_COHORT_ID, 'Returns across the A->B transition', [RETURNING_ID]),
      makeCohort(CONTROL_COHORT_ID, 'Control: no retained history behind it', [CONTROL_ID]),
    ],
    programs: [
      makeProgram(MIXED_PROGRAM_ID, 'Continuous review programme', MIXED_COHORT_ID, [ENV_A, ENV_B]),
      makeProgram(RETURNING_PROGRAM_ID, 'Release-transition review programme', RETURNING_COHORT_ID, [
        ENV_A,
        ENV_B,
      ]),
      makeProgram(CONTROL_PROGRAM_ID, 'Control review programme', CONTROL_COHORT_ID, [ENV_B]),
    ],
  });
}

/* -------------------------------------------------------------------------- */
/* Plans                                                                        */
/* -------------------------------------------------------------------------- */

export interface PlanInput {
  readonly programId: ReviewProgramId;
  readonly cohortId: CohortId;
  readonly environmentId: EnvironmentId;
  readonly version: string;
  readonly observedAt: string;
  readonly mode: EvaluationMode;
  /** A `delivery` keeps two runs of one plan distinguishable by key. */
  readonly delivery: string;
  /** Present only on the run that completes a transition. */
  readonly previousObservation?: {
    readonly environmentId: EnvironmentId;
    readonly version: string;
    readonly observedAt: string;
  };
  readonly planningCeiling?: number;
}

function observation(
  id: EnvironmentId,
  version: string,
  observedAt: string,
  label: string,
): EnvironmentObservation {
  return {
    observationId: observationId(`obs-${label}`),
    environmentId: id,
    version: environmentVersion(version),
    observedAt,
  };
}

/** An `EvaluationPlan` through #62's own builder. */
export function buildScenarioPlan(input: PlanInput): EvaluationPlan {
  const current = observation(input.environmentId, input.version, input.observedAt, 'current');
  const previous =
    input.previousObservation === undefined
      ? undefined
      : observation(
          input.previousObservation.environmentId,
          input.previousObservation.version,
          input.previousObservation.observedAt,
          'previous',
        );

  return buildEvaluationPlan({
    planKey: planKeyFrom([input.programId, input.environmentId, input.delivery]),
    idempotencyKey: idempotencyKey(['idem', input.delivery]),
    mode: input.mode,
    productId: PRODUCT_ID,
    environmentId: input.environmentId,
    cohortId: input.cohortId,
    programId: input.programId,
    trigger: {
      kind: 'event',
      dueAt: input.observedAt,
      deliveryId: triggerDeliveryId(`dlv-${input.delivery}`),
      event: 'deployment.completed',
      debounceMinutes: 0,
    },
    cohort: {
      cohortId: input.cohortId,
      membership: { kind: 'explicit', identityIds: [] },
      declaredIdentityCount: null,
      planningCeiling: input.planningCeiling ?? 4,
      plannedIdentities: input.planningCeiling ?? 4,
    },
    escalation: {
      kind: 'cheapScoutThenVerification',
      maxVerifications: 0,
      verificationCostUnits: 0,
      reservedUpFront: true,
    },
    budget: {
      costUnits: 10,
      scoutCostUnits: 10,
      verificationCostUnits: 0,
      maxRunsPerDay: 100,
      maxRunsPerEvent: 10,
      maxCostUnitsPerDay: 10_000,
    },
    authority: {
      operatorAuthorityRefs: [authorityRef('pol-acceptance')],
      // The two live instances, so the plan's declared authority and the
      // environment the participant is actually driven to are the same
      // thing rather than a coincidence.
      environmentOrigins: [`https://${input.environmentId}.example`],
      maxParticipantStateRetention: 'durable',
      retentionResolution: 'cohort-lifecycle',
      maxMutatingActions: 0,
    },
    observedVersion: current,
    ...(previous === undefined
      ? {}
      : {
          lineage: {
            previous,
            current,
            kind:
              previous.environmentId === current.environmentId
                ? ('sameEnvironment' as const)
                : ('crossEnvironment' as const),
          },
        }),
  });
}

/* -------------------------------------------------------------------------- */
/* Clock                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A monotonic deterministic clock shared by the runtime and the World
 * Operator, so no two records in the scenario can disagree about order.
 */
export function scenarioClock(start = '2026-10-01T00:00:00.000Z', stepMs = 1_000): () => string {
  let instant = Date.parse(start);
  let count = 0;
  return () => {
    if (count > 0) instant += stepMs;
    count += 1;
    return new Date(instant).toISOString();
  };
}
