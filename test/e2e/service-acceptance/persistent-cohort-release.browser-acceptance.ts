/**
 * Issue #67 — the 0.4.0 service acceptance scenario.
 *
 * ## What this file is
 *
 * ADR-0011's evaluation mode 2, end to end and in a real browser: a
 * **persistent cohort experiences version A and then version B**, and
 * the change in behaviour, memory, confidence and mental model is
 * observable, evidence-backed, dispositioned and aggregated into KPI
 * primitives. This is the capstone of the 0.4.0 graph — it is what
 * proves the release is a usable vertical slice rather than a set of
 * disconnected abstractions.
 *
 * ## Every acceptance criterion in #67 maps to a named test
 *
 * | #67 criterion | test |
 * | --- | --- |
 * | fresh clone can run the documented example | `AC1 fresh clone can run the documented example` |
 * | the persistent identity remains the same across A -> B | `AC2 the persistent identity is the same Synthetic Identity across A -> B` |
 * | no privileged Operator action in Participant capabilities | `AC3 no privileged Operator action is reachable from a Participant` |
 * | the resulting finding has complete lineage/evidence | `AC4 the resulting finding carries complete lineage and evidence` |
 * | a disposition updates KPI primitives without changing the finding | `AC5 a customer disposition updates the KPI primitives and leaves the finding untouched` |
 * | the example explains what is simulated, no human representativeness | `AC6 the documented example states what is simulated and claims no human representativeness` |
 *
 * Scenario requirements from the same issue are covered by
 * `SR1..SR4` below, and each names the specific observable it depends
 * on. A criterion whose observable were never reached would still be
 * listed as passing, which is the failure this file is written against;
 * `SR0` below is the check that the scenario really executed.
 *
 * ## SR0 — proof the scenario ran at all
 *
 * Everything downstream depends on the runs having happened, so the
 * first test asserts that *before* anything else: a real Chromium was
 * available, both environments answered HTTP 200, the two cohorts
 * actually drove the participant loop, and the durable store holds
 * observations for the identities that ran. A scenario that never
 * executed cannot satisfy any of the other tests, but it can silently
 * make them vacuous if they only inspect the report object — so the
 * report is not treated as evidence of itself.
 *
 * ## What this scenario cannot prove, and says so
 *
 * `RunLineage` (#57) carries no version identity (Issue #83), so no
 * record on a finding can demonstrate that a *version* boundary was
 * crossed rather than one deployment observed twice. This file
 * therefore makes two separate, smaller claims and names which is
 * which: the **environment** boundary is on the lineage and is asserted
 * there, and the **version** boundary is asserted where it does exist —
 * the durable cohort state and the transition journal. The
 * `environment instance identity` test asserts both instance keys, and
 * `AC2` asserts both versions on the durable record.
 *
 * `openTransition` / `closeTransition` are not guarded against a
 * concurrent run of the same `release` identity (Issue #103), so this
 * scenario's "the same identity spanned A and B" claim is about a
 * sequential execution and says nothing about what two concurrent runs
 * of one identity would do.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertNoSharedMutableState } from '../../../examples/continuous-product-evaluation/environment/index.js';
import type { ParticipantExecutionContext } from '../../../src/runtime/index.js';
import { isReleaseTransitionComparison } from '../../../src/product/index.js';
import { resolveDispositionLineage } from '../../../src/review/index.js';
import { assertBrowserRuntimeAvailable } from '../../browser/support/browser-runtime.js';
import { repoRoot } from './routing/profile-include.js';

import {
  ENV_A,
  ENV_B,
  ENVIRONMENT_NAME,
  EPHEMERAL_ID,
  LONGITUDINAL_TITLE,
  MIXED_EPHEMERAL_TASK,
  MIXED_PERSISTENT_TASK,
  PERSISTENT_ID,
  RETURNING_COHORT_ID,
  RETURNING_ID,
  TASK_CREATED_IN_A,
  TASK_CREATED_IN_B,
  VERSION_A,
  VERSION_B,
  executeAcceptanceScenario,
  resolveEvidenceFiles,
  type AcceptanceReport,
} from '../../fixtures/service-acceptance/scenario.js';
import { stableStringify } from '../../fixtures/service-acceptance/harness.js';
import {
  CUSTOMER_ACTOR,
  emptyLedger,
  kpiFromOutcomes,
  makeDisposition,
  recordDisposition,
} from '../../fixtures/service-acceptance/feedback.js';
import * as exampleEntryPoint from '../../../examples/continuous-product-evaluation/run-acceptance.js';
import { REPORT_ENV_VAR, renderReport, summarise } from '../../../examples/continuous-product-evaluation/run-acceptance.js';

/**
 * Compiled, not merely checked.
 *
 * `AssertNever<T extends never>` fails to compile the moment `T` is
 * not `never`, so adding an `operator` field to
 * `ParticipantExecutionContext` breaks `npm run typecheck` instead of
 * quietly widening what a participant run is handed.
 */
type AssertNever<T extends never> = T;
export type ParticipantContextCarriesNoOperator = AssertNever<
  Extract<
    'operator' | 'connector' | 'cohort' | 'setup' | 'store' | 'provision' | 'worldOperator',
    keyof ParticipantExecutionContext
  >
>;

const EXAMPLE_COMMAND = 'node --import tsx examples/continuous-product-evaluation/run-acceptance.ts';
/** The declared World Operator resource the returning cohort's run provisioned. */
const RETURNING_ACCOUNT_KEY = 'acct-returning-leo';
const EXAMPLE_README = 'examples/continuous-product-evaluation/README.md';

let report: AcceptanceReport;
let apiKeyBefore: string | undefined;

beforeAll(async () => {
  await assertBrowserRuntimeAvailable();

  // The scenario is required to run with no external API key (ADR-0011
  // and CLAUDE.md §3). Removing the variable for the duration of the
  // suite makes that a falsifiable claim: if any part of the chain ever
  // reached a live provider, the run would fail here rather than quietly
  // succeeding on a machine that happened to export a key.
  apiKeyBefore = process.env['ANTHROPIC_API_KEY'];
  delete process.env['ANTHROPIC_API_KEY'];

  report = await executeAcceptanceScenario();

  // The documented command (`examples/.../run-acceptance.ts`) sets this
  // so the run prints the report its README promises a reader. Printed
  // from `beforeAll` rather than from a test, so the output appears even
  // if every assertion below is later removed.
  if (process.env[REPORT_ENV_VAR] === '1') {
    process.stdout.write(`${renderReport(summarise(report))}\n`);
  }
}, 600_000);

// `report` is unassigned when `beforeAll` failed; restoring the key has
// to happen either way, and closing the two live environments has to
// happen only once.
afterAll(async () => {
  await report?.teardown();
  if (apiKeyBefore === undefined) {
    delete process.env['ANTHROPIC_API_KEY'];
  } else {
    process.env['ANTHROPIC_API_KEY'] = apiKeyBefore;
  }
});

describe('#67 0.4.0 service acceptance: a persistent cohort across A -> B', () => {
  it('SR0 the scenario really executed: a browser ran, both environments answered, and the durable store holds the runs', async () => {
    const { mixed, baseline, comparison, scenario } = report;

    // A real browser was available and was used. The adapter id is the
    // Playwright one, and the run recorded observations rather than a
    // setup failure.
    expect(mixed.run.startedAt < mixed.run.endedAt).toBe(true);
    expect(mixed.run.setupRefused).toBe(false);
    expect(mixed.run.setupFailures).toEqual([]);
    expect(mixed.run.observer.summary).not.toContain('unavailable');

    // Both cohort members were actually driven, at the step budget the
    // scenario declared, and each produced a real observation.
    expect(mixed.run.resolvedCohort.members.map((m) => m.id).sort()).toEqual(
      [EPHEMERAL_ID, PERSISTENT_ID].sort(),
    );
    expect(mixed.run.evidence.length).toBeGreaterThan(0);

    // The two environments both answered over HTTP. `readWorld` throws
    // on a non-2xx, so reaching this line at all is the assertion; the
    // titles are the positive evidence that each served real content.
    expect(scenario.pair.before.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(scenario.pair.after.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(scenario.pair.before.baseUrl).not.toBe(scenario.pair.after.baseUrl);
    expect(baseline.world.titles).toContain(TASK_CREATED_IN_A);
    expect(comparison.worldB.titles).toContain(TASK_CREATED_IN_B);

    // The durable store holds one observation per run, per identity —
    // read through a service opened over the same directory.
    expect(baseline.stateAfterA.observations).toHaveLength(1);
    expect(comparison.stateAfterB.observations).toHaveLength(2);
  }, 600_000);

  it('SR1 provisions accounts through the World Operator boundary and releases them at cleanup', () => {
    const { mixed, baseline, comparison, scenario } = report;

    // Provisioning went through the declared plan and was authorised by
    // the policy, once per cohort member.
    expect(mixed.run.setup.status).toBe('provisioned');
    expect([...mixed.run.setup.resourceKeys].sort()).toEqual([
      'acct-ephemeral-nova',
      'acct-persistent-iris',
    ]);
    expect(baseline.run.setup.status).toBe('provisioned');
    expect(baseline.run.setup.resourceKeys).toEqual(['acct-returning-leo']);
    expect(comparison.run.setup.status).toBe('provisioned');
    expect(comparison.run.setup.resourceKeys).toEqual(['acct-returning-leo']);

    // Cleanup ran through the same gate and released what setup made, so
    // the world these runs created is not left live.
    for (const run of [mixed.run, baseline.run, comparison.run]) {
      expect(run.cleanup?.status).toBe('cleaned');
      expect(run.operatorAudit.map((r) => r.kind)).toContain('cleanupCompleted');
    }

    // The audit names the durable scope, so a privileged effect is
    // attributable to the exact product / program / cohort / run that
    // caused it.
    for (const record of comparison.run.operatorAudit) {
      expect(record.lineage.productId).toBe('prd-task-tracker');
      expect(record.lineage.programId).toBe('rp-transition');
      expect(record.lineage.cohortId).toBe(RETURNING_COHORT_ID);
      expect(record.lineage.runId).toBe('run-returning-version-b');
      expect(record.lineage.environmentId).toBe(ENV_B);
    }

    // The authority policy the runs used was written against the two
    // live origins, which is the only reason rule 7 let the step
    // through at all.
    expect(scenario.pair.after.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('SR2 one ephemeral and one persistent cohort coexist, and only the persistent one retains', () => {
    const { mixed } = report;

    // Both lifecycles are in the *same* cohort, in the same run. This is
    // not two runs compared afterwards: the resolved cohort itself names
    // both.
    expect(mixed.run.resolvedCohort.lifecycles).toEqual(['ephemeral', 'persistent']);
    expect(mixed.run.mode).toBe('continuous');

    // The retention divergence is the observable, read back from the
    // durable store: an ephemeral identity retains nothing at all, a
    // persistent one carries its interaction count forward.
    expect(mixed.ephemeralState.retainedState).toBeUndefined();
    expect(mixed.persistentState.retainedState).toBeDefined();
    expect(mixed.persistentState.retainedState?.interactionCount).toBe(1);

    // Both recorded the run. The difference is what they kept, not
    // whether they were observed.
    expect(mixed.ephemeralState.observations).toHaveLength(1);
    expect(mixed.persistentState.observations).toHaveLength(1);
    expect(mixed.ephemeralState.observations[0]).toMatchObject({
      environmentId: ENV_A,
      version: VERSION_A,
      runId: 'run-mixed-version-a',
    });

    // Each of them really drove the browser into the shared world, so
    // the mixed cohort is not a claim about two identities that were
    // declared and never run.
    expect(mixed.worldAfter.titles).toContain(MIXED_PERSISTENT_TASK);
    expect(mixed.worldAfter.titles).toContain(MIXED_EPHEMERAL_TASK);
  });

  it('SR3 browser-backed interaction: every run was driven by a real Chromium, with no capability violation', async () => {
    for (const run of [report.mixed.run, report.baseline.run, report.comparison.run]) {
      // No `capability.violation` anywhere in the run's own trace: the
      // participant stayed inside the human-facing primitive set.
      const events = await fs.readFile(path.join(run.artifactDir, 'events.ndjson'), 'utf8');
      expect(events, `${run.runId} recorded a capability violation`).not.toContain(
        'capability.violation',
      );
      // The participant really opened the environment: the trace
      // carries an `observation.captured` for every member.
      expect(events).toContain('observation.captured');
      expect(events).toContain('action.result');
      // And the observer, a separate context, saw that trace and
      // produced a report rather than declining.
      expect(run.observer.terminationVerdict.declared).toBe('finish');
      expect(run.observer.summary).not.toContain('unavailable');
    }

    // A real screenshot artifact, produced by the browser, for the
    // returning cohort's run in version B.
    const artifacts = await fs.readdir(report.comparison.run.artifactDir);
    expect(artifacts.length).toBeGreaterThan(0);
    expect(artifacts).toContain('events.ndjson');
  });

  it('SR4 the A -> B transition moved an observable pointer, was recorded durably, and is idempotent', async () => {
    const { promotion, scenario, baseline } = report;
    const { pair } = scenario;

    // "Never started" is an *observed* state, read before the promotion
    // ran. The transition store returns a discriminated union precisely
    // so this cannot be confused with "committed".
    expect(promotion.before.status).toBe('never-started');

    // The pointer moved, and it is observable through the pair.
    expect(promotion.applied).toBe(true);
    expect(pair.active()).toBe(pair.after);
    expect(promotion.activeVersionAfter).toBe(VERSION_B);
    expect(promotion.activeVersionAfter).not.toBe(VERSION_A);

    // It was recorded durably, and the record was re-read from the
    // store rather than taken from the return value.
    expect(promotion.reread.status).toBe('committed');
    if (promotion.reread.status !== 'committed') return;
    expect(promotion.reread.record.cohortId).toBe(RETURNING_COHORT_ID);
    expect(promotion.reread.record.fromVersion).toBe(VERSION_A);
    expect(promotion.reread.record.toVersion).toBe(VERSION_B);
    expect(promotion.reread.record.fromKey).toBe(pair.before.key);
    expect(promotion.reread.record.toKey).toBe(pair.after.key);

    // The journal on disk really contains a commit envelope naming both
    // endpoints. A commit that exists only in the return value would be
    // a success report about a transition nobody could recover.
    const journal = await fs.readdir(scenario.transitionStore.rootDir);
    expect(journal.length).toBeGreaterThan(0);
    const committed = await Promise.all(
      journal.map(async (name) => fs.readFile(path.join(scenario.transitionStore.rootDir, name), 'utf8')),
    );
    const commitEnvelope = committed.find((text) => text.includes('"phase": "commit"'));
    expect(commitEnvelope, 'no committed envelope was written to the transition journal').toBeDefined();
    expect(commitEnvelope).toContain(pair.before.key);
    expect(commitEnvelope).toContain(pair.after.key);
    expect(commitEnvelope).toContain(VERSION_A);
    expect(commitEnvelope).toContain(VERSION_B);

    // The baseline version survives the promotion. Promotion moves a
    // pointer; it does not overwrite the earlier deployment, and any
    // evidence gathered against A stays evidence about something that
    // still exists.
    expect(promotion.baselineVersionStillAnswering).toBe(true);
    expect(promotion.worldAUnchangedByPromotion.titles).toEqual(baseline.world.titles);
    expect(promotion.worldAUnchangedByPromotion.titles).toContain(TASK_CREATED_IN_A);

    // Applying it again is observably a re-run, not a second
    // transition: same key, same record, `applied: false`.
    expect(promotion.reapplyApplied).toBe(false);
  });

  it('SR5 the two environments instance identities are distinct versions of one declared environment, and share no mutable state', () => {
    const { scenario, isolation, baseline, comparison } = report;
    const { pair } = scenario;

    // Two instances, one environment name, two versions. This is the
    // distinction #69 exists for: without a concrete runnable instance
    // there is nothing for an A-versus-B comparison to point at.
    expect(isolation.keysDiffer).toBe(true);
    expect(isolation.declaredNames).toEqual(['staging', 'staging']);
    expect(isolation.declaredVersions).toEqual([VERSION_A, VERSION_B]);
    expect(pair.before.key).toMatch(/^envkey-[0-9a-f]{64}$/);
    expect(pair.after.key).toMatch(/^envkey-[0-9a-f]{64}$/);
    expect(pair.before.declaration.product).toBe(pair.after.declaration.product);
    expect(pair.before.declaration.seed).toBe(pair.after.declaration.seed);

    // The branded `ProductId` survives the trip into #69's declaration
    // as a *value*, even though #69's type does not carry the brand.
    // Asserted rather than cast, because a cast here would be the only
    // thing making it compile.
    expect(pair.before.declaration.product).toBe('prd-task-tracker');
    expect(pair.after.declaration.product).toBe(pair.before.declaration.product);
    // `name` is #69's own declared environment name, not #57's
    // `EnvironmentId`: #69 shipped it as a `string` because `src/product`
    // was absent from its base. This scenario carries the real branded
    // types and could adopt them, but doing so is a change to #69's
    // public declaration, not something a test may decide.
    expect(pair.before.declaration.name).toBe(ENVIRONMENT_NAME);

    // The structural check, called directly rather than trusted to have
    // been called by the pair constructor. A version B that silently
    // inherited version A's state would make every longitudinal finding
    // a comparison of a thing against itself.
    expect(() => assertNoSharedMutableState(pair.before, pair.after)).not.toThrow();

    // The behavioural complement: after version B's participant wrote
    // through a real browser, the two worlds are still disjoint, and
    // each still holds exactly what its own participant put there.
    expect(comparison.worldB.titles).toContain(TASK_CREATED_IN_B);
    expect(comparison.worldB.titles).not.toContain(TASK_CREATED_IN_A);
    expect(comparison.worldAAfter.titles).toContain(TASK_CREATED_IN_A);
    expect(comparison.worldAAfter.titles).not.toContain(TASK_CREATED_IN_B);
    expect(comparison.worldAAfter.titles).toEqual(baseline.world.titles);
  });

  it('AC2 the persistent identity is the same Synthetic Identity across A -> B', () => {
    const { baseline, comparison } = report;
    const before = baseline.stateAfterA;
    const after = comparison.stateAfterB;

    // The same durable identity, not a lookalike: same id, same
    // declared lifecycle, same state reference.
    expect(before.identity.id).toBe(RETURNING_ID);
    expect(after.identity.id).toBe(before.identity.id);
    expect(after.identity.lifecycle).toBe('release');
    expect(after.identity.stateRef).toBe(before.identity.stateRef);
    expect(after.identity.displayName).toBe(before.identity.displayName);

    // Both versions are on the durable record, in the order they
    // happened, each naming the run that observed it. This is where the
    // *version* boundary is observable, because `RunLineage` does not
    // carry one (Issue #83).
    expect(after.observations.map((o) => `${o.environmentId}@${o.version}`)).toEqual([
      `${ENV_A}@${VERSION_A}`,
      `${ENV_B}@${VERSION_B}`,
    ]);
    expect(after.observations.map((o) => o.runId)).toEqual([
      'run-returning-version-a',
      'run-returning-version-b',
    ]);

    // The release window the runtime opened before version B and closed
    // after it is still on the record, with both versions on it.
    expect(after.releaseWindow?.fromVersion).toBe(VERSION_A);
    expect(after.releaseWindow?.toVersion).toBe(VERSION_B);
    expect(after.releaseWindow?.closedAt).toBeDefined();
    expect(comparison.run.persistence.closedTransitions).toEqual([RETURNING_ID]);

    // #60's rule: the transition-scoped retained state is gone once the
    // transition closed. The identity returned; it did not accumulate
    // across the boundary.
    expect(after.retainedState).toBeUndefined();

    // The two runs are a release-transition comparison by #57's own
    // predicate, and the run recorded the comparison it made.
    expect(
      isReleaseTransitionComparison(baseline.run.lineage, comparison.run.lineage),
      'the two runs are not a joinable release-transition comparison, so nothing about a ' +
        'returning cohort can be claimed from them',
    ).toBe(true);
    expect(comparison.run.mode).toBe('releaseTransition');
    expect(comparison.run.lineage.environmentId).toBe(ENV_B);
    expect(baseline.run.lineage.environmentId).toBe(ENV_A);
    expect(comparison.run.lineage.identityIds).toEqual([RETURNING_ID]);
  });

  it('AC3 no privileged Operator action is reachable from a Participant', () => {
    const { comparison } = report;
    const result = comparison.run;

    // The setup phase reports which connector acted, by identity only.
    // One string, and nothing that could dispatch.
    expect(Object.keys(result.setup.connector)).toEqual(['connectorId']);
    expect(result.setup.connector.connectorId).toBe('acceptance-connector');

    // No value reachable from the returned result carries `provision` or
    // `release` — the whole privileged effect surface. Walked rather
    // than spot-checked, because a spot check is a sample and a sample
    // is how a leak survives.
    const seen = new Set<unknown>();
    const walk = (value: unknown, depth: number, path: string): void => {
      if (value === null || typeof value !== 'object' || depth > 8) return;
      if (seen.has(value)) return;
      seen.add(value);
      const record = value as Record<string, unknown>;
      for (const method of ['provision', 'release', 'applyStep']) {
        if (typeof record[method] === 'function') {
          throw new Error(
            `a privileged dispatch method "${method}" is reachable from the evaluation result at ${path}`,
          );
        }
      }
      for (const [key, nested] of Object.entries(record)) walk(nested, depth + 1, `${path}.${key}`);
    };
    walk(result, 0, 'EvaluationRunResult');

    // The audit records the authority that was exercised, not a handle
    // that could be exercised again.
    for (const record of result.operatorAudit) {
      expect(Object.keys(record).sort()).toEqual(
        expect.arrayContaining(['connectorId', 'kind', 'lineage']),
      );
      expect(record.connectorId).toBe('acceptance-connector');
    }

    // And the declared step was the *only* privileged dispatch: the
    // returning cohort's account, named by the declared resource key,
    // and nothing else. The participant's five browser actions added
    // none.
    expect(result.setup.resourceKeys).toEqual([RETURNING_ACCOUNT_KEY]);
    expect(result.setup.spendUnits).toBe(1);
  });

  it('AC4 the resulting finding carries complete lineage and evidence', async () => {
    const { comparison, baseline } = report;
    const findings = comparison.findings;

    // Exactly the longitudinal finding, and nothing else. A second
    // unaccounted-for finding would mean the observer reported
    // something the scenario cannot account for.
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (finding === undefined) return;
    expect(finding.outcome).toBe('productFinding');
    expect(finding.title).toBe(LONGITUDINAL_TITLE);
    expect(finding.kind).toBe('trustDefect');
    expect(finding.severity).toBe('high');
    expect(finding.riskClass).toBe('security');

    // Lineage: the durable scope, the run, and the identity.
    expect(finding.target.productId).toBe('prd-task-tracker');
    expect(finding.target.programId).toBe('rp-transition');
    expect(finding.target.cohortId).toBe(RETURNING_COHORT_ID);
    expect(finding.target.environmentId).toBe(ENV_B);
    expect(finding.observedIn).toBe('run-returning-version-b');
    expect(finding.identityIds).toEqual([RETURNING_ID]);
    expect(finding.longitudinal.observed.runId).toBe('run-returning-version-b');
    expect(finding.longitudinal.observed.environmentId).toBe(ENV_B);

    // The comparative claim is present and names the earlier run.
    expect(finding.longitudinal.mode).toBe('releaseTransition');
    expect(finding.longitudinal.baseline?.runId).toBe('run-returning-version-a');
    expect(finding.longitudinal.baseline?.environmentId).toBe(ENV_A);

    // The change is `unknown`, and that is the honest value rather than
    // a shortfall in the assertion. The version-A run produced no
    // finding, so there was nothing for the join to compare against, and
    // #61's rule is that anything short of a real join is `unknown`
    // ("we did not compare") rather than a guess. Asserting `introduced`
    // here would be a claim the evidence does not support. What a
    // non-empty baseline would produce is pinned as a pure-function
    // control in `control-cases.browser-acceptance.ts`.
    expect(baseline.run.findings).toHaveLength(0);
    expect(finding.longitudinal.change).toBe('unknown');

    // Evidence: non-empty, at least one supporting citation, and every
    // citation is one this run produced.
    expect(finding.evidenceRefs.length).toBeGreaterThan(0);
    expect(finding.evidenceRefs.some((r) => r.stance === 'supports')).toBe(true);
    for (const ref of finding.evidenceRefs) {
      expect(ref.locator.length).toBeGreaterThan(0);
      expect(comparison.run.lineage.evidenceIds).toContain(ref.id);
    }

    // Every locator names a file that exists in the run's artifact, so a
    // reviewer following a citation arrives at a file.
    const resolved = await resolveEvidenceFiles(
      comparison.run.artifactDir,
      finding.evidenceRefs.map((r) => r.locator),
    );
    expect(resolved.length).toBeGreaterThan(0);
    for (const entry of resolved) {
      expect(entry.exists, `${entry.locator} does not resolve to a file in the run artifact`).toBe(
        true,
      );
    }

    // Affected conditions are non-empty, and the confidence is the
    // weakest the contract admits rather than a calibrated number.
    expect(finding.affectedConditions.length).toBeGreaterThan(0);
    expect(finding.confidence.level).toBe('low');
    expect(finding.confidence.calibration.calibrated).toBe(false);

    // The run had no setup failures, so no setup failure can be hiding
    // inside the finding set.
    expect(comparison.run.setupFailures).toEqual([]);
    expect(comparison.run.outcomes.every((o) => o.outcome === 'productFinding')).toBe(true);

    // The observer really read the trace: its summary says what it saw.
    expect(comparison.run.observer.summary).toContain('carried a task from an earlier version');
  });

  it('AC5 a customer disposition updates the KPI primitives and leaves the finding untouched', () => {
    const { comparison } = report;
    const finding = comparison.findings[0];
    if (finding === undefined) throw new Error('the comparison run produced no finding to disposition');

    // The finding, byte for byte, before any customer decision exists.
    const before = stableStringify(finding);

    // --- Before: nothing is decided, and the KPI says so with a named
    // denominator rather than a zero that could also mean "we did not
    // look".
    const emptyKpi = kpiFromOutcomes(comparison.run.outcomes, emptyLedger());
    expect(emptyKpi.undispositionedFindingIds).toEqual([finding.id]);
    expect(emptyKpi.acceptedFindingCount.value).toBe(0);
    expect(emptyKpi.findingAcceptanceRate.defined).toBe(false);
    expect(emptyKpi.findingAcceptanceRate.reason).toBe('emptyDenominator');
    expect(emptyKpi.findingAcceptanceRate.basis.noDisposition).toBe(1);
    expect(emptyKpi.findingAcceptanceRate.basis.customerDecisions).toBe(0);

    // --- The customer decides, and records it as a customer.
    const disposition = makeDisposition({
      findingId: finding.id,
      kind: 'accepted',
      state: 'decided',
      dispositionId: 'dsp-acceptance-67-1',
      decidedAt: '2026-10-10T09:00:00.000Z',
      rationale:
        'Confirmed against the customer: the list in the newer version does not carry the ' +
        'returning user\'s task forward, and nothing on the page says why.',
      action: { kind: 'issue', reference: 'u-sekai#67', label: 'Returning-user state across a version change' },
    });
    const ledger = recordDisposition(emptyLedger(), disposition);

    // --- The finding did not change. Not "the fields we looked at": the
    // whole serialised record, compared before and after.
    expect(stableStringify(finding)).toBe(before);

    // The disposition is a *reference*, never a copy. A disposition that
    // carried the finding's own text could go stale relative to the
    // finding it judges.
    const dispositionKeys = Object.keys(disposition).sort();
    expect(dispositionKeys).toEqual(
      ['action', 'decidedAt', 'findingId', 'id', 'kind', 'rationale', 'state', 'actor'].sort(),
    );
    expect(disposition.actor).toEqual({ kind: 'customer', reference: CUSTOMER_ACTOR });
    expect(disposition.findingId).toBe(finding.id);

    // And the reference resolves back to the very finding.
    const lineage = resolveDispositionLineage(disposition, comparison.findings);
    expect(lineage.finding.id).toBe(finding.id);
    expect(lineage.finding.title).toBe(LONGITUDINAL_TITLE);
    expect(lineage.evidenceRefs).toBe(finding.evidenceRefs);
    expect(lineage.isDecision).toBe(true);
    expect(lineage.runId).toBe('run-returning-version-b');

    // --- The ledger recorded it as a first decision, out of
    // `unreviewed`, not as a correction.
    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0]?.sequence).toBe(1);
    expect(ledger.events[0]?.fromState).toBe('unreviewed');
    expect(ledger.events[0]?.isCorrection).toBe(false);
    expect(ledger.events[0]?.findingId).toBe(finding.id);

    // --- After: the KPI primitives moved, and the finding is untouched.
    const kpi = kpiFromOutcomes(comparison.run.outcomes, ledger);
    const basis = kpi.findingAcceptanceRate.basis;
    expect(basis.totalFindings).toBe(1);
    expect(basis.customerDecisions).toBe(1);
    expect(basis.noDisposition).toBe(0);
    expect(basis.openDisposition).toBe(0);
    expect(kpi.undispositionedFindingIds).toEqual([]);

    expect(kpi.acceptedFindingCount.value).toBe(1);
    expect(kpi.acceptedFindingCount.findingIds).toEqual([finding.id]);
    expect(kpi.findingAcceptanceRate.defined).toBe(true);
    expect(kpi.findingAcceptanceRate.numerator).toBe(1);
    expect(kpi.findingAcceptanceRate.denominator).toBe(1);
    expect(kpi.findingAcceptanceRate.value).toBe(1);
    expect(kpi.findingAcceptanceRate.numeratorFindingIds).toEqual([finding.id]);
    expect(kpi.falsePositiveRate.value).toBe(0);
    expect(kpi.actionRate.value).toBe(1);
    expect(kpi.actionRate.numeratorFindingIds).toEqual([finding.id]);
    expect(kpi.dispositionCoverage.value).toBe(1);
    expect(kpi.byKind.accepted).toBe(1);

    // No setup failure was silently folded into a rate.
    expect(kpi.excludedSetupFailures).toEqual([]);

    // Cost KPIs stay *undefined*, with a named reason. A `null` read as
    // zero is the anti-metric this layer exists to prevent.
    expect(kpi.costPerAcceptedFinding.defined).toBe(false);
    expect(kpi.costPerAcceptedFinding.reason).toBe('noCostData');

    // The finding is still exactly what it was.
    expect(stableStringify(finding)).toBe(before);
  });

  it('AC1 fresh clone can run the documented example', async () => {
    // The documented command runs the file the README names...
    const readme = await fs.readFile(path.join(repoRoot, EXAMPLE_README), 'utf8');
    expect(readme).toContain(EXAMPLE_COMMAND);
    // ...that file exists...
    await expect(
      fs.stat(path.join(repoRoot, 'examples/continuous-product-evaluation/run-acceptance.ts')),
    ).resolves.toBeDefined();
    // ...and the file it delegates to is *this* file, compared by
    // resolved path rather than by a matching name. A parallel
    // implementation behind the documentation would make "the example
    // runs" unfalsifiable: the command would succeed while exercising
    // something the acceptance criteria never see.
    expect(path.resolve(repoRoot, exampleEntryPoint.SCENARIO_SPEC)).toBe(
      fileURLToPath(import.meta.url),
    );
    expect(exampleEntryPoint.BROWSER_PROFILE_CONFIG).toBe('test/vitest.browser.config.ts');
    expect(typeof exampleEntryPoint.main).toBe('function');
    expect(typeof exampleEntryPoint.summarise).toBe('function');

    // The example's own reporting path is exercised here rather than
    // left as an unreached export: a summary that reported "everything
    // fine" over a scenario that observed nothing is the exact failure
    // this repository keeps meeting.
    const summary = summarise(report);
    expect(
      summary.unmetExpectations,
      `the example's summary reported unmet expectations: ${summary.unmetExpectations.join('; ')}`,
    ).toEqual([]);
    expect(summary.stages.length).toBeGreaterThan(0);
    expect(summary.findings).toHaveLength(1);
    expect(renderReport(summary)).toContain('Simulated, not human');

    // The report the example would print is the one under assertion
    // here, and it is not empty: the example's own stages are populated.
    // Zero findings, zero observations or an empty world would all mean
    // the documented command produces a report that says nothing while
    // exiting successfully.
    expect(report.comparison.findings.length).toBeGreaterThan(0);
    expect(report.comparison.stateAfterB.observations.length).toBeGreaterThan(0);
    expect(report.comparison.worldB.titles.length).toBeGreaterThan(0);
    expect(report.baseline.world.titles.length).toBeGreaterThan(0);
  });

  it('AC6 the documented example states what is simulated and claims no human representativeness', async () => {
    const readme = await fs.readFile(path.join(repoRoot, EXAMPLE_README), 'utf8');

    // ADR-0011's non-reality boundary, in the example a reader runs
    // first: Synthetic Users are exploratory instruments, and a large or
    // persistent cohort is not automatically representative.
    expect(readme.toLowerCase()).toContain('not automatically representative');
    expect(readme.toLowerCase()).toContain('synthetic');
    // The disclaimer is a whole sentence, not a keyword buried in a
    // table: a reader who skims this file must meet it.
    expect(readme).toMatch(/Synthetic Cohort is not automatically representative/i);
    expect(readme).toContain('docs/non-reality.md');

    // It also says what *is* simulated and what the run actually drove,
    // so nobody reads the output as a result about people.
    expect(readme).toContain('What is simulated');
    expect(readme).toContain('no external API key');

    // The disclaimer survives a refinement pass: the scenario's own
    // source carries it too, not only the prose around it.
    const scenarioSource = await fs.readFile(
      path.join(repoRoot, 'test/fixtures/service-acceptance/scenario.ts'),
      'utf8',
    );
    expect(scenarioSource).toContain('non-reality');
  });

  it('SR6 the scenario needs no external API key', async () => {
    // Removed in `beforeAll` for the whole suite. If anything in the
    // chain reached a live provider, the runs above would have failed
    // rather than produced findings, so their existence is the proof.
    expect(process.env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(report.comparison.findings).toHaveLength(1);

    // And the deliverable's own source never names a key. A future edit
    // that reached for one would be caught here rather than in a CI
    // environment that happened to export one.
    const files = [
      'test/fixtures/service-acceptance/durable.ts',
      'test/fixtures/service-acceptance/harness.ts',
      'test/fixtures/service-acceptance/reasoner.ts',
      'test/fixtures/service-acceptance/scenario.ts',
      'test/fixtures/service-acceptance/feedback.ts',
      'test/fixtures/service-acceptance/finding.ts',
      'examples/continuous-product-evaluation/run-acceptance.ts',
    ];
    for (const file of files) {
      const source = await fs.readFile(path.join(repoRoot, file), 'utf8');
      expect(source.toUpperCase(), `${file} names an API key`).not.toContain('API_KEY');
      expect(source.toUpperCase(), `${file} names a model provider`).not.toContain('ANTHROPIC');
    }

    // The scenario modules read no environment variable at all. The
    // example's CLI is excluded from *this* narrower rule because it
    // legitimately passes `process.env` through to the browser profile
    // and sets its own report flag; the key check above is the claim
    // that matters and it covers the CLI too.
    const scenarioModules = files.filter((f) => f.startsWith('test/'));
    expect(scenarioModules.length).toBeGreaterThan(0);
    for (const file of scenarioModules) {
      const source = await fs.readFile(path.join(repoRoot, file), 'utf8');
      expect(source, `${file} reads an environment variable`).not.toContain('process.env');
    }
  });
});
