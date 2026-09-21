/**
 * Participant runtime (ADR-0006). Single-step inner loop:
 *
 *   1. adapter.open(url)
 *   2. for step in [0, budget):
 *        a. observer = adapter.observe(step)
 *        b. participantObs = applyParticipantObservation(observer, capability)
 *        c. request = buildReasonerRequest(...)
 *        d. reasoner.complete(request)
 *        e. action = result.action ; enforceActionAllowlist(...)
 *        f. result  = adapter.execute(action)
 *        g. recorder.append(...)
 *        h. if action.kind === 'finish' -> terminate
 *   3. selfReport = askReasonerForSelfReport(participantMemoryOnly)
 *
 * The participant runtime NEVER sees the observer observation's DOM /
 * console / network — only the filtered participant view.
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
import {
  applyParticipantObservation,
  assertNoPrivilegedLeak,
  enforceActionAllowlist,
  buildReasonerRequest,
  memoryWindowDescription,
} from '../capability/index.js';
import { CapabilityViolation, StepBudgetExceeded } from '../domain/errors.js';
import {
  participantActionSystemPrompt,
  participantSelfReportSystemPrompt,
} from './system-prompt.js';
import { fnv1aHex } from '../evidence/hash.js';
import { isParticipantAction } from '../domain/capability.js';

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
}

export interface ParticipantRuntimeResult {
  readonly steps: number;
  readonly selfReport: SelfReport;
  readonly terminationReason:
    | 'finish'
    | 'stepBudgetExceeded'
    | 'capabilityViolation'
    | 'error';
  readonly error?: string;
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

      const reasonerResponse = await reasoner.complete(outcome.request);

      await recorder.append({
        type: 'reasoner.response',
        runId,
        participantId,
        stepIndex,
        ts: new Date().toISOString(),
        response: reasonerResponse,
      });

      if (reasonerResponse.kind === 'refusal') {
        // Recover by waiting one step.
        const fallback: ParticipantAction = { kind: 'wait', milliseconds: 250 };
        await recorder.append({
          type: 'action',
          runId,
          participantId,
          stepIndex,
          ts: new Date().toISOString(),
          action: fallback,
        });
        const ar = await adapter.execute(fallback);
        await recorder.append({
          type: 'action.result',
          runId,
          participantId,
          stepIndex,
          ts: new Date().toISOString(),
          result: ar,
        });
        steps += 1;
        continue;
      }

      if (reasonerResponse.kind !== 'action') {
        lastError = `unexpected reasoner response kind: ${reasonerResponse.kind}`;
        await recorder.append({
          type: 'capability.violation',
          runId,
          participantId,
          stepIndex,
          ts: new Date().toISOString(),
          axis: 'action',
          reason: lastError,
        });
        terminationReason = 'error';
        break;
      }

      const action = reasonerResponse.action;
      if (!isParticipantAction(action)) {
        await recorder.append({
          type: 'capability.violation',
          runId,
          participantId,
          stepIndex,
          ts: new Date().toISOString(),
          axis: 'action',
          reason: 'non-participant action shape',
        });
        terminationReason = 'capabilityViolation';
        break;
      }

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
      reason: terminationReason === 'finish' ? 'finish' : terminationReason === 'capabilityViolation' ? 'capabilityViolation' : 'error',
    });
  }

  const selfReport = await generateSelfReport(opts, recorder, reasoner);

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

  const response = await reasoner.complete({
    systemPrompt: selfReportSystemPrompt,
    messages,
    maxTokens: 384,
  });
  if (response.kind !== 'selfReport') {
    return {
      participantId,
      capturedAt: new Date().toISOString(),
      goal: '',
      productUnderstanding: '',
      confusionPoints: [],
      resultAlignedWithExpectation: false,
      confidence: 0,
      wouldReturn: false,
      freeText: 'selfReport unavailable',
    };
  }

  const content = response.content;
  const report: SelfReport = {
    participantId,
    capturedAt: new Date().toISOString(),
    goal: stringField(content.goal),
    productUnderstanding: stringField(content.productUnderstanding),
    confusionPoints: stringArrayField(content.confusionPoints),
    resultAlignedWithExpectation: Boolean(content.resultAlignedWithExpectation),
    confidence: clamp01(numberField(content.confidence)),
    wouldReturn: Boolean(content.wouldReturn),
    freeText: stringField(content.freeText),
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

function stringField(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function stringArrayField(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function numberField(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
