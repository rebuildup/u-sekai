# Research Issues (draft)

> **Note**: this is a **draft set of initial research targets** for the research / design phase.
> The questions listed here are **not** a fixed specification; they will be added to, merged, split, or removed as discussion progresses.
> Individual items are intended to be opened as GitHub Issues over time.

## How to use these drafts

1. Before opening an Issue, search the existing drafts in `docs/research-issues/` and open Issues to avoid duplicates.
2. Each draft is framed as a **question**, not a planned solution. The primary work is **refining the question**, not filling in the answer.
3. When an item's conclusion is finalized, close the corresponding Issue and reflect it in docs (or promote to an ADR in `docs/adr/` when the decision is long-lived).
4. Split / merge / delete drafts freely as the discussion evolves.

## Initial draft set

### R-01: Survey of existing browser / computer-use agent environments

- **Question**: Survey the existing browser-automation agent / computer-use agent ecosystems (OSS / SaaS / papers) to identify what u-sekai can reuse and what it must build.
- **Motivation**: avoid reinventing the wheel and clarify which **layer** u-sekai adds value on top of.
- **Initial scope**: public OSS, public papers, official docs, major SaaS capability comparisons. Private / non-public systems are out of scope.
- **Initial non-scope**: final adopt / not-adopt decision.
- **Dependencies**: none.
- **Suggested investigation**:
  - Build a capability comparison table of public OSS repositories
  - Build a capability comparison table from official docs / public papers
  - Identify what is **missing** from the Synthetic User perspective
- **Acceptance criteria**:
  - Capability comparison table is captured in docs
  - Differences vs u-sekai's requirements are made explicit

### R-02: Survey of existing research / benchmarks on synthetic user simulation

- **Question**: Survey the research area / benchmarks / datasets called "Synthetic User", "User Simulation", "Simulated User", "Persona Simulation", etc., to extract reusable insights, evaluation metrics, and pitfalls.
- **Motivation**: ignoring prior work risks repeating the same failures or failing to beat existing evaluation metrics.
- **Initial scope**: public research literature, benchmarks, public datasets. Both English and Japanese sources.
- **Initial non-scope**: lock-in to a specific model or SaaS. Implementation adoption decisions.
- **Dependencies**: none.
- **Suggested investigation**:
  - Literature search around "Synthetic User" / "User Simulation" / "Persona Simulation" / "Web Agent" / "Computer-Use Agent"
  - Catalog existing benchmarks by task type, evaluation method, and synthetic-vs-real calibration
  - Identify what is **missing or reusable** for u-sekai
- **Acceptance criteria**:
  - A references / benchmark list exists in docs
  - Evaluation metrics, calibration methods, and pitfalls are summarized

### R-03: How far can Synthetic User capability limits be reproduced at the runtime layer?

- **Question**: Inventory how the dimensions of individual difference (capability, perception, operating environment, memory, preference, situation) can be modeled / reproduced at u-sekai's runtime or agent layer.
- **Motivation**: reproducing individual difference is the core value of u-sekai. Without a clear boundary, implementation explodes.
- **Initial scope**:
  - What granularity of individual difference to model (e.g. visually impaired / elderly / novice / general user)
  - What to reproduce at runtime vs via prompt / profile alone
- **Initial non-scope**: dependence on a specific model; locking in specific UI operations.
- **Dependencies**: R-01, R-02.
- **Suggested investigation**:
  - Catalog how existing research / OSS reproduce individual difference
  - Classify required information sources (accessibility profile, cognitive profile, demographic profile, preference profile)
  - Trade off runtime reproduction cost / complexity against fidelity
- **Acceptance criteria**:
  - The runtime-reproduce / prompt-reproduce / give-up boundaries are documented

### R-04: Comparison of isolated execution environments

- **Question**: Compare isolated execution environment options (browser, desktop, VM, container, provider-managed sandbox) for running Synthetic User agents independently.
- **Motivation**: environment choice directly affects cost, reproducibility, safety, and portability for "run many Synthetic Users in parallel".
- **Initial scope**:
  - Both local and remote options
  - Browser isolation for the initial Web target (headless / existing browser / dedicated browser, etc.)
  - Future-proofing for desktop / mobile / CLI / API isolation
- **Initial non-scope**: vendor lock-in; final adoption decision.
- **Dependencies**: R-01.
- **Suggested investigation**:
  - Compare local and remote options across capability / cost / reproducibility / safety
  - Evaluate each option against the "many Synthetic Users in parallel" requirement
  - Compare browser isolation approaches
- **Acceptance criteria**:
  - Environment option comparison table exists in docs
  - Recommended candidate set (not yet adopted) is documented

### R-05: Subjective evaluation / post-session feedback design

- **Question**: Design how a Synthetic User **reports subjective experience** (rating, free-form reflection, behavioral log, etc.). Compare candidate approaches.
- **Motivation**: half of u-sekai's value is making subjective UX visible. Without a workable design, u-sekai has no reason to exist.
- **Initial scope**:
  - Timing of subjective evaluation (per-action / per-task / per-session / per-condition)
  - Format (numeric rating, Likert, free-form, behavioral log, emotion tags, etc.)
  - Balancing comparability with reproducibility
- **Initial non-scope**: dependence on a specific LLM / model. Final UI decision.
- **Dependencies**: R-02.
- **Suggested investigation**:
  - Survey subjective evaluation methods in UX research / HCI / user simulation
  - Compare LLM-as-judge / structured output / free-form reflection
  - Trade off reproducibility, comparability, and analyzability
- **Acceptance criteria**:
  - A subjective evaluation option comparison table exists in docs
  - A recommended candidate set (not yet adopted) is documented

### R-06: User story / user population generation

- **Question**: Investigate how to **generate and sample** diverse Synthetic User personas, tasks, situations, and preferences.
- **Motivation**: Synthetic User "diversity" is the core value. A biased sampling undermines u-sekai's exploratory value.
- **Initial scope**:
  - Persona generation (rule-based / LLM-based / dataset-based)
  - Task generation (seed / automated / human-authored)
  - Situation generation (context / environment / device / network / time of day)
- **Initial non-scope**: dependence on a specific model or SaaS. Final UI decision.
- **Dependencies**: R-02, R-03.
- **Suggested investigation**:
  - Compare persona generation / sampling methods (option-based / LLM-based / dataset-based)
  - Trade off diversity against reproducibility / comparability
  - Analyze what populations existing benchmarks / datasets assume
- **Acceptance criteria**:
  - A comparison table of persona / task / situation generation options exists in docs
  - Diversity metrics / bias detection options are documented

### R-07: Calibrating / validating Synthetic Users against real users

- **Question**: Investigate how to **calibrate and validate** that Synthetic Users are acceptable proxies for real users, and how to make the boundaries of validity explicit.
- **Motivation**: if u-sekai's outputs are dismissed as "synthetic", it has no reason to exist. The boundary of validity must be explicit.
- **Initial scope**:
  - Calibration methods (comparison with real user data, comparison with known metrics, statistical alignment of behavioral logs)
  - Choice of calibration target (success rate, time-on-task, subjective rating, failure patterns)
  - How to communicate "what Synthetic Users cannot validate"
- **Initial non-scope**: automating calibration / CI. Final UI.
- **Dependencies**: R-02, R-05, R-06.
- **Suggested investigation**:
  - Survey Synthetic-vs-Real calibration methods in prior work
  - Catalog what metrics to calibrate against
  - Distinguish what u-sekai can calibrate from what it cannot
- **Acceptance criteria**:
  - Calibration options / metrics comparison table exists in docs
  - The "what Synthetic cannot validate" boundary is documented

### R-08: MVP scope definition

- **Question**: Given R-01 to R-07, define what the **first MVP** of u-sekai must achieve — and what it must explicitly defer.
- **Motivation**: aiming for "everything" at implementation time causes collapse. An explicit MVP creates a feedback loop from investigation → design → implementation → evaluation.
- **Initial scope**:
  - Initial Synthetic User capability range
  - Initial Web target scope (how many sites, what kinds)
  - Initial evaluation metric range
  - Initial release acceptance criteria
- **Initial non-scope**: final architecture / language / framework decision. (Pre-requisites needed for the MVP scope will be handled by separate Issues.)
- **Dependencies**: R-01, R-02, R-03, R-04, R-05, R-06, R-07 (effectively depends on all of the above).
- **Suggested investigation**:
  - Use R-01 to R-07 results to define the **smallest slice** that produces a measurable u-sekai result
  - Define MVP acceptance criteria from the perspective of "can we measure u-sekai's value?"
- **Acceptance criteria**:
  - MVP capability range / target range / evaluation metric / acceptance criteria are documented

### R-09: Translate upstream Skills into English (and the future language policy)

- **Question**: Decide whether / how to translate the 14 Skills under `.claude/skills/` (currently Japanese, copied verbatim from the pinned `rebuildup/project-init@release-0-1-1` source) into English, and how to keep them in sync with future upstream revisions.
- **Motivation**: u-sekai is internationally oriented (Product Hunt and similar channels). The rest of the repository's user-facing and internal docs are written in English; only the Skills remain in Japanese because translating them risks semantic drift relative to the pinned reference. A clear translation policy (and a sync protocol) is needed before international contributors engage.
- **Initial scope**:
  - Whether to translate the Skills (full / partial / by Skill)
  - Where to keep the translation (`.claude/skills/<name>/SKILL.md` itself vs. parallel `SKILL.en.md` vs. separate `skills-en/` directory)
  - Reconciliation protocol when the pinned upstream source updates a Skill
  - Translation process (manual PR / machine-translation with human review / coordinated upstream PR)
- **Initial non-scope**: re-organizing or rewriting Skill content. Translation must preserve operational semantics.
- **Dependencies**: none (independent of R-01 to R-08).
- **Suggested investigation**:
  - Inventory which Skills are most likely to be read by international contributors in the current phase
  - Compare `bunx skills add rebuildup/project-init` versus local copy from `.tmp/project-init/skills/` and assess which path better supports translation
  - Decide on a "drift budget": if upstream changes a translated Skill, do we re-translate immediately, queue, or accept temporary divergence?
- **Acceptance criteria**:
  - Translation decision recorded (translate / not translate / partial)
  - If translation is chosen: location convention, process, and reconciliation protocol documented
  - Follow-up Issue(s) opened if translation begins

---

## Next steps

1. Open the above R-01 to R-09 as individual GitHub Issues using `research-question.md` (and `investigation.md` where appropriate).
2. Declare dependencies in the GitHub Issue dependency graph.
3. Refine drafts as discussion progresses.
4. Revisit the set for missing / duplicate / merge / removal.