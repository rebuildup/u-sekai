/**
 * Anthropic Messages API adapter (ADR-0005). HTTP-only via fetch.
 *
 * - Reads `ANTHROPIC_API_KEY` from process.env at construction time.
 * - Translates u-sekai's ReasonerRequest -> Anthropic Messages JSON.
 * - Parses back to a ReasonerResponse. JSON-mode (action / selfReport /
 *   observerFindings) via system prompt framing + JSON parsing of the
 *   assistant text.
 *
 * Default model: claude-3-5-sonnet-latest.
 */

import type { Reasoner, ReasonerRequest, ReasonerResponse } from '../../domain/reasoner.js';
import type { ReasonerConfig } from '../../domain/experiment.js';
import type { ParticipantAction } from '../../domain/capability.js';
import { ProviderError } from '../../domain/errors.js';

const DEFAULT_MODEL = 'claude-3-5-sonnet-latest';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ENV_KEY = 'ANTHROPIC_API_KEY';

export function anthropicReasoner(
  config: ReasonerConfig,
  _ctx: { participantLabel?: string; role: 'participant' | 'observer' | 'selfReport' },
): Reasoner {
  const apiKey = process.env[ENV_KEY];
  if (!apiKey) {
    throw new ProviderError(
      `${ENV_KEY} is not set; required when reasoner.provider === 'anthropic'.`,
      'anthropic',
    );
  }
  const modelId = config.modelId ?? DEFAULT_MODEL;
  return {
    providerId: 'anthropic',
    modelId,
    complete: async (request) => invokeAnthropic(request, modelId, apiKey, config.seed),
  };
}

async function invokeAnthropic(
  request: ReasonerRequest,
  modelId: string,
  apiKey: string,
  seed: string | undefined,
): Promise<ReasonerResponse> {
  const body = {
    model: modelId,
    max_tokens: request.maxTokens,
    system: request.systemPrompt,
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.stop !== undefined ? { stop_sequences: [...request.stop] } : {}),
    ...(seed !== undefined ? { metadata: { user_id: `usekai:${seed}` } } : {}),
  } as Record<string, unknown>;

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ProviderError(`network error: ${(err as Error).message}`, 'anthropic');
  }

  if (!response.ok) {
    const text = await response.text();
    throw new ProviderError(`anthropic http ${response.status}: ${text.slice(0, 500)}`, 'anthropic', {
      status: response.status,
    });
  }

  const json = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const text = (json.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');

  const usage = {
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
  };

  return parseAnthropicText(text, request.systemPrompt, usage);
}

function parseAnthropicText(
  text: string,
  systemPrompt: string,
  usage: { inputTokens: number; outputTokens: number },
): ReasonerResponse {
  // The system prompt tells the model whether to emit action /
  // selfReport / observerFindings. We detect which by prompt markers,
  // not by content.
  if (/Emit a JSON object matching the SelfReport shape/.test(systemPrompt)) {
    return {
      kind: 'selfReport',
      content: safeJson(text),
      usage,
    };
  }
  if (/Produce an ObserverFindings JSON object/.test(systemPrompt)) {
    return {
      kind: 'observerFindings',
      content: safeJson(text),
      usage,
    };
  }
  // Default: action.
  let action: Record<string, unknown>;
  try {
    action = safeJson(text);
  } catch (err) {
    return {
      kind: 'refusal',
      message: `unparseable assistant output: ${(err as Error).message}; raw=${text.slice(0, 200)}`,
      usage,
    };
  }
  if (!action || typeof action !== 'object' || typeof action.kind !== 'string') {
    return {
      kind: 'refusal',
      message: `assistant did not emit a recognisable action; raw=${text.slice(0, 200)}`,
      usage,
    };
  }
  const typedAction = action as unknown as ParticipantAction;
  return {
    kind: 'action',
    action: typedAction,
    rationale: text.slice(0, 200),
    usage,
  };
}

function safeJson(text: string): Record<string, unknown> {
  // Try the whole string first; fall back to the first JSON object.
  const trimmed = text.trim();
  try {
    const v = JSON.parse(trimmed);
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const v = JSON.parse(match[0]);
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        return v as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }
  throw new Error('no JSON object found in assistant output');
}

export const __testHelpers = { safeJson };
