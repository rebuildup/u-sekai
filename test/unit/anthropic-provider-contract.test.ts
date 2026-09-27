/**
 * Anthropic provider contract tests (ADR-0005, ADR-0008).
 *
 * The transport is injected, so these are hermetic: no network, and no
 * real credential anywhere in source.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  anthropicReasoner,
  createAnthropicReasoner,
  type AnthropicFetch,
} from '../../src/reasoner/providers/anthropic.js';
import { CapabilityViolation, ProviderError, StructuredOutputError } from '../../src/domain/errors.js';
import { participantActionSystemPrompt } from '../../src/participant/system-prompt.js';
import type { Reasoner } from '../../src/domain/reasoner.js';

const TEST_KEY = 'test-key-not-a-credential';
const TEST_ENDPOINT = 'https://provider.invalid/v1/messages';

const originalKey = process.env['ANTHROPIC_API_KEY'];
afterEach(() => {
  if (originalKey === undefined) {
    delete process.env['ANTHROPIC_API_KEY'];
  } else {
    process.env['ANTHROPIC_API_KEY'] = originalKey;
  }
});

function makeReasoner(transport: AnthropicFetch): Reasoner {
  return createAnthropicReasoner({
    apiKey: TEST_KEY,
    endpoint: TEST_ENDPOINT,
    modelId: 'test-model',
    fetchImpl: transport,
  });
}

const request = {
  systemPrompt: participantActionSystemPrompt({ memoryDescription: 'recent 3 steps' }),
  messages: [{ role: 'user' as const, content: 'pick an action' }],
  maxTokens: 64,
};

function textTransport(text: string, status = 200): AnthropicFetch {
  return async () =>
    new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

async function expectStructured(
  reasoner: Reasoner,
  failureKind: 'providerTransport' | 'providerParse' | 'contractValidation',
): Promise<StructuredOutputError> {
  try {
    await reasoner.complete(request);
  } catch (err) {
    expect(err).toBeInstanceOf(StructuredOutputError);
    const structured = err as StructuredOutputError;
    expect(structured.failureKind).toBe(failureKind);
    expect(structured).not.toBeInstanceOf(CapabilityViolation);
    return structured;
  }
  throw new Error('expected the provider call to throw');
}

describe('anthropic provider: construction', () => {
  it('still requires a credential when neither deps nor env provide one', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    expect(() => anthropicReasoner({ provider: 'anthropic' }, { role: 'participant' })).toThrow(ProviderError);
  });

  it('accepts an injected credential without consulting the environment', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const reasoner = anthropicReasoner(
      { provider: 'anthropic' },
      { role: 'participant' },
      { apiKey: TEST_KEY, baseUrl: 'https://provider.invalid', fetch: textTransport('{}') },
    );
    expect(reasoner.providerId).toBe('anthropic');
  });
});

describe('anthropic provider: structured output taxonomy', () => {
  it('classifies prose without a JSON object as providerParse', async () => {
    const err = await expectStructured(
      makeReasoner(textTransport('I think you should click the blue link.')),
      'providerParse',
    );
    expect(err.detail.outputKind).toBe('action');
    expect(err.detail.provider).toBe('anthropic');
    expect(err.detail.excerpt).toContain('blue link');
  });

  it.each([
    ['an unknown kind', '{"kind":"teleport"}'],
    ['a missing kind', '{}'],
    ['a stringly-typed coordinate', '{"kind":"clickByCoords","x":"left","y":2}'],
  ])('classifies %s as contractValidation', async (_label, payload) => {
    await expectStructured(makeReasoner(textTransport(payload)), 'contractValidation');
  });

  it('raises a genuine capability violation for a privileged action attempt', async () => {
    let caught: unknown;
    try {
      await makeReasoner(
        textTransport('{"kind":"evaluateJs","payload":{"code":"document.cookie"}}'),
      ).complete(request);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CapabilityViolation);
    expect((caught as CapabilityViolation).axis).toBe('action');
  });

  it('returns a typed action for a valid payload', async () => {
    const res = await makeReasoner(textTransport('{"kind":"finish","reason":"done"}')).complete(request);
    expect(res.kind).toBe('action');
    if (res.kind === 'action') {
      expect(res.action).toEqual({ kind: 'finish', reason: 'done' });
    }
  });

  it('validates the self-report contract on the self-report channel', async () => {
    const reasoner = makeReasoner(textTransport('{"goal":"g"}'));
    const selfReportRequest = {
      systemPrompt: 'You just finished.\nEmit a JSON object matching the SelfReport shape:\n{}',
      messages: [{ role: 'user' as const, content: 'history' }],
      maxTokens: 128,
    };
    try {
      await reasoner.complete(selfReportRequest);
      throw new Error('expected the provider call to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(StructuredOutputError);
      expect((err as StructuredOutputError).failureKind).toBe('contractValidation');
      expect((err as StructuredOutputError).detail.outputKind).toBe('selfReport');
    }
  });
});

describe('anthropic provider: transport failures', () => {
  it('classifies a network error as providerTransport with no status', async () => {
    const reasoner = makeReasoner(async () => {
      throw new Error('ECONNREFUSED 10.0.0.1:443');
    });
    const err = await expectStructured(reasoner, 'providerTransport');
    expect(err.detail.status).toBeUndefined();
  });

  it.each([400, 401, 403, 404])('classifies HTTP %i as providerTransport', async (status) => {
    const reasoner = makeReasoner(
      async () => new Response('{"error":"nope"}', { status, headers: { 'content-type': 'application/json' } }),
    );
    const err = await expectStructured(reasoner, 'providerTransport');
    expect(err.detail.status).toBe(status);
  });

  it('classifies a non-JSON success body as providerParse', async () => {
    const reasoner = makeReasoner(async () => new Response('not json at all', { status: 200 }));
    await expectStructured(reasoner, 'providerParse');
  });

  it('classifies an aborted request as a retryable transport timeout', async () => {
    const reasoner = makeReasoner(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const err = await expectStructured(reasoner, 'providerTransport');
    expect(err.detail.timeout).toBe(true);
  });

  it('keeps the credential and HTTP headers out of the recorded diagnostics', async () => {
    const reasoner = makeReasoner(async () => {
      const body = JSON.stringify({ error: { message: `bad key ${TEST_KEY} for x-api-key: ${TEST_KEY}` } });
      return new Response(body, { status: 401, headers: { 'content-type': 'application/json' } });
    });
    const err = await expectStructured(reasoner, 'providerTransport');
    const persisted = `${err.message} ${err.detail.excerpt ?? ''}`;
    expect(persisted).not.toContain(TEST_KEY);
    expect(persisted).not.toContain('x-api-key: sk');
    expect(persisted).toContain('[redacted]');
  });

  it('caps an over-long error body instead of persisting it verbatim', async () => {
    const body = 'upstream service unavailable while handling the request '.repeat(100);
    const reasoner = makeReasoner(
      async () => new Response(body, { status: 500, headers: { 'content-type': 'text/plain' } }),
    );
    const err = await expectStructured(reasoner, 'providerTransport');
    expect(err.detail.excerpt?.length ?? 0).toBeLessThan(320);
    expect(err.detail.excerpt).toContain('truncated');
  });

  it('forwards the completion signal to the transport', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | null = null;
    const reasoner = makeReasoner(async (_url, init) => {
      seen = init.signal ?? null;
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"kind":"finish","reason":"d"}' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await reasoner.complete(request, { signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });
});
