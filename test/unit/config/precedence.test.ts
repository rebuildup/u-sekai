/**
 * Precedence, and the claim that `u-sekai.yml` is the authority surface
 * (issue #58).
 *
 * There is exactly one precedence ladder in this layer — which file is
 * the authority — and it is exercised here in all three of its steps
 * plus the two ways it is closed. The second row of the table in
 * `load.ts` ("what that file authorises" comes from the file alone) has
 * no ladder at all, and these tests are what make that true rather than
 * merely documented.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as loadSurface from '../../../src/config/load.js';
import {
  CONFIG_PATH_ENV_VARS,
  DEFAULT_CONFIG_FILENAME,
  ENV_VAR_PREFIX,
  findConfiguredEnvironmentByName,
  loadUseSekaiConfig,
  resolveConfigPath,
  type LoadConfigOptions,
} from '../../../src/config/index.js';
import { buildConfig, expectConfigError, expectConfigErrorAsync, serialise } from './support.js';
import { UseSekaiConfigError } from '../../../src/config/index.js';

const CWD = '/repo';

/** Resolve with a fully-populated environment so nothing leaks in from the host. */
const options = (overrides: Partial<LoadConfigOptions> = {}): LoadConfigOptions => ({
  cwd: CWD,
  env: {},
  ...overrides,
});

describe('which file is the authority', () => {
  it('uses the explicit path first', () => {
    const resolved = resolveConfigPath(
      options({ configPath: '/elsewhere/chosen.yml', env: { USE_SEKAI_CONFIG: '/env/from-env.yml' } }),
    );
    expect(resolved).toEqual({ configPath: '/elsewhere/chosen.yml', configPathSource: 'explicit' });
  });

  it('uses the environment variable second', () => {
    const resolved = resolveConfigPath(options({ env: { USE_SEKAI_CONFIG: '/env/from-env.yml' } }));
    expect(resolved).toEqual({ configPath: '/env/from-env.yml', configPathSource: 'environment' });
  });

  it('falls back to u-sekai.yml in the working directory', () => {
    const resolved = resolveConfigPath(options());
    expect(resolved).toEqual({
      configPath: resolve(CWD, DEFAULT_CONFIG_FILENAME),
      configPathSource: 'default',
    });
  });

  it('resolves a relative path against the working directory', () => {
    expect(resolveConfigPath(options({ configPath: 'config/u-sekai.yml' })).configPath).toBe(
      resolve(CWD, 'config/u-sekai.yml'),
    );
    expect(
      resolveConfigPath(options({ env: { USE_SEKAI_CONFIG: 'config/u-sekai.yml' } })).configPath,
    ).toBe(resolve(CWD, 'config/u-sekai.yml'));
  });

  it('leaves an absolute path alone', () => {
    expect(resolveConfigPath(options({ configPath: '/abs/u-sekai.yml' })).configPath).toBe(
      '/abs/u-sekai.yml',
    );
  });

  it('rejects an empty path from either source', () => {
    for (const empty of ['', '   ']) {
      expect(() => resolveConfigPath(options({ configPath: empty }))).toThrow(UseSekaiConfigError);
      expect(() => resolveConfigPath(options({ env: { USE_SEKAI_CONFIG: empty } }))).toThrow(
        UseSekaiConfigError,
      );
    }
  });

  it('records which rule chose the file on the loaded configuration', async () => {
    const text = buildConfig();
    const loaded = await loadUseSekaiConfig(
      options({ configPath: 'u-sekai.yml', readFile: () => text }),
    );
    expect(loaded.provenance).toEqual({
      configPath: resolve(CWD, 'u-sekai.yml'),
      configPathSource: 'explicit',
    });
  });
});

describe('nothing else may supply an authority', () => {
  it('rejects any USE_SEKAI_* variable it does not read', async () => {
    // The realistic failure: an operator exports
    // USE_SEKAI_REAL_MONEY=true to enable a permission, it has no effect,
    // and they reasonably conclude the permission is on. Silently ignoring
    // it is the dangerous behaviour; the error says where authority comes
    // from.
    const error = await expectConfigErrorAsync(() =>
      loadUseSekaiConfig(options({ env: { USE_SEKAI_REAL_MONEY: 'true' }, readFile: () => buildConfig() })),
    );
    expect(error.message).toContain('USE_SEKAI_REAL_MONEY');
    expect(error.message).toMatch(/u-sekai\.yml is the only authority surface/);
  });

  it('rejects a whole set of them and names every one', () => {
    const error = expectConfigError(() =>
      resolveConfigPath(
        options({
          env: {
            USE_SEKAI_CONFIG: '/env/from-env.yml',
            USE_SEKAI_DESTRUCTIVE_ACTIONS: 'true',
            USE_SEKAI_EXTERNAL_COMMUNICATION: '1',
          },
        }),
      ),
    );
    expect(error.detail['variables']).toEqual([
      'USE_SEKAI_DESTRUCTIVE_ACTIONS',
      'USE_SEKAI_EXTERNAL_COMMUNICATION',
    ]);
  });

  it('names the offending variables but never their values', () => {
    // An operator who exported a secret by mistake must not have it copied
    // into a CI log by this error.
    const leaked = 'sk-live-LEAKED-VALUE';
    const error = expectConfigError(() =>
      resolveConfigPath(options({ env: { USE_SEKAI_TOKEN: leaked } })),
    );
    expect(error.message).toContain('USE_SEKAI_TOKEN');
    expect(error.message).not.toContain(leaked);
    expect(JSON.stringify(error.detail)).not.toContain(leaked);
  });

  it('ignores unrelated environment variables entirely', () => {
    // The guard is scoped to u-sekai's own namespace, so a host with a
    // hundred other variables in its environment is not rejected.
    const resolved = resolveConfigPath(
      options({ env: { PATH: '/usr/bin', HOME: '/root', CI: 'true', GITHUB_ACTIONS: 'true' } }),
    );
    expect(resolved.configPathSource).toBe('default');
  });

  it('ignores an authority smuggled in through an unknown option key', async () => {
    // `LoadConfigOptions` has no authority field, and TypeScript's
    // `exactOptionalPropertyTypes` does not stop a JavaScript caller or
    // an `as any` cast. The runtime must therefore ignore such a key
    // rather than honour it — and must not report an envelope the file
    // never granted.
    const loaded = await loadUseSekaiConfig(
      options({
        readFile: () => buildConfig(),
        // Deliberately not part of LoadConfigOptions.
        authority: { destructiveActions: true },
      } as LoadConfigOptions),
    );
    expect(findConfiguredEnvironmentByName(loaded, 'develop')?.authority.destructiveActions).toBe(
      false,
    );
  });

  it('exposes exactly one supported environment input', () => {
    // The loader's whole public surface, so adding a second environment
    // input — the only way to widen what a file can be overridden with —
    // has to change this list.
    expect(Object.keys(loadSurface).sort()).toEqual([
      'CONFIG_PATH_ENV_VARS',
      'loadUseSekaiConfig',
      'parseUseSekaiConfigText',
      'resolveConfigPath',
    ]);
    expect(CONFIG_PATH_ENV_VARS).toEqual(['USE_SEKAI_CONFIG']);
    expect(ENV_VAR_PREFIX).toBe('USE_SEKAI_');
  });
});

describe('the authority is the file and only the file', () => {
  /** A file that grants exactly one permission on one environment. */
  const granting = (): Record<string, unknown> => ({
    version: 1,
    product: { id: 'acme' },
    environments: {
      develop: {
        class: 'staging',
        url: 'https://staging.example.com',
        authority: { destructiveActions: true },
      },
    },
  });

  /** A file that grants nothing. */
  const denying = (): Record<string, unknown> => ({
    version: 1,
    product: { id: 'acme' },
    environments: {
      develop: { class: 'staging', url: 'https://staging.example.com' },
    },
  });

  it('takes a permission from the file', async () => {
    const loaded = await loadUseSekaiConfig(options({ readFile: () => serialise(granting()) }));
    expect(findConfiguredEnvironmentByName(loaded, 'develop')?.authority.destructiveActions).toBe(
      true,
    );
  });

  it('grants the same permission from a different file without intervention', async () => {
    // Selecting a different file is the only lever, and it is a lever the
    // caller can only pull by naming a file. Nothing in between changes
    // the envelope.
    const loaded = await loadUseSekaiConfig(
      options({ configPath: '/other/u-sekai.yml', readFile: () => serialise(granting()) }),
    );
    expect(findConfiguredEnvironmentByName(loaded, 'develop')?.authority.destructiveActions).toBe(
      true,
    );
  });

  it('denies a permission the selected file does not grant, however the file was chosen', async () => {
    for (const loadOptions of [
      options({ readFile: () => serialise(denying()) }),
      options({ env: { USE_SEKAI_CONFIG: '/env/u-sekai.yml' }, readFile: () => serialise(denying()) }),
      options({ configPath: '/other/u-sekai.yml', readFile: () => serialise(denying()) }),
    ]) {
      const loaded = await loadUseSekaiConfig(loadOptions);
      const authority = findConfiguredEnvironmentByName(loaded, 'develop')?.authority;
      expect(authority?.destructiveActions).toBe(false);
      expect(authority?.realMoney).toEqual({ enabled: false, maxAmount: 0 });
    }
  });

  it('reports the envelope source as the file, never as an override', async () => {
    const loaded = await loadUseSekaiConfig(
      options({
        env: { USE_SEKAI_CONFIG: '/env/u-sekai.yml' },
        readFile: () => serialise(granting()),
      }),
    );
    const environment = findConfiguredEnvironmentByName(loaded, 'develop');
    expect(environment?.authoritySource).toBe('file');
    expect(loaded.provenance.configPathSource).toBe('environment');
  });
});

describe('a missing or unreadable file fails closed', () => {
  it('rejects a missing file rather than falling back to defaults', async () => {
    // A configuration surface that invents an empty product when the file
    // is absent turns a typo in a path into a silent loss of the
    // authority declaration.
    const error = await expectConfigErrorAsync(() =>
      loadUseSekaiConfig(
        options({
          readFile: () => {
            const notFound = new Error('nope') as NodeJS.ErrnoException;
            notFound.code = 'ENOENT';
            throw notFound;
          },
        }),
      ),
    );
    expect(error.message).toMatch(/no u-sekai configuration at/);
    expect(error.detail['reason']).toBe('not_found');
  });

  it('names the path it looked for, so the fix is obvious', async () => {
    const error = await expectConfigErrorAsync(() =>
      loadUseSekaiConfig(
        options({
          configPath: '/somewhere/else.yml',
          readFile: () => {
            const notFound = new Error('nope') as NodeJS.ErrnoException;
            notFound.code = 'ENOENT';
            throw notFound;
          },
        }),
      ),
    );
    expect(error.message).toContain('/somewhere/else.yml');
    expect(error.message).toContain('USE_SEKAI_CONFIG');
  });

  it('rejects a directory in place of a file', async () => {
    const error = await expectConfigErrorAsync(() =>
      loadUseSekaiConfig(
        options({
          readFile: () => {
            const isDir = new Error('nope') as NodeJS.ErrnoException;
            isDir.code = 'EISDIR';
            throw isDir;
          },
        }),
      ),
    );
    expect(error.detail['reason']).toBe('not_a_file');
  });

  it('rejects an unreadable file rather than proceeding without one', async () => {
    const error = await expectConfigErrorAsync(() =>
      loadUseSekaiConfig(
        options({
          readFile: () => {
            const denied = new Error('nope') as NodeJS.ErrnoException;
            denied.code = 'EACCES';
            throw denied;
          },
        }),
      ),
    );
    expect(error.detail['reason']).toBe('unreadable');
    expect(error.message).toContain('EACCES');
  });

  it('never returns a partial configuration for any of them', async () => {
    for (const code of ['ENOENT', 'EISDIR', 'EACCES', 'EIO']) {
      let result: unknown = 'unset';
      try {
        result = await loadUseSekaiConfig(
          options({
            readFile: () => {
              const failure = new Error('nope') as NodeJS.ErrnoException;
              failure.code = code;
              throw failure;
            },
          }),
        );
      } catch {
        // expected
      }
      expect(result, `expected no result for ${code}`).toBe('unset');
    }
  });
});

describe('against a real filesystem', () => {
  it('reads a file from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'use-sekai-config-'));
    const path = join(dir, 'u-sekai.yml');
    await writeFile(path, buildConfig(), 'utf8');

    const loaded = await loadUseSekaiConfig({ configPath: path, env: {} });
    expect(loaded.model.product.id).toBe('prd-acme');
    expect(loaded.provenance.configPathSource).toBe('explicit');
  });

  it('finds u-sekai.yml in the working directory when nothing selects one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'use-sekai-config-'));
    await writeFile(join(dir, DEFAULT_CONFIG_FILENAME), buildConfig(), 'utf8');

    const loaded = await loadUseSekaiConfig({ cwd: dir, env: {} });
    expect(loaded.provenance.configPathSource).toBe('default');
    expect(loaded.provenance.configPath).toBe(join(dir, DEFAULT_CONFIG_FILENAME));
  });
});
