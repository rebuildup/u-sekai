/**
 * Acceptance: the vertical slice works against a **real** Playwright-backed
 * environment (Issue #63, criterion 1).
 *
 * ## The observable this file exists to prove
 *
 * A green `tsc` proves signatures, not behaviour, so each assertion here
 * names a thing that could only be true if the whole chain really ran:
 *
 * | claim | observable |
 * | --- | --- |
 * | the browser was really driven | the demo server's own HTML contains the task title the participant typed |
 * | the participant really was constrained | no `capability.violation` was recorded and the run terminated on `finish` |
 * | world setup really happened | the scripted connector counted exactly one `provision` call, and cleanup released it |
 * | a product finding was materialised | a #61 `Finding` exists whose evidence handles all resolve into the run's own `evidenceIds` |
 * | the durable lineage is complete | every record names Product, Environment, Review Program, Cohort and run |
 *
 * The demo server is the in-repo `src/demo/environment` app started on an
 * ephemeral port: a real HTTP server with real form posts, driven by a
 * real Chromium through `PlaywrightAdapter`. Nothing here mocks the
 * browser path.
 *
 * Coordinates come from `test/browser/support/demo.ts`, which reads them
 * off the rendered page through the observer view rather than hardcoding
 * them. Reusing that helper keeps the two browser-facing suites agreeing
 * about what "the Add button" is.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { PlaywrightAdapter } from '../../../src/adapter/browser/playwright-adapter.js';
import { assertBrowserRuntimeAvailable } from '../../browser/support/browser-runtime.js';
import { locateDemoControls, startDemoServer } from '../../browser/support/demo.js';
import { runEvaluation, defaultParticipantProfile } from '../../../src/runtime/index.js';
import type { RuntimeConfiguration } from '../../../src/runtime/index.js';
import type { SyntheticIdentity } from '../../../src/product/index.js';
import type { ParticipantAction } from '../../../src/domain/capability.js';
import {
  COHORT_ID,
  ENV_A,
  PROGRAM_ID,
  PRODUCT_ID,
  accountCreateStep,
  fixedClock,
  linkedOperatorClock,
  makeConnector,
  makeIdentity,
  makeModel,
  makePlan,
  makeService,
  makeTempDir,
  reasonerFactory,
  seedIdentities,
  stagingPolicy,
} from './support/fixtures.js';

const TITLE = 'Write the release notes';
const OBSERVER_FINDING = {
  id: 'obs-1',
  summary: 'The list gave no confirmation that the task had been saved.',
  severity: 'major' as const,
  category: 'confusion',
};

let server: Awaited<ReturnType<typeof startDemoServer>>;
let tempDir: string;

beforeAll(async () => {
  await assertBrowserRuntimeAvailable();
  server = await startDemoServer();
  const made = await makeTempDir('u-sekai-runtime-playwright-');
  tempDir = made.dir;
  afterAll(async () => {
    await made.cleanup();
  });
}, 180_000);

afterAll(async () => {
  await server?.close();
});

function buildConfig(overrides: Partial<RuntimeConfiguration> = {}): {
  config: RuntimeConfiguration;
  connector: ReturnType<typeof makeConnector>;
  service: ReturnType<typeof makeService>;
} {
  const clock = fixedClock();
  const connector = makeConnector();
  const service = makeService(path.join(tempDir, `store-${connector.connectorId}`), {
    now: fixedClock(),
  });

  return {
    connector,
    service,
    config: {
      model: makeModel({
        environments: [{ id: ENV_A, baseUrl: server.baseUrl }],
        identities: [{ id: 'idn-alice', lifecycle: 'persistent', displayName: 'Alice' }],
      }),
      cohort: service,
      experiment: {
        userStory: 'Add a task to the list.',
        outDir: path.join(tempDir, 'artifacts'),
        seed: 'runtime-63',
        maxStepsPerIdentity: 8,
        participantReasoner: { provider: 'scripted', seed: 'runtime-63' },
        observerReasoner: { provider: 'scripted', seed: 'runtime-63' },
      },
      setup: {
        policy: stagingPolicy(),
        connector,
        clock: linkedOperatorClock(clock),
        steps: [accountCreateStep(identity().id)],
        reason: 'issue 63 vertical slice',
      },
      adapterFactory: () => new PlaywrightAdapter(),
      reasonerFactory: reasonerFactory({ observerFindings: [OBSERVER_FINDING] }),
      now: clock,
      participantProfile: defaultParticipantProfile,
      ...overrides,
    },
  };
}

function identity(): SyntheticIdentity {
  return makeIdentity({ id: 'idn-alice', lifecycle: 'persistent', displayName: 'Alice' });
}

describe('runtime vertical slice against a real Playwright environment', () => {
  it('drives a real browser, provisions permitted world state, and returns evidence-backed findings', async () => {
    const controls = await locateDemoControls(server.baseUrl);
    const script: ReadonlyArray<ParticipantAction> = [
      { kind: 'clickByCoords', ...controls.titleInput },
      { kind: 'typeText', text: TITLE },
      { kind: 'clickByCoords', ...controls.addButton },
      { kind: 'wait', milliseconds: 150 },
      { kind: 'finish', reason: 'task added' },
    ];

    const { config, connector, service } = buildConfig({
      scriptFor: () => script,
    });
    await seedIdentities(service, [identity()]);

    const plan = makePlan({
      environmentId: ENV_A,
      version: '2026.10.1',
      observedAt: '2026-10-01T00:00:00.000Z',
    });

    const result = await runEvaluation(config, { plan, runId: 'run-alpha-1' });

    // --- The browser really drove the product. The demo server's own
    // rendered HTML is the evidence: a task exists that nobody in this
    // process created except through the constrained action surface.
    const html = await (await fetch(`${server.baseUrl}/`)).text();
    expect(html).toContain(TITLE);

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
      expect(record.lineage.runId).toBe('run-alpha-1');
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
    expect(result.lineage.runId).toBe('run-alpha-1');
    expect(result.lineage.identityIds).toEqual(['idn-alice']);
    expect(finding?.observedIn).toBe(result.lineage.runId);
    expect(finding?.identityIds).toEqual(['idn-alice']);
    expect(finding?.longitudinal.observed.runId).toBe(result.lineage.runId);

    // --- The artifact every locator points at really exists.
    await expect(
      fs.readFile(path.join(result.artifactDir, 'events.ndjson'), 'utf8'),
    ).resolves.toContain('idn-alice');
    const reviewRecords = JSON.parse(
      await fs.readFile(path.join(result.artifactDir, 'review-records.json'), 'utf8'),
    ) as ReadonlyArray<{ outcome: string }>;
    expect(reviewRecords.some((r) => r.outcome === 'productFinding')).toBe(true);

    // Every artifact path an evidence locator names really exists, so a
    // reviewer following a citation arrives at a file rather than a
    // dead reference.
    for (const ref of result.evidence) {
      const file = ref.locator.split('#')[0];
      if (file === undefined || file.length === 0) continue;
      await expect(fs.stat(path.join(result.artifactDir, file))).resolves.toBeDefined();
    }

    // --- No capability violation was recorded: the participant stayed
    // inside the human-facing primitive set for the whole run.
    const events = await fs.readFile(path.join(result.artifactDir, 'events.ndjson'), 'utf8');
    expect(events).not.toContain('capability.violation');
    expect(result.observer.terminationVerdict.declared).toBe('finish');
  }, 180_000);
});
