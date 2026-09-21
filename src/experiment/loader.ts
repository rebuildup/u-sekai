/**
 * Load and validate an ExperimentDefinition from a JSON / YAML file.
 *
 * 0.1.0 supports JSON only (the YAML reader would add a runtime dep we
 * don't need yet). Comments / richer formats are deferred.
 */

import { promises as fs } from 'node:fs';
import type { ExperimentDefinition } from '../domain/experiment.js';
import { ExperimentConfigError } from '../domain/errors.js';

export async function loadExperiment(path: string): Promise<ExperimentDefinition> {
  const raw = await fs.readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ExperimentConfigError(`invalid JSON in ${path}: ${(err as Error).message}`, { path });
  }
  return validateExperimentDefinition(parsed);
}

export function validateExperimentDefinition(input: unknown): ExperimentDefinition {
  if (!isObject(input)) throw new ExperimentConfigError('experiment must be an object');
  for (const field of ['id', 'environment', 'userStory', 'participants', 'budget', 'observer', 'outDir', 'seed']) {
    if (!(field in input)) {
      throw new ExperimentConfigError(`missing required field: ${field}`);
    }
  }
  const def = input as unknown as ExperimentDefinition;
  if (!Array.isArray(def.participants) || def.participants.length === 0) {
    throw new ExperimentConfigError('participants must be a non-empty array');
  }
  for (const p of def.participants) {
    if (!isObject(p) || typeof p.id !== 'string' || typeof p.personaPrompt !== 'string') {
      throw new ExperimentConfigError('each participant needs id and personaPrompt');
    }
    if (!isObject(p.capability)) {
      throw new ExperimentConfigError(`participant ${p.id}: capability missing`);
    }
    if (!isObject(p.reasoner)) {
      throw new ExperimentConfigError(`participant ${p.id}: reasoner missing`);
    }
  }
  return def;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
