/**
 * The documented 0.4.0 example (Issue #67).
 *
 * Run it from a fresh clone:
 *
 * ```bash
 * npm ci
 * npx playwright install chromium
 * node --import tsx examples/continuous-product-evaluation/run-acceptance.ts
 * ```
 *
 * ## Why this command delegates instead of running the scenario itself
 *
 * The scenario drives a real Chromium through `PlaywrightAdapter`, which
 * reads the page with `page.evaluate`. `tsx` transpiles with esbuild's
 * `keepNames: true` — hard-coded, with no opt-out — which rewrites every
 * named function to call an injected `__name` helper. `page.evaluate`
 * serialises the function *source* into the page, where `__name` does not
 * exist, so the very first observation fails with
 * `ReferenceError: __name is not defined`. Running this file under `tsx`
 * and calling the scenario in-process therefore cannot work, and
 * documenting it as if it could would be documenting a command nobody ran.
 *
 * Vite's transform (what Vitest uses) does not inject `__name`, so the
 * browser-backed path runs there. This entry point therefore *delegates*
 * to the browser profile and relays its result, rather than pretending to
 * be a second implementation. `U_SEKAI_ACCEPTANCE_REPORT=1` makes the
 * acceptance test print the same report this file's `summarise` builds, so
 * the command below produces the documented output.
 *
 * The same workaround is a real constraint on this release, not a quirk
 * of this example: **any** Node-hosted TypeScript runner that applies
 * esbuild `keepNames` cannot drive `PlaywrightAdapter` in 0.4.0.
 *
 * ## This file is a shell, not a second implementation
 *
 * The orchestration lives in `test/fixtures/service-acceptance/scenario.ts`
 * and the browser-backed test drives that same function, so "the example
 * runs" and "the acceptance scenario passes" are the same claim. An
 * example that reimplemented the scenario would make the first acceptance
 * criterion of Issue #67 unfalsifiable: the test could be green while the
 * documented command did something else entirely.
 *
 * No environment variable is read and no external API key is required.
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AcceptanceReport } from '../../test/fixtures/service-acceptance/scenario.js';

export type { AcceptanceReport };

/** Set by this entry point so the acceptance test prints the report. */
export const REPORT_ENV_VAR = 'U_SEKAI_ACCEPTANCE_REPORT';

/** The file the browser profile runs, relative to the repository root. */
export const SCENARIO_SPEC = 'test/e2e/service-acceptance/persistent-cohort-release.browser-acceptance.ts';

/** The browser profile, relative to the repository root. */
export const BROWSER_PROFILE_CONFIG = 'test/vitest.browser.config.ts';

export interface AcceptanceExampleOutput {
  readonly stages: ReadonlyArray<{
    readonly stage: string;
    readonly observed: string;
  }>;
  readonly findings: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly change: string;
  }>;
  readonly unmetExpectations: ReadonlyArray<string>;
}

/**
 * Turn the scenario's report into a printable summary and an explicit
 * list of anything that fell short.
 *
 * Every expectation here is something the scenario claims; each one that
 * fails becomes a line in `unmetExpectations` and a non-zero exit code,
 * so a stage that silently produced nothing cannot exit `0`.
 */
export function summarise(report: AcceptanceReport): AcceptanceExampleOutput {
  const stages: { stage: string; observed: string }[] = [];
  const unmet: string[] = [];

  const expect_ = (stage: string, condition: boolean, observed: string): void => {
    stages.push({ stage, observed });
    if (!condition) unmet.push(stage);
  };

  const { isolation, mixed, baseline, promotion, comparison } = report;

  expect_(
    'two live instances of one declared environment',
    isolation.keysDiffer &&
      isolation.declaredNames[0] === isolation.declaredNames[1] &&
      isolation.declaredVersions[0] !== isolation.declaredVersions[1],
    `${isolation.declaredNames[0]} at ${isolation.declaredVersions[0]}, ${isolation.declaredNames[1]} at ${isolation.declaredVersions[1]}`,
  );

  expect_(
    'one cohort holding an ephemeral and a persistent identity',
    mixed.run.resolvedCohort.lifecycles.join(',') === 'ephemeral,persistent',
    `lifecycles: ${mixed.run.resolvedCohort.lifecycles.join(', ')}`,
  );

  expect_(
    'only the persistent identity retained state',
    mixed.ephemeralState.retainedState === undefined &&
      mixed.persistentState.retainedState !== undefined,
    `persistent interactions: ${String(mixed.persistentState.retainedState?.interactionCount ?? 0)}; ephemeral retained state: none`,
  );

  expect_(
    'accounts provisioned through the World Operator and released at cleanup',
    baseline.run.setup.status === 'provisioned' && baseline.run.cleanup?.status === 'cleaned',
    `setup=${baseline.run.setup.status}, cleanup=${String(baseline.run.cleanup?.status)}`,
  );

  expect_(
    'the cohort created a task in version A, through a real browser',
    baseline.world.titles.length > 0,
    `version A lists ${baseline.world.titles.length} task(s)`,
  );

  expect_(
    'the A -> B promotion committed durably and moved the pointer',
    promotion.applied &&
      promotion.reread.status === 'committed' &&
      promotion.reapplyApplied === false,
    `pointer now on version ${promotion.activeVersionAfter}; re-applying is a no-op`,
  );

  expect_(
    'the earlier version survived the promotion',
    promotion.worldAUnchangedByPromotion.titles.length > 0 &&
      promotion.worldAUnchangedByPromotion.titles.join('|') === baseline.world.titles.join('|'),
    `version A still lists ${promotion.worldAUnchangedByPromotion.titles.length} task(s)`,
  );

  // Two independent checks, because "the newer world is not the older
  // world" has failed in two different ways in practice: a leaked
  // reference would carry the older world's task *into* the newer one,
  // and an over-eager promotion would have overwritten the older one.
  const versionATasks = baseline.world.titles;
  const versionBTasks = comparison.worldB.titles;
  expect_(
    'the two environments share no mutable state',
    versionBTasks.length > 0 &&
      versionBTasks.every((t) => !versionATasks.includes(t)) &&
      comparison.worldAAfter.titles.join('|') === versionATasks.join('|'),
    `version A lists [${versionATasks.join(', ')}], version B lists [${versionBTasks.join(', ')}]`,
  );

  expect_(
    'the same Synthetic Identity spans both versions',
    comparison.stateAfterB.identity.id === baseline.stateAfterA.identity.id &&
      comparison.stateAfterB.observations.length === 2,
    `${comparison.stateAfterB.identity.id} observed ${comparison.stateAfterB.observations
      .map((o) => o.version)
      .join(' then ')}`,
  );

  expect_(
    'the comparison run produced an evidence-backed longitudinal finding',
    comparison.findings.length > 0,
    `${comparison.findings.length} finding(s)`,
  );
  if (comparison.findings.length === 0) {
    unmet.push('at least one evidence-backed finding');
  }

  return {
    stages,
    findings: comparison.findings.map((f) => ({
      id: f.id,
      title: f.title,
      change: f.longitudinal.change,
    })),
    unmetExpectations: unmet,
  };
}

/** The human-readable report, as the documented command prints it. */
export function renderReport(output: AcceptanceExampleOutput): string {
  const lines: string[] = [];
  lines.push('u-sekai 0.4.0 acceptance example - Continuous Product Evaluation');
  lines.push('');
  lines.push(
    'Simulated, not human. See docs/non-reality.md and ' +
      'examples/continuous-product-evaluation/README.md.',
  );
  lines.push('');
  for (const entry of output.stages) {
    lines.push(`  [ok]   ${entry.stage}`);
    lines.push(`         ${entry.observed}`);
  }
  lines.push('');
  lines.push('Findings:');
  if (output.findings.length === 0) {
    lines.push('  (none - the run observed nothing reportable)');
  }
  for (const finding of output.findings) {
    lines.push(`  - ${finding.id} [${finding.change}] ${finding.title}`);
  }
  if (output.unmetExpectations.length > 0) {
    lines.push('');
    lines.push(`Unmet expectations (${output.unmetExpectations.length}):`);
    for (const entry of output.unmetExpectations) {
      lines.push(`  ! ${entry}`);
    }
  }
  lines.push('');
  lines.push(
    'Next: record a customer disposition for a finding and re-run ' +
      'computeKpiSnapshot over the ledger. The acceptance test does exactly that.',
  );
  return lines.join('\n');
}

const repoRoot = path
  .resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  .replace(/[/\\]+$/, '');

/**
 * Entry point. Returns the process exit code rather than calling
 * `process.exit`, so the same function is testable and runnable.
 */
export function main(): number {
  // The browser profile runs the scenario; this process relays its
  // result. `stdio: 'inherit'` so the report and any failure reach the
  // terminal unchanged rather than through a second, lossy format.
  const child = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      '--config',
      BROWSER_PROFILE_CONFIG,
      SCENARIO_SPEC,
    ],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, [REPORT_ENV_VAR]: '1' },
    },
  );

  if (child.error !== undefined) {
    process.stderr.write(
      `could not start the browser profile: ${child.error.message}\n` +
        'Is the checkout complete? Run `npm ci` first.\n',
    );
    return 1;
  }
  if (child.signal !== null) {
    process.stderr.write(`the browser profile was terminated by ${child.signal}\n`);
    return 1;
  }
  return child.status ?? 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith('run-acceptance.ts');

if (invokedDirectly) {
  process.exitCode = main();
}
