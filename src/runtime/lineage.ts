/**
 * Run identity and run lineage (issue #63).
 *
 * ## The runtime owns the run id, and nothing else does
 *
 * `src/product/lineage.ts` says so explicitly: `EvaluationRunId` is an
 * opaque foreign key, "minted and owned outside this layer", and
 * #57's whole discipline is that a durable id is *declared*, never
 * generated. The two statements are reconciled the way they can only
 * be: the runtime is that outside layer, so this module is where a run
 * id comes from, and it comes from one of exactly two places —
 *
 * 1. `deriveRunId(plan)` — a **pure function of the plan's
 *    `planKey`**. `planKey` is itself #62's deterministic identity of
 *    the evaluation, so the derived run id is a pure function of the
 *    evaluation. Two consequences follow, and both are wanted: a
 *    redelivered plan names the same run, and the same trigger against
 *    the same durable target can never produce two runs' worth of
 *    findings.
 * 2. A caller-declared `runId`, parsed by #57's own
 *    `parseEvaluationRunId`.
 *
 * There is no third source. No clock, no counter, no random value: a
 * run id that could differ between two identical replays would orphan
 * every `FindingId` derived from it, which is the exact failure #61's
 * `deriveFindingId` exists to prevent.
 *
 * ## The provisioning request id
 *
 * #59's `requestId` is a *caller-declared idempotency key* and its
 * journal key deliberately excludes the run id, so a caller retrying a
 * plan after a crashed run is still recognised. Deriving the request id
 * from the plan key — not the run id — keeps that property: re-running
 * the same plan under a fresh run id is one intent, and #59 replays
 * the recorded result rather than provisioning twice.
 */

import { createHash } from 'node:crypto';

import {
  parseEvaluationRunId,
  parseRunLineage,
  type EvaluationRunId,
  type RunLineage,
} from '../product/index.js';
import type {
  EvaluationTargetRef,
  EvidenceId,
  SyntheticIdentityId,
} from '../product/index.js';
import { provisionRequestId, type ProvisionRequestId } from '../operator/index.js';
import type { EvaluationPlan } from '../program/index.js';
import { RuntimeIntegrationError } from './errors.js';

/**
 * A short, stable digest of a plan key.
 *
 * #62's `canonicalKey` joins its parts with `|` and pads each with
 * `length:`, and both #57's `EvaluationRunId` grammar and #59's
 * `ProvisionRequestId` grammar exclude `|`. A run id or request id
 * spelled directly from a `planKey` is therefore *always* rejected, so
 * the derivation has to go through a digest. SHA-256 truncated to 32
 * hex characters is 128 bits, which is far more than the number of
 * plans a service will ever evaluate in a release, and it is a pure
 * function of nothing but the plan key — no clock, no counter.
 */
function planDigest(plan: EvaluationPlan): string {
  return createHash('sha256').update(plan.planKey, 'utf8').digest('hex').slice(0, 32);
}

/**
 * A short, stable token for a run id, for composing bounded review ids.
 *
 * #57 accepts a declared `runId` of up to 256 characters. #61 caps a
 * review id at 128. Spelling a setup-failure id as
 * `sf-<runId>-re-1` therefore produces an id #61 would reject for any
 * caller that declared a long run id — and the failure is silent,
 * because `setupFailureFromRuntimeError` takes its id as a
 * `SetupFailureId` and never re-parses it. Hashing removes the length
 * coupling entirely: the composed id is `sf-` plus 16 hex characters
 * plus a short suffix, comfortably inside #61's bound for *any* run id.
 *
 * 64 bits of run id is ample here. The token only has to keep two
 * setup failures of the *same* run apart, and the ordinal already does
 * that; its other job is to keep one run's ids from colliding with
 * another's, which 64 bits does for any realistic evaluation count.
 */
export function runToken(runId: EvaluationRunId | string): string {
  return createHash('sha256').update(String(runId), 'utf8').digest('hex').slice(0, 16);
}

/**
 * The run id a plan implies.
 *
 * `plan.planKey` already encodes the trigger's idempotency key and the
 * durable target, so this adds no entropy and no ambiguity: two
 * different evaluations of the same target from the same trigger
 * occurrence are the same evaluation, and two different targets are
 * different runs.
 */
export function deriveRunId(plan: EvaluationPlan): EvaluationRunId {
  return parseEvaluationRunId(`run.${planDigest(plan)}`, 'runId');
}

/**
 * The provisioning request id a plan implies.
 *
 * Derived from `planKey` rather than `runId` for the reason in the
 * module docstring: a retry under a new run id must be the same
 * intent, and #59's journal key is `environmentId | requestId`.
 */
export function deriveRequestId(plan: EvaluationPlan): ProvisionRequestId {
  return provisionRequestId(`req.${planDigest(plan)}`);
}

/** Resolve the run id a caller declared, or derive one from the plan. */
export function resolveRunId(plan: EvaluationPlan, declared?: string): EvaluationRunId {
  if (declared === undefined) return deriveRunId(plan);
  try {
    return parseEvaluationRunId(declared, 'runId');
  } catch (error) {
    throw new RuntimeIntegrationError(
      `runId "${declared}" is not a valid EvaluationRunId: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'invalidInvocation',
      'runId',
      { runId: declared },
    );
  }
}

/**
 * Build the run's lineage.
 *
 * `startedAt` / `endedAt` come from the runtime's own clock rather than
 * from #62's plan. #62 makes the plan a pure function of its inputs
 * and therefore carries *no* creation stamp; the instants at which a
 * run actually happened are transport metadata that belongs here, and
 * putting them on the plan would make two attempts at one trigger
 * produce two different plans.
 *
 * `evidenceIds` is left off. It is filled in once the evidence
 * catalogue exists, and re-parsing the lineage at that point would
 * produce a *different object* than the one findings already reference
 * — which is precisely the copy-versus-reference drift
 * `src/review/longitudinal.ts` refuses to accept. The lineage is
 * therefore built once, after the evidence catalogue.
 */
export function buildRunLineage(input: {
  readonly target: EvaluationTargetRef;
  readonly runId: EvaluationRunId;
  readonly identityIds: ReadonlyArray<SyntheticIdentityId>;
  readonly startedAt: string;
  /**
   * Omitted for the *projected* lineage `runEvaluation` checks a
   * baseline against before doing any work. #57's
   * `isReleaseTransitionComparison` reads only `runId`, the program
   * scope and the identity set, so a projection that omits `endedAt`
   * and the evidence handles still carries everything the decision
   * depends on — and a run that has not happened yet has no end.
   */
  readonly endedAt?: string;
  readonly evidenceIds?: ReadonlyArray<EvidenceId>;
}): RunLineage {
  return parseRunLineage({
    ...input.target,
    runId: input.runId,
    identityIds: [...input.identityIds],
    startedAt: input.startedAt,
    ...(input.endedAt !== undefined ? { endedAt: input.endedAt } : {}),
    ...(input.evidenceIds !== undefined ? { evidenceIds: [...input.evidenceIds] } : {}),
  });
}
