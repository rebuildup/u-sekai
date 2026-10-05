/**
 * #66 acceptance: Product -> Environment -> Program -> job -> findings
 * -> disposition, driven through the real runtime.
 *
 * This is the one test in the suite that runs the whole vertical slice
 * with #63's actual runtime, a real HTTP environment, a scripted
 * Reasoner and a scripted provisioning connector. Everything else in
 * `test/integration/service/**` uses the fake executor, because a
 * policy assertion should not fail because a browser did something
 * unexpected — but a test that claims "the control plane works" has to
 * be the one that would notice if it did not.
 *
 * Each step is asserted on its own observable rather than on "it got
 * to the end", so a failure names which link broke:
 *
 * | step | observable |
 * | --- | --- |
 * | Product + Environment registered | the stored model round-trips to #57's `ProductModel` |
 * | Review Program registered | the program's declared trigger and budget survive |
 * | job created | `queued`, `outcome.kind === 'notStarted'`, executor untouched |
 * | job executed | `succeeded`, one run record, lineage naming all four durable identities |
 * | findings retrievable | a #61 `Finding` carrying evidence, addressed to the right product |
 * | findings dispositionable | an accepted decision reaches the sink, and a replay does not double it |
 */

import { describe, expect, it } from 'vitest';

import { isFinding, isSetupFailure } from '../../../src/review/index.js';
import { isServiceError } from '../../../src/service/index.js';
import {
  accountCreateStep,
  buildRuntimeExecutor,
  buildService,
  buildStore,
  makeIdentity,
  makeObservation,
  manualTrigger,
  principal,
  PRODUCT_ID,
  registrationBody,
  startRuntimeRoot,
} from './support/fixtures.js';
import { feedbackSink } from './support/doubles.js';

const AT = '2026-10-05T09:00:00.000Z';

describe('#66 Product -> Environment -> Program -> job -> findings -> disposition', () => {
  it('carries one product all the way from registration to a customer decision', async () => {
    const root = await startRuntimeRoot();
    try {
      const harness = await buildRuntimeExecutor(root, {
        identities: ['idn-ava'],
        steps: [accountCreateStep(makeIdentity('idn-ava').id, root.server.baseUrl)],
        observerFindings: [
          {
            id: 'obs-confusion-1',
            summary: 'After entering a title the save control did not add a task to the list.',
            severity: 'major',
          },
        ],
      });
      const sink = feedbackSink();
      const service = buildService({
        dir: root.dir,
        store: buildStore(),
        executor: harness.executor,
        feedback: sink,
        observations: [makeObservation()],
        clock: () => AT,
      });
      const p = principal();

      // 1. Product + Environment (+ identities, cohort, program) registered.
      const model = service.registerProduct(p, registrationBody(harness.baseUrl, ['idn-ava']));
      expect(model.product.id).toBe(PRODUCT_ID);
      expect(model.environments.map((e) => e.id)).toEqual(['env-staging']);
      expect(model.environments[0]?.endpoint.baseUrl).toBe(harness.baseUrl);
      expect(model.programs[0]?.triggers).toEqual([{ kind: 'manual' }]);
      expect(model.programs[0]?.budget.maxRunsPerDay).toBe(100);
      // The stored model is what was registered, not a re-derivation.
      expect(service.getProduct(p, PRODUCT_ID)).toEqual(model);

      // 2. A job is created and nothing has run yet.
      const accepted = service.submitTriggerEvaluation(
        p,
        manualTrigger('jb-e2e-1', 'dlv-e2e-1', AT),
      );
      if (!accepted.accepted) throw new Error(`expected acceptance, got ${accepted.reason}`);
      expect(accepted.job.status).toBe('queued');
      expect(accepted.job.outcome).toEqual({ kind: 'notStarted' });

      // 3. The job runs through the real runtime.
      const job = await service.runJob(p, { tenantId: 'tn-acme', jobId: 'jb-e2e-1' });
      expect(job.status).toBe('succeeded');
      expect(job.outcome.kind).toBe('completed');

      // 4. Findings are retrievable, and they are real #61 findings.
      const report = service.getFindings(p, { tenantId: 'tn-acme', jobId: 'jb-e2e-1' });
      expect(report.definitive).toBe(true);
      expect(report.runs).toHaveLength(1);
      expect(report.findings.length).toBeGreaterThan(0);
      expect(report.findings.every((f) => isFinding(f))).toBe(true);
      expect(report.setupFailures.every((f) => isSetupFailure(f))).toBe(true);
      expect(report.setupFailures).toHaveLength(0);

      const finding = report.findings[0];
      if (finding === undefined) throw new Error('expected at least one finding');
      expect(finding.target.productId).toBe(PRODUCT_ID);
      expect(finding.evidenceRefs.length).toBeGreaterThan(0);
      // The lineage names Product, Environment, Review Program and the
      // identities that took part, from one value per run.
      expect(report.runs[0]?.lineage.productId).toBe(PRODUCT_ID);
      expect(report.runs[0]?.lineage.environmentId).toBe('env-staging');
      expect(report.runs[0]?.lineage.programId).toBe('rp-continuous');
      expect(report.runs[0]?.lineage.identityIds).toContain('idn-ava');

      // The privileged step was declared, granted, and dispatched.
      expect(report.runs[0]?.privilegedEffects).toMatchObject({
        declared: true,
        refused: false,
      });
      expect(report.runs[0]?.privilegedEffects.auditRecordCount).toBeGreaterThan(0);
      expect(harness.connector.provisionCalls).toBeGreaterThan(0);

      // The declared cost travelled with the run.
      expect(report.runs[0]?.cost).toEqual({
        amount: expect.any(Number),
        unit: 'svc.microcredits',
        reportableDecimals: 4,
      });
      expect((report.runs[0]?.cost.amount ?? 0)).toBeGreaterThan(0);

      // 5. The customer dispositions it, and a replay does not double it.
      const dispositionBody = {
        tenantId: 'tn-acme',
        requestId: 'req-e2e-1',
        productId: PRODUCT_ID,
        findingId: finding.id,
        dispositionId: 'dsp-e2e-1',
        kind: 'accepted',
        state: 'decided',
        actor: { kind: 'customer', reference: 'acme-support' },
        decidedAt: '2026-10-05T10:00:00.000Z',
      };
      const first = await service.submitDisposition(p, dispositionBody);
      expect(first.recorded).toBe(true);
      expect(first.duplicate).toBe(false);
      expect(first.previousState).toBe('unreviewed');

      const replay = await service.submitDisposition(p, dispositionBody);
      expect(replay.duplicate).toBe(true);
      expect(sink.appends).toHaveLength(1);

      // 6. The whole slice is still tenant-scoped at every step.
      const other = principal({ tenantId: 'tn-other' });
      try {
        service.getFindings(other, { tenantId: 'tn-other', jobId: 'jb-e2e-1' });
        throw new Error('expected a refusal');
      } catch (error) {
        if (!isServiceError(error)) throw error;
        expect(error.code).toBe('job-not-found');
      }
    } finally {
      await root.cleanup();
    }
  }, 60_000);

  it('records a run that found nothing as a definite zero, not as silence', async () => {
    const root = await startRuntimeRoot();
    try {
      const harness = await buildRuntimeExecutor(root, {
        identities: ['idn-ava'],
        // No observer findings: the scripted observer reports only its
        // own clean finish, which #63's classifier correctly refuses to
        // report as a product problem.
        observerFindings: [],
      });
      const service = buildService({
        dir: root.dir,
        store: buildStore(),
        executor: harness.executor,
        observations: [makeObservation()],
        clock: () => AT,
      });
      service.registerProduct(principal(), registrationBody(harness.baseUrl, ['idn-ava']));
      const accepted = service.submitTriggerEvaluation(
        principal(),
        manualTrigger('jb-e2e-clean', 'dlv-e2e-clean', AT),
      );
      if (!accepted.accepted) throw new Error(`expected acceptance, got ${accepted.reason}`);
      await service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-e2e-clean' });

      const report = service.getFindings(principal(), {
        tenantId: 'tn-acme',
        jobId: 'jb-e2e-clean',
      });
      expect(report.findings).toHaveLength(0);
      // The distinction this whole ticket turns on: the run happened,
      // and that is assertable.
      expect(report.runs).toHaveLength(1);
      expect(report.definitive).toBe(true);
      expect(report.unexecuted).toHaveLength(0);
    } finally {
      await root.cleanup();
    }
  }, 60_000);
});
