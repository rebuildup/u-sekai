import { describe, expect, it } from 'vitest';
import { renderReport } from '../../../examples/continuous-product-evaluation/run-acceptance.js';

describe('acceptance example report (browser-profile routing)', () => {
  it('does not label an unmet stage as successful', () => {
    const output = renderReport({
      stages: [{ stage: 'identity retained', observed: 'no retained state' }],
      findings: [],
      unmetExpectations: ['identity retained'],
    });
    expect(output).toContain('[FAIL]   identity retained');
    expect(output).not.toContain('[ok]   identity retained');
    expect(output).toContain('Unmet expectations (1)');
  });

  it('keeps successful and failed stages distinguishable', () => {
    const output = renderReport({
      stages: [
        { stage: 'browser ran', observed: 'one run' },
        { stage: 'identity retained', observed: 'no retained state' },
      ],
      findings: [],
      unmetExpectations: ['identity retained'],
    });
    expect(output).toContain('[ok]   browser ran');
    expect(output).toContain('[FAIL]   identity retained');
    expect(output).toContain('Simulated, not human');
  });
});
