/**
 * Negative controls for the matcher the routing guard is built on.
 *
 * A guard that cannot distinguish "covered" from "not covered" reports a
 * green for routing it never checked, which is the same false green as a
 * skipped browser test. These cases pin the two directions: the exact
 * patterns the profiles use must match the files they are supposed to
 * claim, and must not match the files that must stay out.
 */

import { describe, it, expect } from 'vitest';
import {
  matchesGlob,
  DEFAULT_E2E_GLOB,
  SCENARIO_GLOB,
  BROWSER_SUITE_GLOB,
} from './profile-include.js';

const DEFAULT_UNIT_GLOB = 'test/unit/**/*.test.ts';

const SCENARIO = 'test/e2e/service-acceptance/route-probe.browser-acceptance.ts';
const GUARD = 'test/e2e/service-acceptance/routing/browser-profile-routing.test.ts';
const BROWSER_TEST = 'test/browser/playwright-adapter.test.ts';

describe('profile include matcher', () => {
  it('matches the files each profile is supposed to claim', () => {
    expect(matchesGlob(DEFAULT_UNIT_GLOB, 'test/unit/recorder.test.ts')).toBe(true);
    expect(matchesGlob(DEFAULT_UNIT_GLOB, 'test/unit/nested/deep/recorder.test.ts')).toBe(true);
    expect(matchesGlob(DEFAULT_E2E_GLOB, GUARD)).toBe(true);
    expect(matchesGlob(BROWSER_SUITE_GLOB, BROWSER_TEST)).toBe(true);
    expect(matchesGlob(SCENARIO_GLOB, SCENARIO)).toBe(true);
    expect(matchesGlob(SCENARIO_GLOB, 'test/e2e/service-acceptance/route-probe.browser-acceptance.ts')).toBe(
      true,
    );
    expect(matchesGlob(SCENARIO_GLOB, 'test/e2e/service-acceptance/nested/second.browser-acceptance.ts')).toBe(
      true,
    );
  });

  it('does not match the files that must stay out', () => {
    // The whole point of the browser-only suffix: the default profile's
    // e2e sweep must not reach a browser-backed scenario.
    expect(matchesGlob(DEFAULT_E2E_GLOB, SCENARIO)).toBe(false);
    expect(matchesGlob(DEFAULT_UNIT_GLOB, SCENARIO)).toBe(false);
    // The browser profile must not reach the default-profile guard.
    expect(matchesGlob(SCENARIO_GLOB, GUARD)).toBe(false);
    expect(matchesGlob(BROWSER_SUITE_GLOB, BROWSER_TEST.replace('test/browser/', 'test/e2e/'))).toBe(false);
    // Near-miss suffixes are not silently accepted.
    expect(matchesGlob(SCENARIO_GLOB, 'test/e2e/service-acceptance/route-probe.test.ts')).toBe(false);
    expect(matchesGlob(DEFAULT_E2E_GLOB, 'test/e2e/service-acceptance/route-probe.browser-acceptance.ts.bak')).toBe(
      false,
    );
  });

  it('refuses glob syntax it does not implement instead of guessing', () => {
    expect(() => matchesGlob('test/{unit,browser}/**/*.test.ts', 'test/unit/recorder.test.ts')).toThrow(
      /unsupported glob syntax/,
    );
  });
});
