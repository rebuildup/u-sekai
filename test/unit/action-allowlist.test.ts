import { describe, it, expect } from 'vitest';
import { enforceActionAllowlist, listHumanFacingPrimitiveKinds } from '../../src/capability/action-allowlist.js';
import type { CapabilityProfile } from '../../src/domain/capability.js';

const profile: CapabilityProfile = {
  observation: 'visual',
  action: 'visualOnly',
  memory: { kind: 'fullHistory' },
};

describe('action-allowlist', () => {
  it('lists exactly the human-facing primitives', () => {
    const kinds = listHumanFacingPrimitiveKinds();
    expect(new Set(kinds)).toEqual(new Set(['clickByCoords', 'tapByCoords', 'typeText', 'scroll', 'wait', 'finish']));
  });

  it('accepts a clickByCoords action under visualOnly', () => {
    expect(() => enforceActionAllowlist({ kind: 'clickByCoords', x: 1, y: 1 }, profile)).not.toThrow();
  });

  it('rejects an unknown action kind regardless of profile', () => {
    expect(() =>
      enforceActionAllowlist(
        // Cast to bypass the union type; the allowlist still rejects it.
        { kind: 'exploit', payload: {} } as unknown as Parameters<typeof enforceActionAllowlist>[0],
        profile,
      ),
    ).toThrow();
  });
});
