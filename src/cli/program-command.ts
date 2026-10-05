/**
 * The Continuous Product Evaluation CLI surface (issue #65).
 *
 * ## What this module is
 *
 * The bridge between three packages that were each built against a
 * different question, and that therefore do not know about each other:
 *
 * | package | question it owns |
 * | --- | --- |
 * | `src/config/**` (#58) | *what* may be run, and *under which authority* |
 * | `src/program/**` (#62) | *whether* it is due, and *what the run would cost* |
 * | `src/runtime/**` (#63) | *what happened* when it ran |
 *
 * #63's own docstring says the seam this module fills was anticipated:
 * "it does not read configuration from disk (that is #58 …) — a loader
 * produces a `RuntimeConfiguration` and this module becomes its output
 * type." This is that loader. #58's `UseSekaiConfig.model` is already a
 * #57 `ProductModel`, which is exactly the field `RuntimeConfiguration
 * .model` declares, so the durable model crosses over without a
 * translation; everything *around* it is what this module supplies.
 *
 * ## The three properties this surface is responsible for
 *
 * 1. **The file is the whole authority.** #58 has no parameter through
 *    which a caller could supply an authority, and this module does not
 *    add one. The only configuration input is *which file to read* —
 *    `--config`, `USE_SEKAI_CONFIG`, or `./u-sekai.yml`, in #58's own
 *    precedence order. There is deliberately **no** `--allow-*`,
 *    `--force`, `--skip-validation` or `--unsafe` flag: a flag that made
 *    the surface lenient would silently destroy the guarantee #58 exists
 *    to provide, so the surface has no shape in which that is expressible.
 * 2. **Privileged setup goes through #59's gate, never around it.**
 *    When the target environment declares World Operator connectors, the
 *    policy handed to #63 is *derived from the file's own authority
 *    envelope* — never widened. When it declares none, no operator is
 *    constructed at all, so there is no ungated path to a connector.
 * 3. **A setup failure is never reported as a product finding.** #63
 *    already returns them as separate `SetupFailure` records; this
 *    module keeps them separate in the exit code and the output, because
 *    a caller that conflates them would read "we could not set the world
 *    up" as "the product is broken".
 *
 * ## Exit codes
 *
 * Reuses 1 (configuration) and 2 (runtime) from the experiment surface so
 * a script can branch on "bad input" and "the run broke" without knowing
 * which surface it invoked, and adds two that the experiment surface has
 * no meaning for:
 *
 * - `4` — setup was refused, so the run observed nothing. Not a product
 *   verdict. A script must not read this as "no problems found"; it means
 *   the opposite, that u-sekai could not look.
 * - `5` — the run completed and reported product findings. Distinct from
 *   `0` so a CI gate can fail on findings without failing on a broken
 *   environment, which is the difference between "the product has a
 *   problem" and "u-sekai has a problem".
 *
 * It never returns `3`. That code means a participant hit a capability
 * violation, which in a program run is reported by #63 as a setup or
 * runtime failure rather than as a process-level capability signal.
 */

import * as path from 'node:path';

import { isCohortStateError, CohortStateService, FileRecordStore } from '../cohort/index.js';
import { HttpAdapter } from '../adapter/browser/http-adapter.js';
import { PlaywrightAdapter } from '../adapter/browser/playwright-adapter.js';
import { UseSekaiConfigError, loadUseSekaiConfig } from '../config/index.js';
import type { ConfiguredEnvironment, UseSekaiConfig } from '../config/index.js';
import {
  parseReviewProgramId,
  type ReviewProgram,
  type ReviewProgramId,
  type SyntheticCohort,
  type SyntheticIdentity,
} from '../product/index.js';
import { planEvaluation, parseTriggerDeliveryId } from '../program/index.js';
import type { EvaluationPlan, PlanDecision } from '../program/index.js';
import {
  defaultParticipantProfile,
  isRuntimeIntegrationError,
  runEvaluation,
  type EvaluationRunResult,
  type RuntimeConfiguration,
} from '../runtime/index.js';

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Subcommands accepted under `config` and under `program`.
 *
 * Declared here, next to the code that dispatches them, and re-exported
 * for `index.ts`. The parser in `index.ts` needs the same two unions to
 * narrow without a cast; having one declaration means a verb cannot be
 * parseable and un-dispatchable.
 */
export type ConfigSubcommand = 'validate';
export type ProgramSubcommand = 'run' | 'status';

/* -------------------------------------------------------------------------- */
/* Exit codes                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The process exit code, as one value rather than several bare numbers.
 *
 * A union rather than an `enum` so a `switch` over it is checked against
 * every member, and so adding a code without deciding what prints for it
 * is a compile error at the reporting site.
 */
export type ProgramExitCode =
  /** Ran, and reported nothing the product should be told about. */
  | 0
  /** The configuration, the request, or the plan was refused. */
  | 1
  /** The run itself failed: adapter, Reasoner, or durable store. */
  | 2
  /** Setup was refused, so nothing was observed. Not a product verdict. */
  | 4
  /** The run completed and reported product findings. */
  | 5;

/* -------------------------------------------------------------------------- */
/* Argument shape                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The parsed invocation, in the shape `parseArgs` in `index.ts` produces.
 *
 * Declared here rather than imported so the two files agree on the shape
 * without one owning the other's parser.
 */
export interface ProgramSurfaceArgs {
  readonly command: 'config' | 'program';
  readonly subcommand: ConfigSubcommand | ProgramSubcommand | null;
  readonly positional: ReadonlyArray<string>;
  readonly flags: Readonly<Record<string, string>>;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Dispatch a `config` / `program` invocation.
 *
 * Never throws: every failure becomes a written diagnostic and a
 * classified exit code, because the process exit code is this surface's
 * only machine-readable output and a stack trace is not one.
 */
export async function runProgramSurface(args: ProgramSurfaceArgs): Promise<ProgramExitCode> {
  const out = createSink();
  try {
    if (args.command === 'config') return await runConfigCommand(args, out);
    return await runProgramCommand(args, out);
  } catch (error) {
    out.error(describeFailure(error));
    return classifyFailure(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Output sink                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Where the surface writes.
 *
 * Injected rather than reaching for `process` directly so a test can
 * assert on the *observable* output — which is what the acceptance
 * criteria are about — without a child process, and so the exit-code
 * contract and the printed contract cannot drift apart.
 */
export interface OutputSink {
  readonly line: (text: string) => void;
  readonly error: (text: string) => void;
}

function createSink(): OutputSink {
  return {
    line: (text: string) => process.stdout.write(`${text}\n`),
    error: (text: string) => process.stderr.write(`${text}\n`),
  };
}

/* -------------------------------------------------------------------------- */
/* config                                                                       */
/* -------------------------------------------------------------------------- */

async function runConfigCommand(
  args: ProgramSurfaceArgs,
  out: OutputSink,
): Promise<ProgramExitCode> {
  if (args.subcommand !== 'validate') {
    out.error(
      `u-sekai: config: expected a subcommand (${listConfigSubcommands()}). Use --help.`,
    );
    return 1;
  }
  // A positional path is a *convenience*, and it is resolved through
  // #58's own precedence rather than around it: the positional only
  // chooses the file, exactly as `--config` does, and grants nothing.
  const explicit = args.positional[0] ?? args.flags['config'];
  const config = await loadUseSekaiConfig(
    explicit === undefined ? {} : { configPath: explicit },
  );
  reportConfig(config, out);
  return 0;
}

function listConfigSubcommands(): string {
  return 'validate';
}

function listProgramSubcommands(): string {
  return 'run, status';
}

/**
 * Report what the file authorises.
 *
 * Every line is a fact the file states, not a summary of the loader's
 * opinion: the environments with their class and origins, the declared
 * authority per environment (including which defaults are *denials*),
 * and the programs with their triggers. A fresh user needs to see that
 * the file they just wrote resolves to what they meant.
 */
function reportConfig(config: UseSekaiConfig, out: OutputSink): void {
  const { model, provenance } = config;
  out.line(`ok: ${config.provenance.configPath} (schema v${config.schemaVersion})`);
  out.line(`  source: ${provenance.configPathSource}`);
  out.line(`  product: ${model.product.id} (${model.product.displayName})`);
  out.line(`  environments: ${config.environments.length}`);

  for (const environment of config.environments) {
    const durable = model.environments.find((e) => e.id === environment.id);
    out.line(
      `    ${environment.name}: class=${durable?.environmentClass ?? 'unknown'} ` +
        `origins=${environment.origins.length} authority=${environment.authoritySource}`,
    );
    // The denied/allowed detail is the part a user most often gets
    // wrong, and it is the part a lenient loader would hide. Printing
    // each axis separately is the point: "authority=file" on its own
    // does not say *what* the file granted.
    const { authority } = environment;
    out.line(
      `      destructiveActions=${authority.destructiveActions} ` +
        `externalCommunication=${authority.externalCommunication} ` +
        `realMoney=${authority.realMoney.enabled ? authority.realMoney.maxAmount : 'denied'}`,
    );
    const connectors = describeWorldConnectors(environment);
    out.line(`      world: ${connectors === '' ? 'none declared' : connectors}`);
  }

  out.line(`  identities: ${model.identities.length}`);
  for (const identity of model.identities) {
    out.line(
      `    ${identity.id}: lifecycle=${identity.lifecycle} ` +
        `retention=${identity.capability.stateRetention}`,
    );
  }
  out.line(`  cohorts: ${model.cohorts.length}`);
  for (const cohort of model.cohorts) {
    out.line(`    ${cohort.name}: membership=${describeMembership(cohort)}`);
  }
  out.line(`  reviewPrograms: ${model.programs.length}`);
  for (const program of model.programs) {
    out.line(
      `    ${program.name}: environments=${program.environmentIds.join(',')} ` +
        `cohort=${program.cohortId} triggers=${program.triggers.map((t) => t.kind).join(',')}`,
    );
  }
  out.line('  authority: u-sekai.yml is the only authority surface; no flag widens it.');
}

function describeWorldConnectors(environment: ConfiguredEnvironment): string {
  const declared: string[] = [];
  if (environment.world.accounts !== undefined) {
    declared.push(`accounts(${environment.world.accounts.provider})`);
  }
  if (environment.world.email !== undefined) {
    declared.push(`email(${environment.world.email.provider})`);
  }
  if (environment.world.billing !== undefined) {
    declared.push(`billing(${environment.world.billing.provider}/${environment.world.billing.mode})`);
  }
  return declared.join(' ');
}

function describeMembership(cohort: SyntheticCohort): string {
  const { membership } = cohort;
  if (membership.kind === 'explicit') {
    return `explicit(${membership.identityIds.join(',')})`;
  }
  if (membership.kind === 'sizeTarget') {
    return `sizeTarget(${membership.lifecycle},${membership.targetSize})`;
  }
  return `byLifecycle(${membership.lifecycle})`;
}

/* -------------------------------------------------------------------------- */
/* program                                                                      */
/* -------------------------------------------------------------------------- */

async function runProgramCommand(
  args: ProgramSurfaceArgs,
  out: OutputSink,
): Promise<ProgramExitCode> {
  if (args.subcommand === null) {
    out.error(`u-sekai: program: expected a subcommand (${listProgramSubcommands()}). Use --help.`);
    return 1;
  }
  const config = await loadUseSekaiConfig(
    args.flags['config'] === undefined ? {} : { configPath: args.flags['config'] },
  );
  const program = requireProgram(config, args.positional[0], out);
  if (program === null) return 1;

  if (args.subcommand === 'status') {
    return await reportProgramStatus(config, program, args, out);
  }
  return await runConfiguredProgram(config, program, args, out);
}

/**
 * Find the named program.
 *
 * The argument is the program's **name** as written in `u-sekai.yml`,
 * not its derived durable id: a user reading their own file types what
 * they wrote there. A derived id is also accepted, because a script that
 * read it out of `config validate` should work unchanged.
 */
function requireProgram(
  config: UseSekaiConfig,
  name: string | undefined,
  out: OutputSink,
): ReviewProgram | null {
  if (name === undefined || name === '') {
    out.error('u-sekai: program: missing <program-id>. Name it as in u-sekai.yml.');
    return null;
  }
  const byName = config.model.programs.find((program) => program.name === name);
  if (byName !== undefined) return byName;

  // Only attempt the derived-id parse when the name is not a program's
  // name, so a typo in a *name* reports the names that do exist instead
  // of an id grammar error.
  try {
    const id: ReviewProgramId = parseReviewProgramId(name);
    const byId = config.model.programs.find((program) => program.id === id);
    if (byId !== undefined) return byId;
  } catch {
    // Falls through to the named-program diagnostic below.
  }

  out.error(`u-sekai: program: no review program named or identified by "${name}".`);
  for (const program of config.model.programs) {
    out.error(`  declared: ${program.name} (${program.id})`);
  }
  return null;
}

/**
 * Report what the durable store knows, without running anything.
 *
 * Read-only by construction: it opens the store and calls the read
 * surface, so a user can inspect a program's history before spending a
 * run on it, and can tell "never run" from "ran and found nothing".
 */
async function reportProgramStatus(
  config: UseSekaiConfig,
  program: ReviewProgram,
  args: ProgramSurfaceArgs,
  out: OutputSink,
): Promise<ProgramExitCode> {
  const stateDir = resolveStateDir(args);
  const service = new CohortStateService({ store: new FileRecordStore({ rootDir: stateDir }) });

  out.line(`program: ${program.name} (${program.id})`);
  out.line(`  environments: ${program.environmentIds.join(',')}`);
  out.line(`  cohort: ${program.cohortId}`);
  out.line(`  triggers: ${program.triggers.map((t) => t.kind).join(',')}`);
  out.line(
    `  budget: maxRunsPerDay=${program.budget.maxRunsPerDay} ` +
      `maxRunsPerEvent=${program.budget.maxRunsPerEvent} ` +
      `maxCostUnitsPerDay=${program.budget.maxCostUnitsPerDay}`,
  );
  out.line(`  state: ${stateDir}`);

  const cohort = config.model.cohorts.find((c) => c.id === program.cohortId);
  if (cohort === undefined) {
    out.error(`u-sekai: program status: cohort ${program.cohortId} is not declared.`);
    return 1;
  }

  // A cohort that was never declared has no membership to report, which
  // is a fact about the store rather than an error: the honest report is
  // "nothing has been observed yet", not a failure to read.
  const stored = await service.tryLoadCohort(cohort.id);
  if (stored === undefined) {
    out.line('  members: (none resolved yet — no run has declared this cohort)');
    return 0;
  }
  const members = stored.membership?.members ?? [];
  if (members.length === 0) {
    out.line(`  members: (0 eligible; excluded: ${describeExclusions(stored.membership?.excluded ?? [])})`);
    return 0;
  }
  out.line(`  members: ${members.length}`);

  let observed = 0;
  for (const identityId of members) {
    const state = await service.tryLoadIdentity(identityId);
    if (state === undefined) continue;
    const observations = state.observations;
    if (observations.length > 0) observed += 1;
    const latest = observations[observations.length - 1];
    out.line(
      `    ${identityId}: lifecycle=${state.identity.lifecycle} ` +
        `observations=${observations.length}` +
        (latest === undefined
          ? ''
          : ` lastVersion=${latest.version} lastSeen=${latest.observedAt}`),
    );
  }
  out.line(
    `  identities with an observation: ${observed}/${members.length}` +
      (observed === 0
        ? ' — a release transition needs two observations of the same cohort'
        : ''),
  );
  return 0;
}

function describeExclusions(excluded: ReadonlyArray<{ readonly identityId: string; readonly reason: string }>): string {
  if (excluded.length === 0) return 'none';
  return excluded.map((entry) => `${entry.identityId}(${entry.reason})`).join(', ');
}

/* -------------------------------------------------------------------------- */
/* program run                                                                  */
/* -------------------------------------------------------------------------- */

async function runConfiguredProgram(
  config: UseSekaiConfig,
  program: ReviewProgram,
  args: ProgramSurfaceArgs,
  out: OutputSink,
): Promise<ProgramExitCode> {
  const stateDir = resolveStateDir(args);
  const service = new CohortStateService({ store: new FileRecordStore({ rootDir: stateDir }) });

  // The identities the file declares are the population the program may
  // select from. Declaring them into the store is idempotent by
  // construction: #60 refuses a re-declaration that differs, so a run
  // cannot silently rewrite what a cohort was resolved from.
  const cohort = config.model.cohorts.find((c) => c.id === program.cohortId);
  if (cohort === undefined) {
    out.error(`u-sekai: program run: cohort ${program.cohortId} is not declared.`);
    return 1;
  }

  // Asked before the first store write. #63 refuses a run with no
  // observed version, and it refuses *after* the operator is built and
  // the cohort resolved; asking here means a missing flag costs a
  // diagnostic rather than a run that provisions, drives a browser, and
  // then declines to record what it saw. `--dry-run` is exempt, because
  // it dispatches nothing and therefore records no observation.
  const observedVersion = args.flags['dry-run'] === undefined ? requireVersionLabel(args) : undefined;

  for (const identity of identitiesForCohort(config, cohort)) {
    await service.declareIdentity(identity);
  }
  await service.declareCohort(cohort);

  const decision = planForManualRun(config, program, cohort, args);
  if (decision.outcome !== 'due') {
    // Narrowed here, so `reportNotDue` receives a shape that provably
    // has no `plan` — it cannot accidentally read one.
    reportNotDue(decision, program, out);
    return 1;
  }
  const { plan } = decision;

  out.line(`program: ${program.name} (${program.id})`);
  out.line(`  plan: ${plan.planKey}`);
  out.line(`  mode: ${plan.mode}`);
  out.line(`  target: environment=${plan.target.environmentId} cohort=${plan.target.cohortId}`);
  out.line(
    `  cost: ${plan.budget.costUnits} unit(s) reserved ` +
      `(scout ${plan.budget.scoutCostUnits} + verification ${plan.budget.verificationCostUnits}); ` +
      'reserved at plan emission and not released',
  );
  out.line(`  identities: ${plan.cohort.plannedIdentities} planned, ceiling ${plan.cohort.planningCeiling}`);

  if (args.flags['dry-run'] !== undefined) {
    out.line('dry-run: nothing was dispatched.');
    return 0;
  }

  const runtimeConfig = buildRuntimeConfiguration(config, plan, program, args, service, stateDir);
  // Narrowed rather than cast. `--dry-run` returned above, so this
  // branch is unreachable; it is written as a real refusal instead of an
  // assertion so that a future edit which reorders the dry-run return
  // produces a diagnostic rather than an `undefined` reaching #63.
  if (observedVersion === undefined) {
    throw new ProgramUsageError('--version-label is required to run a program');
  }

  const result = await runEvaluation(runtimeConfig, {
    plan,
    observedVersion,
    persist: true,
  });
  return reportRunResult(result, out);
}

/**
 * Plan one manual run of `program`.
 *
 * The trigger is a **manual** delivery, because a person typed the
 * command. #62's trigger resolution is still what decides whether that
 * is a candidate: a program that declares no `manual` trigger resolves
 * to `not-due` with `no-trigger`, and this surface reports that rather
 * than planning anyway. Forcing a run past a program that never asked
 * for one would make the trigger block decorative.
 */
function planForManualRun(
  config: UseSekaiConfig,
  program: ReviewProgram,
  cohort: SyntheticCohort,
  args: ProgramSurfaceArgs,
): PlanDecision {
  const now = new Date().toISOString();
  return planEvaluation({
    model: config.model,
    programId: program.id,
    now,
    signals: [
      {
        kind: 'manual',
        deliveryId: parseTriggerDeliveryId(`cli-${args.flags['delivery'] ?? 'local'}`),
        requestedAt: now,
      },
    ],
    planningCeiling: requirePlanningCeiling(args, cohort),
    // Declared, provider-neutral rates. #62 is explicit that a cost is
    // arithmetic on declarations and never on measurement, so these are
    // stated here rather than inferred from a run that has not happened.
    rates: { scoutUnitsPerIdentity: 1, verificationUnitsPerIdentity: 1 },
    // Zero environment-mutating actions, always. The CLI has no
    // `--allow-mutation` flag: a plan that mutates the environment under
    // test is a different product decision, and #59's gate is where it
    // belongs.
    maxMutatingActions: 0,
  });
}

/**
 * The per-plan identity ceiling.
 *
 * Defaults to the count the cohort's own membership rule declares, and
 * otherwise to 1. A ceiling is a cap on how many identities one command
 * exercises, so the default is the smallest value that still runs.
 *
 * `--max-identities` can only ever *lower* the count relative to what
 * the cohort selects: it is `min(flag, what the cohort resolves)`, which
 * #62 applies itself in `buildCohortSelection`. A flag that could raise
 * a plan past the cohort's declared membership would let a command line
 * select a population `u-sekai.yml` never declared.
 */
function requirePlanningCeiling(args: ProgramSurfaceArgs, cohort: SyntheticCohort): number {
  const flag = args.flags['max-identities'];
  if (flag !== undefined) {
    const parsed = Number(flag);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new ProgramUsageError(`--max-identities must be a positive integer, got "${flag}"`);
    }
    return parsed;
  }
  return declaredMembershipSize(cohort);
}

/**
 * The identity count a membership rule declares, or `null`.
 *
 * Mirrors #62's own `declaredSize`, which is not exported: an `explicit`
 * rule declares its member list, a `sizeTarget` declares a number, and a
 * `byLifecycle` rule declares neither — it is resolved against the store
 * at run time, so the caller has to supply a ceiling for it.
 */
function declaredMembershipSize(cohort: SyntheticCohort): number {
  const { membership } = cohort;
  if (membership.kind === 'explicit') return membership.identityIds.length;
  if (membership.kind === 'sizeTarget') return membership.targetSize;
  return 1;
}

/** The identities a cohort's membership rule can select. */
function identitiesForCohort(config: UseSekaiConfig, cohort: SyntheticCohort): ReadonlyArray<SyntheticIdentity> {
  const { membership } = cohort;
  if (membership.kind === 'explicit') {
    return config.model.identities.filter((identity) => membership.identityIds.includes(identity.id));
  }
  return config.model.identities.filter(
    (identity) => identity.lifecycle === membership.lifecycle,
  );
}

/**
 * Build the runtime configuration #63 consumes.
 *
 * Every value here is either read from the file, derived from it by a
 * rule that can only narrow, or named on the command line. Nothing is
 * defaulted in a way that *adds* authority — the two that look like
 * defaults are the two #58 already defines as denials.
 */
function buildRuntimeConfiguration(
  config: UseSekaiConfig,
  plan: EvaluationPlan,
  program: ReviewProgram,
  args: ProgramSurfaceArgs,
  service: CohortStateService,
  stateDir: string,
): RuntimeConfiguration {
  const environmentId = plan.target.environmentId;
  const environment = config.environments.find((e) => e.id === environmentId);
  if (environment === undefined) {
    // Cannot happen while the plan came from this config, but a refusal
    // is cheaper than a run that resolves the authority from nowhere.
    throw new ProgramUsageError(
      `environment ${environmentId} is not in ${config.provenance.configPath}`,
    );
  }

  const adapterName = args.flags['adapter'] ?? 'http';
  const provider = args.flags['reasoner'] ?? 'scripted';
  const observerProvider = args.flags['observer-reasoner'] ?? provider;
  const seed = args.flags['seed'] ?? `u-sekai-${program.id}`;

  const base: RuntimeConfiguration = {
    model: config.model,
    cohort: service,
    experiment: {
      userStory: args.flags['task'] ?? 'Explore the product and report what a new user would hit.',
      outDir: path.resolve(
        process.cwd(),
        args.flags['out'] ?? path.join(stateDir, 'artifacts'),
      ),
      seed,
      maxStepsPerIdentity: parsePositiveInt(args.flags['max-steps'], 6, '--max-steps'),
      participantReasoner: { provider: requireProvider(provider, '--reasoner'), seed },
      observerReasoner: { provider: requireProvider(observerProvider, '--observer-reasoner'), seed },
    },
    // Reuses the adapters the experiment surface already selects. The
    // `playwright` choice is the same `src/adapter/browser/playwright-adapter.ts`
    // the pre-0.4.0 path uses — no second browser path exists here.
    adapterFactory: () =>
      adapterName === 'playwright' ? new PlaywrightAdapter() : new HttpAdapter(),
    participantProfile: defaultParticipantProfile,
  };

  /*
   * No World Operator is constructed, deliberately.
   *
   * `u-sekai.yml`'s `world:` block declares *connectors and authority*,
   * not a provisioning plan: there is no step list anywhere in the
   * configuration format, so this CLI has no steps to declare. Building
   * an operator anyway was tried and is wrong in a way `tsc` cannot
   * catch — with zero declared steps the setup phase reports `skipped`,
   * but #63 still runs the cleanup phase, and #59's cleanup issues a
   * `fixture.reset` probe through the same gate as any destructive step.
   * With nothing provisioned there is nothing to release, so that probe
   * is denied, and the denial is reported as a `SetupFailure`. The
   * observable effect was an exit code 4 reading "setup refused" for a
   * run whose actual failure was an unreachable environment — a
   * misattributed diagnosis, which is worse than no diagnosis.
   *
   * Not constructing an operator is also the fail-closed direction:
   * with no operator there is no object holding a connector, so there is
   * no path to a privileged effect even by accident. When a
   * provisioning plan does become declarable, the setup belongs here,
   * and it must go through `buildWorldOperator` so #59's gate still
   * authorises it — never around it.
   */
  void environment;
  return base;
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The version the environment was observed at.
 *
 * Required, with no default. #63 refuses to invent one for exactly the
 * reason recorded in `resolveObservedVersion`: a guessed version poisons
 * the next release-transition join, and that error surfaces two runs
 * later as a comparison that silently means nothing. Making the operator
 * state it costs one flag and removes a whole class of wrong answer.
 */
function requireVersionLabel(args: ProgramSurfaceArgs): string {
  const label = args.flags['version-label'];
  if (label === undefined || label === '') {
    throw new ProgramUsageError(
      '--version-label is required: the version the environment answered as. ' +
        'It cannot be defaulted, because a guessed version makes a later ' +
        'release-transition comparison wrong rather than absent.',
    );
  }
  return label;
}

/**
 * Report a plan decision that was not `due`.
 *
 * Takes the narrowed `not-due` / `duplicate` shapes rather than the
 * whole `PlanDecision`, so reading `reason` or `nextDueAt` is a
 * compile-time fact about the branch rather than a property access that
 * happens to be present.
 */
function reportNotDue(
  decision: Exclude<PlanDecision, { readonly outcome: 'due' }>,
  program: ReviewProgram,
  out: OutputSink,
): void {
  if (decision.outcome === 'duplicate') {
    out.error(
      `u-sekai: program run: ${program.name} was already planned for this trigger ` +
        `(${decision.planKey}); nothing was charged.`,
    );
    return;
  }
  out.error(`u-sekai: program run: ${program.name} is not due (${decision.reason}).`);
  out.error(`  detail: ${JSON.stringify(decision.detail)}`);
  if (decision.nextDueAt !== undefined) {
    out.error(`  next due: ${decision.nextDueAt}`);
  }
  if (decision.reason === 'no-trigger') {
    out.error(
      '  a manual run needs a `trigger: { manual: true }` block on the program in u-sekai.yml; ' +
        'this surface does not run a program that never asked to be run by hand.',
    );
  }
}

/**
 * Report the run, and classify it.
 *
 * The output leads with what a reader came for — the findings and where
 * the evidence is — and names the artifact directory, rather than
 * echoing internal traces. #63 has already written every record to
 * disk; the terminal is a summary and a pointer, not a second copy.
 */
function reportRunResult(result: EvaluationRunResult, out: OutputSink): ProgramExitCode {
  out.line(`run: ${result.runId}`);
  out.line(`  mode: ${result.mode}`);
  out.line(`  environment: ${result.target.environmentId}`);
  out.line(`  setup: ${result.setup.status}`);
  out.line(`  identities run: ${result.resolvedCohort.members.length}`);
  out.line(`  artifact: ${result.artifactDir}`);

  if (result.setupFailures.length > 0) {
    // Kept visibly separate from findings. A setup failure is a
    // statement about u-sekai's ability to run the evaluation, never
    // about the product.
    out.error(`setup failures: ${result.setupFailures.length}`);
    for (const failure of result.setupFailures) {
      out.error(`  ${failure.id}: [${failure.cause}] ${failure.message}`);
    }
  }

  out.line(`findings: ${result.findings.length}`);
  for (const finding of result.findings) {
    out.line(`  [${finding.severity}] ${finding.title}`);
    out.line(`    ${finding.summary}`);
    out.line(
      `    kind=${finding.kind} confidence=${finding.confidence} ` +
        `identities=${finding.identityIds.join(',')}`,
    );
    for (const ref of finding.evidenceRefs) {
      out.line(`    evidence ${ref.channel}/${ref.stance}: ${ref.locator} — ${ref.summary}`);
    }
  }
  if (result.findings.length === 0) {
    // The wording depends on whether the run actually looked. "No
    // findings" from a run that reached the environment and "no
    // findings" from a run that could not open a page are different
    // facts, and printing the reassuring sentence in both cases is how
    // a broken environment gets reported as a clean bill of health.
    out.line(
      result.setupFailures.length > 0
        ? '  (none — but the run did not reach the product, so this is not a clean result)'
        : '  (no product findings; the run observed the environment)',
    );
  }

  if (result.setupFailures.length > 0) return 4;
  return result.findings.length > 0 ? 5 : 0;
}

/* -------------------------------------------------------------------------- */
/* Failure classification                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A usage mistake in this surface, as distinct from a refusal by a
 * package below it.
 *
 * A distinct type because the diagnostic differs: a usage error names
 * the flag, while a #58 refusal names a line of the file. Collapsing them
 * into "invalid input" is what makes a CLI hard to fix.
 */
export class ProgramUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProgramUsageError';
  }
}

/**
 * Map a thrown value to an exit code.
 *
 * The ordering is the point: a configuration refusal outranks a runtime
 * one, because a run that never got a valid authority file did not
 * "fail at runtime" — it never started. Each branch names the package
 * that refused, so the diagnostic and the code cannot disagree about
 * whose decision this was.
 */
export function classifyFailure(error: unknown): ProgramExitCode {
  if (error instanceof ProgramUsageError) return 1;
  if (error instanceof UseSekaiConfigError) return 1;
  if (isCohortStateError(error)) return 2;
  if (isRuntimeIntegrationError(error)) return 2;
  // #62's planning refusals and the domain's parse errors are both
  // "the request or the file was refused" rather than "the run broke".
  return 1;
}

/** A one-line, secret-free description of a thrown value. */
function describeFailure(error: unknown): string {
  if (error instanceof ProgramUsageError) return `u-sekai: ${error.message}`;
  if (error instanceof UseSekaiConfigError) {
    // #58's message already names the file and the field and never
    // includes a rejected secret value, so it is safe to pass through.
    return `u-sekai: configuration refused: ${error.message}`;
  }
  if (isCohortStateError(error)) return `u-sekai: durable store: ${error.message}`;
  if (isRuntimeIntegrationError(error)) return `u-sekai: runtime: ${error.message}`;
  if (error instanceof Error) return `u-sekai: ${error.name}: ${error.message}`;
  return `u-sekai: ${String(error)}`;
}

/* -------------------------------------------------------------------------- */
/* Small parsing helpers                                                         */
/* -------------------------------------------------------------------------- */

function parsePositiveInt(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ProgramUsageError(`${flag} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function requireProvider(value: string, flag: string): 'scripted' | 'anthropic' {
  if (value === 'scripted' || value === 'anthropic') return value;
  throw new ProgramUsageError(`${flag} must be scripted or anthropic, got "${value}"`);
}

function resolveStateDir(args: ProgramSurfaceArgs): string {
  return path.resolve(process.cwd(), args.flags['state-dir'] ?? '.u-sekai-state');
}
