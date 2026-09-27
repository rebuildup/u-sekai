/**
 * Type declarations for the pure release-publication rules in
 * `scripts/release-rules.mjs`.
 *
 * `scripts/` is plain Node ESM JavaScript (no build step, no dependencies), so
 * this hand-written declaration file is what lets the TypeScript unit tests
 * import the rules with full type checking.
 */

export interface CheckRun {
  /** Check-run name as reported by the GitHub Checks API. */
  name: string;
  /** e.g. `completed`, `in_progress`, `queued`, `pending`. */
  status: string;
  /** e.g. `success`, `failure`, `neutral`, or `null` while running. */
  conclusion: string | null;
  /** Head branch of the owning check suite; `null` when unknown. */
  headBranch?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  id?: string | number | null;
  url?: string | null;
}

export interface ExpectedReleaseSha {
  sha: string | null;
  subject?: string;
  candidates?: number;
}

export interface ExistingTag {
  sha: string;
}

export interface ExistingRelease {
  /** Commit the release ships, resolved from the tag it references. */
  sha: string;
  /**
   * Raw `target_commitish` recorded by GitHub, kept only for the printed note
   * that explains why it can differ from `sha`.
   */
  targetCommitish?: string | null;
  draft: boolean;
  prerelease: boolean;
}

export interface ReleaseEvaluationInput {
  /** `owner/name` of the GitHub repository. */
  repo: string;
  /** Ref the version source of truth was read from. */
  sourceRef: string;
  /** Ref that holds the released source state. */
  mainRef: string;
  /** Value read from `package.json#version`. */
  packageVersion: string;
  /** Tag to publish. */
  tagName: string;
  /** Intended release branch. */
  releaseBranch: string;
  /** Resolved target commit. */
  targetSha: string;
  /** Release commit resolved from `main` history for this version. */
  expectedReleaseSha: ExpectedReleaseSha;
  remoteHasTargetSha: boolean;
  /** Remote-tracking refs that contain the target commit. */
  remoteContainingRefs?: readonly string[];
  targetOnMain: boolean;
  releaseBranchExists: boolean;
  releaseBranchTip: string | null;
  releaseBranchTipIsAncestor: boolean | null;
  /** Check names that must be `completed` / `success` on the target commit. */
  requiredChecks: readonly string[];
  /** Where `requiredChecks` came from, for the printed verdict. */
  gateSource?: string;
  /** Status check contexts registered on `main`; `null` when unreadable. */
  protectionContexts?: readonly string[] | null;
  /** Refuse to publish when branch protection registers no required check. */
  requireProtectionConfigured?: boolean;
  /** False when the check runs could not be read at all. */
  checkRunsReadable: boolean;
  checkRuns?: readonly CheckRun[];
  /** Branches whose check runs form the release state. */
  applicableBranches: readonly string[];
  existingTag: ExistingTag | null;
  existingRelease: ExistingRelease | null;
  conflictingReleaseTags?: readonly string[];
}

export interface ReleaseCheck {
  rule: string;
  ok: boolean;
  message: string;
}

export interface ReleaseViolation {
  rule: string;
  message: string;
}

export interface ReleaseNote {
  rule: string;
  message: string;
}

export interface ReleaseEvaluation {
  ok: boolean;
  verdict: 'publish' | 'already-published' | 'refused';
  checks: readonly ReleaseCheck[];
  violations: readonly ReleaseViolation[];
  notes: readonly ReleaseNote[];
  plan: readonly string[];
}

export declare const STABLE_VERSION_PATTERN: RegExp;
export declare const RELEASE_TAG_PATTERN: RegExp;
export declare const DEFAULT_REQUIRED_RELEASE_CHECKS: readonly string[];
export declare const PR_TIME_CHECK_CONTEXTS: readonly string[];

export declare function deriveReleaseBranchName(version: string): string;
export declare function parseReleaseTag(tagName: string): { version: string } | null;
export declare function resolveExpectedReleaseSha(input: {
  merges: ReadonlyArray<{ sha: string; parents: readonly string[]; subject: string }>;
  releaseBranch: string;
}): ExpectedReleaseSha;
export declare function selectLatestCheckRun(
  runs: readonly CheckRun[],
  name: string,
): CheckRun | null;
export declare function evaluateReleasePublication(
  input: ReleaseEvaluationInput,
): ReleaseEvaluation;
