import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Browser-backed test profile.
 *
 * Kept separate from `vitest.config.ts` on purpose: the default profile
 * is the deterministic HTTP-only path that `ci.yml` runs, and it must
 * stay runnable on a machine with no browser binaries installed. The
 * browser path is a separate, slower, explicitly-invoked gate
 * (`.github/workflows/browser-smoke.yml`, `npm run test:browser`).
 *
 * A test that silently skips when the browser is missing would be a
 * false green, so nothing here is conditional: `support/browser-runtime.ts`
 * turns a missing runtime into a loud, actionable failure.
 */
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/+$/, '');

export default defineConfig({
  root,
  test: {
    include: [
      'test/browser/**/*.test.ts',
      // Issue #70: the #67 acceptance scenario lives under
      // `test/e2e/service-acceptance/**`, which the default profile sweeps
      // with `test/e2e/**/*.test.ts`. The scenario is browser-backed, so it
      // is routed here by a browser-only file suffix instead of by a
      // `*.test.ts` glob: a `*.test.ts` glob here would put the scenario
      // in *both* profiles and make `npm run ci` require Chromium, which is
      // exactly the defect class Issue #90 exists to undo. With the suffix,
      // the default profile cannot reach the scenario at all.
      // `routing/**` is the deliberate exception in the other direction: the
      // guard that pins this routing is itself an HTTP-free default-profile
      // test, so it keeps the plain `.test.ts` suffix and is not matched here.
      'test/e2e/service-acceptance/**/*.browser-acceptance.ts',
    ],
    // Fails once, loudly, if the browser runtime is missing or cannot be
    // launched. Never skips.
    globalSetup: ['test/browser/support/global-setup.ts'],
    environment: 'node',
    // Browser launch is slow on cold CI runners; the suite is a gate,
    // not a latency budget.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // One browser-backed file at a time: several Chromium instances in
    // parallel make CI logs and timings unpredictable for no real gain.
    fileParallelism: false,
    sequence: { shuffle: false },
  },
});
