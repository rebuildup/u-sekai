/**
 * The setup-failure document, shared by the runtime-adapter tests and
 * the compile-time separation test.
 */

import type { RuntimeErrorRecord } from '../../../../src/review/index.js';
import { lineageA, target } from './fixtures.js';

/** A `BehavioralEvidence.runtimeErrors` entry with no natural handle. */
export const browserGone: RuntimeErrorRecord = {
  ts: '2026-10-01T00:02:11Z',
  where: 'participant/browser',
  message: 'browserType.launch: Executable does not exist at /root/.cache/ms-playwright',
};

export function setupInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outcome: 'setupFailure',
    id: 'sf-0000abcd',
    cause: 'harnessUnavailable',
    message: 'Chromium could not be launched.',
    target,
    runId: lineageA.runId,
    identityIds: ['idn-alice'],
    evidenceRefs: [
      {
        id: 'ev-setup-1',
        channel: 'environmentProbe',
        stance: 'supports',
        locator: 'runtimeErrors[0]',
        observedAt: '2026-10-01T00:02:11Z',
        summary: 'participant/browser: launch failed',
      },
    ],
    occurredAt: '2026-10-01T00:02:11Z',
    ...overrides,
  };
}

/** Alias used by the compile-time separation test. */
export const setupInputFor = setupInput;
