/**
 * Shared helpers for the `u-sekai.yml` test suite.
 *
 * ## Two ways to write a configuration, on purpose
 *
 * `buildConfig` serialises a JS object literal with `yaml.stringify`, so a
 * schema test reads like the document it is asserting about.
 *
 * `rawConfig` takes a hand-written string and is used for everything
 * about *YAML itself* — duplicate keys, aliases, tags, `__proto__`,
 * unterminated flow. Those cases are exactly the ones a serialiser
 * cannot produce, because `stringify` would emit the correct document
 * rather than the broken one; going through the library to build them
 * would also mean a reader bug could be cancelled out by a writer bug.
 *
 * Neither helper weakens an assertion: both produce the text that is fed
 * to the loader under test, and the loader is the only thing that reads
 * it.
 */

import { readFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import { UseSekaiConfigError } from '../../../src/config/index.js';
import type { UseSekaiConfig } from '../../../src/config/index.js';
import { loadUseSekaiConfig, type LoadConfigOptions } from '../../../src/config/index.js';

export const FIXTURE_DIR = 'test/fixtures/config';

/**
 * Path of a committed fixture, relative to the repository root.
 *
 * `name` is the basename without an extension, so a test cannot
 * accidentally read a different file than the one it names.
 */
export function fixturePath(name: string): string {
  return `${FIXTURE_DIR}/${name}.yml`;
}

/** Read a committed fixture as text. */
export async function readFixtureText(name: string): Promise<string> {
  return readFile(fixturePath(name), 'utf8');
}

/** A `LoadConfigOptions.readFile` that reads from the repository. */
export const repositoryReader = (path: string): Promise<string> => readFile(path, 'utf8');

/** Load a committed fixture through the real loader. */
export function loadFixture(name: string, overrides: Partial<LoadConfigOptions> = {}) {
  return loadUseSekaiConfig({
    configPath: fixturePath(name),
    env: {},
    readFile: repositoryReader,
    ...overrides,
  });
}

/** The smallest valid document, as a structured object. */
export function minimalDocument(): Record<string, unknown> {
  return {
    version: 1,
    product: { id: 'acme' },
    environments: {
      develop: { class: 'develop', url: 'https://develop.acme.example' },
    },
  };
}

/**
 * Serialise a document, dropping `undefined` so an absent optional is
 * absent in the YAML rather than an explicit `null` (which the loader
 * rejects, correctly).
 */
export function serialise(document: unknown): string {
  return stringify(prune(document), { aliasDuplicateObjects: false });
}

/**
 * `buildConfig({...})` — the minimal document with `overrides` deep-merged
 * on top. An override value of `undefined` deletes the key.
 */
export function buildConfig(overrides: Record<string, unknown> = {}): string {
  return serialise(deepMerge(minimalDocument(), overrides));
}

/**
 * Serialise a document from scratch, with no minimal-document defaults
 * merged in. Needed for the cases that assert on an absent or empty
 * block, which `buildConfig` cannot express.
 */
export function configFrom(document: Record<string, unknown>): string {
  return serialise(document);
}

/** Feed hand-written YAML to the loader and assert it is rejected. */
export function expectConfigError(operation: () => unknown): UseSekaiConfigError {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expectConfigErrorShape(thrown);
  return thrown as UseSekaiConfigError;
}

/** Async form of {@link expectConfigError}. */
export async function expectConfigErrorAsync(operation: () => Promise<unknown>): Promise<UseSekaiConfigError> {
  let thrown: unknown;
  try {
    await operation();
  } catch (error) {
    thrown = error;
  }
  expectConfigErrorShape(thrown);
  return thrown as UseSekaiConfigError;
}

/** Assert the error is a config error, and that it names a field. */
export function expectConfigErrorShape(thrown: unknown): void {
  if (!(thrown instanceof UseSekaiConfigError)) {
    throw new Error(
      `expected a UseSekaiConfigError, got ${
        thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)
      }`,
    );
  }
  if (typeof thrown.message !== 'string' || thrown.message.trim() === '') {
    throw new Error('a config error must carry a message');
  }
}

/** The authority envelope of the environment declared under `name`. */
export function authorityOf(config: UseSekaiConfig, name: string) {
  const environment = config.environments.find((entry) => entry.name === name);
  if (!environment) {
    throw new Error(`no environment named "${name}" in the loaded configuration`);
  }
  return environment.authority;
}

function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      out[key] = prune(entry);
    }
    return out;
  }
  return value;
}

function deepMerge(base: unknown, overlay: unknown): unknown {
  if (
    overlay === null ||
    typeof overlay !== 'object' ||
    Array.isArray(overlay) ||
    base === null ||
    typeof base !== 'object' ||
    Array.isArray(base)
  ) {
    return overlay;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overlay as Record<string, unknown>)) {
    if (value === undefined) {
      delete out[key];
      continue;
    }
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out;
}
