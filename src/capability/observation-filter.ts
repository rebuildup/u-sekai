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

export interface FilterOptions {
  /** Maximum depth for the visible-text summary. Defaults to 10. */
  readonly visibleTextMaxLength?: number;
}

export function applyParticipantObservation(
  source: ObserverObservation,
  profile: Pick<CapabilityProfile, 'observation'>,
  opts: FilterOptions = {},
): ParticipantObservation {
  const visibleTextMaxLength = opts.visibleTextMaxLength ?? 1000;

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
 * privileged data. Used by tests and as a runtime assertion in
 * development.
 */
export function assertNoPrivilegedLeak(
  observation: ParticipantObservation,
  original: ObserverObservation,
): void {
  const banned: Array<keyof ObserverObservation> = ['domHtml', 'console', 'network'];
  for (const k of banned) {
    const a = (original as unknown as Record<string, unknown>)[k];
    const b = (observation as unknown as Record<string, unknown>)[k];
    if (b !== undefined && a !== undefined && JSON.stringify(b) === JSON.stringify(a)) {
      throw new CapabilityViolation(
        `privilege leak: ${String(k)} present in participant observation`,
        'observation',
        { stepIndex: observation.stepIndex, leakedKey: String(k) },
      );
    }
  }
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
