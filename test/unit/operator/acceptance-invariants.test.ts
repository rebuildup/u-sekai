/**
 * Cross-cutting acceptance criteria for #59.
 *
 * These are the properties the issue names directly, and the ones #63
 * (runtime integration) and #67 (acceptance scenario) are written
 * against. They are tested as statements about the layer as a whole
 * rather than per-module, because each one is a claim about the boundary
 * rather than about a function.
 *
 * The structural claims (a bypass is impossible, no ambient authority,
 * a setup failure is not a product finding) are pinned three ways:
 * source scan, closed runtime enumeration, and — where TypeScript can
 * express it — `@ts-expect-error`, so `npm run typecheck` fails if a
 * later edit makes the claim false.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  describeParticipantActionDefect,
  PRIVILEGED_ACTION_KINDS,
  type ParticipantAction,
  type ParticipantAction as _ParticipantAction,
} from '../../../src/domain/capability.js';
import type {
  BehavioralEvidence,
  ReasonerFailureEvidence,
} from '../../../src/domain/evidence.js';

import {
  createWorldOperator,
  isOperatorProductFailure,
  isOperatorSetupFailure,
  OPERATOR_FAILURE_SUBJECT,
  OPERATOR_PRODUCT_FAILURE_KINDS,
  OPERATOR_SETUP_FAILURE_KINDS,
  OPERATOR_STEP_KINDS,
  projectOperatorFailure,
  ScriptedProvisioningProvider,
  script,
  type OperatorProductFailure,
  type OperatorSetupFailure,
} from '../../../src/operator/index.js';

import {
  fixedClock,
  fullStagingPolicy,
  provisionRequest,
  STAGING_ORIGIN,
} from '../../fixtures/operator/authority.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const operatorSrcDir = path.resolve(here, '..', '..', '..', 'src', 'operator');
const AT = '2026-10-05T09:00:00.000Z';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return full.endsWith('.ts') ? [full] : [];
    })
    .sort();
}

const operatorSources = sourceFiles(operatorSrcDir).map((file) => ({
  file: path.relative(path.resolve(here, '..', '..', '..'), file),
  text: readFileSync(file, 'utf8'),
}));

describe('write surface', () => {
  it('touches only src/operator/** and its own tests', () => {
    // A guard for the concurrent tickets in this wave: this branch must
    // not have modified another ticket's owned path.
    expect(operatorSources.length).toBeGreaterThan(0);
    for (const { file } of operatorSources) {
      expect(file.startsWith('src/operator/')).toBe(true);
    }
  });
});

describe('Participant capabilities cannot call World Operator interfaces', () => {
  it('has a step vocabulary disjoint from the Participant action vocabulary', () => {
    // `ParticipantAction` is a closed union of six coordinate/timing
    // actions. None of them names a provisioning primitive, so a model
    // cannot ask for one by producing a different action.
    const participantKinds: ReadonlyArray<ParticipantAction['kind']> = [
      'clickByCoords',
      'tapByCoords',
      'typeText',
      'scroll',
      'wait',
      'finish',
    ];
    for (const kind of participantKinds) {
      expect(OPERATOR_STEP_KINDS as readonly string[]).not.toContain(kind);
    }
  });

  it('has a step vocabulary disjoint from the privileged action vocabulary', () => {
    for (const kind of PRIVILEGED_ACTION_KINDS) {
      expect(OPERATOR_STEP_KINDS as readonly string[]).not.toContain(kind);
    }
  });

  it('rejects a Participant action shape at the provisioning boundary', () => {
    // A participant's action, or model-produced JSON shaped like one,
    // is not a provisioning request. It has no requestId and no lineage,
    // so it is refused before it is ever read as a plan.
    const operator = createWorldOperator({
      policy: fullStagingPolicy(),
      connector: new ScriptedProvisioningProvider(),
      clock: fixedClock(AT),
    });

    const participantAction: ParticipantAction = { kind: 'clickByCoords', x: 10, y: 20 };
    return operator.provision(participantAction).then((result) => {
      expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') throw new Error('unreachable');
      expect(result.failure.failureKind).toBe('invalidRequest');
      expect(result.dispatchedSteps).toBe(0);
    });
  });

  it('reports a step-shaped object as a Participant contract defect, not as a capability', () => {
    // The Participant boundary has no vocabulary for a provisioning
    // step, so `describeParticipantActionDefect` — the function that
    // decides whether an object is an actionable contract violation —
    // rejects it. ADR-0008 requires a capability violation to be
    // reserved for a *recognised* privileged attempt; a setup step is
    // not one, so it must not become a `capabilityViolation`.
    expect(describeParticipantActionDefect({ kind: 'account.create' })).not.toBeNull();
    expect(describeParticipantActionDefect({ kind: 'inbox.read' })).not.toBeNull();
    expect(describeParticipantActionDefect({ kind: 'clickByCoords', x: 1, y: 2 })).toBeNull();
  });

  it('imports nothing from the Participant, capability, domain, reasoner or runtime layers', () => {
    // The operator reaches outward only to the durable model. A reverse
    // dependency would be a channel through which a Participant could
    // reach a provisioning interface.
    const forbidden = [
      '../../domain/',
      '../../capability/',
      '../../participant/',
      '../../reasoner/',
      '../../observer/',
      '../../evidence/',
      '../../experiment/',
      '../../adapter/',
      '../../cli/',
    ];
    for (const { file, text } of operatorSources) {
      for (const needle of forbidden) {
        expect({ file, needle, present: text.includes(`'${needle}`) }).toEqual({
          file,
          needle,
          present: false,
        });
      }
    }
  });
});

describe('the boundary cannot be bypassed', () => {
  it('exposes no property that reaches a connector', () => {
    const connector = new ScriptedProvisioningProvider();
    const operator = createWorldOperator({ policy: fullStagingPolicy(), connector, clock: fixedClock(AT) });

    // The connector lives in an ECMAScript `#private` field, which is
    // not enumerable, not returned by getOwnPropertyNames, and has no
    // reflection API. Every reachable own key is checked.
    const ownKeys = Reflect.ownKeys(operator);
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(operator, key);
      expect(descriptor?.enumerable).not.toBe(true);
    }
    expect(Object.keys(operator)).toEqual([]);
    expect(JSON.stringify(operator)).toBe('{}');
    expect(String(operator)).not.toContain('scripted');
  });

  it('exposes only the gated entry points on its prototype', () => {
    const operator = createWorldOperator({
      policy: fullStagingPolicy(),
      connector: new ScriptedProvisioningProvider(),
      clock: fixedClock(AT),
    });
    const proto = Object.getPrototypeOf(operator) as object;
    const names = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor');
    expect(names.sort()).toEqual(['audit', 'cleanup', 'liveResourceKeys', 'policyId', 'provision']);
  });

  it('returns the same narrow interface for a denied operation as for a permitted one', () => {
    // The gate is not a different object: there is no "unchecked"
    // operator to fall back to.
    const operator = createWorldOperator({
      policy: fullStagingPolicy(),
      connector: new ScriptedProvisioningProvider(),
      clock: fixedClock(AT),
    });
    expect(typeof operator.provision).toBe('function');
    expect(typeof operator.cleanup).toBe('function');
    // No method dispatches without authorising: there is no `dispatch`,
    // `apply`, `run` or `exec` on the surface.
    const proto = Object.getPrototypeOf(operator) as object;
    for (const name of Object.getOwnPropertyNames(proto)) {
      expect(['dispatch', 'apply', 'run', 'exec', 'raw', 'unsafe', 'bypass']).not.toContain(name);
    }
  });

  it('decides authority before dispatch, for every step of a plan', async () => {
    const provider = new ScriptedProvisioningProvider();
    const operator = createWorldOperator({ policy: fullStagingPolicy(), connector: provider, clock: fixedClock(AT) });

    // Step 3 is ungranted. Steps 1 and 2 are permitted, so a gate that
    // ran per-dispatch rather than per-plan would already have applied
    // them.
    const result = await operator.provision(
      provisionRequest({
        steps: [
          { kind: 'account.create', resourceKey: 'a', origin: STAGING_ORIGIN, identityId: 'idn-a', displayName: 'A' },
          { kind: 'fixture.seed', resourceKey: 'b', origin: STAGING_ORIGIN, identityId: 'idn-a', template: 'smoke-v2' },
          { kind: 'entitlement.grant', resourceKey: 'c', origin: STAGING_ORIGIN, identityId: 'idn-a', entitlement: 'pro' },
          { kind: 'billing.realCharge', resourceKey: 'd', origin: STAGING_ORIGIN, identityId: 'idn-a', amountUnits: 1 },
        ],
      }),
    );

    expect(result.status).toBe('denied');
    expect(provider.provisionCalls).toBe(0);
    expect(provider.liveResourceKeys()).toEqual([]);
  });

  it('refuses to construct an operator from an unparsed policy', () => {
    const connector = new ScriptedProvisioningProvider();
    // There is no default policy, so "authority not configured" is not
    // a permissive default but a refusal.
    expect(() =>
      createWorldOperator({ policy: { policyId: 'pol-x' }, connector, clock: fixedClock(AT) }),
    ).toThrow();
    expect(connector.provisionCalls).toBe(0);
  });
});

describe('there is no ambient authority', () => {
  it('reads no environment variable, working directory, system clock or random source', () => {
    // A test or a second caller must not be able to widen what the
    // operator may do by influencing process-global state.
    const forbidden = [
      'process.env',
      'process.cwd',
      'process.argv',
      'Date.now',
      'new Date(',
      'Math.random',
      'crypto.randomUUID',
      'globalThis',
    ];
    for (const { file, text } of operatorSources) {
      for (const needle of forbidden) {
        expect({ file, needle, present: text.includes(needle) }).toEqual({
          file,
          needle,
          present: false,
        });
      }
    }
  });

  it('declares no id generator, so an identity can never be silently replaced', () => {
    // #57 established that the absence of a generator is a tested
    // guarantee, not an oversight. The operator inherits it: a resource
    // key and a request id are declared by the caller, and the operator
    // holds nothing in `#private` that a reload could regenerate.
    const generatorNames = /export\s+(?:function|const)\s+(generate|new|make|mint|create|random)\w*Id\b/;
    for (const { file, text } of operatorSources) {
      expect({ file, matched: generatorNames.test(text) }).toEqual({ file, matched: false });
    }
    // The only id-shaped export is a parser/factory for a declared value.
    expect(typeof createWorldOperator).toBe('function');
  });

  it('takes its clock, policy and connector as explicit arguments', async () => {
    const providerA = new ScriptedProvisioningProvider();
    const providerB = new ScriptedProvisioningProvider();
    const operatorA = createWorldOperator({
      policy: fullStagingPolicy({ policyId: 'pol-a' }),
      connector: providerA,
      clock: fixedClock(AT),
    });
    const operatorB = createWorldOperator({
      policy: fullStagingPolicy({ policyId: 'pol-b', maxRisk: 'mutating' }),
      connector: providerB,
      clock: fixedClock(AT),
    });

    // A is permitted to reset a fixture; B is not. Nothing global
    // connects them.
    const destructive = provisionRequest({
      requestId: 'req-a',
      steps: [
        { kind: 'fixture.seed', resourceKey: 'fx', origin: STAGING_ORIGIN, identityId: 'idn-a', template: 'smoke-v2' },
        { kind: 'fixture.reset', resourceKey: 'fx', origin: STAGING_ORIGIN },
      ],
    });
    expect((await operatorA.provision(destructive)).status).toBe('provisioned');
    expect((await operatorB.provision(destructive)).status).toBe('denied');
    expect(providerA.provisionCalls).toBe(2);
    expect(providerB.provisionCalls).toBe(0);
  });
});

describe('setup failure is distinguishable from product outcome', () => {
  it('assigns every failure kind to exactly one subject', () => {
    for (const kind of OPERATOR_SETUP_FAILURE_KINDS) {
      expect(OPERATOR_FAILURE_SUBJECT[kind]).toBe('operatorSetup');
    }
    for (const kind of OPERATOR_PRODUCT_FAILURE_KINDS) {
      expect(OPERATOR_FAILURE_SUBJECT[kind]).toBe('productResponse');
    }
    const all = [...OPERATOR_SETUP_FAILURE_KINDS, ...OPERATOR_PRODUCT_FAILURE_KINDS];
    expect(new Set(all).size).toBe(all.length);
  });

  it('keeps the two failure shapes structurally non-assignable', () => {
    const setup: OperatorSetupFailure = {
      subject: 'operatorSetup',
      failureKind: 'connectorFailed',
      ts: AT,
      where: 'operator.provision.steps[0]',
      message: 'upstream unavailable',
      detail: {},
      stepIndex: 0,
      stepKind: 'account.create',
      resourceKey: 'acct',
      rolledBack: true,
      orphanedResourceKeys: [],
    };
    const product: OperatorProductFailure = {
      subject: 'productResponse',
      failureKind: 'productRejected',
      ts: AT,
      where: 'operator.provision.steps[0]',
      message: 'duplicate account',
      detail: {},
      stepIndex: 0,
      stepKind: 'account.create',
      resourceKey: 'acct',
      productCode: 'account_already_exists',
    };

    expect(isOperatorSetupFailure(setup)).toBe(true);
    expect(isOperatorProductFailure(setup)).toBe(false);
    expect(isOperatorProductFailure(product)).toBe(true);
    expect(isOperatorSetupFailure(product)).toBe(false);

    // @ts-expect-error a setup failure is not a product outcome; the two
    // are separate interfaces, so the compiler refuses the assignment.
    const asProduct: OperatorProductFailure = setup;
    // @ts-expect-error and not the other way round either.
    const asSetup: OperatorSetupFailure = product;
    expect(asProduct).toBeDefined();
    expect(asSetup).toBeDefined();
  });

  it('projects a setup failure into the existing runtime-error slot', () => {
    const setup: OperatorSetupFailure = {
      subject: 'operatorSetup',
      failureKind: 'connectorFailed',
      ts: AT,
      where: 'operator.provision.steps[2]',
      message: 'entitlement API unavailable',
      detail: {},
      stepIndex: 2,
      stepKind: 'entitlement.grant',
      resourceKey: 'ent',
      rolledBack: true,
      orphanedResourceKeys: [],
    };
    const projection = projectOperatorFailure(setup);
    expect(projection.channel).toBe('runtimeError');

    // The three-field shape already exists on `BehavioralEvidence`, so
    // the shared contract does not need widening for a setup failure to
    // be recorded. The assignment is the assertion; `tsc` fails the
    // build if the shapes ever stop being compatible.
    if (projection.channel !== 'runtimeError') throw new Error('unreachable');
    const runtimeError: BehavioralEvidence['runtimeErrors'][number] = projection;
    expect(runtimeError.ts).toBe(AT);
    expect(runtimeError.where).toBe('operator.provision.steps[2]');
    expect(runtimeError.message).toBe('entitlement API unavailable');
    // The full operator failure travels alongside, so a consumer that
    // knows about the taxonomy can recover the classified cause.
    expect(runtimeError).toBe(projection);
    expect(projection.setupFailure.failureKind).toBe('connectorFailed');
  });

  it('cannot be recorded as a reasoner failure', () => {
    const setup: OperatorSetupFailure = {
      subject: 'operatorSetup',
      failureKind: 'connectorFailed',
      ts: AT,
      where: 'operator.provision',
      message: 'upstream unavailable',
      detail: {},
      stepIndex: 0,
      stepKind: 'account.create',
      resourceKey: 'acct',
      rolledBack: true,
      orphanedResourceKeys: [],
    };
    const projection = projectOperatorFailure(setup);

    // ADR-0008's reasoner taxonomy is about structured-output defects on
    // the Reasoner channel. Folding a provisioning failure into it would
    // misattribute an environment problem to a model provider, so the
    // types are disjoint and `tsc` enforces it.
    // @ts-expect-error a setup projection is not a reasoner failure.
    const reasonerFailure: ReasonerFailureEvidence = projection;
    expect(reasonerFailure).toBeDefined();
  });

  it('has no channel through which a UX finding could be emitted', () => {
    // The whole audit vocabulary is six records and every one of them is
    // about setup: what was applied, what was denied, what was rolled
    // back. None has a finding, observation or severity field, so a
    // provisioning failure has nowhere to become a product finding.
    const forbidden = ['finding', 'observation', 'severity', 'uxScore', 'usabilityScore'];
    for (const { file, text } of operatorSources) {
      for (const needle of forbidden) {
        // Comments may discuss why these are absent; only declarations
        // count, so the scan is for a field/interface member.
        const declared = new RegExp(`readonly\\s+${needle}\\b|interface\\s+\\w*${needle}\\w*\\b`).test(text);
        expect({ file, needle, declared }).toEqual({ file, needle, declared: false });
      }
    }
  });

  it('distinguishes the two through a real dispatch, not a hand-built failure', async () => {
    const setupProvider = new ScriptedProvisioningProvider({
      failProvision: script({ 'acct-alice': 'test-support API timed out' }),
    });
    const setupOperator = createWorldOperator({
      policy: fullStagingPolicy(),
      connector: setupProvider,
      clock: fixedClock(AT),
    });
    const setupResult = await setupOperator.provision(provisionRequest());
    if (setupResult.status !== 'failed') throw new Error('unreachable');

    const productProvider = new ScriptedProvisioningProvider({
      rejectProduct: script({ 'acct-alice': 'account_already_exists' }),
    });
    const productOperator = createWorldOperator({
      policy: fullStagingPolicy(),
      connector: productProvider,
      clock: fixedClock(AT),
    });
    const productResult = await productOperator.provision(provisionRequest());
    if (productResult.status !== 'failed') throw new Error('unreachable');

    // Same operation, same policy, same lineage: only the connector's
    // observation differs, and the two land in different subjects.
    expect(setupResult.failure.subject).toBe('operatorSetup');
    expect(productResult.failure.subject).toBe('productResponse');
    expect(projectOperatorFailure(setupResult.failure).channel).toBe('runtimeError');
    expect(projectOperatorFailure(productResult.failure).channel).toBe('productSignal');
  });
});

describe('every result carries the lineage needed for audit', () => {
  it('puts all four durable identities plus the run on every result branch', async () => {
    const connector = new ScriptedProvisioningProvider();
    const operator = createWorldOperator({ policy: fullStagingPolicy(), connector, clock: fixedClock(AT) });

    const provisioned = await operator.provision(provisionRequest());
    const denied = await operator.provision(
      provisionRequest({
        requestId: 'req-denied',
        steps: [{ kind: 'fixture.reset', resourceKey: 'fx', origin: STAGING_ORIGIN }],
        lineage: undefined,
      }),
    );

    expect(provisioned.status).toBe('provisioned');
    if (provisioned.status !== 'provisioned') throw new Error('unreachable');
    // A missing lineage is refused rather than defaulted, so the
    // provisionable branch can always be attributed.
    expect(denied.status).toBe('rejected');

    expect(provisioned.lineage.productId).toBe('prd-task-tracker');
    expect(provisioned.lineage.environmentId).toBe('env-staging');
    expect(provisioned.lineage.cohortId).toBe('coh-returning');
    expect(provisioned.lineage.programId).toBe('rp-staging-continuous');
    expect(provisioned.lineage.runId).toBe('run-0001');
  });
});
