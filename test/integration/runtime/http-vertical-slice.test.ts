/**
 * Acceptance: the vertical slice works over the **browser-independent**
 * path (Issue #63 criterion 1, Issue #90).
 *
 * ## Why this file exists
 *
 * `test/browser/runtime/playwright-vertical-slice.test.ts` used to live
 * here, under the default Vitest profile, and needed a real Chromium to
 * run. `npm run ci` runs the default profile, so the file turned
 * `npm run ci` red on every machine without Chromium's shared
 * libraries. It now lives in the browser profile, where a missing
 * browser is a loud failure by design.
 *
 * Moving it would have left the runtime with **no** coverage under the
 * default profile, which is a different regression: the profile every
 * developer and every CI job runs would stop exercising the runtime at
 * all. This file is what remains. The two files partition one claim:
 *
 * | claim | proven by |
 * | --- | --- |
 * | a real Chromium drives a real page | `test/browser/runtime/playwright-vertical-slice.test.ts` |
 * | the runtime's own decisions hold | this file |
 *
 * The split is the adapter, and the adapter is downstream of every
 * decision under test. What the World Operator provisions, what the
 * review layer materialises, which evidence handle a finding cites, what
 * gets persisted and what gets released are all decided before and
 * after the adapter is ever consulted. Driving them through
 * `HttpAdapter` against the same in-repo `src/demo/environment` server
 * keeps each assertion about one thing — a browser launch in the middle
 * of a policy assertion would make it fail for reasons unrelated to the
 * policy — while the environment stays real rather than mocked.
 *
 * ## The observable this file exists to prove
 *
 * A green `tsc` proves signatures, not behaviour, so each assertion
 * names a thing that could only be true if the whole chain really ran:
 *
 * | claim | observable |
 * | --- | --- |
 * | the environment was really reached | the run's observation names the demo server's own page title and its own ephemeral base URL |
 * | world setup really happened | the scripted connector counted exactly one `provision` call, and cleanup released it |
 * | a product finding was materialised | a #61 `Finding` exists whose evidence handles all resolve into the run's own `evidenceIds` |
 * | the durable lineage is complete | every record names Product, Environment, Review Program, Cohort and run |
 * | the participant stayed constrained | no `capability.violation` was recorded and the run terminated on `finish` |
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { runEvaluation } from '../../../src/runtime/index.js';
import {
  COHORT_ID,
  ENV_A,
  PROGRAM_ID,
  PRODUCT_ID,
  accountCreateStep,
  makeConnector,
  makeIdentity,
  makePlan,
  seedIdentities,
} from './support/fixtures.js';
import { buildHarness, startHarnessRoot, type HarnessRoot } from './support/harness.js';

let root: HarnessRoot;

beforeAll(async () => {
  root = await startHarnessRoot('u-sekai-runtime-http-slice-');
});

afterAll(async () => {
  await root.cleanup();
});

const ALICE = { id: 'idn-alice', lifecycle: 'persistent' as const };
const OBSERVER_FINDING = {
  id: 'obs-1',
  summary: 'The list gave no confirmation that the task had been saved.',
  severity: 'major' as const,
  category: 'confusion',
};

/** Every observation file the run wrote, in step order. */
async function observationFiles(artifactDir: string): Promise<ReadonlyArray<string>> {
  const dir = path.join(artifactDir, 'observations');
  const participants = await fs.readdir(dir);
  const files: string[] = [];
  for (const participant of participants) {
    const steps = await fs.readdir(path.join(dir, participant));
    for (const step of steps.filter((f) => f.endsWith('.json'))) {
      files.push(path.join('observations', participant, step));
    }
  }
  return files.sort();
}

describe('runtime vertical slice over the HTTP adapter', () => {
  it('reaches the environment, provisions permitted world state, and returns evidence-backed findings', async () => {
    const identity = makeIdentity(ALICE);
    const connector = makeConnector();
    const { config, baseUrl } = buildHarness(root, {
      identities: [ALICE],
      connector,
      steps: [accountCreateStep(identity.id)],
      observerFindings: [OBSERVER_FINDING],
      storeName: 'http-vertical-slice-store',
    });
    await seedIdentities(config.cohort, [identity]);

    const result = await runEvaluation(config, {
      plan: makePlan({
        environmentId: ENV_A,
        version: '2026.10.1',
        observedAt: '2026-10-01T00:00:00.000Z',
        delivery: 'http-slice-1',
      }),
      runId: 'run-http-slice-1',
    });

    // --- The environment was really reached. The observation is the
    // demo server's own page, fetched over the adapter interface: its
    // title and its ephemeral base URL are the server's, not a fixture's.
    const observations = await observationFiles(result.artifactDir);
    expect(observations.length).toBeGreaterThan(0);
    const first = JSON.parse(
      await fs.readFile(path.join(result.artifactDir, observations[0] as string), 'utf8'),
    ) as { url: string; title: string; visual: { visibleText: string } };
    expect(first.url).toBe(`${baseUrl}/`);
    expect(first.title).toBe('Task Tracker');
    expect(first.visual.visibleText).toContain('Add a task');

    // --- World setup happened, and exactly once.
    expect(result.setupRefused).toBe(false);
    expect(result.setup.status).toBe('provisioned');
    expect(connector.provisionCalls).toBe(1);
    expect(result.setup.resourceKeys).toEqual(['acct-primary']);

    // --- Cleanup went through the same gate and released the resource,
    // so the world this run created is not left behind.
    expect(result.cleanup?.status).toBe('cleaned');
    expect(connector.releaseCalls).toBe(1);
    expect(connector.liveResourceKeys()).toEqual([]);
    // The audit the caller receives covers the whole privileged
    // lifecycle of the run, not only the setup half: both the
    // application and the release are attributable.
    expect(result.operatorAudit.map((r) => r.kind)).toEqual([
      'planProvisioned',
      'stepRolledBack',
      'cleanupCompleted',
    ]);
    for (const record of result.operatorAudit) {
      expect(record.lineage.productId).toBe(PRODUCT_ID);
      expect(record.lineage.programId).toBe(PROGRAM_ID);
      expect(record.lineage.cohortId).toBe(COHORT_ID);
      expect(record.lineage.runId).toBe('run-http-slice-1');
    }

    // --- A product finding exists and it is a #61 Finding, projected
    // from the observer's own category and severity.
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    const finding = result.findings[0];
    expect(finding?.outcome).toBe('productFinding');
    expect(finding?.title).toBe(OBSERVER_FINDING.summary);
    expect(finding?.severity).toBe('high');
    expect(finding?.kind).toBe('comprehensionGap');
    expect(finding?.riskClass).toBe('usability');

    // --- Every evidence handle a finding cites is one the run produced,
    // so a reviewer following a citation lands inside this run.
    const produced = new Set(result.lineage.evidenceIds ?? []);
    expect(produced.size).toBeGreaterThan(0);
    for (const ref of finding?.evidenceRefs ?? []) {
      expect(produced.has(ref.id)).toBe(true);
      expect(ref.locator.length).toBeGreaterThan(0);
    }

    // --- The lineage names the durable scope the plan declared.
    expect(result.target.productId).toBe(PRODUCT_ID);
    expect(result.target.programId).toBe(PROGRAM_ID);
    expect(result.target.cohortId).toBe(COHORT_ID);
    expect(result.lineage.runId).toBe('run-http-slice-1');
    expect(result.lineage.identityIds).toEqual(['idn-alice']);
    expect(finding?.observedIn).toBe(result.lineage.runId);
    expect(finding?.identityIds).toEqual(['idn-alice']);
    expect(finding?.longitudinal.observed.runId).toBe(result.lineage.runId);

    // --- The artifact every locator points at really exists, so a
    // reviewer following a citation arrives at a file rather than a
    // dead reference.
    for (const ref of result.evidence) {
      const file = ref.locator.split('#')[0];
      if (file === undefined || file.length === 0) continue;
      await expect(fs.stat(path.join(result.artifactDir, file))).resolves.toBeDefined();
    }

    const reviewRecords = JSON.parse(
      await fs.readFile(path.join(result.artifactDir, 'review-records.json'), 'utf8'),
    ) as ReadonlyArray<{ outcome: string }>;
    expect(reviewRecords.some((r) => r.outcome === 'productFinding')).toBe(true);

    // --- No capability violation was recorded: the participant stayed
    // inside the human-facing primitive set for the whole run.
    const events = await fs.readFile(path.join(result.artifactDir, 'events.ndjson'), 'utf8');
    expect(events).toContain('idn-alice');
    expect(events).not.toContain('capability.violation');
    expect(result.observer.terminationVerdict.declared).toBe('finish');
  }, 60_000);
});
