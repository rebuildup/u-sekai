/**
 * Shared helpers for the browser-backed tests: a private demo server per
 * test file and coordinate lookup derived from the real page.
 *
 * `startServer({ port: 0 })` is the only supported way to reach the demo
 * environment: ports are ephemeral, and every test file owns its own
 * server so no two files share mutable state or a fixed port.
 */

import { chromium, type Browser, type Page } from 'playwright';
import { startServer, type ServerHandle } from '../../../src/demo/environment/server.js';
import { PlaywrightAdapter } from '../../../src/adapter/browser/playwright-adapter.js';
import type { ObserverObservation } from '../../../src/domain/observation.js';

export type { ServerHandle };

export function startDemoServer(): Promise<ServerHandle> {
  return startServer({ port: 0 });
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Resolves a click point from an observer observation, the same way a
 * Synthetic User reading the screen would: find the interactive region
 * whose visible label matches, then click its centre.
 */
export function regionCenter(
  observation: ObserverObservation,
  match: (region: ObserverObservation['interactiveRegions'][number]) => boolean,
): Point {
  const region = observation.interactiveRegions.find(match);
  if (!region) {
    const seen = observation.interactiveRegions.map((r) => `"${r.label}"`).join(', ');
    throw new Error(
      `no interactive region matched; visible regions were: [${seen}]`,
    );
  }
  return {
    x: Math.round(region.bbox.x + region.bbox.width / 2),
    y: Math.round(region.bbox.y + region.bbox.height / 2),
  };
}

/**
 * Locates the demo task-tracker controls by their visible labels.
 * Labels come from the observer view, never from hardcoded coordinates.
 */
export async function locateDemoControls(baseUrl: string): Promise<{
  readonly titleInput: Point;
  readonly addButton: Point;
  readonly settingsLink: Point;
}> {
  const probe = new PlaywrightAdapter();
  try {
    await probe.open(baseUrl);
    const obs = await probe.observe(0);
    return {
      titleInput: regionCenter(obs, (r) => r.label === 'What needs doing?'),
      addButton: regionCenter(obs, (r) => r.label === 'Add'),
      settingsLink: regionCenter(obs, (r) => r.label === 'Settings'),
    };
  } finally {
    await probe.close();
  }
}

/**
 * Independent page used by tests that need to verify a claim about the
 * DOM without going through the adapter under test.
 */
export async function withIndependentPage<T>(
  url: string,
  fn: (page: Page, browser: Browser) => Promise<T>,
): Promise<T> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return await fn(page, browser);
  } finally {
    await browser.close();
  }
}

export function centerOfLabel(observation: ObserverObservation, label: string): Point {
  return regionCenter(observation, (r) => r.label === label);
}
