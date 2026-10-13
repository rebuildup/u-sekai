/**
 * Versioned environments and A→B release transitions
 * (ADR-0011, issue #69).
 *
 * Public surface for the capability that #67's acceptance scenario
 * needs and that no ticket owned. See `keys.ts` for the identity model,
 * `instance.ts` for the coexisting-pair model, and `transition.ts` for
 * the durable, idempotent, resumable transition.
 */

export {
  EnvironmentKeyError,
  MAX_COMPONENT_LENGTH,
  deriveInstanceKey,
  deriveTransitionKey,
  parseInstanceDeclaration,
  parseInstanceKey,
} from './keys.js';
export type { Brand, EnvironmentInstanceKey, InstanceDeclaration } from './keys.js';

export {
  EnvironmentIsolationError,
  assertNoSharedMutableState,
  startEnvironmentInstance,
  startEnvironmentPair,
} from './instance.js';
export type { EnvironmentInstance, EnvironmentPair } from './instance.js';

export {
  REJECTION_EXPLANATIONS,
  TransitionError,
  TransitionStore,
  applyTransition,
  readTransition,
  resumeIncomplete,
} from './transition.js';
export type {
  ApplyOutcome,
  RejectionReason,
  TransitionEndpoints,
  TransitionRecord,
  TransitionState,
} from './transition.js';
