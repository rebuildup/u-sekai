/**
 * Choosing and reading `u-sekai.yml` (issue #58).
 *
 * ## Precedence, stated once
 *
 * | what | order | source recorded as |
 * | --- | --- | --- |
 * | which file is the authority | `LoadConfigOptions.configPath` → `USE_SEKAI_CONFIG` → `./u-sekai.yml` | `provenance.configPathSource` |
 * | what that file authorises | the file, alone | `ConfiguredEnvironment.authoritySource` |
 *
 * The second row is the one that matters, and it is enforced three
 * ways rather than documented once:
 *
 * 1. `LoadConfigOptions` has **no** field that could carry an
 *    authority, so a caller cannot pass one.
 * 2. `USE_SEKAI_CONFIG` is the only environment variable read, and any
 *    other `USE_SEKAI_*` variable is a **hard error** rather than an
 *    ignore. Someone who exported `USE_SEKAI_AUTHORITY_REAL_MONEY=true`
 *    and was silently ignored would reasonably believe they had enabled
 *    it; the error says the file is the only place it can come from.
 * 3. The error names the offending variables and never their values.
 *
 * A future ticket that needs a new `USE_SEKAI_*` input extends
 * `CONFIG_PATH_ENV_VARS` here. It has to edit the loader, which is the
 * point: adding an environment-driven knob is a visible act.
 *
 * ## No file, no defaults
 *
 * A missing file is an error. A configuration surface that invents an
 * empty product when the file is absent is a surface where a typo in a
 * path silently disables the authority declaration, so absence fails
 * closed too.
 */

import { readFile as readFileFromDisk } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { parseUseSekaiConfig, type ConfigProvenance, type UseSekaiConfig } from './document.js';
import { CONFIG_PATH_ENV_VAR, DEFAULT_CONFIG_FILENAME, ENV_VAR_PREFIX, UseSekaiConfigError } from './errors.js';
import { readYamlSource } from './yaml.js';

/** `USE_SEKAI_*` variables this loader reads. Adding one is a visible act. */
export const CONFIG_PATH_ENV_VARS: ReadonlyArray<string> = Object.freeze([CONFIG_PATH_ENV_VAR]);

export interface LoadConfigOptions {
  /**
   * Explicit path to the configuration file — a CLI `--config` flag.
   * Highest precedence. Cannot widen any authority: it only chooses
   * which file is read.
   */
  readonly configPath?: string;
  /** Directory relative paths resolve against. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Environment consulted for `USE_SEKAI_CONFIG`. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** File reader. Injected by tests; defaults to `node:fs/promises`. */
  readonly readFile?: (path: string) => string | Promise<string>;
}

/** Where the configuration file would be read from, and which rule chose it. */
export function resolveConfigPath(options: LoadConfigOptions = {}): ConfigProvenance {
  const env = options.env ?? process.env;
  assertNoForeignEnvVars(env);

  const cwd = options.cwd ?? process.cwd();

  if (options.configPath !== undefined) {
    return {
      configPath: absolutise(options.configPath, `${CONFIG_PATH_ENV_VAR} / --config`, cwd, 'explicit'),
      configPathSource: 'explicit',
    };
  }

  const fromEnv = env[CONFIG_PATH_ENV_VAR];
  if (fromEnv !== undefined) {
    return {
      configPath: absolutise(fromEnv, CONFIG_PATH_ENV_VAR, cwd, 'environment'),
      configPathSource: 'environment',
    };
  }

  return {
    configPath: resolvePath(cwd, DEFAULT_CONFIG_FILENAME),
    configPathSource: 'default',
  };
}

/**
 * Load, parse and validate `u-sekai.yml`.
 *
 * @throws {UseSekaiConfigError} for a missing, unreadable, malformed, or
 *   invalid configuration. There is no partial result and no warning
 *   channel: every failure is a thrown error.
 */
export async function loadUseSekaiConfig(
  options: LoadConfigOptions = {},
): Promise<UseSekaiConfig> {
  const provenance = resolveConfigPath(options);
  const readFile = options.readFile ?? ((path: string) => readFileFromDisk(path, 'utf8'));
  const source = await readConfigFile(provenance.configPath, readFile);
  return parseUseSekaiConfigText(source, provenance);
}

/** Parse configuration text that is already in hand. */
export function parseUseSekaiConfigText(
  source: string,
  provenance: ConfigProvenance,
): UseSekaiConfig {
  return parseUseSekaiConfig(readYamlSource(source, provenance.configPath), provenance, provenance.configPath);
}

async function readConfigFile(
  path: string,
  readFile: (path: string) => string | Promise<string>,
): Promise<string> {
  let text: string;
  try {
    text = await readFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new UseSekaiConfigError(
        `no u-sekai configuration at ${path}; create it, or point at another with --config or ${CONFIG_PATH_ENV_VAR}`,
        undefined,
        { reason: 'not_found', path },
      );
    }
    if (code === 'EISDIR') {
      throw new UseSekaiConfigError(`${path} is a directory, not a u-sekai configuration file`, undefined, {
        reason: 'not_a_file',
        path,
      });
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new UseSekaiConfigError(`${path} cannot be read (${code})`, undefined, {
        reason: 'unreadable',
        path,
        code,
      });
    }
    throw new UseSekaiConfigError(`${path} could not be read (${code ?? 'unknown error'})`, undefined, {
      reason: 'unreadable',
      path,
      code,
    });
  }
  return text;
}

/**
 * Refuse any `USE_SEKAI_*` variable this loader does not read.
 *
 * The alternative — ignoring them — would make an exported
 * `USE_SEKAI_AUTHORITY_REAL_MONEY=true` look like it worked. Values are
 * never included in the message: an operator who exported a secret by
 * mistake must not have it copied into a CI log by this error.
 */
function assertNoForeignEnvVars(env: NodeJS.ProcessEnv): void {
  const foreign = Object.keys(env)
    .filter((key) => key.startsWith(ENV_VAR_PREFIX) && !CONFIG_PATH_ENV_VARS.includes(key))
    .sort();
  if (foreign.length > 0) {
    throw new UseSekaiConfigError(
      `${foreign.join(', ')} cannot be set: u-sekai.yml is the only authority surface. ` +
        `u-sekai reads only ${CONFIG_PATH_ENV_VARS.join(', ')} from the environment, ` +
        'and only to choose which file to read — never to widen what that file authorises.',
      undefined,
      { reason: 'foreign_env_var', variables: foreign, supported: [...CONFIG_PATH_ENV_VARS] },
    );
  }
}

function absolutise(value: string, field: string, cwd: string, source: ConfigProvenance['configPathSource']): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UseSekaiConfigError(
      `${field} must be a non-empty path (from ${source})`,
      undefined,
      { reason: 'empty_path', source },
    );
  }
  return isAbsolute(value) ? value : resolvePath(cwd, value);
}
