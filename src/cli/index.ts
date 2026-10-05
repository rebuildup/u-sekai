/**
 * u-sekai CLI. Minimal, deterministic, dependency-free.
 *
 *   u-sekai run <experiment.json> [--adapter http|playwright] [--out <dir>] [--demo-server-port N]
 *   u-sekai validate <experiment.json>
 *   u-sekai config validate [u-sekai.yml]
 *   u-sekai program run <program-id> [--config u-sekai.yml] [flags]
 *   u-sekai program status <program-id> [--config u-sekai.yml]
 *   u-sekai --version
 *   u-sekai --help
 *
 * Two surfaces live here, and they are deliberately kept apart:
 *
 * - **experiment surface** (`run`, `validate`) — the pre-0.4.0 JSON
 *   `ExperimentDefinition` path, unchanged. It is preserved verbatim so
 *   an existing script keeps working; see `runExperimentCommand`.
 * - **program surface** (`config`, `program`) — the Continuous Product
 *   Evaluation path (issue #65). It is configuration-centric: the
 *   `u-sekai.yml` authority file from #58 decides *what* may be run and
 *   *under which authority*, and #62/#63 decide whether and how it runs.
 *   See `program-command.ts`.
 *
 * Exit codes:
 *   0 success — every participant reached a legitimate terminal state
 *   1 validation error
 *   2 runtime error (adapter / reasoner), including a participant that
 *     terminated for any reason other than a clean finish
 *   3 capability violation during a participant run
 *
 * The program surface reuses 1/2 and adds 4 (setup refused) and 5
 * (product findings were reported). It never reuses 3, because a
 * program run reports a capability violation as a setup failure — see
 * `program-command.ts` for why the two are not interchangeable.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  ExperimentDefinition,
} from '../domain/experiment.js';
import { loadExperiment } from '../experiment/loader.js';
import { runExperiment, runtimeErrorsForParticipant } from '../experiment/runner.js';
import type { BehavioralEvidence } from '../domain/evidence.js';
import { HttpAdapter } from '../adapter/browser/http-adapter.js';
import { PlaywrightAdapter } from '../adapter/browser/playwright-adapter.js';
import { startServer } from '../demo/environment/server.js';
import { AdapterError } from '../domain/errors.js';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.js';
import { runProgramSurface } from './program-command.js';
import type { ConfigSubcommand, ProgramSubcommand } from './program-command.js';

/**
 * Top-level verbs.
 *
 * `run` / `validate` are the pre-0.4.0 experiment surface and keep their
 * meaning. `config` / `program` are the Continuous Product Evaluation
 * surface from #65 and take a subcommand, which is why the union below
 * carries a second member rather than a flat `config-validate` verb: the
 * issue's required UX is `u-sekai config validate` and
 * `u-sekai program run|status`, and a flat spelling would make
 * `u-sekai program` on its own an unrecognised word instead of a command
 * with a missing subcommand.
 */
type TopLevelCommand = 'run' | 'validate' | 'config' | 'program' | 'help' | 'version';

const TOP_LEVEL_COMMANDS: ReadonlyArray<TopLevelCommand> = [
  'run',
  'validate',
  'config',
  'program',
  'help',
  'version',
];

/**
 * Narrow a bare word to a top-level verb.
 *
 * A type predicate rather than a cast, so a verb added to the union
 * without a branch at the dispatch site in `main` is caught by
 * `tsc` rather than falling through to a generic message.
 */
function isTopLevelCommand(value: string): value is TopLevelCommand {
  return (TOP_LEVEL_COMMANDS as ReadonlyArray<string>).includes(value);
}

/** Narrow a bare word to the subcommand of `command`, if it has one. */
function isSubcommandOf(
  command: TopLevelCommand,
  value: string,
): value is ConfigSubcommand | ProgramSubcommand {
  if (command === 'config') return (['validate'] as ReadonlyArray<string>).includes(value);
  if (command === 'program') return (['run', 'status'] as ReadonlyArray<string>).includes(value);
  return false;
}

interface ParsedArgs {
  command: TopLevelCommand | null;
  /** The verb under `config` / `program`. Absent for the flat surface. */
  subcommand: ConfigSubcommand | ProgramSubcommand | null;
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const out: ParsedArgs = { command: null, subcommand: null, positional: [], flags: {} };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (typeof a !== 'string') { i += 1; continue; }
    if (a === '--help' || a === '-h') { out.command = 'help'; i += 1; continue; }
    if (a === '--version' || a === '-V') { out.command = 'version'; i += 1; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out.flags[key] = next;
        i += 2;
      } else {
        out.flags[key] = 'true';
        i += 1;
      }
      continue;
    }
    if (out.command === null) {
      if (isTopLevelCommand(a)) {
        out.command = a;
        i += 1;
        continue;
      }
    } else if (out.subcommand === null && isSubcommandOf(out.command, a)) {
      out.subcommand = a;
      i += 1;
      continue;
    }
    out.positional.push(a);
    i += 1;
  }
  return out;
}

function printUsage(): void {
  process.stdout.write(`u-sekai ${VERSION}

Usage:
  u-sekai config validate [u-sekai.yml]     Check the authority file.
  u-sekai program run <program-id> [flags]  Run a Review Program once, locally.
  u-sekai program status <program-id>       Show what the durable store holds.

  u-sekai run <experiment.json> [flags]     Experiment surface (pre-0.4.0).
  u-sekai validate <experiment.json>
  u-sekai --version
  u-sekai --help

Continuous Product Evaluation:
  The program surface is configured by u-sekai.yml, which is the only
  authority surface: no flag here can widen what that file grants. The
  file is read from --config, then USE_SEKAI_CONFIG, then ./u-sekai.yml.

Flags (config validate):
  --config <path>            Which file to read. Chooses the file; grants nothing.

Flags (program run):
  --config <path>            Which u-sekai.yml to read. Chooses the file only.
  --adapter http|playwright  Browser adapter. Default: http.
  --reasoner <provider>      scripted (CI) or anthropic (live, needs ANTHROPIC_API_KEY).
  --observer-reasoner <prov> Observer reasoner provider.
  --task <text>              What the Synthetic Identities are asked to attempt.
  --max-steps <n>            Step ceiling per identity. Default: 6.
  --seed <text>              Deterministic seed. Default: derived from the program.
  --state-dir <dir>          Durable identity/cohort store. Default: .u-sekai-state.
  --out <dir>                Artifact root. Default: <state-dir>/artifacts.
  --max-identities <n>       Cap on identities this one command may plan. Only ever
                             lowers the cohort's own declared membership; raising a
                             plan past it is what editing u-sekai.yml is for.
  --version-label <text>     The version the environment is observed at. Required:
                             a run must not invent one (it would poison the next
                             release-transition join).
  --dry-run                  Plan and print, without dispatching a participant.

  Every flag here chooses a file, a store, a provider or a cap. None of
  them can widen what u-sekai.yml grants.

Flags (run):
  --adapter http|playwright   Browser adapter to use. Default: http.
                              Playwright requires the browser binary installed.
  --out <dir>                 Artifact directory (default: <workdir>/runs/<runId>).
  --reasoner <provider>       Override the participant reasoner provider.
                              Useful values: scripted (CI), anthropic (live, needs
                              ANTHROPIC_API_KEY).
  --observer-reasoner <prov>  Override the observer reasoner provider.

Exit codes:
  0  success
  1  validation / configuration error
  2  runtime error (adapter / reasoner / store)
  3  capability violation during a participant run (experiment surface)
  4  setup refused: the run observed nothing (program surface)
  5  the run completed and reported product findings (program surface)
`);
}

/**
 * Terminal reasons that mean the participant completed its exploration on
 * its own terms, so the run as a whole succeeded.
 *
 * The classification is an *allowlist* of successful terminal states, not a
 * list of known failure reasons. A terminal reason that this build does not
 * know about therefore fails closed (exit 2) instead of silently reporting
 * success, which is what a new failure reason needs to mean.
 *
 * This set is intentionally wider than the two reasons a participant
 * actually reaches today (`finish`, `stepBudgetExceeded`), which is what the
 * README documents. `finishFromObserver` and `finishFromSelfReport` are
 * declared in the domain termination-reason union but no runtime path emits
 * them yet; they are listed here so that a finish variant is never reported
 * as a failure if one is wired up later.
 */
const SUCCESSFUL_TERMINATION_REASONS: ReadonlySet<string> = new Set([
  'finish',
  'stepBudgetExceeded',
  'finishFromObserver',
  'finishFromSelfReport',
]);

const CAPABILITY_VIOLATION_REASON = 'capabilityViolation';

export type RunExitClassification =
  | { readonly code: 0; readonly failedParticipantIds: ReadonlyArray<string> }
  | { readonly code: 2 | 3; readonly failedParticipantIds: ReadonlyArray<string> };

/**
 * Maps per-participant terminal reasons to the documented process exit code.
 *
 * - `0` every participant reached a legitimate terminal state
 * - `3` at least one participant hit a capability violation — the more
 *   specific signal, so it keeps its own documented code
 * - `2` any other terminal reason (adapter / Reasoner / runtime failure),
 *   including a mixed run where some participants finished and others did
 *   not: the run did not fully succeed, so it must not report success
 */
export function classifyRunExit(
  terminationReasons: Readonly<Record<string, string>>,
): RunExitClassification {
  const failed = Object.entries(terminationReasons)
    .filter(([, reason]) => !SUCCESSFUL_TERMINATION_REASONS.has(reason))
    .map(([participantId]) => participantId);
  if (failed.length === 0) {
    return { code: 0, failedParticipantIds: failed };
  }
  const anyCapabilityViolation = failed.some(
    (participantId) => terminationReasons[participantId] === CAPABILITY_VIOLATION_REASON,
  );
  return { code: anyCapabilityViolation ? 3 : 2, failedParticipantIds: failed };
}

/** One line per failed participant, on stderr, with the persisted diagnostic. */
function reportParticipantFailures(
  classification: RunExitClassification,
  terminationReasons: Readonly<Record<string, string>>,
  evidence: BehavioralEvidence,
  artifactDir: string,
): void {
  if (classification.code === 0) return;
  const kind = classification.code === 3 ? 'capability violation' : 'runtime failure';
  process.stderr.write(
    `u-sekai: ${classification.failedParticipantIds.length} participant(s) ended in a ${kind} (exit ${classification.code}):\n`,
  );
  for (const participantId of classification.failedParticipantIds) {
    const reason = terminationReasons[participantId] ?? 'unknown';
    const diagnostics = runtimeErrorsForParticipant(evidence, participantId).map(
      (entry) => oneLine(entry.message),
    );
    const detail = diagnostics.length > 0 ? ` -- ${diagnostics.join(' / ')}` : '';
    process.stderr.write(`  ${participantId}: ${reason}${detail}\n`);
  }
  process.stderr.write(
    `u-sekai: full diagnostics are persisted in ${path.join(artifactDir, 'result.json')} (evidence.runtimeErrors).\n`,
  );
}

function oneLine(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? collapsed : '(no diagnostic recorded)';
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.command === 'help' || args.command === null) {
    if (argv.length === 0 || args.command === 'help') {
      printUsage();
      return 0;
    }
  }
  if (args.command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!args.command) {
    process.stderr.write('u-sekai: missing command. Use --help.\n');
    return 1;
  }

  // The Continuous Product Evaluation surface. Routed before the
  // experiment surface so a nested command is never read as an
  // experiment path: `program run` has a `run` in it, and the flat
  // branch below would otherwise claim the word. The narrowing is a
  // type predicate rather than a cast, so this surface cannot be handed
  // a `command` it does not dispatch.
  if (args.command === 'config' || args.command === 'program') {
    return runProgramSurface({
      command: args.command,
      subcommand: args.subcommand,
      positional: args.positional,
      flags: args.flags,
    });
  }

  const target = args.positional[0];
  if (!target) {
    process.stderr.write(`u-sekai: ${args.command}: missing experiment file.\n`);
    return 1;
  }
  const absPath = path.resolve(process.cwd(), target);

  if (args.command === 'validate') {
    try {
      const def = await loadExperiment(absPath);
      process.stdout.write(`ok: ${def.id} (${def.participants.length} participants)\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`u-sekai: validate: ${(err as Error).message}\n`);
      return 1;
    }
  }

  if (args.command === 'run') {
    let experiment: ExperimentDefinition;
    try {
      experiment = await loadExperiment(absPath);
    } catch (err) {
      process.stderr.write(`u-sekai: ${(err as Error).message}\n`);
      return 1;
    }
    const outFlag = args.flags['out'];
    if (outFlag) {
      experiment = { ...experiment, outDir: path.resolve(process.cwd(), outFlag) };
    }
    const adapterName = args.flags['adapter'] ?? 'http';
    const reasonerOverride = args.flags['reasoner'];
    const observerOverride = args.flags['observer-reasoner'];

    let demoHandle: Awaited<ReturnType<typeof startServer>> | null = null;
    const resolveTargetUrl = (env: ExperimentDefinition['environment']): string => {
      if (env.kind === 'http') return env.url;
      if (env.kind === 'demo') {
        if (env.app !== 'task-tracker') {
          throw new AdapterError(`unknown demo app: ${env.app}`, 'demo');
        }
        // Re-uses demoHandle if set; otherwise requires it to be set.
        if (!demoHandle) {
          throw new AdapterError('demo environment requested but server is not running', 'demo');
        }
        return demoHandle.baseUrl;
      }
      throw new AdapterError('unknown environment kind', 'runner');
    };

    try {
      if (experiment.environment.kind === 'demo') {
        demoHandle = await startServer({ port: 0 });
      }

      const overrides: { perParticipant?: Record<string, { provider: 'scripted' | 'anthropic' }>; observer?: { provider: 'scripted' | 'anthropic' } } = {};
      if (reasonerOverride === 'scripted' || reasonerOverride === 'anthropic') {
        overrides.perParticipant = Object.fromEntries(
          experiment.participants.map((p) => [p.id, { provider: reasonerOverride }]),
        );
      }
      if (observerOverride === 'scripted' || observerOverride === 'anthropic') {
        overrides.observer = { provider: observerOverride };
      }

      const result = await runExperiment({
        experiment,
        adapterFactory: (exp) => {
          const a = (adapterName === 'playwright') ? new PlaywrightAdapter() : new HttpAdapter();
          void exp;
          return a;
        },
        resolveTargetUrl: (env) => resolveTargetUrl(env),
        ...(Object.keys(overrides).length > 0 ? { reasonerOverrides: overrides } : {}),
      });

      const artifactDir = path.join(experiment.outDir, result.runId);
      process.stdout.write(`run=${result.runId}\nartifact=${artifactDir}\n`);
      for (const [id, reason] of Object.entries(result.result.terminationReasons)) {
        process.stdout.write(`  ${id}: ${reason}\n`);
      }
      const classification = classifyRunExit(result.result.terminationReasons);
      reportParticipantFailures(
        classification,
        result.result.terminationReasons,
        result.result.evidence,
        artifactDir,
      );
      return classification.code;
    } catch (err) {
      process.stderr.write(`u-sekai: ${(err as Error).message}\n`);
      if (err instanceof AdapterError) return 2;
      return 2;
    } finally {
      if (demoHandle) await demoHandle.close().catch(() => undefined);
      await fs.writeFile(path.join(experiment.outDir, 'last-run.txt'), new Date().toISOString()).catch(() => undefined);
    }
  }
  return 1;
}

const isEntrypoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`u-sekai: uncaught: ${(err as Error).message}\n`);
      process.exit(2);
    },
  );
}

export { main as runCli };
