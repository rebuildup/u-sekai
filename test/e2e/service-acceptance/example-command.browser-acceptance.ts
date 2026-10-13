import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { repoRoot } from './routing/profile-include.js';

it('AC1 executes the documented command in a separate Node process', async () => {
  // The child selects only the scenario spec, so it cannot recurse into
  // this command test. No external model credentials are needed.
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--import', 'tsx', 'examples/continuous-product-evaluation/run-acceptance.ts',
  ], {
    cwd: repoRoot,
    timeout: 600_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', NO_COLOR: '1' },
  });
  expect(stdout).toContain('u-sekai 0.4.0 acceptance example');
  expect(stdout).toContain('Simulated, not human');
  expect(stdout).toContain('[ok]   the same persistent Synthetic Identity retains state across both versions');
  expect(stdout).not.toContain('[FAIL]');
  expect(stdout).not.toContain('Unmet expectations');
}, 610_000);
