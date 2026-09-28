/**
 * One-time preflight for the browser test profile.
 *
 * Runs before any test file, so an unusable browser runtime produces a
 * single loud failure with install instructions instead of the same
 * error repeated per file. A missing browser is never converted into a
 * skipped test: a skip would be a green that claims coverage the run
 * does not have.
 */

import { assertBrowserRuntimeAvailable } from './browser-runtime.js';

export async function setup(): Promise<void> {
  const runtime = await assertBrowserRuntimeAvailable();
  // Printed so a green run is attributable to a concrete browser build.
  console.info(
    `[browser-smoke] chromium ${runtime.version} at ${runtime.executablePath}`,
  );
}
