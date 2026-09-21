/**
 * Action allowlist (ADR-0006). The participant runtime calls
 * `enforceActionAllowlist(action, profile)` BEFORE handing the action to
 * the adapter. Privileged attempts (selector click, JS evaluation, etc.)
 * are caught in `enforceRawAttempt`.
 */

import type {
  ParticipantAction,
  PrivilegedActionAttempt,
  ActionCapability,
} from '../domain/capability.js';
import { CapabilityViolation } from '../domain/errors.js';

const HUMAN_FACING_KINDS: ReadonlySet<ParticipantAction['kind']> = new Set([
  'clickByCoords',
  'tapByCoords',
  'typeText',
  'scroll',
  'wait',
  'finish',
]);

export function isHumanFacingAction(action: ParticipantAction): boolean {
  return HUMAN_FACING_KINDS.has(action.kind);
}

/**
 * Throws if the action cannot be issued under the given capability
 * profile. Returns the same action otherwise (typed proof).
 */
export function enforceActionAllowlist(
  action: ParticipantAction,
  profile: Pick<import('../domain/capability.js').CapabilityProfile, 'action'>,
): ParticipantAction {
  if (profile.action === 'visualOnly') {
    if (!isHumanFacingAction(action)) {
      throw new CapabilityViolation(
        `action "${action.kind}" is not in the visualOnly allowlist`,
        'action',
        { actionKind: action.kind },
      );
    }
  }
  // Reserved for future capability values.
  const _exhaustive: ActionCapability = profile.action;
  void _exhaustive;
  if (!HUMAN_FACING_KINDS.has(action.kind)) {
    throw new CapabilityViolation(
      `action "${action.kind}" is not human-facing`,
      'action',
      { actionKind: action.kind },
    );
  }
  return action;
}

/**
 * Privileged attempts (selector click, JS evaluate, DOM dump, internal
 * metadata) are always rejected regardless of profile. The recording
 * layer still gets a typed `capability.violation` event.
 */
export function enforceRawAttempt(attempt: PrivilegedActionAttempt): never {
  throw new CapabilityViolation(
    `privileged attempt "${attempt.kind}" is not in the human-facing set`,
    'action',
    { attemptKind: attempt.kind, payloadKeys: Object.keys(attempt.payload) },
  );
}

export function listHumanFacingPrimitiveKinds(): ReadonlyArray<ParticipantAction['kind']> {
  return [...HUMAN_FACING_KINDS];
}
