/**
 * Browser runtime preflight for the browser-backed test profile.
 *
 * A missing browser must never turn into a skipped (green) test. This
 * helper resolves the browser executable, launches it, and reports the
 * version — or throws a message that says exactly what to run.
 */

import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

export interface BrowserRuntime {
  readonly executablePath: string;
  readonly version: string;
}

const REMEDY = [
  'u-sekai: the Chromium runtime required by the browser path is not usable.',
  'Fix it with:',
  '  npx playwright install chromium            # browser binaries only',
  '  npx playwright install --with-deps chromium  # binaries + Linux system libraries (needs sudo)',
  'If PLAYWRIGHT_BROWSERS_PATH is set, install into that same location.',
  'See docs/browser-runtime.md for a rootless (no sudo) alternative.',
].join('\n');

export async function assertBrowserRuntimeAvailable(): Promise<BrowserRuntime> {
  const executablePath = chromium.executablePath();
  if (!existsSync(executablePath)) {
    throw new Error(
      `${REMEDY}\nreason: no browser binary at ${executablePath} ` +
        `(PLAYWRIGHT_BROWSERS_PATH=${process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? '<default>'})`,
    );
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${REMEDY}\nreason: ${executablePath} is present but failed to launch: ${detail}\n` +
        'A missing shared library here means the system packages are missing; ' +
        'use `npx playwright install --with-deps chromium`.',
    );
  }
  try {
    return { executablePath, version: browser.version() };
  } finally {
    await browser.close();
  }
}
