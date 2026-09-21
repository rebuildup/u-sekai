/**
 * u-sekai CLI. Minimal, deterministic, dependency-free.
 *
 *   u-sekai run <experiment.json> [--adapter http|playwright] [--out <dir>] [--demo-server-port N]
 *   u-sekai validate <experiment.json>
 *   u-sekai --version
 *   u-sekai --help
 *
 * Exit codes:
 *   0 success
 *   1 validation error
 *   2 runtime error (adapter / reasoner)
 *   3 capability violation during a participant run
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  ExperimentDefinition,
} from '../domain/experiment.js';
import { loadExperiment } from '../experiment/loader.js';
import { runExperiment } from '../experiment/runner.js';
import { HttpAdapter } from '../adapter/browser/http-adapter.js';
import { PlaywrightAdapter } from '../adapter/browser/playwright-adapter.js';
import { startServer } from '../demo/environment/server.js';
import { AdapterError } from '../domain/errors.js';
import { fileURLToPath } from 'node:url';

interface ParsedArgs {
  command: 'run' | 'validate' | 'help' | 'version' | null;
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const out: ParsedArgs = { command: null, positional: [], flags: {} };
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
      if (a === 'run' || a === 'validate') {
        out.command = a;
        i += 1;
        continue;
      }
    }
    out.positional.push(a);
    i += 1;
  }
  return out;
}

function printUsage(): void {
  process.stdout.write(`u-sekai 0.1.0

Usage:
  u-sekai run <experiment.json> [flags]
  u-sekai validate <experiment.json>
  u-sekai --version
  u-sekai --help

Flags (run):
  --adapter http|playwright   Browser adapter to use. Default: http.
                              Playwright requires the browser binary installed.
  --out <dir>                 Artifact directory (default: <workdir>/runs/<runId>).
  --reasoner <provider>       Override the participant reasoner provider.
                              Useful values: scripted (CI), anthropic (live, needs
                              ANTHROPIC_API_KEY).
  --observer-reasoner <prov>  Override the observer reasoner provider.
`);
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
    process.stdout.write('0.1.0\n');
    return 0;
  }
  if (!args.command) {
    process.stderr.write('u-sekai: missing command. Use --help.\n');
    return 1;
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

      process.stdout.write(`run=${result.runId}\nartifact=${path.join(experiment.outDir, result.runId)}\n`);
      for (const [id, reason] of Object.entries(result.result.terminationReasons)) {
        process.stdout.write(`  ${id}: ${reason}\n`);
      }
      const anyCap = Object.values(result.result.terminationReasons).some((r) => r === 'capabilityViolation');
      return anyCap ? 3 : 0;
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
