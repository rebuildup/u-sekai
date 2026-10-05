/**
 * Continuous Product Evaluation runtime (issue #63).
 *
 * The public surface of `src/runtime/**`.
 *
 * ## What this package is
 *
 * The seam where the durable model (#57), the cohort store (#60), the
 * World Operator boundary (#59), the review contract (#61) and the plan
 * envelope (#62) meet the existing experiment / browser runtime. One
 * call, `runEvaluation`, executes a planned evaluation against a real
 * environment and returns evidence-backed review records.
 *
 * ## Layering
 *
 * This is the only layer that imports from *all* of the above, which is
 * what makes it the only place the dependency is legitimate: each of
 * those packages stays one-way and unaware of the others. It imports
 * `src/participant/**`, `src/observer/**`, `src/evidence/**` and
 * `src/adapter/**` for execution and writes nothing outside
 * `src/runtime/**` and its own artifact directory.
 *
 * Not re-exported from `src/index.ts` — the package entrypoint is #65's
 * ticket, and #63 must not compete for it.
 *
 * ## The four guarantees this package is responsible for
 *
 * 1. **A setup failure is never a product finding.** Every run failure
 *    is returned as a #61 `SetupFailure` with its own id brand and its
 *    own discriminant; a refused plan short-circuits before a single
 *    participant runs, so the "findings" it would have produced cannot
 *    exist. See `setup.ts` and `findings.ts`.
 * 2. **Operator capabilities are unreachable from a participant.** The
 *    connector reaches exactly one call site — `createWorldOperator` —
 *    and the object a participant run receives
 *    ({@link ParticipantExecutionContext}) has no field that could
 *    carry it. See `execute.ts`.
 * 3. **Lineage names Product, Environment, Review Program, Synthetic
 *    Identity / Cohort and run** on every record, and exactly one
 *    `RunLineage` value exists per run — every record carries that
 *    value, so no two records can disagree about which run they came
 *    from. See `lineage.ts` and `findings.ts`.
 * 4. **Only declared state is persisted.** One environment observation
 *    per identity per run, plus the retained-state touch and nothing
 *    else. See `persistence.ts`.
 *
 * ## What this package does not do
 *
 * It does not read configuration from disk (that is #58; see
 * `config.ts` for why the programmatic path is used and what changes
 * when #58 lands), it does not plan ({@link runEvaluation} consumes a
 * #62 `EvaluationPlan`), it does not own a clock, a queue, a provider
 * client or a durable store, and it does not interpret evidence into a
 * score. There is no scalar anywhere in this package.
 */

export {
  isRuntimeIntegrationError,
  RuntimeIntegrationError,
  type RuntimeErrorCode,
} from './errors.js';

export {
  DEFAULT_OBSERVER_CLASSIFIER,
  OBSERVER_SEVERITY_MAP,
  defaultParticipantProfile,
  type ObserverFindingClassifier,
  type RuntimeClock,
  type RuntimeConfiguration,
  type RuntimeExperimentConfig,
  type RuntimeReasonerFactory,
  type RuntimeSetupConfig,
} from './config.js';

export {
  buildRunLineage,
  deriveRequestId,
  deriveRunId,
  resolveRunId,
} from './lineage.js';

export {
  EvidenceCatalogue,
  rollUpBehavioralEvidence,
  type IdentityRunRecord,
  type RunEvidenceInput,
} from './evidence.js';

export {
  buildWorldOperator,
  runCleanupPhase,
  runSetupPhase,
  setupFailureCauseForRuntimeError,
  setupFailureFromOperator,
  type ConnectorIdentity,
  type SetupPhaseInput,
  type SetupPhaseResult,
} from './setup.js';

export {
  classifyChange,
  findingChangeKey,
  materializeFindings,
  materializeOutcomes,
  materializeRuntimeSetupFailures,
  type MaterializeInput,
} from './findings.js';

export {
  assertTransitionEligible,
  openReleaseWindows,
  persistRun,
  resolveCohort,
  type OpenTransitionInput,
  type PersistRunInput,
  type PersistRunResult,
  type ResolveCohortInput,
  type ResolvedCohort,
} from './persistence.js';

export {
  assertJoinableBaseline,
  runEvaluation,
  type EvaluationRunResult,
  type ParticipantExecutionContext,
  type RunEvaluationOptions,
} from './execute.js';
