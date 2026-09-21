/**
 * Observation types. Two views exist per step:
 *
 * - `ParticipantObservation` — what the participant runtime sees (already
 *   filtered through the observation capability profile).
 * - `ObserverObservation` — what the observer runtime sees (full,
 *   privileged).
 *
 * The browser adapter produces both per step and the participant runtime
 * never receives the privileged view.
 */

export interface VisualObservation {
  readonly width: number;
  readonly height: number;
  /** PNG bytes when the adapter captured a real browser screenshot. Optional for non-browser adapters. */
  readonly screenshotPng?: Uint8Array;
  /** sha-256 of the screenshot bytes (hex); stable across re-encodings. */
  readonly screenshotHash?: string;
  /** Human-readable textual description (e.g. alt text, button labels, headings). */
  readonly visibleText: string;
  /** Visible focus rectangle (where input would land). */
  readonly focused: { x: number; y: number; width: number; height: number } | null;
}

export interface AriaObservation {
  readonly role: string;
  readonly name: string;
  readonly description?: string;
  /** Children summarised, max depth 2 (filtered). */
  readonly children: ReadonlyArray<{ role: string; name: string }>;
}

export interface ParticipantObservation {
  readonly stepIndex: number;
  readonly url: string;
  readonly title: string;
  readonly capturedAt: string;
  readonly visual: VisualObservation;
  /** Only present when capability `observation === 'visualPlusAria'`. */
  readonly aria?: AriaObservation;
  /** Coordinates of interactive elements (visual cue only — no selectors). */
  readonly interactiveRegions: ReadonlyArray<{
    label: string;
    bbox: { x: number; y: number; width: number; height: number };
  }>;
}

export interface ObserverObservation {
  readonly stepIndex: number;
  readonly url: string;
  readonly title: string;
  readonly capturedAt: string;
  readonly visual: VisualObservation;
  readonly aria: AriaObservation;
  readonly domHtml: string;
  readonly console: ReadonlyArray<{ level: string; text: string; ts: string }>;
  readonly network: ReadonlyArray<{ method: string; url: string; status: number; ts: string }>;
  readonly interactiveRegions: ReadonlyArray<{
    selector: string;
    label: string;
    bbox: { x: number; y: number; width: number; height: number };
  }>;
}
