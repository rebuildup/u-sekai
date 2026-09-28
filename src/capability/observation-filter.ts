/**
 * Observation filter (ADR-0006).
 *
 * `BrowserAdapter.observe()` produces a privileged `ObserverObservation`.
 * The participant runtime calls `applyParticipantObservation(observerView, profile)`
 * to derive the participant-safe view. This is the ONLY path that maps a
 * privileged observation to a participant observation, so it is the only
 * place that can leak or strip privileged signals.
 */

import type {
  CapabilityProfile,
  ObservationCapability,
} from '../domain/capability.js';
import type {
  ObserverObservation,
  ParticipantObservation,
  VisualObservation,
  AriaObservation,
} from '../domain/observation.js';
import { CapabilityViolation } from '../domain/errors.js';

function visibleTextOf(visual: VisualObservation): string {
  // Adapter populates `visual.visibleText` directly. We only collapse
  // whitespace here so the participant sees a single block.
  return visual.visibleText.replace(/\s+/g, ' ').trim();
}

const CONTROL_CHAR_REGEX = /[\x00-\x1F\x7F]/g;

/**
 * Default cap for the participant-facing visible text. One constant
 * governs both the projection and the leak assertion below, so the two
 * can never drift apart.
 */
const DEFAULT_VISIBLE_TEXT_MAX_LENGTH = 1000;

export interface FilterOptions {
  /** Maximum depth for the visible-text summary. Defaults to 10. */
  readonly visibleTextMaxLength?: number;
}

export function applyParticipantObservation(
  source: ObserverObservation,
  profile: Pick<CapabilityProfile, 'observation'>,
  opts: FilterOptions = {},
): ParticipantObservation {
  const visibleTextMaxLength = opts.visibleTextMaxLength ?? DEFAULT_VISIBLE_TEXT_MAX_LENGTH;

  if (!isStringNonEmpty(source.url)) {
    throw new CapabilityViolation('observer observation missing url', 'observation', {
      stepIndex: source.stepIndex,
    });
  }

  const visual: VisualObservation = {
    width: source.visual.width,
    height: source.visual.height,
    ...(source.visual.screenshotPng !== undefined
      ? { screenshotPng: source.visual.screenshotPng }
      : {}),
    ...(source.visual.screenshotHash !== undefined
      ? { screenshotHash: source.visual.screenshotHash }
      : {}),
    visibleText: clamp(visibleTextOf(source.visual), visibleTextMaxLength),
    focused: source.visual.focused,
  };

  const interactiveRegions = source.interactiveRegions.map((r) => ({
    label: r.label,
    bbox: r.bbox,
  }));

  const result: ParticipantObservation = {
    stepIndex: source.stepIndex,
    url: source.url,
    title: stripControlCharacters(source.title),
    capturedAt: source.capturedAt,
    visual,
    interactiveRegions,
  };

  if (profile.observation === 'visualPlusAria') {
    return { ...result, aria: clampAria(source.aria) };
  }
  return result;
}

/**
 * Strictly-typed check that a participant-side observation does not leak
 * privileged data. Called by the participant runtime on every step.
 *
 * The check is EXACT, not heuristic: the participant view must be the
 * projection this module produces and nothing else.
 *
 * 1. No privileged key (`domHtml`, `console`, `network`) is reachable.
 * 2. Every reachable key belongs to the participant observation schema,
 *    at any depth - so a `selector` on a region, or an unknown field
 *    smuggled in under `visual`, is a violation regardless of value.
 * 3. Every participant-visible value equals the value derived from the
 *    observer view by the rules above (whitespace-collapsed and capped
 *    visible text, control characters stripped from the title, region
 *    label + bbox only, clamped ARIA). Content that came from anywhere
 *    else - most importantly `domHtml` - cannot equal its projection and
 *    is therefore caught.
 */
export function assertNoPrivilegedLeak(
  observation: ParticipantObservation,
  original: ObserverObservation,
  opts: FilterOptions = {},
): void {
  const stepIndex = observation.stepIndex;

  for (const k of PRIVILEGED_KEYS) {
    if (hasKey(observation, k)) {
      throw new CapabilityViolation(
        `privilege leak: ${k} present in participant observation`,
        'observation',
        { stepIndex, leakedKey: k },
      );
    }
  }

  const offending = findDisallowedKey(observation);
  if (offending) {
    throw new CapabilityViolation(
      `privilege leak: key "${offending}" is not part of the participant observation schema`,
      'observation',
      { stepIndex, leakedKey: offending },
    );
  }

  // `visual` is the minimal projection, so it pins every field the
  // participant may see. ARIA is compared separately: whether it *should*
  // be present is decided by the capability profile the filter was
  // called with, which this assertion cannot see - but its content must
  // still be exactly the clamped observer summary.
  const expected = withoutAria(applyParticipantObservation(original, { observation: 'visual' }, opts));
  const actual = withoutAria(observation);
  const mismatched =
    findProjectionMismatch(actual, expected, '') ??
    (observation.aria !== undefined
      ? findProjectionMismatch(observation.aria, clampAria(original.aria), 'aria')
      : null);
  if (mismatched) {
    throw new CapabilityViolation(
      `privilege leak: participant ${mismatched} does not match the filtered projection of the observer view`,
      'observation',
      { stepIndex, leakedKey: mismatched },
    );
  }
}

function withoutAria(observation: ParticipantObservation): Record<string, unknown> {
  const { aria: _aria, ...rest } = observation as ParticipantObservation & { aria?: unknown };
  return rest as unknown as Record<string, unknown>;
}

/** Returns the first field whose value is not its expected projection. */
function findProjectionMismatch(
  actual: unknown,
  expected: unknown,
  path: string,
): string | null {
  if (isBinary(actual) || isBinary(expected)) {
    return actual === expected ? null : (path || '<root>');
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) return path || '<root>';
    if (actual.length !== expected.length) return path || '<root>';
    for (let i = 0; i < actual.length; i++) {
      const found = findProjectionMismatch(actual[i], expected[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (isRecord(actual) && isRecord(expected)) {
    const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
    for (const key of keys) {
      if (actual[key] === undefined && expected[key] === undefined) continue;
      const found = findProjectionMismatch(actual[key], expected[key], path ? `${path}.${key}` : key);
      if (found) return found;
    }
    return null;
  }
  return actual === expected ? null : (path || '<root>');
}

export function describeObservationCapability(cap: ObservationCapability): string {
  switch (cap) {
    case 'visual':
      return 'visual only (screenshot, visible text, region labels)';
    case 'visualPlusAria':
      return 'visual + a structural ARIA-derived summary (no DOM tree, no selectors)';
  }
}

// --- internals -------------------------------------------------------

/**
 * Keys that exist only on the privileged observer view. Their mere
 * presence in a participant view is a violation, whatever the value is.
 */
const PRIVILEGED_KEYS = ['domHtml', 'console', 'network'] as const;

/**
 * Exact key set of the participant observation schema, per level. Any
 * other key reachable in a participant view is treated as a leak.
 */
const PARTICIPANT_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  '': new Set(['stepIndex', 'url', 'title', 'capturedAt', 'visual', 'aria', 'interactiveRegions']),
  visual: new Set(['width', 'height', 'screenshotPng', 'screenshotHash', 'visibleText', 'focused']),
  focused: new Set(['x', 'y', 'width', 'height']),
  aria: new Set(['role', 'name', 'description', 'children']),
  children: new Set(['role', 'name']),
  interactiveRegions: new Set(['label', 'bbox']),
  bbox: new Set(['x', 'y', 'width', 'height']),
};

function hasKey(target: unknown, key: string): boolean {
  return isRecord(target) && Object.prototype.hasOwnProperty.call(target, key);
}

/**
 * Walks the participant view and returns the first key that is not part
 * of the schema, or `null` when the view is clean.
 */
function findDisallowedKey(value: unknown, path = ''): string | null {
  if (isBinary(value)) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDisallowedKey(item, path);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    const allowed = PARTICIPANT_KEYS[path];
    if (!allowed || !allowed.has(key)) {
      return path ? `${path}.${key}` : key;
    }
    const found = findDisallowedKey(child, childPathFor(path, key));
    if (found) return found;
  }
  return null;
}

function childPathFor(parentPath: string, key: string): string {
  if (parentPath === '' && key === 'interactiveRegions') return 'interactiveRegions';
  if (parentPath === 'interactiveRegions' && key === 'bbox') return 'bbox';
  return key;
}

function isBinary(value: unknown): boolean {
  return value instanceof Uint8Array || value instanceof ArrayBuffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

function stripControlCharacters(s: string): string {
  return s.replace(CONTROL_CHAR_REGEX, '');
}

function clampAria(aria: AriaObservation): AriaObservation {
  return {
    role: aria.role,
    name: stripControlCharacters(aria.name),
    ...(aria.description !== undefined ? { description: stripControlCharacters(aria.description) } : {}),
    children: aria.children.map((c) => ({ role: c.role, name: stripControlCharacters(c.name) })),
  };
}

function isStringNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
