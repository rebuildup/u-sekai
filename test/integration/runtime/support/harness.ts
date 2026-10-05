/**
 * A non-browser harness for the runtime integration suite.
 *
 * The Playwright vertical slice proves the browser path end to end. The
 * other acceptance criteria are about what the runtime *decides* — which
 * record a failure becomes, what is persisted, which lineage joins — and
 * those decisions are downstream of the adapter, not upstream. Driving
 * them through `HttpAdapter` against the same in-repo demo server keeps
 * each test about one thing: a browser launch in every test would make
 * a policy assertion fail for reasons that have nothing to do with the
 * policy.
 *
 * The environment is still real. It is the same `src/demo/environment`
 * HTTP application the browser suite drives, reached through the
 * adapter interface, so nothing about the participant loop, the
 * capability enforcement, the evidence roll-up or the review projection
 * is stubbed out.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { startServer, type ServerHandle } from '../../../../src/demo/environment/server.js';
import { HttpAdapter } from '../../../../src/adapter/browser/http-adapter.js';
import {
  defaultParticipantProfile,
  type RuntimeConfiguration,
  type RuntimeReasonerFactory,
} from '../../../../src/runtime/index.js';
import type { OperatorStep, ProvisioningConnector } from '../../../../src/operator/index.js';
import type { ParticipantAction } from '../../../../src/domain/capability.js';
import type { EnvironmentSpec, IdentitySpec, PrivilegedAttemptKind } from './fixtures.js';
import {
  ENV_A,
  fixedClock,
  linkedOperatorClock,
  makeModel,
  makeService,
  reasonerFactory,
  stagingPolicy,
  type ObserverFindingSpec,
} from './fixtures.js';

export interface HarnessRoot {
  readonly server: ServerHandle;
  readonly dir: string;
  readonly cleanup: () => Promise<void>;
}

/** Start a demo server and a per-file temp root. */
export async function startHarnessRoot(prefix = 'u-sekai-runtime-'): Promise<HarnessRoot> {
  const server = await startServer({ port: 0 });
  const dir = await fs.mkdtemp(path.join('/tmp', prefix));
  return {
    server,
    dir,
    cleanup: async () => {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

export interface HarnessOptions {
  /** Identity specs. The cohort resolves to exactly these, in id order. */
  readonly identities: ReadonlyArray<IdentitySpec>;
  /** The environment the plan targets. */
  readonly environmentId?: string;
  /** Extra environments declared in the model (a release transition's target). */
  readonly extraEnvironments?: ReadonlyArray<EnvironmentSpec>;
  /** Point the target environment at a dead address instead of the demo server. */
  readonly unreachable?: boolean;
  /** Declared provisioning plan. Empty means "no privileged setup". */
  readonly steps?: ReadonlyArray<OperatorStep>;
  /** The connector. Required whenever `steps` is non-empty. */
  readonly connector?: ProvisioningConnector;
  /** Override the World Operator policy. */
  readonly policy?: Record<string, unknown>;
  /** The observer findings the run should produce. */
  readonly observerFindings?: ReadonlyArray<ObserverFindingSpec>;
  /** The participant action script. */
  readonly script?: ReadonlyArray<ParticipantAction>;
  /**
   * Make the scripted Reasoner emit one privileged action attempt
   * before following the script. See `fixtures.ts`.
   */
  readonly attemptPrivilegedKind?: PrivilegedAttemptKind;
  readonly reasonerFactory?: RuntimeReasonerFactory;
  /** A distinct store directory, so two configurations do not share one. */
  readonly storeName?: string;
  readonly maxStepsPerIdentity?: number;
  /** Cap the plan applies on top of the resolved cohort. */
  readonly planningCeiling?: number;
}

export interface Harness {
  readonly config: RuntimeConfiguration;
  readonly baseUrl: string;
}

/**
 * Build a runtime configuration over the given root.
 *
 * No World Operator is constructed when there is no connector and no
 * declared plan, so a test about the participant loop does not have to
 * declare a policy it never uses and `result.setup.status` is then
 * `skipped`.
 */
export function buildHarness(root: HarnessRoot, options: HarnessOptions): Harness {
  const environmentId = options.environmentId ?? ENV_A;
  const baseUrl = options.unreachable === true ? 'http://127.0.0.1:9' : root.server.baseUrl;
  const clock = fixedClock();
  const storeName = options.storeName ?? 'store';
  const service = makeService(path.join(root.dir, storeName), { now: fixedClock() });

  const environments: EnvironmentSpec[] = [
    { id: environmentId, baseUrl },
    ...(options.extraEnvironments ?? []),
  ];

  const setup =
    options.connector === undefined
      ? undefined
      : {
          policy: options.policy ?? stagingPolicy(),
          connector: options.connector,
          clock: linkedOperatorClock(clock),
          steps: options.steps ?? [],
          reason: 'issue 63 integration fixture',
        };

  return {
    baseUrl,
    config: {
      model: makeModel({ environments, identities: options.identities }),
      cohort: service,
      experiment: {
        userStory: 'Add a task to the list.',
        outDir: path.join(root.dir, storeName, 'artifacts'),
        seed: 'runtime-63',
        maxStepsPerIdentity: options.maxStepsPerIdentity ?? 6,
        participantReasoner: { provider: 'scripted', seed: 'runtime-63' },
        observerReasoner: { provider: 'scripted', seed: 'runtime-63' },
      },
      ...(setup !== undefined ? { setup } : {}),
      adapterFactory: () => new HttpAdapter(),
      reasonerFactory:
        options.reasonerFactory ??
        reasonerFactory({
          observerFindings: options.observerFindings ?? [],
          ...(options.attemptPrivilegedKind !== undefined
            ? { attemptPrivilegedKind: options.attemptPrivilegedKind }
            : {}),
        }),
      now: clock,
      participantProfile: defaultParticipantProfile,
      ...(options.script !== undefined
        ? { scriptFor: () => options.script as ReadonlyArray<ParticipantAction> }
        : {}),
    },
  };
}
