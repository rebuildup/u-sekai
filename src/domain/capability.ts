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
export type PrivilegedActionKind =
  | 'selectorClick'
  | 'evaluateJs'
  | 'getDomTree'
  | 'readInternalMetadata';

export interface PrivilegedActionAttempt {
  readonly kind: PrivilegedActionKind;
  readonly payload: Record<string, unknown>;
}

export const PRIVILEGED_ACTION_KINDS: ReadonlySet<string> = new Set<PrivilegedActionKind>([
  'selectorClick',
  'evaluateJs',
  'getDomTree',
  'readInternalMetadata',
]);

export function isPrivilegedActionKind(value: unknown): value is PrivilegedActionKind {
  return typeof value === 'string' && PRIVILEGED_ACTION_KINDS.has(value);
}

/**
 * True when the parsed value is a *recognised* attempt to reach a
 * privileged primitive. This is the only shape that justifies a
 * `capabilityViolation`: an unknown or structurally broken `kind` is a
 * contract problem, not a capability one (ADR-0008).
 */
export function isPrivilegedActionAttempt(value: unknown): value is PrivilegedActionAttempt {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { kind?: unknown; payload?: unknown };
  if (!isPrivilegedActionKind(v.kind)) return false;
  const payload = v.payload;
  if (payload === undefined) {
    return true;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  return true;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function fieldType(v: unknown): string {
  if (v === undefined) return 'missing';
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

/**
 * Explains why `value` is not a valid `ParticipantAction`, or returns
 * `null` when it is. The structured-output boundary uses this to build a
 * `contractValidation` diagnostic that names the offending field.
 */
export function describeParticipantActionDefect(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return `expected a JSON object, received ${fieldType(value)}`;
  }
  if (Array.isArray(value)) {
    return 'expected a JSON object, received array';
  }
  const v = value as Record<string, unknown>;
  const kind = v['kind'];
  if (kind === undefined) {
    return 'action object has no "kind" discriminator';
  }
  if (typeof kind !== 'string') {
    return `action "kind" must be a string, received ${fieldType(kind)}`;
  }
  switch (kind) {
    case 'clickByCoords':
    case 'tapByCoords': {
      if (!isFiniteNumber(v['x'])) return `${kind}: "x" must be a finite number, received ${fieldType(v['x'])}`;
      if (!isFiniteNumber(v['y'])) return `${kind}: "y" must be a finite number, received ${fieldType(v['y'])}`;
      return null;
    }
    case 'typeText':
      return typeof v['text'] === 'string' ? null : `typeText: "text" must be a string, received ${fieldType(v['text'])}`;
    case 'scroll': {
      const direction = v['direction'];
      if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') {
        return `scroll: "direction" must be one of up|down|left|right, received ${fieldType(direction)}`;
      }
      if (!isFiniteNumber(v['amount'])) {
        return `scroll: "amount" must be a finite number, received ${fieldType(v['amount'])}`;
      }
      return null;
    }
    case 'wait': {
      if (!isFiniteNumber(v['milliseconds'])) {
        return `wait: "milliseconds" must be a finite number, received ${fieldType(v['milliseconds'])}`;
      }
      if ((v['milliseconds'] as number) < 0) {
        return `wait: "milliseconds" must be >= 0, received ${String(v['milliseconds'])}`;
      }
      return null;
    }
    case 'finish':
      return typeof v['reason'] === 'string' ? null : `finish: "reason" must be a string, received ${fieldType(v['reason'])}`;
    default:
      return `unknown action kind "${kind}"; expected one of clickByCoords|tapByCoords|typeText|scroll|wait|finish`;
  }
}

/**
 * Structural check of a value against the `ParticipantAction` contract
 * (ADR-0008). Unlike a `kind` string sniff, this rejects wrong field
 * types and out-of-range values, so a malformed model response cannot be
 * mistaken for an admissible action.
 */
export function isParticipantAction(value: unknown): value is ParticipantAction {
  return describeParticipantActionDefect(value) === null;
}
