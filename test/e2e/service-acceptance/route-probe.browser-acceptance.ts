/**
 * Routing probe for Issue #70.
 *
 * The capability for a browser-backed acceptance scenario already existed;
 * only the routing was missing. This file is the smallest thing that can
 * prove the route is live: it sits in the #67 acceptance directory, so it
 * is only executed when `test/vitest.browser.config.ts` picks it up, and it
 * performs one real browser-backed interaction through the *existing*
 * shared harness (`test/browser/support/demo.ts`) rather than a parallel
 * one. No new subsystem, no second Playwright wiring.
 *
 * It is deliberately not the #67 scenario. The longitudinal A -> B
 * acceptance scenario (persistent cohort, environment transition, KPI
 * disposition) is Issue #67's, and its A -> B environment versioning is
 * Issue #69, which is not implemented. What this file establishes is only
 * that a scenario placed in this directory *reaches a real browser* and
 * that the reachability is asserted rather than assumed.
 *
 * Fail-loud: a missing or unusable Chromium fails this file through
 * `assertBrowserRuntimeAvailable()`. It never skips.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { PlaywrightAdapter } from '../../../src/adapter/browser/playwright-adapter.js';
import type { ParticipantAction } from '../../../src/domain/capability.js';
import { assertBrowserRuntimeAvailable } from '../../browser/support/browser-runtime.js';
import { startDemoServer, locateDemoControls, type ServerHandle } from '../../browser/support/demo.js';
import {
  ACCEPTANCE_DIR,
  DEFAULT_E2E_GLOB,
  browserInclude,
  matchesGlob,
  repoRoot,
} from './routing/profile-include.js';

const SELF = path
  .relative(repoRoot, fileURLToPath(import.meta.url))
  .split(path.sep)
  .join('/');

const TITLE = 'Route the acceptance scenario into a real browser';

let server: ServerHandle;

beforeAll(async () => {
  await assertBrowserRuntimeAvailable();
  server = await startDemoServer();
});

afterAll(async () => {
  // `server` is unassigned when beforeAll failed (for example a missing
  // browser runtime); do not mask that failure with a second error.
  await server?.close();
});

describe('#70 acceptance-scenario route', () => {
  it('is reached by the browser profile and by nothing else', () => {
    expect(
      browserInclude.some((pattern) => matchesGlob(pattern, SELF)),
      `${SELF} is not claimed by the browser profile, so this file would never run`,
    ).toBe(true);
    expect(
      matchesGlob(DEFAULT_E2E_GLOB, SELF),
      `${SELF} is also claimed by the default profile; running it there would make ` +
        '`npm run ci` require Chromium (Issue #90)',
    ).toBe(false);
    expect(SELF.startsWith(`${ACCEPTANCE_DIR}/`)).toBe(true);
  });

  it('drives a real browser-backed interaction through the shared harness', async () => {
    // Coordinates come from the observer view of the real rendered page,
    // exactly as a Synthetic User reading the screen would resolve them.
    const controls = await locateDemoControls(server.baseUrl);
    const script: ParticipantAction[] = [
      { kind: 'clickByCoords', ...controls.titleInput },
      { kind: 'typeText', text: TITLE },
      { kind: 'clickByCoords', ...controls.addButton },
      { kind: 'wait', milliseconds: 100 },
    ];

    const adapter = new PlaywrightAdapter();
    try {
      await adapter.open(server.baseUrl);
      for (const action of script) {
        const result = await adapter.execute(action);
        expect(
          result.status,
          `${action.kind} did not succeed: ${JSON.stringify(result)}`,
        ).toBe('ok');
      }
    } finally {
      await adapter.close();
    }

    // The interaction is only real if the demo server's own state moved.
    const page = await (await fetch(`${server.baseUrl}/`)).text();
    expect(page, `"${TITLE}" was never created through the browser`).toContain(`<span>${TITLE}</span>`);
  });
});
