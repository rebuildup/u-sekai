/**
 * The evaluation runtime (issue #63).
 *
 * ## The flow, and why it is in this order
 *
 * ```text
 * plan -> cohort -> operator setup -> participants -> observer
 *      -> evidence -> review records -> durable state -> cleanup
 * ```
 *
 * The order is Issue #63's own, and three of its edges are load-bearing
 * rather than cosmetic:
 *
 * - **Setup before participants.** The World Operator is the only thing
 *   that can put a world into the state a participant is about to be
 *   dropped into. A participant that started first would be exploring a
 *   world nobody set up, and every finding from it would be about the
 *   fixture rather than the product.
 * - **Review records before durable state.** The records are derived
 *   from the run; the state is written after. Writing state first and
 *   then failing to materialise a finding would leave a durable record
 *   claiming an observation that no review record references.
 * - **Cleanup last, and always.** #59's gate authorises a destructive
 *   step exactly the way it authorises any other, so cleanup is not a
 *   privileged afterthought and it is not optional. It runs after the
 *   artifact is written whatever happened above, and its verdict is
 *   *returned* rather than thrown: world state this run created and did
 *   not release is a fact the caller must be able to see, and an
 *   exception here would hide the run's actual result behind it.
 *
 * ## What raises and what is returned
 *
 * Only four things raise {@link RuntimeIntegrationError}: a plan the
 * durable model does not declare, a caller-supplied value a #57/#61/#62
 * parser refuses, a baseline that is not a joinable release-transition
 * comparison, and a durable-store rejection. Every *run* failure —
 * refused setup, unreachable environment, dead browser, forbidden
 * action — is returned as a #61 `SetupFailure` through
 * {@link EvaluationRunResult.outcomes}. See `errors.ts` for why that
 * split is the whole point.
 *
 * ## The participant cannot reach the operator
 *
 * {@link ParticipantExecutionContext} is the complete set of things a
 * participant run is given: a browser adapter, a reasoner, a capability
 * profile, a target URL, a step budget and a recorder. There is no field
 * on it for a `WorldOperator`, a `ProvisioningConnector`, a
 * `ResourceHandle` or a durable store, and `setup.ts` holds the
 * connector only long enough to hand it to `createWorldOperator`. The
 * isolation is structural — there is no property to reach through, not
 * a permission that could be granted by accident.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { runParticipant } from '../participant/runtime.js';
import { runObserver } from '../observer/runtime.js';
import { FileArtifactIO, InMemoryRecorder } from '../evidence/index.js';
import { createReasoner } from '../reasoner/interface.js';
import { VERSION } from '../version.js';
import type { BrowserAdapter } from '../adapter/browser/interface.js';
import type { Reasoner } from '../domain/reasoner.js';
import type { ParticipantAction, CapabilityProfile } from '../domain/capability.js';
import type { ObserverReport } from '../domain/observer.js';
import type { ReasonerConfig } from '../domain/experiment.js';
import type { RunEvent, StoredObservation } from '../domain/evidence.js';
import type { RunResult } from '../domain/result.js';
import { EMPTY_SELF_REPORT } from '../domain/self-report.js';
import type { EvaluationPlan } from '../program/index.js';
import {
  isReleaseTransitionComparison,
  parseEvaluationTargetRef,
  type EnvironmentId,
  type EvaluationRunId,
  type EvaluationTargetRef,
  type RunLineage,
  type SyntheticIdentity,
} from '../product/index.js';
import {
  isFinding,
  isSetupFailure,
  type EvaluationMode,
  type EvidenceRef,
  type Finding,
  type ReviewOutcome,
  type SetupFailure,
} from '../review/index.js';
import type {
  OperatorAuditRecord,
  OperatorCleanupResult,
  WorldOperator,
} from '../operator/index.js';

import { RuntimeIntegrationError } from './errors.js';
import type { RuntimeClock, RuntimeConfiguration } from './config.js';
import {
  buildWorldOperator,
  runCleanupPhase,
  runSetupPhase,
  setupFailureFromOperator,
  type SetupPhaseResult,
} from './setup.js';
import { buildRunLineage, resolveRunId } from './lineage.js';
import { EvidenceCatalogue, rollUpBehavioralEvidence, type IdentityRunRecord } from './evidence.js';
import { materializeOutcomes, type MaterializeInput } from './findings.js';
import {
  assertTransitionEligible,
  openReleaseWindows,
  persistRun,
  resolveCohort,
  type PersistRunResult,
  type ResolvedCohort,
} from './persistence.js';

export interface RunEvaluationOptions {
  readonly plan: EvaluationPlan;
  /**
   * Caller-declared run id. Omit to derive one from `plan.planKey`.
   * Declared rather than generated in every case: a re-run that must be
   * distinguishable from the first passes its own id.
   */
  readonly runId?: string;
  /**
   * The version the environment was observed at.
   *
   * Falls back to `plan.observedVersion`, then to
   * `plan.lineage.current`. There is no default beyond that, because
   * "the version is unknown" is a fact worth refusing to record rather
   * than one to invent: an identity observation with a guessed version
   * would poison the next release-transition join.
   */
  readonly observedVersion?: string;
  /**
   * The earlier run this one is compared against.
   *
   * Required when the mode is `releaseTransition`, because #61 refuses a
   * `releaseTransition` finding with no baseline and the runtime will
   * not claim a mode the evidence does not support.
   */
  readonly baseline?: RunLineage;
  /**
   * The baseline run's findings, for the `introduced` / `persisted`
   * classification. Absent means `change: 'unknown'` — "we did not
   * compare", which is different from "we compared and saw no change".
   */
  readonly baselineFindings?: ReadonlyArray<Finding>;
  /** Override the plan's declared mode. Must be consistent with the baseline. */
  readonly mode?: EvaluationMode;
  /** Write nothing to the durable store. A dry run. */
  readonly persist?: boolean;
  /** Skip cleanup. Off by default; see the module docstring. */
  readonly skipCleanup?: boolean;
}

export interface EvaluationRunResult {
  readonly runId: EvaluationRunId;
  readonly target: EvaluationTargetRef;
  /**
   * The run's lineage. Every record carries an equal value; see
   * `runEvaluation` for what "one lineage per run" does and does not
   * mean once #61's parser has re-materialised it.
   */
  readonly lineage: RunLineage;
  /** The mode, as the review layer sees it. */
  readonly mode: EvaluationMode;
  /** Every review record the run produced, findings and setup failures. */
  readonly outcomes: ReadonlyArray<ReviewOutcome>;
  readonly findings: ReadonlyArray<Finding>;
  readonly setupFailures: ReadonlyArray<SetupFailure>;
  /** Every evidence handle the run produced. Mirrors `lineage.evidenceIds`. */
  readonly evidence: ReadonlyArray<EvidenceRef>;
  readonly resolvedCohort: ResolvedCohort;
  readonly setup: SetupPhaseResult;
  /**
   * The operator's complete audit for this run, **after** cleanup.
   *
   * `setup.audit` is a snapshot taken when the plan finished being
   * applied, so it cannot contain the release that happened later. A
   * caller asking "what privileged effects did this run cause" needs
   * both, and asking twice is how a `fixture.reset` goes unaccounted.
   */
  readonly operatorAudit: ReadonlyArray<OperatorAuditRecord>;
  readonly cleanup?: OperatorCleanupResult;
  readonly persistence: PersistRunResult;
  readonly observer: ObserverReport;
  /** True when setup was refused and no participant ran. */
  readonly setupRefused: boolean;
  readonly startedAt: string;
  readonly endedAt: string;
  /** Directory the run's artifact was written to. */
  readonly artifactDir: string;
}

/**
 * Execute one planned evaluation.
 *
 * Resolves for every run outcome. See the module docstring for the
 * raise/return boundary.
 */
export async function runEvaluation(
  config: RuntimeConfiguration,
  options: RunEvaluationOptions,
): Promise<EvaluationRunResult> {
  const { plan } = options;
  const now: RuntimeClock = config.now ?? (() => new Date().toISOString());

  const target = assertPlanInModel(config, plan);
  // Resolved here, before the World Operator is constructed: an
  // environment that declares no endpoint is a model defect, and finding
  // it out *after* provisioning would leave world state applied for a run
  // that was always going to fail.
  const targetUrl = resolveTargetUrl(config, target.environmentId);
  const runId = resolveRunId(plan, options.runId);
  const version = resolveObservedVersion(plan, options.observedVersion);
  const { mode, baseline } = resolveLongitudinal(plan, options);
  const startedAt = now();

  // Checked before anything is dispatched, so a cohort that cannot span
  // a transition is named while nobody has been provisioned, driven or
  // billed for it.
  const resolved = await resolveCohort({
    service: config.cohort,
    cohortId: target.cohortId,
    planningCeiling: plan.cohort.planningCeiling,
    resolvedAt: startedAt,
  });
  assertTransitionEligible(plan, resolved.members, 'cohort.membership');

  const memberIds = resolved.members.map((m) => m.id);

  // The comparative claim is checked here, before anything is dispatched,
  // because that is the only point where a rejection costs nothing.
  // `isReleaseTransitionComparison` reads only `runId`, the program scope
  // and the identity set, and all three are already fixed at this point:
  // the target was validated, the cohort is resolved and the run id is
  // known. Checking after execution would burn a browser session, a
  // World Operator plan and a half-open release window on a mistake the
  // caller can fix in one line.
  if (baseline !== null) {
    assertJoinableBaseline(
      baseline,
      buildRunLineage({
        target,
        runId,
        identityIds: memberIds,
        startedAt,
      }),
    );
  }

  // --- Declared World Operator setup, through #59's gate.
  const operator: WorldOperator | undefined =
    config.setup === undefined
      ? undefined
      : buildWorldOperator({
          policy: config.setup.policy,
          connector: config.setup.connector,
          clock: config.setup.clock,
        });

  const setup: SetupPhaseResult =
    operator === undefined || config.setup === undefined
      ? skippedSetup()
      : await runSetupPhase(operator, {
          plan,
          target,
          runId,
          identityIds: resolved.members.map((m) => m.id),
          steps: config.setup.steps,
          policy: config.setup.policy,
          connector: config.setup.connector,
          clock: config.setup.clock,
          ...(config.setup.reason !== undefined ? { reason: config.setup.reason } : {}),
        });

  const setupFailures: ReadonlyArray<SetupFailure> =
    operator === undefined
      ? Object.freeze([])
      : Object.freeze(
          setup.failures.map((failure, index) =>
            setupFailureFromOperator(failure, { runId, target, identityIds: memberIds, ordinal: index + 1 }),
          ),
        );

  const setupRefused =
    setup.status === 'denied' || setup.status === 'failed' || setup.status === 'rejected';

  const artifactDir = path.join(config.experiment.outDir, runId);
  await fs.mkdir(artifactDir, { recursive: true });

  // A refused plan stops the run. There is no world, so there is nothing
  // for a participant to observe and every finding would be about the
  // fixture. The setup failure is the whole result.
  const execution: IdentityExecution = setupRefused
    ? emptyExecution()
    : await executeIdentities(config, {
        runId,
        targetUrl,
        members: resolved.members,
        startedAt,
        now,
      });

  // A release window brackets the run: opened before the identities
  // execute, closed after their state is persisted.
  if (!setupRefused) {
    await openReleaseWindows({
      service: config.cohort,
      plan,
      members: resolved.members,
      openedAt: startedAt,
    });
  }

  const observer: ObserverReport = setupRefused
    ? unavailableObserver(startedAt, 'world operator setup was refused, so the run observed nothing')
    : await runObserver({
        runId,
        reasoner: makeReasoner(config, 'observer', 'observer'),
        recorder: execution.recorder,
        userStory: config.experiment.userStory,
        participants: resolved.members.map((m) => ({ participantId: m.id, personaPrompt: m.persona })),
      });

  const endedAt = now();
  if (!setupRefused) {
    await execution.recorder.append({
      type: 'run.end',
      runId,
      ts: endedAt,
      durationMs: Date.parse(endedAt) - Date.parse(startedAt),
    });
  }
  const events = await execution.recorder.snapshot();

  const catalog = new EvidenceCatalogue({
    runId,
    startedAt,
    endedAt,
    seed: config.experiment.seed,
    experimentPath: artifactDir,
    events,
    identities: execution.identities,
    observer,
  });

  // Built exactly once, and the *same value* goes into every record. It
  // is worth being precise about what that buys, because the obvious
  // over-claim is available here and is false: #61's `parseFinding`
  // re-parses `longitudinal.observed` through #57's `parseRunLineage`, so
  // the object a consumer holds is a re-materialised equal, not this
  // instance. What the runtime guarantees is that there is only ever one
  // lineage *value* per run — nothing here constructs a second one for a
  // finding — so the two cannot disagree, and the equality is checkable
  // (`finding-lineage.test.ts` asserts it field for field).
  const lineage = buildRunLineage({
    target,
    runId,
    identityIds: memberIds,
    startedAt,
    endedAt,
    evidenceIds: catalog.evidenceIds(),
  });

  // The comparative claim was verified against #57's own predicate
  // before anything ran (see above), on the same `runId`, the same
  // program scope and the same identity set this lineage carries, so
  // there is nothing left to re-decide here.

  const materialiseInput: MaterializeInput = {
    runId,
    target,
    observed: lineage,
    mode,
    baseline,
    baselineFindings: options.baselineFindings,
    catalog,
    observerFindings: observer.findings,
    observerCapturedAt: observer.capturedAt,
    observedAt: endedAt,
    lifecycles: resolved.lifecycles,
    ...(config.classifyObserverFinding !== undefined
      ? { classifier: config.classifyObserverFinding }
      : {}),
  };

  // One materialiser, not three call sites. The operator's own failures
  // join the same set of review records later, once cleanup has run:
  // they were classified before execution began, but a cleanup failure
  // can only be known afterwards.
  const runOutcomes = materializeOutcomes(materialiseInput);

  const persistence =
    setupRefused || options.persist === false
      ? emptyPersistence(resolved)
      : await persistRun({
          service: config.cohort,
          plan,
          members: resolved.members,
          environmentId: target.environmentId,
          version,
          runId,
          observedAt: endedAt,
          ...(plan.lineage === undefined ? {} : { closeTransition: true }),
        });

  const behavioral = rollUpBehavioralEvidence({
    runId,
    startedAt,
    endedAt,
    events,
    identities: execution.identities,
    catalog,
    participantConfigurations: resolved.members.map((m) => ({
      participantId: m.id,
      personaPrompt: m.persona,
      capability: config.participantProfile(m),
    })),
  });

  const result: RunResult = {
    runId,
    experimentPath: artifactDir,
    seed: config.experiment.seed,
    startedAt,
    endedAt,
    terminationReasons: Object.fromEntries(
      execution.identities.map((r) => [r.identityId, r.terminationReason]),
    ),
    participants: execution.identities.map((r) => ({
      participantId: r.identityId,
      selfReport: r.selfReport,
    })),
    observer,
    evidence: behavioral,
  };

  let cleanup: OperatorCleanupResult | undefined;
  if (
    operator !== undefined &&
    !setupRefused &&
    (config.cleanup ?? true) &&
    options.skipCleanup !== true
  ) {
    cleanup = await runCleanupPhase(operator, { plan, target, runId });
  }
  // A cleanup that was denied, or that could not release everything,
  // means world state this run created is still live. That is the one
  // condition in #59's taxonomy that can leave something behind, so it
  // is reported as a `SetupFailure` of its own rather than left for the
  // caller to notice in `result.cleanup` — and it is never collapsed
  // into the failure that caused it.
  const cleanupFailures: ReadonlyArray<SetupFailure> =
    cleanup === undefined || !('failure' in cleanup)
      ? Object.freeze([])
      : Object.freeze([
          setupFailureFromOperator(cleanup.failure, {
            runId,
            target,
            identityIds: memberIds,
            ordinal: 1,
            kind: 'cleanup',
          }),
        ]);
  const findings = runOutcomes.filter(isFinding);
  const runFailures = runOutcomes.filter(isSetupFailure);
  const outcomes: ReadonlyArray<ReviewOutcome> = Object.freeze([
    ...runOutcomes,
    ...setupFailures,
    ...cleanupFailures,
  ]);
  // Read after cleanup so the audit a caller receives — and the audit
  // written into the artifact — covers the whole privileged lifecycle of
  // the run, not only its setup half. A `fixture.reset` that never made
  // it into the durable record is exactly the leak this ordering exists
  // to prevent.
  const operatorAudit: ReadonlyArray<OperatorAuditRecord> =
    operator === undefined ? Object.freeze([]) : operator.audit();

  // Written last, so the artifact is the closed record of the run
  // including whatever cleanup did.
  await writeArtifact({
    outDir: config.experiment.outDir,
    artifactDir,
    runId,
    plan,
    target,
    seed: config.experiment.seed,
    startedAt,
    endedAt,
    version,
    events,
    members: resolved.members,
    profiles: new Map(resolved.members.map((m) => [m.id, config.participantProfile(m)])),
    identities: execution.identities,
    observer,
    result,
    outcomes,
    operatorAudit,
    cleanupStatus: cleanup?.status ?? (operator === undefined ? 'none' : setupRefused ? 'notAttempted' : 'skipped'),
  });

  return Object.freeze({
    runId,
    target,
    lineage,
    mode,
    outcomes,
    findings,
    setupFailures: Object.freeze([...setupFailures, ...runFailures, ...cleanupFailures]),
    evidence: catalog.all,
    resolvedCohort: resolved,
    setup,
    operatorAudit,
    ...(cleanup !== undefined ? { cleanup } : {}),
    persistence,
    observer,
    setupRefused,
    startedAt,
    endedAt,
    artifactDir,
  });
}

/* -------------------------------------------------------------------------- */
/* Invocation-time validation                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The plan must describe a target the durable model actually declares.
 *
 * #62 plans are built from declarations, so a mismatch is a caller
 * mistake rather than a state to be tolerated — and tolerating it would
 * put a finding on a Product/Environment/Cohort/Program the model's own
 * lineage cannot justify. Each of the four is checked against the model
 * and the target is re-parsed by #57, so a hand-built plan object cannot
 * bypass the id grammar.
 */
function assertPlanInModel(
  config: RuntimeConfiguration,
  plan: EvaluationPlan,
): EvaluationTargetRef {
  const { model } = config;
  const declared = parseEvaluationTargetRef({
    productId: plan.target.productId,
    environmentId: plan.target.environmentId,
    cohortId: plan.target.cohortId,
    programId: plan.target.programId,
  });

  const missing: string[] = [];
  if (model.product.id !== declared.productId) missing.push(`product ${String(declared.productId)}`);
  if (!model.environments.some((e) => e.id === declared.environmentId)) {
    missing.push(`environment ${declared.environmentId}`);
  }
  if (!model.cohorts.some((c) => c.id === declared.cohortId)) {
    missing.push(`cohort ${declared.cohortId}`);
  }
  if (!model.programs.some((p) => p.id === declared.programId)) {
    missing.push(`review program ${declared.programId}`);
  }
  if (missing.length > 0) {
    throw new RuntimeIntegrationError(
      `the plan targets durable identities the model does not declare: ${missing.join(', ')}`,
      'planNotInModel',
      'plan.target',
      { declared, declaredProductId: model.product.id },
    );
  }

  const program = model.programs.find((p) => p.id === declared.programId);
  if (program !== undefined && program.cohortId !== declared.cohortId) {
    throw new RuntimeIntegrationError(
      `review program ${declared.programId} evaluates cohort ${program.cohortId}, not ` +
        `${declared.cohortId}; a plan may not pair a program with a cohort it does not own`,
      'planNotInModel',
      'plan.target.cohortId',
      { programId: declared.programId, declaredCohortId: declared.cohortId },
    );
  }
  if (program !== undefined && !program.environmentIds.includes(declared.environmentId)) {
    throw new RuntimeIntegrationError(
      `review program ${declared.programId} does not evaluate environment ${declared.environmentId}`,
      'planNotInModel',
      'plan.target.environmentId',
      { programId: declared.programId, declaredEnvironmentId: declared.environmentId },
    );
  }

  return declared;
}

function resolveObservedVersion(plan: EvaluationPlan, declared?: string): string {
  const candidate = declared ?? plan.observedVersion?.version ?? plan.lineage?.current.version;
  if (candidate === undefined || candidate === '') {
    throw new RuntimeIntegrationError(
      'no version was supplied and the plan declares none; an identity observation records the ' +
        'version the environment answered as, and guessing one would poison the next ' +
        'release-transition join',
      'noObservedVersion',
      'observedVersion',
      { planKey: plan.planKey },
    );
  }
  return candidate;
}

/**
 * Resolve the mode, and refuse a comparative claim that cannot be made.
 *
 * A `releaseTransition` mode with no baseline is refused rather than
 * downgraded. Downgrading would be quieter and wrong: the caller asked
 * for a returning-user comparison, the runtime would deliver a
 * point-in-time run, and the difference between the two is exactly what
 * the evaluation was commissioned to establish.
 */
function resolveLongitudinal(
  plan: EvaluationPlan,
  options: RunEvaluationOptions,
): { mode: EvaluationMode; baseline: RunLineage | null } {
  const baseline = options.baseline ?? null;
  const declaredMode = options.mode ?? plan.mode;

  if (baseline === null) {
    if (declaredMode === 'releaseTransition') {
      throw new RuntimeIntegrationError(
        'the plan declares mode "releaseTransition" but no baseline run was supplied; #61 ' +
          'refuses a release-transition finding with no baseline, and the runtime will not ' +
          'claim a mode the evidence does not support. Pass the earlier RunLineage as `baseline`.',
        'unjoinableBaseline',
        'baseline',
        { planKey: plan.planKey, mode: declaredMode },
      );
    }
    return { mode: declaredMode, baseline: null };
  }

  if (declaredMode === 'pointInTime') {
    throw new RuntimeIntegrationError(
      'a baseline was supplied but the mode is "pointInTime"; #61 requires baseline to be null ' +
        'in point-in-time mode, so one of the two declarations is wrong',
      'unjoinableBaseline',
      'baseline',
      { planKey: plan.planKey, mode: declaredMode, baselineRunId: baseline.runId },
    );
  }

  return { mode: declaredMode, baseline };
}

/**
 * Assert a supplied baseline really is a returning-user comparison.
 *
 * #57 does the actual comparison; this turns its boolean into a
 * message that names which axis failed, at the point the caller can act
 * on it, rather than an opaque `ReviewContractError` from inside
 * `parseFinding`.
 *
 * Called with a *projected* current lineage, built from the validated
 * target, the resolved cohort and the resolved run id, before any
 * provisioning or browser work. #57's predicate reads only `runId`, the
 * program scope and the identity set, so the projection carries
 * everything the decision depends on and the rejection is free.
 */
export function assertJoinableBaseline(baseline: RunLineage, observed: RunLineage): void {
  if (isReleaseTransitionComparison(baseline, observed)) return;
  const scope = (l: RunLineage): string => `${l.productId}|${l.cohortId}|${l.programId}`;
  if (baseline.runId === observed.runId) {
    throw new RuntimeIntegrationError(
      `the baseline run (${baseline.runId}) is the run being observed; a comparison needs two ` +
        'distinct runs',
      'unjoinableBaseline',
      'baseline.runId',
      { runId: baseline.runId },
    );
  }
  if (scope(baseline) !== scope(observed)) {
    throw new RuntimeIntegrationError(
      'the baseline run does not share this program\'s scope: ' +
        `${scope(baseline)} vs ${scope(observed)}. A comparative claim needs the same Product, ` +
        'Cohort and Review Program; the environment is deliberately allowed to differ.',
      'unjoinableBaseline',
      'baseline',
      { baselineScope: scope(baseline), observedScope: scope(observed) },
    );
  }
  throw new RuntimeIntegrationError(
    'the baseline run and this run share no Synthetic Identity, so they are not a returning-user ' +
      'observation. #61 requires at least one identity in both.',
    'unjoinableBaseline',
    'baseline.identityIds',
    { baselineIdentityIds: baseline.identityIds, observedIdentityIds: observed.identityIds },
  );
}

/**
 * The entry point to drive a browser at, or a refusal.
 *
 * Checked before the World Operator exists, so a model whose environment
 * has no reachable entry point fails before any world state is applied.
 *
 * The test is falsy, not `undefined`: #57's parser already guarantees a
 * non-empty absolute origin, so this is a second line against a model
 * assembled by hand or across a serialisation boundary. A falsy check
 * would let `baseUrl: ''` through — the exact shape a hand-built model
 * most likely has — and the run would then fail one layer later, inside
 * the adapter, with the connector already holding live resources.
 */
function resolveTargetUrl(config: RuntimeConfiguration, environmentId: EnvironmentId): string {
  const environment = config.model.environments.find((e) => e.id === environmentId);
  const baseUrl = environment?.endpoint.baseUrl;
  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
    throw new RuntimeIntegrationError(
      `environment ${environmentId} declares no endpoint, so there is nothing to drive a browser at`,
      'noEnvironmentEndpoint',
      'model.environments.endpoint',
      { environmentId, received: baseUrl === undefined ? 'absent' : typeof baseUrl },
    );
  }
  return baseUrl;
}

/* -------------------------------------------------------------------------- */
/* Participant execution                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Everything a participant run is given.
 *
 * Note what is absent: no operator, no connector, no provisioning
 * request, no resource handle, no durable store. This object is the
 * complete set of capabilities a participant has, and it is strictly
 * narrower than the union of everything the runtime holds.
 */
export interface ParticipantExecutionContext {
  readonly runId: string;
  readonly identity: SyntheticIdentity;
  readonly targetUrl: string;
  readonly userStory: string;
  readonly capability: CapabilityProfile;
  readonly reasoner: Reasoner;
  readonly adapter: BrowserAdapter;
  readonly budget: number;
  readonly recorder: InMemoryRecorder;
}

interface IdentityExecution {
  readonly events: ReadonlyArray<RunEvent>;
  readonly identities: ReadonlyArray<IdentityRunRecord>;
  readonly recorder: InMemoryRecorder;
}

async function executeIdentities(
  config: RuntimeConfiguration,
  input: {
    readonly runId: EvaluationRunId;
    readonly targetUrl: string;
    readonly members: ReadonlyArray<SyntheticIdentity>;
    readonly startedAt: string;
    readonly now: RuntimeClock;
  },
): Promise<IdentityExecution> {
  const recorder = new InMemoryRecorder();
  await recorder.append({
    type: 'run.start',
    runId: input.runId,
    ts: input.startedAt,
    experimentPath: config.experiment.outDir,
    seed: config.experiment.seed,
    packageVersion: VERSION,
  });

  const identities: IdentityRunRecord[] = [];

  for (const identity of input.members) {
    const adapter = config.adapterFactory();
    const observations: StoredObservation[] = [];
    try {
      const context: ParticipantExecutionContext = {
        runId: input.runId,
        identity,
        targetUrl: input.targetUrl,
        userStory: config.experiment.userStory,
        capability: config.participantProfile(identity),
        reasoner: makeReasoner(config, 'participant', identity.id, identity),
        adapter,
        budget: config.experiment.maxStepsPerIdentity,
        recorder,
      };

      const outcome = await runParticipant({
        runId: context.runId,
        // The durable identity id *is* the participant id, so every event
        // in the stream joins to a `SyntheticIdentityId` with no lookup
        // table and no second naming scheme.
        participantId: context.identity.id,
        personaPrompt: context.identity.persona,
        userStory: context.userStory,
        capability: context.capability,
        reasoner: context.reasoner,
        adapter: context.adapter,
        targetUrl: context.targetUrl,
        budget: context.budget,
        recorder: context.recorder,
        onStepObservation: async (observation) => {
          observations.push({
            participantId: context.identity.id,
            stepIndex: observation.stepIndex,
            observation,
          });
        },
      });

      const termination = (await recorder.snapshot())
        .filter(
          (e): e is Extract<RunEvent, { type: 'termination' }> =>
            e.type === 'termination' && e.participantId === identity.id,
        )
        .at(-1);

      identities.push({
        identityId: identity.id,
        selfReport: outcome.selfReport,
        terminationReason: termination?.reason ?? 'error',
        observations,
        ...(outcome.error !== undefined && outcome.error !== ''
          ? { error: outcome.error }
          : {}),
      });
    } catch (error) {
      // `runParticipant` reports its own failures through `error`; a
      // throw here is a defect in the wiring (an adapter that could not
      // be constructed, a reasoner factory that raised). Either way the
      // run must still produce a diagnosable record rather than lose the
      // identity, so the failure is folded into the same channel and the
      // loop continues to the next identity.
      identities.push({
        identityId: identity.id,
        // `EMPTY_SELF_REPORT` is the existing constant for "this
        // participant never produced one", restated with the two fields
        // that must be per-run. Restating the other nine would be a
        // second place for a new self-report field to be forgotten.
        selfReport: {
          ...EMPTY_SELF_REPORT,
          participantId: identity.id,
          capturedAt: input.now(),
        },
        terminationReason: 'error',
        observations,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    } finally {
      // The adapter owns a page. It is closed whatever happened, or the
      // next identity's run leaks a browser.
      await adapter.close().catch(() => undefined);
    }
  }

  return { events: await recorder.snapshot(), identities, recorder };
}

function makeReasoner(
  config: RuntimeConfiguration,
  role: 'participant' | 'observer',
  participantLabel: string,
  identity?: SyntheticIdentity,
): Reasoner {
  const factory = config.reasonerFactory ?? defaultReasonerFactory;
  const script =
    identity === undefined || config.scriptFor === undefined
      ? undefined
      : config.scriptFor(identity);
  return factory(
    role === 'observer' ? config.experiment.observerReasoner : config.experiment.participantReasoner,
    {
      role,
      participantLabel,
      ...(script !== undefined ? { script } : {}),
    },
  );
}

/**
 * Default Reasoner construction.
 *
 * The action script is folded into the config here rather than widening
 * `ReasonerConfig`, which is the existing experiment contract and
 * #65's surface. A scripted integration run therefore needs no change
 * to any other ticket's file.
 */
function defaultReasonerFactory(
  config: ReasonerConfig,
  ctx: {
    readonly role: 'participant' | 'observer';
    readonly participantLabel: string;
    readonly script?: ReadonlyArray<ParticipantAction>;
  },
): Reasoner {
  // `script` is not a member of `ReasonerConfig` — the experiment
  // contract has nowhere to carry an action list — so the widened shape
  // is built through a typed binding rather than an object literal, which
  // keeps `createReasoner`'s own signature honest.
  if (ctx.script !== undefined) {
    const widened: ReasonerConfig & { script: ReadonlyArray<ParticipantAction> } = {
      ...config,
      script: ctx.script,
    };
    return createReasoner(widened, { role: ctx.role, participantLabel: ctx.participantLabel });
  }
  return createReasoner(config, { role: ctx.role, participantLabel: ctx.participantLabel });
}

/* -------------------------------------------------------------------------- */
/* Artifact                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Write the run's artifact.
 *
 * Every locator the evidence catalogue produced names a file written
 * here — `events.ndjson`, `self-report/<identityId>.json`,
 * `observer.report.json`, `review-records.json` — so a reviewer
 * following a citation arrives at the thing the citation said it was.
 * That correspondence is the reason the catalogue and this writer live
 * in the same package.
 */
async function writeArtifact(input: {
  /** `experiment.outDir`. `FileArtifactIO` appends the run id itself. */
  readonly outDir: string;
  /** `path.join(outDir, runId)`: where this artifact actually landed. */
  readonly artifactDir: string;
  readonly runId: EvaluationRunId;
  readonly plan: EvaluationPlan;
  readonly target: EvaluationTargetRef;
  readonly seed: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly version: string;
  readonly events: ReadonlyArray<RunEvent>;
  readonly members: ReadonlyArray<SyntheticIdentity>;
  readonly profiles: ReadonlyMap<string, CapabilityProfile>;
  readonly identities: ReadonlyArray<IdentityRunRecord>;
  readonly observer: ObserverReport;
  readonly result: RunResult;
  readonly outcomes: ReadonlyArray<ReviewOutcome>;
  readonly operatorAudit: ReadonlyArray<OperatorAuditRecord>;
  readonly cleanupStatus: string;
}): Promise<void> {
  // `FileArtifactIO` resolves its root to `<rootDir>/<runId>`; passing
  // the already-joined artifact directory would nest the run id twice.
  const io = new FileArtifactIO({ rootDir: input.outDir, runId: input.runId });

  await io.writeManifest({
    runId: input.runId,
    // The experiment manifest contract has no field for a durable
    // target, so the plan key and the observed version are recorded as
    // manifest metadata. The full lineage lives in `review-records.json`.
    experimentId: input.plan.planKey,
    seed: input.seed,
    experimentPath: input.artifactDir,
    packageVersion: VERSION,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    terminationReasons: input.result.terminationReasons,
    participants: input.members.map((m) => {
      const profile = input.profiles.get(m.id);
      return {
        id: m.id,
        personaPrompt: m.persona,
        ...(profile !== undefined ? { capability: profile } : {}),
      };
    }),
    observer: { provider: 'see observer.report.json' },
    target: {
      productId: input.target.productId,
      environmentId: input.target.environmentId,
      cohortId: input.target.cohortId,
      programId: input.target.programId,
      observedVersion: input.version,
      planKey: input.plan.planKey,
    },
  });

  await io.writeParticipants(
    Object.fromEntries(
      input.members.map((m) => {
        const profile = input.profiles.get(m.id);
        return [
          m.id,
          {
            displayName: m.displayName,
            personaPrompt: m.persona,
            lifecycle: m.lifecycle,
            ...(profile !== undefined ? { capability: profile } : {}),
          },
        ];
      }),
    ),
  );

  await io.writeEvents(input.events);
  for (const record of input.identities) {
    for (const observation of record.observations) {
      await io.writeObservation(record.identityId, observation.stepIndex, observation.observation);
    }
    await io.writeSelfReport(record.identityId, record.selfReport);
  }
  await io.writeObserverReport(input.observer);
  await io.writeResult(input.result);
  await io.writeSummary(renderSummary(input));

  // #61's records and #59's audit are not part of the experiment artifact
  // contract, so they are written directly rather than by widening
  // `ArtifactIO`. Both are load-bearing: an evidence locator that points
  // at a file the run did not write is not inspectable, and #61's
  // `assertSupportsClaim` exists to make that impossible.
  await writeJsonFile(path.join(input.artifactDir, 'review-records.json'), input.outcomes);
  await writeJsonFile(path.join(input.artifactDir, 'operator-audit.json'), {
    policyId: input.plan.authority.operatorAuthorityRefs.join(','),
    cleanupStatus: input.cleanupStatus,
    records: input.operatorAudit,
  });

  await io.finalize();
}

async function writeJsonFile(target: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function renderSummary(input: {
  readonly runId: EvaluationRunId;
  readonly target: EvaluationTargetRef;
  readonly plan: EvaluationPlan;
  readonly version: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly identities: ReadonlyArray<IdentityRunRecord>;
  readonly outcomes: ReadonlyArray<ReviewOutcome>;
}): string {
  const findings = input.outcomes.filter((o): o is Finding => o.outcome === 'productFinding');
  const setupFailures = input.outcomes.filter(
    (o): o is SetupFailure => o.outcome === 'setupFailure',
  );

  const lines: string[] = [];
  lines.push(`# Evaluation run ${input.runId}`);
  lines.push('');
  lines.push(`- Product: ${input.target.productId}`);
  lines.push(`- Environment: ${input.target.environmentId} (observed version ${input.version})`);
  lines.push(`- Cohort: ${input.target.cohortId}`);
  lines.push(`- Review program: ${input.target.programId}`);
  lines.push(`- Plan: ${input.plan.planKey} (declared mode ${input.plan.mode})`);
  lines.push(`- Started: ${input.startedAt}`);
  lines.push(`- Ended: ${input.endedAt}`);
  lines.push('');
  lines.push('## Synthetic identities');
  for (const record of input.identities) {
    lines.push(`- ${record.identityId}: terminated (${record.terminationReason})`);
  }
  lines.push('');
  lines.push(`## Product findings (${findings.length})`);
  for (const finding of findings) {
    lines.push(`- [${finding.severity}/${finding.kind}] ${finding.title} (${finding.id})`);
  }
  lines.push('');
  // Setup failures are listed separately and never merged into the
  // finding list. A reader scanning this file must not be able to
  // mistake "we could not evaluate" for "your product has a problem".
  lines.push(`## Setup failures (${setupFailures.length})`);
  for (const failure of setupFailures) {
    lines.push(`- [${failure.cause}] ${failure.message} (${failure.id})`);
  }
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Empty shapes                                                                   */
/* -------------------------------------------------------------------------- */

function skippedSetup(): SetupPhaseResult {
  return Object.freeze({
    status: 'skipped' as const,
    connector: Object.freeze({ connectorId: 'none' }),
    resourceKeys: Object.freeze([]),
    spendUnits: 0,
    audit: Object.freeze([]),
    failures: Object.freeze([]),
  });
}

function emptyExecution(): IdentityExecution {
  return {
    events: Object.freeze([]),
    identities: Object.freeze([]),
    recorder: new InMemoryRecorder(),
  };
}

function emptyPersistence(resolved: ResolvedCohort): PersistRunResult {
  return Object.freeze({
    states: Object.freeze([]),
    persistedIdentityIds: Object.freeze([]),
    skippedIdentityIds: Object.freeze(resolved.members.map((m) => m.id)),
    closedTransitions: Object.freeze([]),
  });
}

function unavailableObserver(capturedAt: string, reason: string): ObserverReport {
  return {
    capturedAt,
    summary: `observer did not run: ${reason}`,
    findings: [],
    terminationVerdict: {
      declared: 'unknown',
      plausible: false,
      note:
        `${reason}. No findings were produced because the run never reached the product; this is ` +
        'a setup outcome, not an observation that the product produced no usability signal.',
    },
  };
}
