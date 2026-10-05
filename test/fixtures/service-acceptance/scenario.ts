/**
 * The 0.4.0 acceptance scenario, as one function (Issue #67).
 *
 * `docs/non-reality.md` is the boundary this file sits inside of: the
 * Synthetic Users below are exploratory instruments, and nothing this
 * scenario observes is a statement about human users.
 *
 *
 * ## Why the scenario lives here and not in the test file
 *
 * The issue's first acceptance criterion is "a fresh clone can run the
 * documented example". An example that is a *separate* implementation
 * from the tested one would make that criterion unfalsifiable: the test
 * could be green while the documented command did something else. So the
 * orchestration lives in this module, the browser-backed test drives it,
 * and `examples/continuous-product-evaluation/run-acceptance.ts` is a
 * thin CLI over the same `executeAcceptanceScenario`. One implementation,
 * two entry points, and the criterion can be checked by running the
 * command.
 *
 * ## The flow, and the order it has to happen in
 *
 * ```text
 * version A live  ─┬─ mixed cohort (ephemeral + persistent), browser
 *                  └─ returning cohort, browser          -> baseline run
 *                       |
 *              A -> B transition (durable, idempotent)
 *                       |
 * version B live  ─────── returning cohort, browser      -> comparison run
 * ```
 *
 * The transition is between the two returning-cohort runs and not before
 * them, because the whole claim is that *this* cohort experienced the
 * earlier version first. Promoting before the baseline run would compare
 * a cohort against a version it never saw.
 *
 * ## What the scenario deliberately does not claim
 *
 * The two instances serve the same demo application, so what differs
 * between version A and version B is **world state**, not rendered
 * behaviour: the task version A's cohort created is not in version B,
 * and version B is a genuinely separate deployment. `RunLineage` carries
 * no version identity (Issue #83), so no record on a finding can prove a
 * *version* boundary was crossed; the version boundary is observable in
 * the durable cohort state and in the transition journal, and the
 * environment boundary is observable on the lineage. The scenario
 * asserts each of those separately and says which is which.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { ParticipantAction } from '../../../src/domain/capability.js';
import type { SyntheticIdentityId } from '../../../src/product/index.js';
import type { Finding } from '../../../src/review/index.js';
import type { IdentityState } from '../../../src/cohort/index.js';
import type { EnvironmentPair } from '../../../examples/continuous-product-evaluation/environment/index.js';

import { locateDemoControls, type Point } from '../../browser/support/demo.js';

import {
  CONTROL_COHORT_ID,
  CONTROL_ID,
  CONTROL_PROGRAM_ID,
  ENV_A,
  ENV_B,
  ENVIRONMENT_NAME,
  EPHEMERAL_ID,
  MIXED_COHORT_ID,
  MIXED_PROGRAM_ID,
  PERSISTENT_ID,
  RETURNING_COHORT_ID,
  RETURNING_ID,
  RETURNING_PROGRAM_ID,
  VERSION_A,
  VERSION_B,
  buildScenarioPlan,
  scenarioClock,
} from './durable.js';
import {
  accountCreateStep,
  openStore,
  promoteToVersionB,
  runAcceptanceRun,
  startAcceptanceScenario,
  teardownAcceptanceScenario,
  transitionBefore,
  type AcceptanceRunOutput,
  type AcceptanceScenario,
} from './harness.js';
import {
  LONGITUDINAL_TITLE,
  TASK_CREATED_IN_A,
  TASK_CREATED_IN_B,
  type RetainedMemory,
} from './reasoner.js';

export { LONGITUDINAL_TITLE, TASK_CREATED_IN_A, TASK_CREATED_IN_B };
export {
  CONTROL_COHORT_ID,
  CONTROL_ID,
  CONTROL_PROGRAM_ID,
  ENV_A,
  ENV_B,
  EPHEMERAL_ID,
  ENVIRONMENT_NAME,
  MIXED_COHORT_ID,
  MIXED_PROGRAM_ID,
  PERSISTENT_ID,
  RETURNING_COHORT_ID,
  RETURNING_ID,
  RETURNING_PROGRAM_ID,
  VERSION_A,
  VERSION_B,
};

/** The task each cohort creates, so the two worlds differ observably. */
export const MIXED_PERSISTENT_TASK = 'Draft the release checklist';
export const MIXED_EPHEMERAL_TASK = 'Find the help page';
export const CONTROL_TASK = 'Book a desk for Tuesday';

/** One observation of a live instance's rendered index page. */
export interface RenderedWorld {
  readonly baseUrl: string;
  readonly html: string;
  readonly titles: ReadonlyArray<string>;
}

export interface AcceptanceReport {
  readonly scenario: AcceptanceScenario;
  readonly isolation: {
    readonly beforeKey: string;
    readonly afterKey: string;
    readonly keysDiffer: boolean;
    readonly declaredNames: readonly [string, string];
    readonly declaredVersions: readonly [string, string];
  };
  readonly mixed: {
    readonly run: AcceptanceRunOutput['result'];
    readonly worldBefore: RenderedWorld;
    readonly worldAfter: RenderedWorld;
    readonly persistentState: IdentityState;
    readonly ephemeralState: IdentityState;
  };
  readonly baseline: {
    readonly run: AcceptanceRunOutput['result'];
    readonly connectorDispatchCount: number;
    readonly world: RenderedWorld;
    readonly stateAfterA: IdentityState;
  };
  readonly promotion: {
    readonly before: Awaited<ReturnType<typeof transitionBefore>>;
    readonly applied: boolean;
    readonly reread: Awaited<ReturnType<typeof transitionBefore>>;
    readonly reapplyApplied: boolean;
    readonly activeVersionAfter: string;
    readonly baselineVersionStillAnswering: boolean;
    readonly worldAUnchangedByPromotion: RenderedWorld;
  };
  readonly comparison: {
    readonly run: AcceptanceRunOutput['result'];
    readonly worldB: RenderedWorld;
    readonly worldAAfter: RenderedWorld;
    readonly stateAfterB: IdentityState;
    readonly findings: ReadonlyArray<Finding>;
    readonly memory: RetainedMemory;
  };
  readonly teardown: () => Promise<void>;
}

/** Read a live instance's rendered index page and the titles it lists. */
export async function readWorld(baseUrl: string): Promise<RenderedWorld> {
  const response = await fetch(`${baseUrl}/`);
  if (!response.ok) {
    throw new Error(`world at ${baseUrl} answered ${response.status}; it must be live to be compared`);
  }
  const html = await response.text();
  const titles: string[] = [];
  for (const match of html.matchAll(/<li><span>([^<]*)<\/span>/g)) {
    const title = match[1];
    if (title !== undefined) titles.push(title);
  }
  return { baseUrl, html, titles };
}

function addTaskScript(controls: { readonly titleInput: Point; readonly addButton: Point }, title: string): ReadonlyArray<ParticipantAction> {
  return [
    { kind: 'clickByCoords', ...controls.titleInput },
    { kind: 'typeText', text: title },
    { kind: 'clickByCoords', ...controls.addButton },
    { kind: 'wait', milliseconds: 200 },
    { kind: 'finish', reason: `added ${title}` },
  ];
}

/**
 * What a cohort's durable record says about a version it has already
 * experienced.
 *
 * Read through a **second** `CohortStateService` over the same
 * directory, so this is a property of the bytes on disk rather than of
 * the object graph the baseline run happened to be holding. The titles
 * come from the world's own rendered page, not from a constant, so a run
 * that silently failed to mutate the world would produce an empty
 * history and the comparison run would report nothing.
 */
export async function readRetainedMemory(
  scenario: AcceptanceScenario,
  identityId: SyntheticIdentityId,
  world: RenderedWorld,
): Promise<RetainedMemory> {
  const reopened = openStore(scenario.root.dir, 'store');
  const state = await reopened.loadIdentity(identityId);
  const last = state.observations.at(-1);
  if (last === undefined) return { priorTitles: [] };
  return {
    priorTitles: [...world.titles],
    lastVersion: last.version,
    lastEnvironmentId: last.environmentId,
  };
}

/**
 * Execute the whole scenario and return everything the acceptance
 * criteria are checked against.
 */
export async function executeAcceptanceScenario(): Promise<AcceptanceReport> {
  const scenario = await startAcceptanceScenario();
  try {
    return await driveAcceptanceScenario(scenario);
  } catch (error) {
    // A scenario that throws part-way has already started two live
    // environments and a temp directory. Leaving them running would make
    // the next run fail for a reason that has nothing to do with it, and
    // a leaked process is exactly the kind of thing a "it failed, we
    // re-ran it" workflow never notices.
    await teardownAcceptanceScenario(scenario);
    throw error;
  }
}

async function driveAcceptanceScenario(
  scenario: AcceptanceScenario,
): Promise<AcceptanceReport> {
  const { pair, model, root } = scenario;

  const controlsA = await locateDemoControls(pair.before.baseUrl);
  const controlsB = await locateDemoControls(pair.after.baseUrl);

  // --- Stage 0: what the pair actually is, read off the live values.
  const isolation = {
    beforeKey: pair.before.key,
    afterKey: pair.after.key,
    keysDiffer: pair.before.key !== pair.after.key,
    declaredNames: [pair.before.declaration.name, pair.after.declaration.name] as const,
    declaredVersions: [pair.before.version, pair.after.version] as const,
  };

  // --- Stage 1: one cohort holding an ephemeral and a persistent
  // identity at the same time, both driven through a real browser at
  // version A.
  const mixedPlan = buildScenarioPlan({
    programId: MIXED_PROGRAM_ID,
    cohortId: MIXED_COHORT_ID,
    environmentId: ENV_A,
    version: VERSION_A,
    observedAt: '2026-10-01T09:00:00.000Z',
    mode: 'continuous',
    delivery: 'mixed-version-a',
    planningCeiling: 4,
  });
  const mixed = await runAcceptanceRun({
    root,
    model,
    pair,
    plan: mixedPlan,
    runId: 'run-mixed-version-a',
    steps: [
      accountCreateStep(EPHEMERAL_ID, pair.before.baseUrl, 'acct-ephemeral-nova'),
      accountCreateStep(PERSISTENT_ID, pair.before.baseUrl, 'acct-persistent-iris'),
    ],
    scriptFor: (identity) =>
      addTaskScript(
        controlsA,
        identity.id === PERSISTENT_ID ? MIXED_PERSISTENT_TASK : MIXED_EPHEMERAL_TASK,
      ),
    returningIdentityId: RETURNING_ID,
    now: scenarioClock('2026-10-01T09:00:00.000Z'),
  });
  const worldAfterMixed = await readWorld(pair.before.baseUrl);

  const afterMixed = openStore(root.dir, 'store');
  const persistentState = await afterMixed.loadIdentity(PERSISTENT_ID);
  const ephemeralState = await afterMixed.loadIdentity(EPHEMERAL_ID);

  // --- Stage 2: the returning cohort's first version. This run is the
  // baseline the comparison run will be joined against.
  const worldBeforeBaseline = await readWorld(pair.before.baseUrl);
  const planA = buildScenarioPlan({
    programId: RETURNING_PROGRAM_ID,
    cohortId: RETURNING_COHORT_ID,
    environmentId: ENV_A,
    version: VERSION_A,
    observedAt: '2026-10-02T09:00:00.000Z',
    mode: 'pointInTime',
    delivery: 'returning-version-a',
    planningCeiling: 1,
  });
  const baseline = await runAcceptanceRun({
    root,
    model,
    pair,
    plan: planA,
    runId: 'run-returning-version-a',
    steps: [accountCreateStep(RETURNING_ID, pair.before.baseUrl, 'acct-returning-leo')],
    scriptFor: () => addTaskScript(controlsA, TASK_CREATED_IN_A),
    returningIdentityId: RETURNING_ID,
    now: scenarioClock('2026-10-02T09:00:00.000Z'),
  });
  const worldAfterBaseline = await readWorld(pair.before.baseUrl);
  const afterBaseline = openStore(root.dir, 'store');
  const stateAfterA = await afterBaseline.loadIdentity(RETURNING_ID);

  // --- Stage 3: the explicit A -> B promotion, recorded durably and
  // with a recovery point. Read the state *before* it happens, so
  // "never started" is an observed value rather than an assumption.
  const promotionBefore = await transitionBefore(scenario.transitionStore, RETURNING_COHORT_ID, pair);
  const worldABeforePromotion = await readWorld(pair.before.baseUrl);

  const promotion = await promoteToVersionB(scenario.transitionStore, RETURNING_COHORT_ID, pair);
  const reapply = await promoteToVersionB(scenario.transitionStore, RETURNING_COHORT_ID, pair);

  const activeVersionAfter = pair.active().version;
  const worldAStillAnswering = await readWorld(pair.before.baseUrl);
  const worldAAfterPromotion = await readWorld(pair.before.baseUrl);
  void worldABeforePromotion;

  // --- Stage 4: the same cohort, the same identity id, the newer
  // version, joined against the run above.
  const memory = await readRetainedMemory(scenario, RETURNING_ID, worldAfterBaseline);
  const planB = buildScenarioPlan({
    programId: RETURNING_PROGRAM_ID,
    cohortId: RETURNING_COHORT_ID,
    environmentId: ENV_B,
    version: VERSION_B,
    observedAt: '2026-10-09T09:00:00.000Z',
    mode: 'releaseTransition',
    delivery: 'returning-version-b',
    planningCeiling: 1,
    previousObservation: {
      environmentId: ENV_A,
      version: VERSION_A,
      observedAt: '2026-10-02T09:00:00.000Z',
    },
  });
  const comparison = await runAcceptanceRun({
    root,
    model,
    pair,
    plan: planB,
    runId: 'run-returning-version-b',
    steps: [accountCreateStep(RETURNING_ID, pair.after.baseUrl, 'acct-returning-leo')],
    scriptFor: () => addTaskScript(controlsB, TASK_CREATED_IN_B),
    memory: new Map([[RETURNING_ID, memory]]),
    returningIdentityId: RETURNING_ID,
    now: scenarioClock('2026-10-09T09:00:00.000Z'),
    baseline: { lineage: baseline.result.lineage, findings: baseline.result.findings },
  });

  const worldB = await readWorld(pair.after.baseUrl);
  const worldAAfter = await readWorld(pair.before.baseUrl);
  const afterComparison = openStore(root.dir, 'store');
  const stateAfterB = await afterComparison.loadIdentity(RETURNING_ID);

  return {
    scenario,
    isolation,
    mixed: {
      run: mixed.result,
      worldBefore: worldBeforeBaseline,
      worldAfter: worldAfterMixed,
      persistentState,
      ephemeralState,
    },
    baseline: {
      run: baseline.result,
      connectorDispatchCount: baseline.connector.provisionCalls,
      world: worldAfterBaseline,
      stateAfterA,
    },
    promotion: {
      before: promotionBefore,
      applied: promotion.outcome.applied,
      reread: promotion.reread,
      reapplyApplied: reapply.outcome.applied,
      activeVersionAfter,
      baselineVersionStillAnswering: worldAStillAnswering.baseUrl === pair.before.baseUrl,
      worldAUnchangedByPromotion: worldAAfterPromotion,
    },
    comparison: {
      run: comparison.result,
      worldB,
      worldAAfter,
      stateAfterB,
      findings: comparison.result.findings,
      memory,
    },
    teardown: onceTeardown(pair, root),
  };
}

/**
 * A teardown that is safe to call twice.
 *
 * #69's `close` rejects with `ERR_SERVER_NOT_RUNNING` on a second call,
 * and a teardown called from both a `beforeAll` return value and an
 * `afterAll` hook would turn that into a suite-level failure that has
 * nothing to do with what the scenario observed. Every caller gets to
 * clean up after itself without having to know who else will.
 */
function onceTeardown(
  pair: EnvironmentPair,
  root: { cleanup: () => Promise<void> },
): () => Promise<void> {
  let done: Promise<void> | undefined;
  return () => {
    done ??= (async () => {
      await pair.before.close();
      await pair.after.close();
      await root.cleanup();
    })();
    return done;
  };
}

/**
 * The control case, in the same harness and against the same live
 * version B: a cohort with **no** retained history behind it.
 *
 * It exists so the longitudinal finding cannot be a property of the
 * fixture. Everything is identical to the comparison run except the one
 * input that matters — the durable record the participant's Reasoner is
 * given — and the expected outcome is inverted: no finding.
 *
 * Takes an existing scenario so the control can share the pair with the
 * other control cases rather than paying for a second pair of live
 * environments.
 */
export async function executeControlRun(scenario: AcceptanceScenario): Promise<{
  readonly run: AcceptanceRunOutput['result'];
  readonly worldB: RenderedWorld;
  readonly memory: RetainedMemory;
  readonly stateAfter: IdentityState;
}> {
  const { pair, model, root } = scenario;
  const controlsB = await locateDemoControls(pair.after.baseUrl);

  const controlPlan = buildScenarioPlan({
    programId: CONTROL_PROGRAM_ID,
    cohortId: CONTROL_COHORT_ID,
    environmentId: ENV_B,
    version: VERSION_B,
    observedAt: '2026-10-09T10:00:00.000Z',
    mode: 'continuous',
    delivery: 'control-version-b',
    planningCeiling: 1,
  });

  // Read the control identity's durable record the same way the
  // comparison run reads the returning cohort's, so the two differ only
  // in what the store actually holds.
  const before = openStore(root.dir, 'store');
  const stateBefore = await before.loadIdentity(CONTROL_ID);
  // A control identity that already had history would make this a second
  // returning-user run rather than a control, and the run would be
  // reported as one. Refusing is the honest response.
  if (stateBefore.observations.length > 0) {
    throw new Error(
      'the control identity already has observations in the durable store, so the control run ' +
        'would not be a control; start from a fresh scenario',
    );
  }
  const memory: RetainedMemory = { priorTitles: [] };

  const run = await runAcceptanceRun({
    root,
    model,
    pair,
    plan: controlPlan,
    runId: 'run-control-version-b',
    steps: [accountCreateStep(CONTROL_ID, pair.after.baseUrl, 'acct-control-fresh')],
    scriptFor: () => addTaskScript(controlsB, CONTROL_TASK),
    memory: new Map([[CONTROL_ID, memory]]),
    returningIdentityId: RETURNING_ID,
    now: scenarioClock('2026-10-09T10:00:00.000Z'),
  });

  const worldB = await readWorld(pair.after.baseUrl);
  const after = openStore(root.dir, 'store');
  const stateAfter = await after.loadIdentity(CONTROL_ID);

  return { run: run.result, worldB, memory, stateAfter };
}

/**
 * The capability-boundary control: the participant's Reasoner reaches for
 * a primitive no capability profile grants, on its very first step.
 *
 * The load-bearing observable is the connector's dispatch count, which is
 * a count of *calls anything could have made*. If the privileged attempt
 * had reached the privileged boundary in any way, the number would move.
 * It does not.
 */
export async function executePrivilegedAttempt(scenario: AcceptanceScenario): Promise<{
  readonly run: AcceptanceRunOutput['result'];
  readonly connector: AcceptanceRunOutput['connector'];
  readonly dispatchCountAfterSetup: number;
  readonly events: string;
}> {
  const { pair, model, root } = scenario;

  const privilegedPlan = buildScenarioPlan({
    programId: CONTROL_PROGRAM_ID,
    cohortId: CONTROL_COHORT_ID,
    environmentId: ENV_B,
    version: VERSION_B,
    observedAt: '2026-10-09T11:00:00.000Z',
    mode: 'continuous',
    delivery: 'privileged-version-b',
    planningCeiling: 1,
  });

  const run = await runAcceptanceRun({
    root,
    model,
    pair,
    plan: privilegedPlan,
    runId: 'run-privileged-version-b',
    steps: [accountCreateStep(CONTROL_ID, pair.after.baseUrl, 'acct-privileged')],
    scriptFor: () => [
      { kind: 'wait', milliseconds: 10 },
      { kind: 'finish', reason: 'unreachable: the run should have terminated on the violation' },
    ],
    memory: new Map([[CONTROL_ID, { priorTitles: [] }]]),
    returningIdentityId: RETURNING_ID,
    privilegedAttemptKind: 'evaluateJs',
    now: scenarioClock('2026-10-09T11:00:00.000Z'),
  });

  return {
    run: run.result,
    connector: run.connector,
    // Read after the run: setup dispatched exactly the one declared step,
    // and the participant's attempt added nothing to it.
    dispatchCountAfterSetup: run.connector.provisionCalls,
    events: await fs.readFile(path.join(run.result.artifactDir, 'events.ndjson'), 'utf8'),
  };
}

/** Every artifact file a run's evidence locators name, resolved. */
export async function resolveEvidenceFiles(
  artifactDir: string,
  locators: ReadonlyArray<string>,
): Promise<ReadonlyArray<{ readonly locator: string; readonly exists: boolean }>> {
  const out: { locator: string; exists: boolean }[] = [];
  for (const locator of locators) {
    const file = locator.split('#')[0] ?? locator;
    if (file.length === 0) continue;
    try {
      await fs.stat(path.join(artifactDir, file));
      out.push({ locator, exists: true });
    } catch {
      out.push({ locator, exists: false });
    }
  }
  return out;
}
