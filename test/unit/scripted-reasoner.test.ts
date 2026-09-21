import { describe, it, expect } from 'vitest';
import { scriptedReasoner } from '../../src/reasoner/providers/scripted.js';
import type { ReasonerRequest } from '../../src/domain/reasoner.js';

describe('scripted reasoner', () => {
  it('returns a scripted action sequence on the action prompt', async () => {
    const r = scriptedReasoner({ provider: 'scripted', seed: 's1' }, { role: 'participant' });
    const req: ReasonerRequest = {
      systemPrompt: 'pick exactly one primitive per call',
      messages: [{ role: 'user', content: '[Current observation] url=u1' }],
      maxTokens: 64,
    };
    const first = await r.complete(req);
    expect(first.kind).toBe('action');
    if (first.kind === 'action') {
      expect(['clickByCoords', 'tapByCoords', 'typeText', 'scroll', 'wait', 'finish']).toContain(first.action.kind);
    }
  });

  it('returns selfReport JSON when the marker is present', async () => {
    const r = scriptedReasoner({ provider: 'scripted', seed: 's2' }, { role: 'selfReport' });
    const req: ReasonerRequest = {
      systemPrompt: 'Emit a JSON object matching the SelfReport shape',
      messages: [{ role: 'user', content: 'history' }],
      maxTokens: 256,
    };
    const res = await r.complete(req);
    expect(res.kind).toBe('selfReport');
  });

  it('returns observerFindings when the observer marker is present', async () => {
    const r = scriptedReasoner({ provider: 'scripted', seed: 's3' }, { role: 'observer' });
    const req: ReasonerRequest = {
      systemPrompt: 'Produce an ObserverFindings JSON object',
      messages: [{ role: 'user', content: 'trace' }],
      maxTokens: 1024,
    };
    const res = await r.complete(req);
    expect(res.kind).toBe('observerFindings');
  });

  it('emits a finish action when the script is exhausted', async () => {
    const r = scriptedReasoner(
      { provider: 'scripted', seed: 's4', script: [{ kind: 'wait', milliseconds: 1 }] },
      { role: 'participant' },
    );
    const req: ReasonerRequest = {
      systemPrompt: 'pick exactly one primitive per call',
      messages: [{ role: 'user', content: 'one' }],
      maxTokens: 64,
    };
    await r.complete(req); // consume the single scripted step
    const second = await r.complete(req);
    expect(second.kind).toBe('action');
    if (second.kind === 'action') {
      expect(second.action.kind).toBe('finish');
    }
  });
});
