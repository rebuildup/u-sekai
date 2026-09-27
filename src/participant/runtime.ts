/**
 * Participant runtime (ADR-0006, ADR-0008). Single-step inner loop:
 *
 *   1. adapter.open(url)
 *   2. for step in [0, budget):
 *        a. observer = adapter.observe(step)
 *        b. participantObs = applyParticipantObservation(observer, capability)
 *        c. request = buildReasonerRequest(...)
 *        d. completeStructuredWithRecovery(request)  <- typed taxonomy + bounded retry
 *        e. action = result.action ; enforceActionAllowlist(...)
 *        f. result  = adapter.execute(action)
 *        g. recorder.append(...)
 *        h. if action.kind === 'finish' -> terminate
 *   3. selfReport = askReasonerForSelfReport(participantMemoryOnly)
 *
 * The participant runtime NEVER sees the observer observation's DOM /
 * console / network — only the filtered participant view.
 *
 * A malformed or contract-violating Reasoner response is recorded as a
 * typed `reasoner.failure`, never as a `capability.violation`. Only a
 * parsed action that attempts a privileged primitive produces a
 * `capability.violation`.
 */

import type { BrowserAdapter } from '../adapter/browser/interface.js';
import type { Reasoner } from '../domain/reasoner.js';
import type {
  CapabilityProfile,
  ParticipantAction,
} from '../domain/capability.js';
import type { SelfReport } from '../domain/self-report.js';
import type {
  EvidenceRecorder,
} from '../evidence/recorder.js';
import type { TerminationReason } from '../domain/evidence.js';
import {
  applyParticipantObservation,
  assertNoPrivilegedLeak,
  enforceActionAllowlist,
  enforceRawAttempt,
  buildReasonerRequest,
  memoryWindowDescription,
} from '../capability/index.js';
import { CapabilityViolation, StepBudgetExceeded } from '../domain/errors.js';
import {
  participantActionSystemPrompt,
  participantSelfReportSystemPrompt,
} from './system-prompt.js';
import { fnv1aHex } from '../evidence/hash.js';
import {
  admitParticipantAction,
  assertReasonerResponseContract,
  completeStructuredWithRecovery,
  requireSelfReportContent,
  resolveStructuredOutputPolicy,
  type StructuredAttemptFailure,
  type StructuredOutputPolicy,
} from '../reasoner/structured.js';

export interface ParticipantRuntimeOptions {
  readonly runId: string;
  readonly participantId: string;
  readonly personaPrompt: string;
  readonly userStory: string;
  readonly capability: CapabilityProfile;
  readonly reasoner: Reasoner;
  readonly adapter: BrowserAdapter;
  readonly targetUrl: string;
  readonly budget: number;
  readonly recorder: EvidenceRecorder;
  /** Function that flushes the current step to the artifact directory. */
  readonly onStepObservation?: (obs: import('../domain/observation.js').ParticipantObservation) => Promise<void>;
  /** Optional seed used for digest determinism. */
  readonly seed?: string;
  /**
   * Overrides the structured-output recovery policy (ADR-0008). Defaults
   * to 2 attempts with parse/contract/transient-transport retry.
   */
  readonly structuredOutputPolicy?: Partial<StructuredOutputPolicy>;
}

export interface ParticipantRuntimeResult {
  readonly steps: number;
  readonly selfReport: SelfReport;
  readonly terminationReason: TerminationReason;
  readonly error?: string;
}

/**
 * Record every failed structured-output attempt. The event carries
 * `recoveryOutcome`, so retry-success and retry-exhaustion are
 * distinguishable from `events.ndjson` alone.
 */
async function recordReasonerFailures(
  recorder: EvidenceRecorder,
  runId: string,
  participantId: string,
  stepIndex: number | null,
  failures: ReadonlyArray<StructuredAttemptFailure>,
): Promise<void> {
  for (const f of failures) {
    await recorder.append({
      type: 'reasoner.failure',
      runId,
      ts: f.ts,
      outputKind: f.outputKind,
      channel: f.channel,
      failureKind: f.failureKind,
      provider: f.provider,
      modelId: f.modelId,
      attempt: f.attempt,
      maxAttempts: f.maxAttempts,
      retryable: f.retryable,
      willRetry: f.willRetry,
      recoveryOutcome: f.recoveryOutcome,
      message: f.message,
      ...(stepIndex !== null ? { participantId, stepIndex } : {}),
      ...(f.httpStatus !== undefined ? { httpStatus: f.httpStatus } : {}),
      ...(f.excerpt !== undefined ? { excerpt: f.excerpt } : {}),
    });
  }
}

export async function runParticipant(opts: ParticipantRuntimeOptions): Promise<ParticipantRuntimeResult> {
  const {
    runId,
    participantId,
    personaPrompt,
    userStory,
    capability,
    reasoner,
    adapter,
    targetUrl,
    budget,
    recorder,
  } = opts;

  const policy = resolveStructuredOutputPolicy(opts.structuredOutputPolicy);

  await adapter.open(targetUrl);

  const actionSystemPrompt = participantActionSystemPrompt({
    memoryDescription: memoryWindowDescription(capability.memory),
  });

  let steps = 0;
  let terminationReason: ParticipantRuntimeResult['terminationReason'] = 'error';
  let lastError = '';

  for (let stepIndex = 0; stepIndex < budget; stepIndex++) {
    try {
      await recorder.append({
        type: 'step.start',
        runId,
        participantId,
        stepIndex,
        ts: new Date().toISOString(),
      });
      const observerObs = await adapter.observe(stepIndex);
      const participantObs = applyParticipantObservation(observerObs, capability);
      if (opts.onStepObservation) await opts.onStepObservation(participantObs);

      try {
        assertNoPrivilegedLeak(participantObs, observerObs);
      } catch (err) {
        if (err instanceof CapabilityViolation) {
          await recorder.append({
            type: 'capability.violation',
            runId,
            participantId,
            stepIndex,
            ts: new Date().toISOString(),
            axis: err.axis,
            reason: err.message,
          });
        }
        throw err;
      }

      await recorder.append({
        type: 'observation.captured',
        runId,
        participantId,
        stepIndex,
        ts: new Date().toISOString(),
        url: participantObs.url,
        title: participantObs.title,
      });

      // build Reasoner request through the memory controller
      const history = await recorder.snapshot();
      const outcome = buildReasonerRequest(
        {
          personaPrompt,
          userStory,
          systemPrompt: actionSystemPrompt,
          history,
          currentObservation: {
            type: 'observation.captured',
            runId,
            participantId,
            stepIndex,
            ts: new Date().toISOString(),
            url: participantObs.url,
            title: participantObs.title,
          },
          maxTokens: 256,
        },
        capability.memory,
      );

      const digest = fnv1aHex(actionSystemPrompt + '\n' + outcome.request.messages.map((m) => m.content).join('\n'));

      await recorder.append({
        type: 'reasoner.request',
        runId,
        participantId,
        stepIndex,
        ts: new Date().toISOString(),
        promptHash: digest,
        messageCount: outcome.request.messages.length,
        request: {
          ...outcome.request,
          systemPromptDigest: digest,
        },
      });

      const recovery = await completeStructuredWithRecovery({
        reasoner,
        request: outcome.request,
        expectedKind: 'action',
        policy,
        validate: (response, outputKind) => {
          assertReasonerResponseContract(response, outputKind, {
            provider: reasoner.providerId,
            modelId: reasoner.modelId,
          });
        },
      });

      await recordReasonerFailures(recorder, runId, participantId, stepIndex, recovery.failures);

      if (recovery.status === 'failed') {
        // A provider / protocol defect, exhausted or not retryable. This
        // is deliberately NOT a capability violation.
        terminationReason = recovery.failureKind === 'capabilityViolation' ? 'capabilityViolation' : 'reasonerFailure';
        lastError =
          recovery.failureKind === 'capabilityViolation'
            ? 'reasoner emitted a privileged action attempt'
            : `reasoner structured-output failure (${recovery.failureKind}) after ${recovery.attempts} attempt(s)`;
        if (recovery.failureKind === 'capabilityViolation') {
          await recorder.append({
            type: 'capability.violation',
            runId,
            participantId,
            stepIndex,
            ts: new Date().toISOString(),
            axis: 'action',
            reason: lastError,
          });
        }
        break;
      }

      const reasonerResponse = recovery.value;

      await recorder.append({
        type: 'reasoner.response',
        runId,
        participantId,
        stepIndex,
        ts: new Date().toISOString(),
        response: reasonerResponse,
      });

      if (reasonerResponse.kind !== 'action') {
        // Type-narrowing guard. The boundary contract check above already
        // classifies any non-action response — including a `refusal` — as
        // `contractValidation`, so this is not a reachable path.
        lastError = `reasoner returned "${reasonerResponse.kind}" where an action was required`;
        terminationReason = 'reasonerFailure';
        break;
      }

      // Three-way admission. Only a recognised privileged primitive is a
      // capability violation; anything else structurally wrong is a
      // contract defect.
      const admission = admitParticipantAction(reasonerResponse.action);
      if (admission.status === 'capabilityViolation') {
        try {
          enforceRawAttempt(admission.attempt);
        } catch (err) {
          if (err instanceof CapabilityViolation) {
            await recorder.append({
              type: 'capability.violation',
              runId,
              participantId,
              stepIndex,
              ts: new Date().toISOString(),
              axis: err.axis,
              reason: err.message,
            });
            lastError = err.message;
          }
        }
        terminationReason = 'capabilityViolation';
        break;
      }
      if (admission.status === 'contractInvalid') {
        lastError = `reasoner contract validation failure: ${admission.reason}`;
        terminationReason = 'reasonerFailure';
        break;
      }

      const action: ParticipantAction = admission.action;

      // Enforce action allowlist at the runtime layer.
      try {
        enforceActionAllowlist(action, capability);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof CapabilityViolation) {
          await recorder.append({
            type: 'capability.violation',
            runId,
            participantId,
            stepIndex,
            ts: new Date().toISOString(),
            axis: err.axis,
            reason: err.message,
          });
        }
        terminationReason = 'capabilityViolation';
        lastError = message;
        break;
      }

      await recorder.append({
        type: 'action',
        runId,
        participantId,
        stepIndex,
        ts: new Date().toISOString(),
        action,
      });

      const actionResult = await adapter.execute(action);
      await recorder.append({
        type: 'action.result',
        runId,
        participantId,
        stepIndex,
        ts: new Date().toISOString(),
        result: actionResult,
      });

      steps += 1;
      if (action.kind === 'finish') {
        terminationReason = 'finish';
        break;
      }
    } catch (err) {
      lastError = (err as Error).message;
      if (err instanceof CapabilityViolation) {
        terminationReason = 'capabilityViolation';
      } else {
        terminationReason = 'error';
      }
      break;
    }
  }

  if (steps >= budget && terminationReason === 'error') {
    terminationReason = 'stepBudgetExceeded';
    await recorder.append({
      type: 'termination',
      runId,
      participantId,
      ts: new Date().toISOString(),
      reason: 'stepBudgetExceeded',
    });
    void StepBudgetExceeded; // referenced via runtime semantics
  } else {
    await recorder.append({
      type: 'termination',
      runId,
      participantId,
      ts: new Date().toISOString(),
      reason: terminationReason,
    });
  }

  const selfReport = await generateSelfReport(opts, recorder, reasoner, policy);

  await adapter.close();

  return {
    steps,
    selfReport,
    terminationReason,
    ...(lastError ? { error: lastError } : {}),
  };
}

async function generateSelfReport(
  opts: ParticipantRuntimeOptions,
  recorder: EvidenceRecorder,
  reasoner: Reasoner,
  policy: StructuredOutputPolicy,
): Promise<SelfReport> {
  const { runId, participantId, personaPrompt, userStory, capability, seed } = opts;
  const selfReportSystemPrompt = participantSelfReportSystemPrompt();
  const history = await recorder.snapshot();
  const prior = [...history].reverse().find((e) => e.type === 'observation.captured');
  const lastObs = prior && prior.type === 'observation.captured' ? prior : null;

  // Build the same memory-controlled view, but for self-report: we
  // re-use the participant's memory window. The system prompt is the
  // only new thing.
  const messages = buildSelfReportMessages(history, capability.memory, lastObs, personaPrompt, userStory);

  const promptDigest = fnv1aHex(selfReportSystemPrompt + '\n' + messages.map((m) => m.content).join('\n'));

  await recorder.append({
    type: 'selfReport.prompt',
    runId,
    participantId,
    ts: new Date().toISOString(),
    promptDigest,
  });

  const recovery = await completeStructuredWithRecovery({
    reasoner,
    request: {
      systemPrompt: selfReportSystemPrompt,
      messages,
      maxTokens: 384,
    },
    expectedKind: 'selfReport',
    policy,
    validate: (response, outputKind) => {
      assertReasonerResponseContract(response, outputKind, {
        provider: reasoner.providerId,
        modelId: reasoner.modelId,
      });
    },
  });

  await recordReasonerFailures(recorder, runId, participantId, null, recovery.failures);

  if (recovery.status === 'failed') {
    // The placeholder is self-describing on purpose: a reader must be
    // able to tell a provider/contract failure apart from a participant
    // that chose to say nothing.
    const report: SelfReport = {
      participantId,
      capturedAt: new Date().toISOString(),
      goal: '',
      productUnderstanding: '',
      confusionPoints: [],
      resultAlignedWithExpectation: false,
      confidence: 0,
      wouldReturn: false,
      freeText:
        `self-report unavailable: reasoner ${recovery.failureKind} failure after ` +
        `${recovery.attempts} attempt(s). This is a provider/contract failure, not participant silence.`,
    };
    await recorder.append({
      type: 'selfReport.response',
      runId,
      participantId,
      ts: new Date().toISOString(),
      report,
    });
    return report;
  }

  const content = requireSelfReportContent(recovery.value, {
    provider: reasoner.providerId,
    modelId: reasoner.modelId,
  });

  const report: SelfReport = {
    participantId,
    capturedAt: new Date().toISOString(),
    goal: content.goal,
    productUnderstanding: content.productUnderstanding,
    confusionPoints: content.confusionPoints,
    resultAlignedWithExpectation: content.resultAlignedWithExpectation,
    confidence: content.confidence,
    wouldReturn: content.wouldReturn,
    freeText: content.freeText,
  };

  await recorder.append({
    type: 'selfReport.response',
    runId,
    participantId,
    ts: new Date().toISOString(),
    report,
  });

  void seed;
  return report;
}

function buildSelfReportMessages(
  history: ReadonlyArray<import('../domain/evidence.js').RunEvent>,
  capability: import('../domain/capability.js').MemoryCapability,
  lastObs: { url: string; title: string } | null,
  personaPrompt: string,
  userStory: string,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const obsEvents = history.filter((e): e is Extract<typeof e, { type: 'observation.captured' }> => e.type === 'observation.captured');
  const actEvents = history.filter((e): e is Extract<typeof e, { type: 'action' }> => e.type === 'action');
  const resultEvents = history.filter((e): e is Extract<typeof e, { type: 'action.result' }> => e.type === 'action.result');

  const steps = obsEvents.map((o) => ({
    stepIndex: o.stepIndex,
    url: o.url,
    title: o.title,
    action: actEvents.find((a) => a.stepIndex === o.stepIndex)?.action ?? null,
    result: resultEvents.find((r) => r.stepIndex === o.stepIndex)?.result ?? null,
  }));

  let retained = steps;
  if (capability.kind === 'limitedRecent') {
    retained = steps.slice(Math.max(0, steps.length - capability.windowSteps));
  }

  const lines: string[] = [];
  lines.push(`Persona: ${personaPrompt}`);
  lines.push(`User story: ${userStory}`);
  lines.push('Steps you remember:');
  for (const s of retained) {
    lines.push(`- step ${s.stepIndex}: ${s.url} (${s.title}) action=${s.action ? JSON.stringify(s.action) : 'none'} result=${s.result ? s.result.status : 'n/a'}`);
  }
  if (lastObs) {
    lines.push(`Last seen page: ${lastObs.url} - ${lastObs.title}`);
  }
  return [
    {
      role: 'user',
      content: lines.join('\n'),
    },
  ];
}
