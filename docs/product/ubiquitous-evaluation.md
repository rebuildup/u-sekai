# Ubiquitous Evaluation

## Definition

“Ubiquitous evaluation” means that product evaluation is attached to the **product lifecycle and reachable environments**, rather than invoked only when a particular source-code artifact changes.

u-sekai should be able to remain present around a product for weeks or months through durable Review Programs and Synthetic Cohorts.

This does not mean continuously burning model/browser compute. It means the service has enough persistent state and scheduling context to evaluate the product whenever a relevant cadence, deployment, transition, or explicit request occurs.

## Core invariant

> A surface is not safe merely because it was not changed in the latest pull request.

Source diffs can help prioritize exploration or explain a finding. They must not define the entire observable product boundary.

The canonical target is a reachable Environment.

## Environment classes

A Product may expose one or more environments:

- **develop** — rapidly changing integration environment,
- **pre-release/staging** — candidate state intended for broader validation,
- **production-like** — controlled environment with production-shaped behavior and safe test data,
- **production** — real released product, only when the configured authority and privacy/safety model explicitly allows it.

Environment names are customer-defined identifiers. u-sekai must not encode a required Git branch topology.

## Evaluation modes

### Continuous evaluation

A Review Program revisits an environment on a cadence or trigger.

Examples:

- daily exploration of a staging environment,
- evaluation after each successful deployment,
- nightly broader exploration with cheaper scouting runs and selective deep verification.

The program may revisit unchanged areas because the relevant state or interaction context may have changed.

### Release-transition evaluation

The same Synthetic Identity or Cohort experiences multiple product versions.

```text
Environment/version A
        ↓
interaction + retained state
        ↓
release/promotion
        ↓
Environment/version B
        ↓
returning-user interaction
        ↓
change in behavior / belief / confidence / outcome
```

This is not equivalent to running two fresh agents independently. The retained history is part of the experimental condition.

### Point-in-time evaluation

A bounded run inspects one environment state without requiring prior history. This remains useful for initial onboarding, incident investigation, external demonstrations, and products that cannot support persistent test identities.

## Durable state

Ubiquitous evaluation requires durable identities above an Evaluation Run:

- Product
- Environment
- Synthetic Identity
- Synthetic Cohort
- Review Program
- World State references
- evaluation history and evidence lineage

A run can fail, be retried, or be replaced without silently changing those durable identities.

## Synthetic Identity lifecycle

A persistent Synthetic Identity may retain:

- product account identity,
- allowed product-side data,
- experiment-controlled memory,
- learned interface expectations,
- relevant mental-state history,
- previous findings/episodes through an explicitly defined memory boundary.

A persistent identity must not receive a perfect historical transcript by default. The existing capability/memory model remains responsible for what the Reasoner can actually retain.

Lifecycle policies include:

- `ephemeral` — reset after each evaluation,
- `release` — survive through one defined release transition,
- `persistent` — survive repeated Review Program executions until retired.

## Exploration policy

The service should distinguish **where to spend compute** from **what counts as reviewable**.

A source diff, deployment manifest, changed route list, telemetry anomaly, or prior finding may increase exploration priority. It must not automatically exclude the rest of the environment.

A cost-aware execution plan can use staged exploration:

```text
broad cheap scouts
       ↓
novel / suspicious behavior
       ↓
focused reproduction
       ↓
strong independent verification
       ↓
finding
```

The customer sees the finding and evidence, not the internal provider routing.

## Longitudinal findings

Some findings exist only over time:

- a learned control moves and returning users continue looking in the old location,
- a workflow remains technically possible but confidence erodes over several sessions,
- a user accumulates data until an interface becomes unusable,
- a feature introduced in one release changes interpretation of an older feature,
- repeated interruptions or failures alter trust and subsequent behavior.

The evidence model should preserve the version/environment/run lineage needed to distinguish these from one-session observations.

## Triggers

A Review Program may eventually support:

- fixed cadence,
- deployment/promotion event,
- version/release event,
- provider callback,
- manual invocation,
- production signal/anomaly.

Triggers schedule evaluation; they do not replace the Environment as the review target.

## Safety by environment

Authority should become stricter as the environment becomes more consequential.

A production-like test environment may allow fixture creation and sandbox billing. A real production environment may be read/explore-only by default and deny account creation, payments, destructive actions, or external communications unless each capability is explicitly enabled.

The service must fail closed when requested setup or Participant behavior exceeds configured authority.

## Success condition

Ubiquitous evaluation is working when a team can keep a Review Program enabled across multiple releases and receive useful evidence about:

- persistent problems,
- newly introduced problems,
- resolved problems,
- returning-user adaptation,
- behavior that changed even when task completion did not,
- issues outside the latest source diff.

It is not measured by keeping agents continuously running.
