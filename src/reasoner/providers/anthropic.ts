/**
 * Anthropic Messages API adapter (ADR-0005). HTTP-only via fetch.
 *
 * - Reads `ANTHROPIC_API_KEY` from process.env at construction time.
 * - Translates u-sekai's ReasonerRequest -> Anthropic Messages JSON.
 * - Converts the assistant text into a typed `ReasonerResponse` through
 *   the structured-output boundary (`src/reasoner/structured.ts`), which
 *   owns the failure taxonomy and contract validation (ADR-0008).
 *
 * This adapter never interprets a malformed payload as a capability
 * problem, never persists HTTP headers, and never returns unbounded model
 * text: diagnostics are redacted and hard-capped.
 *
 * Default model: claude-3-5-sonnet-latest.
 */

import type {
  Reasoner,
  ReasonerCompletionOptions,
  ReasonerRequest,
  ReasonerResponse,
} from '../../domain/reasoner.js';
import type { ReasonerConfig } from '../../domain/experiment.js';
import { ProviderError, StructuredOutputError } from '../../domain/errors.js';
import {
  detectStructuredOutputKind,
  excerptForDiagnostics,
  parseStructuredOutput,
  type StructuredOutputKind,
} from '../structured.js';

const DEFAULT_MODEL = 'claude-3-5-sonnet-latest';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const ENV_KEY = 'ANTHROPIC_API_KEY';
const ENV_BASE_URL = 'ANTHROPIC_BASE_URL';

/** A fetch-compatible transport. Injectable so tests never touch the network. */
export type AnthropicFetch = (input: string, init: RequestInit) => Promise<Response>;

const defaultTransport: AnthropicFetch = (input, init) => fetch(input, init);

interface AnthropicMessagesBody {
  readonly content?: Array<{ type: string; text?: string }>;
  readonly usage?: { input_tokens?: number; output_tokens?: number };
}

export interface AnthropicReasonerDeps {
  /**
   * Explicit credential. Intended for tests and for embedding hosts that
   * already hold the key; never write the value into an artifact.
   */
  readonly apiKey?: string;
  /** API base URL; the adapter appends `/v1/messages`. */
  readonly baseUrl?: string;
  /** Transport seam. Defaults to the global `fetch`. */
  readonly fetch?: AnthropicFetch;
}

export function anthropicReasoner(
  config: ReasonerConfig,
  _ctx: { participantLabel?: string; role: 'participant' | 'observer' | 'selfReport' },
  deps: AnthropicReasonerDeps = {},
): Reasoner {
  const apiKey = deps.apiKey ?? process.env[ENV_KEY];
  if (!apiKey) {
    throw new ProviderError(
      `${ENV_KEY} is not set; required when reasoner.provider === 'anthropic'.`,
      'anthropic',
    );
  }
  const baseUrl = deps.baseUrl ?? process.env[ENV_BASE_URL] ?? DEFAULT_BASE_URL;
  const endpoint = baseUrl.replace(/\/+$/, '') + '/v1/messages';
  return createAnthropicReasoner({
    apiKey,
    endpoint,
    modelId: config.modelId ?? DEFAULT_MODEL,
    ...(config.seed !== undefined ? { seed: config.seed } : {}),
    ...(deps.fetch !== undefined ? { fetchImpl: deps.fetch } : {}),
  });
}

export interface AnthropicReasonerOptions {
  readonly apiKey: string;
  readonly endpoint: string;
  readonly modelId: string;
  readonly seed?: string;
  readonly fetchImpl?: AnthropicFetch;
}

/**
 * Build a Reasoner from explicit options. `createAnthropicReasoner` is the
 * hermetic seam: a test can construct a fully deterministic Reasoner with a
 * stub transport and no real credential in source.
 */
export function createAnthropicReasoner(opts: AnthropicReasonerOptions): Reasoner {
  const { apiKey, endpoint, modelId } = opts;
  return {
    providerId: 'anthropic',
    modelId,
    complete: async (request, completion) =>
      invokeAnthropic(request, modelId, apiKey, endpoint, opts.seed, completion, opts),
  };
}

async function invokeAnthropic(
  request: ReasonerRequest,
  modelId: string,
  apiKey: string,
  endpoint: string,
  seed: string | undefined,
  completion: ReasonerCompletionOptions | undefined,
  options: AnthropicReasonerOptions,
): Promise<ReasonerResponse> {
  const outputKind = detectStructuredOutputKind(request.systemPrompt);
  const base = { provider: 'anthropic', modelId, outputKind } as const;

  const body = {
    model: modelId,
    max_tokens: request.maxTokens,
    system: request.systemPrompt,
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.stop !== undefined ? { stop_sequences: [...request.stop] } : {}),
    ...(seed !== undefined ? { metadata: { user_id: `usekai:${seed}` } } : {}),
  } as Record<string, unknown>;

  const transport = opts_fetch(options);
  let response: Response;
  try {
    response = await transport(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      ...(completion?.signal !== undefined ? { signal: completion.signal } : {}),
    });
  } catch (err) {
    if (isAbort(err)) {
      throw new StructuredOutputError(
        'anthropic request exceeded the per-attempt deadline',
        'providerTransport',
        { ...base, timeout: true },
      );
    }
    throw new StructuredOutputError(
      `anthropic network error: ${excerptForDiagnostics((err as Error).message)}`,
      'providerTransport',
      { ...base },
    );
  }

  if (!response.ok) {
    // The response body is kept only as a short redacted excerpt: a
    // provider error body can echo request content, and the boundary must
    // never persist unbounded text.
    const text = await response.text().catch(() => '');
    throw new StructuredOutputError(
      `anthropic http ${response.status}`,
      'providerTransport',
      {
        ...base,
        status: response.status,
        ...(text ? { excerpt: excerptForDiagnostics(text) } : {}),
      },
    );
  }

  let json: AnthropicMessagesBody;
  try {
    json = (await response.json()) as AnthropicMessagesBody;
  } catch (err) {
    throw new StructuredOutputError(
      `anthropic response body was not JSON: ${excerptForDiagnostics((err as Error).message)}`,
      'providerParse',
      { ...base },
    );
  }

  const text = (json.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');

  const usage = {
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
  };

  return parseStructuredOutput(outputKind, text, {
    ...base,
    usage,
    rationale: excerptForDiagnostics(text),
  });
}

function opts_fetch(options: AnthropicReasonerOptions): AnthropicFetch {
  return options.fetchImpl ?? defaultTransport;
}

function isAbort(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    ((err as { name?: unknown }).name === 'AbortError' ||
      (err as { name?: unknown }).name === 'TimeoutError')
  );
}

/** Explicitly re-exported so the boundary contract stays discoverable. */
export type { StructuredOutputKind };

export const __testHelpers = { ANTHROPIC_VERSION, DEFAULT_BASE_URL };
