/**
 * #66: the control plane cannot bypass #59's World Operator gate.
 *
 * "Respects the operator gate" is normally a convention, and this
 * project asks for the guarantee to be structural. So it is asserted
 * two ways, because either alone is weak:
 *
 * 1. **Statically — there is no edge.** `src/service/**` imports
 *    nothing from `src/operator/**`. Not the connector, not the
 *    operator, not a step type, not an error type. There is therefore
 *    no value in the control plane through which a privileged effect
 *    could be dispatched, and no code path to bypass. The assertion
 *    walks the real import graph of the real files rather than
 *    grepping for a string, so a new import edge fails the test even if
 *    it is spelled unexpectedly.
 * 2. **Behaviourally — a denial dispatches nothing.** A run whose plan
 *    declares a privileged step the policy does not grant produces a
 *    #61 `SetupFailure` and **zero** connector calls, observed from the
 *    control plane through its own run record. This is the property #59
 *    exists to provide, and the point of driving it through the control
 *    plane is that it is still true when the caller is a service rather
 *    than a person.
 *
 * The transitive graph deliberately *does* reach `src/operator/**` —
 * `src/service/executor.ts` imports `src/runtime/index.js`, which
 * imports the operator types — so the assertion is on **direct** edges
 * from a `src/service/**` file. That is the accurate claim: this
 * package holds no operator value, and the only way to make one happen
 * is to hand a plan to #63, which is where #59's gate sits.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isServiceError } from '../../../src/service/index.js';
import {
  accountCreateStep,
  buildService,
  buildStore,
  buildRuntimeExecutor,
  makeIdentity,
  makeObservation,
  manualTrigger,
  principal,
  registrationBody,
  startRuntimeRoot,
} from './support/fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const SERVICE_DIR = path.join(REPO_ROOT, 'src', 'service');
const OPERATOR_DIR = path.join(REPO_ROOT, 'src', 'operator');

/** Every `.ts` file directly under `dir`, recursively. */
async function tsFiles(dir: string): Promise<ReadonlyArray<string>> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await tsFiles(full)));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Relative import specifiers in a source file, `import` and `export ... from`. */
function relativeImports(source: string): ReadonlyArray<string> {
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"](\.[^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  return specifiers;
}

/** Block and line comments removed, so prose about a symbol is not a use of it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('#66 the control plane cannot bypass the World Operator gate', () => {
  it('has no import edge from src/service/** into src/operator/**', async () => {
    const serviceFiles = await tsFiles(SERVICE_DIR);
    expect(serviceFiles.length).toBeGreaterThan(5);

    const edges: string[] = [];
    for (const file of serviceFiles) {
      const source = await fs.readFile(file, 'utf8');
      for (const specifier of relativeImports(source)) {
        const resolved = path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts'));
        if (resolved.startsWith(OPERATOR_DIR + path.sep)) {
          edges.push(`${path.relative(REPO_ROOT, file)} -> ${specifier}`);
        }
      }
    }

    // Named rather than counted, so a failure says which edge appeared.
    expect(edges).toEqual([]);
  });

  it('uses no provisioning connector, operator or step type in its code', async () => {
    const serviceFiles = await tsFiles(SERVICE_DIR);
    const forbidden = [
      'ProvisioningConnector',
      'WorldOperator',
      'OperatorStep',
      'authorizeStep',
      'createWorldOperator',
      'runSetupPhase',
    ];
    const hits: string[] = [];
    for (const file of serviceFiles) {
      // Comments are stripped first: the module docstrings in
      // `src/service/**` *name* these symbols in order to say the
      // package never touches them, and a raw scan would flag its own
      // explanation of the guarantee. What is being asserted is a
      // **use**, not a mention.
      const code = stripComments(await fs.readFile(file, 'utf8'));
      for (const name of forbidden) {
        if (new RegExp(`\\b${name}\\b`).test(code)) {
          hits.push(`${path.relative(REPO_ROOT, file)}: ${name}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('a denied privileged step produces a SetupFailure and zero connector dispatches', async () => {
    const root = await startRuntimeRoot();
    try {
      const harness = await buildRuntimeExecutor(root, {
        identities: ['idn-ava'],
        // A plan that asks for a real privileged effect ...
        steps: [accountCreateStep(makeIdentity('idn-ava').id, root.server.baseUrl)],
        // ... under a policy that grants nothing.
        denyAll: true,
      });

      const service = buildService({
        dir: root.dir,
        store: buildStore(),
        executor: harness.executor,
        observations: [makeObservation()],
        clock: () => '2026-10-05T09:00:00.000Z',
      });
      service.registerProduct(principal(), registrationBody(harness.baseUrl, ['idn-ava']));
      const accepted = service.submitTriggerEvaluation(
        principal(),
        manualTrigger('jb-gate-denied', 'dlv-gate-denied', '2026-10-05T09:00:00.000Z'),
      );
      if (!accepted.accepted) throw new Error(`expected acceptance, got ${accepted.reason}`);

      await service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-gate-denied' });

      // The whole point: the gate refused, so nothing was dispatched.
      // Not "the dispatch failed" — nothing was attempted.
      expect(harness.connector.provisionCalls).toBe(0);

      const report = service.getFindings(principal(), {
        tenantId: 'tn-acme',
        jobId: 'jb-gate-denied',
      });
      // ...and the refusal is reported as a SetupFailure, not as a
      // successful run that happened to find nothing.
      expect(report.setupFailures.length).toBeGreaterThan(0);
      expect(report.runs[0]?.setupRefused).toBe(true);
      expect(report.runs[0]?.privilegedEffects).toMatchObject({ declared: true, refused: true });
    } finally {
      await root.cleanup();
    }
  });

  it('a granted privileged step does dispatch, so the zero above means "denied" and not "never tried"', async () => {
    const root = await startRuntimeRoot();
    try {
      const harness = await buildRuntimeExecutor(root, {
        identities: ['idn-ava'],
        steps: [accountCreateStep(makeIdentity('idn-ava').id, root.server.baseUrl)],
      });

      const service = buildService({
        dir: root.dir,
        store: buildStore(),
        executor: harness.executor,
        observations: [makeObservation()],
        clock: () => '2026-10-05T09:00:00.000Z',
      });
      service.registerProduct(principal(), registrationBody(harness.baseUrl, ['idn-ava']));
      const accepted = service.submitTriggerEvaluation(
        principal(),
        manualTrigger('jb-gate-granted', 'dlv-gate-granted', '2026-10-05T09:00:00.000Z'),
      );
      if (!accepted.accepted) throw new Error(`expected acceptance, got ${accepted.reason}`);

      await service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-gate-granted' });

      // The control case. Without it, `provisionCalls === 0` above
      // would also pass on a harness that never dispatched anything.
      expect(harness.connector.provisionCalls).toBeGreaterThan(0);
      const report = service.getFindings(principal(), {
        tenantId: 'tn-acme',
        jobId: 'jb-gate-granted',
      });
      expect(report.runs[0]?.setupRefused).toBe(false);
      expect(report.runs[0]?.privilegedEffects.auditRecordCount).toBeGreaterThan(0);
    } finally {
      await root.cleanup();
    }
  });

  it('refuses to run at all with no executor, so there is no ungated path around the runtime', async () => {
    const service = buildService({ dir: '/tmp/svc-gate-none', store: buildStore() });
    service.registerProduct(principal(), registrationBody('http://127.0.0.1:65535'));
    const accepted = service.submitTriggerEvaluation(
      principal(),
      manualTrigger('jb-gate-none', 'dlv-gate-none', '2026-10-05T09:00:00.000Z'),
    );
    if (!accepted.accepted) throw new Error('expected acceptance');

    try {
      await service.runJob(principal(), { tenantId: 'tn-acme', jobId: 'jb-gate-none' });
      throw new Error('expected a refusal');
    } catch (error) {
      if (!isServiceError(error)) throw error;
      expect(error.code).toBe('invalid-request');
      expect(error.message).toContain('cannot run a job without one');
    }
  });
});
