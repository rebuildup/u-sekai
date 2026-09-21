import { describe, it, expect } from 'vitest';
import { loadExperiment } from '../../src/experiment/loader.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'experiment.task-tracker.json');

describe('experiment loader', () => {
  it('parses the bundled task-tracker experiment fixture', async () => {
    const def = await loadExperiment(fixture);
    expect(def.id).toBe('demo-task-tracker');
    expect(def.participants.length).toBe(2);
    expect(def.participants[0]?.capability.memory.kind).toBe('limitedRecent');
    expect(def.participants[1]?.capability.memory.kind).toBe('fullHistory');
  });

  it('throws on missing required field', async () => {
    await expect(loadExperiment('/non/existent.json')).rejects.toThrow();
  });
});
