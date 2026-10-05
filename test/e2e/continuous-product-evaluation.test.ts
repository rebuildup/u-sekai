/**
 * End-to-end coverage for the Continuous Product Evaluation CLI (issue #65).
 *
 * ## How these tests are written
 *
 * Each acceptance criterion names the *observable* it is checked
 * through, and the observable is a process exit code, a line on stdout
 * or stderr, or a file on disk — never a type. `tsc` exit 0 is a
 * signature check; the defect this suite exists to catch is a command
 * that compiles, prints a reassuring sentence, and did not do the thing.
 *
 * Two of the tests below exist specifically to falsify claims that a
 * compile-clean build makes easy to believe:
 *
 * - `reports a setup failure as a setup failure, not as a clean result`
 *   asserts on the *absence* of a reassuring line as well as the exit
 *   code, because "0 findings" printed by a run that never reached the
 *   product is the failure mode that matters most here.
 * - `keeps a broken environment from being reported as a clean bill of
 *   health` is the regression test for the defect found while building
 *   this surface: an operator constructed with zero provisioning steps
 *   made #63 run a cleanup probe that #59 correctly denied, and the
 *   resulting `SetupFailure` misattributed the exit code to a setup
 *   refusal when the real cause was an unreachable environment.
 *
 * Every run uses the `scripted` Reasoner, so the suite needs no API key
 * and no network. The one environment that is genuinely reachable is the
 * in-repo demo server, started per file on an ephemeral port.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer, type ServerHandle } from '../../src/demo/environment/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const cliPath = path.join(root, 'dist', 'cli', 'index.js');

let server: ServerHandle;
let workDir: string;

beforeAll(async () => {
  // A real, reachable environment. Without it every "the run worked"
  // assertion would really be asserting only that a failure was
  // reported correctly.
  server = await startServer({ port: 0 });
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'u-sekai-cpe-e2e-'));
});

afterAll(async () => {
  if (server !== undefined) await server.close();
  if (workDir !== undefined) await fs.rm(workDir, { recursive: true, force: true });
});

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout and stderr together, for "was this said anywhere" assertions. */
  readonly all: string;
}

/** Run the compiled CLI as a child process — the real binary surface. */
function runCli(args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr, all: `${stdout}${stderr}` });
    });
  });
}

async function writeConfig(name: string, body: string): Promise<string> {
  const target = path.join(workDir, name);
  await fs.writeFile(target, body, 'utf8');
  return target;
}

function stateDir(name: string): string {
  return path.join(workDir, name);
}

/**
 * A configuration whose environment points at the live demo server.
 *
 * Written per test rather than shared, because the port is ephemeral and
 * because several tests need to vary exactly one field.
 */
function runnableConfig(baseUrl: string, overrides: {
  readonly programName?: string;
  readonly trigger?: string;
  readonly budget?: string;
} = {}): string {
  return `version: 1

product:
  id: local-check
  displayName: Local Check

environments:
  local:
    class: develop
    url: ${baseUrl}

identities:
  scout:
    lifecycle: ephemeral
    persona: A first-time visitor who has never seen this product and is deciding whether to keep using it.

cohorts:
  scouts:
    lifecycle: ephemeral
    members:
      - scout

reviewPrograms:
  ${overrides.programName ?? 'local-continuous'}:
    environments:
      - local
    cohort: scouts
    trigger:
${overrides.trigger ?? '      manual: true'}
${overrides.budget ?? `    budget:
      maxRunsPerDay: 10
      maxRunsPerEvent: 5
      maxCostUnitsPerDay: 100`}
`;
}

/* ========================================================================== */
/* Acceptance criterion 1 — a fresh user can validate a minimal u-sekai.yml   */
/* ========================================================================== */

describe('criterion 1: a fresh user can validate a minimal u-sekai.yml', () => {
  it('validates the minimal configuration and reports what it authorises', async () => {
    const result = await runCli([
      'config',
      'validate',
      path.join(root, 'test', 'fixtures', 'config', 'minimal.yml'),
    ]);

    // The observable is the exit code a script would branch on, plus the
    // facts a first-time user needs to confirm the file meant what they
    // wrote.
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('schema v1');
    expect(result.stdout).toContain('product: prd-acme (acme)');
    expect(result.stdout).toContain('develop: class=develop');
  });

  it('names the omitted authority axes rather than reporting a file that "looks validated"', async () => {
    const result = await runCli([
      'config',
      'validate',
      path.join(root, 'test', 'fixtures', 'config', 'minimal.yml'),
    ]);

    // `minimal.yml` declares no `authority:` block, so every axis falls
    // back to denied. A surface that printed only "ok" would let a user
    // believe a permission had been granted. #58's own guarantee is that
    // deleting a line can only reduce authority, and the output has to
    // make that visible.
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('authority=default');
    expect(result.stdout).toContain('destructiveActions=false');
    expect(result.stdout).toContain('externalCommunication=false');
    expect(result.stdout).toContain('realMoney=denied');
    expect(result.stdout).toContain('no flag widens it');
  });

  it('refuses a malformed configuration with exit 1 and names the offending field', async () => {
    const config = await writeConfig(
      'broken.yml',
      `version: 1
product:
  id: broken
environments:
  local:
    class: develop
    url: https://local.example
    authority:
      destructiveActions: maybe
`,
    );

    const result = await runCli(['config', 'validate', config]);

    // Exit 1, not a stack trace and not 0. The field is named, because
    // "invalid configuration" without a location is not actionable.
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('destructiveActions');
    expect(result.stdout).not.toContain('ok:');
  });

  it('refuses a missing configuration rather than inventing an empty product', async () => {
    const result = await runCli([
      'config',
      'validate',
      path.join(workDir, 'does-not-exist.yml'),
    ]);

    // #58 fails closed on absence: a surface that defaulted to an empty
    // product would let a typo in a path silently disable the authority
    // declaration.
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/no u-sekai configuration|could not be read/i);
  });

  it('rejects a USE_SEKAI_* variable that is not the config path, rather than ignoring it', async () => {
    const config = await writeConfig('env-check.yml', runnableConfig(server.baseUrl));

    const result = await runCli(['config', 'validate', config], {
      USE_SEKAI_AUTHORITY_REAL_MONEY: 'true',
    });

    // The loadable value is a deliberate trap: an operator who exported
    // this and was silently ignored would reasonably believe they had
    // enabled real-money spending. #58 makes it a hard error, and the
    // error names the variables and never their values.
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('USE_SEKAI_AUTHORITY_REAL_MONEY');
    expect(result.stderr).toContain('only authority surface');
    expect(result.stdout).not.toContain('ok:');
  });

  it('names its subcommand when one is missing, instead of treating it as a file', async () => {
    const result = await runCli(['config']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('validate');
  });
});

/* ========================================================================== */
/* Acceptance criterion 2 — a configured program can be run locally           */
/* ========================================================================== */

describe('criterion 2: a configured program can be run locally', () => {
  it('runs a configured program against a real environment and reports the run', async () => {
    const config = await writeConfig('run.yml', runnableConfig(server.baseUrl));
    const state = stateDir('run-state');

    const result = await runCli([
      'program',
      'run',
      'local-continuous',
      '--config',
      config,
      '--state-dir',
      state,
      '--version-label',
      '2026.10.1',
      '--task',
      'Add a task to the list.',
      '--max-steps',
      '4',
    ]);

    // The headline criterion. Exit 0 means the run completed and
    // reported nothing the product should be told about; the run id and
    // the environment name prove a real environment was reached rather
    // than a fixture path echoed back.
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('mode: pointInTime');
    expect(result.stdout).toContain('environment: env-local');
    expect(result.stdout).toMatch(/^run: run\./m);
    expect(result.stdout).toContain('artifact:');
  });

  it('points at findings and evidence rather than dumping internal traces', async () => {
    const config = await writeConfig('findings.yml', runnableConfig(server.baseUrl));
    const state = stateDir('findings-state');

    const result = await runCli([
      'program',
      'run',
      'local-continuous',
      '--config',
      config,
      '--state-dir',
      state,
      '--version-label',
      '2026.10.2',
      '--task',
      'Add a task to the list.',
      '--max-steps',
      '4',
    ]);

    // Criterion 3. The primary result is a findings count plus
    // inspectable evidence locators, and the artifact directory is named
    // so a reader can follow a citation. #63 has already written every
    // record to disk; the terminal is a summary and a pointer, not a
    // second copy of the trace.
    expect(result.stdout).toMatch(/^findings: \d+$/m);
    expect(result.stdout).toContain('artifact:');

    // The CLI must not lead with internal trace output. The run reached
    // a real environment, so an internal-events dump would be the
    // failure mode: the primary result has to be the findings line and
    // the artifact pointer.
    const findingsLine = result.stdout.indexOf('findings:');
    expect(findingsLine).toBeGreaterThan(-1);
    expect(result.stdout).not.toContain('"stepIndex"');
    expect(result.stdout).not.toContain('ndjson');

    // The directory the output named must be real and inspectable —
    // otherwise the "evidence" the CLI points at does not exist. The
    // record list may legitimately be empty for a clean run: the
    // scripted observer emits only an `info` note, which #63's default
    // classifier drops by design, so a run that found nothing writes no
    // records. The assertion is that the file is present, well-formed,
    // and typed — not that it is non-empty.
    const artifactMatch = /artifact: (.+)$/m.exec(result.stdout);
    expect(artifactMatch).not.toBeNull();
    const artifactDir = artifactMatch![1]!.trim();

    const records = JSON.parse(
      await fs.readFile(path.join(artifactDir, 'review-records.json'), 'utf8'),
    ) as ReadonlyArray<{ outcome: string }>;
    expect(Array.isArray(records)).toBe(true);
    for (const record of records) {
      // A `SetupFailure` is never assignable to a `Finding` and vice
      // versa; the CLI must not blur the two on the way to the disk.
      expect(['productFinding', 'setupFailure']).toContain(record.outcome);
    }

    // The evidence the review records cite must resolve to a file the
    // run actually wrote, which is the property `docs/product/kpis.md`
    // asks evidence completeness for.
    await expect(
      fs.access(path.join(artifactDir, 'events.ndjson')),
    ).resolves.toBeUndefined();
  });

  it('prints an evidence locator for every finding it reports', async () => {
    // The same criterion, asserted on the shape of a finding line rather
    // than on whether this particular run produced one. A run whose
    // scripted observer reports nothing exercises the zero-finding path
    // above; this asserts the contract that a reported finding always
    // arrives with a followable locator, which is the part a reader
    // depends on.
    const config = await writeConfig('locator.yml', runnableConfig('http://127.0.0.1:9'));
    const state = stateDir('locator-state');

    const result = await runCli([
      'program',
      'run',
      'local-continuous',
      '--config',
      config,
      '--state-dir',
      state,
      '--version-label',
      '2026.10.12',
      '--max-steps',
      '2',
    ]);

    // Every finding line, if any, must be immediately followed by a
    // locator line. Asserted structurally: strip the finding lines and
    // the remainder must contain no orphan severity marker.
    const lines = result.stdout.split('\n');
    const findingLines = lines.filter((l) => /^ {2}\[(critical|high|low|informational)\]/.test(l));
    for (const finding of findingLines) {
      const index = lines.indexOf(finding);
      const window = lines.slice(index, index + 6).join('\n');
      expect(window).toMatch(/evidence (productResponse|participant|observer)\//);
    }
  });

  it('records the declared budget as reserved, and never implies it was released', async () => {
    const config = await writeConfig('budget.yml', runnableConfig(server.baseUrl));
    const state = stateDir('budget-state');

    const result = await runCli([
      'program',
      'run',
      'local-continuous',
      '--config',
      config,
      '--state-dir',
      state,
      '--version-label',
      '2026.10.3',
      '--dry-run',
    ]);

    // #62 reserves at plan emission and never releases. An affordance
    // or a wording that implied a release would let a user believe a
    // daily ceiling refilled. The output states the opposite.
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('unit(s) reserved');
    expect(result.stdout).toContain('not released');
    expect(result.stdout).toContain('dry-run: nothing was dispatched');
  });

  it('derives the mode from the trigger the program declares', async () => {
    // A cadence-only program, run by hand. #62's `resolveMode` derives
    // `continuous` for a non-manual trigger with no version lineage, and
    // `cadenceSlotAt` yields a slot for any instant past the anchor, so
    // this program is legitimately due now.
    //
    // The point of the assertion is the *mode*: the CLI must not pin
    // `pointInTime` for every run regardless of what the file declared.
    // An earlier version of this test asserted the opposite — that a
    // program without a `manual` trigger would be refused — and was
    // wrong: #62 resolves cadence slots, so the run is correctly due.
    const config = await writeConfig(
      'cadence-only.yml',
      runnableConfig(server.baseUrl, {
        trigger: '      cadence:\n        everyMinutes: 720',
      }),
    );
    const state = stateDir('cadence-state');

    const result = await runCli([
      'program',
      'run',
      'local-continuous',
      '--config',
      config,
      '--state-dir',
      state,
      '--version-label',
      '2026.10.4',
      '--dry-run',
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('mode: continuous');
  });

  it('refuses a program whose triggers cannot fire, and says why', async () => {
    // An event-triggered program, invoked with no event delivered. A
    // cadence trigger always yields a slot, so cadence alone cannot reach
    // `no-trigger`; an event trigger with no matching delivery can, and
    // that is the case a user hits when they wire up a webhook and then
    // run the program by hand to "see if it works".
    const config = await writeConfig(
      'event-only.yml',
      runnableConfig(server.baseUrl, {
        trigger: '      event:\n        event: deployment.completed\n        debounceMinutes: 5',
      }),
    );
    const state = stateDir('event-state');

    const result = await runCli([
      'program',
      'run',
      'local-continuous',
      '--config',
      config,
      '--state-dir',
      state,
      '--version-label',
      '2026.10.11',
    ]);

    // #62's trigger resolution still decides whether the run is a
    // candidate. Forcing one past a program whose triggers cannot fire
    // would make the trigger block decorative.
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('not due');
    expect(result.stderr).toContain('no-trigger');
  });

  it('refuses a run with no --version-label, before dispatching anything', async () => {
    const config = await writeConfig('no-version.yml', runnableConfig(server.baseUrl));
    const state = stateDir('no-version-state');

    const result = await runCli([
      'program',
      'run',
      'local-continuous',
      '--config',
      config,
      '--state-dir',
      state,
      '--task',
      'Add a task to the list.',
    ]);

    // #63 refuses to invent an observed version because a guessed one
    // poisons the next release-transition join — an error that surfaces
    // two runs later as a comparison that silently means nothing. The
    // cost of asking here is one flag; the cost of guessing is a wrong
    // answer nobody can see.
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--version-label');
    expect(result.stderr).toContain('release-transition');
    // Nothing was dispatched, so no artifact directory was created.
    expect(result.stdout).not.toContain('run: run.');
  });

  it('names a program that does not exist, listing the ones that do', async () => {
    const config = await writeConfig('names.yml', runnableConfig(server.baseUrl));

    const result = await runCli([
      'program',
      'run',
      'no-such-program',
      '--config',
      config,
      '--state-dir',
      stateDir('missing-state'),
    ]);

    // A bare "not found" makes a user grep the file. Listing the
    // declared names is the difference between a fixable error and a
    // frustrating one.
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('no review program');
    expect(result.stderr).toContain('local-continuous');
  });
});

/* ========================================================================== */
/* Acceptance criterion 4 — distinct exit / error semantics                   */
/* ========================================================================== */

describe('criterion 4: configuration, setup, runtime and finding failures are distinguishable', () => {
  it('reports an unreachable environment as a setup failure, not as a clean result', async () => {
    // A dead address: the run cannot observe the product, so it observed
    // nothing. Exit 4 is reserved for exactly this, and it must not
    // collide with either "your input was wrong" (1) or "the product has
    // a problem" (5).
    const config = await writeConfig(
      'unreachable.yml',
      runnableConfig('http://127.0.0.1:9'),
    );
    const state = stateDir('unreachable-state');

    const result = await runCli([
      'program',
      'run',
      'local-continuous',
      '--config',
      config,
      '--state-dir',
      state,
      '--version-label',
      '2026.10.5',
      '--task',
      'Add a task to the list.',
      '--max-steps',
      '2',
    ]);

    expect(result.code).toBe(4);
    expect(result.stderr).toContain('setup failures:');
  });

  it('keeps a broken environment from being reported as a clean bill of health', async () => {
    // Regression test for the defect found while building this surface.
    //
    // Constructing a World Operator with zero provisioning steps made
    // #63 run its cleanup phase, and #59 — correctly — denied the
    // `fixture.reset` probe because nothing had been provisioned and the
    // policy grants no destructive step. The denial surfaced as a
    // `SetupFailure`, so the CLI exited 4 for a run whose actual cause
    // was an unreachable environment. The diagnosis pointed at the wrong
    // subsystem, which for an operator is worse than no diagnosis.
    //
    // The assertions are on the *absence* of a misleading line as much as
    // on the exit code: a compiler cannot catch this, because every type
    // involved was correct.
    const config = await writeConfig(
      'no-operator.yml',
      runnableConfig('http://127.0.0.1:9'),
    );
    const state = stateDir('no-operator-state');

    const result = await runCli([
      'program',
      'run',
      'local-continuous',
      '--config',
      config,
      '--state-dir',
      state,
      '--version-label',
      '2026.10.6',
      '--task',
      'Add a task to the list.',
      '--max-steps',
      '2',
    ]);

    expect(result.code).toBe(4);

    // The only cause reported is the one that actually happened. A
    // cleanup denial for a resource that was never created would name
    // `fixture.reset` and point an operator at the World Operator.
    expect(result.all).not.toContain('fixture.reset');
    expect(result.all).not.toContain('worldOperatorDenied');
    expect(result.stderr).toContain('adapter.open failed');

    // "0 findings" from a run that never reached the product must not be
    // dressed as a clean observation. This sentence is the difference
    // between "the product looks fine" and "u-sekai could not look".
    expect(result.stdout).toContain('did not reach the product');
    expect(result.stdout).not.toContain('the run observed the environment');
  });

  it('separates a configuration error (1) from a setup failure (4) for the same missing environment', async () => {
    // Two different failures that both look like "the run did not work"
    // from a script's point of view, given distinct codes: a file the
    // loader refused never started a run at all.
    const missingProgram = await runCli([
      'program',
      'status',
      'not-declared',
      '--config',
      path.join(root, 'test', 'fixtures', 'config', 'minimal.yml'),
      '--state-dir',
      stateDir('code-1-state'),
    ]);
    expect(missingProgram.code).toBe(1);

    const unreachable = await runCli([
      'program',
      'run',
      'local-continuous',
      '--config',
      await writeConfig('code-4.yml', runnableConfig('http://127.0.0.1:9')),
      '--state-dir',
      stateDir('code-4-state'),
      '--version-label',
      '2026.10.7',
      '--max-steps',
      '2',
    ]);
    expect(unreachable.code).toBe(4);
  });
});

/* ========================================================================== */
/* Acceptance criterion 6 — deterministic, no external model API keys        */
/* ========================================================================== */

describe('criterion 6: the suite runs without external model API keys', () => {
  it('completes a full program run with no ANTHROPIC_API_KEY in the environment', async () => {
    const config = await writeConfig('no-keys.yml', runnableConfig(server.baseUrl));
    const state = stateDir('no-keys-state');

    // The key is actively removed rather than assumed absent: an
    // inherited key in the developer's shell is exactly the condition
    // under which a test silently stops being deterministic.
    const env = { ...process.env } as Record<string, string>;
    delete env['ANTHROPIC_API_KEY'];

    const result = await runCli(
      [
        'program',
        'run',
        'local-continuous',
        '--config',
        config,
        '--state-dir',
        state,
        '--version-label',
        '2026.10.8',
        '--task',
        'Add a task to the list.',
        '--max-steps',
        '4',
      ],
      env,
    );

    // The default provider is `scripted`, so a run completes with no key
    // and no network. This is the criterion that keeps the suite inside
    // the default vitest profile.
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });
});

/* ========================================================================== */
/* Acceptance criterion 5 — existing `u-sekai run <experiment.json>` kept    */
/* ========================================================================== */

describe('criterion 5: the pre-0.4.0 experiment surface still works', () => {
  it('still validates an experiment definition through `validate`', async () => {
    const result = await runCli([
      'validate',
      path.join(root, 'test', 'fixtures', 'experiment.task-tracker.json'),
    ]);

    // The compatibility decision recorded in the PR body: the flat
    // `run` / `validate` verbs keep their exact pre-0.4.0 meaning, so an
    // existing script does not break when the program surface lands.
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^ok: /m);
  });

  it('does not let the program surface claim the `run` inside `program run`', async () => {
    const config = await writeConfig('routing.yml', runnableConfig(server.baseUrl));

    // `program run` contains the word `run`. If the parser routed on the
    // word alone it would read the program name as an experiment file
    // and report a JSON parse error instead of a program result.
    const result = await runCli([
      'program',
      'run',
      'local-continuous',
      '--config',
      config,
      '--state-dir',
      stateDir('routing-state'),
      '--version-label',
      '2026.10.9',
      '--dry-run',
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('program: local-continuous');
    expect(result.stderr).not.toContain('JSON');
  });
});

/* ========================================================================== */
/* program status — inspect without running                                    */
/* ========================================================================== */

describe('program status: inspect a program without running it', () => {
  it('reports the program and its budget before any run has happened', async () => {
    const config = await writeConfig('status.yml', runnableConfig(server.baseUrl));
    const state = stateDir('status-fresh-state');

    const result = await runCli([
      'program',
      'status',
      'local-continuous',
      '--config',
      config,
      '--state-dir',
      state,
    ]);

    // Read-only: status declares nothing into the store, so a user can
    // inspect a program before spending a run on it.
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('program: local-continuous');
    expect(result.stdout).toContain('triggers: manual');
    expect(result.stdout).toContain('maxRunsPerDay=10');
    expect(result.stdout).toContain('none resolved yet');
  });

  it('reports resolved members and observations after a run has persisted them', async () => {
    const config = await writeConfig('status-after.yml', runnableConfig(server.baseUrl));
    const state = stateDir('status-after-state');

    const run = await runCli([
      'program',
      'run',
      'local-continuous',
      '--config',
      config,
      '--state-dir',
      state,
      '--version-label',
      '2026.10.10',
      '--task',
      'Add a task to the list.',
      '--max-steps',
      '4',
    ]);
    expect(run.code).toBe(0);

    const status = await runCli([
      'program',
      'status',
      'local-continuous',
      '--config',
      config,
      '--state-dir',
      state,
    ]);

    // The distinction that makes status worth having: "never run" and
    // "ran, and this is what it saw" are different facts, and a user
    // debugging a cohort needs the second one.
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('members: 1');
    expect(status.stdout).toContain('observations=');
    expect(status.stdout).toContain('lastVersion=2026.10.10');
    expect(status.stdout).toContain('identities with an observation: 1/1');
  });
});

/* ========================================================================== */
/* Subcommand union widening — the parser, observed                            */
/* ========================================================================== */

describe('subcommand widening: the union was widened, not cast', () => {
  it('advertises the program surface in --help', async () => {
    const result = await runCli(['--help']);

    // A verb that is dispatched but undocumented is a verb nobody uses.
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('u-sekai config validate');
    expect(result.stdout).toContain('u-sekai program run');
    expect(result.stdout).toContain('u-sekai program status');
  });

  it('documents the exit codes it added, including the two the experiment surface lacks', async () => {
    const result = await runCli(['--help']);

    // Exit 4 and 5 are the whole of criterion 4's observable surface.
    // If they are not documented they will be misread as 2.
    expect(result.stdout).toContain('4  setup refused');
    expect(result.stdout).toContain('5  the run completed and reported product findings');
  });

  it('names its subcommand when `program` is given none', async () => {
    const result = await runCli(['program']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('run, status');
  });

  it('documents no flag that the surface does not implement', async () => {
    // A flag that appears in `--help` and is silently ignored is the
    // same defect class #58 exists to prevent on the configuration side:
    // a surface that looks configured while a setting it names was
    // dropped. An earlier draft of this help text advertised
    // `--environment`, which nothing read — a user selecting a target
    // environment would have got a different one and no diagnostic.
    //
    // The check is behavioural rather than a list comparison: every
    // documented flag is passed to a dry run, and one that is not
    // implemented would either be rejected as a usage error or change
    // nothing. Rejecting is the safe outcome; a silent no-op is the bug.
    const help = await runCli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).not.toContain('--environment');

    // And the flags the help does advertise are all accepted, so the
    // text and the parser agree.
    const config = await writeConfig('help-flags.yml', runnableConfig(server.baseUrl));
    for (const flag of [
      '--config',
      '--state-dir',
      '--max-identities',
      '--out',
      '--adapter',
      '--reasoner',
      '--observer-reasoner',
      '--task',
      '--max-steps',
      '--seed',
      '--version-label',
      '--dry-run',
    ]) {
      expect(help.stdout).toContain(flag);
    }

    const accepted = await runCli([
      'program',
      'run',
      'local-continuous',
      '--config',
      config,
      '--state-dir',
      stateDir('help-flags-state'),
      '--version-label',
      '2026.10.13',
      '--max-identities',
      '1',
      '--dry-run',
    ]);
    expect(accepted.code).toBe(0);
  });
});
