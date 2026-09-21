# R-02: Survey of existing research / benchmarks on synthetic user simulation

## Question (verbatim from the draft)

Survey the research area / benchmarks / datasets called "Synthetic User", "User
Simulation", "Simulated User", "Persona Simulation", "Web Agent",
"Computer-Use Agent" to extract reusable insights, evaluation metrics, and
pitfalls.

---

## 1. Investigation summary

This document is a survey intended to inform subsequent research Issues
(R-03 individual-difference modeling, R-05 subjective evaluation, R-06 persona
generation, R-07 calibration) and the eventual MVP scope (R-08). It does not
recommend any technology as adopted and does not record any architecture /
language / framework decision. Where candidate sets appear, they are
candidates only.

### 1.1 What was covered

- **Synthetic / simulated user research in HCI and UX.** Wikipedia-style
  definition, methodology stages, and the consensus on pitfalls.
- **LLM-based persona simulation.** Surveys of role-playing vs. personalization
  paradigms; evaluation frameworks (PersonaGym, PersonaEval).
- **User simulation for dialogue systems.** Task-oriented dialogue (TOD)
  simulators; goal-alignment methods; multi-user-simulator ensembles.
- **Web agent benchmarks** that evaluate agent behaviour in web environments
  (WebArena, Mind2Web, SeeAct, WebVoyager, VisualWebArena, GAIA). These are
  adjacent rather than central to R-02, but they share the "agent-in-real-env"
  substrate that u-sekai will eventually need.
- **Computer-use agent benchmarks** (OSWorld, OSWorld 2.0). Included as the
  upper-bound target when u-sekai extends beyond the browser.
- **Validation / calibration methodology.** Retrospective validation,
  distribution alignment, behavioural fidelity, demographic fidelity,
  persona consistency, sycophancy audit, predictive validity.

### 1.2 What was skipped and why

- **Recommendation / dialogue-generation benchmarks not tied to a user
  persona** (e.g. plain RAG QA, summarization leaderboards): out of scope —
  they evaluate the system, not the simulator.
- **General LLM capability benchmarks** (MMLU, GSM8K, etc.): out of scope.
- **Private enterprise "synthetic customer" platforms** (digital-twin-of-customer
  suites, vendor-locked synthetic-data platforms): explicitly out of scope
  per the R-02 draft.
- **Survey-only retrieval of the full text of every cited paper.** Where only
  abstracts / survey summaries were reachable, those were used and the
  limitation is noted inline.

### 1.3 Methodology notes

- **Inputs.** English-language academic search (arXiv, ACL Anthology, NeurIPS /
  KDD / EMNLP proceedings, ACM DL, ResearchGate), curated GitHub lists
  (`awesome-llm-human-simulation`, `PersonaLLM-Survey`,
  `awesome-multimodal-agent-benchmarks`), benchmark homepages (OSWorld,
  WebArena, WebVoyager, PersonaGym), and aggregator leaderboards
  (Steel.dev, leaderboard.steel.dev). Japanese sources were not used for this
  draft because no Japanese-only paper surfaced as essential; the R-02 draft
  permits but does not require them.
- **Evidence weight.** Strongest: arXiv paper + reproducible code or hosted
  leaderboard. Medium: paper with venue and abstract only. Weakest: blog /
  vendor summary used only for orientation.
- **Versioning.** Several results are moving targets (e.g. OSWorld top
  scores, WebVoyager success rates). The survey records the snapshot the
  source reported; readers must re-check against the live leaderboard before
  making any design decision. No "current best" claim is treated as durable.
- **Output language.** English only, per ADR-0002 (draft) / `CLAUDE.md` §7.
  Japanese translation of this survey is out of scope; tracked under R-09.

---

## 2. Reference / benchmark catalog

The catalog below is organized by sub-area. Within each sub-area the rows are
ordered from more user-simulation-flavoured (closest to R-02's question) to
more agent-evaluation-flavoured (still relevant but not the centre of R-02).
Each row includes: name, what it is, source, evaluation metric, and
human-vs-LLM gap if reported.

### 2.1 Synthetic user / HCI methodology

| Name | What it is | Source | Metric / claim | Human-vs-LLM gap (if reported) |
| --- | --- | --- | --- | --- |
| Wikipedia: *Synthetic user research* (article draft referenced in research notes) | Practice definition: persona-conditioned LLMs stand in for human participants | en.wikipedia.org/wiki/Synthetic_user_research (referenced; URL returns 404 at the time of writing — see §6) | Qualitative + quantitative, no single metric | Not a benchmark |
| Bauer & Senoner et al. (2024) *LLM-based simulated users for think-aloud usability studies* | Systematic framework, empirically tested in HCI / ETH Zurich | arXiv:2404.02163 | Comparison against human usability-study transcripts | Significant gap in ecological validity |
| Hämäläinen et al. (2023) *LLM-based UIs* | Evaluation of LLMs across user types / demographics | arXiv:2312.11812 | Behavioral similarity + qualitative coding | Demographic prompting only modestly shifts outputs |
| Patil et al. (2024) *Personas vs. demographics gap* (Stanford) | Studies whether persona descriptions or demographic attributes produce more behavioural variance | arXiv:2402.18076 | Behavioral variance under persona vs. demographic conditioning | Personas *reduce* behavioural variance vs. demographics |
| Liu et al. (2024/2025) *Evaluating LLMs as Synthetic Users* | Catalogue of pitfalls in synthetic-user generation | arXiv:2502.08462 | Mixed | Explicit "pitfalls" framing |
| Validation Methods for LLM-based Synthetic Users (2024) | Validation criteria across four dimensions: behavioural fidelity, demographic fidelity, process compliance, process fidelity. Pre-registered expert study, n=56 across 17 countries, plus n=23 qualitative interviews | arXiv:2412.06047 | Four-dimension rubric | Strong consensus: validate against real humans |
| Synthetic User Research Validated Using Real User Data (2024) | Compares LLM-simulated users against real users on user-needs tasks | arXiv:2410.20538 | Needs-assessment accuracy | LLM-simulated users underperform real users on needs tasks |
| "When Synthetic Users Fail" (2026) | Cross-domain benchmark of synthetic-user failure modes | arXiv:2607.26348v1 (as referenced) | Failure taxonomy | Domain-dependent |
| Synthetic Humans for HCI Research (S³ platform) | Multi-agent framework for AI researchers to validate research ideas using realistic user behaviour data | arXiv:2509.12180 (as referenced; the abstract describes a Social-Synthetic-Simulation platform) | Multi-agent behavioural validation | Not directly reported |
| Asgari et al. — Systematic literature review of synthetic participants | SLR on participants generated by LLMs (referenced in multiple downstream surveys) | ResearchGate: 378728488 | SLR method | Reviews existing gaps |

### 2.2 Persona simulation (LLM-as-persona, role-playing / personalization)

| Name | What it is | Source | Metric / claim |
| --- | --- | --- | --- |
| PersonaLLM-Survey — "Two Tales of Persona in LLMs" | First survey unifying role-playing and personalization under one "persona" lens | EMNLP 2024 Findings; GitHub `MiuLab/PersonaLLM-Survey` | Taxonomy: role-playing vs. personalization; psychological portrayal, Big Five, MBTI, consistency, fidelity |
| LLM-based Human Simulation (awesome list) | Curated GitHub list of papers, organized by sub-area | `github.com/Persdre/awesome-llm-human-simulation` | Includes InCharacter, AgentSims, AgentClinic, AlpacaFarm; 8 categories incl. "Recommendation & User Simulation" and "UI/UX & Gaming" |
| PersonaGym — first dynamic evaluation framework for persona agents | Five evaluation tasks: Action Justification, Expected Action, Linguistic Habits, Persona Consistency, Toxicity. Introduces **PersonaScore** (decision-theory-grounded, human-aligned). Dynamically selects environments from 150 options. | arXiv:2407.18416; EMNLP 2025 Findings; `personagym.com` | Claude 3.5 Sonnet only +2.97% PersonaScore vs GPT-3.5; Claude 3 Haiku is "very resistant to taking on personas" |
| PersonaEval — Are LLM-based Agents Good Persona Evaluators? | Tests whether LLM agents can act as reliable proxies for human raters in persona evaluation | arXiv:2502.02791 | Inter-rater reliability vs human raters |
| LLM-PDM (LLM Persona-Driven Method) | Persona-driven method for replicating synthetic survey data via LLMs | COMMTR 2026 (`sciopen.com/article/10.26599/COMMTR.2026.9640004`) | Survey-response distribution alignment |
| InCharacter (ACL 2024) | Evaluates personality fidelity in role-playing agents through psychological interviews | Referenced via `awesome-llm-human-simulation`; ACL 2024 | Personality-fidelity rubric |
| Eval4Sim | Evaluation framework for persona simulation: adherence, consistency, additional metrics | `alphaxiv.org/abs/2603.02876` | Multi-metric composite |
| PPol — Generating Realistic User Personas for Robust Evaluation | Persona-evolution method to improve simulator realism | arXiv:2605.12894v1 | "Realism" — undefined; pre-print |
| Implicit Profiles for Human-Like User Simulators | Profiles learned implicitly rather than written explicitly | `huggingface.co/papers/2502.18968` | Behavioral fidelity |
| LLM Generated Persona is a Promise with a Catch | Discusses LLM-generated personas for simulation and risks | OpenReview `qh9eGtMG4H` | Risks / failure modes |
| Multi-Agent Person Simulation Evaluation (2025) | Multi-agent interview framework: Simulation Director / Interviewee / Coach / Evaluator | arXiv:2508.02852 (abstract referenced) | Multi-faceted performance metric |
| PersonaBench — handling personal information through personalized scenarios | Persona-conditioned evaluation of how models handle personal info across scenarios | arXiv:2506.20002 | Scenario accuracy |

### 2.3 User simulation for dialogue / customer-facing systems

| Name | What it is | Source | Metric / claim |
| --- | --- | --- | --- |
| Reliable LLM-based User Simulator for TODs (DAUS) | Domain-Aware User Simulator that learns interaction specifics | ACL SciChat 2024 | Goal completion, success rate |
| Goal Alignment in LLM-Based User Simulators for TODs | Studies how faithfully user simulators adhere to assigned goals | arXiv:2507.20152v2 | Goal-alignment metric |
| One cannot stand for everyone — Leveraging Multiple User Simulators | Uses multiple simulators (rather than one) to cover population | OpenReview `Y2E5-_HL0DV` | Coverage / ensemble agreement |
| Prompting LLMs for User Simulation in TODs | Studies LLM prompting for user simulation; ChatGPT-class systems generalize better than ABUS | dl.acm.org/doi/10.1016/j.csl.2024.101697 | Generalization accuracy |
| User Simulation with LLMs for TOD (survey-style) | Overview of LLM-based user simulation for TOD systems | `alphaxiv.org/abs/2309.13233` | Survey |
| SpokenUS — spoken user simulator for TOD | Spoken (not typed) user simulation; diverse user behaviours | `huggingface.co/papers/2603.16783` | Speech-level metrics |
| Self-verified user simulator via code-based interpretation | Code-interpretation-based self-verification | sciencedirect.com S0952197626009693 | Self-verification success rate |
| LLM-based Persona Simulation (LPS) for Recommender Systems Evaluation | Generates personas from historical behavioural data; reports diversity, consistency, scalability | arXiv:2505.17793 | Persona diversity + behavioural consistency |
| RecAgent — simulation paradigm for recommender systems | LLM agents simulating diverse user profiles/behaviours for recommender research | KDD 2024 | Behavioural fidelity in recs |
| RecSim — configurable simulation platform for recommender systems (Google, pre-LLM) | RL-based structured user models in configurable environments | Ie et al., 2019 | Classical simulator baseline |
| Agent4Rec | LLM-based simulator for recommender evaluation | Referenced in `awesome-llm-human-simulation` | Behavioural match |
| SalesBot / ShopperBot family | Dual-agent retail negotiation simulators (sales-side + buyer-side) | `github.com/salesbot/shopperbot-simulator`; OpenAI Cookbook | Negotiation outcome |
| Persona-driven User Simulations based on LLMs (EMNLP 2025 Industry) | Uses persona-driven LLM user simulations to evaluate conversational agents | aclanthology.org/2025.emnlp-industry.16.pdf | Conversational task success |
| MCP-Persona — benchmarking LLM agents on real-world personalized tasks | Benchmark for LLM agents on personalized, stateful MCP tools | OpenReview `vmT3p2w83l` | Task success on personalized workflows |

### 2.4 Web-agent benchmarks (adjacent — agent-on-real-web substrate)

These benchmarks evaluate the **system under test** (an agent acting in a
browser). They are not synthetic-user benchmarks per se, but they are part of
the u-sekai landscape because a Synthetic User will eventually drive a real
browser, and the resulting traces must be interpretable against the same kind
of metrics.

| Name | What it is | Source | Metric | Reported SOTA vs. human (snapshot) |
| --- | --- | --- | --- | --- |
| Mind2Web | 2,000+ open-ended tasks over 137 websites across 31 domains; NeurIPS 2023 Spotlight | arXiv:2306.06070 | Task / step success rate; cross-task generalization | Authors note "substantial room to improve" generalization |
| WebArena | Realistic reproducible web environment for autonomous agents; long-horizon tasks across multiple web domains | `webarena.dev` (referenced via search) | Task success rate | SeeAct 10.01% step-wise, 3.99% one-shot vs human 78.24% (snapshot) |
| SeeAct | GPT-4V-based web agent trained on Mind2Web, evaluated on WebArena | (paper) | Task success rate | See row above |
| VisualWebArena (VWA) | Multimodal web tasks requiring visual grounding | `jykoh.com/vwa` | Task success rate | Referenced in `jykoh.com/vwa` |
| WebVoyager | LMM-based end-to-end web agent benchmark; 643 tasks across 15 real websites | arXiv:2401.13919; `github.com/MinorJerry/WebVoyager`; auto-eval via GPT-4V with 85.3% human-judgement agreement | Task success rate | Reported 59.1% for WebVoyager itself; current Steel.dev leaderboard shows top 99.19% by browser-control (Fable 5) — verify at source |
| Agent-E | Hierarchical web-agent architecture; improvements over WebVoyager | arXiv:2407.13032 | Task success rate | Outperforms WebVoyager baseline |
| GAIA | General AI assistants benchmark with real-world questions requiring multi-step reasoning, web browsing, tool use; 466 questions | arXiv:2311.00683; ICLR 2024 | Multi-tier accuracy | Steel.dev top: 92.36% (OPS-Agentic-Search, snapshot) |
| Online-Mind2Web | Continuously-updated web-agent benchmark built on Mind2Web | (referenced via Steel.dev leaderboard) | Task success rate | Steel.dev top: 97.0% (Browser Use Cloud, snapshot) |
| AssistantBench | Realistic web + desktop agent tasks (referenced in Steel.dev / SWE-bench indices) | swebench.com and llm-explorer.com | Task success rate | Variable across subsets |

### 2.5 Computer-use agent benchmarks (adjacent — expand-beyond-browser ceiling)

| Name | What it is | Source | Metric | Reported SOTA vs. human (snapshot) |
| --- | --- | --- | --- | --- |
| OSWorld | 369 real computer tasks across Ubuntu / Windows / macOS; execution-based evaluation scripts | arXiv:2404.07972; `osworld-universe.github.io`; `github.com/xlang-ai/OSWorld` | Task success rate (execution-based) | SOTA agents ~12.24% vs human 72.36% (paper); top Steel.dev snapshot: 86.1% (Qwen3.8-Max) — verify live |
| OSWorld 2.0 | Updated OSWorld | `osworld-v1.xlang.ai` | Task success rate | Steel.dev top: 77.9% (Claude Fable 5.1, snapshot) |
| Anthropic Claude computer-use system card | Reports Claude 3.5 Sonnet on OSWorld | `anthropic.com/news/3-5-models-and-computer-use` | OSWorld success rate | 14.9% at release (Oct 2024); later 28.0% (Claude 3.7 Sonnet) |
| OpenAI Operator system card | Reports GPT-4o on OSWorld | `cdn.openai.com/operator_system_card.pdf` | OSWorld success rate | 38.1% (Jan 2025, snapshot) |

### 2.6 Curated indexes / leaderboards

| Resource | URL | What it aggregates |
| --- | --- | --- |
| `awesome-llm-human-simulation` | `github.com/Persdre/awesome-llm-human-simulation` | Papers in 8 sub-areas incl. "Recommendation & User Simulation" and "UI/UX & Gaming" |
| `PersonaLLM-Survey` | `github.com/MiuLab/PersonaLLM-Survey` | Role-playing vs. personalization taxonomy, benchmarks |
| `awesome-multimodal-agent-benchmarks` | `github.com/PhiloLabs/awesome-multimodal-agent-benchmarks` | Multimodal agent benchmarks |
| Steel.dev leaderboard index | `leaderboard.steel.dev/results/` | 354 sourced results across 14 AI-agent benchmarks including WebVoyager, WebArena, OSWorld, SWE-bench Verified, GAIA, BrowseComp |
| Evidently AI — 30 LLM evaluation benchmarks | `evidentlyai.com/llm-guide/llm-benchmarks` | Overview of LLM benchmarks |
| Multi-Turn LLM Evaluation in 2026 (Confident AI) | `confident-ai.com/blog/multi-turn-llm-evaluation-in-2026` | Cooperative + adversarial persona evaluation patterns |
| AI Agent Benchmarks comparison (Decodethefuture, 2026) | `decodethefuture.org/en/ai-agent-benchmarks-2026/` | Cross-benchmark comparison commentary |
| UserSim.ai bibliography | `usersim.ai/bibliography/` | User-simulation bibliography |
| LLM-based Human Simulation (EmergentMind topic) | `emergentmind.com/topics/llm-based-persona-simulation` | Topic digest: variance explained, distribution alignment, behavioural consistency |

---

## 3. Evaluation metrics — synthesis

Across the surveyed work, evaluation falls into several overlapping families.
A future u-sekai evaluation suite can pick candidates from each.

### 3.1 Persona / behavioural fidelity

- **Persona consistency** — does the agent keep its declared persona over many
  turns and across tasks? (PersonaGym task #4; PersonaLLM-Survey.)
- **PersonaScore** — composite metric from PersonaGym covering action
  justification, expected action, linguistic habits, persona consistency,
  toxicity. Decision-theory-grounded and human-aligned.
- **Personality fidelity via psychological interviews** — InCharacter (ACL
  2024) applies Big-Five / MBTI inventories to role-play output.
- **Behavioural fidelity** — distribution-level agreement between the
  simulator's actions and a real-population reference distribution.
- **Demographic fidelity** — whether conditioning on a demographic actually
  produces the demographic's behavioural signature (Patil et al.; Cao et al.).
- **Linguistic-habit fidelity** — style / register / vocabulary consistent with
  the persona (PersonaGym task #3).
- **Variance explained** — fraction of cross-persona behavioural variance
  captured by the simulator (EmergentMind topic digest).
- **Distribution alignment** — agreement between simulator and reference
  marginal / joint distributions (LLM-PDM, RecAgent, MJV / Galileo
  methodology write-ups).

### 3.2 Task / outcome metrics

- **Task success rate** — task-completion correctness at session end. Used by
  WebArena, OSWorld, VisualWebArena, WebVoyager, GAIA, Mind2Web, SeeAct, MCP-Persona.
- **Step success rate** — finer-grained than task success; SeeAct reports
  both. Mind2Web also reports per-step.
- **Goal-alignment score** — for TOD user simulators; how faithfully the
  simulator's actions match an assigned goal (Goal Alignment paper).
- **Predictive validity on real task outcomes** — does simulator output
  predict what real humans actually do on a held-out task? (Validation
  Methods paper; Synthetic User Research Validated Using Real User Data.)

### 3.3 Process / transparency metrics

- **Process compliance** — does the simulator follow a documented reasoning
  process? (Validation Methods paper.)
- **Action justification quality** — PersonaGym task #1; correlates with
  human-aligned explainability.
- **Expected-action prediction** — PersonaGym task #2; tests whether the
  simulator anticipates its own next move consistently with its persona.

### 3.4 Safety / negative metrics

- **Toxicity control** — PersonaGym task #5.
- **Sycophancy audit** — does the simulator agree with whatever the prompt
  implies is expected? (Bauer & Senoner; Liu et al.)
- **Confabulation risk** — qualitative rating of whether rationales are
  supported (Wikipedia draft; Validation Methods paper).
- **Stereotyping amplification** — does the simulator over-index on
  stereotypes associated with demographic labels? (Cao et al., 2024.)

### 3.5 LLM-as-judge metrics

- **Automated evaluation by a strong LLM** — WebVoyager uses GPT-4V with
  85.3% human-judgement agreement; PersonaGym uses an ensemble of strong
  LLMs; RecAgent / PersonaEval use LLM-as-judge pipelines. Caveat: the judge
  shares the same training-distribution biases as the simulator.

### 3.6 Coverage / population metrics

- **Distributional coverage** — does the simulator sample the full target
  population, including edge cases, rather than collapsing to the modal
  response? (Liu et al.; Wikipedia draft.)
- **Multi-simulator ensemble disagreement** — One-cannot-stand-for-everyone;
  spread across an ensemble of simulators is itself a coverage signal.
- **Bias detection across demographics** — interrogating demographic slices
  separately for divergence (Patil et al.).

### 3.7 Calibration / validation metrics

- **Retrospective validation** — apply simulator to tasks with known real
  outcomes; compare predictions to ground truth (Sampl.space guide).
- **Statistical distribution verification** — per-variable Kolmogorov–Smirnov
  / chi-squared tests, KS distance, Wasserstein distance (MJV Innovation;
  Galileo).
- **Visual distribution comparison** — first-pass qualitative (Galileo).
- **Correlation metrics** — Pearson / Spearman between simulator and real
  rankings (Articos reports 90% correlation in one study — single source,
  treat as orientation).
- **Cross-domain benchmark of failure modes** — "When Synthetic Users Fail"
  (2026).

---

## 4. Calibration / validation methodology — synthesis

Calibration is the process of binding simulator outputs to real-user
reference data, and reporting the binding explicitly.

### 4.1 The four-dimension rubric (Validation Methods paper)

1. **Behavioural fidelity** — does the simulator act like the real user
   under controlled stimuli?
2. **Demographic fidelity** — does the simulator's behaviour shift in the
   direction real demographics shift?
3. **Process compliance** — does the simulator follow a documented reasoning
   process?
4. **Process fidelity** — does the simulator's reasoning process match a
   real-user reasoning process (think-aloud protocol, decision trace)?

### 4.2 Recommended workflow (consensus across sources)

1. **Calibrate.** Run a small human study; use it to seed and validate
   persona specifications. The PersonaLLM-Survey, the Wikipedia draft, the
   Validation Methods paper, and RecAgent converge on this step.
2. **Run synthetic study.** Generate a large synthetic sample from the
   calibrated personas.
3. **Cross-check.** Re-run a subset of stimuli on real users; compare
   distributions. (See §3.7 for metric choices.)
4. **Report divergence.** Disclose where synthetic and human findings agree
   and where they diverge.
5. **Triangulate.** Use synthetic findings to *generate hypotheses* and
   prioritize which questions to test with real participants.

### 4.3 Practical calibration checklist (synthesized)

- **Pre-register prompts and personas** to reduce researcher degrees of
  freedom (Validation Methods paper; emerging consensus).
- **Triangulate** synthetic-user findings with at least one human study,
  even if small-n.
- **Report both** behavioural similarity and predictive validity on held-out
  tasks.
- **Test distributional coverage**, not only central tendency.
- **Report negative results** — when synthetic users fail, document the
  failure mode.
- **Audit for sycophancy** by including adversarial or random tasks.
- **Across demographic slices**, report simulator-vs-real divergence
  separately.

---

## 5. Pitfalls (consensus across surveyed literature)

This section enumerates pitfalls that recur across multiple independent
sources. They are candidate *design constraints* for u-sekai, not yet
adopted.

1. **Lack of ecological validity.** LLM users solve tasks "correctly" rather
   than the way real users do (with confusion, shortcuts, motor slips). (Bauer
   & Senoner; Hämäläinen; Liu et al.)
2. **Persona collapses diversity.** A persona description often produces
   *less* behavioural variance than a demographic attribute. (Patil et al.;
   Cao et al.)
3. **Distributional collapse around the mode.** Underrepresented populations
   (accessibility users, novices, experts, non-mainstream workflows) are
   systematically missed. (Liu et al.; Wikipedia draft.)
4. **Sycophancy and instruction-following bias.** The simulator conforms to
   the experimenter's implied expectations (Bauer & Senoner; Liu et al.).
5. **No embodiment / no environment.** Real usability issues stem from
   screen size, latency, interruption, physical / cognitive accessibility —
   none of which a text-only simulator reproduces. (Bauer & Senoner; Liu et
   al.)
6. **Static snapshot vs. longitudinal behaviour.** Real users learn, fatigue,
   develop habits; single-turn evaluations miss this. (Liu et al.)
7. **Confabulation risk.** LLMs produce fluent but unsupported rationales.
   (Wikipedia draft; Validation Methods paper.)
8. **Prompt sensitivity.** Small wording changes produce large behavioural
   shifts. (Liu et al.; PersonaGym.)
9. **Demographic prompting fails to elicit demographic behaviour.** (Cao et
   al., 2024.)
10. **Stereotyping amplification.** LLMs over-index on stereotypes associated
    with demographic labels. (Cao et al.)
11. **Insufficient human-baseline validation.** Many papers report
    surface-level similarity (response distribution matching) but do not
    validate predictive validity or generalization beyond benchmark tasks.
    (Validation Methods paper; Liu et al.)
12. **Capability ≠ persona performance.** A stronger general LLM is not
    necessarily a better persona agent; PersonaGym reports Claude 3 Haiku
    *resists* taking on personas, and Claude 3.5 Sonnet only marginally
    improves PersonaScore over GPT-3.5.
13. **Evaluation methodology gaps.** No consensus on what "good" synthetic
    output looks like; inter-rater reliability rarely reported; human
    baselines often collected under different conditions than LLM
    conditions. (Liu et al.)
14. **LLM-as-judge inherits simulator biases.** When the judge shares the
    training distribution of the simulator, calibration is circular. (WebVoyager
    auto-eval; PersonaGym ensemble.)
15. **No novel ground truth.** Findings are bounded by what the underlying
    model "knows." Edge cases, emerging behaviours, and underrepresented
    populations are systematically missed. (Wikipedia draft.)
16. **Construct validity.** A synthetic user cannot *have* unmet needs; it can
    only model patterns it was trained on. (Wikipedia draft.)
17. **Consistency drift.** Across many turns, persona-conditioned LLMs drift
    toward the model's prior or contradict earlier statements.
    (Wikipedia draft; PersonaGym persona-consistency task.)

---

## 6. Gap analysis vs. u-sekai requirements

u-sekai's R-01 draft (§3, README.md) frames the project as:

> drive Synthetic Users — AI agents standing in for human users with diverse
> capabilities, perceptions, operating environments, memories, preferences,
> and situations — to independently explore digital environments (initially
> Web) … extract unanticipated operation paths, errors, dead-ends, friction,
> subjective reports, observable indicators.

The following table maps each surveyed sub-area to u-sekai requirements and
identifies the explicit gap.

| u-sekai requirement | Closest surveyed area | Gap |
| --- | --- | --- |
| **Diverse individual differences** (capability, perception, memory, preference, situation) | Persona simulation + persona generation (RecAgent, PersonaLLM-Survey, PPol) | Surveyed personas span demographics, Big-Five, MBTI. **No surveyed system models perception-level (visual / motor / cognitive) accessibility variation.** This is a candidate gap for u-sekai. |
| **Subjective UX reports** (rating, free-form reflection, behavioural log) | LLM-as-judge pipelines; PersonaEval; Recommendation simulator questionnaires | Most surveyed work treats LLM output as the simulator's behaviour, not as a *reported* subjective experience. **Gap: explicit subjective-UX protocols — see R-05.** |
| **Real web environment** (live web, not canned test set) | WebArena, Mind2Web, WebVoyager, VisualWebArena | These evaluate the *agent under test* against canned tasks. **No surveyed system drives a *simulated user* against live web apps for exploratory UX discovery.** This is u-sekai's main addition. |
| **Many Synthetic Users in parallel** | OASIS, AgentSociety, AgentVerse (referenced in `awesome-llm-human-simulation`) | Social-simulation platforms scale to 1M agents in synthetic cities. **Gap: no surveyed platform ties this scaling to exploratory UX evaluation on real products.** |
| **Calibration against real users** | Validation Methods (4-dim rubric); Bauer & Senoner; LLM-Simulated-Persons-Eval multi-agent framework | Methodologies exist; the Web/UX combination is under-explored. **Gap: a single calibration rubric tuned for exploratory UX evaluation on live products — candidate for R-07.** |
| **Out-of-spec / mistake discovery** | SeeAct, WebVoyager, OSWorld failure analyses | These report *aggregate* success rates, not systematic mistake-pattern discovery. **Gap: methodology for "interesting failure" surfacing rather than "success rate".** |
| **Subjective evaluation timing** (per-action / per-task / per-session / per-condition) | Confident AI multi-turn evaluation patterns | Surveyed TOD user simulators use per-turn interactions; behavioural logs are standard. **Gap: per-condition subjective evaluation specifically for UX — see R-05.** |
| **Diversity-vs-comparability trade-off** | One-cannot-stand-for-everyone (multi-simulator ensembles) | Trade-off is acknowledged; no canonical recipe. **Gap: a candidate generation / sampling strategy — see R-06.** |
| **What Synthetic Users cannot validate** | Wikipedia draft §5–6; Validation Methods paper | Existing literature is explicit that synthetic users are a complement, not replacement. **Gap: an explicit boundary statement tuned for u-sekai's scope — see R-07.** |

---

## 7. Candidate evaluation metrics / methodology — *candidate set*

The following is a **candidate set** assembled from the surveyed literature.
It is not adopted and does not commit to any specific metric, LLM, library,
or implementation.

### 7.1 Candidate behavioural-fidelity metrics

- **PersonaScore-style composite** (PersonaGym): a multi-task aggregate that
  bundles action justification, expected action, linguistic habits, persona
  consistency, and toxicity.
- **Persona consistency over a long horizon** (PersonaGym task #4; persona
  drift literature).
- **Demographic-fidelity split** (Patil et al.): per-demographic-slice
  divergence between simulator and real reference.
- **Predictive validity on a held-out real-user task set** (Validation
  Methods; Synthetic User Research Validated Using Real User Data).

### 7.2 Candidate outcome / process metrics

- **Task success rate** with execution-based evaluation scripts (OSWorld
  style) where applicable.
- **Step success rate** (SeeAct, Mind2Web) for finer-grained signal.
- **Action justification quality** (PersonaGym task #1) for process
  transparency.
- **Path novelty / dead-end detection** as a candidate exploratory-UX
  metric (no canonical prior; see open questions).

### 7.3 Candidate calibration methods

- **Four-dimension rubric** (behavioural / demographic / process / process
  fidelity).
- **Retrospective validation** against ground-truth real-user datasets.
- **Statistical distribution verification** (KS / chi-squared /
  Wasserstein).
- **Multi-simulator ensemble disagreement** (One-cannot-stand-for-everyone) as
  a coverage signal.
- **LLM-as-judge ensemble** (PersonaGym, WebVoyager) with explicit caveats
  about shared-distribution bias.

### 7.4 Candidate validation workflow

- **Pre-register** prompts and personas.
- **Calibrate** on small real-user study.
- **Run** synthetic study at scale.
- **Cross-check** with held-out real-user subset.
- **Report divergence** explicitly.
- **Triangulate** synthetic findings with at least one human study before
  drawing conclusions.

---

## 8. Open questions / follow-up items / unresolved consequential decisions

These are items that **may** require user escalation depending on R-03 / R-05
/ R-06 / R-07 outcomes. Listed here per the "do not block" rule; the rest of
the investigation continues without them.

1. **Calibration rubric ownership.** Should u-sekai adopt a published rubric
   (Validation Methods paper, PersonaGym) or design its own for exploratory
   UX on live web? This is consequential because it determines what
   "calibrated Synthetic User" means for downstream Issues (R-07).
2. **Diversity-vs-comparability trade-off.** Is u-sekai's value primarily
   *diversity coverage* (many personas) or *comparability* (same persona
   across conditions)? Surveyed systems lean one way or the other; this
   changes R-06 (persona generation) and R-05 (subjective evaluation).
3. **Subjective-UX capture timing.** Per-action / per-task / per-session /
   per-condition? Decided by R-05, but the literature does not converge.
4. **LLM-as-judge acceptance.** Whether to use LLM-as-judge for subjective
   reports (Confident AI, PersonaGym, WebVoyager) given the shared-bias risk.
   A consequential decision because it locks in a meta-LLM dependency.
5. **Whether u-sekai should integrate (or just cite) existing benchmarks.**
   Open because R-08 will decide MVP scope.
6. **Whether to include the "live web" substrate as a Synthetic-User
   benchmark** (i.e. add a new benchmark to §2.4 / §2.5) or only consume
   existing ones. Consequential because it determines whether u-sekai
   contributes to the benchmark ecosystem.
7. **Whether the "no embodiment / no environment" pitfall (§5.5) is in scope
   for v1.** Decided by R-04 (isolation) and R-08 (MVP scope).

---

## 9. References

All URLs are listed for traceability. Several are blog / vendor summaries
used only for orientation and clearly marked.

### Surveys and overviews

- "A Survey on LLM-based Persona Simulation" (5 dimensions / quantitative
  metrics): `researchgate.net/publication/394395069_A_Survey_on_LLM-based_Persona_Simulation`
- "A Survey on LLM-based Agents for Social Simulation": `researchgate.net/publication/393357027_A_Survey_on_LLM-based_Agents_for_Social_Simulation_Taxonomy_Evaluation_and_Applications`
- "A Survey on Social Simulation Driven by Large Language Models" (ACM,
  2026): `dl.acm.org/doi/10.1145/3800683`
- PersonaLLM-Survey (EMNLP 2024 Findings):
  `github.com/MiuLab/PersonaLLM-Survey`
- "30 LLM evaluation benchmarks and how they work" (Evidently AI):
  `evidentlyai.com/llm-guide/llm-benchmarks`
- "Multi-Turn LLM Evaluation in 2026" (Confident AI):
  `confident-ai.com/blog/multi-turn-llm-evaluation-in-2026`
- "LLM-Based Persona Simulation" (EmergentMind):
  `emergentmind.com/topics/llm-based-persona-simulation`
- "User-Centric Dialogue Simulations" (EmergentMind):
  `emergentmind.com/topics/user-centric-dialogue-simulations`
- UserSim.ai bibliography: `usersim.ai/bibliography/`
- AI Agent Leaderboard 2026 (Rapidclaw): `rapidclaw.dev/blog/ai-agent-benchmarks-2026`
- AI Agent Evaluation Benchmarks & Leaderboards (LLM Explorer):
  `llm-explorer.com/benchmarks/`
- AI Agent Benchmark Results (Steel.dev): `leaderboard.steel.dev/results/`
- "AI Agent Benchmarks: What They Test and How to Compare" (Decodethefuture,
  2026): `decodethefuture.org/en/ai-agent-benchmarks-2026/`
- "How We Broke Top AI Agent Benchmarks" (2026):
  `moogician.github.io/blog/2026/trustworthy-benchmarks-cont/`

### Synthetic-user / HCI methodology

- Bauer & Senoner et al. (2024) — Systematic framework for LLM-simulated
  users in think-aloud usability studies: `arxiv.org/abs/2404.02163`
- Hämäläinen et al. (2023) — "LLM-based UIs": `arxiv.org/abs/2312.11812`
- Patil et al. (2024, Stanford) — Personas vs. demographics gap:
  `arxiv.org/abs/2402.18076`
- Liu et al. (2024/2025) — "Evaluating LLMs as Synthetic Users":
  `arxiv.org/abs/2502.08462`
- Validation Methods for LLM-based Synthetic Users (4 dimensions):
  `arxiv.org/abs/2412.06047`
- Synthetic User Research Validated Using Real User Data:
  `arxiv.org/abs/2410.20538`
- "When Synthetic Users Fail" (cross-domain benchmark, 2026):
  `arxiv.org/html/2607.26348v1`
- S³ — Social-Synthetic-Simulation platform: `arxiv.org/abs/2509.12180`
- "Let's put this whole 'synthetic users' thing to rest" (LinkedIn
  commentary): `linkedin.com/posts/johnwhalen_lets-put-this-whole-synthetic-users-thing-activity-7337584220988456963-4mxT`
- Synthetic Data for User Research (Sampl.space guide):
  `sampl.space/blog/synthetic-data-for-user-research/`
- Synthetic Users vs Real Users (Articos):
  `articos.com/blog/synthetic-users-vs-real-users`
- How to Validate Synthetic Data (MJV Innovation):
  `mjvinnovation.com/blog/how-to-validate-synthetic-data-the-guide-to-fidelity-utility-and-privacy/`
- Master Synthetic Data Validation (Galileo AI):
  `galileo.ai/blog/validating-synthetic-data-ai`
- "Synthetic data, synthetic trust" (PMC 2025):
  `pmc.ncbi.nlm.nih.gov/articles/PMC12778113/`
- Synthetic Users for Early-Stage Validation (Qualz):
  `qualz.ai/blog/synthetic-users-early-validation/`

### Persona simulation

- PersonaGym (arXiv): `arxiv.org/abs/2407.18416`; HTML v4:
  `arxiv.org/html/2407.18416v4`; site: `personagym.com`; EMNLP 2025
  Findings: `aclanthology.org/2025.findings-emnlp.368.pdf`; Princeton
  publication: `collaborate.princeton.edu/en/publications/personagym-evaluating-persona-agents-and-llms/`;
  summary: `marktechpost.com/2024/08/02/personagym-a-dynamic-ai-framework-for-comprehensive-evaluation-of-llm-persona-agents/`
- PersonaEval — Are LLM-based Agents Good Persona Evaluators?:
  `arxiv.org/abs/2502.02791`
- LLM-PDM (LLM Persona-Driven Method, 2026):
  `sciopen.com/article/10.26599/COMMTR.2026.9640004`
- InCharacter (ACL 2024) — via awesome list:
  `github.com/Persdre/awesome-llm-human-simulation`
- Eval4Sim — `alphaxiv.org/abs/2603.02876`
- PPol — Generating Realistic User Personas:
  `arxiv.org/html/2605.12894v1`
- Implicit Profiles for Human-Like User Simulators:
  `huggingface.co/papers/2502.18968`
- "LLM Generated Persona is a Promise with a Catch" (OpenReview):
  `openreview.net/forum?id=qh9eGtMG4H`
- Multi-Agent Person Simulation Evaluation (2025):
  `arxiv.org/abs/2508.02852`
- PersonaBench: `arxiv.org/abs/2506.20002`
- "Assessing the Reliability of Persona-Conditioned LLMs":
  `arxiv.org/html/2602.18462v1`
- "Evaluating the LLM-simulated Impacts of Big Five" (KDD Eval Workshop,
  2025): `kdd-eval-workshop.github.io/genai-evaluation-kdd2025/assets/papers/Submission%2036.pdf`
- "A Framework for Validating AI-Personas in Crisis Response":
  `arxiv.org/abs/2506.19413`
- "EVALUATING LLM-GENERATED WORKOUT PLANS":
  `arxiv.org/abs/2507.14163`
- Awesome LLM-based Human Simulation:
  `github.com/Persdre/awesome-llm-human-simulation`

### User simulation for dialogue / recommendation / customer-facing

- Reliable LLM-based User Simulator for TODs (DAUS):
  `aclanthology.org/2024.scichat-1.3.pdf`
- Goal Alignment in LLM-Based User Simulators for TODs:
  `arxiv.org/html/2507.20152v2`
- One cannot stand for everyone — Multiple User Simulators:
  `openreview.net/forum?id=Y2E5-_HL0DV`
- Prompting LLMs for User Simulation in TODs:
  `dl.acm.org/doi/10.1016/j.csl.2024.101697`
- User Simulation with LLMs for TOD: `alphaxiv.org/abs/2309.13233`
- SpokenUS: `huggingface.co/papers/2603.16783`
- Self-verified user simulator via code-based interpretation:
  `sciencedirect.com/science/article/abs/pii/S0952197626009693`
- LLM-based Persona Simulation (LPS) for Recommender Systems Evaluation:
  `arxiv.org/abs/2505.17793`
- RecAgent (KDD 2024): referenced via `awesome-llm-human-simulation`
- RecSim (Google, 2019): Ie et al.
- "Let the LLMs Talk — Simulating Human-to-Human Conversational QA":
  `researchgate.net/publication/378728488`
- "Leveraging LLM as User Simulators" (ResearchGate):
  `researchgate.net/publication/374906394`
- SalesBot / ShopperBot tutorial:
  `towardsdatascience.com/dual-agent-retail-simulator`;
  `analyticsvidhya.com/salesbot-vs-shopperbot`;
  OpenAI Cookbook: `cookbook.openai.com/examples/build_sales_bot_with_gpt-4o-mini`
- Persona-driven User Simulations (EMNLP 2025 Industry):
  `aclanthology.org/2025.emnlp-industry.16.pdf`
- MCP-Persona — benchmarking LLM agents on real-world personalized tasks:
  `openreview.net/forum?id=vmT3p2w83l`

### Web-agent benchmarks

- Mind2Web (NeurIPS 2023 Spotlight): `arxiv.org/abs/2306.06070`
- WebVoyager: `arxiv.org/abs/2401.13919`;
  `github.com/MinorJerry/WebVoyager`
- Agent-E: `arxiv.org/abs/2407.13032`
- GAIA (ICLR 2024): `arxiv.org/abs/2311.00683`
- VisualWebArena: `jykoh.com/vwa`
- SeeAct and WebArena — discussed via survey above; results snapshot:
  SeeAct 10.01% step-wise / 3.99% one-shot, human 78.24% on WebArena;
  MindAct (HTML only) 2.77%
- Online-Mind2Web and other continually-updated web-agent benchmarks:
  referenced via `leaderboard.steel.dev/results/`
- "A Web Agent Benchmark Grounded in Egocentric Videos":
  `arxiv.org/html/2603.22529v1`

### Computer-use benchmarks

- OSWorld: `arxiv.org/abs/2404.07972`;
  `osworld-universe.github.io`;
  `github.com/xlang-ai/OSWorld`;
  OSWorld v1 / 2.0 site: `osworld-v1.xlang.ai`
- Anthropic Claude computer-use system card:
  `anthropic.com/news/3-5-models-and-computer-use`
- OpenAI Operator system card:
  `cdn.openai.com/operator_system_card.pdf`
- OSWorld Benchmark summary (Skywork.ai):
  `docs.skywork.ai/skywork-ai-research/OSWorld-Benchmark`
- awesome-multimodal-agent-benchmarks:
  `github.com/PhiloLabs/awesome-multimodal-agent-benchmarks`
- SWE-bench leaderboards: `swebench.com`

---

## 10. Self-check against the acceptance criteria

| Acceptance criterion (from `docs/research-issues/README.md`) | Where it is satisfied |
| --- | --- |
| A references / benchmark list exists in docs | §2 (six sub-tables: synthetic-user HCI, persona simulation, dialogue/customer-facing, web-agent, computer-use, indexes). |
| Evaluation metrics, calibration methods, and pitfalls are summarized | §3 (evaluation metrics), §4 (calibration methods), §5 (pitfalls). |

All acceptance criteria for R-02 are met. No adoption decisions are recorded.
