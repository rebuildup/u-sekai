/**
 * Persisted Synthetic Identity state (ADR-0011, issue #60).
 *
 * ## Identity state is not cohort state
 *
 * This module and `cohort.ts` share no types and no storage. An identity
 * record is keyed by the identity's own declared id; a cohort record is
 * keyed by the cohort's. Resolving a cohort reads identity *declarations*
 * to pick members and writes only the cohort record — it never reaches
 * into an identity record. That separation is the reason re-running an
 * evaluation cannot corrupt an identity, and it is asserted directly in
 * `test/unit/cohort/separation.test.ts`.
 *
 * ## What is persisted here, and what is deliberately not
 *
 * ADR-0011 states that "runtime state, credentials, evidence, mutable
 * user state, and billing records are not canonicalized into the
 * repository file", and #57 leaves `IdentityStateRef` as an opaque handle
 * whose location is #60's decision. This module takes that literally:
 *
 * - The **reference** to the state an environment holds for an identity
 *   is persisted (`retainedState.ref`).
 * - The **mutable state itself is not.** What is stored alongside it is a
 *   small, non-secret accumulation summary — enough to observe that the
 *   identity carried state across a release transition, and nothing more.
 * - **No credential is persisted at all.** `accountRef` is a
 *   *structural* whitelist, not a secret detector: it must be a
 *   namespaced handle whose first segment names a declared reference
 *   kind (`acct-`, `world-`, `fixture-`) and which has at least one
 *   further segment. See `parseAccountRef` for exactly what this does and
 *   does not guarantee — a charset rule alone would accept `hunter2`, and
 *   the module says so rather than implying otherwise.
 *
 * ## Lifecycle is enforced, not assumed
 *
 * #57's `ALLOWED_STATE_RETENTION` binds retention to lifecycle. This
 * module reuses that table through `assertRetentionAllowed` rather than
 * restating it, and adds the two state-level consequences:
 *
 * | lifecycle    | retained state            | transition window |
 * | ------------ | ------------------------- | ----------------- |
 * | `ephemeral`  | never present             | never present     |
 * | `release`    | present, then dropped when the window closes | exactly 0 or 1 |
 * | `persistent` | present and never dropped | never present     |
 *
 * A `release` identity retains state across *exactly* its window: it is
 * there for the second run of the transition — which is the observation
 * ADR-0011's release-transition mode exists to make — and gone
 * afterwards.
 */

import {
  parseEnvironmentId,
  parseEvaluationRunId,
  parseIdentityStateRef,
  parseSyntheticIdentity,
  ProductDomainError,
  type EnvironmentId,
  type EvaluationRunId,
  type IdentityStateRef,
  type SyntheticIdentity,
} from '../product/index.js';
import { projectDeclaredKeys } from './record.js';
import { CohortStateError } from './errors.js';
import {
  requireInteger,
  requireIsoInstant,
  requireNonEmptyString,
  requireRecord,
} from '../product/validation.js';

/**
 * How many environment observations an identity keeps.
 *
 * The history exists to establish transition lineage — "this identity
 * was last seen on version A of environment X" — not to be an
 * append-only audit log. Bounding it keeps a long-lived identity's record
 * a fixed size.
 */
export const MAX_ENVIRONMENT_OBSERVATIONS = 64;

/** The #57 fields, verbatim. Used to down-project a stored record. */
const IDENTITY_DECLARED_KEYS = [
  'id',
  'productId',
  'displayName',
  'lifecycle',
  'persona',
  'capability',
  'stateRef',
] as const;

const IDENTITY_STATE_FIELDS = [
  ...IDENTITY_DECLARED_KEYS,
  'accountRef',
  'retainedState',
  'observations',
  'releaseWindow',
  'retiredAt',
] as const;

const RETAINED_STATE_FIELDS = ['ref', 'interactionCount', 'firstObservedAt', 'lastObservedAt'] as const;
const OBSERVATION_FIELDS = ['environmentId', 'version', 'observedAt', 'runId'] as const;
const WINDOW_FIELDS = ['fromVersion', 'toVersion', 'openedAt', 'closedAt'] as const;

/**
 * Opaque reference to the product-side account a synthetic identity owns.
 *
 * Nominal type + a *structural* grammar, not a secret detector.
 *
 * A charset whitelist alone is not sufficient here, and this module does
 * not pretend otherwise: `hunter2` and `password123` are all lowercase
 * alphanumerics, so any charset-only rule accepts them. What actually
 * excludes a credential is that a valid account reference must be a
 * **namespaced handle whose first segment names a declared reference
 * kind** and which carries at least one further segment:
 *
 * ```text
 * acct-alice-primary   ok    kind "acct"
 * world-seed-42        ok    kind "world"
 * hunter2              no    no kind segment
 * sk-ant-api03-...     no    kind "sk" is not declared
 * dXNlcjpw...==        no    not in the permitted character set
 * ```
 *
 * ### What this does and does not guarantee
 *
 * It guarantees that a value can only be persisted here if it is
 * *deliberately shaped as a reference to a declared kind*, and that no
 * code path in this package ingests a credential in order to store it.
 * It does **not** guarantee that a credential deliberately constructed as
 * `acct-<secret>` is detected — nothing can, and a rule claiming
 * otherwise would be false. That residual case is a configuration-authoring
 * error at the declaration boundary, which is where #57's other id
 * grammars are validated too.
 */
export type AccountRef = string & { readonly __brand: 'AccountRef' };

/**
 * Reference kinds an account reference may name.
 *
 * A closed set: adding one is a deliberate schema decision, so a value
 * cannot acquire a new "kind" merely by being invented.
 */
export const ACCOUNT_REF_KINDS = ['acct', 'world', 'fixture'] as const;
export type AccountRefKind = (typeof ACCOUNT_REF_KINDS)[number];

const ACCOUNT_REF_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
export const MAX_ACCOUNT_REF_LENGTH = 64;

/**
 * A deployment version label as the environment reports it.
 *
 * Opaque on purpose: `Environment` (#57) deliberately carries no
 * Git-shaped field, so a version is whatever the deployable calls itself.
 */
export type VersionLabel = string & { readonly __brand: 'VersionLabel' };

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+~-]*$/;
export const MAX_VERSION_LENGTH = 64;

/** Where an identity was last observed, and which run observed it. */
export interface EnvironmentObservation {
  readonly environmentId: EnvironmentId;
  readonly version: VersionLabel;
  readonly observedAt: string;
  /**
   * The run that produced this observation.
   *
   * A **reference only** — it is never part of a persistence key. Runs
   * are observations of the durable model, not the durable model itself
   * (ADR-0011), and keying state by run id would restart every identity
   * on the next execution.
   */
  readonly runId: EvaluationRunId;
}

/**
 * A release-scoped identity's single transition window.
 *
 * `toVersion` and `closedAt` are absent exactly while the window is open.
 */
export interface ReleaseWindow {
  readonly fromVersion: VersionLabel;
  readonly toVersion?: VersionLabel;
  readonly openedAt: string;
  readonly closedAt?: string;
}

export function isOpenWindow(window: ReleaseWindow): boolean {
  return window.toVersion === undefined || window.closedAt === undefined;
}

/**
 * Bounded, non-secret summary of the state an environment holds for this
 * identity. The state itself lives in the environment; only the handle
 * and the summary are durable.
 */
export interface RetainedIdentityState {
  readonly ref: IdentityStateRef;
  readonly interactionCount: number;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
}

export interface IdentityState {
  /** The #57 declaration, validated by #57's own parser. */
  readonly identity: SyntheticIdentity;
  readonly accountRef?: AccountRef;
  readonly retainedState?: RetainedIdentityState;
  readonly observations: ReadonlyArray<EnvironmentObservation>;
  readonly releaseWindow?: ReleaseWindow;
  /** Set when the identity has been withdrawn from future evaluations. */
  readonly retiredAt?: string;
}

/* -------------------------------------------------------------------------- */
/* Scalars                                                                     */
/* -------------------------------------------------------------------------- */

export function parseAccountRef(value: unknown, field = 'identity.accountRef'): AccountRef {
  const raw = requireNonEmptyString(value, field, MAX_ACCOUNT_REF_LENGTH);
  if (!ACCOUNT_REF_PATTERN.test(raw)) {
    throw new ProductDomainError(
      `${field} must be a lowercase hyphen-separated handle of at least two segments (e.g. "acct-alice-primary")`,
      field,
      { received: raw },
    );
  }
  const kind = raw.slice(0, raw.indexOf('-'));
  if (!(ACCOUNT_REF_KINDS as readonly string[]).includes(kind)) {
    throw new ProductDomainError(
      `${field} must begin with a declared reference kind (${ACCOUNT_REF_KINDS.join(', ')}); "${kind}" is not one, and a credential, token or secret is not a valid account reference`,
      field,
      { received: raw, kind, allowed: [...ACCOUNT_REF_KINDS] },
    );
  }
  return raw as AccountRef;
}

export function parseVersionLabel(value: unknown, field = 'observation.version'): VersionLabel {
  const raw = requireNonEmptyString(value, field, MAX_VERSION_LENGTH);
  if (!VERSION_PATTERN.test(raw)) {
    throw new ProductDomainError(
      `${field} must be an opaque version label such as "2026.10.1" or "v1.2.3"`,
      field,
      { received: raw },
    );
  }
  return raw as VersionLabel;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Parse a stored identity record.
 *
 * Unmodelled keys are dropped by `projectDeclaredKeys` before anything
 * else runs, which is what lets a record written by a later release load
 * here. The #57 sub-object is then handed to **#57's own** parser, so
 * every invariant #57 declares — lifecycle/retention agreement,
 * `stateRef` presence — is enforced without being restated.
 */
export function parseIdentityState(input: unknown, field = 'identityState'): IdentityState {
  const raw = requireRecord(input, field);
  const projected = projectDeclaredKeys(raw, IDENTITY_STATE_FIELDS);

  const identity = parseSyntheticIdentity(
    projectDeclaredKeys(raw, IDENTITY_DECLARED_KEYS),
    `${field}.identity`,
  );

  const accountRef =
    projected['accountRef'] === undefined
      ? undefined
      : parseAccountRef(projected['accountRef'], `${field}.accountRef`);

  const retainedState =
    projected['retainedState'] === undefined
      ? undefined
      : parseRetainedState(projected['retainedState'], `${field}.retainedState`);

  const observations =
    projected['observations'] === undefined
      ? Object.freeze([])
      : parseObservations(projected['observations'], `${field}.observations`);

  const releaseWindow =
    projected['releaseWindow'] === undefined
      ? undefined
      : parseReleaseWindow(projected['releaseWindow'], `${field}.releaseWindow`);

  const retiredAt =
    projected['retiredAt'] === undefined
      ? undefined
      : requireIsoInstant(projected['retiredAt'], `${field}.retiredAt`);

  const result: { -readonly [K in keyof IdentityState]: IdentityState[K] } = {
    identity,
    observations,
  };
  if (accountRef !== undefined) result.accountRef = accountRef;
  if (retainedState !== undefined) result.retainedState = retainedState;
  if (releaseWindow !== undefined) result.releaseWindow = releaseWindow;
  if (retiredAt !== undefined) result.retiredAt = retiredAt;

  const state = Object.freeze(result);
  assertLifecycleConsistent(state, field);
  return state;
}

function parseRetainedState(input: unknown, field: string): RetainedIdentityState {
  const raw = requireRecord(input, field);
  const projected = projectDeclaredKeys(raw, RETAINED_STATE_FIELDS);
  return Object.freeze({
    ref: parseIdentityStateRef(projected['ref'], `${field}.ref`),
    interactionCount: requireInteger(projected['interactionCount'], `${field}.interactionCount`, 0, 1_000_000_000),
    firstObservedAt: requireIsoInstant(projected['firstObservedAt'], `${field}.firstObservedAt`),
    lastObservedAt: requireIsoInstant(projected['lastObservedAt'], `${field}.lastObservedAt`),
  });
}

function parseObservations(input: unknown, field: string): ReadonlyArray<EnvironmentObservation> {
  if (!Array.isArray(input)) {
    throw new ProductDomainError(`${field} must be an array`, field, {
      received: input === null ? 'null' : typeof input,
    });
  }
  if (input.length > MAX_ENVIRONMENT_OBSERVATIONS) {
    throw new ProductDomainError(
      `${field} must have at most ${MAX_ENVIRONMENT_OBSERVATIONS} entries`,
      field,
      { length: input.length, max: MAX_ENVIRONMENT_OBSERVATIONS },
    );
  }
  const parsed = input.map((v, i) => parseObservation(v, `${field}[${i}]`));
  return Object.freeze(parsed);
}

function parseObservation(input: unknown, field: string): EnvironmentObservation {
  const raw = requireRecord(input, field);
  const projected = projectDeclaredKeys(raw, OBSERVATION_FIELDS);
  return Object.freeze({
    environmentId: parseEnvironmentId(projected['environmentId'], `${field}.environmentId`),
    version: parseVersionLabel(projected['version'], `${field}.version`),
    observedAt: requireIsoInstant(projected['observedAt'], `${field}.observedAt`),
    runId: parseEvaluationRunId(projected['runId'], `${field}.runId`),
  });
}

function parseReleaseWindow(input: unknown, field: string): ReleaseWindow {
  const raw = requireRecord(input, field);
  const projected = projectDeclaredKeys(raw, WINDOW_FIELDS);
  const result: { -readonly [K in keyof ReleaseWindow]: ReleaseWindow[K] } = {
    fromVersion: parseVersionLabel(projected['fromVersion'], `${field}.fromVersion`),
    openedAt: requireIsoInstant(projected['openedAt'], `${field}.openedAt`),
  };
  if (projected['toVersion'] !== undefined) {
    result.toVersion = parseVersionLabel(projected['toVersion'], `${field}.toVersion`);
  }
  if (projected['closedAt'] !== undefined) {
    result.closedAt = requireIsoInstant(projected['closedAt'], `${field}.closedAt`);
  }
  const window: ReleaseWindow = Object.freeze(result);
  // A window is open or closed, never half-specified: mixing a toVersion
  // with no closedAt would make "did this transition finish?" unanswerable.
  if ((window.toVersion === undefined) !== (window.closedAt === undefined)) {
    throw new ProductDomainError(
      `${field}.toVersion and ${field}.closedAt must be present together`,
      field,
      { toVersion: window.toVersion, closedAt: window.closedAt },
    );
  }
  if (Date.parse(window.closedAt ?? window.openedAt) < Date.parse(window.openedAt)) {
    throw new ProductDomainError(
      `${field}.closedAt must not precede openedAt`,
      `${field}.closedAt`,
      { openedAt: window.openedAt, closedAt: window.closedAt },
    );
  }
  return window;
}

/**
 * The state-level consequences of a lifecycle.
 *
 * #57 already binds `lifecycle` to `stateRetention`; this adds the two
 * facts #57 does not model — a transition window, and whether retained
 * state may be present at all. Violations are `invalid_transition`
 * rather than a generic domain error, so a caller reloading damaged
 * state can tell "this record is inconsistent" from "this input is
 * malformed".
 */
function assertLifecycleConsistent(state: IdentityState, field: string): void {
  const { lifecycle } = state.identity;

  if (state.retainedState !== undefined && state.identity.capability.stateRetention === 'none') {
    throw new CohortStateError(
      'invalid_transition',
      `${field}: a "${lifecycle}" identity retains no state, so retainedState must be absent`,
      `${field}.retainedState`,
      { lifecycle },
    );
  }
  if (state.retainedState !== undefined && state.identity.stateRef === undefined) {
    throw new CohortStateError(
      'invalid_transition',
      `${field}: retainedState requires the identity to carry a stateRef`,
      `${field}.retainedState`,
      { lifecycle },
    );
  }

  if (state.releaseWindow !== undefined && lifecycle !== 'release') {
    throw new CohortStateError(
      'invalid_transition',
      `${field}: only a "release" identity has a transition window, but this one is "${lifecycle}"`,
      `${field}.releaseWindow`,
      { lifecycle },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Transitions                                                                 */
/* -------------------------------------------------------------------------- */

export interface RecordedObservation {
  readonly environmentId: EnvironmentId;
  readonly version: string;
  readonly observedAt: string;
  readonly runId: string;
}

/**
 * Append an observation, replacing any earlier one from the same run.
 *
 * Re-running an evaluation therefore does not duplicate history, and
 * re-observing the *same* run with a later instant updates that run's
 * entry rather than growing the record. The cap keeps the most recent
 * observations, which are the ones transition lineage needs.
 */
export function recordObservation(
  state: IdentityState,
  observation: RecordedObservation,
  field = 'identityState.observations',
): IdentityState {
  if (state.retiredAt !== undefined) {
    throw new CohortStateError(
      'invalid_transition',
      `${field}: a retired identity cannot be observed again`,
      field,
      { retiredAt: state.retiredAt },
    );
  }
  const parsed = parseObservation(
    {
      environmentId: observation.environmentId,
      version: observation.version,
      observedAt: observation.observedAt,
      runId: observation.runId,
    },
    field,
  );

  const withoutSameRun = state.observations.filter((o) => o.runId !== parsed.runId);
  const next = [...withoutSameRun, parsed];
  const bounded =
    next.length > MAX_ENVIRONMENT_OBSERVATIONS
      ? next.slice(next.length - MAX_ENVIRONMENT_OBSERVATIONS)
      : next;

  return replace(state, { observations: Object.freeze(bounded) });
}

export function openReleaseWindow(
  state: IdentityState,
  input: { readonly fromVersion: string; readonly openedAt: string },
): IdentityState {
  const { lifecycle } = state.identity;
  if (lifecycle !== 'release') {
    throw new CohortStateError(
      'invalid_transition',
      `only a "release" identity has a transition window, but this one is "${lifecycle}"`,
      'identityState.releaseWindow',
      { lifecycle },
    );
  }
  if (state.retiredAt !== undefined) {
    throw new CohortStateError(
      'invalid_transition',
      'a retired identity cannot open a transition window',
      'identityState.releaseWindow',
      { retiredAt: state.retiredAt },
    );
  }
  if (state.releaseWindow !== undefined) {
    throw new CohortStateError(
      'invalid_transition',
      'this release identity already has a transition window; a release identity spans exactly one transition',
      'identityState.releaseWindow',
      { existing: state.releaseWindow },
    );
  }
  const window = parseReleaseWindow(
    { fromVersion: input.fromVersion, openedAt: input.openedAt },
    'identityState.releaseWindow',
  );
  return replace(state, { releaseWindow: window });
}

/**
 * Close the transition window and drop the state it carried.
 *
 * This is the "exactly the intended transition window" semantics: the
 * retained state is what makes the second run of the transition a
 * *returning-user* observation, and it stops being retained the moment
 * the transition is complete. The window and the observations are kept —
 * they are the lineage that proves the transition happened.
 */
export function closeReleaseWindow(
  state: IdentityState,
  input: { readonly toVersion: string; readonly closedAt: string },
): IdentityState {
  const { releaseWindow } = state;
  if (releaseWindow === undefined) {
    throw new CohortStateError(
      'invalid_transition',
      'this identity has no open transition window to close',
      'identityState.releaseWindow',
      { lifecycle: state.identity.lifecycle },
    );
  }
  if (!isOpenWindow(releaseWindow)) {
    throw new CohortStateError(
      'invalid_transition',
      'this transition window is already closed',
      'identityState.releaseWindow',
      { releaseWindow },
    );
  }
  const closed = parseReleaseWindow(
    {
      fromVersion: releaseWindow.fromVersion,
      toVersion: input.toVersion,
      openedAt: releaseWindow.openedAt,
      closedAt: input.closedAt,
    },
    'identityState.releaseWindow',
  );
  // `retainedState: undefined` is dropped by `replace` under
  // `exactOptionalPropertyTypes`, which is the point.
  return replace(state, { releaseWindow: closed, retainedState: undefined });
}

/** Begin (or extend) the accumulation summary for an identity. */
export function touchRetainedState(
  state: IdentityState,
  input: { readonly at: string },
): IdentityState {
  const { stateRef } = state.identity;
  if (stateRef === undefined) {
    throw new CohortStateError(
      'invalid_transition',
      'this identity retains no state, so there is nothing to touch',
      'identityState.retainedState',
      { lifecycle: state.identity.lifecycle },
    );
  }
  const existing = state.retainedState;
  const next: RetainedIdentityState = existing === undefined
    ? Object.freeze({
        ref: stateRef,
        interactionCount: 1,
        firstObservedAt: input.at,
        lastObservedAt: input.at,
      })
    : Object.freeze({
        ref: stateRef,
        interactionCount: existing.interactionCount + 1,
        firstObservedAt: existing.firstObservedAt,
        lastObservedAt: input.at,
      });
  return replace(state, { retainedState: next });
}

/**
 * Return the identity's carried-over state to a fresh baseline.
 *
 * The declaration, the account reference, the observations and the
 * transition window all survive: those are lineage, and discarding them
 * would destroy the record of *which* identity carried state. Only the
 * accumulated state is dropped, so a subsequent evaluation meets a fresh
 * user under the same id.
 *
 * Idempotent — resetting an identity that holds no state is a successful
 * no-op, which is what makes it a safe thing for a caller to run
 * unconditionally.
 */
export function resetRetainedState(state: IdentityState): IdentityState {
  if (state.retiredAt !== undefined) {
    throw new CohortStateError(
      'invalid_transition',
      'a retired identity cannot be reset; retire it again if it is to be revived',
      'identityState',
      { retiredAt: state.retiredAt },
    );
  }
  return replace(state, { retainedState: undefined });
}

/** Withdraw an identity from future evaluations, keeping its lineage. */
export function retireIdentity(
  state: IdentityState,
  input: { readonly at: string },
): IdentityState {
  if (state.retiredAt !== undefined) {
    return state;
  }
  const at = requireIsoInstant(input.at, 'identityState.retiredAt');
  return replace(state, { retiredAt: at, retainedState: undefined });
}

export function isRetired(state: IdentityState): boolean {
  return state.retiredAt !== undefined;
}

/**
 * Whether this identity may take part in a new run.
 *
 * The store controls persistence; this is the store's own eligibility
 * rule, and it deliberately does **not** decide what the Reasoner is
 * allowed to see. That remains the Participant memory enforcement
 * (issue scope, "the store controls persistence").
 */
export function isEligibleForRun(state: IdentityState): boolean {
  return state.retiredAt === undefined;
}

/** Serializable form of an identity record. */
export function serializeIdentityState(state: IdentityState): Record<string, unknown> {
  const identity = state.identity as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...identity };
  if (state.accountRef !== undefined) out['accountRef'] = state.accountRef;
  if (state.retainedState !== undefined) out['retainedState'] = { ...state.retainedState };
  if (state.releaseWindow !== undefined) out['releaseWindow'] = { ...state.releaseWindow };
  if (state.retiredAt !== undefined) out['retiredAt'] = state.retiredAt;
  out['observations'] = state.observations.map((o) => ({ ...o }));
  return out;
}

/** Build a fresh state with no history. */
export function initialIdentityState(identity: SyntheticIdentity): IdentityState {
  return Object.freeze({ identity, observations: Object.freeze([]) });
}

/**
 * Produce a new state with some fields replaced.
 *
 * `retainedState` and `releaseWindow` are declared with an explicit
 * `| undefined` because under `exactOptionalPropertyTypes` an optional
 * property may not be *assigned* `undefined` — which would leave no way
 * to express "drop this field". The distinction the implementation below
 * relies on is `'field' in changes`: a key that is absent means "leave
 * it alone", and a key present with the value `undefined` means "drop
 * it". `closeReleaseWindow` and `resetRetainedState` need the latter.
 */
function replace(
  state: IdentityState,
  changes: {
    readonly accountRef?: AccountRef;
    readonly retainedState?: RetainedIdentityState | undefined;
    readonly observations?: ReadonlyArray<EnvironmentObservation>;
    readonly releaseWindow?: ReleaseWindow | undefined;
    readonly retiredAt?: string;
  },
): IdentityState {
  const result: { -readonly [K in keyof IdentityState]: IdentityState[K] } = {
    identity: state.identity,
    observations: changes.observations ?? state.observations,
  };
  const accountRef = changes.accountRef ?? state.accountRef;
  if (accountRef !== undefined) result.accountRef = accountRef;
  // An explicit `undefined` in `changes` means "drop this", which is how
  // `closeReleaseWindow` and `resetRetainedState` clear retained state.
  const retainedState =
    'retainedState' in changes ? changes.retainedState : state.retainedState;
  if (retainedState !== undefined) result.retainedState = retainedState;
  const releaseWindow =
    'releaseWindow' in changes ? changes.releaseWindow : state.releaseWindow;
  if (releaseWindow !== undefined) result.releaseWindow = releaseWindow;
  const retiredAt = changes.retiredAt ?? state.retiredAt;
  if (retiredAt !== undefined) result.retiredAt = retiredAt;

  return Object.freeze(result);
}
