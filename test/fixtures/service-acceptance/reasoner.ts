/**
 * The Reasoner double for the 0.4.0 acceptance scenario (Issue #67).
 *
 * ## No external API key
 *
 * ADR-0011 and `CLAUDE.md` §3 require CI never to depend on an external
 * API key. Every reasoning decision this scenario makes is therefore
 * taken by a local, deterministic double. Nothing here is a mock of the
 * *product* path: the adapter, the capability enforcement, the evidence
 * recorder, the observer projection and the durable store are all real.
 *
 * ## The double is driven by the run, not by a constant
 *
 * The failure this scenario most has to avoid is a finding that appears
 * because the fixture said so. So neither role is allowed to assert a
 * conclusion it did not read out of the evidence it was handed:
 *
 * - **The participant** decides what it remembers from the *durable
 *   cohort state* the scenario read back off disk after version A. A
 *   cohort with no earlier observation self-reports an empty, aligned
 *   session; a cohort with an earlier observation at a different
 *   version self-reports the mismatch. Same code, different durable
 *   bytes, different self-report.
 * - **The observer** decides whether to report a longitudinal finding by
 *   parsing the compact trace it was actually given. It reports the
 *   mismatch only if that trace carries a self-report whose
 *   `wouldReturn` is `false` from the returning cohort. Remove the
 *   retained history and the trace no longer carries that line, so the
 *   observer has nothing to report and says so.
 *
 * That is what makes the control case in
 * `control-cases.browser-acceptance.ts` meaningful: the same harness,
 * the same environment and the same code produce no finding when the one
 * changed input is the cohort's retained history.
 *
 * ## What the participant Reasoner cannot see, stated plainly
 *
 * The participant's current-step prompt carries only `url`, `title` and
 * `ts` (`src/capability/memory-controller.ts`), not the rendered page
 * text. So this double cannot decide "the list is empty" by reading the
 * screen. It decides from the durable retained state, which is the
 * experimental condition ADR-0011 describes ("the retained history is
 * part of the experimental condition"). The page-level A-versus-B
 * difference is asserted separately and directly, against the two live
 * instances over HTTP, so nothing in the scenario rests on the
 * participant being able to read pixels.
 */

import type { ParticipantAction } from '../../../src/domain/capability.js';
import type { ObserverFindingSeverity } from '../../../src/domain/observer.js';
import type { Reasoner, ReasonerRequest, ReasonerResponse } from '../../../src/domain/reasoner.js';
import { detectStructuredOutputKind } from '../../../src/reasoner/structured.js';
import type { RuntimeReasonerFactory } from '../../../src/runtime/index.js';

/**
 * What a cohort's durable record says about a version it has already
 * experienced. Read back through a *second* `CohortStateService` over
 * the same bytes, so this is a property of the store rather than of the
 * object the first run happened to hold.
 */
export interface RetainedMemory {
  /** Task titles this cohort demonstrably created in an earlier version. */
  readonly priorTitles: readonly string[];
  /** The version the cohort last observed, when it has one. */
  readonly lastVersion?: string;
  /** Environment the cohort last observed. */
  readonly lastEnvironmentId?: string;
}

/** The title this scenario uses for the task version A's cohort created. */
export const TASK_CREATED_IN_A = 'Renew the passport before June';
/** The title the returning cohort creates in version B. */
export const TASK_CREATED_IN_B = 'Re-issue the parking permit';

/** The one longitudinal problem this scenario looks for, in full. */
export const LONGITUDINAL_TITLE =
  'A returning user who added a task in version 2026.10.1 found the version 2026.10.2 ' +
  'task list empty and could not reconcile the two.';

export interface AcceptanceReasonerOptions {
  /**
   * Per-participant durable memory, keyed by `SyntheticIdentityId`.
   *
   * Absent entries behave exactly like an identity with no history.
   */
  readonly memory?: ReadonlyMap<string, RetainedMemory>;
  /**
   * The identity whose durable record carries the earlier version. Only
   * this identity can produce the longitudinal finding, and only if the
   * trace shows the self-report that record implies.
   */
  readonly returningIdentityId: string;
  /**
   * Emit one privileged action attempt before following the script.
   *
   * The response is deliberately *not* a `ParticipantAction`: it is the
   * shape a reasoner produces when it reaches for a primitive no
   * capability profile grants, and the structured boundary is what has
   * to refuse it. Used only by the control case.
   */
  readonly privilegedAttemptKind?: 'selectorClick' | 'evaluateJs' | 'getDomTree' | 'readInternalMetadata';
  /**
   * Free-text self-report override, for reasons a control case needs to
   * state. Never used by the accepted scenario.
   */
  readonly selfReportOverride?: Partial<{
    readonly productUnderstanding: string;
    readonly confusionPoints: ReadonlyArray<string>;
    readonly resultAlignedWithExpectation: boolean;
    readonly confidence: number;
    readonly wouldReturn: boolean;
    readonly freeText: string;
  }>;
}

/** One `selfReport` line, as the observer's compact trace renders it. */
const SELF_REPORT_LINE = /selfReport p=(\S+) confidence=([0-9.]+) wouldReturn=(true|false)/;

interface ParsedSelfReport {
  readonly participantId: string;
  readonly confidence: number;
  readonly wouldReturn: boolean;
}

/** Read the self-reports out of the compact trace the observer was given. */
export function parseSelfReports(compactTrace: string): ReadonlyArray<ParsedSelfReport> {
  const out: ParsedSelfReport[] = [];
  for (const line of compactTrace.split('\n')) {
    const match = SELF_REPORT_LINE.exec(line);
    if (match === null) continue;
    const [, participantId, confidence, wouldReturn] = match;
    if (participantId === undefined || confidence === undefined || wouldReturn === undefined) continue;
    out.push({
      participantId,
      confidence: Number.parseFloat(confidence),
      wouldReturn: wouldReturn === 'true',
    });
  }
  return out;
}

export function createAcceptanceReasoner(
  options: AcceptanceReasonerOptions,
): RuntimeReasonerFactory {
  return (_config, ctx) => {
    let cursor = 0;
    const script: ReadonlyArray<ParticipantAction> = ctx.script ?? [];
    const memory = options.memory?.get(ctx.participantLabel);

    const reasoner: Reasoner = {
      providerId: 'scripted',
      modelId: 'scripted:acceptance-67',
      complete: async (request: ReasonerRequest): Promise<ReasonerResponse> => {
        const kind = detectStructuredOutputKind(request.systemPrompt);

        if (kind === 'selfReport') {
          return {
            kind: 'selfReport',
            content: selfReportFor(ctx.participantLabel, memory, options),
            usage: { inputTokens: 48, outputTokens: 48 },
          };
        }

        if (kind === 'observerFindings') {
          return {
            kind: 'observerFindings',
            content: observerFindingsFor(request, options),
            usage: { inputTokens: 96, outputTokens: 96 },
          };
        }

        // The one cast in this deliverable, and it is the point of the
        // control case: `evaluateJs` and friends are not in
        // `ParticipantAction`, so a reasoner that returns one is a reasoner
        // that has been given a response the type system says is
        // impossible. Constructing that value is the whole control — a
        // response the boundary must refuse — and it is reachable only
        // when a caller passes `privilegedAttemptKind`, which only
        // `executePrivilegedAttempt` does.
        if (options.privilegedAttemptKind !== undefined && cursor === 0) {
          cursor += 1;
          return {
            kind: 'action',
            action: { kind: options.privilegedAttemptKind, payload: { selector: '#app' } },
            rationale: 'privileged probe',
            usage: { inputTokens: 16, outputTokens: 16 },
          } as unknown as ReasonerResponse;
        }

        const action = script[cursor];
        if (action === undefined) {
          return {
            kind: 'action',
            action: { kind: 'finish', reason: 'script exhausted' },
            rationale: 'Script exhausted.',
            usage: { inputTokens: 16, outputTokens: 16 },
          };
        }
        cursor += 1;
        return {
          kind: 'action',
          action,
          rationale: `scripted step ${cursor}`,
          usage: { inputTokens: 16, outputTokens: 16 },
        };
      },
    };
    return reasoner;
  };
}

/**
 * The participant's own account of the session, decided by its durable
 * record.
 *
 * A cohort with no earlier observation and a cohort returning from a
 * different version take visibly different paths through this function,
 * which is the whole point of evaluation mode 2: the difference is the
 * retained history, not the environment.
 */
function selfReportFor(
  participantLabel: string,
  memory: RetainedMemory | undefined,
  options: AcceptanceReasonerOptions,
): Record<string, unknown> {
  const returning = participantLabel === options.returningIdentityId;
  const priorTitles = memory?.priorTitles ?? [];
  const carriesHistoryFromAnotherVersion =
    returning && priorTitles.length > 0 && memory?.lastVersion !== undefined;

  const base = {
    goal: 'Check the task list and keep it current.',
    productUnderstanding:
      'A single-page task list with one text field and an Add button, plus a Settings ' +
      'page that does nothing yet.',
    confidence: carriesHistoryFromAnotherVersion ? 0.3 : 0.8,
    wouldReturn: !carriesHistoryFromAnotherVersion,
    resultAlignedWithExpectation: !carriesHistoryFromAnotherVersion,
    confusionPoints: carriesHistoryFromAnotherVersion
      ? [
          `The task "${priorTitles[0] ?? ''}" I created in version ${memory?.lastVersion ?? ''} is ` +
            'not on this list, and nothing on the page explains where it went.',
        ]
      : [],
    freeText: carriesHistoryFromAnotherVersion
      ? 'I added something last time. This list is empty, so either my task was lost or ' +
        'this is a different list. I cannot tell which, and the page does not say.'
      : 'I added a task and it appeared. Nothing surprised me.',
  };

  return { ...base, ...options.selfReportOverride };
}

interface ObserverFindingSpec {
  readonly id: string;
  readonly summary: string;
  readonly severity: ObserverFindingSeverity;
  readonly category: string;
  readonly stepIndex: number | null;
}

/**
 * The observer's report, decided by the compact trace it was handed.
 *
 * The trace is the only thing the observer sees. If it does not carry a
 * self-report from the returning cohort saying the session did not meet
 * expectations, the observer has no observation of a longitudinal problem
 * and reports none — with a summary that says so, rather than an empty
 * report that reads like "nothing was wrong".
 */
function observerFindingsFor(request: ReasonerRequest, options: AcceptanceReasonerOptions): {
  readonly summary: string;
  readonly findings: ReadonlyArray<ObserverFindingSpec>;
  readonly terminationVerdict: { readonly declared: string; readonly plausible: boolean; readonly note: string };
} {
  const compactTrace = request.messages.map((m) => m.content).join('\n');
  const selfReports = parseSelfReports(compactTrace);
  const returningReport = selfReports.find((r) => r.participantId === options.returningIdentityId);

  const reportsMismatch = returningReport !== undefined && returningReport.wouldReturn === false;

  if (!reportsMismatch) {
    return {
      summary:
        selfReports.length === 0
          ? 'observer: no participant self-report reached the trace, so this run produced no ' +
            'reportable product observation.'
          : 'observer: every cohort in this run reported a session aligned with its expectations; ' +
            'no returning-user mismatch is present in the trace.',
      findings: [],
      terminationVerdict: {
        declared: 'finish',
        plausible: true,
        note: 'Acceptance-scenario observer. Nothing in the trace supported a product finding.',
      },
    };
  }

  return {
    summary:
      'The returning cohort carried a task from an earlier version and found no trace of it ' +
      'in the newer one; the trace records that as a session that did not meet expectations.',
    findings: [
      {
        id: 'obs-returning-mismatch',
        summary: LONGITUDINAL_TITLE,
        severity: 'major',
        category: 'trust',
        stepIndex: 0,
      },
    ],
    terminationVerdict: {
      declared: 'finish',
      plausible: true,
      note: 'Acceptance-scenario observer, reporting from the trace it was given.',
    },
  };
}
