# ADR-0011: Environment-centric Continuous Product Evaluation

- Status: Accepted
- Date: 2026-10-01
- Decision owner: u-sekai project
- Target release: 0.4.0

## Context

u-sekai began as research infrastructure for capability-constrained Synthetic Users exploring a digital environment. The runtime, observer separation, evidence recording, and browser adapter establish useful primitives, but the commercial review target must not be reduced to a pull request or to the surface changed by one commit.

Real product problems exist in the deployed environment regardless of whether the relevant code changed recently. They can also emerge from data, time, state, dependency changes, interactions between features, or a user's prior experience.

A release transition is itself an important experimental condition: a returning user may react differently from a fresh user because their memory, habits, expectations, and stored data were formed under an earlier product version.

The product therefore needs a durable identity above an individual experiment or source change.

## Decision

u-sekai's primary product boundary is **Continuous Product Evaluation of deployable product environments over time**.

The review target is an environment that can actually be used. Pull requests, commits, deployment events, release identifiers, and source diffs may be useful triggers and explanatory metadata, but they are not the canonical review target.

The initial durable service model contains these identities:

- **Product** — the customer-owned product being evaluated.
- **Environment** — a reachable deployable instance such as develop, pre-release, staging, production-like, or explicitly authorized production.
- **Synthetic Identity** — a durable simulated user identity with bounded capabilities and retained state.
- **Synthetic Cohort** — a managed population of Synthetic Identities selected for an evaluation program.
- **World State** — product-side state required to place identities in meaningful conditions, such as accounts, seeded data, subscription state, or inbox state.
- **Review Program** — a durable policy that determines where, when, and under which conditions evaluation runs.
- **Evaluation Run** — one execution instance that produces evidence. Runs are observations of the durable model, not the durable model itself.

u-sekai must support three evaluation modes without redefining the domain:

1. **Continuous evaluation** — repeated exploration of an environment on a cadence or event trigger, including unchanged surfaces.
2. **Release-transition evaluation** — a persistent cohort experiences an earlier version and then a newer version so changes in behavior, memory, confidence, and mental model can be observed.
3. **Point-in-time evaluation** — an explicit evaluation of a particular environment state when continuous history is not required.

## Managed-service boundary

The commercial product is a managed evaluation service.

Customers buy evaluation outcomes and evidence. They are not required to select model providers, operate a browser fleet, or pay model/browser providers separately for the normal service path.

Model choice, execution backends, browser capacity, evidence processing, and cost optimization remain internal implementation choices unless an enterprise deployment explicitly negotiates otherwise.

Provider neutrality remains a design requirement: the durable domain must not encode one model vendor, browser provider, CI system, Git host, or deployment platform.

## Authority model

Synthetic Participants must not receive privileged setup powers merely because the service needs them.

A separate **World Operator** boundary may receive narrowly scoped capabilities for setup and cleanup, including:

- creating test accounts,
- seeding product data,
- establishing subscription or entitlement state,
- reading a test inbox,
- resetting an environment-owned fixture,
- using explicitly configured sandbox payment facilities.

Those capabilities do not become Participant capabilities.

The repository-controlled configuration declares what the service is allowed to do. Agent autonomy is bounded by that declaration.

Real-money transactions, destructive production mutation, irreversible actions, external communications, or use of real identities require explicit opt-in, narrow scope, and an enforceable budget/authority boundary. A model deciding that an action would be useful does not create permission to perform it.

## Configuration

A future `u-sekai.yml` is the declarative customer-controlled configuration surface for:

- products and environments,
- permitted domains/endpoints,
- review programs and triggers,
- cohort declarations,
- provisioning connectors,
- test inbox and billing sandbox capabilities,
- secret references,
- budget and action limits.

Secret values are not committed to that file. The file stores only references to an approved secret authority.

Configuration describes authority and intent. Runtime state, credentials, evidence, mutable user state, and billing records are not canonicalized into the repository file.

## Evidence and non-reality

This decision does not change the project's non-reality boundary.

Synthetic Users remain exploratory instruments. A large or persistent Synthetic Cohort is not automatically representative of a human population.

u-sekai may earn trust by calibration, reproducibility, longitudinal evidence, and correlation with human decisions or production outcomes. It must not claim human representativeness merely from simulated population size.

## Consequences

### Positive

- Evaluation can find persistent product problems that are unrelated to the latest source change.
- Returning-user and upgrade behavior become first-class evaluation subjects.
- The service can attach to develop/pre-release/staging/production-like environments without adopting the customer's branch model.
- Account, data, and billing setup can be automated without contaminating Participant capabilities.
- Managed execution creates a clear commercial unit and allows u-sekai to optimize model/browser costs internally.
- Longitudinal evidence can become a defensible dataset and calibration asset.

### Costs and risks

- Persistent identities and world state require durable storage and lifecycle semantics.
- Long-running review programs create cost-control and scheduling requirements.
- Production access increases security, privacy, and authority risk.
- Cross-release comparisons require careful identity, environment, and evidence lineage.
- A service that reports low-value opinions rather than evidence-backed findings will not justify its inference cost.

## Implementation direction

0.4.0 should build the first usable vertical slice around this decision. Implementation tickets should own disjoint mutable file areas where practical and converge through an explicit integration ticket rather than having every ticket modify shared entry points.

The business/product strategy, ubiquitous evaluation model, KPI definitions, and configuration/authority contract are documented under `docs/product/`.
