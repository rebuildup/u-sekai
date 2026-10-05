/**
 * Composition with #59's World Operator failure projection.
 *
 * #59 (`src/operator/**`, uncommitted at the time of writing) built its
 * own setup/product split at the operator boundary. This file pins the
 * two surfaces against each other *structurally* — no import from
 * `src/operator/**`, because that module is another ticket's mutable
 * surface and this layer must not depend on it. If #59's shapes change,
 * these tests fail here, which is the signal the Supervisor needs to
 * reconcile naming before #63 and #64 are built on both vocabularies.
 *
 * The two questions this answers:
 *
 * 1. Does #59's setup projection feed `setupFailureFromRuntimeError`
 *    without a translation layer? (It does — the shapes are identical.)
 * 2. Does #59's product projection have a channel to be cited on?
 *    (It did not, until `productResponse` was added. See the test below.)
 */

import { describe, it, expect } from 'vitest';
import {
  EVIDENCE_CHANNELS,
  inferSetupFailureCause,
  parseEvidenceRef,
  parseFinding,
  parseSetupFailure,
  setupFailureFromRuntimeError,
  setupFailureId,
  type RuntimeErrorRecord,
  type SetupFailure,
} from '../../../src/review/index.js';
import { findingInput } from './support/fixtures.js';

/**
 * Structural copies of #59's projection, transcribed from
 * `src/operator/evidence.ts` and `src/operator/errors.ts`. Deliberately
 * not imported — see the module docstring.
 */
interface OperatorSetupProjection {
  readonly channel: 'runtimeError';
  readonly ts: string;
  readonly where: string;
  readonly message: string;
  /** The full operator failure behind the three coarse fields. */
  readonly setupFailure: {
    readonly subject: 'operatorSetup';
    readonly failureKind: string;
    readonly stepIndex: number;
    readonly resourceKey: string | null;
    readonly rolledBack: boolean;
    readonly orphanedResourceKeys: ReadonlyArray<string>;
  };
}

interface OperatorProductProjection {
  readonly channel: 'productSignal';
  readonly ts: string;
  readonly where: string;
  readonly productCode: string;
  readonly productFailure: { readonly subject: 'productResponse' };
}

const setupProjection: OperatorSetupProjection = {
  channel: 'runtimeError',
  ts: '2026-10-01T00:02:11Z',
  where: 'operator.provision.steps[2]',
  message: 'seeded test account "qa-alice" already exists in env-staging',
  setupFailure: {
    subject: 'operatorSetup',
    failureKind: 'connectorFailed',
    stepIndex: 2,
    resourceKey: 'account:qa-alice',
    rolledBack: true,
    orphanedResourceKeys: [],
  },
};

const productProjection: OperatorProductProjection = {
  channel: 'productSignal',
  ts: '2026-10-01T00:02:11Z',
  where: 'operator.provision.steps[2]',
  productCode: 'account_already_exists',
  productFailure: { subject: 'productResponse' },
};

describe("#59's setup projection feeds the setup-failure adapter unchanged", () => {
  it('accepts the projection object itself as a runtime error record', () => {
    // No translation: #59 documents its projection as shape-compatible
    // with BehavioralEvidence['runtimeErrors'][number], and this asserts
    // that claim still holds against this layer's declared input.
    const asRecord: RuntimeErrorRecord = setupProjection;
    expect(asRecord.ts).toBe(setupProjection.ts);

    const failure: SetupFailure = setupFailureFromRuntimeError(setupProjection, {
      id: setupFailureId('sf-0000abcd'),
      index: 2,
    });
    expect(failure.outcome).toBe('setupFailure');
    expect(failure.message).toBe(setupProjection.message);
  });

  it('routes an unambiguous operator setup failure to a setup cause, never a product one', () => {
    // Held in a variable, as a real caller holds the projection. An
    // inline object literal would trip TypeScript's excess-property
    // check against RuntimeErrorRecord, which is the one ergonomic
    // difference between passing #59's projection and passing a
    // hand-built record.
    const unreachable: OperatorSetupProjection = {
      ...setupProjection,
      message: 'seeded fixture: connect ECONNREFUSED 127.0.0.1:3000',
    };
    const failure = setupFailureFromRuntimeError(unreachable, {
      id: setupFailureId('sf-0000abcd'),
    });
    expect(failure.cause).toBe('harnessUnavailable');
    expect(failure.outcome).toBe('setupFailure');
  });

  it('refuses to guess when a message could be either, rather than inventing a product claim', () => {
    // "already exists" is genuinely ambiguous from the message alone: it
    // may be an unseedable environment, or the product refusing a
    // duplicate — and #59's own taxonomy classes the second as
    // `productRejected`, a product observation. Guessing either way
    // would put a product claim in the record that the evidence does
    // not support, which is the corruption this split exists to stop.
    // `unknown` is the honest answer, and #59 passes `cause` explicitly
    // when it knows better.
    expect(inferSetupFailureCause(setupProjection.message)).toBe('unknown');
    expect(
      setupFailureFromRuntimeError(setupProjection, {
        id: setupFailureId('sf-0000abcd'),
        cause: 'worldStateUnavailable',
      }).cause,
    ).toBe('worldStateUnavailable');
  });

  it('preserves the richer operator payload by reference, not by copy', () => {
    // The adapter only receives {ts, where, message}, so the operator's
    // stepIndex / rolledBack / orphanedResourceKeys cannot survive in
    // the SetupFailure. That is deliberate: a copy free to drift is
    // worse than a reference. The evidence `locator` is where the
    // durable record points at the operator record instead.
    const failure = setupFailureFromRuntimeError(setupProjection, {
      id: setupFailureId('sf-0000abcd'),
      index: 2,
    });
    expect(failure).not.toHaveProperty('stepIndex');
    expect(failure).not.toHaveProperty('orphanedResourceKeys');
    expect(failure.evidenceRefs[0]?.locator).toBe('runtimeErrors[2]');
    expect(failure.evidenceRefs[0]?.summary).toContain('operator.provision.steps[2]');
  });

  it('stays a SetupFailure, so it cannot enter a finding array', () => {
    const failure = setupFailureFromRuntimeError(setupProjection, {
      id: setupFailureId('sf-0000abcd'),
    });
    expect(parseSetupFailure({
      outcome: 'setupFailure',
      id: failure.id,
      cause: failure.cause,
      message: failure.message,
      evidenceRefs: failure.evidenceRefs,
      occurredAt: failure.occurredAt,
    }).outcome).toBe('setupFailure');
  });
});

describe("#59's product projection has a channel to be cited on", () => {
  it('distinguishes a product response from production telemetry', () => {
    // #59's 'productSignal' and this layer's 'productionSignal' are one
    // word apart and mean different things. Both must exist, and they
    // must not be the same member.
    expect(EVIDENCE_CHANNELS).toContain('productResponse');
    expect(EVIDENCE_CHANNELS).toContain('productionSignal');
    expect(EVIDENCE_CHANNELS).not.toContain('productSignal');
  });

  it('accepts a product refusal as evidence backing a finding', () => {
    const ref = parseEvidenceRef({
      id: 'ev-product-1',
      channel: 'productResponse',
      stance: 'supports',
      locator: 'operator.provision.steps[2]',
      observedAt: productProjection.ts,
      summary: `Product refused setup with code ${productProjection.productCode}.`,
    });
    expect(ref.channel).toBe('productResponse');

    const finding = parseFinding(
      findingInput({
        evidenceRefs: [ref],
        kind: 'workflowBlocker',
        severity: 'medium',
      }),
    );
    expect(finding.outcome).toBe('productFinding');
    expect(finding.evidenceRefs[0]?.channel).toBe('productResponse');
  });

  it('lets a finding cite a product response and a production signal as distinct corroboration', () => {
    // Same observation recorded twice would look like corroboration if
    // the two channels collapsed.
    const finding = parseFinding(
      findingInput({
        evidenceRefs: [
          {
            id: 'ev-product-2',
            channel: 'productResponse',
            stance: 'supports',
            locator: 'operator.provision.steps[2]',
            observedAt: productProjection.ts,
            summary: 'Product refused the setup.',
          },
          {
            id: 'ev-prod-2',
            channel: 'productionSignal',
            stance: 'supports',
            locator: 'customer-telemetry/support-tickets/4471',
            observedAt: '2026-10-02T00:00:00Z',
            summary: 'Customer filed a ticket describing the same refusal.',
          },
        ],
      }),
    );
    expect(finding.evidenceRefs.map((r) => r.channel)).toEqual([
      'productResponse',
      'productionSignal',
    ]);
  });
});
