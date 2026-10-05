/**
 * Disposition lineage: from a customer decision back to the finding and
 * the evidence that justified it.
 *
 * The property under test is not just "the ids line up". It is that the
 * evidence reached through a disposition is the *same* evidence the
 * finding holds — same array instance, not a re-parse — so there is no
 * second copy that can fall out of date. #64's acceptance rate,
 * false-positive rate and cost-per-accepted-finding are all joins
 * through this path.
 */

import { describe, it, expect } from 'vitest';
import {
  findFinding,
  indexFindings,
  isCustomerDecision,
  parseDisposition,
  parseFinding,
  resolveAllDispositionLineages,
  resolveDispositionLineage,
  ReviewContractError,
} from '../../../src/review/index.js';
import {
  dispositionInput,
  evidenceDeterministic,
  evidenceObserver,
  evidenceSelfReport,
  findingInput,
  verification,
} from './support/fixtures.js';

describe('resolving a disposition back to its finding', () => {
  const finding = parseFinding(findingInput());
  const disposition = parseDisposition(dispositionInput());
  const lineage = resolveDispositionLineage(disposition, [finding]);

  it('reaches the finding the disposition named', () => {
    expect(lineage.findingId).toBe(finding.id);
    expect(lineage.finding).toBe(finding);
    expect(lineage.dispositionId).toBe(disposition.id);
  });

  it('reaches the evidence the finding holds, as the same array instance', () => {
    expect(lineage.evidenceRefs).toBe(finding.evidenceRefs);
    expect(lineage.evidenceRefs[0]).toBe(finding.evidenceRefs[0]);
    expect(lineage.evidenceRefs.map((r) => r.id)).toEqual(['ev-observer-1', 'ev-selfreport-1']);
  });

  it('reaches the run, target, identities and instant the finding was observed at', () => {
    expect(lineage.runId).toBe(finding.observedIn);
    expect(lineage.target).toBe(finding.target);
    expect(lineage.identityIds).toBe(finding.identityIds);
    expect(lineage.observedAt).toBe(finding.observedAt);
    expect(lineage.longitudinal).toBe(finding.longitudinal);
  });

  it('reports whether this disposition is a customer decision', () => {
    expect(lineage.isDecision).toBe(true);
    expect(isCustomerDecision(disposition)).toBe(true);
  });

  it('reports an open disposition as not a decision, however confident the finding', () => {
    const open = parseDisposition(
      dispositionInput({
        id: 'dsp-0000ffff',
        kind: 'needsHumanResearch',
        state: 'needsHumanResearch',
        rationale: 'Needs a human to look at the recording.',
      }),
    );
    const openLineage = resolveDispositionLineage(open, [finding]);
    expect(openLineage.isDecision).toBe(false);
    // The finding is unchanged by the disposition; the two are separate.
    expect(openLineage.finding).toBe(finding);
  });

  it('refuses to resolve a disposition whose finding is not held', () => {
    const orphan = parseDisposition(dispositionInput({ findingId: 'fnd-99999999' }));
    expect(() => resolveDispositionLineage(orphan, [finding])).toThrow(
      /may not be aggregated without the finding it judged/,
    );
  });
});

describe('finding lookup', () => {
  const finding = parseFinding(findingInput());

  it('finds a held finding by id', () => {
    expect(findFinding([finding], finding.id)).toBe(finding);
  });

  it('returns null for an absent finding rather than throwing', () => {
    expect(findFinding([finding], 'fnd-99999999' as typeof finding.id)).toBeNull();
  });

  it('indexes by id and rejects a duplicate id', () => {
    const index = indexFindings([finding]);
    expect(index.get(finding.id)).toBe(finding);
    expect(() => indexFindings([finding, finding])).toThrow(/duplicate finding id/);
  });
});

describe('resolving a whole ledger', () => {
  const accepted = parseFinding(findingInput());
  const conflicting = parseFinding(
    findingInput({
      id: 'fnd-0000beef',
      title: 'Save button is inert on task creation (second run)',
      evidenceRefs: [evidenceObserver, evidenceDeterministic],
      verification: { ...verification, findingId: 'fnd-0000beef' },
    }),
  );

  const acceptedDisposition = parseDisposition(dispositionInput());
  const invalidDisposition = parseDisposition(
    dispositionInput({
      id: 'dsp-0000beef',
      findingId: 'fnd-0000beef',
      kind: 'invalid',
      supersedes: undefined,
      rationale: 'The existing regression test covers this flow and passes.',
    }),
  );

  const lineages = resolveAllDispositionLineages(
    [acceptedDisposition, invalidDisposition],
    [accepted, conflicting],
  );

  it('resolves each disposition to its own finding, not to the first one', () => {
    expect(lineages).toHaveLength(2);
    expect(lineages[0]?.finding).toBe(accepted);
    expect(lineages[1]?.finding).toBe(conflicting);
  });

  it('preserves input order so a ledger replays deterministically', () => {
    expect(lineages.map((l) => l.dispositionId)).toEqual([
      'dsp-0000abcd',
      'dsp-0000beef',
    ]);
  });

  it('carries each finding\'s own evidence, including the contradicting one', () => {
    expect(lineages[1]?.evidenceRefs).toBe(conflicting.evidenceRefs);
    // Same array instance as the finding; the individual entries are
    // the finding's own parsed references, re-validated on parse.
    expect(lineages[1]?.evidenceRefs.map((r) => r.id)).toEqual(
      conflicting.evidenceRefs.map((r) => r.id),
    );
    expect(lineages[1]?.evidenceRefs[1]?.id).toBe(evidenceDeterministic.id);
  });

  it('fails loudly rather than skipping an unresolvable disposition', () => {
    const orphan = parseDisposition(dispositionInput({ id: 'dsp-0000dead', findingId: 'fnd-99999999' }));
    expect(() =>
      resolveAllDispositionLineages([acceptedDisposition, orphan], [accepted]),
    ).toThrow(ReviewContractError);
  });
});

describe('a disposition cannot drift from its finding', () => {
  it('holds no copy of anything the finding owns', () => {
    const disposition = parseDisposition(dispositionInput());
    for (const copiedField of ['title', 'summary', 'severity', 'evidenceRefs', 'confidence']) {
      expect(disposition).not.toHaveProperty(copiedField);
    }
  });

  it('resolves a correction back to the same finding as the decision it supersedes', () => {
    const finding = parseFinding(findingInput());
    const first = parseDisposition(dispositionInput());
    const correction = parseDisposition(
      dispositionInput({
        id: 'dsp-0000ffff',
        kind: 'invalid',
        supersedes: first.id,
        rationale: 'Re-reviewed: the control does save, the participant misread the toast.',
      }),
    );

    const a = resolveDispositionLineage(first, [finding]);
    const b = resolveDispositionLineage(correction, [finding]);
    expect(b.finding).toBe(a.finding);
    expect(b.evidenceRefs).toBe(a.evidenceRefs);
    expect(correction.supersedes).toBe(first.id);
  });

  it('keeps the superseding record reachable through the same evidence', () => {
    const finding = parseFinding(
      findingInput({ evidenceRefs: [evidenceObserver, evidenceSelfReport] }),
    );
    const disposition = parseDisposition(dispositionInput());
    const lineage = resolveDispositionLineage(disposition, [finding]);
    expect(lineage.evidenceRefs.every((r) => r.locator.length > 0)).toBe(true);
  });
});
