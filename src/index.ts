/**
 * Public package entry. We export domain, capability, participant,
 * observer, evidence types, and the experiment runner. Internal test
 * helpers (`__testHelpers` exports in submodules) are deliberately not
 * rolled up to keep the public surface small.
 */
export { VERSION } from './version.js';
export * from './domain/index.js';
export {
  applyParticipantObservation,
  assertNoPrivilegedLeak,
  describeObservationCapability,
  enforceActionAllowlist,
  isHumanFacingAction,
  enforceRawAttempt,
  listHumanFacingPrimitiveKinds,
  buildReasonerRequest,
  memoryWindowDescription,
} from './capability/index.js';
export type {
  MemoryInputs,
  MemoryOutcome,
  FilterOptions,
} from './capability/index.js';
export { createReasoner, createReasonerForExperiment } from './reasoner/index.js';
export { scriptedReasoner } from './reasoner/index.js';
export { anthropicReasoner } from './reasoner/index.js';
export type {} from './reasoner/index.js';
export { runParticipant } from './participant/index.js';
export { participantActionSystemPrompt, participantSelfReportSystemPrompt } from './participant/index.js';
export type {} from './participant/index.js';
export { runObserver } from './observer/index.js';
export { observerSystemPrompt } from './observer/index.js';
export type {} from './observer/index.js';
export type { EvidenceRecorder, ArtifactIO, FileArtifactIOOptions } from './evidence/index.js';
export { InMemoryRecorder, FileRecorder, makeInMemoryRecorder } from './evidence/index.js';
export { FileArtifactIO } from './evidence/index.js';
export { fnv1aHex, digestRequest } from './evidence/index.js';
export type {} from './evidence/index.js';
export type { BrowserAdapter, HttpAdapterState } from './adapter/index.js';
export { HttpAdapter, PlaywrightAdapter } from './adapter/index.js';
export type {} from './adapter/index.js';
export { runExperiment, loadExperiment } from './experiment/index.js';
export type { RunExperimentOptions, RunExperimentResult } from './experiment/index.js';

/* -------------------------------------------------------------------------- */
/* Continuous Product Evaluation (issue #65)                                   */
/* -------------------------------------------------------------------------- */
/*
 * The 0.4.0 domains roll up here for the first time. `src/config/index.ts`
 * and `src/runtime/index.ts` each stated that they are "not re-exported
 * from the package entrypoint — wiring the new domains into the export
 * map is a separate, single-owner ticket once every 0.4.0 domain
 * exists". This is that ticket, and this file is the single owner.
 *
 * Re-exported rather than re-implemented: the authority surface (#58),
 * the planning surface (#62) and the runtime surface (#63) keep their
 * own entrypoints and their own contracts. What is added here is the
 * seam between them — `buildRuntimeConfiguration`, the function that
 * turns a validated `UseSekaiConfig` into the `RuntimeConfiguration`
 * #63 consumes — and that lives in `src/cli/program-command.ts` because
 * it is the CLI's job, not the library's.
 *
 * `runCli` is re-exported so an embedder can drive the same command
 * surface a terminal would, with the same exit codes.
 */
export {
  CONFIG_PATH_ENV_VAR,
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIG_FILENAME,
  UseSekaiConfigError,
  findConfiguredEnvironment,
  findConfiguredEnvironmentByName,
  loadUseSekaiConfig,
  parseUseSekaiConfigText,
  resolveConfigPath,
  type ConfigProvenance,
  type ConfiguredEnvironment,
  type EnvironmentAuthority,
  type LoadConfigOptions,
  type UseSekaiConfig,
} from './config/index.js';

export {
  EVALUATION_MODES,
  buildEvaluationPlan,
  planEvaluation,
  ProgramPlanningError,
  type EvaluationMode,
  type EvaluationPlan,
  type NotDueReason,
  type PlanDecision,
  type PlanEvaluationInput,
} from './program/index.js';

export {
  isRuntimeIntegrationError,
  runEvaluation,
  RuntimeIntegrationError,
  type EvaluationRunResult,
  type RunEvaluationOptions,
  type RuntimeConfiguration,
} from './runtime/index.js';

export {
  CohortStateError,
  CohortStateService,
  FileRecordStore,
  isCohortStateError,
  type RecordStore,
} from './cohort/index.js';

export { runCli } from './cli/index.js';
