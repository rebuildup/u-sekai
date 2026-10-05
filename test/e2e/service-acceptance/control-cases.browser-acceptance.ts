/**
 * Control cases for the Issue #67 acceptance scenario.
 *
 * ## Why this file exists
 *
 * This repository has been bitten, repeatedly, by the same defect in five
 * different forms: **something reports success or completeness while
 * having observed nothing.** A test script that discovers zero files. A
 * partition that runs zero tests and reports `success: true`. A guard
 * built on a pattern it silently mis-parsed. An A/B comparison where the
 * new environment quietly inherited the old one's state.
 *
 * A green result and a verified result are different things. So the
 * question this file answers is not "does the scenario pass" — the
 * sibling file answers that — it is **"would the scenario notice if the
 * thing it claims to prove were false?"**
 *
 * Every case below changes exactly one input away from the accepted
 * scenario and inverts the expected outcome. A control that does not fail
 * when the property is broken is a control that proves nothing, so each
 * one names the axis it changes and what would have to be true for the
 * accepted scenario's claim to hold vacuously.
 *
 * | case | axis changed | the accepted scenario would be vacuous if… |
 * | --- | --- | --- |
 * | `CC1` | the isolation check is given a pair that *does* share state | `assertNoSharedMutableState` never fires, so "A and B share nothing" is unfalsified |
 * | `CC2` | the cohort has no retained history behind it | the longitudinal finding is a property of the fixture, not of the durable record |
 * | `CC3` | the Reasoner reaches for a privileged primitive | the capability boundary reports no violation and the attempt reaches the operator |
 * | `CC4` | the disposition actor and content change | "a customer decides" and "the ledger is auditable" are unfalsified |
 * | `CC5` | the observer's trace loses the returning self-report | the observer is a constant that always reports, and the trace it is given is decorative |
 * | `CC6` | a pair is asked for two instances of the same version | instance identity is not derived from the declaration at all |
| `CC7` | the change classifier is given a non-empty baseline | the `change` verdict is a constant rather than a join |
 *
 * ## Cost
 *
 * `CC2` and `CC3` each drive a real Chromium against the same live
 * version B, so they are the expensive cases; `CC1`, `CC4`, `CC5` and
 * `CC6` are pure and run without a browser. That split is deliberate: a
 * control that only runs on the slow path is a control nobody runs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
  assertNoSharedMutableState,
  EnvironmentIsolationError,
  startEnvironmentPair,
} from '../../../examples/continuous-product-evaluation/environment/index.js';
import {
  appendDisposition,
  computeKpiSnapshot,
  emptyLedger,
  isFeedbackContractError,
} from '../../../src/feedback/index.js';
import { isReviewContractError } from '../../../src/review/index.js';
import type { Finding, FindingKind } from '../../../src/review/index.js';
import { classifyChange } from '../../../src/runtime/index.js';
import { assertBrowserRuntimeAvailable } from '../../browser/support/browser-runtime.js';

import {
  CONTROL_TASK,
  LONGITUDINAL_TITLE,
  TASK_CREATED_IN_B,
  executeControlRun,
  executePrivilegedAttempt,
} from '../../fixtures/service-acceptance/scenario.js';
import {
  startAcceptanceScenario,
  teardownAcceptanceScenario,
  type AcceptanceScenario,
} from '../../fixtures/service-acceptance/harness.js';
import { makeFinding } from '../../fixtures/service-acceptance/finding.js';
import { makeDisposition } from '../../fixtures/service-acceptance/feedback.js';
import { parseSelfReports } from '../../fixtures/service-acceptance/reasoner.js';

/**
 * A real #61 `Finding` for the classifier control. Its values are
 * arbitrary and it observes nothing: it exists so the join can be
 * exercised on a shape the real contract accepts.
 */
function classifierFixture(idSuffix: string, kind: FindingKind, title: string): Finding {
  return makeFinding({
    findingId: `fnd-control-${idSuffix}`,
    title,
    kind,
    severity: 'high',
    observedAt: '2026-10-10T09:00:00.000Z',
    identityId: 'idn-control-classifier',
    environmentId: 'env-staging-version-b',
    cohortId: 'coh-control',
    programId: 'rp-control',
  });
}

let scenario: AcceptanceScenario | undefined;
let control: Awaited<ReturnType<typeof executeControlRun>> | undefined;
let privileged: Awaited<ReturnType<typeof executePrivilegedAttempt>> | undefined;

beforeAll(async () => {
  await assertBrowserRuntimeAvailable();
  // One pair of live environments, shared by both browser-backed control
  // cases. The pair is the expensive part; the cases are what matter.
  scenario = await startAcceptanceScenario();
  control = await executeControlRun(scenario);
  privileged = await executePrivilegedAttempt(scenario);
}, 600_000);

// `scenario` is unassigned when `beforeAll` failed; #69's `close`
// rejects on a second call, so teardown must happen exactly once.
afterAll(async () => {
  await teardownAcceptanceScenario(scenario);
});

describe('#67 control cases: the scenario can detect a real defect', () => {
  it('CC1 the A/B isolation check fires on a pair that really does share state', async () => {
    // The accepted scenario asserts `assertNoSharedMutableState` does not
    // throw for the real pair. That assertion is only worth something if
    // the check is capable of throwing, so here it is handed the one
    // pair that certainly shares state: an instance with itself.
    const pair = await startEnvironmentPair(
      { product: 'prd-task-tracker', name: 'staging', version: '2026.10.1', seed: 'control-case' },
      { product: 'prd-task-tracker', name: 'staging', version: '2026.10.2', seed: 'control-case' },
    );
    try {
      // The real pair does not throw. Asserted here too, so a broken
      // checker that always throws cannot pass the sibling file either.
      expect(() => assertNoSharedMutableState(pair.before, pair.after)).not.toThrow();

      // The same instance on both sides does throw, and names the fault.
      let raised: unknown;
      try {
        assertNoSharedMutableState(pair.before, pair.before);
      } catch (error) {
        raised = error;
      }
      expect(raised).toBeInstanceOf(EnvironmentIsolationError);
      expect((raised as EnvironmentIsolationError).detail).toBe('isolation');
      expect((raised as Error).message).toContain('share a mutable object');
    } finally {
      await pair.before.close();
      await pair.after.close();
    }
  });

  it('CC2 the longitudinal finding disappears when the cohort has no retained history', async () => {
    if (control === undefined || scenario === undefined) throw new Error('the control run never executed');

    // The control really ran, really drove a browser, and really wrote
    // to the same live version B the accepted scenario used. Without
    // this, "no finding" would be indistinguishable from "no run".
    expect(control.run.setupRefused).toBe(false);
    expect(control.run.evidence.length).toBeGreaterThan(0);
    expect(control.worldB.titles).toContain(CONTROL_TASK);
    expect(control.stateAfter.observations).toHaveLength(1);
    expect(control.stateAfter.observations[0]).toMatchObject({ version: '2026.10.2' });

    // The one axis that changed: this cohort's durable record holds no
    // earlier version, so its Reasoner was given no history.
    expect(control.memory.priorTitles).toEqual([]);
    expect(control.stateAfter.retainedState?.interactionCount).toBe(1);

    // Same environment, same version, same application, same code, same
    // observer — and no finding. The accepted scenario's finding is
    // therefore attributable to the returning cohort's retained history
    // and not to the fixture.
    expect(control.run.findings).toEqual([]);

    // And the observer said why, rather than emitting an empty report
    // that reads like "nothing was wrong".
    expect(control.run.observer.summary).toContain('aligned with its expectations');
    expect(control.run.observer.findings).toEqual([]);
    expect(control.run.observer.terminationVerdict.plausible).toBe(true);

    // Sanity, in the other direction: the accepted scenario's title is
    // the one this run did *not* produce. A constant string comparison
    // would fail here rather than quietly passing both.
    expect(control.run.findings.map((f) => f.title)).not.toContain(LONGITUDINAL_TITLE);
    expect(LONGITUDINAL_TITLE).toContain('2026.10.1');
    expect(TASK_CREATED_IN_B).not.toBe(LONGITUDINAL_TITLE);
  });

  it('CC3 a privileged attempt is refused and dispatches nothing', () => {
    if (privileged === undefined) throw new Error('the privileged run never executed');

    // The refusal is observable in the run's own trace, not inferred
    // from the absence of an error.
    expect(privileged.events).toContain('capability.violation');
    expect(privileged.events).toContain('capabilityViolation');
    expect(privileged.events).toContain('evaluateJs');

    // The run reported it as a setup failure rather than swallowing it
    // and reporting a clean participant session.
    expect(privileged.run.setupFailures.length).toBeGreaterThan(0);
    expect(privileged.run.setupFailures.map((f) => f.cause)).toContain('policyDenied');

    // The load-bearing observation. One declared step was authorised and
    // dispatched; the participant's privileged attempt added none. This
    // is a count of calls *anything* could have made, not a count of
    // calls the runtime happened to make.
    expect(privileged.connector.provisionCalls).toBe(1);
    expect(privileged.run.setup.resourceKeys).toEqual(['acct-privileged']);

    // Cleanup still went through the same gate, so a refused run does
    // not leak the world it created.
    expect(privileged.run.cleanup?.status).toBe('cleaned');
    expect(privileged.connector.releaseCalls).toBe(1);
    expect(privileged.connector.liveResourceKeys()).toEqual([]);
  });

  it('CC4 the disposition rules refuse what the accepted scenario relies on being refused', () => {
    const findingId = 'fnd-control-case';

    // Automation may not record a decision. If it could, every
    // acceptance and false-positive rate in the KPI snapshot would be
    // inflatable by a triage bot, and `AC5`'s "customer disposition"
    // would mean nothing.
    expect(() =>
      appendDisposition(
        emptyLedger(),
        makeDisposition({
          findingId,
          kind: 'accepted',
          state: 'decided',
          dispositionId: 'dsp-control-automation',
          decidedAt: '2026-10-10T09:00:00.000Z',
          actorKind: 'automation',
          actorReference: 'triage-bot',
        }),
      ),
    ).toThrow(/automation/);

    // Undecided is not decided: an open kind in a decided state is
    // refused, so a rate can never count an unreviewed finding as
    // accepted.
    expect(() =>
      appendDisposition(
        emptyLedger(),
        makeDisposition({
          findingId,
          kind: 'unresolved',
          state: 'decided',
          dispositionId: 'dsp-control-open-as-decided',
          decidedAt: '2026-10-10T09:00:00.000Z',
        }),
      ),
    ).toThrow();

    // A disposition id is the identity of one event. Re-using it with
    // different content is refused, because the finding's current
    // disposition would otherwise depend on the order the log was read
    // in.
    const ledger = appendDisposition(
      emptyLedger(),
      makeDisposition({
        findingId,
        kind: 'accepted',
        state: 'decided',
        dispositionId: 'dsp-control-replay',
        decidedAt: '2026-10-10T09:00:00.000Z',
        rationale: 'first account',
      }),
    );
    // An exact replay is a no-op, not a second event.
    expect(
      appendDisposition(
        ledger,
        makeDisposition({
          findingId,
          kind: 'accepted',
          state: 'decided',
          dispositionId: 'dsp-control-replay',
          decidedAt: '2026-10-10T09:00:00.000Z',
          rationale: 'first account',
        }),
      ).events,
    ).toHaveLength(1);

    let conflict: unknown;
    try {
      appendDisposition(
        ledger,
        makeDisposition({
          findingId,
          kind: 'accepted',
          state: 'decided',
          dispositionId: 'dsp-control-replay',
          decidedAt: '2026-10-10T09:00:00.000Z',
          rationale: 'a different account of the same event',
        }),
      );
    } catch (error) {
      conflict = error;
    }
    expect(isFeedbackContractError(conflict) || isReviewContractError(conflict)).toBe(true);

    // And a decision about a finding nobody is aggregating is refused
    // rather than counted. A snapshot that quietly divided by a
    // denominator the caller could not see is how an acceptance rate
    // moves for reasons no consumer can inspect.
    expect(() => computeKpiSnapshot({ findings: [], ledger })).toThrow(
      /which is not in the aggregation input/,
    );

    // Aggregated over the finding it judged, the same ledger moves the
    // rate and names the finding in the numerator.
    const judged = classifierFixture('disposition-subject', 'trustDefect', LONGITUDINAL_TITLE);
    const measured = computeKpiSnapshot({ findings: [judged], ledger: emptyLedger() });
    expect(measured.undispositionedFindingIds).toEqual([judged.id]);
    expect(measured.findingAcceptanceRate.defined).toBe(false);
    expect(measured.findingAcceptanceRate.reason).toBe('emptyDenominator');

    const decided = appendDisposition(
      emptyLedger(),
      makeDisposition({
        findingId: judged.id,
        kind: 'accepted',
        state: 'decided',
        dispositionId: 'dsp-control-measured',
        decidedAt: '2026-10-10T09:00:00.000Z',
      }),
    );
    const after = computeKpiSnapshot({ findings: [judged], ledger: decided });
    expect(after.findingAcceptanceRate.value).toBe(1);
    expect(after.findingAcceptanceRate.numeratorFindingIds).toEqual([judged.id]);
    expect(after.acceptedFindingCount.value).toBe(1);
  });

  it('CC5 the observer reports from the trace it was given, not from a constant', () => {
    // A trace with no self-report at all: the observer has no observation
    // of a returning-user problem and must not invent one.
    expect(parseSelfReports('')).toEqual([]);
    expect(parseSelfReports('run.start run-1 seed=x\ntermination p=idn-x reason=finish')).toEqual([]);

    // A trace whose returning cohort reported a satisfied session: the
    // mismatch line the accepted scenario depends on is absent.
    const satisfied = parseSelfReports(
      [
        'observation p=idn-returning-leo step=0 url=http://127.0.0.1:1 title="Task Tracker"',
        'selfReport p=idn-returning-leo confidence=0.8 wouldReturn=true',
      ].join('\n'),
    );
    expect(satisfied).toHaveLength(1);
    expect(satisfied[0]?.wouldReturn).toBe(true);
    expect(satisfied[0]?.participantId).toBe('idn-returning-leo');

    // A self-report from a *different* cohort does not stand in for the
    // returning one: attribution is by id, not by "somebody was
    // unhappy".
    const otherIdentity = parseSelfReports('selfReport p=idn-someone-else confidence=0.1 wouldReturn=false');
    expect(otherIdentity).toHaveLength(1);
    expect(otherIdentity[0]?.participantId).not.toBe('idn-returning-leo');
  });

  it('CC7 the longitudinal change verdict is a real join, and `unknown` is what an empty baseline earns', () => {
    // The accepted scenario's comparison run carries
    // `change: 'unknown'`, because its version-A baseline produced no
    // finding at all. That is a property of the evidence, not a missing
    // assertion, so it is pinned here from the other side: the same
    // classifier, fed a non-empty baseline, produces `persisted` and
    // `introduced` rather than a constant.
    //
    // A `classifyChange` that always returned `unknown` would satisfy
    // the accepted scenario's assertion and nothing else, which is the
    // shape of a check that cannot fail. Both values below are real
    // #61 `Finding`s, built through its own parser, so the classifier is
    // exercised on the shape it will actually see.
    const observed = classifierFixture('same-problem', 'trustDefect', LONGITUDINAL_TITLE);
    const other = classifierFixture('other-problem', 'usabilityDefect', 'A different problem entirely.');

    // Nothing to compare with.
    expect(classifyChange(observed, undefined)).toBe('unknown');
    expect(classifyChange(observed, [])).toBe('unknown');

    // The same problem in the baseline: it was already there.
    expect(
      classifyChange(observed, [classifierFixture('same-problem', 'trustDefect', LONGITUDINAL_TITLE)]),
      'a finding present in both runs must classify as persisted, so the accepted scenario\'s ' +
        '`unknown` is a property of its empty baseline and not of a constant verdict',
    ).toBe('persisted');

    // A different problem in the baseline: this one is new.
    expect(classifyChange(observed, [other])).toBe('introduced');
  });

  it('CC6 instance identity is derived from the declaration, so a same-version pair is refused', async () => {
    // Two instances that differ in nothing are one instance. If identity
    // were not derived from `(product, name, version, seed)`, this pair
    // would start happily and the A-versus-B comparison would be
    // comparing one deployment against itself.
    let raised: unknown;
    try {
      await startEnvironmentPair(
        { product: 'prd-task-tracker', name: 'staging', version: '2026.10.1', seed: 'control-case' },
        { product: 'prd-task-tracker', name: 'staging', version: '2026.10.1', seed: 'control-case' },
      );
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(EnvironmentIsolationError);
    expect((raised as EnvironmentIsolationError).detail).toBe('pair.before.version');
    expect((raised as Error).message).toContain('two different versions');
  });
});
