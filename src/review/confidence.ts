/**
 * Confidence — how much the *producer* believes its own claim
 * (issue #61).
 *
 * ## Confidence is not disposition
 *
 * These are two different questions asked by two different parties
 * about two different things:
 *
 * | | Confidence | Disposition |
 * | --- | --- | --- |
 * | who answers | the producer / model / check | the customer or a human reviewer |
 * | about | the quality of the observation | whether the observation is a real product problem |
 * | lives on | `Finding.confidence` | `Disposition` (see `disposition.ts`) |
 *
 * `docs/product/kpis.md` counts false-positive rate from *dispositions*
 * and never from confidence, because a confident wrong finding is
 * exactly the case a self-assessment would hide. The separation is
 * structural in both directions: `parseFinding` rejects a
 * `disposition` key, `parseDisposition` rejects a `confidence` key, and
 * neither type has a field for the other's question.
 *
 * ## Provenance is required, calibration is a claim
 *
 * `level` alone is unusable: "high confidence" from a single model
 * self-report and "high confidence" from an independently reproduced
 * observation are different facts, so `basis` and `provenance` are
 * required alongside it.
 *
 * `calibration.calibrated` is the one place this layer makes a claim
 * about how well its confidence tracks reality, and it cannot be made
 * without naming the yardstick. That is the non-reality boundary from
 * ADR-0011 applied to a field rather than to a document: u-sekai may
 * earn a calibration claim with evidence, but it cannot assert one
 * because the cohort was large.
 */

import { EVIDENCE_CHANNELS } from './evidence.js';
import type { EvidenceChannel } from './evidence.js';
import { ReviewContractError } from './errors.js';
import {
  rejectUnknownKeys,
  requireIsoInstant,
  requireNonEmptyString,
  requireOneOf,
  requireRecord,
} from './validation.js';

export const CONFIDENCE_LEVELS = ['veryLow', 'low', 'medium', 'high'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/** Why the producer believes its own level. Ordered weak → strong. */
export const CONFIDENCE_BASES = [
  'modelJudgement',
  'heuristic',
  'singleObservation',
  'multiChannelAgreement',
  'reproduced',
] as const;
export type ConfidenceBasis = (typeof CONFIDENCE_BASES)[number];

/** Which kind of thing produced the judgement. */
export const CONFIDENCE_SOURCES = ['model', 'deterministic', 'human'] as const;
export type ConfidenceSource = (typeof CONFIDENCE_SOURCES)[number];

/**
 * An explicit claim that this layer's confidence numbers have been
 * checked against an outside yardstick.
 *
 * `calibrated: false` is a valid and common value. What is not valid is
 * `calibrated: true` with nothing to point at.
 */
export interface CalibrationClaim {
  readonly calibrated: boolean;
  /**
   * What the confidence numbers were compared against, e.g.
   * `human-usability-study`, `support-incident-correlation`,
   * `deterministic-regression-suite`. Required when `calibrated` is
   * true.
   */
  readonly yardstick?: string;
  /** Observations the comparison was made over. Required when calibrated. */
  readonly sampleSize?: number;
}

/** Where a confidence judgement came from. Never a secret. */
export interface ConfidenceProvenance {
  readonly channel: EvidenceChannel;
  /** ISO instant the judgement was recorded, not when it was true. */
  readonly recordedAt: string;
  readonly provider?: string;
  readonly modelId?: string;
}

export interface Confidence {
  readonly level: ConfidenceLevel;
  readonly basis: ConfidenceBasis;
  readonly source: ConfidenceSource;
  readonly provenance: ConfidenceProvenance;
  readonly rationale?: string;
  readonly calibration: CalibrationClaim;
}

const CONFIDENCE_FIELDS = ['level', 'basis', 'source', 'provenance', 'rationale', 'calibration'] as const;
const PROVENANCE_FIELDS = ['channel', 'recordedAt', 'provider', 'modelId'] as const;
const CALIBRATION_FIELDS = ['calibrated', 'yardstick', 'sampleSize'] as const;

export const MAX_CONFIDENCE_RATIONALE_LENGTH = 1000;
export const MAX_YARDSTICK_LENGTH = 200;
export const MAX_PROVIDER_LENGTH = 100;
export const MAX_MODEL_ID_LENGTH = 100;

export function parseConfidence(input: unknown, field = 'confidence'): Confidence {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, CONFIDENCE_FIELDS, field);

  const source = requireOneOf(raw['source'], CONFIDENCE_SOURCES, `${field}.source`);
  const rationale =
    raw['rationale'] === undefined
      ? undefined
      : requireNonEmptyString(raw['rationale'], `${field}.rationale`, MAX_CONFIDENCE_RATIONALE_LENGTH);

  const result: { -readonly [K in keyof Confidence]: Confidence[K] } = {
    level: requireOneOf(raw['level'], CONFIDENCE_LEVELS, `${field}.level`),
    basis: requireOneOf(raw['basis'], CONFIDENCE_BASES, `${field}.basis`),
    source,
    provenance: parseConfidenceProvenance(raw['provenance'], `${field}.provenance`),
    calibration: parseCalibrationClaim(raw['calibration'], `${field}.calibration`, source),
  };
  if (rationale !== undefined) {
    result.rationale = rationale;
  }
  return Object.freeze(result);
}

export function parseConfidenceProvenance(
  input: unknown,
  field = 'provenance',
): ConfidenceProvenance {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, PROVENANCE_FIELDS, field);
  const result: { -readonly [K in keyof ConfidenceProvenance]: ConfidenceProvenance[K] } = {
    channel: requireOneOf(raw['channel'], EVIDENCE_CHANNELS, `${field}.channel`),
    recordedAt: requireIsoInstant(raw['recordedAt'], `${field}.recordedAt`),
  };
  if (raw['provider'] !== undefined) {
    result.provider = requireNonEmptyString(
      raw['provider'],
      `${field}.provider`,
      MAX_PROVIDER_LENGTH,
    );
  }
  if (raw['modelId'] !== undefined) {
    result.modelId = requireNonEmptyString(raw['modelId'], `${field}.modelId`, MAX_MODEL_ID_LENGTH);
  }
  return Object.freeze(result);
}

export function parseCalibrationClaim(
  input: unknown,
  field = 'calibration',
  source?: ConfidenceSource,
): CalibrationClaim {
  const raw = requireRecord(input, field);
  rejectUnknownKeys(raw, CALIBRATION_FIELDS, field);
  if (typeof raw['calibrated'] !== 'boolean') {
    throw new ReviewContractError(`${field}.calibrated must be a boolean`, `${field}.calibrated`, {
      received: raw['calibrated'] === null ? 'null' : typeof raw['calibrated'],
    });
  }
  const calibrated = raw['calibrated'];
  const yardstick =
    raw['yardstick'] === undefined
      ? undefined
      : requireNonEmptyString(raw['yardstick'], `${field}.yardstick`, MAX_YARDSTICK_LENGTH);
  const sampleSize = raw['sampleSize'];

  if (sampleSize !== undefined) {
    if (typeof sampleSize !== 'number' || !Number.isInteger(sampleSize) || sampleSize < 1) {
      throw new ReviewContractError(
        `${field}.sampleSize must be an integer >= 1`,
        `${field}.sampleSize`,
        { received: sampleSize },
      );
    }
  }

  if (calibrated) {
    if (yardstick === undefined) {
      throw new ReviewContractError(
        `${field}.yardstick is required when calibrated is true: a calibration claim must name ` +
          `what the confidence was compared against, because a large Synthetic Cohort is not ` +
          `evidence of human representativeness (ADR-0011 non-reality boundary)`,
        `${field}.yardstick`,
      );
    }
    if (sampleSize === undefined) {
      throw new ReviewContractError(
        `${field}.sampleSize is required when calibrated is true`,
        `${field}.sampleSize`,
      );
    }
    if (source === 'model') {
      throw new ReviewContractError(
        `${field}: a model may report a correlation result but may not certify its own ` +
          `confidence as calibrated; record the human or deterministic comparison instead`,
        field,
        { source },
      );
    }
  }

  const result: { -readonly [K in keyof CalibrationClaim]: CalibrationClaim[K] } = { calibrated };
  if (yardstick !== undefined) result.yardstick = yardstick;
  if (sampleSize !== undefined) result.sampleSize = sampleSize;
  return Object.freeze(result);
}

/**
 * Rank a basis for ordering/comparison without collapsing it into a
 * number on the finding itself.
 *
 * `docs/product/kpis.md` wants a *verification survival rate*, not a
 * confidence score. This index exists so a caller can sort or filter
 * by basis explicitly, and the `RankedConfidence` wrapper keeps the
 * derived number from being mistaken for a stored field.
 */
export function rankBasis(basis: ConfidenceBasis): number {
  return CONFIDENCE_BASES.indexOf(basis);
}

export interface RankedConfidence {
  readonly confidence: Confidence;
  readonly basisRank: number;
}

export function rankConfidence(confidence: Confidence): RankedConfidence {
  return Object.freeze({ confidence, basisRank: rankBasis(confidence.basis) });
}
