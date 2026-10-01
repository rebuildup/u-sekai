# Business Context

## Product position

u-sekai is a **managed Continuous Product Evaluation service**.

A customer connects a deployable product environment and declares the authority that u-sekai may exercise. u-sekai operates the models, browser execution, Synthetic Cohorts, evidence pipeline, and evaluation infrastructure required to use that product repeatedly and report evidence-backed findings.

The customer buys evaluation outcomes. They do not need to buy model tokens, choose a reasoner vendor, provision a browser fleet, or understand the internal Synthetic User runtime for the normal service path.

A concise product promise is:

> Keep an independent synthetic customer population living with the product, so meaningful problems and experience changes can be found before or alongside real users.

## Problem

Agentic software development increases the volume and frequency of product changes. Existing verification layers cover important but different questions:

- static and code review inspect source changes,
- deterministic tests verify known expectations,
- monitoring observes production systems and real traffic,
- human UX research provides high-value human evidence but is too expensive and slow to run continuously across every environment and release condition.

A product can still contain a meaningful usability or behavioral problem when the relevant source file did not change in the latest pull request. Problems can emerge from product state, data, time, dependencies, interactions between features, accumulated user history, or a release that invalidates an existing mental model.

u-sekai therefore evaluates **the product environment**, not merely the latest diff.

## Initial customer

The initial wedge is software teams that:

- ship interactive digital products frequently,
- already maintain a usable staging, pre-release, or production-like environment,
- increasingly use coding agents or high-throughput development workflows,
- value human UX/design judgment but cannot economically run human research for every product state,
- can act on concrete findings when evidence is attached.

The service should be useful to a small product team before it is useful to a model provider.

Large coding-agent, cloud, browser, QA, and developer-platform providers are a later distribution and integration target. The provider value proposition is not “buy a Synthetic User tool”; it is “add an independent product-level evaluation layer after software has become runnable.”

## Commercial unit

The commercial unit is a **Review Program attached to a Product/Environment**, not a token bundle and not a pull request.

A Review Program can run:

- on a cadence,
- after a deployment or release event,
- as a release-transition comparison,
- on demand,
- or under a provider/API integration.

The long-term service can support subscription tiers plus usage or capacity limits, but pricing is intentionally not fixed by this document. Pricing should be derived from demonstrated customer value and measured unit economics rather than from raw model cost.

## What customers receive

The primary output is a small set of evidence-backed findings and longitudinal signals, for example:

- a returning cohort can no longer locate a workflow learned in the previous release,
- first-time users repeatedly form the same incorrect mental model,
- a behavior appears only under a specific device/capability condition,
- a previously stable path becomes less discoverable after a release,
- confidence or trust falls even though task completion remains unchanged,
- a problem persists across releases despite unrelated source changes.

Each finding should be traceable to reproducible evidence such as observations, screenshots, actions, state transitions, self-report, observer analysis, and comparison context.

u-sekai should avoid producing large volumes of low-value generic UX commentary. A short review with one actionable finding is more valuable than a long report of ungrounded opinions.

## Relationship to human research and design

u-sekai does not compete by claiming that a Synthetic User has better taste than a UX designer or that a simulated cohort represents real people.

Human designers and researchers remain appropriate for judgment, discovery, qualitative depth, and decisions requiring real-human evidence.

u-sekai's economic advantage comes from repetition, breadth, persistence, and automation:

- run many explorations when human sessions would be uneconomic,
- revisit the same product continuously,
- preserve synthetic identity and history across releases,
- reproduce findings,
- compare environments and versions,
- provide evidence before a human reviewer spends attention.

The product is successful when it makes human attention more effective, not when it manufactures agreement with an AI opinion.

## Business flywheel

The intended compounding loop is:

```text
more active products
      ↓
more evaluation runs and longitudinal histories
      ↓
more findings + customer disposition
      ↓
better calibration of useful vs. useless synthetic evidence
      ↓
better planning, model routing, and evaluation protocols
      ↓
higher value at lower cost
      ↓
more active products
```

The defensible asset is therefore not only the open-source runtime. It is the combination of:

- longitudinal product/evaluation evidence,
- finding disposition and calibration data,
- reproducible protocols,
- integrations into product delivery,
- cost-efficient execution,
- trust earned from repeated useful findings.

## Provider neutrality

u-sekai should benefit from competition among model and execution providers.

The durable product model must not depend on one model vendor, browser provider, CI system, Git host, or cloud. Internally, the service may route different phases to different models or execution backends based on cost and quality.

A major provider integrating u-sekai should be able to treat it as an external product-evaluation API. The same service should remain useful to competing providers.

## Economic thesis

For the service to create a sustainable return, three things must become true in measured data:

1. **Recurring value** — teams keep Review Programs enabled because findings continue to influence product decisions.
2. **Evaluation quality** — evidence-backed findings are accepted often enough, and false positives are low enough, that the service earns attention rather than consuming it.
3. **Improving unit economics** — routing, reuse, early stopping, caching, and selective escalation reduce the cost of obtaining an accepted finding as scale grows.

If those conditions do not hold, additional browser scale or model sophistication does not rescue the business.

## Initial go-to-market evidence

Before broad self-service launch, design-partner use should establish:

- how quickly a product can be connected,
- whether useful findings appear without bespoke prompt engineering,
- which findings teams actually fix or investigate,
- which findings were not already covered by deterministic tests or known issues,
- the cost and elapsed time required to obtain those findings,
- whether customers keep the service enabled across multiple releases.

The first proof is not GitHub stars or Synthetic User run count. It is repeated customer action caused by credible evidence.

## Non-goals

- Selling raw LLM/browser usage.
- Requiring customers to operate the normal inference/browser stack.
- Replacing deterministic testing.
- Claiming Synthetic Cohorts are representative human samples.
- Restricting evaluation to pull requests.
- Becoming dependent on one coding-agent provider.
