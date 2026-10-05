/**
 * Programmatic configuration for the evaluation runtime (issue #63).
 *
 * ## Why configuration is supplied here and not read from `src/config/**`
 *
 * Issue #58 owns the on-disk configuration format and its loader. Until
 * #58 is integrated, Issue #63 explicitly permits supplying the same
 * values programmatically, and this module is that path. It is a
 * **shape**, not a policy: it says what a caller must hand in, and it
 * validates nothing that #57 / #59 / #62 have not already validated.
 *
 * Concretely:
 *
 * - `model` is a #57 `ProductModel`. It is consumed as-is; this layer
 *   does not re-parse or relax any of its invariants.
 * - `authority.policy` is `unknown` on purpose. #59's
 *   `parseOperatorAuthorityPolicy` is the only authority on whether a
 *   policy is well formed, and `createWorldOperator` calls it. Passing
 *   `unknown` means an invalid policy is refused by the layer that owns
 *   the rule rather than by a duplicate parser here.
 * - `steps` are raw `OperatorStep` values, parsed by #59 when the
 *   provisioning request is built.
 *
 * When #58 lands, a loader produces a `RuntimeConfiguration` and this
 * module becomes its output type. Nothing here has to move.
 *
 * ## What the runtime deliberately does *not* read
 *
 * No environment variable, no working directory, no module-level
 * mutable state, no ambient clock. Every one of those is an argument:
 * `clock` is the World Operator's own `OperatorClock`, and the runtime's
 * own instants come from the `now` function. A budget window that reads
 * the wall clock is a budget a test cannot pin, which is the reason
 * #59 refused to provide a default.
 */

import type { BrowserAdapter } from '../adapter/browser/interface.js';
import type { ObserverReport } from '../domain/observer.js';
import type { ReasonerConfig } from '../domain/experiment.js';
import type { FindingKind, Severity } from '../review/index.js';
import type { Reasoner } from '../domain/reasoner.js';
import type { CapabilityProfile, ParticipantAction } from '../domain/capability.js';
import type { CohortStateService } from '../cohort/index.js';
import type {
  EnvironmentId,
  ProductId,
  ProductModel,
  SyntheticIdentity,
} from '../product/index.js';
import type { OperatorClock, OperatorStep, ProvisioningConnector } from '../operator/index.js';
import type { ObserverFinding, ObserverFindingSeverity } from '../domain/observer.js';

/** How the runtime turns one `ObserverFinding` into a product outcome. */
export type ObserverFindingClassifier = (
  finding: ObserverFinding,
) =>
  | {
      /** Report it as a product finding. */
      readonly report: true;
      readonly severity: Severity;
      readonly kind: FindingKind;
    }
  | { readonly report: false; readonly reason: string };

/**
 * The runtime's own instants.
 *
 * Separate from the World Operator's `OperatorClock` because they are
 * different jobs: the operator's clock decides which UTC day a budget
 * window belongs to, this one stamps the run's lineage. A test pins
 * both, and pinning them to the same source keeps the artifact's
 * timestamps consistent with the audit log's.
 */
export type RuntimeClock = () => string;

/** What the experiment surface needs that the durable model does not carry. */
export interface RuntimeExperimentConfig {
  /** The task the Synthetic Identities are asked to attempt. */
  readonly userStory: string;
  /** Artifact root. One directory is created per run beneath it. */
  readonly outDir: string;
  /** Deterministic seed handed to the Reasoner and to the trace hash. */
  readonly seed: string;
  /** Hard cap on steps per identity. Bounded further by nothing else. */
  readonly maxStepsPerIdentity: number;
  readonly participantReasoner: ReasonerConfig;
  readonly observerReasoner: ReasonerConfig;
}

/**
 * Declared World Operator setup.
 *
 * `steps` is a **declaration**, not a script: the runtime hands it to
 * #59 and #59's gate decides what actually dispatches. The runtime has
 * no path that reaches a connector directly, so a plan containing a
 * step nobody granted produces a `SetupFailure`, not a dispatch.
 */
export interface RuntimeSetupConfig {
  /** Parsed by #59 inside `createWorldOperator`. Never validated here. */
  readonly policy: unknown;
  /**
   * The privileged effect surface.
   *
   * Held by the `WorldOperator` in an ECMAScript `#private` field. This
   * module stores the reference only long enough to hand it to
   * `createWorldOperator`, and never returns it, exposes it, or passes
   * it to participant execution.
   */
  readonly connector: ProvisioningConnector;
  readonly clock: OperatorClock;
  /** The declared provisioning plan, in application order. */
  readonly steps: ReadonlyArray<OperatorStep>;
  /** Audit note recorded on the provisioning request. Never a secret. */
  readonly reason?: string;
}

/**
 * Reasoner construction.
 *
 * The `script` member is not part of `ReasonerConfig` — the experiment
 * contract has no place to carry a per-participant action list — so it
 * travels beside the config and is folded in by the default factory.
 * That keeps the deterministic path available to an integration test
 * without widening the experiment contract, which is #65's surface.
 */
export type RuntimeReasonerFactory = (
  config: ReasonerConfig,
  ctx: {
    readonly role: 'participant' | 'observer';
    readonly participantLabel: string;
    readonly script?: ReadonlyArray<ParticipantAction>;
    readonly observerReport?: ObserverReport;
  },
) => Reasoner;

export interface RuntimeConfiguration {
  /** #57's durable model. The single source of Product/Environment/Cohort/Program. */
  readonly model: ProductModel;
  readonly experiment: RuntimeExperimentConfig;
  /** #60's durable store. Read-modify-write only; this layer writes no files of its own. */
  readonly cohort: CohortStateService;
  /** World Operator setup. Absent means "no privileged setup is declared". */
  readonly setup?: RuntimeSetupConfig;
  /** A fresh browser adapter per identity. Never shared: adapters hold a page. */
  readonly adapterFactory: () => BrowserAdapter;
  readonly reasonerFactory?: RuntimeReasonerFactory;
  /** The runtime's own instants. Defaults to the system clock. */
  readonly now?: RuntimeClock;
  /**
   * Per-identity participant capability profile.
   *
   * Required, and deliberately not derived: #57's `SyntheticIdentity`
   * bounds *authority* (origins, sessions, retention), while the three
   * capability axes are the Participant runtime's contract (ADR-0006).
   * Inferring one from the other would silently grant an identity an
   * observation or memory capability nobody declared.
   */
  readonly participantProfile: (identity: SyntheticIdentity) => CapabilityProfile;
  /** Deterministic action script per identity, for the scripted Reasoner. */
  readonly scriptFor?: (identity: SyntheticIdentity) => ReadonlyArray<ParticipantAction> | undefined;
  /** Which observer findings become product findings. See `findings.ts`. */
  readonly classifyObserverFinding?: ObserverFindingClassifier;
  /**
   * Bounded cleanup. Defaults to `true`: a run that provisions world
   * state and does not release it is a leak, and the World Operator is
   * the only thing allowed to release it.
   */
  readonly cleanup?: boolean;
}

/** The mapping from the observer's severity vocabulary onto #61's. */
export const OBSERVER_SEVERITY_MAP: Readonly<
  Record<ObserverFindingSeverity, Severity>
> = Object.freeze({
  critical: 'critical',
  major: 'high',
  minor: 'low',
  info: 'informational',
});

/**
 * Default observer-finding policy.
 *
 * Two categories are dropped, and the reasons are different:
 *
 * - `positive` is not a problem. Reporting "the page loaded" as a
 *   finding would put a non-defect into the denominator #64's
 *   false-positive rate is computed over.
 * - `info` is an observation, not a claim about the product. The
 *   observer emits it for anything it wants to note, including its own
 *   clean finish.
 *
 * Everything else is reported with a kind derived from the observer's
 * own category. The mapping is data, not inference: the runtime never
 * guesses a `FindingKind` the observer did not imply.
 */
export const DEFAULT_OBSERVER_CLASSIFIER: ObserverFindingClassifier = (finding) => {
  if (finding.category === 'positive') {
    return { report: false, reason: 'positive observations are not product problems' };
  }
  if (finding.severity === 'info') {
    return { report: false, reason: 'informational observer notes are not product findings' };
  }
  return {
    report: true,
    severity: OBSERVER_SEVERITY_MAP[finding.severity],
    kind: OBSERVER_FINDING_KIND[finding.category],
  };
};

const OBSERVER_FINDING_KIND: Readonly<
  Record<ObserverFinding['category'], FindingKind>
> = Object.freeze({
  dead_end: 'workflowBlocker',
  friction: 'usabilityDefect',
  confusion: 'comprehensionGap',
  trust: 'trustDefect',
  navigation: 'usabilityDefect',
  timing: 'usabilityDefect',
  error: 'reliabilityFailure',
  positive: 'other',
});

/**
 * The participant profile #57's own retention implies.
 *
 * A *default*, exported so a caller can adopt it deliberately and
 * override per identity. It is not applied implicitly: `RuntimeConfiguration
 * .participantProfile` is required, so no run happens without someone
 * having written down what the participant may see and do.
 *
 * The memory axis follows #57's retention table rather than the
 * lifecycle name, because retention is the property #57 validates
 * against the lifecycle and it is the one that decides whether a run is
 * a returning-user observation at all.
 */
export function defaultParticipantProfile(identity: SyntheticIdentity): CapabilityProfile {
  return Object.freeze({
    observation: 'visual',
    // `ActionCapability` has exactly one member: there is no privileged
    // action primitive a participant profile can enable. See ADR-0006.
    action: 'visualOnly',
    memory:
      identity.capability.stateRetention === 'none'
        ? Object.freeze({ kind: 'limitedRecent' as const, windowSteps: 1 })
        : Object.freeze({ kind: 'fullHistory' as const }),
  });
}

/** The environment's declared entry point, or `undefined` when absent. */
export function environmentBaseUrl(
  model: ProductModel,
  environmentId: EnvironmentId,
): string | undefined {
  return model.environments.find((e) => e.id === environmentId)?.endpoint.baseUrl;
}

/** The declared product of the model, used for cross-checks. */
export function modelProductId(model: ProductModel): ProductId {
  return model.product.id;
}
