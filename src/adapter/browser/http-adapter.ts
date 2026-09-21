/**
 * HTTP-only browser adapter.
 *
 * Used by CI / scripted tests. Produces a deterministic
 * `ObserverObservation` directly from the response body without launching
 * a browser. Screenshot is intentionally absent — visual observation is
 * represented by structured text + a synthetic focus rectangle.
 */

import type { BrowserAdapter } from './interface.js';
import type {
  ObserverObservation,
  AriaObservation,
  VisualObservation,
} from '../../domain/observation.js';
import type { ParticipantAction } from '../../domain/capability.js';
import type { ActionResult } from '../../domain/action.js';
import { AdapterError } from '../../domain/errors.js';

interface InteractiveRegion {
  readonly selector: string;
  readonly label: string;
  readonly bbox: { x: number; y: number; width: number; height: number };
}

export interface HttpAdapterState {
  url: string;
  title: string;
  body: string;
  domHtml: string;
  interactiveRegions: ReadonlyArray<InteractiveRegion>;
}

export class HttpAdapter implements BrowserAdapter {
  readonly adapterId = 'http';

  private state: HttpAdapterState | null = null;
  private readonly regionIndex = new Map<string, InteractiveRegion>();
  private recentActions: Array<{ ts: string; kind: ParticipantAction['kind']; note?: string }> = [];

  async open(url: string): Promise<void> {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
      throw new AdapterError(`http adapter open failed (${response.status}) for ${url}`, 'http', {
        status: response.status,
      });
    }
    const body = await response.text();
    const parsed = parseSimpleHtml(body);
    this.state = {
      url: response.url,
      title: parsed.title,
      body: parsed.body,
      domHtml: body,
      interactiveRegions: parsed.regions,
    };
    this.regionIndex.clear();
    for (const r of parsed.regions) this.regionIndex.set(r.selector, r);
  }

  async observe(stepIndex: number): Promise<ObserverObservation> {
    if (!this.state) {
      throw new AdapterError('http adapter observe before open', 'http');
    }
    return buildObserverObservation(this.state, stepIndex, this.recentActions);
  }

  async execute(action: ParticipantAction): Promise<ActionResult> {
    if (!this.state) {
      throw new AdapterError('http adapter execute before open', 'http');
    }
    const now = new Date().toISOString();
    this.recentActions.push({ ts: now, kind: action.kind });
    switch (action.kind) {
      case 'wait':
        return { status: 'ok', observedAfter: { url: this.state.url, title: this.state.title } };
      case 'finish':
        return { status: 'ok', observedAfter: { url: this.state.url, title: this.state.title }, note: 'finish' };
      case 'clickByCoords':
      case 'tapByCoords': {
        const region = pickRegionByCoords(this.state.interactiveRegions, action.x, action.y);
        if (!region) {
          return { status: 'error', note: 'no interactive region at coords', code: 'out_of_bounds' };
        }
        return { status: 'ok', observedAfter: { url: this.state.url, title: this.state.title }, note: `clicked ${region.label}` };
      }
      case 'typeText':
        return { status: 'noop', note: 'http adapter does not type into the page; use playwright adapter for live smoke' };
      case 'scroll':
        return { status: 'noop', note: 'http adapter ignores scroll' };
    }
  }

  async close(): Promise<void> {
    this.state = null;
  }

  // Test/diagnostic accessors.
  __stateForTest(): HttpAdapterState | null {
    return this.state;
  }
}

export function parseSimpleHtml(html: string): {
  title: string;
  body: string;
  regions: ReadonlyArray<InteractiveRegion>;
} {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (titleMatch?.[1] ?? '').trim();
  const body = htmlToVisibleText(html);
  const regions: InteractiveRegion[] = [];

  // Buttons.
  let i = 0;
  for (const m of html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi)) {
    const label = stripTags(m[1] ?? '').trim();
    if (!label) continue;
    i += 1;
    regions.push({
      selector: `button[data-uid="${i}"]`,
      label,
      bbox: { x: 200, y: 100 + i * 40, width: 200, height: 32 },
    });
  }
  // Anchors.
  for (const m of html.matchAll(/<a[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = stripTags(m[2] ?? '').trim() || (m[1] ?? '').trim();
    i += 1;
    regions.push({
      selector: `a[data-uid="${i}"]`,
      label,
      bbox: { x: 100, y: 80 + i * 32, width: 180, height: 24 },
    });
  }
  // Inputs.
  for (const m of html.matchAll(/<input[^>]*?(?:\sname=["']([^"']+)["'])?[^>]*?>/gi)) {
    const name = m[1] ?? '';
    i += 1;
    regions.push({
      selector: `input[data-uid="${i}"]`,
      label: name ? `input: ${name}` : 'input',
      bbox: { x: 100, y: 200 + i * 40, width: 280, height: 32 },
    });
  }
  return { title, body, regions };
}

function htmlToVisibleText(html: string): string {
  return stripTags(html)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

function pickRegionByCoords(
  regions: ReadonlyArray<InteractiveRegion>,
  x: number,
  y: number,
): InteractiveRegion | null {
  for (const r of regions) {
    if (
      x >= r.bbox.x &&
      x <= r.bbox.x + r.bbox.width &&
      y >= r.bbox.y &&
      y <= r.bbox.y + r.bbox.height
    ) {
      return r;
    }
  }
  return null;
}

function buildObserverObservation(
  state: HttpAdapterState,
  stepIndex: number,
  recentActions: ReadonlyArray<{ ts: string; kind: ParticipantAction['kind']; note?: string }>,
): ObserverObservation {
  const visual: VisualObservation = {
    width: 1280,
    height: 800,
    visibleText: state.body,
    focused: { x: 200, y: 200, width: 0, height: 0 },
  };
  const aria: AriaObservation = {
    role: 'document',
    name: state.title,
    children: state.interactiveRegions.slice(0, 20).map((r) => ({ role: 'button', name: r.label })),
  };
  return {
    stepIndex,
    url: state.url,
    title: state.title,
    capturedAt: new Date().toISOString(),
    visual,
    aria,
    domHtml: state.domHtml,
    console: [],
    network: [],
    interactiveRegions: state.interactiveRegions,
  };
  void recentActions;
}

export const __testHelpers = { pickRegionByCoords, htmlToVisibleText };
