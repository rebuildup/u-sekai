import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = path.join(root, 'node_modules/vitest/vitest.mjs');
const { scripts } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

function testFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(filename);
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [filename] : [];
  }).sort();
}

function suiteArguments(suite: string): string[] {
  const script = scripts[`test:${suite}`];
  expect(script, `Missing test:${suite} script`).toBeTypeOf('string');
  const [runner, command, ...args] = script!.trim().split(/\s+/);
  // These scripts are direct CLI invocations; wrappers need their own discovery check.
  expect([runner, command]).toEqual(['vitest', 'run']);
  return args;
}

function vitest(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

describe.each(['unit', 'integration', 'e2e'])('test:%s discovery', (suite) => {
  it('selects every test file in its suite and no files outside it', () => {
    const expected = testFiles(path.join(root, 'test', suite));
    expect(expected.length).toBeGreaterThan(0);

    // List with the package script's real arguments without recursively running this test.
    const result = vitest(['list', ...suiteArguments(suite), '--filesOnly', '--json']);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const files = JSON.parse(result.stdout) as { file: string }[];
    const actual = files.map(({ file }) => path.resolve(root, file)).sort();
    expect(actual).toEqual(expected);
  });

  it('fails explicitly when no test files match', () => {
    const result = vitest(['run', ...suiteArguments(suite), '--exclude', '**/*.test.ts']);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout + result.stderr).toContain('No test files found');
  });
});
