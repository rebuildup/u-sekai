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
