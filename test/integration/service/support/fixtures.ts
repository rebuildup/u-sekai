/**
 * Shared builders for the service integration suite (issue #66).
 *
 * The same two rules the runtime suite follows, for the same reasons:
 *
 * 1. **Every fixture goes through the owning layer's own parser.** A
 *    Product, Environment, Identity, Cohort, Review Program, cost
 *    policy, principal and job id are all built by the module that owns
 *    them. A fixture therefore cannot describe a value the real contract
 *    would reject, and the tests keep working when those contracts
 *    tighten.
 * 2. **Nothing reaches a live provider.** Every Reasoner is a local
 *    deterministic double, so the suite needs no API key and CI's
 *    "never depends on external keys" rule stays true.
 *
 * ## The clock is always injected
 *
 * `createService` takes a required `clock`, and these builders hand it
 * a fixed one. A control plane that read the wall clock would stamp
 * jobs with instants no test could pin — and "two submissions of the
 * same trigger" would depend on how long the first one took.
 */

import * as path from 'node:path';

import {
  buildProduct,
  buildProductModel,
  parseEnvironment,
  parseReviewProgram,
  parseSyntheticCohort,
  parseSyntheticIdentity,
  type EnvironmentId,
  type ProductModel,
  type ReviewProgramId,
  type SyntheticIdentity,
  type SyntheticIdentityId,
} from '../../../../src/product/index.js';
import { FileRecordStore, CohortStateService } from '../../../../src/cohort/index.js';
import { environmentVersion, observationId } from '../../../../src/program/index.js';
import type { EnvironmentObservation } from '../../../../src/program/index.js';
import { ScriptedProvisioningProvider } from '../../../../src/operator/index.js';
import type { OperatorStep } from '../../../../src/operator/index.js';
import { HttpAdapter } from '../../../../src/adapter/browser/http-adapter.js';
import {
  createRuntimeExecutor,
  createService,
  InMemoryServiceStore,
  parseServiceCostPolicy,
  tenantId,
  type EvaluationControlPlane,
  type EvaluationExecutor,
  type FeedbackSink,
  type ServiceCostPolicy,
  type ServicePrincipal,
  type ServiceStore,
  type TenantId,
} from '../../../../src/service/index.js';
import {
  defaultParticipantProfile,
  type RuntimeConfiguration,
  type RuntimeReasonerFactory,
} from '../../../../src/runtime/index.js';
import { startServer, type ServerHandle } from '../../../../src/demo/environment/server.js';
import type { ParticipantAction } from '../../../../src/domain/capability.js';
import type {
  Reasoner,
  ReasonerRequest,
  ReasonerResponse,
} from '../../../../src/domain/reasoner.js';
import type { ObserverFindingSeverity } from '../../../../src/domain/observer.js';
import { detectStructuredOutputKind } from '../../../../src/reasoner/structured.js';

export const PRODUCT_ID = 'prd-task-tracker';
export const ENV_ID = 'env-staging';
export const COHORT_ID = 'coh-returning';
export const PROGRAM_ID = 'rp-continuous';

/**
 * The declared cost unit this suite runs under.
 *
 * A unit and a precision, both *declared*. The test process is not
 * making a product decision: it is proving that a declared policy is
 * carried through and that no figure is published without one. The
 * "what is the real unit" question is open and is reported, not
 * settled here.
 */
export const DECLARED_COST: ServiceCostPolicy = parseServiceCostPolicy({
  unit: 'svc.microcredits',
  reportableDecimals: 4,
});

/* -------------------------------------------------------------------------- */
/* Clocks                                                                        */
/* -------------------------------------------------------------------------- */

/** A deterministic clock advancing `stepMs` per call. */
export function fixedClock(start = '2026-10-05T09:00:00.000Z', stepMs = 1_000): () => string {
  let t = Date.parse(start);
  let count = 0;
  return () => {
    if (count > 0) t += stepMs;
    count += 1;
    return new Date(t).toISOString();
  };
}

/** A clock that does not advance. For tests that submit twice. */
export function stillClock(at = '2026-10-05T09:00:00.000Z'): () => string {
  return () => new Date(at).toISOString();
}

/* -------------------------------------------------------------------------- */
/* Principals                                                                    */
/* -------------------------------------------------------------------------- */

export const ALL_CAPABILITIES = [
  'product:register',
  'product:read',
  'environment:register',
  'program:register',
  'job:submit',
  'job:read',
  'job:cancel',
  'finding:read',
  'disposition:submit',
] as const;

export function principal(overrides: { readonly tenantId?: string; readonly capabilities?: ReadonlyArray<string> } = {}): ServicePrincipal {
  return {
    tenantId: tenantId(overrides.tenantId ?? 'tn-acme'),
    subject: 'svc-fixture',
    capabilities: (overrides.capabilities ?? ALL_CAPABILITIES) as ServicePrincipal['capabilities'],
  };
}

/* -------------------------------------------------------------------------- */
/* Durable model                                                                 */
/* -------------------------------------------------------------------------- */

export function makeEnvironment(baseUrl: string, id: string = ENV_ID): EnvironmentId {
  parseEnvironment({
    id,
    productId: PRODUCT_ID,
    name: id,
    environmentClass: 'staging',
    deploymentKind: 'versioned',
    endpoint: { baseUrl },
  });
  return id as EnvironmentId;
}

export function makeIdentity(
  id: string,
  lifecycle: 'ephemeral' | 'release' | 'persistent' = 'persistent',
  /** The origin the identity may reach. Defaults to the declared one. */
  permittedOrigins: ReadonlyArray<string> = ['https://staging.task-tracker.example'],
): SyntheticIdentity {
  const retention = lifecycle === 'ephemeral' ? 'none' : 'durable';
  return parseSyntheticIdentity({
    id,
    productId: PRODUCT_ID,
    displayName: id,
    lifecycle,
    persona: `A ${lifecycle} synthetic user evaluating the task tracker.`,
    capability: {
      maxConcurrentSessions: 1,
      stateRetention: retention,
      permittedOrigins: [...permittedOrigins],
    },
    ...(retention === 'none' ? {} : { stateRef: `state://${id}` }),
  });
}

export function makeCohort(identityIds: ReadonlyArray<string>) {
  return parseSyntheticCohort({
    id: COHORT_ID,
    productId: PRODUCT_ID,
    name: 'Returning users',
    membership: { kind: 'explicit', identityIds: [...identityIds] },
  });
}

export interface ProgramSpec {
  readonly triggers?: ReadonlyArray<Record<string, unknown>>;
  readonly maxRunsPerDay?: number;
  readonly maxRunsPerEvent?: number;
  readonly maxCostUnitsPerDay?: number;
}

export function makeProgram(
  environmentIds: ReadonlyArray<string>,
  spec: ProgramSpec = {},
) {
  return parseReviewProgram({
    id: PROGRAM_ID,
    productId: PRODUCT_ID,
    name: 'Continuous review program',
    environmentIds: [...environmentIds],
    cohortId: COHORT_ID,
    triggers: (spec.triggers ?? [{ kind: 'manual' }]) as never,
    budget: {
      maxRunsPerDay: spec.maxRunsPerDay ?? 100,
      maxRunsPerEvent: spec.maxRunsPerEvent ?? 10,
      maxCostUnitsPerDay: spec.maxCostUnitsPerDay ?? 10_000,
    },
  });
}

/**
 * The registration body, in wire shape.
 *
 * Built through #57's parsers and then re-serialised, so the service
 * receives exactly the JSON a client would send rather than a
 * pre-validated object graph.
 */
export function registrationBody(
  baseUrl: string,
  identityIds: ReadonlyArray<string> = ['idn-ava'],
  programSpec: ProgramSpec = {},
  tenant = 'tn-acme',
) {
  return {
    tenantId: tenant,
    product: buildProduct({ id: PRODUCT_ID as ProductModel['product']['id'], slug: 'task-tracker', displayName: 'Task Tracker' }),
    environments: [makeEnvironmentSpec(baseUrl)],
    identities: identityIds.map((id) => makeIdentity(id, 'persistent', [baseUrl])),
    cohorts: [makeCohort(identityIds)],
    programs: [makeProgram([ENV_ID], programSpec)],
  };
}

function makeEnvironmentSpec(baseUrl: string) {
  return {
    id: ENV_ID,
    productId: PRODUCT_ID,
    name: ENV_ID,
    environmentClass: 'staging',
    deploymentKind: 'versioned',
    endpoint: { baseUrl },
  };
}

/** The model the registration above produces, composed by #57. */
export function expectedModel(
  baseUrl: string,
  identityIds: ReadonlyArray<string> = ['idn-ava'],
  programSpec: ProgramSpec = {},
): ProductModel {
  return buildProductModel({
    product: buildProduct({ id: PRODUCT_ID as ProductModel['product']['id'], slug: 'task-tracker', displayName: 'Task Tracker' }),
    environments: [makeEnvironmentSpec(baseUrl)].map((e) => parseEnvironment(e)),
    identities: identityIds.map((id) => makeIdentity(id, 'persistent', [baseUrl])),
    cohorts: [makeCohort(identityIds)],
    programs: [makeProgram([ENV_ID], programSpec)],
  });
}

/**
 * The environment version this suite evaluates against.
 *
 * #63 refuses to run a plan that declares no observed version: "the
 * version is unknown" is a fact worth refusing to record, because a
 * guessed version poisons the next release-transition join. So every
 * test that executes a real run must hand the planner an observation
 * to stamp, and these tests do so explicitly rather than through a
 * fixture default that would hide the requirement.
 */
export function makeObservation(
  environment: string = ENV_ID,
  version = '2026.10.5',
  observedAt = '2026-10-05T08:45:00.000Z',
): EnvironmentObservation {
  return {
    observationId: observationId(`obs-${environment}-${version}`),
    environmentId: environment as EnvironmentId,
    version: environmentVersion(version),
    observedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                      */
/* -------------------------------------------------------------------------- */

export function manualTrigger(jobId: string, deliveryId: string, requestedAt: string) {
  return {
    tenantId: 'tn-acme',
    jobId,
    productId: PRODUCT_ID,
    programId: PROGRAM_ID,
    signal: { kind: 'manual', deliveryId, requestedAt },
  };
}

/* -------------------------------------------------------------------------- */
/* Service assembly                                                              */
/* -------------------------------------------------------------------------- */

export interface ServiceHarnessOptions {
  readonly clock?: () => string;
  readonly store?: ServiceStore;
  readonly executor?: EvaluationExecutor;
  readonly feedback?: FeedbackSink;
  /** Omit to build one that refuses every disposition. */
  readonly cost?: unknown;
  readonly planningCeiling?: number;
  /**
   * Version observations handed to the planner. Omit and no plan carries
   * an observed version, so #63 refuses to execute — visibly, as a
   * `failed` job carrying its reason.
   */
  readonly observations?: ReadonlyArray<EnvironmentObservation>;
  readonly dir: string;
}

/**
 * A control plane with no executor and no feedback sink.
 *
 * Those omissions are the point: several criteria are about what the
 * service *refuses* (running with no executor, dispositioning with no
 * ledger), and a harness that always supplied a working collaborator
 * could not observe them.
 */
export function buildService(options: ServiceHarnessOptions): EvaluationControlPlane {
  return createService({
    // `'cost' in options` rather than `??`: a test that passes an
    // explicit `undefined` is asserting that *no* default is applied,
    // and `??` would quietly substitute one and make that test pass for
    // the wrong reason.
    ...('cost' in options ? { cost: options.cost } : { cost: DECLARED_COST }),
    planning: {
      planningCeiling: options.planningCeiling ?? 4,
      rates: { scoutUnitsPerIdentity: 2, verificationUnitsPerIdentity: 5 },
      maxMutatingActions: 0,
      operatorAuthorityRefs: ['pol-staging'],
      ...(options.observations !== undefined
        ? { observations: () => options.observations as ReadonlyArray<EnvironmentObservation> }
        : {}),
    },
    ...(options.store !== undefined ? { store: options.store } : {}),
    ...(options.executor !== undefined ? { executor: options.executor } : {}),
    ...(options.feedback !== undefined ? { feedback: options.feedback } : {}),
    clock: options.clock ?? fixedClock(),
  });
}

/** A store, kept so a test can read the ledger it is asserting on. */
export function buildStore(): InMemoryServiceStore {
  return new InMemoryServiceStore();
}

/* -------------------------------------------------------------------------- */
/* Runtime harness (for the end-to-end path)                                   */
/* -------------------------------------------------------------------------- */

export interface RuntimeHarnessRoot {
  readonly server: ServerHandle;
  readonly dir: string;
  readonly cleanup: () => Promise<void>;
}

export async function startRuntimeRoot(): Promise<RuntimeHarnessRoot> {
  const server = await startServer({ port: 0 });
  const dir = path.join('/tmp', `u-sekai-service-${process.pid}-${Math.abs(hash(String(server.baseUrl)))}`);
  return {
    server,
    dir,
    cleanup: async () => {
      await server.close();
      const { rm } = await import('node:fs/promises');
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (h * 31 + value.charCodeAt(i)) | 0;
  }
  return h;
}

export interface RuntimeHarnessOptions {
  readonly identities?: ReadonlyArray<string>;
  /** The declared provisioning plan. Empty means no privileged setup. */
  readonly steps?: ReadonlyArray<OperatorStep>;
  readonly connector?: ScriptedProvisioningProvider;
  /** A policy that grants nothing, so the gate refuses. */
  readonly denyAll?: boolean;
  readonly observerFindings?: ReadonlyArray<{ id: string; summary: string; severity?: ObserverFindingSeverity }>;
  readonly script?: ReadonlyArray<ParticipantAction>;
}

export interface RuntimeHarness {
  readonly executor: EvaluationExecutor;
  readonly connector: ScriptedProvisioningProvider;
  readonly baseUrl: string;
}

/**
 * A real `EvaluationExecutor` over #63's runtime, with a scripted
 * connector and a scripted Reasoner.
 *
 * The point of using the real runtime rather than a stub is the
 * operator gate: "a denial means zero connector calls" is only
 * observable when something actually would have dispatched.
 *
 * ## Why it seeds #60's store
 *
 * This is the composition root's job, and it is not the control
 * plane's. `registerProduct` is a *declaration* into the service's
 * registry; #60's durable identity/cohort store is a separate store
 * that #63's runtime resolves membership from. A hosted deployment
 * wires both, and the service package deliberately does not own the
 * second one — writing a model here and an identity there would be a
 * two-store write with no transaction across it, and a half-applied
 * one would surface as "the run failed to resolve a cohort nobody
 * declared". `docs` note in `service.ts` records the wiring
 * requirement for #65.
 */
export async function buildRuntimeExecutor(root: RuntimeHarnessRoot, options: RuntimeHarnessOptions = {}): Promise<RuntimeHarness> {
  const identityIds = options.identities ?? ['idn-ava'];
  const baseUrl = root.server.baseUrl;
  const connector =
    options.connector ??
    new ScriptedProvisioningProvider({ connectorId: 'scripted-connector' });
  const clock = fixedClock();
  const cohort = new CohortStateService({
    store: new FileRecordStore({ rootDir: path.join(root.dir, 'cohort') }),
    now: fixedClock(),
  });

  const model = expectedModel(baseUrl, identityIds);
  const config: RuntimeConfiguration = {
    model,
    cohort,
    experiment: {
      userStory: 'Add a task to the list.',
      outDir: path.join(root.dir, 'artifacts'),
      seed: 'service-66',
      maxStepsPerIdentity: 6,
      participantReasoner: { provider: 'scripted', seed: 'service-66' },
      observerReasoner: { provider: 'scripted', seed: 'service-66' },
    },
    setup: {
      policy: options.denyAll === true ? denyAllPolicy(baseUrl) : stagingPolicy(baseUrl),
      connector,
      clock: { now: clock },
      steps: options.steps ?? [],
      reason: 'issue 66 integration fixture',
    },
    adapterFactory: () => new HttpAdapter(),
    reasonerFactory: reasonerFactory({
      observerFindings: options.observerFindings ?? [],
      ...(options.script !== undefined ? { script: options.script } : {}),
    }),
    now: clock,
    participantProfile: defaultParticipantProfile,
  };

  for (const identity of model.identities) {
    await cohort.declareIdentity(identity);
  }
  await cohort.declareCohort(
    parseSyntheticCohort({
      id: COHORT_ID,
      productId: PRODUCT_ID,
      name: 'Returning users',
      membership: { kind: 'explicit', identityIds: [...identityIds] },
    }),
  );

  return { executor: createRuntimeExecutor(config), connector, baseUrl };
}

function denyAllPolicy(baseUrl: string): Record<string, unknown> {
  return {
    policyId: 'pol-staging',
    environments: [
      {
        environmentId: ENV_ID,
        environmentClass: 'staging',
        baseUrl,
        destructiveAllowed: false,
        productionDestructive: false,
      },
    ],
    grantedSteps: [],
    maxRisk: 'sandbox',
    stepUnits: {},
    realMoney: { mode: 'denied' },
    budget: { maxStepsPerDay: 1, maxUnitsPerDay: 1 },
    allowedSeedTemplates: [],
  };
}

function stagingPolicy(baseUrl: string): Record<string, unknown> {
  return {
    policyId: 'pol-staging',
    environments: [
      {
        environmentId: ENV_ID,
        environmentClass: 'staging',
        baseUrl,
        destructiveAllowed: true,
        productionDestructive: false,
      },
    ],
    // `fixture.reset` is part of the runtime's own declared plan for a
    // real environment, so the granting policy has to name it. Its
    // absence is a useful reminder that a policy is a *declaration*
    // that has to cover what the plan actually asks for.
    grantedSteps: ['account.create', 'account.retire', 'fixture.seed', 'fixture.reset'],
    maxRisk: 'destructive',
    stepUnits: { 'account.create': 1, 'account.retire': 0, 'fixture.seed': 1, 'fixture.reset': 0 },
    realMoney: { mode: 'denied' },
    budget: { maxStepsPerDay: 100, maxUnitsPerDay: 100 },
    allowedSeedTemplates: ['empty-board'],
  };
}

export function accountCreateStep(identityId: SyntheticIdentityId, origin = 'https://staging.example'): OperatorStep {
  return {
    kind: 'account.create',
    resourceKey: 'acct-primary',
    origin,
    identityId,
    displayName: 'Synthetic user',
  };
}

export function reasonerFactory(options: {
  readonly script?: ReadonlyArray<ParticipantAction>;
  readonly observerFindings?: ReadonlyArray<{
    id: string;
    summary: string;
    severity?: ObserverFindingSeverity;
  }>;
}): RuntimeReasonerFactory {
  return (_config, ctx) => {
    let cursor = 0;
    const script = ctx.script ?? options.script ?? [
      { kind: 'clickByCoords', x: 10, y: 10 },
      { kind: 'wait', milliseconds: 10 },
      { kind: 'finish', reason: 'done' },
    ];
    return {
      providerId: 'scripted',
      modelId: 'scripted:service-66',
      complete: async (request: ReasonerRequest): Promise<ReasonerResponse> => {
        const kind = detectStructuredOutputKind(request.systemPrompt);
        if (kind === 'selfReport') {
          return {
            kind: 'selfReport',
            content: {
              goal: 'Add a task to the list.',
              productUnderstanding: 'A single-page task list with one text field.',
              confusionPoints: ['I could not tell whether the task was saved'],
              resultAlignedWithExpectation: true,
              confidence: 0.6,
              wouldReturn: true,
              freeText: 'It worked once I found the field.',
            },
            usage: { inputTokens: 32, outputTokens: 32 },
          };
        }
        if (kind === 'observerFindings') {
          return {
            kind: 'observerFindings',
            content: {
              summary: 'The run reached the product and produced a trace.',
              findings: (options.observerFindings ?? []).map((f) => ({
                id: f.id,
                stepIndex: null,
                severity: f.severity ?? 'major',
                category: 'confusion',
                summary: f.summary,
                evidenceRefs: [{ kind: 'observation' as const, ref: f.id }],
              })),
              terminationVerdict: { declared: 'finish', plausible: true, note: 'Fixture observer.' },
            },
            usage: { inputTokens: 64, outputTokens: 64 },
          };
        }
        if (cursor >= script.length) {
          return {
            kind: 'action',
            action: { kind: 'finish', reason: 'script exhausted' },
            rationale: 'Script exhausted.',
            usage: { inputTokens: 16, outputTokens: 16 },
          };
        }
        const action = script[cursor] as ParticipantAction;
        cursor += 1;
        return {
          kind: 'action',
          action,
          rationale: `scripted step ${cursor}`,
          usage: { inputTokens: 16, outputTokens: 16 },
        };
      },
    } satisfies Reasoner;
  };
}

export type { TenantId, ReviewProgramId };
