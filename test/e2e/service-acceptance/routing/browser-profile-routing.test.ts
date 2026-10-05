/**
 * Machine-checked guard for the Issue #70 routing decision.
 *
 * Issue #70's finding was that the capability for a browser-backed #67
 * acceptance scenario already existed (`test/browser/support/demo.ts`) and
 * only the routing was missing. Routing is configuration, and configuration
 * is exactly the kind of thing that silently drifts back, so it is asserted
 * here rather than trusted:
 *
 * 1. the acceptance scenario is reachable from the browser profile;
 * 2. it is *not* reachable from the default profile, so `npm run ci` can
 *    never start requiring Chromium (the defect class of Issue #90);
 * 3. the guard subtree that makes those assertions stays in the default
 *    profile, where `npm run ci` will actually run it.
 *
 * This file is deliberately HTTP-free and deliberately placed in
 * `routing/`, the one acceptance-directory subtree the default profile
 * claims. It must not launch a browser and must not import Playwright.
 */

import { describe, it, expect } from 'vitest';
import {
  ACCEPTANCE_DIR,
  DEFAULT_E2E_GLOB,
  ROUTING_SUBDIR,
  SCENARIO_GLOB,
  BROWSER_SUITE_GLOB,
  acceptanceClaims,
  browserInclude,
  browserRoot,
  defaultProfileSource,
  isCollectable,
  matchesGlob,
  repoRoot,
} from './profile-include.js';

const SCENARIO = `${ACCEPTANCE_DIR}/route-probe.browser-acceptance.ts`;

describe('#70 acceptance-scenario routing', () => {
  it('resolves the browser profile globs against the repository root', () => {
    // The claims below are only meaningful if the globs are compared on
    // the same base the profile itself uses.
    expect(browserRoot).toBe(repoRoot);
  });

  it('routes the acceptance scenario into the browser profile', () => {
    expect(
      browserInclude,
      `${SCENARIO_GLOB} is missing from test/vitest.browser.config.ts; the #67 acceptance ` +
        'scenario would never reach a browser again.',
    ).toContain(SCENARIO_GLOB);
    expect(
      matchesGlob(SCENARIO_GLOB, SCENARIO),
      `${SCENARIO_GLOB} does not match a scenario file directly under ${ACCEPTANCE_DIR}.`,
    ).toBe(true);
    // The pre-existing browser suite must still be routed; this change
    // adds a route, it does not replace one.
    expect(browserInclude).toContain(BROWSER_SUITE_GLOB);
  });

  it('keeps the default profile unable to reach a browser-backed scenario', () => {
    // The guard reasons about the default profile's e2e sweep. Pin the
    // exact entry, so a change to it goes red here instead of silently
    // invalidating every claim below.
    expect(
      defaultProfileSource,
      `vitest.config.ts no longer contains ${DEFAULT_E2E_GLOB}; this guard reasons about ` +
        'that sweep and has to be updated alongside it.',
    ).toContain(`'${DEFAULT_E2E_GLOB}'`);

    expect(
      matchesGlob(DEFAULT_E2E_GLOB, SCENARIO),
      'the default profile can execute the browser-backed scenario; npm run ci would then ' +
        'require Chromium (Issue #90).',
    ).toBe(false);

    // Belt and braces: whatever the sweep looks like, the default profile
    // must not name the acceptance directory at all.
    expect(
      defaultProfileSource,
      `vitest.config.ts names ${ACCEPTANCE_DIR}; the default profile must not know about the ` +
        'acceptance directory, or `npm run ci` can start requiring a browser.',
    ).not.toContain(ACCEPTANCE_DIR);
  });

  it('partitions the acceptance directory between the two profiles', () => {
    const claims = acceptanceClaims();
    expect(
      claims.length,
      `${ACCEPTANCE_DIR} contains no .ts files, so nothing is being routed at all`,
    ).toBeGreaterThan(0);

    for (const claim of claims) {
      const where = `${claim.file} (default=${claim.defaultProfile}, browser=${claim.browserProfile})`;

      if (claim.defaultProfile) {
        expect(
          claim.file.startsWith(`${ROUTING_SUBDIR}/`),
          `${where} is executed by the default profile but is not under ${ROUTING_SUBDIR}. ` +
            'A scenario file written with the plain `.test.ts` suffix is a browser-backed test ' +
            'that `npm run ci` would try to run without a browser. Use the ' +
            `\`${SCENARIO_GLOB}\` suffix instead.`,
        ).toBe(true);
      }

      if (claim.browserProfile) {
        expect(
          !claim.file.startsWith(`${ROUTING_SUBDIR}/`),
          `${where} is executed by the browser profile, but ${ROUTING_SUBDIR} is the ` +
            'default-profile guard subtree and must stay HTTP-free and browser-free.',
        ).toBe(true);
      }

      if (isCollectable(claim.file)) {
        expect(
          claim.defaultProfile !== claim.browserProfile,
          `${where} is executed by ${claim.defaultProfile ? 'both' : 'neither'} profile; ` +
            'every acceptance test file must belong to exactly one.',
        ).toBe(true);
      }
    }
  });

  it('runs the routing guard itself in the default profile', () => {
    // If this stops being true the guard silently stops guarding: the
    // default profile is the one `npm run ci` runs.
    const guard = `${ROUTING_SUBDIR}/browser-profile-routing.test.ts`;
    expect(
      matchesGlob(DEFAULT_E2E_GLOB, guard),
      `${guard} is no longer claimed by the default profile, so npm run ci would stop ` +
        'checking the #70 routing at all.',
    ).toBe(true);
  });
});
