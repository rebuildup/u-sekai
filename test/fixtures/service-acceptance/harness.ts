/**
 * The acceptance harness for Issue #67.
 *
 * ## Reuse, not a parallel runtime
 *
 * The browser harness already exists: `test/browser/support/demo.ts`
 * provides `startDemoServer()`, `locateDemoControls()` and
 * `withIndependentPage()`. This module reuses `locateDemoControls` for
 * coordinates and adds no second Playwright wiring. The one thing it
 * does not reuse is `startDemoServer`, because this scenario needs
 * **two simultaneously live deployments of the same environment** —
 * which is #69's `startEnvironmentPair`, the capability Issue #67 was
 * waiting for.
 *
 * ## Every run gets a fresh, process-shaped view of the durable store
 *
 * `openStore` constructs a new `FileRecordStore` and a new
 * `CohortStateService` over the same directory, and every run opens its
 * own. Reading a cohort's history through a *second* service is the only
 * honest way to claim "the cohort persisted", because an in-process
 * object graph cannot distinguish a value that was written to disk from
 * one that was merely still in memory.
 *
 * ## Nothing here is cast to make a signature fit
 *
 * An `OperatorStep` is built by #59's `parseOperatorStep`, a
 * `SyntheticIdentity` by #57's `parseSyntheticIdentity`, and an
 * `EvaluationPlan` by #62's `buildEvaluationPlan`. A fixture that had to
 * be cast into shape would be able to describe a value the real contract
 * would refuse, and the scenario would then pass on something no
 * deployment could produce.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PlaywrightAdapter } from '../../../src/adapter/browser/playwright-adapter.js';
import { CohortStateService, FileRecordStore } from '../../../src/cohort/index.js';
import { parseOperatorStep, ScriptedProvisioningProvider } from '../../../src/operator/index.js';
import type { OperatorStep } from '../../../src/operator/index.js';
import {
  defaultParticipantProfile,
  runEvaluation,
  type EvaluationRunResult,
  type RuntimeConfiguration,
} from '../../../src/runtime/index.js';
import type {
  ProductModel,
  RunLineage,
  SyntheticCohort,
  SyntheticIdentity,
  SyntheticIdentityId,
} from '../../../src/product/index.js';
import type { Finding } from '../../../src/review/index.js';
import type { ParticipantAction } from '../../../src/domain/capability.js';
import type { EvaluationPlan } from '../../../src/program/index.js';

import {
  EnvironmentIsolationError,
  TransitionStore,
  applyTransition,
  readTransition,
  startEnvironmentPair,
  type EnvironmentPair,
  type TransitionState,
} from '../../../examples/continuous-product-evaluation/environment/index.js';

import {
  buildScenarioModel,
  ENVIRONMENT_NAME,
  makeIdentity,
  PRODUCT_ID,
  scenarioClock,
  scenarioIdentities,
  VERSION_A,
  VERSION_B,
  type IdentitySpec,
} from './durable.js';
import { createAcceptanceReasoner, type RetainedMemory } from './reasoner.js';

/** The declared world-provisioning resource this scenario authorises. */
export const ACCOUNT_STEP_RESOURCE_KEY = 'acct-returning';

export interface AcceptanceRoot {
  readonly dir: string;
  readonly cleanup: () => Promise<void>;
}

export async function createRoot(prefix = 'u-sekai-acceptance-67-'): Promise<AcceptanceRoot> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A fresh view of the durable store over the same bytes on disk.
 *
 * `now` defaults to its own monotonic clock, which is right for a read.
 * A *run* must pass the same clock it hands the runtime — see
 * {@link runAcceptanceRun} for why.
 */
export function openStore(dir: string, name: string, now?: () => string): CohortStateService {
  return new CohortStateService({
    store: new FileRecordStore({ rootDir: path.join(dir, name) }),
    now: now ?? scenarioClock('2026-10-02T00:00:00.000Z'),
  });
}

/**
 * Version A and version B of one declared environment, both live.
 *
 * `product` is passed as the real branded `ProductId` from #57, not as a
 * string literal. That is not a cast and not a widening of #69's
 * declaration type: `ProductId` is `string & { __brand }`, so it is
 * assignable to #69's `product: string` field with no assertion at all.
 *
 * What #69 cannot do is *return* the brand. `parseInstanceDeclaration`
 * declares `product: string`, so the value that comes back out of an
 * `EnvironmentInstance` is unbranded and the round-trip can only be
 * checked at runtime. The scenario therefore asserts the value, rather
 * than pretending the types carry it. Narrowing
 * `InstanceDeclaration.product` to `ProductId` and `name` to
 * `EnvironmentId` is an integration change to #69, not this ticket's.
 */
export function startPair(): Promise<EnvironmentPair> {
  return startEnvironmentPair(
    {
      product: PRODUCT_ID,
      name: ENVIRONMENT_NAME,
      version: VERSION_A,
      seed: 'acceptance-67',
    },
    {
      product: PRODUCT_ID,
      name: ENVIRONMENT_NAME,
      version: VERSION_B,
      seed: 'acceptance-67',
    },
  );
}

/**
 * The World Operator authority policy, written against the two live
 * origins.
 *
 * `authorizeStep` rule 7 requires a step's origin to be contained in
 * the environment grant, so a policy carrying placeholder origins would
 * deny the very steps the scenario declares. Writing the real origins in
 * is what makes the provisioning path real rather than skipped.
 */
export function authorityPolicy(pair: EnvironmentPair): Record<string, unknown> {
  return {
    policyId: 'pol-acceptance',
    environments: [
      {
        environmentId: 'env-staging-version-a',
        environmentClass: 'staging',
        baseUrl: pair.before.baseUrl,
        destructiveAllowed: true,
        productionDestructive: false,
      },
      {
        environmentId: 'env-staging-version-b',
        environmentClass: 'staging',
        baseUrl: pair.after.baseUrl,
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
    notes: 'Acceptance-scenario authority for issue #67. Real money stays denied.',
  };
}

/**
 * An `account.create` step through #59's own parser.
 *
 * `resourceKey` is declared per identity: #59 addresses resources by
 * declared key and a plan may not reuse one, so a cohort of two needs
 * two keys rather than one shared handle.
 */
export function accountCreateStep(
  identityId: SyntheticIdentityId,
  origin: string,
  resourceKey: string = ACCOUNT_STEP_RESOURCE_KEY,
): OperatorStep {
  return parseOperatorStep({
    kind: 'account.create',
    resourceKey,
    origin,
    identityId,
    displayName: 'Acceptance scenario Synthetic User',
  });
}

export interface AcceptanceRunInput {
  readonly root: AcceptanceRoot;
  readonly model: ProductModel;
  readonly pair: EnvironmentPair;
  readonly plan: EvaluationPlan;
  readonly runId: string;
  readonly steps?: ReadonlyArray<OperatorStep>;
  readonly scriptFor?: (identity: SyntheticIdentity) => ReadonlyArray<ParticipantAction> | undefined;
  readonly memory?: ReadonlyMap<string, RetainedMemory>;
  readonly returningIdentityId: SyntheticIdentityId;
  readonly privilegedAttemptKind?:
    | 'selectorClick'
    | 'evaluateJs'
    | 'getDomTree'
    | 'readInternalMetadata';
  readonly now?: () => string;
  readonly maxStepsPerIdentity?: number;
  /** Run with no World Operator at all: a control for the setup path. */
  readonly withoutOperator?: boolean;
  /** Compare this run against an earlier run's lineage and findings. */
  readonly baseline?: { readonly lineage: RunLineage; readonly findings: ReadonlyArray<Finding> };
}

export interface AcceptanceRunOutput {
  readonly result: EvaluationRunResult;
  readonly connector: ScriptedProvisioningProvider;
}

/**
 * Execute one planned evaluation through a real Chromium against one of
 * the pair's live instances.
 */
export async function runAcceptanceRun(input: AcceptanceRunInput): Promise<AcceptanceRunOutput> {
  const connector = new ScriptedProvisioningProvider({ connectorId: 'acceptance-connector' });
  const clock = input.now ?? scenarioClock('2026-10-05T00:00:00.000Z');
  // One clock for the runtime *and* the durable store.
  //
  // The two are separate seams by design (`RuntimeClock` and the service's
  // own `now`), but a release window's two ends have to be ordered:
  // `openTransition` is handed the runtime's `startedAt`, while
  // `closeTransition` falls back to the *store's* clock because the
  // runtime does not pass an instant
  // (`src/runtime/persistence.ts:289`). Two independently started clocks
  // therefore stamp the two ends of one window, and
  // `parseReleaseWindow` refuses when they invert. Sharing one monotonic
  // source here is both the workaround and the honest fixture: a
  // scenario in which the durable record and the run lineage disagree
  // about when things happened would be a scenario asserting nothing.
  const service = openStore(input.root.dir, 'store', clock);

  const config: RuntimeConfiguration = {
    model: input.model,
    cohort: service,
    experiment: {
      userStory: 'Add a task to the list and confirm it is there.',
      outDir: path.join(input.root.dir, 'artifacts'),
      seed: 'acceptance-67',
      maxStepsPerIdentity: input.maxStepsPerIdentity ?? 8,
      participantReasoner: { provider: 'scripted', seed: 'acceptance-67' },
      observerReasoner: { provider: 'scripted', seed: 'acceptance-67' },
    },
    ...(input.withoutOperator === true
      ? {}
      : {
          setup: {
            policy: authorityPolicy(input.pair),
            connector,
            clock: { now: clock },
            steps: input.steps ?? [],
            reason: 'issue 67 acceptance scenario',
          },
        }),
    // A real Chromium per identity. The adapter is never shared: it
    // holds a page, and two participants sharing one page would make the
    // A-versus-B world-state assertion meaningless.
    adapterFactory: () => new PlaywrightAdapter(),
    reasonerFactory: createAcceptanceReasoner({
      memory: input.memory ?? new Map(),
      returningIdentityId: input.returningIdentityId,
      ...(input.privilegedAttemptKind === undefined
        ? {}
        : { privilegedAttemptKind: input.privilegedAttemptKind }),
    }),
    now: clock,
    participantProfile: defaultParticipantProfile,
    ...(input.scriptFor === undefined ? {} : { scriptFor: input.scriptFor }),
  };

  const result = await runEvaluation(config, {
    plan: input.plan,
    runId: input.runId,
    ...(input.baseline === undefined
      ? {}
      : { baseline: input.baseline.lineage, baselineFindings: input.baseline.findings }),
  });
  return { result, connector };
}

export interface AcceptanceScenario {
  readonly root: AcceptanceRoot;
  readonly pair: EnvironmentPair;
  readonly transitionStore: TransitionStore;
  readonly model: ProductModel;
  readonly specs: ReadonlyArray<IdentitySpec>;
  readonly declared: ReadonlyArray<SyntheticIdentity>;
  readonly cohorts: ReadonlyArray<SyntheticCohort>;
}

/**
 * Start the two live versions, build the durable model against their
 * real origins, and declare every identity and cohort into the store.
 */
export async function startAcceptanceScenario(): Promise<AcceptanceScenario> {
  const root = await createRoot();
  const pair = await startPair();
  const transitionStore = new TransitionStore(path.join(root.dir, 'transitions'));

  const specs = Object.values(scenarioIdentities(pair.before.baseUrl, pair.after.baseUrl));
  const declared = specs.map((spec) => makeIdentity(spec));
  const model = buildScenarioModel({
    baseUrlA: pair.before.baseUrl,
    baseUrlB: pair.after.baseUrl,
    identities: declared,
  });

  const service = openStore(root.dir, 'store');
  for (const identity of declared) {
    await service.declareIdentity(identity);
  }
  for (const cohort of model.cohorts) {
    await service.declareCohort(cohort);
  }

  return { root, pair, transitionStore, model, specs, declared, cohorts: model.cohorts };
}

export async function teardownAcceptanceScenario(
  scenario: AcceptanceScenario | undefined,
): Promise<void> {
  if (scenario === undefined) return;
  await scenario.pair.before.close();
  await scenario.pair.after.close();
  await scenario.root.cleanup();
}

export interface PromotionResult {
  readonly outcome: Awaited<ReturnType<typeof applyTransition>>;
  /** Re-read through the store, never the value `applyTransition` returned. */
  readonly reread: TransitionState;
}

/** Apply the A -> B promotion, then re-read it from the durable record. */
export async function promoteToVersionB(
  store: TransitionStore,
  cohortId: string,
  pair: EnvironmentPair,
): Promise<PromotionResult> {
  const outcome = await applyTransition(store, cohortId, pair);
  const reread = await readTransition(store, cohortId, {
    fromKey: pair.before.key,
    toKey: pair.after.key,
  });
  return { outcome, reread };
}

/** The transition state *before* anything is applied. Never `undefined`. */
export function transitionBefore(
  store: TransitionStore,
  cohortId: string,
  pair: EnvironmentPair,
): Promise<TransitionState> {
  return readTransition(store, cohortId, { fromKey: pair.before.key, toKey: pair.after.key });
}

/**
 * An order-stable serialisation, for "this record did not change"
 * assertions. Object keys are sorted so a comparison cannot pass or fail
 * on property insertion order.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
      return Object.fromEntries(
        Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return inner;
  });
}

export { EnvironmentIsolationError, applyTransition, readTransition, TransitionStore };
export type { EvaluationRunResult, Finding, OperatorStep, ParticipantAction, RunLineage };
