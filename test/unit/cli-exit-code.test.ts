/**
 * CLI exit-code classification.
 *
 * The rule is an allowlist of *successful* terminal states, so a terminal
 * reason this build does not know about fails closed instead of reporting
 * success. That is what keeps the mapping correct for a reason added later
 * (0.2.0 gives a Reasoner failure its own terminal reason) without this
 * branch having to know its name.
 */

import { describe, it, expect } from 'vitest';
import { classifyRunExit } from '../../src/cli/index.js';

describe('classifyRunExit', () => {
  it('returns 0 when every participant reached a legitimate terminal state', () => {
    expect(classifyRunExit({ a: 'finish', b: 'finish' })).toEqual({
      code: 0,
      failedParticipantIds: [],
    });
    expect(classifyRunExit({ a: 'finish', b: 'stepBudgetExceeded' }).code).toBe(0);
    expect(classifyRunExit({ a: 'finishFromObserver' }).code).toBe(0);
    expect(classifyRunExit({ a: 'finishFromSelfReport' }).code).toBe(0);
  });

  it('keeps 3 for a capability violation, which stays the more specific signal', () => {
    expect(classifyRunExit({ a: 'capabilityViolation' })).toEqual({
      code: 3,
      failedParticipantIds: ['a'],
    });
    // A run that mixes a capability violation with another failure still
    // reports the capability violation: that code shipped in 0.1.0 and is
    // documented as "capability violation during a participant run".
    expect(classifyRunExit({ a: 'capabilityViolation', b: 'error' }).code).toBe(3);
  });

  it('returns the documented runtime-error code for any other terminal reason', () => {
    expect(classifyRunExit({ a: 'error' })).toEqual({
      code: 2,
      failedParticipantIds: ['a'],
    });
    expect(classifyRunExit({ a: 'error', b: 'finish' }).code).toBe(2);
  });

  it('fails closed for a terminal reason this build does not know', () => {
    // A Reasoner structured-output failure is reported under a dedicated
    // terminal reason as of 0.2.0. Naming it here as an opaque string keeps
    // the contract under test without depending on that symbol existing.
    expect(classifyRunExit({ a: 'reasonerFailure', b: 'reasonerFailure' })).toEqual({
      code: 2,
      failedParticipantIds: ['a', 'b'],
    });
    expect(classifyRunExit({ a: 'someFutureFailure' }).code).toBe(2);
  });

  it('lists every participant that did not finish, not only the first', () => {
    expect(classifyRunExit({ a: 'finish', b: 'error', c: 'error' }).failedParticipantIds)
      .toEqual(['b', 'c']);
  });
});
