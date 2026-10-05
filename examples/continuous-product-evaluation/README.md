# Continuous Product Evaluation — the 0.4.0 acceptance example

This is the example ADR-0011 asks for: **a persistent cohort experiences an
earlier version of a product and then a newer one**, so changes in
behaviour, memory, confidence and mental model can be observed. It is the
runnable companion to the browser-backed acceptance test in
[`test/e2e/service-acceptance/persistent-cohort-release.browser-acceptance.ts`](../../test/e2e/service-acceptance/persistent-cohort-release.browser-acceptance.ts)
— both drive the same function, so "the example runs" and "the acceptance
scenario passes" are the same claim rather than two similar ones.

## Run it

From a fresh clone:

```bash
npm ci
npx playwright install chromium
node --import tsx examples/continuous-product-evaluation/run-acceptance.ts
```

The command starts two live deployments of one declared environment, drives a
real Chromium against each, promotes the returning cohort from version A to
version B, prints what it observed, and exits `0` only when every stage
reported what it claims. A stage that observed nothing is a non-zero exit, not
a quiet success. The report it prints looks like this:

```text
u-sekai 0.4.0 acceptance example - Continuous Product Evaluation

Simulated, not human. See docs/non-reality.md and .../README.md.

  [ok]   two live instances of one declared environment
         staging at 2026.10.1, staging at 2026.10.2
  [ok]   one cohort holding an ephemeral and a persistent identity
         lifecycles: ephemeral, persistent
  [ok]   only the persistent identity retained state
         persistent interactions: 1; ephemeral retained state: none
  [ok]   accounts provisioned through the World Operator and released at cleanup
         setup=provisioned, cleanup=cleaned
  [ok]   the cohort created a task in version A, through a real browser
         version A lists 3 task(s)
  [ok]   the A -> B promotion committed durably and moved the pointer
         pointer now on version 2026.10.2; re-applying is a no-op
  [ok]   the earlier version survived the promotion
         version A still lists 3 task(s)
  [ok]   the two environments share no mutable state
         version A lists [Find the help page, Draft the release checklist, Renew the passport before June], version B lists [Re-issue the parking permit]
  [ok]   the same Synthetic Identity spans both versions
         idn-returning-leo observed 2026.10.1 then 2026.10.2
  [ok]   the comparison run produced an evidence-backed longitudinal finding
         1 finding(s)
```

The whole gate, including the control cases that prove the scenario can
detect a real defect:

```bash
npm run build
npx vitest run --config test/vitest.browser.config.ts
```

### Why the example delegates instead of running the scenario in-process

The scenario drives a real Chromium through `PlaywrightAdapter`, which reads
the page with `page.evaluate`. `tsx` transpiles with esbuild's `keepNames:
true` — hard-coded, with no opt-out — which rewrites every named function to
call an injected `__name` helper. `page.evaluate` serialises the function
*source* into the page, where `__name` does not exist, so the first
observation fails with `ReferenceError: __name is not defined`. The example
therefore delegates to the browser profile (Vite's transform, which does not
inject `__name`) and relays its result, rather than documenting a command that
cannot work.

This is a real constraint on 0.4.0, not a quirk of this example: **any**
Node-hosted TypeScript runner that applies esbuild `keepNames` — `tsx` among
them — cannot drive `PlaywrightAdapter` in this release. The repo's own
`npm run demo:server` (`node --import tsx ./src/demo/environment/server.ts`) is
unaffected only because it never evaluates a function in a page.

On a host without Chromium's shared libraries on the default search path
(WSL2, a slim container), export the library path first or the browser will
not launch:

```bash
export LD_LIBRARY_PATH=/home/basic/chrome-libs/usr/lib/x86_64-linux-gnu
```

There is **no external API key**: every reasoning decision is taken by a local
deterministic double, so the example runs in CI with no provider account and no
network egress. The environment under evaluation is an in-repo HTTP
application, started on an ephemeral port.

## What is simulated

Everything the Synthetic Users do, and nothing about real people.

| Simulated here | Not simulated |
| --- | --- |
| The environment: an in-repo task-tracker application, served twice from two independent processes. | Any real product, customer, deployment or traffic. |
| The Synthetic Users: capability-constrained agents whose memory is bounded by the capability model (ADR-0006). | Human users, human sessions, or any human population statistic. |
| The Reasoner: a local, deterministic double that takes its self-report from the cohort's own durable record. | A foundation model. No provider is contacted, and no key is read. |
| The customer decision: one `accepted` disposition recorded by a named workspace, so the KPI primitives have a decision to count. | A real review board, a real triage queue, or a real customer. |
| The privileged world setup: a scripted provisioning connector behind #59's authority gate. | Real accounts, real money, real inboxes. Real-money authority stays `denied`. |

**A large or persistent Synthetic Cohort is not automatically representative of
a human population.** The non-reality boundary is unchanged by this example, and
it is not a disclaimer bolted on afterwards: the retained-history behaviour the
scenario demonstrates is a property of the simulated identities and says nothing
about how people use software. See [`docs/non-reality.md`](../../docs/non-reality.md).

## What the run demonstrates

```text
environment "staging" @ 2026.10.1  (live for the whole comparison)
        |
        +-- cohort: one ephemeral + one persistent identity, browser-driven
        +-- cohort: one returning identity, browser-driven      -> baseline run
        |
   A -> B promotion, recorded durably, idempotent
        |
environment "staging" @ 2026.10.2  (a separate, simultaneously live process)
        |
        +-- the same returning identity, browser-driven         -> comparison run
```

1. **Two versions of one environment are live at once.** Two independently
   started instances share a declared environment name and differ only in
   version. The promotion moves a pointer between them; it does not overwrite
   either, so the earlier version survives as a baseline.
2. **One ephemeral and one persistent cohort coexist.** They are members of the
   same cohort in the same run, and the run shows the difference in what they
   keep: the persistent identity carries its interaction count forward, the
   ephemeral one retains nothing.
3. **Accounts are provisioned through the World Operator, never around it.**
   Setup and cleanup both go through #59's authority gate, and the audit names
   the product, program, cohort, environment and run responsible.
4. **The returning cohort's finding is evidence-backed.** Its self-report
   follows from the cohort's own durable record — the task it created at version
   A is not in version B's list — and the finding cites evidence handles that
   resolve to files in the run's artifact.
5. **A customer disposition moves the KPIs without touching the finding.** The
   finding is compared byte for byte before and after the decision is recorded;
   the disposition is a reference to it, never a copy.

## What this example does not claim

Stated here rather than left for a reader to infer:

- **`RunLineage` carries no version identity** (Issue #83). No record on a
  finding can demonstrate that a *version* boundary was crossed. The
  environment boundary is observable on the lineage; the version boundary is
  observable on the durable cohort state and in the transition journal. The
  example asserts each of those separately and does not conflate them.
- **The two deployments differ in world state, not in rendered behaviour.** Both
  serve the same demo application. What the returning cohort observes is a
  genuinely separate deployment that does not carry its earlier task forward —
  a real difference, but a narrower one than a UI redesign would be.
- **The participant's Reasoner cannot read the page text.** The participant's
  current-step prompt carries `url` and `title`, not the rendered page. The
  self-report therefore follows from the cohort's durable record, and the
  page-level A-versus-B difference is asserted directly against the two live
  instances over HTTP.
- **The change verdict is `unknown`, not `introduced`.** The version-A run
  produced no finding, so there was nothing for the join to compare against,
  and #61's own rule is that anything short of a real join is `unknown`
  ("we did not compare") rather than a guess. Asserting `introduced` would be
  a claim the evidence does not support. `control-cases.browser-acceptance.ts`
  pins what a non-empty baseline would have produced, so the `unknown` is
  demonstrably a property of this baseline and not of a constant verdict.
- **Concurrency is out of scope.** `openTransition` / `closeTransition` are not
  guarded against a concurrent run of the same `release` identity (Issue #103),
  so the "same identity spanned A and B" claim is about a sequential execution.
- **The example is a fixture, not a benchmark.** It is deterministic on purpose:
  a scenario that reads well on a fast machine and fails on a slow one trains
  reviewers to re-run instead of read.

## Layout

| Path | What it is |
| --- | --- |
| `run-acceptance.ts` | The CLI entry point documented above. A thin shell over the shared scenario. |
| `environment/` | Versioned environments and A→B transitions (Issue #69). Not owned by this example. |
| `test/fixtures/service-acceptance/` | The scenario, its durable declarations, the Reasoner double, the harness and the disposition/KPI helpers. |
| `test/e2e/service-acceptance/persistent-cohort-release.browser-acceptance.ts` | The acceptance criteria, one named test each. |
| `test/e2e/service-acceptance/control-cases.browser-acceptance.ts` | The cases that prove the scenario can detect a real defect. |
| `test/e2e/service-acceptance/routing/` | The Issue #70 guard that routes `.browser-acceptance.ts` into this profile and keeps `npm run ci` browser-free. Not owned by this example. |
