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

### R-03: How should Synthetic User capability boundaries be enforced at runtime?

- **Question**: Investigate how perception, action, tool availability, and memory can be **actually constrained by the experiment runtime**, rather than simulated primarily through persona / role-play instructions.
- **Motivation**: a capable model cannot reliably become a novice, impaired, or unfamiliar user merely because a prompt asks it to behave like one. u-sekai's core hypothesis is that unavailable capabilities should be made unavailable whenever feasible.
- **Initial scope**:
  - Perception boundaries (visual transformations, information exposure, temporal access)
  - Action boundaries (available input primitives, precision, device-specific operations)
  - Tool topology (different users may receive different tools rather than one universal toolbox)
  - Memory availability / retention boundaries
  - What information privileged browser / automation APIs must withhold from participant agents
- **Initial non-scope**:
  - Locking in a browser driver, computer-use provider, or agent SDK
  - Defining demographic labels as deterministic capability bundles
  - Final implementation API
- **Dependencies**: R-01, R-02.
- **Suggested investigation**:
  - Compare prompt-only simulation with environment-enforced restrictions
  - Catalog which user differences can be represented as real I/O or memory constraints
  - Identify constraints that cannot currently be enforced without unacceptable distortion
  - Investigate how to prevent hidden automation metadata from leaking capabilities to the participant
- **Acceptance criteria**:
  - A capability taxonomy exists
  - Runtime-enforced vs model-mediated boundaries are explicitly separated
  - Known fidelity limitations and leakage risks are documented

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

### R-05: Subjective experience / post-session evaluation design

- **Question**: Investigate how to capture a Synthetic User's **subjective experience** after and during an episode without collapsing UX into task success or a single synthetic score.
- **Motivation**: a participant can complete an interaction while feeling confused, uncertain, frustrated, manipulated, or unwilling to return. Conversely, failure to reach a target state does not fully describe the experience.
- **Initial scope**:
  - Participant self-report after an episode, based on the state / memories the participant actually retained
  - Independent observer evaluation from richer trajectory evidence
  - Behavioral / system telemetry as a separate observation channel
  - Structured and free-form interview approaches
  - Disagreement between participant, observer, and telemetry
- **Initial non-scope**:
  - Treating self-report as ground truth
  - A universal UX score
  - Dependence on a specific LLM / judge model
  - Final release-gate thresholds
- **Dependencies**: R-02, R-11.
- **Suggested investigation**:
  - Survey post-task / post-session UX research methods and LLM-based participant interviewing
  - Compare fixed questionnaires with episode-adaptive follow-up questions
  - Investigate self-report bias when the participant is given full replay versus retained memory only
  - Define evidence that should remain separate instead of normalized into one number
- **Acceptance criteria**:
  - Participant / observer / telemetry channels are clearly distinguished
  - Candidate interview approaches and their bias risks are documented
  - The design preserves meaningful disagreement between evidence channels

### R-06: Open-ended user state / story / population generation

- **Question**: Investigate how to generate diverse Synthetic User **states, situations, histories, capabilities, motivations, and stories** without reducing the population to a fixed persona catalog or scripted task suite.
- **Motivation**: fixed scenarios and static personas create a finite target that a product can overfit to. u-sekai needs fresh interaction conditions that still support meaningful comparison and replay.
- **Initial scope**:
  - User stories as situations / motivations rather than click-by-click procedures
  - Prior knowledge and product familiarity
  - Capability profiles without demographic stereotyping
  - Device / environment / interruption / urgency / preference variation
  - Multiple generation methods (model-based, dataset-based, rule-based, mixed)
  - Sampling diversity and reproducibility
- **Initial non-scope**:
  - A permanent list of canonical personas
  - Giving the participant the intended product workflow
  - Dependence on one model/provider
  - Claiming generated populations represent real-world population frequencies without calibration
- **Dependencies**: R-02, R-03.
- **Suggested investigation**:
  - Compare static persona suites with generated latent user-state approaches
  - Investigate story generation that communicates life context without leaking the product solution
  - Explore ensemble generation across models / datasets / rules
  - Define ways to detect population collapse and repeated scenario patterns
- **Acceptance criteria**:
  - Candidate user-state / story generation methods are compared
  - Diversity, replayability, and overfitting risks are documented
  - The boundary between generated experimental diversity and real-population representativeness is explicit

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

### R-10: Generative benchmark design and resistance to scenario overfitting

- **Question**: How should u-sekai behave as a **generative benchmark / experiment generator** rather than a finite checklist, while still allowing reproducible investigation and baseline-vs-candidate comparison?
- **Motivation**: a fixed benchmark eventually becomes a training target. Exploratory UX evaluation needs continuing exposure to unseen combinations and behaviors.
- **Initial scope**:
  - Fresh episode generation
  - Seed / provenance recording
  - Comparable populations for baseline / candidate experiments
  - Holdout / novel / adversarial generation strategies
  - Benchmark drift and versioning
  - Replay of interesting episodes without turning replay cases into the whole benchmark
- **Initial non-scope**:
  - Final scoring formula
  - Release-gate policy
  - Claiming exhaustive user coverage
- **Dependencies**: R-02, R-03, R-05, R-06, R-07.
- **Suggested investigation**:
  - Survey generative / procedural benchmark design
  - Compare strict paired seeds with distribution-level comparison
  - Investigate mechanisms for generating conditions dissimilar to prior runs
  - Define benchmark provenance required to reproduce a finding
- **Acceptance criteria**:
  - A benchmark-generation model is described
  - Reproducibility and anti-overfitting mechanisms are compared
  - Remaining ways the product could overfit to u-sekai itself are documented

### R-11: Mental models, forgetting, and evolving cognitive state

- **Question**: How should a participant's beliefs, misconceptions, retained memory, attention, confidence, urgency, and preferences evolve during an episode without relying on one unlimited conversation transcript?
- **Motivation**: a model that always receives complete history and can immediately reconstruct the correct product model is unlike an unfamiliar human user. Incorrect beliefs and forgetting must be able to persist and influence behavior.
- **Initial scope**:
  - Explicit participant belief / mental-model state
  - Retention, omission, decay, distortion, and reinforcement of memory
  - Runtime-controlled context injection
  - Interruption and changing situation / motivation
  - Keeping capability constraints separate from mental / preference state
- **Initial non-scope**:
  - Direct modification of proprietary model hidden reasoning
  - Treating private chain-of-thought as a required artifact
  - Final memory implementation
- **Dependencies**: R-02, R-03.
- **Suggested investigation**:
  - Compare long-context transcript approaches with explicit bounded state
  - Investigate whether structured beliefs improve persistence of misconceptions
  - Explore how post-session interviews change when only retained memory is available
  - Identify which cognitive-state manipulations create useful simulation versus artificial behavior
- **Acceptance criteria**:
  - Capability, memory, belief, and preference are conceptually separated
  - Candidate mechanisms for bounded / evolving state are compared
  - Known validity risks are documented

---

## Next steps

1. Open the above R-01 to R-11 as individual GitHub Issues using `research-question.md` (and `investigation.md` where appropriate).
2. Declare dependencies in the GitHub Issue dependency graph.
3. Refine drafts as discussion progresses.
4. Revisit the set for missing / duplicate / merge / removal.