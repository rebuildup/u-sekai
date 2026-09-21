/**
 * Capability model (ADR-0006).
 *
 * Three axes; each participant profile carries an explicit value on every
 * axis. The participant runtime checks each axis per step; a violation
 * becomes a typed event rather than a hidden assumption.
 */

export type ObservationCapability = 'visual' | 'visualPlusAria';

export type ActionCapability = 'visualOnly';

export type MemoryCapability =
  | { kind: 'fullHistory' }
  | { kind: 'limitedRecent'; windowSteps: number };

export interface CapabilityProfile {
  readonly observation: ObservationCapability;
  readonly action: ActionCapability;
  readonly memory: MemoryCapability;
}

export const DEFAULT_CAPABILITY_PROFILE: CapabilityProfile = {
  observation: 'visual',
  action: 'visualOnly',
  memory: { kind: 'limitedRecent', windowSteps: 3 },
};

export interface ActionPrimitive {
  readonly kind:
    | 'clickByCoords'
    | 'tapByCoords'
    | 'typeText'
    | 'scroll'
    | 'wait'
    | 'finish';
}

export interface ClickByCoordsAction {
  readonly kind: 'clickByCoords';
  readonly x: number;
  readonly y: number;
}
export interface TapByCoordsAction {
  readonly kind: 'tapByCoords';
  readonly x: number;
  readonly y: number;
}
export interface TypeTextAction {
  readonly kind: 'typeText';
  readonly text: string;
}
export interface ScrollAction {
  readonly kind: 'scroll';
  readonly direction: 'up' | 'down' | 'left' | 'right';
  readonly amount: number;
}
export interface WaitAction {
  readonly kind: 'wait';
  readonly milliseconds: number;
}
export interface FinishAction {
  readonly kind: 'finish';
  readonly reason: string;
}

export type ParticipantAction =
  | ClickByCoordsAction
  | TapByCoordsAction
  | TypeTextAction
  | ScrollAction
  | WaitAction
  | FinishAction;

/**
 * Attempt by a participant to invoke a privileged primitive that is NOT
 * in the human-facing set. Always recorded / rejected regardless of
 * language.
 */
export interface PrivilegedActionAttempt {
  readonly kind: 'selectorClick' | 'evaluateJs' | 'getDomTree' | 'readInternalMetadata';
  readonly payload: Record<string, unknown>;
}

export function isParticipantAction(value: unknown): value is ParticipantAction {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { kind?: unknown };
  return (
    v.kind === 'clickByCoords' ||
    v.kind === 'tapByCoords' ||
    v.kind === 'typeText' ||
    v.kind === 'scroll' ||
    v.kind === 'wait' ||
    v.kind === 'finish'
  );
}
