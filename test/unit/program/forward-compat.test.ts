/**
 * Forward-compatibility guards against the durable model (issue #62).
 *
 * ## Why this file exists
 *
 * `src/product/**` (issue #57) is still moving, and one of its changes
 * is invisible to the compiler: `SyntheticIdentity` became a
 * discriminated union on `lifecycle`, so narrowing on that field turns
 * `capability.stateRetention` from the general `StateRetention` into a
 * *literal* type. TypeScript does not warn when a comparison becomes
 * constant — it just quietly makes the dead branch dead.
 *
 * This layer is exposed to that hazard in exactly one place: the
 * retention an authority envelope advertises, which is chosen from a
 * cohort's declared lifecycle. So the shape of that narrowing is pinned
 * here, as a compile-time guard rather than a comment. If #57 ever
 * narrows `CohortMembershipIntent.lifecycle` to a literal, the guard
 * below stops compiling and the retention branch has to be re-examined
 * by a human, at the moment the change happens, instead of by a
 * reviewer who happens to remember.
 *
 * The empirical case for this file is recorded in the PR: the previous
 * #57 snapshot merged into the current one conflict-free, passed `tsc`
 * clean and passed all 497 tests — while rejecting the canonical
 * release transition. A green gate is not evidence of semantic
 * correctness across a moving base; these guards are how the part of
 * that risk which *is* checkable gets checked.
 */

import { describe, it, expect } from 'vitest';

import {
  ALLOWED_STATE_RETENTION,
  IDENTITY_LIFECYCLES,
  parseSyntheticCohort,
  parseSyntheticIdentity,
  type CohortMembershipIntent,
  type ExplicitMembership,
  type IdentityLifecycle,
  type StateRetention,
} from '../../../src/product/index.js';
import { makeProgram, makeModel, manualSignal, reviewProgramId, RATES } from './fixtures.js';
import { planEvaluation, type PlanDecision } from '../../../src/program/index.js';

const NOW = '2026-03-02T10:00:30.000Z';

/** The membership intents that name a lifecycle rather than identities. */
type LifecycleNamedMembership = Exclude<CohortMembershipIntent, ExplicitMembership>;

/**
 * COMPILE-TIME GUARD — not runtime logic.
 *
 * If `LifecycleNamedMembership['lifecycle']` ever narrows to a literal
 * (e.g. `'release'`), `IdentityLifecycle extends <that literal>` becomes
 * false, the conditional type resolves to `never`, and `true` is no
 * longer assignable to it. The file then fails `tsc`, which is the
 * intended outcome: it forces a human to re-examine the retention
 * branch at the moment the model's shape changes.
 */
const LIFECYCLE_IS_NOT_LITERAL: IdentityLifecycle extends LifecycleNamedMembership['lifecycle']
  ? true
  : never = true;

describe('Retention narrowing guard', () => {
  it('keeps the cohort lifecycle unnarrowed, so the retention branch is not constant', () => {
    // The guard above is the real assertion; this test exists so the
    // failure surfaces as a named test as well as a compile error.
    expect(LIFECYCLE_IS_NOT_LITERAL).toBe(true);
  });

  it.each([...IDENTITY_LIFECYCLES])(
    'advertises a retention %s actually admits',
    (lifecycle: IdentityLifecycle) => {
      const cohort = parseSyntheticCohort({
        id: `coh-fc-${lifecycle}`,
        productId: 'prd-task-tracker',
        name: lifecycle,
        membership: { kind: 'byLifecycle', lifecycle },
      });
      const program = makeProgram({
        id: `rp-${lifecycle}`,
        triggers: [{ kind: 'manual' }],
        cohortId: cohort.id,
      });
      const decision: PlanDecision = planEvaluation({
        model: makeModel({ programs: [program], extraCohorts: [cohort] }),
        programId: reviewProgramId(`rp-${lifecycle}`),
        now: NOW,
        signals: [manualSignal(`m-${lifecycle}`, '2026-03-02T10:00:00.000Z')],
        planningCeiling: 5,
        rates: RATES,
        maxMutatingActions: 0,
      });
      if (decision.outcome !== 'due') throw new Error(`expected due, got ${decision.outcome}`);

      const advertised: StateRetention = decision.plan.authority.maxParticipantStateRetention;
      expect(ALLOWED_STATE_RETENTION[lifecycle]).toContain(advertised);
      // And the ceiling must actually be the maximum the lifecycle
      // permits, not merely some member of it.
      const permitted = ALLOWED_STATE_RETENTION[lifecycle];
      expect(advertised).toBe(permitted[permitted.length - 1]);
    },
  );

  it('does not assume uniform retention across identities in a cohort', () => {
    // A cohort can hold identities of different lifecycles under the
    // new union. The envelope advertises the cohort's declared
    // lifecycle ceiling and says so explicitly, rather than implying
    // every member shares one retention.
    const ephemeral = parseSyntheticCohort({
      id: 'coh-fc-ephemeral',
      productId: 'prd-task-tracker',
      name: 'Ephemeral',
      membership: { kind: 'byLifecycle', lifecycle: 'ephemeral' },
    });
    const program = makeProgram({
      id: 'rp-ephemeral-check',
      triggers: [{ kind: 'manual' }],
      cohortId: ephemeral.id,
    });
    const decision = planEvaluation({
      model: makeModel({ programs: [program], extraCohorts: [ephemeral] }),
      programId: reviewProgramId('rp-ephemeral-check'),
      now: NOW,
      signals: [manualSignal('m-eph', '2026-03-02T10:00:00.000Z')],
      planningCeiling: 5,
      rates: RATES,
      maxMutatingActions: 0,
    });
    if (decision.outcome !== 'due') throw new Error('expected due');
    // An ephemeral identity retains nothing, so the envelope must not
    // advertise a ceiling that implies it might.
    expect(decision.plan.authority.maxParticipantStateRetention).toBe('none');
    expect(decision.plan.authority.retentionResolution).toBe('cohort-lifecycle');
  });

  it('reads an ephemeral identity through the narrowed union without a cast', () => {
    // The union narrows `capability.stateRetention` to `'none'`, so
    // this comparison is provably constant — which is the point: on an
    // identity the compiler *does* tell us, and the runtime agrees.
    const identity = parseSyntheticIdentity({
      id: 'idn-ephemeral',
      productId: 'prd-task-tracker',
      displayName: 'Fresh visitor',
      lifecycle: 'ephemeral',
      persona: 'Has never seen the product.',
      capability: {
        maxConcurrentSessions: 1,
        stateRetention: 'none',
        permittedOrigins: ['https://staging.task-tracker.example'],
      },
    });
    if (identity.lifecycle !== 'ephemeral') throw new Error('unreachable');
    const retention: 'none' = identity.capability.stateRetention;
    expect(retention).toBe('none');
    expect(identity.stateRef).toBeUndefined();
  });
});
