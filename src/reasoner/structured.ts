/**
 * Structured Reasoner output boundary (ADR-0008).
 *
 * This module is the ONLY place where a raw provider payload becomes a
 * typed domain value. It owns:
 *
 * 1. the four-way failure taxonomy
 *    (`providerTransport` | `providerParse` | `contractValidation` |
 *    `capabilityViolation`),
 * 2. the declared contract for each of the three structured outputs
 *    (action / selfReport / observerFindings),
 * 3. the bounded recovery policy used when a recoverable failure occurs.
 *
 * Two invariants matter most:
 *
 * - A parse or contract failure is NEVER reported as a capability
 *   violation. Only a parsed action whose `kind` is a recognised
 *   privileged primitive is a `capabilityViolation`, and it is never
 *   retried.
 * - Recovery is bounded by attempt count AND by wall-clock. Exhaustion is
 *   a terminal, correctly classified outcome, never a silent fallback.
 *
 * Runtime validation is the enforcement mechanism; system prompts are not
 * the source of truth (ADR-0008).
 */

import {
  CapabilityViolation,
  ProviderError,
  StructuredOutputError,
} from '../domain/errors.js';
import type {
  StructuredFailureKind,
  StructuredOutputErrorKind,
  StructuredOutputFailureDetail,
} from '../domain/errors.js';
import {
  describeParticipantActionDefect,
  isParticipantAction,
  isPrivilegedActionAttempt,
  isPrivilegedActionKind,
} from '../domain/capability.js';
import type { ParticipantAction, PrivilegedActionAttempt } from '../domain/capability.js';
import type { Reasoner, ReasonerRequest, ReasonerResponse } from '../domain/reasoner.js';
import type { ObserverFindingSeverity } from '../domain/observer.js';

// ---------------------------------------------------------------------------
// Output kinds and prompt markers
// ---------------------------------------------------------------------------

export type StructuredOutputKind = 'action' | 'selfReport' | 'observerFindings';

export type StructuredChannel = 'participant' | 'observer' | 'selfReport';

function channelOf(outputKind: StructuredOutputKind): StructuredChannel {
  switch (outputKind) {
    case 'action':
      return 'participant';
    case 'selfReport':
      return 'selfReport';
    case 'observerFindings':
      return 'observer';
  }
}

/**
 * Markers shared by the system-prompt builders and the boundary's kind
 * detection. Keeping them here means the prompt text and the contract
 * selector cannot drift apart, without adding any prompt instruction.
 */
export const PARTICIPANT_ACTION_OUTPUT_MARKER = 'Pick exactly one primitive per call';
export const SELF_REPORT_OUTPUT_MARKER = 'Emit a JSON object matching the SelfReport shape';
export const OBSERVER_OUTPUT_MARKER = 'Produce an ObserverFindings JSON object';

/**
 * Which structured output the caller expects. The action flow is the
 * default so an unrecognised prompt still validates as an action request
 * rather than silently bypassing validation.
 */
export function detectStructuredOutputKind(systemPrompt: string): StructuredOutputKind {
  if (systemPrompt.includes(SELF_REPORT_OUTPUT_MARKER)) return 'selfReport';
  if (systemPrompt.includes(OBSERVER_OUTPUT_MARKER)) return 'observerFindings';
  return 'action';
}

// ---------------------------------------------------------------------------
// Diagnostics: bounded, redacted excerpts
// ---------------------------------------------------------------------------

/** Hard cap for any provider text kept in evidence or error messages. */
export const EXCERPT_MAX_LENGTH = 200;

const REDACTED = '[redacted]';

/**
 * Patterns that indicate a credential may be present in provider text.
 * Redaction is defence in depth: the boundary never requests or echoes
 * HTTP headers, and a compliant provider never returns its own key. A
 * provider that echoes a request can however return a key without any
 * label, so the opaque-token patterns are not optional.
 *
 * Order matters: the labelled forms are matched first so a diagnostic
 * keeps the field name it came from.
 *
 * Thresholds are chosen so that a redacted excerpt stays diagnosable: an
 * ordinary hyphenated English phrase (`structured-output`) and a long
 * camelCase field name (`resultAlignedWithExpectation`) must survive,
 * while a key-shaped token must not. Keys are opaque, so they virtually
 * always contain a digit or a separator — that is the discriminator.
 */
const CREDENTIAL_PATTERNS: ReadonlyArray<RegExp> = [
  // `x-api-key: …`, `authorization: Bearer …`, `"api_key":"…"`,
  // `api_key=…`, `password: …`. An optional closing quote lets a JSON
  // body match, and an optional auth scheme lets the whole
  // `Bearer <token>` pair be consumed in one pass — otherwise a short
  // token would survive after its label was already stripped.
  /((?:x-)?api[-_]?key|authorization|secret[-_]?key|access[-_]?token|auth[-_]?token|password|passwd)"?\s*[:=]\s*"?(?:(?:Bearer|Basic)\s+)?[^\s",;}]+/gi,
  // `sk-…` style provider keys.
  /\bsk-[A-Za-z0-9_-]{6,}/g,
  // `Bearer <token>` / `Basic <token>` with no label in front.
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{6,}=*/gi,
  // Opaque hyphen/underscore-joined tokens of key length. A hyphenated
  // English phrase is rarely this long, so ordinary diagnostic wording
  // survives while an unlabelled key does not.
  /\b(?=[A-Za-z0-9_-]*[-_])[A-Za-z0-9_-]{20,}\b/g,
  // Long unbroken alphanumerics containing a digit: base64/hex digests
  // and raw tokens. Requiring a digit keeps a long camelCase field name
  // readable, which is the point of a diagnostic.
  /\b(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{24,}\b/g,
];

/**
 * Collapse whitespace, strip control characters, and cap the length.
 * This is the bound applied to messages the boundary authors itself; no
 * credential can be in them, so redaction would only destroy the
 * diagnostic.
 */
export function boundedInternalMessage(text: string): string {
  const collapsed = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= EXCERPT_MAX_LENGTH) return collapsed;
  return `${collapsed.slice(0, EXCERPT_MAX_LENGTH)}…[truncated ${collapsed.length - EXCERPT_MAX_LENGTH} chars]`;
}

/**
 * Produce a short, redacted, control-character-free excerpt of
 * *provider-derived* text, suitable for an event payload or an error
 * message. Never returns unbounded text, and never returns a credential.
 */
export function excerptForDiagnostics(text: string): string {
  const withoutControls = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ');
  const redacted = CREDENTIAL_PATTERNS.reduce(
    (acc, pattern) => acc.replace(pattern, (match) => {
      const label = /^([A-Za-z_-]+)"?\s*[:=]/.exec(match);
      return label ? `${label[1]}=${REDACTED}` : REDACTED;
    }),
    withoutControls,
  );
  return boundedInternalMessage(redacted);
}

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

/**
 * Extract the first JSON object from assistant text, or `null` when none
 * can be found. Never throws: "no JSON object" is a `providerParse`
 * classification decision for the caller, not an exception here.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  try {
    const direct = JSON.parse(trimmed);
    if (typeof direct === 'object' && direct !== null && !Array.isArray(direct)) {
      return direct as Record<string, unknown>;
    }
  } catch {
    /* fall through to the substring scan */
  }
  const match = /\{[\s\S]*\}/.exec(trimmed);
  if (match) {
    try {
      const inner = JSON.parse(match[0]);
      if (typeof inner === 'object' && inner !== null && !Array.isArray(inner)) {
        return inner as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Declared contracts
// ---------------------------------------------------------------------------

export interface StructuredOutputContext {
  readonly provider: string;
  readonly modelId: string;
  readonly attempt?: number;
  readonly maxAttempts?: number;
}

function withContext(
  detail: StructuredOutputFailureDetail,
  ctx: StructuredOutputContext,
  outputKind: StructuredOutputKind,
): StructuredOutputFailureDetail {
  return {
    provider: ctx.provider,
    modelId: ctx.modelId,
    outputKind,
    ...(ctx.attempt !== undefined ? { attempt: ctx.attempt } : {}),
    ...(ctx.maxAttempts !== undefined ? { maxAttempts: ctx.maxAttempts } : {}),
    ...detail,
  };
}

function contractError(
  message: string,
  ctx: StructuredOutputContext,
  outputKind: StructuredOutputKind,
  detail: StructuredOutputFailureDetail = {},
): StructuredOutputError {
  return new StructuredOutputError(
    message,
    'contractValidation',
    withContext(detail, ctx, outputKind),
  );
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

const FINDING_SEVERITIES: ReadonlySet<string> = new Set<ObserverFindingSeverity>([
  'info',
  'minor',
  'major',
  'critical',
]);

const FINDING_CATEGORIES: ReadonlySet<string> = new Set([
  'dead_end',
  'friction',
  'confusion',
  'trust',
  'navigation',
  'timing',
  'error',
  'positive',
]);

const EVIDENCE_REF_KINDS: ReadonlySet<string> = new Set(['event', 'observation', 'selfReport']);

/** Total, validated participant self-report content. */
export interface ValidatedSelfReportContent {
  readonly goal: string;
  readonly productUnderstanding: string;
  readonly confusionPoints: ReadonlyArray<string>;
  readonly resultAlignedWithExpectation: boolean;
  readonly confidence: number;
  readonly wouldReturn: boolean;
  readonly freeText: string;
}

/** Total, validated observer findings content. */
export interface ValidatedObserverFinding {
  readonly id: string;
  readonly stepIndex: number | null;
  readonly severity: ObserverFindingSeverity;
  readonly category: string;
  readonly summary: string;
  readonly evidenceRefs: ReadonlyArray<{ kind: 'event' | 'observation' | 'selfReport'; ref: string }>;
}

export interface ValidatedObserverFindingsContent {
  readonly summary: string;
  readonly findings: ReadonlyArray<ValidatedObserverFinding>;
  readonly terminationVerdict: { declared: string; plausible: boolean; note: string };
}

/**
 * Validate a participant action payload.
 *
 * A recognised privileged `kind` is a genuine `CapabilityViolation` and
 * throws as such. Every other structural defect is a
 * `contractValidation` failure — this is the distinction the Issue is
 * about.
 */
export function validateActionContent(
  raw: unknown,
  ctx: StructuredOutputContext,
): ParticipantAction {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw contractError(
      `action output must be a JSON object, received ${raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw}`,
      ctx,
      'action',
    );
  }
  const obj = raw as Record<string, unknown>;
  if (isPrivilegedActionAttempt(obj)) {
    throw new CapabilityViolation(
      `privileged action attempt "${String(obj['kind'])}" is not in the human-facing set`,
      'action',
      { attemptKind: obj['kind'], provider: ctx.provider },
    );
  }
  if (isPrivilegedActionKind(obj['kind'])) {
    // Privileged kind with a malformed payload: still a capability
    // violation, because the intent to reach a privileged primitive is
    // unambiguous.
    throw new CapabilityViolation(
      `privileged action attempt "${String(obj['kind'])}" is not in the human-facing set`,
      'action',
      { attemptKind: obj['kind'], provider: ctx.provider, payloadDefect: true },
    );
  }
  const defect = describeParticipantActionDefect(obj);
  if (defect !== null) {
    throw contractError(`action contract violation: ${defect}`, ctx, 'action');
  }
  return obj as unknown as ParticipantAction;
}

/**
 * Validate a participant self-report payload. Required fields are the
 * ones the run result depends on; the two derivable fields default when
 * absent, but a present value of the wrong type is a violation.
 */
export function validateSelfReportContent(
  raw: unknown,
  ctx: StructuredOutputContext,
): ValidatedSelfReportContent {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw contractError('selfReport output must be a JSON object', ctx, 'selfReport');
  }
  const o = raw as Record<string, unknown>;
  if (!isString(o['goal'])) {
    throw contractError('selfReport: "goal" must be a string', ctx, 'selfReport');
  }
  if (!isString(o['productUnderstanding'])) {
    throw contractError('selfReport: "productUnderstanding" must be a string', ctx, 'selfReport');
  }
  if (!isBoolean(o['resultAlignedWithExpectation'])) {
    throw contractError('selfReport: "resultAlignedWithExpectation" must be a boolean', ctx, 'selfReport');
  }
  if (!isBoolean(o['wouldReturn'])) {
    throw contractError('selfReport: "wouldReturn" must be a boolean', ctx, 'selfReport');
  }
  const confidence = o['confidence'];
  if (!isFiniteNumber(confidence) || confidence < 0 || confidence > 1) {
    throw contractError(
      `selfReport: "confidence" must be a number in [0,1], received ${String(confidence)}`,
      ctx,
      'selfReport',
    );
  }
  const confusionPointsRaw = o['confusionPoints'];
  let confusionPoints: ReadonlyArray<string> = [];
  if (confusionPointsRaw !== undefined) {
    if (!Array.isArray(confusionPointsRaw) || !confusionPointsRaw.every(isString)) {
      throw contractError('selfReport: "confusionPoints" must be an array of strings', ctx, 'selfReport');
    }
    confusionPoints = confusionPointsRaw as ReadonlyArray<string>;
  }
  const freeText = o['freeText'];
  if (freeText !== undefined && !isString(freeText)) {
    throw contractError('selfReport: "freeText" must be a string', ctx, 'selfReport');
  }
  return {
    goal: o['goal'],
    productUnderstanding: o['productUnderstanding'],
    confusionPoints,
    resultAlignedWithExpectation: o['resultAlignedWithExpectation'],
    confidence,
    wouldReturn: o['wouldReturn'],
    freeText: isString(freeText) ? freeText : '',
  };
}

/**
 * Validate an observer findings payload. Findings are never silently
 * coerced: a malformed finding is a contract failure, not an
 * `unparseable finding` placeholder.
 */
export function validateObserverFindingsContent(
  raw: unknown,
  ctx: StructuredOutputContext,
): ValidatedObserverFindingsContent {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw contractError('observerFindings output must be a JSON object', ctx, 'observerFindings');
  }
  const o = raw as Record<string, unknown>;
  if (!isString(o['summary'])) {
    throw contractError('observerFindings: "summary" must be a string', ctx, 'observerFindings');
  }
  const findingsRaw = o['findings'];
  if (!Array.isArray(findingsRaw)) {
    throw contractError('observerFindings: "findings" must be an array', ctx, 'observerFindings');
  }
  const verdictRaw = o['terminationVerdict'];
  if (typeof verdictRaw !== 'object' || verdictRaw === null || Array.isArray(verdictRaw)) {
    throw contractError('observerFindings: "terminationVerdict" must be an object', ctx, 'observerFindings');
  }

  const findings = findingsRaw.map((entry, idx) => validateObserverFinding(entry, idx, ctx));
  const verdict = verdictRaw as Record<string, unknown>;
  if (verdict['declared'] !== undefined && !isString(verdict['declared'])) {
    throw contractError('observerFindings: "terminationVerdict.declared" must be a string', ctx, 'observerFindings');
  }
  if (verdict['plausible'] !== undefined && !isBoolean(verdict['plausible'])) {
    throw contractError('observerFindings: "terminationVerdict.plausible" must be a boolean', ctx, 'observerFindings');
  }
  if (verdict['note'] !== undefined && !isString(verdict['note'])) {
    throw contractError('observerFindings: "terminationVerdict.note" must be a string', ctx, 'observerFindings');
  }

  return {
    summary: o['summary'],
    findings,
    terminationVerdict: {
      declared: isString(verdict['declared']) ? verdict['declared'] : '',
      plausible: verdict['plausible'] === true,
      note: isString(verdict['note']) ? verdict['note'] : '',
    },
  };
}

function validateObserverFinding(
  entry: unknown,
  idx: number,
  ctx: StructuredOutputContext,
): ValidatedObserverFinding {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw contractError(
      `observerFindings: findings[${idx}] must be a JSON object`,
      ctx,
      'observerFindings',
    );
  }
  const o = entry as Record<string, unknown>;
  if (!isString(o['summary'])) {
    throw contractError(
      `observerFindings: findings[${idx}].summary must be a string`,
      ctx,
      'observerFindings',
    );
  }
  const severity = o['severity'];
  if (severity !== undefined && (typeof severity !== 'string' || !FINDING_SEVERITIES.has(severity))) {
    throw contractError(
      `observerFindings: findings[${idx}].severity must be one of info|minor|major|critical`,
      ctx,
      'observerFindings',
    );
  }
  const category = o['category'];
  if (category !== undefined && (typeof category !== 'string' || !FINDING_CATEGORIES.has(category))) {
    throw contractError(
      `observerFindings: findings[${idx}].category is not a known finding category`,
      ctx,
      'observerFindings',
    );
  }
  const stepIndex = o['stepIndex'];
  if (stepIndex !== undefined && stepIndex !== null && !isFiniteNumber(stepIndex)) {
    throw contractError(
      `observerFindings: findings[${idx}].stepIndex must be a number or null`,
      ctx,
      'observerFindings',
    );
  }
  const id = o['id'];
  if (id !== undefined && !isString(id)) {
    throw contractError(
      `observerFindings: findings[${idx}].id must be a string`,
      ctx,
      'observerFindings',
    );
  }

  let evidenceRefs: ReadonlyArray<{ kind: 'event' | 'observation' | 'selfReport'; ref: string }> = [];
  const refsRaw = o['evidenceRefs'];
  if (refsRaw !== undefined) {
    if (!Array.isArray(refsRaw)) {
      throw contractError(
        `observerFindings: findings[${idx}].evidenceRefs must be an array`,
        ctx,
        'observerFindings',
      );
    }
    evidenceRefs = refsRaw.map((r, refIdx) => {
      if (typeof r !== 'object' || r === null || Array.isArray(r)) {
        throw contractError(
          `observerFindings: findings[${idx}].evidenceRefs[${refIdx}] must be an object`,
          ctx,
          'observerFindings',
        );
      }
      const er = r as Record<string, unknown>;
      if (typeof er['kind'] !== 'string' || !EVIDENCE_REF_KINDS.has(er['kind'])) {
        throw contractError(
          `observerFindings: findings[${idx}].evidenceRefs[${refIdx}].kind must be event|observation|selfReport`,
          ctx,
          'observerFindings',
        );
      }
      if (!isString(er['ref'])) {
        throw contractError(
          `observerFindings: findings[${idx}].evidenceRefs[${refIdx}].ref must be a string`,
          ctx,
          'observerFindings',
        );
      }
      return {
        kind: er['kind'] as 'event' | 'observation' | 'selfReport',
        ref: er['ref'],
      };
    });
  }

  return {
    id: isString(id) ? id : `f-${idx}`,
    stepIndex: typeof stepIndex === 'number' ? stepIndex : null,
    severity: (typeof severity === 'string' ? severity : 'info') as ObserverFindingSeverity,
    category: typeof category === 'string' ? category : 'positive',
    summary: o['summary'],
    evidenceRefs,
  };
}

// ---------------------------------------------------------------------------
// Entry point: raw assistant text -> typed ReasonerResponse
// ---------------------------------------------------------------------------

export interface ParseStructuredOutputOptions extends StructuredOutputContext {
  readonly usage?: { inputTokens: number; outputTokens: number };
  /** Short rationale recorded on an action response. */
  readonly rationale?: string;
}

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0 } as const;

/**
 * Turn raw assistant text into a typed `ReasonerResponse`, or throw.
 *
 * Throws `StructuredOutputError('providerParse')` when no JSON object can
 * be extracted, `StructuredOutputError('contractValidation')` when the
 * object violates the declared contract for `outputKind`, and
 * `CapabilityViolation` when a parsed action attempts a privileged
 * primitive.
 */
export function parseStructuredOutput(
  outputKind: StructuredOutputKind,
  text: string,
  opts: ParseStructuredOutputOptions,
): ReasonerResponse {
  const usage = opts.usage ?? ZERO_USAGE;
  const raw = extractJsonObject(text);
  if (raw === null) {
    throw new StructuredOutputError(
      'assistant output contained no JSON object',
      'providerParse',
      withContext({ excerpt: excerptForDiagnostics(text) }, opts, outputKind),
    );
  }
  switch (outputKind) {
    case 'action': {
      const action = validateActionContent(raw, opts);
      return {
        kind: 'action',
        action,
        rationale: opts.rationale ?? excerptForDiagnostics(text),
        usage,
      };
    }
    case 'selfReport': {
      validateSelfReportContent(raw, opts);
      return { kind: 'selfReport', content: raw, usage };
    }
    case 'observerFindings': {
      validateObserverFindingsContent(raw, opts);
      return { kind: 'observerFindings', content: raw, usage };
    }
  }
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

export interface StructuredFailureClassification {
  readonly failureKind: StructuredFailureKind;
  readonly message: string;
  readonly detail: StructuredOutputFailureDetail;
}

/**
 * Map any thrown value onto the four-way taxonomy. `ProviderError` is
 * accepted for adapters that have not yet moved to `StructuredOutputError`
 * so a third-party Reasoner still lands in `providerTransport` rather than
 * an untyped runtime error.
 */
export function classifyStructuredFailure(err: unknown): StructuredFailureClassification {
  if (err instanceof StructuredOutputError) {
    return {
      failureKind: err.failureKind,
      message: err.message,
      detail: err.detail,
    };
  }
  if (err instanceof CapabilityViolation) {
    return {
      failureKind: 'capabilityViolation',
      message: err.message,
      detail: { axis: err.axis },
    };
  }
  if (err instanceof ProviderError) {
    const status = err.detail['status'];
    return {
      failureKind: 'providerTransport',
      message: err.message,
      detail: {
        provider: err.provider,
        ...(typeof status === 'number' ? { status } : {}),
      },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    failureKind: 'providerTransport',
    message: `unexpected reasoner failure: ${excerptForDiagnostics(message)}`,
    detail: {},
  };
}

/**
 * Decide whether a failure may be retried.
 *
 * `capabilityViolation` is never retryable. `providerTransport` is only
 * retryable for genuinely transient conditions: a network error or
 * timeout (no status), HTTP 429, or HTTP 5xx. A 4xx such as 400 / 401 /
 * 403 / 404 is a deterministic client error and fails immediately.
 */
export function isRetryableFailure(
  failureKind: StructuredFailureKind,
  detail: StructuredOutputFailureDetail,
  policy: StructuredOutputPolicy,
): boolean {
  if (failureKind === 'capabilityViolation') return false;
  if (!policy.retryOn.includes(failureKind)) return false;
  if (failureKind !== 'providerTransport') return true;
  const status = detail.status;
  if (status === undefined) return true;
  if (status === 429) return true;
  return status >= 500 && status <= 599;
}

// ---------------------------------------------------------------------------
// Bounded recovery
// ---------------------------------------------------------------------------

export type StructuredRecoveryOutcome = 'recovered' | 'exhausted';

export interface StructuredOutputPolicy {
  /** Total attempts per call, including the first. Clamped to [1, 8]. */
  readonly maxAttempts: number;
  /** Failure kinds eligible for a retry. `capabilityViolation` is always excluded. */
  readonly retryOn: ReadonlyArray<StructuredFailureKind>;
  /** Linear backoff base; attempt n waits `backoffMs * n`. */
  readonly backoffMs: number;
  /** Wall-clock ceiling for one whole recovery sequence. */
  readonly maxTotalMs: number;
  /** Wall-clock ceiling for a single attempt. */
  readonly attemptTimeoutMs: number;
  /** Injectable for tests; must resolve after the requested delay. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable clock in epoch milliseconds; used for the wall-clock ceiling. */
  readonly now?: () => number;
}

/** Hard ceiling on attempts so a misconfigured policy cannot create an unbounded loop. */
export const MAX_ATTEMPTS_CEILING = 8;

export const DEFAULT_STRUCTURED_OUTPUT_POLICY: StructuredOutputPolicy = {
  maxAttempts: 2,
  retryOn: ['providerTransport', 'providerParse', 'contractValidation'],
  backoffMs: 250,
  maxTotalMs: 30_000,
  attemptTimeoutMs: 15_000,
};

export function resolveStructuredOutputPolicy(
  policy?: Partial<StructuredOutputPolicy>,
): StructuredOutputPolicy {
  const merged: StructuredOutputPolicy = {
    maxAttempts: policy?.maxAttempts ?? DEFAULT_STRUCTURED_OUTPUT_POLICY.maxAttempts,
    retryOn: policy?.retryOn ?? DEFAULT_STRUCTURED_OUTPUT_POLICY.retryOn,
    backoffMs: policy?.backoffMs ?? DEFAULT_STRUCTURED_OUTPUT_POLICY.backoffMs,
    maxTotalMs: policy?.maxTotalMs ?? DEFAULT_STRUCTURED_OUTPUT_POLICY.maxTotalMs,
    attemptTimeoutMs: policy?.attemptTimeoutMs ?? DEFAULT_STRUCTURED_OUTPUT_POLICY.attemptTimeoutMs,
    ...(policy?.sleep !== undefined ? { sleep: policy.sleep } : {}),
    ...(policy?.now !== undefined ? { now: policy.now } : {}),
  };
  return { ...merged, maxAttempts: clampAttempts(merged.maxAttempts) };
}

function clampAttempts(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_ATTEMPTS_CEILING, Math.max(1, Math.floor(n)));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface StructuredAttemptFailure {
  /** 1-based attempt number. */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly outputKind: StructuredOutputKind;
  readonly channel: StructuredChannel;
  readonly provider: string;
  readonly modelId: string;
  readonly failureKind: StructuredFailureKind;
  /** Whether the taxonomy+policy considered this failure kind retryable. */
  readonly retryable: boolean;
  /** Whether another attempt was actually made afterwards. */
  readonly willRetry: boolean;
  /** Whether recovery eventually succeeded or the sequence was exhausted. */
  readonly recoveryOutcome: StructuredRecoveryOutcome;
  /** Redacted, bounded diagnostic message. */
  readonly message: string;
  readonly httpStatus?: number;
  readonly excerpt?: string;
  readonly ts: string;
}

export type StructuredRecoveryResult<T> =
  | {
      readonly status: 'ok';
      readonly value: T;
      readonly attempts: number;
      readonly failures: ReadonlyArray<StructuredAttemptFailure>;
    }
  | {
      readonly status: 'failed';
      readonly error: unknown;
      readonly failureKind: StructuredFailureKind;
      readonly attempts: number;
      readonly failures: ReadonlyArray<StructuredAttemptFailure>;
    };

interface MutableAttemptFailure {
  attempt: number;
  maxAttempts: number;
  outputKind: StructuredOutputKind;
  channel: StructuredChannel;
  provider: string;
  modelId: string;
  failureKind: StructuredFailureKind;
  retryable: boolean;
  willRetry: boolean;
  recoveryOutcome: StructuredRecoveryOutcome;
  message: string;
  httpStatus?: number;
  excerpt?: string;
  ts: string;
}

export interface StructuredRecoveryOptions<T> {
  readonly policy?: Partial<StructuredOutputPolicy>;
  readonly outputKind: StructuredOutputKind;
  readonly channel: StructuredChannel;
  readonly provider: string;
  readonly modelId: string;
  /** Performs one attempt. Must honour `signal` for the wall-clock bound to hold. */
  readonly invoke: (attempt: number, ctx: { signal: AbortSignal }) => Promise<T>;
  /** Optional post-condition check; throw to classify the value as a failure. */
  readonly validate?: (value: T) => void;
}

/**
 * Run `invoke` under a bounded recovery policy.
 *
 * Every failed attempt is recorded with its taxonomy classification. On
 * eventual success every recorded failure is marked `recovered`; on
 * exhaustion every recorded failure is marked `exhausted` and the last one
 * has `willRetry: false`. Retry-success and retry-exhaustion are therefore
 * distinguishable from the recorded evidence alone.
 */
export async function runWithStructuredOutputRecovery<T>(
  opts: StructuredRecoveryOptions<T>,
): Promise<StructuredRecoveryResult<T>> {
  const policy = resolveStructuredOutputPolicy(opts.policy);
  const now = policy.now ?? (() => Date.now());
  const sleep = policy.sleep ?? defaultSleep;
  const startedAt = now();
  const failures: MutableAttemptFailure[] = [];
  let attempts = 0;
  let lastError: unknown = undefined;
  let lastFailureKind: StructuredFailureKind = 'providerTransport';

  const freeze = (outcome: StructuredRecoveryOutcome): ReadonlyArray<StructuredAttemptFailure> => {
    if (outcome === 'exhausted' && failures.length > 0) {
      const last = failures[failures.length - 1] as MutableAttemptFailure;
      last.willRetry = false;
    }
    return failures.map((f) => ({ ...f, recoveryOutcome: outcome }));
  };

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const elapsed = now() - startedAt;
    const remaining = policy.maxTotalMs - elapsed;
    if (remaining <= 0) {
      lastError = new StructuredOutputError(
        'structured-output recovery wall-clock budget exhausted',
        'providerTransport',
        { timeout: true, provider: opts.provider, modelId: opts.modelId, outputKind: opts.outputKind },
      );
      lastFailureKind = 'providerTransport';
      attempts += 1;
      break;
    }

    attempts = attempt;
    const attemptBudget = Math.min(policy.attemptTimeoutMs, remaining);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, attemptBudget);
    try {
      const value = await opts.invoke(attempt, { signal: controller.signal });
      opts.validate?.(value);
      return { status: 'ok', value, attempts: attempt, failures: freeze('recovered') };
    } catch (err) {
      const classification = classifyStructuredFailure(err);
      const retryable = isRetryableFailure(classification.failureKind, classification.detail, policy);
      const willRetry = retryable && attempt < policy.maxAttempts;
      const detail = classification.detail;
      failures.push({
        attempt,
        maxAttempts: policy.maxAttempts,
        outputKind: opts.outputKind,
        channel: opts.channel,
        provider: detail.provider ?? opts.provider,
        modelId: detail.modelId ?? opts.modelId,
        failureKind: classification.failureKind,
        retryable,
        willRetry,
        recoveryOutcome: 'exhausted',
        // The boundary authored this message; bound it but keep the
        // offending field name readable.
        message: boundedInternalMessage(classification.message),
        ...(typeof detail.status === 'number' ? { httpStatus: detail.status } : {}),
        ...(detail.excerpt !== undefined ? { excerpt: detail.excerpt } : {}),
        ts: new Date().toISOString(),
      });
      lastError = err;
      lastFailureKind = classification.failureKind;
      if (!willRetry) break;
      const backoff = policy.backoffMs * attempt;
      if (now() - startedAt + backoff >= policy.maxTotalMs) {
        break;
      }
      await sleep(backoff);
    } finally {
      clearTimeout(timer);
    }
  }

  if (failures.length === 0) {
    // The wall-clock budget was exhausted before any attempt completed.
    failures.push({
      attempt: attempts,
      maxAttempts: policy.maxAttempts,
      outputKind: opts.outputKind,
      channel: opts.channel,
      provider: opts.provider,
      modelId: opts.modelId,
      failureKind: lastFailureKind,
      retryable: false,
      willRetry: false,
      recoveryOutcome: 'exhausted',
      message: boundedInternalMessage(lastError instanceof Error ? lastError.message : 'recovery aborted'),
      ts: new Date().toISOString(),
    });
  }

  return {
    status: 'failed',
    error: lastError,
    failureKind: lastFailureKind,
    attempts: failures.length,
    failures: freeze('exhausted'),
  };
}

// ---------------------------------------------------------------------------
// Runtime-facing helper
// ---------------------------------------------------------------------------

export interface CompleteStructuredOptions {
  readonly reasoner: Reasoner;
  readonly request: ReasonerRequest;
  /** Overrides the marker-based detection. */
  readonly expectedKind?: StructuredOutputKind;
  readonly policy?: Partial<StructuredOutputPolicy>;
  /**
   * Re-validates a returned `ReasonerResponse` against the declared
   * contract. This is the runtime enforcement point; the provider adapter
   * validating its own payload is a first line of defence, not a
   * substitute.
   */
  readonly validate?: (response: ReasonerResponse, outputKind: StructuredOutputKind) => void;
}

/**
 * Call a Reasoner under the structured-output boundary with bounded
 * recovery, and classify whatever comes back.
 */
export async function completeStructuredWithRecovery(
  opts: CompleteStructuredOptions,
): Promise<StructuredRecoveryResult<ReasonerResponse>> {
  const outputKind = opts.expectedKind ?? detectStructuredOutputKind(opts.request.systemPrompt);
  const provider = opts.reasoner.providerId;
  const modelId = opts.reasoner.modelId;
  return runWithStructuredOutputRecovery<ReasonerResponse>({
    ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
    outputKind,
    channel: channelOf(outputKind),
    provider,
    modelId,
    invoke: (_attempt, ctx) => opts.reasoner.complete(opts.request, { signal: ctx.signal }),
    ...(opts.validate !== undefined
      ? {
          validate: (response: ReasonerResponse) => {
            opts.validate?.(response, outputKind);
          },
        }
      : {}),
  });
}

/**
 * Default runtime contract check for a `ReasonerResponse`. A response of
 * the wrong kind, or one whose payload violates the declared contract, is
 * a `contractValidation` failure.
 */
export function assertReasonerResponseContract(
  response: ReasonerResponse,
  outputKind: StructuredOutputKind,
  ctx: StructuredOutputContext,
): void {
  if (response.kind !== outputKind) {
    throw contractError(
      `expected a ${outputKind} response, received ${response.kind}`,
      ctx,
      outputKind,
    );
  }
  switch (outputKind) {
    case 'action': {
      if (response.kind === 'action') validateActionContent(response.action, ctx);
      return;
    }
    case 'selfReport': {
      if (response.kind === 'selfReport') validateSelfReportContent(response.content, ctx);
      return;
    }
    case 'observerFindings': {
      if (response.kind === 'observerFindings') validateObserverFindingsContent(response.content, ctx);
      return;
    }
  }
}

/**
 * Narrow a `selfReport` response to its validated content. Throws a
 * `contractValidation` error when the response is of another kind, so a
 * caller can never silently coerce a mismatched response into a report.
 */
export function requireSelfReportContent(
  response: ReasonerResponse,
  ctx: StructuredOutputContext,
): ValidatedSelfReportContent {
  if (response.kind !== 'selfReport') {
    throw contractError(
      `expected a selfReport response, received ${response.kind}`,
      ctx,
      'selfReport',
    );
  }
  return validateSelfReportContent(response.content, ctx);
}

/**
 * Narrow an `observerFindings` response to its validated content.
 */
export function requireObserverFindingsContent(
  response: ReasonerResponse,
  ctx: StructuredOutputContext,
): ValidatedObserverFindingsContent {
  if (response.kind !== 'observerFindings') {
    throw contractError(
      `expected an observerFindings response, received ${response.kind}`,
      ctx,
      'observerFindings',
    );
  }
  return validateObserverFindingsContent(response.content, ctx);
}

/**
 * Three-way admission of a parsed action value.
 *
 * - `admitted` — structurally valid participant action; the caller still
 *   runs `enforceActionAllowlist` before it reaches the adapter.
 * - `capabilityViolation` — a recognised privileged primitive attempt.
 * - `contractInvalid` — structurally not a participant action.
 */
export type ActionAdmission =
  | { readonly status: 'admitted'; readonly action: ParticipantAction }
  | { readonly status: 'capabilityViolation'; readonly attempt: PrivilegedActionAttempt; readonly reason: string }
  | { readonly status: 'contractInvalid'; readonly reason: string };

export function admitParticipantAction(value: unknown): ActionAdmission {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { status: 'contractInvalid', reason: 'action value is not a JSON object' };
  }
  const obj = value as Record<string, unknown>;
  if (isPrivilegedActionKind(obj['kind'])) {
    const payload =
      typeof obj['payload'] === 'object' && obj['payload'] !== null && !Array.isArray(obj['payload'])
        ? (obj['payload'] as Record<string, unknown>)
        : {};
    return {
      status: 'capabilityViolation',
      attempt: { kind: obj['kind'], payload },
      reason: `privileged action attempt "${String(obj['kind'])}" is not in the human-facing set`,
    };
  }
  if (!isParticipantAction(obj)) {
    return {
      status: 'contractInvalid',
      reason: describeParticipantActionDefect(obj) ?? 'action contract violation',
    };
  }
  return { status: 'admitted', action: obj as unknown as ParticipantAction };
}

/** Re-exported so callers do not need a second import for the error union. */
export type { StructuredFailureKind, StructuredOutputErrorKind, StructuredOutputFailureDetail };
