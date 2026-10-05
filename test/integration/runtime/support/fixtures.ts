/**
 * Shared builders for the runtime integration suite (issue #63).
 *
 * Everything here is deterministic: a fixed clock, declared ids and
 * fixed instants. A vertical-slice test that reads well on a fast
 * machine and fails on a slow one is a flaky test, and a flaky test is
 * worse than no test because it trains reviewers to re-run instead of
 * read.
 *
 * The two rules the suite follows throughout:
 *
 * 1. **Every fixture goes through the owning layer's own parser.**
 *    A Product, Environment, Identity, Cohort and Review Program are
 *    built by #57; a plan by #62; a provisioning policy by #59. A
 *    fixture can therefore never describe a value the real contract
 *    would reject, and the tests keep working when those contracts
 *    tighten.
 * 2. **Nothing reaches a live provider.** The Reasoner is a local
 *    deterministic double, so the suite needs no API key and the CI
 *    profile's "never depends on external keys" rule (#3 of CLAUDE.md)
 *    stays true.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildProduct,
  buildProductModel,
  environmentId,
  parseEnvironment,
  parseReviewProgram,
  parseSyntheticCohort,
  parseSyntheticIdentity,
  type CohortId,
  type EnvironmentId,
  type ProductModel,
  type ReviewProgramId,
  type SyntheticCohort,
  type SyntheticIdentity,
  type SyntheticIdentityId,
} from '../../../../src/product/index.js';
import { FileRecordStore, CohortStateService } from '../../../../src/cohort/index.js';
import {
  buildEvaluationPlan,
  observationId,
  planKeyFrom,
  idempotencyKey,
  triggerDeliveryId,
  environmentVersion,
  authorityRef,
  type EnvironmentObservation,
  type EvaluationMode,
  type EvaluationPlan,
  type RetentionResolution,
} from '../../../../src/program/index.js';
import type { StateRetention } from '../../../../src/product/index.js';
import { ScriptedProvisioningProvider } from '../../../../src/operator/index.js';
import type { OperatorClock, OperatorStep } from '../../../../src/operator/index.js';
import type { ParticipantAction } from '../../../../src/domain/capability.js';
import type { Reasoner, ReasonerRequest, ReasonerResponse } from '../../../../src/domain/reasoner.js';
import type { ObserverFindingSeverity } from '../../../../src/domain/observer.js';
import { detectStructuredOutputKind } from '../../../../src/reasoner/structured.js';

export const PRODUCT_ID = 'prd-task-tracker';
export const ENV_A = 'env-alpha';
export const ENV_B = 'env-beta';
export const COHORT_ID = 'coh-returning';
export const PROGRAM_ID = 'rp-continuous';

export function asEnvironmentId(value: string): EnvironmentId {
  return environmentId(value);
}

/* -------------------------------------------------------------------------- */
/* Clocks                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A monotonic deterministic clock.
 *
 * Each call advances by `stepMs`, so every instant a run stamps is
 * ordered and reproducible. The World Operator's `OperatorClock` is
 * built from the *same* source in {@link linkedOperatorClock} so the
 * audit log and the run lineage cannot disagree about when things
 * happened.
 */
export function fixedClock(start = '2026-10-01T00:00:00.000Z', stepMs = 1_000): () => string {
  let t = Date.parse(start);
  let count = 0;
  return () => {
    if (count > 0) t += stepMs;
    count += 1;
    return new Date(t).toISOString();
  };
}

/** An `OperatorClock` over the same counter as a {@link fixedClock}. */
export function linkedOperatorClock(clock: () => string): OperatorClock {
  return { now: clock };
}

/* -------------------------------------------------------------------------- */
/* Durable model                                                                 */
/* -------------------------------------------------------------------------- */

export interface EnvironmentSpec {
  readonly id: string;
  readonly baseUrl: string;
  readonly environmentClass?: 'develop' | 'preRelease' | 'staging' | 'productionLike' | 'production';
  readonly deploymentKind?: 'continuous' | 'versioned' | 'static';
}

export function makeEnvironment(spec: EnvironmentSpec): ReturnType<typeof parseEnvironment> {
  return parseEnvironment({
    id: spec.id,
    productId: PRODUCT_ID,
    name: spec.id,
    environmentClass: spec.environmentClass ?? 'staging',
    deploymentKind: spec.deploymentKind ?? 'versioned',
    endpoint: { baseUrl: spec.baseUrl },
  });
}

export interface IdentitySpec {
  readonly id: string;
  readonly lifecycle: 'ephemeral' | 'release' | 'persistent';
  readonly displayName?: string;
  readonly persona?: string;
  readonly permittedOrigins?: ReadonlyArray<string>;
}

/**
 * A `SyntheticIdentity` through #57's own parser.
 *
 * The retention default follows #57's lifecycle/retention table, which
 * is the point: a fixture cannot describe an `ephemeral` identity that
 * claims durable state, because #57 refuses it here rather than in the
 * test that eventually trips over it.
 */
export function makeIdentity(spec: IdentitySpec): SyntheticIdentity {
  const retention = spec.lifecycle === 'ephemeral' ? 'none' : 'durable';
  return parseSyntheticIdentity({
    id: spec.id,
    productId: PRODUCT_ID,
    displayName: spec.displayName ?? spec.id,
    lifecycle: spec.lifecycle,
    persona: spec.persona ?? `A ${spec.lifecycle} synthetic user exploring the task tracker.`,
    capability: {
      maxConcurrentSessions: 1,
      stateRetention: retention,
      permittedOrigins: spec.permittedOrigins ?? ['https://staging.task-tracker.example'],
    },
    ...(retention === 'none' ? {} : { stateRef: `state://${spec.id}` }),
  });
}

export function makeExplicitCohort(identityIds: ReadonlyArray<string>): SyntheticCohort {
  return parseSyntheticCohort({
    id: COHORT_ID,
    productId: PRODUCT_ID,
    name: 'Explicit cohort',
    membership: { kind: 'explicit', identityIds: [...identityIds] },
  });
}

export function makeProgram(environmentIds: ReadonlyArray<string>): ReturnType<typeof parseReviewProgram> {
  return parseReviewProgram({
    id: PROGRAM_ID,
    productId: PRODUCT_ID,
    name: 'Continuous review program',
    environmentIds: [...environmentIds],
    cohortId: COHORT_ID,
    triggers: [{ kind: 'manual' }],
    budget: { maxRunsPerDay: 100, maxRunsPerEvent: 10, maxCostUnitsPerDay: 10_000 },
  });
}

export interface ModelSpec {
  readonly environments: ReadonlyArray<EnvironmentSpec>;
  readonly identities: ReadonlyArray<IdentitySpec>;
}

export function makeModel(spec: ModelSpec): ProductModel {
  const environmentIds = spec.environments.map((e) => e.id);
  return buildProductModel({
    product: buildProduct(
      { id: PRODUCT_ID as ProductModel['product']['id'], slug: 'task-tracker', displayName: 'Task Tracker' },
      { description: 'Integration fixture product.' },
    ),
    environments: spec.environments.map(makeEnvironment),
    identities: spec.identities.map(makeIdentity),
    cohorts: [makeExplicitCohort(spec.identities.map((i) => i.id))],
    programs: [makeProgram(environmentIds)],
  });
}

/* -------------------------------------------------------------------------- */
/* Plans                                                                         */
/* -------------------------------------------------------------------------- */

export interface PlanSpec {
  readonly environmentId: string;
  readonly version: string;
  readonly observedAt: string;
  readonly mode?: EvaluationMode;
  /** Delivery suffix, so two runs of the same plan get distinct plan keys. */
  readonly delivery?: string;
  readonly maxMutatingActions?: number;
  readonly planningCeiling?: number;
  readonly maxParticipantStateRetention?: StateRetention;
  readonly retentionResolution?: RetentionResolution;
  readonly previousObservation?: { readonly environmentId: string; readonly version: string; readonly observedAt: string };
}

export function makeObservation(
  environmentId: string,
  version: string,
  observedAt: string,
  label: string,
): EnvironmentObservation {
  return {
    observationId: observationId(`obs-${label}`),
    environmentId: asEnvironmentId(environmentId),
    version: environmentVersion(version),
    observedAt,
  };
}

/**
 * An `EvaluationPlan` through #62's own builder.
 *
 * `previousObservation` produces a `releaseTransition` plan carrying
 * real `VersionLineage`, which is what #63's release-transition test
 * needs: the version history is genuine lineage rather than a
 * hand-assembled pair.
 */
export function makePlan(spec: PlanSpec): EvaluationPlan {
  const mode = spec.mode ?? (spec.previousObservation === undefined ? 'continuous' : 'releaseTransition');
  const current = makeObservation(spec.environmentId, spec.version, spec.observedAt, 'current');
  const delivery = spec.delivery ?? `${spec.environmentId}-${spec.version}`;

  const previous =
    spec.previousObservation === undefined
      ? undefined
      : makeObservation(
          spec.previousObservation.environmentId,
          spec.previousObservation.version,
          spec.previousObservation.observedAt,
          'previous',
        );

  return buildEvaluationPlan({
    planKey: planKeyFrom([PROGRAM_ID, spec.environmentId, delivery]),
    idempotencyKey: idempotencyKey(['idem', delivery]),
    mode,
    productId: PRODUCT_ID as EvaluationPlan['target']['productId'],
    environmentId: asEnvironmentId(spec.environmentId),
    cohortId: COHORT_ID as CohortId,
    programId: PROGRAM_ID as ReviewProgramId,
    trigger: {
      kind: 'event',
      dueAt: spec.observedAt,
      deliveryId: triggerDeliveryId(`dlv-${delivery}`),
      event: 'deployment.completed',
      debounceMinutes: 0,
    },
    cohort: {
      cohortId: COHORT_ID as CohortId,
      membership: { kind: 'explicit', identityIds: [] },
      declaredIdentityCount: null,
      planningCeiling: spec.planningCeiling ?? 4,
      plannedIdentities: spec.planningCeiling ?? 4,
    },
    escalation: { kind: 'cheapScoutThenVerification', maxVerifications: 0, verificationCostUnits: 0, reservedUpFront: true },
    budget: {
      costUnits: 10,
      scoutCostUnits: 10,
      verificationCostUnits: 0,
      maxRunsPerDay: 100,
      maxRunsPerEvent: 10,
      maxCostUnitsPerDay: 10_000,
    },
    authority: {
      operatorAuthorityRefs: [authorityRef('pol-staging')],
      environmentOrigins: [`https://${spec.environmentId}.example`],
      maxParticipantStateRetention: spec.maxParticipantStateRetention ?? 'durable',
      retentionResolution: spec.retentionResolution ?? 'cohort-lifecycle',
      maxMutatingActions: spec.maxMutatingActions ?? 0,
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
/* Operator                                                                      */
/* -------------------------------------------------------------------------- */

/** A staging policy that grants exactly the step the fixture declares. */
export function stagingPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    policyId: 'pol-staging',
    environments: [
      {
        environmentId: ENV_A,
        environmentClass: 'staging',
        baseUrl: 'https://alpha.example',
        destructiveAllowed: true,
        productionDestructive: false,
      },
      {
        environmentId: ENV_B,
        environmentClass: 'staging',
        baseUrl: 'https://beta.example',
        destructiveAllowed: true,
        productionDestructive: false,
      },
    ],
    grantedSteps: ['account.create', 'account.retire', 'fixture.seed', 'fixture.reset'],
    maxRisk: 'destructive',
    stepUnits: { 'account.create': 1, 'account.retire': 0, 'fixture.seed': 1, 'fixture.reset': 0 },
    realMoney: { mode: 'denied' },
    budget: { maxStepsPerDay: 100, maxUnitsPerDay: 100 },
    allowedSeedTemplates: ['empty-board'],
    ...overrides,
  };
}

export function accountCreateStep(
  identityId: SyntheticIdentityId,
  origin = 'https://alpha.example',
  resourceKey = 'acct-primary',
): OperatorStep {
  return {
    kind: 'account.create',
    resourceKey,
    origin,
    identityId,
    displayName: 'Synthetic user',
  };
}

export function makeConnector(
  options: ConstructorParameters<typeof ScriptedProvisioningProvider>[0] = {},
): ScriptedProvisioningProvider {
  return new ScriptedProvisioningProvider({ connectorId: 'scripted-connector', ...options });
}

/* -------------------------------------------------------------------------- */
/* Reasoner                                                                      */
/* -------------------------------------------------------------------------- */

export interface ObserverFindingSpec {
  readonly id: string;
  readonly summary: string;
  readonly severity?: ObserverFindingSeverity;
  readonly category?: string;
  readonly stepIndex?: number | null;
}

/**
 * A privileged primitive a scripted Reasoner can be made to attempt.
 *
 * These four are the whole of `PRIVILEGED_ACTION_KINDS`: a request for
 * one of them is a genuine `CapabilityViolation` even when its payload
 * is malformed, because the intent to reach outside the human-facing
 * set is unambiguous. The union is restated here rather than imported so
 * a test cannot quietly drift onto a fifth member.
 */
export type PrivilegedAttemptKind =
  | 'selectorClick'
  | 'evaluateJs'
  | 'getDomTree'
  | 'readInternalMetadata';

/**
 * A deterministic Reasoner double.
 *
 * The scripted Reasoner in `src/reasoner/providers/scripted.ts` reports
 * one `info` / `timing` observer note about its own clean finish, which
 * #63's default classifier correctly refuses to report as a product
 * problem. A test that needs a *product* finding therefore supplies one
 * explicitly here, so what is under test is the runtime's projection
 * rather than the scripted provider's housekeeping output.
 */
export function reasonerFactory(options: {
  readonly script?: ReadonlyArray<ParticipantAction>;
  readonly observerFindings?: ReadonlyArray<ObserverFindingSpec>;
  readonly observerSummary?: string;
  /**
   * Emit one privileged action attempt before following the script.
   *
   * The response is deliberately *not* a `ParticipantAction`: that is
   * the point. It is the shape a reasoner produces when it reaches for
   * a primitive no capability profile grants, and the structured boundary
   * is what has to refuse it.
   */
  readonly attemptPrivilegedKind?: PrivilegedAttemptKind;
  readonly selfReport?: Partial<{
    readonly goal: string;
    readonly productUnderstanding: string;
    readonly confusionPoints: ReadonlyArray<string>;
    readonly resultAlignedWithExpectation: boolean;
    readonly confidence: number;
    readonly wouldReturn: boolean;
    readonly freeText: string;
  }>;
}): (
  config: { readonly provider: 'scripted' | 'anthropic'; readonly modelId?: string; readonly seed?: string },
  ctx: { readonly role: 'participant' | 'observer'; readonly participantLabel: string; readonly script?: ReadonlyArray<ParticipantAction> },
) => Reasoner {
  return (config, ctx) => {
    let cursor = 0;
    const script = ctx.script ?? options.script ?? [
      { kind: 'clickByCoords', x: 10, y: 10 },
      { kind: 'wait', milliseconds: 10 },
      { kind: 'finish', reason: 'done' },
    ];

    return {
      providerId: 'scripted',
      modelId: `scripted:${config.seed ?? 'fixture'}`,
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
              ...options.selfReport,
            },
            usage: { inputTokens: 32, outputTokens: 32 },
          };
        }
        if (kind === 'observerFindings') {
          return {
            kind: 'observerFindings',
            content: {
              summary: options.observerSummary ?? 'The run reached the product and produced a trace.',
              findings: (options.observerFindings ?? []).map((f) => ({
                id: f.id,
                stepIndex: f.stepIndex === undefined ? null : f.stepIndex,
                severity: f.severity ?? 'major',
                category: f.category ?? 'confusion',
                summary: f.summary,
                evidenceRefs: [{ kind: 'observation' as const, ref: f.id }],
              })),
              terminationVerdict: {
                declared: 'finish',
                plausible: true,
                note: 'Fixture observer.',
              },
            },
            usage: { inputTokens: 64, outputTokens: 64 },
          };
        }
        if (options.attemptPrivilegedKind !== undefined && cursor === 0) {
          cursor += 1;
          return {
            kind: 'action',
            action: { kind: options.attemptPrivilegedKind, payload: { selector: '#app' } },
            rationale: 'privileged probe',
            usage: { inputTokens: 16, outputTokens: 16 },
          } as unknown as ReasonerResponse;
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
    };
  };
}

/* -------------------------------------------------------------------------- */
/* Stores and directories                                                        */
/* -------------------------------------------------------------------------- */

export async function makeTempDir(prefix = 'u-sekai-runtime-'): Promise<{
  readonly dir: string;
  readonly cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A `CohortStateService` over a **file** store in `dir`.
 *
 * Tests call this a second time with the same `dir` to simulate a fresh
 * process: a new `FileRecordStore` and a new service that share nothing
 * but the bytes on disk. That is the real definition of "survives a
 * process restart", and an in-memory store cannot express it.
 */
export function makeService(
  dir: string,
  options: { readonly now?: () => string } = {},
): CohortStateService {
  return new CohortStateService({
    store: new FileRecordStore({ rootDir: dir }),
    now: options.now ?? fixedClock(),
  });
}

/** Declare identities into a fresh service so the store is populated. */
export async function seedIdentities(
  service: CohortStateService,
  identities: ReadonlyArray<SyntheticIdentity>,
): Promise<void> {
  for (const identity of identities) {
    await service.declareIdentity(identity);
  }
  await service.declareCohort(makeExplicitCohort(identities.map((i) => i.id)));
}

/** Read every JSON file in a run's artifact directory, by name. */
export async function readArtifactJson(
  artifactDir: string,
  name: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(artifactDir, name), 'utf8')) as Record<
    string,
    unknown
  >;
}
