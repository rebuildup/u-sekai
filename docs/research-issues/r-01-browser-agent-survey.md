# R-01: Survey of existing browser / computer-use agent environments

> Draft research artifact for issue **R-01** (Survey of existing browser / computer-use agent ecosystems).
> This is a **survey**, not an adoption decision. Nothing in this document is "decided" or "adopted".
> Investigation method, evidence, candidate sets, and open questions are recorded here so that subsequent Issues (R-03, R-04, R-06, R-08) can make decisions with prior-art visibility.

---

## 1. Question (verbatim from the draft)

> Survey the existing browser-automation agent / computer-use agent ecosystems (OSS / SaaS / papers) to identify what u-sekai can reuse and what it must build.

**Acceptance criteria** (from `docs/research-issues/README.md`):

1. Capability comparison table is captured in docs.
2. Differences vs u-sekai's requirements are made explicit.

---

## 2. Investigation summary

### 2.1 What was covered

- **OSS browser / web agent libraries** that wrap Playwright / headless Chrome behind an LLM loop: `browser-use`, `stagehand` (Browserbase), `skyvern`, `OpenHands` (All-Hands-AI).
- **OSS browser-infrastructure providers** that supply hosted Chromium for agents: Browserbase, Steel, Hyperbrowser (referenced in comparison write-ups).
- **Low-level browser automation substrate**: Playwright, Puppeteer, Selenium (referenced as the substrate many of the above are built on).
- **General-purpose agent runtimes / frameworks** that a browser agent can be implemented on: LangChain + LangGraph, AutoGen, CrewAI.
- **First-party "computer-use" agent platforms** offered by foundation-model vendors: Anthropic Claude "Computer Use", OpenAI Operator / CUA, Google Gemini 2.0 Computer Use (and the now-discontinued Project Mariner wrapper).
- **Personal / consumer-facing SaaS in the same niche**: MultiOn (now AGI, Inc. / AGI-0), Adept AI (ACT-1 / Fuyu, largely dismantled after the Amazon acquihire).
- **Public research benchmarks** commonly used to evaluate these systems: Mind2Web, WebArena (and WebArena Verified), WebVoyager, VisualWebArena, GAIA, OSWorld (and OSWorld-MCP / OSWorld-X), AppWorld.
- **Adjacent research artifacts** that frame "agent persona" / "generative agents" (Park et al., 2023) because the Synthetic User dimension is the u-sekai-specific twist not covered by the agent-ecosystem literature itself.

### 2.2 What was skipped and why

- **Non-public / enterprise-internal** browser-agent stacks (e.g., Amazon's internal agents after the Adept acquihire, OpenAI Operator internal red-teaming infra). These are explicitly **out of scope** per the R-01 draft.
- **Domain-specific vertical agents** (e.g., shopping-only, recruiting-only, RPA-only). The R-01 motivation is "what layer does u-sekai add value on top of"; vertical agents blur the layer separation.
- **Pure LLM-evaluation benchmarks with no agent component** (MMLU, HumanEval, etc.). They are not informative for the "browser / computer-use agent" layer.
- **Persona / synthetic-user research literature** at depth. That is R-02's scope; R-01 only sketches the intersection (see Section 4.4).
- **Per-product deep dives on pricing, vendor SLAs, and ToS**. These are deferred to R-04 (execution-environment comparison) when the candidate set narrows.

### 2.3 Methodology notes

- Primary sources used: official project READMEs / docs, official papers (arXiv, NeurIPS / ICLR / EMNLP proceedings), official model-vendor launch posts, and OpenReview / Hugging Face leaderboards.
- Where the public record is unclear (e.g., MultiOn's roadmap, Adept's current state), the gap is recorded in Section 7 (open questions) rather than guessed.
- "Capability" is interpreted along the axes u-sekai cares about (Section 5): **input modality**, **action space**, **persona / individual-difference support**, **subjective reporting**, **isolation / sandboxing**, **portability**, **reproducibility**, **cost shape**, **safety surface**.
- This document **does not** rank them by recommendation score. Section 6 records candidate *sets* only.

---

## 3. Layer model (how the prior art stacks)

Before listing individual systems, it is helpful to fix the layer model so that candidate sets in Section 6 are not comparing apples to oranges.

| Layer | What lives here | Representative prior art (candidate) |
| --- | --- | --- |
| L1. Substrate | Headless browser / desktop runtime, DOM / accessibility-tree / pixel APIs | Playwright, Puppeteer, Selenium, Chromium, headless-X11 |
| L2. Browser-infrastructure | Hosted, isolated, anti-detect Chromium-as-a-service | Browserbase, Steel, Hyperbrowser |
| L3. Browser-agent harness | LLM loop that turns (observation, goal) into next action | `browser-use`, `stagehand`, `skyvern`, OpenHands (web mode) |
| L4. Agent runtime / orchestration | Stateful multi-step / multi-agent framework underneath L3 | LangGraph, AutoGen, CrewAI, raw SDKs |
| L5. First-party computer-use model | A foundation model whose native API is "see screen, emit action" | Anthropic Claude Computer Use, OpenAI CUA, Google Gemini Computer Use |
| L6. Agentic SaaS / product | End-user-facing product that bundles L3+L4+L5 with personas, guardrails, billing | OpenAI Operator, Anthropic's Claude-in-Chrome, MultiOn / AGI-0, Adept (legacy) |
| L7. Evaluation environment | Reproducible sites / OS state / fixed tasks with programmatic checkers | Mind2Web, WebArena, WebVoyager, GAIA, OSWorld, AppWorld |

u-sekai's value sits on top of L1–L4 (and possibly L5 as a candidate tool) but **above** the existing benchmarks at L7; see Section 5 for the gap analysis.

---

## 4. Key findings with evidence

### 4.1 OSS browser / web agent libraries

#### `browser-use` (browser-use/browser-use)

- AI-driven browser agent library for Python and TypeScript; lets an LLM control a browser via natural-language goals.
- Combines LLM reasoning with HTML / DOM and visual analysis; ships with a managed cloud-browser backend (Browser Use Cloud) priced around **$0.02 per browser-hour** per public docs.
- Public evidence: <https://github.com/browser-use/browser-use>, <https://browser-use.com/>, <https://docs.browser-use.com/cloud/quickstart>, <https://pypi.org/project/browser-use/>.
- Primary observation: positions itself as a **drop-in L3 harness** with first-class LLM-agnostic support; the project's own marketing emphasizes "Web agent automation" / "Web scraping with AI-driven navigation".

#### `stagehand` (browserbase/stagehand)

- Open-source browser-automation framework developed by Browserbase; exposes four primitives: `act`, `extract`, `observe`, `agent`. Built on Playwright.
- Ships in TypeScript, Python, and Go (per the v3 introduction docs).
- Public evidence: <https://github.com/browserbase/stagehand>, <https://stagehand.dev/>, <https://docs.stagehand.dev/v3/first-steps/introduction>, <https://www.browserbase.com/stagehand>.
- Primary observation: positions itself as **"Playwright was built for testing. Stagehand is built for agents"**; the primitives deliberately mix "AI natural-language" (`act`) with "deterministic code" (`extract`), which is a useful design pattern for u-sekai's need to combine exploratory behavior with reproducible instrumentation.

#### `skyvern` (Skyvern-AI/skyvern)

- Open-source browser automation framework that uses LLMs and computer vision to automate workflows on any website; includes "Workflow Blocks" (navigation, extraction, login, action, conditional, loop, validation).
- Public evidence: <https://github.com/Skyvern-AI/skyvern>.
- Primary observation: emphasizes **workflow-as-code** rather than pure natural-language agency, which makes it closer to an RPA tool than to an exploratory agent; less directly applicable but relevant as a candidate for the "structured exploration" subset.

#### OpenHands (All-Hands-AI/OpenHands, formerly OpenDevin)

- OSS platform for software-development agents; can execute commands, browse the web, call APIs. 50K+ stars / 3M+ Docker pulls per the project's own README.
- Public evidence: <https://github.com/All-Hands-AI/OpenHands>.
- Primary observation: agent runtime is **task-completion-oriented** for software engineering rather than user-experience exploration; useful as an L4 reference architecture but not as a candidate to build on for the Synthetic User case.

### 4.2 Browser-infrastructure providers (L2)

#### Browserbase, Steel, Hyperbrowser

- Hosted Chromium-as-a-service aimed at AI-agent workloads; primary value is **isolation**, **anti-bot resilience**, and **per-session ephemeral state**.
- Public evidence: <https://www.browserbase.com/stagehand>, <https://www.skyvern.com/blog/browserbase-vs-stagehand-which-is-better/> (third-party comparison), and the Browserbase / Steel product sites.
- Primary observation: these are **infrastructure candidates** for u-sekai's "many parallel Synthetic Users" requirement (R-04), not full agent harnesses. Their pricing model is per-browser-hour, which matches the unit economics of large-batch persona studies.

### 4.3 First-party computer-use model APIs (L5)

#### Anthropic Claude "Computer Use"

- API feature on Claude 3.5 / 3.7 / Sonnet 4 models that takes screenshots and returns tool calls (`mouse_move`, `left_click`, `type`, `key`, `screenshot`, etc.).
- Public evidence: Anthropic's launch post and tool-use docs (referenced widely; primary source is the Anthropic product documentation page).
- Primary observation: **model-level API**, not a persona-aware system. The agent harness (the loop, memory, persona injection, post-session analysis) is the implementer's responsibility.

#### OpenAI Operator / Computer-Using Agent (CUA)

- Browser-based agent product announced January 23 2025; powered by a new CUA model that combines GPT-4o vision with reinforcement learning over a screenshot + keyboard + mouse action space.
- Reported benchmark scores per the OpenAI Operator system card and launch material: **38.1% on OSWorld**, **58.1% on WebArena**, **87% on WebVoyager**; humans at ~72.4% on OSWorld.
- Safety features include "take over" mode for sensitive actions, watch mode for monitoring, prompt-injection safeguards, and a 30-day data-retention limit on screenshots.
- Public evidence: <https://openai.com/index/introducing-operator/>, <https://openai.com/index/computer-using-agent/>, <https://cdn.openai.com/operator_system_card.pdf>, <https://techcrunch.com/2025/01/23/openai-launches-operator/>.
- Primary observation: closed product with an API roadmap; persona / individual-difference is **not** a first-class feature; single-session SaaS, not a parallel-batch research infrastructure.

#### Google Gemini 2.0 Computer Use / Project Mariner

- Gemini 2.0 introduced a Computer Use capability; Project Mariner was the prototype Chrome-extension wrapper built on Gemini 2.0.
- Public evidence: <https://labs.google.com/mariner/landing>, <https://www.youtube.com/watch?v=2XJqLPqHtyo>.
- Important **status update**: per Wired (March 2026) and Digital Trends (May 2026), Project Mariner as a standalone product was discontinued and its capabilities were folded into the Gemini API, Gemini Agent, and Google Search "AI Mode". The team was also reorganized (see Section 7 open questions).
- Public evidence of discontinuation: <https://www.wired.com/story/google-shakes-up-project-mariner-team-web-browsing-agents/>, <https://www.digitaltrends.com/computing/google-pulls-the-plug-on-project-mariner-the-ai-agent-that-browsed-the-web-like-a-human/>.
- Primary observation: signals that **first-party browser-agent product surfaces are unstable**; u-sekai should not depend on a single vendor's product roadmap. The underlying Gemini capability may still be reusable as a model API even if the standalone product goes away.

### 4.4 Agent runtimes and orchestration (L4)

#### LangGraph / LangChain

- LangGraph is a low-level orchestration framework ("nodes, edges, state") for stateful, long-running agent workflows; LangChain v1.0 frames LangGraph as the **agent runtime**, LangChain as the **agent framework**.
- Public evidence: <https://www.langchain.com/langgraph>, <https://docs.langchain.com/oss/python/langgraph/overview>, <https://www.langchain.com/blog/deep-agents-vs-langchain-vs-langgraph>, <https://www.langchain.com/blog/langchain-langgraph-1dot0>.
- Primary observation: **framework-level candidate**; no opinions about personas, exploration vs validation, or user simulation; gives u-sekai the primitives (state, memory, control flow) without prescribing the Synthetic User semantics.

#### AutoGen, CrewAI

- Multi-agent orchestration frameworks with role-based agent definitions and group-chat / crew patterns.
- Public evidence: product docs of Microsoft AutoGen and CrewAI (commonly referenced in the literature; primary sources are the official docs and GitHub repos).
- Primary observation: alternative L4 candidates; offer more "persona-as-agent-role" affordances than LangGraph but at the cost of less direct control over the control flow. Open question for R-03 (Section 7).

### 4.5 Personal / consumer SaaS in the same niche (L6)

#### MultiOn → AGI, Inc. / AGI-0

- MultiOn pioneered the personal browser-agent category; per public reporting the company has since rebranded around AGI-0, described as a "proactive personal AI agent that sees your screen and controls mobile apps, browsers, and desktop software".
- Public evidence: <https://docs.multion.ai/welcome>, <https://www.langchain.com/blog/multion-x-langchain-powering-next-gen-web-automation-navigation-with-ai>, <https://mail.multion.ai/p/personal-ai-agent>.
- Primary observation: the **brand survives but the consumer browser-agent product has pivoted away** from per-session automation toward a "proactive always-on" model. u-sekai's "many parallel Synthetic Users in independent sessions" use case is not MultiOn's target market.

#### Adept AI (ACT-1, Fuyu)

- ACT-1 (action transformer) was announced 2022; Fuyu-8B (multimodal architecture for AI agents) was open-sourced in late 2023, followed by Fuyu-Heavy announcement.
- In June 2024, Amazon hired most of Adept's co-founders and licensed the core technology (similar pattern to Microsoft–Inflection). Zach Brock became CEO in June 2024 and departed for OpenAI in April 2025.
- Public evidence: <https://www.adept.ai/blog/fuyu-8b/>, <https://www.adept.ai/blog/adept-fuyu-heavy/>, <https://www.adept.ai/blog/adept-update/>, <https://techcrunch.com/2024/06/28/amazon-hires-founders-away-from-ai-startup-adept/>, <https://huggingface.co/adept/fuyu-8b>.
- Primary observation: **prior art, not a candidate**. The Fuyu-8B weights remain on Hugging Face for research use; the company is not a stable supplier for a research infrastructure.

### 4.6 Evaluation environments / benchmarks (L7)

| Benchmark | Domain | Size | Originating venue | Public artifact |
| --- | --- | --- | --- | --- |
| Mind2Web | Real websites | 2,350 tasks / 137 sites / 31 domains | NeurIPS 2023 (Datasets & Benchmarks) | <https://github.com/OSU-NLP/Mind2Web> |
| WebArena | Self-hosted realistic web apps (shopping, forums, software dev, etc.) | 812 long-horizon tasks | NeurIPS 2024 (Oral) | <https://webarena.dev/>, <https://github.com/web-arena-x/webarena> |
| WebArena Verified | WebArena with template-level macro averages, 95% CIs, failure-mode breakdown | derived from WebArena | OpenReview | <https://openreview.net/forum?id=94tlGxmqkN> |
| WebVoyager | 15 popular live websites | 643 tasks | arXiv 2401.13919 (2024) | <https://www.webvoyager.ai/leaderboard>, <https://github.com/David-Chen523/WebVoyager> |
| VisualWebArena | Visual (pixel-only) variant of WebArena | (WebArena-adjacent) | NeurIPS 2024 | (referenced via WebArena family) |
| GAIA | Mixed real-world assistant tasks (web, files, multimodal, reasoning) | 466 questions | arXiv 2311.12983 (2023) | <https://arxiv.org/abs/2311.12983>, <https://huggingface.co/spaces/gaia-benchmark/leaderboard> |
| OSWorld | Real desktop OS (Ubuntu / Windows / macOS) tasks via screenshots + accessibility trees | 369 → 435+ tasks | Xie et al. (HKU, CMU, Stanford) | <https://github.com/xlang-ai/OSWorld> |
| OSWorld-MCP / OSWorld-X | MCP-style action-server and cross-app diagnostic variant of OSWorld | derived | follow-up papers | (referenced via OSWorld repo) |
| AppWorld | Controllable sandbox of 9 day-to-day apps via a Python API | 1,000+ tasks / 750+ APIs | NeurIPS 2024 (Datasets & Benchmarks) | <https://appworld.dev/>, <https://github.com/StonyBrookNLP/appworld>, <https://arxiv.org/abs/2407.18901> |
| SeeAct | GPT-4V-grounded generalist web agent (paper + repo, not a benchmark per se) | reports 51.1% on live sites | arXiv 2401.01614 | <https://arxiv.org/abs/2401.01614>, <https://github.com/osu-nlp-group/seeact> |

Primary observation across L7: **none of these benchmarks measure "exploratory UX with diverse personas"**. They measure **task success under a fixed goal** on either a fixed set of tasks or fixed web sites. The "diverse Synthetic Users exploring without a prescribed goal" angle that is u-sekai's reason for existence is **not represented** in the current benchmark landscape — see Section 5.

### 4.7 Adjacent: "Generative Agents" / persona simulation

- Park et al. (2023), *Generative Agents: Interactive Simulacra of Human Behavior*, Stanford — 25 LLM-powered agents in a virtual town, with a memory stream, reflection, and planning architecture, exhibiting emergent social behavior.
- Public evidence: <https://arxiv.org/abs/2304.03442>, <https://generative-agents.stanford.edu/>.
- Primary observation: this is the **closest prior-art anchor** for u-sekai's Synthetic User concept, but it targets **open-ended social simulation** rather than **goal-directed Web exploration under measurable UX**. The persona / memory / reflection architecture is reusable in concept; the evaluation methodology is not.

---

## 5. Differences vs u-sekai's requirements (gap analysis)

u-sekai's distinguishing axes, taken from `README.md` and the draft R-01 / R-03 / R-05 / R-06 text, are:

| u-sekai axis | Current prior art coverage | Gap |
| --- | --- | --- |
| **Diverse Synthetic Users** (persona diversity = the core value) | Treated as **secondary** or **absent** in browser-agent harnesses; primary focus in *Generative Agents*-style social simulation | Existing browser agents are tuned to **single-persona success rate**; they do not model capability / perception / memory / preference / situation differences systematically |
| **Exploratory, not scripted** (no fixed goal) | Benchmarks (Mind2Web, WebArena, WebVoyager, OSWorld, AppWorld) all assume **a fixed instruction** per task | No existing benchmark measures **unguided exploration** as the primary signal |
| **Subjective UX as first-class output** (rating, free-form reflection, friction report) | LLM-as-judge exists in WebVoyager for success/failure classification, but **post-session subjective evaluation by the agent itself** is not a first-class pattern | u-sekai needs to design this — see R-05 |
| **Many parallel Synthetic Users in independent sessions** | First-party products (Operator, Computer Use, Mariner) are **single-session**; OSS harnesses (`browser-use`, `stagehand`, `skyvern`) are session-per-process with limited batch orchestration | R-04 (execution environment) candidate set needs to be evaluated against "many parallel" |
| **Persona-aware UI / accessibility simulation** (visual, motor, cognitive limitations) | None of the surveyed systems model accessibility constraints at the agent level; computer-use APIs can theoretically be configured to mimic them but no canonical pattern exists | This is u-sekai-specific value territory — see R-03 |
| **Calibration against real users** | Benchmarks calibrate **agent task success** against human task success, but not **Synthetic User behavior against real user behavior** under the same prompt | This is u-sekai-specific — see R-07 |
| **Reproducibility across many personas** | Browser-agent evaluation is typically reported as **aggregate** scores across tasks; persona-conditioned variance is rarely reported | New metrics / reporting shape needed |

### 5.1 What u-sekai can plausibly **reuse** (candidate, not adopted)

- **L1 substrate**: Playwright / Chromium for browser control; headless display + `pyautogui`/XTest for desktop; existing accessibility-tree libraries.
- **L2 isolation**: Browserbase / Steel / Hyperbrowser as candidate managed infrastructure for running many parallel synthetic users (per-browser-hour cost shape).
- **L3 harness primitives**: `act` / `extract` / `observe` / `agent`-style primitives (Stagehand) are a reusable design pattern for mixing AI natural-language actions with deterministic instrumentation (u-sekai will likely want deterministic instrumentation hooks for evaluation).
- **L4 runtime**: LangGraph's state / memory / control-flow primitives as a candidate for the orchestration layer; AutoGen / CrewAI as alternative candidates for persona-as-role patterns.
- **L5 model APIs**: Anthropic Claude Computer Use, OpenAI CUA, Google Gemini Computer Use as **candidate tool backends** — none of them is the obvious choice and the vendor landscape is in flux (Project Mariner was folded into Gemini products in 2026).
- **L7 evaluation environments as a substrate**: WebArena's self-hosted site replicas, Mind2Web's real-website annotation format, OSWorld's programmatic state checkers, AppWorld's Python API, and GAIA's mixed-reality task structure are all **plausible substrate components** for u-sekai's evaluation layer — but none of them is sufficient on its own, because none of them measures the persona-conditioned exploratory dimension.

### 5.2 What u-sekai must **build** (gap)

- **Persona / capability / perception / situation injection layer** — no existing system provides this as a first-class concept. Closest analog: role-based prompts in CrewAI / AutoGen, plus accessibility simulations in screen-reader integrations; both are thin and not systematized.
- **Exploration policy** — agent harnesses assume a goal; u-sekai needs to define what an agent does when the goal is "explore this Web app as a Synthetic User with profile X" (curiosity / coverage / failure-seeking behavior).
- **Subjective reporting channel** — post-session rating + free-form reflection + behavioral log; this is mostly an **R-05 design** task, but the L3 harness must expose the hooks.
- **Parallel-orchestration primitives** — existing runtimes support multi-agent but rarely **multi-isolated-environment-multi-persona** at research scale.
- **Synthetic-vs-real calibration methodology** — R-07.
- **Reporting / analysis surface** — u-sekai's value includes surfacing **unexpected usage patterns, mistakes, perception gaps, subjective UX**; this is a different reporting shape than the standard "task-success-rate" leaderboard.

---

## 6. Candidate sets (for downstream Issues to narrow)

> All wording below is **candidate**, not adopted. The role of R-01 is to put plausible candidates on the table so that R-03 / R-04 / R-08 can decide.

### 6.1 L1 substrate candidates

| Candidate | Pros | Cons |
| --- | --- | --- |
| Playwright | Cross-browser, modern API, dominant in L3 harnesses | None blocking |
| Puppeteer | Mature for Chromium-only | Chromium-only is a real constraint for "many real-world sites" |
| Selenium | Enterprise coverage | Heavier, slower, more brittle to modern SPAs |

### 6.2 L2 isolation candidates

| Candidate | Pros | Cons |
| --- | --- | --- |
| Browserbase | Mature, paired with Stagehand L3 candidate | Vendor cost; per-hour billing model |
| Steel | Hosted Chromium for agents | Smaller footprint; less ecosystem |
| Hyperbrowser | Comparable feature set | Smaller footprint |
| Self-hosted Chromium (Docker / K8s) | No vendor dependency; portable | Own the operational surface (cost, anti-bot, scaling) |

### 6.3 L3 harness candidates

| Candidate | Pros | Cons |
| --- | --- | --- |
| `browser-use` | LLM-agnostic; natural-language interface; active development | Single-persona in current shape |
| `stagehand` | Clean `act`/`extract`/`observe`/`agent` primitive set; deterministic+AI mix | Tight coupling to Browserbase substrate (though standalone use is possible) |
| `skyvern` | Workflow-block semantics good for structured exploration | Heavier on structured-workflow use, lighter on free exploration |
| OpenHands (web mode) | Mature agent runtime | SDLC-oriented, not user-experience-oriented |

### 6.4 L4 orchestration candidates

| Candidate | Pros | Cons |
| --- | --- | --- |
| LangGraph | Low-level, full control, strong state model | More engineering required up front |
| AutoGen | Multi-agent persona-friendly | Less explicit control flow |
| CrewAI | Role-based personas out of the box | Less control over long-running state |

### 6.5 L5 model-API candidates

| Candidate | Pros | Cons |
| --- | --- | --- |
| Anthropic Claude Computer Use | Stable API surface; well-documented tool calls | Closed model; cost shape tied to Anthropic pricing |
| OpenAI CUA | Strong reported benchmark numbers (38.1% OSWorld, 58.1% WebArena, 87% WebVoyager) | Vendor concentration; product surface evolving |
| Google Gemini Computer Use | Multimodal; Gemini capability continues even after Mariner wrapper was discontinued | Product roadmap instability (Project Mariner folded into Gemini products in 2026) |

### 6.6 L7 evaluation-environment candidates

| Candidate | Pros | Cons |
| --- | --- | --- |
| WebArena + WebArena Verified | Realistic web apps; reproducible; 812 tasks | Fixed-goal tasks; no persona dimension |
| Mind2Web | 137 real sites; 2,350 tasks | Real sites = reproducibility risk |
| WebVoyager | Live sites; visual observation native | Live-site drift; not persona-aware |
| OSWorld (+OSWorld-MCP / OSWorld-X) | Cross-platform desktop; programmatic state checkers | Desktop target is **not** u-sekai's initial Web scope (but future-proofing candidate) |
| AppWorld | Python-API controllable sandbox; 1,000+ tasks | Synthetic apps = limited realism |
| GAIA | Mixed modality; general-assistant-shaped | Not Web-specific |

---

## 7. Open questions / unresolved consequential decisions

The following items surfaced during the survey but require separate Issues or user escalation. They are recorded here so they are not lost.

1. **Dependency on a single first-party computer-use vendor** is risky: OpenAI CUA is closed, Anthropic's surface is stable but tied to its model roadmap, and Google's Project Mariner was discontinued and folded into Gemini products in 2026 (sources cited in Section 4.3). Does u-sekai target **model-API-agnostic** orchestration from day one? (Affects L4 / L5 design in R-03 / R-04.)
2. **Live websites vs self-hosted replicas** for evaluation (Mind2Web / WebVoyager use live; WebArena uses replicas; AppWorld uses synthetic). u-sekai's reproducibility / cost / safety trade-off is unresolved — feeds into R-04 (environment) and R-08 (MVP scope).
3. **Persona-conditioned benchmark** does not exist in the prior art. Should u-sekai contribute a public benchmark / dataset as part of the research infrastructure, or stay purely tool-side? (Affects R-06 and R-07.)
4. **Accessibility / capability injection** has no canonical pattern. The closest analog is screen-reader / motor-impairment simulation in academic HCI work — none of the surveyed browser-agent harnesses model it. This needs **R-03** to scope carefully before any L3 / L4 work begins.
5. **Subjective reporting by the agent itself** (LLM-as-self-judge) vs **external LLM-as-judge** (WebVoyager's approach for task success) vs **human rating** — the trade-off is well-known but unresolved for u-sekai; this is the central question for **R-05**.
6. **Generative Agents-style persona architecture** (Park et al., 2023) is the closest conceptual prior art for u-sekai's Synthetic User layer. The translation from open-ended social simulation to **goal-directed exploratory Web UX** is non-trivial — needs a dedicated design study before any persona library is built.
7. **Real-user data**: GAIA, WebArena, and Mind2Web were constructed against either task descriptions or crowdsourced annotations. Whether u-sekai needs to **collect new real-user behavior data** for calibration (R-07) is an unresolved cost / privacy / scope question.
8. **Project Mariner discontinuation** and Adept AI acquihire both suggest that **first-party browser-agent product surfaces churn fast**. This is **not** a blocker but should be reflected in R-04 and R-08 as a portability / lock-in risk.

---

## 8. References

### OSS libraries / harnesses

- `browser-use` — <https://github.com/browser-use/browser-use>, <https://browser-use.com/>, <https://docs.browser-use.com/cloud/quickstart>, <https://pypi.org/project/browser-use/>
- `stagehand` (Browserbase) — <https://github.com/browserbase/stagehand>, <https://stagehand.dev/>, <https://docs.stagehand.dev/v3/first-steps/introduction>, <https://www.browserbase.com/stagehand>
- `skyvern` — <https://github.com/Skyvern-AI/skyvern>
- OpenHands — <https://github.com/All-Hands-AI/OpenHands>

### Browser infrastructure

- Browserbase / Stagehand product page — <https://www.browserbase.com/stagehand>
- Skyvern's third-party Browserbase vs Stagehand comparison — <https://www.skyvern.com/blog/browserbase-vs-stagehand-which-is-better/>

### Low-level substrate

- Playwright / Puppeteer / Selenium comparison write-up — referenced in 2025 ecosystem comparisons on dev blogs.

### First-party computer-use platforms

- OpenAI Operator launch — <https://openai.com/index/introducing-operator/>
- OpenAI Computer-Using Agent (CUA) — <https://openai.com/index/computer-using-agent/>
- OpenAI Operator System Card (PDF) — <https://cdn.openai.com/operator_system_card.pdf>
- OpenAI Operator coverage — <https://techcrunch.com/2025/01/23/openai-launches-operator/>
- Anthropic Claude Computer Use documentation (vendor docs; widely cited)
- Google Project Mariner page — <https://labs.google.com/mariner/landing>
- Wired coverage of Mariner team reorganization — <https://www.wired.com/story/google-shakes-up-project-mariner-team-web-browsing-agents/>
- Digital Trends on Mariner discontinuation — <https://www.digitaltrends.com/computing/google-pulls-the-plug-on-project-mariner-the-ai-agent-that-browsed-the-web-like-a-human/>

### SaaS in the same niche

- MultiOn docs — <https://docs.multion.ai/welcome>
- MultiOn × LangChain announcement — <https://www.langchain.com/blog/multion-x-langchain-powering-next-gen-web-automation-navigation-with-ai>
- MultiOn personal-agent waitlist — <https://mail.multion.ai/p/personal-ai-agent>
- Adept Fuyu-8B announcement — <https://www.adept.ai/blog/fuyu-8b/>
- Adept Fuyu-Heavy announcement — <https://www.adept.ai/blog/adept-fuyu-heavy/>
- Adept update post-Amazon deal — <https://www.adept.ai/blog/adept-update/>
- Adept / Amazon coverage — <https://techcrunch.com/2024/06/28/amazon-hires-founders-away-from-ai-startup-adept/>
- `adept/fuyu-8b` on Hugging Face — <https://huggingface.co/adept/fuyu-8b>

### Agent runtime / orchestration

- LangGraph — <https://www.langchain.com/langgraph>, <https://docs.langchain.com/oss/python/langgraph/overview>
- LangChain 1.0 + LangGraph 1.0 — <https://www.langchain.com/blog/langchain-langgraph-1dot0>
- Deep Agents vs LangChain vs LangGraph — <https://www.langchain.com/blog/deep-agents-vs-langchain-vs-langgraph>
- AutoGen, CrewAI (official docs / GitHub; referenced widely)

### Benchmarks

- Mind2Web — <https://github.com/OSU-NLP/Mind2Web>, NeurIPS 2023 Datasets & Benchmarks track
- WebArena — <https://webarena.dev/>, <https://github.com/web-arena-x/webarena>, NeurIPS 2024 (Oral), <https://arxiv.org/abs/2307.13854>
- WebArena Verified — <https://openreview.net/forum?id=94tlGxmqkN>
- WebArena Leaderboard — <https://benchlm.ai/benchmarks/webarena>
- WebVoyager — <https://arxiv.org/abs/2401.13919>, <https://www.webvoyager.ai/leaderboard>, <https://github.com/David-Chen523/WebVoyager>
- GAIA — <https://arxiv.org/abs/2311.12983>, <https://huggingface.co/spaces/gaia-benchmark/leaderboard>, <https://openreview.net/forum?id=fibxvahvs3>
- OSWorld — <https://github.com/xlang-ai/OSWorld>
- AppWorld — <https://appworld.dev/>, <https://github.com/StonyBrookNLP/appworld>, <https://arxiv.org/abs/2407.18901>
- SeeAct — <https://arxiv.org/abs/2401.01614>, <https://github.com/osu-nlp-group/seeact>
- WebOlympus (EMNLP 2024 demo) — <https://aclanthology.org/2024.emnlp-demo.20.pdf>

### Adjacent: persona / social simulation

- Generative Agents (Park et al., 2023) — <https://arxiv.org/abs/2304.03442>, <https://generative-agents.stanford.edu/>

---

## 9. Status

This is a draft research artifact for R-01. No adoption / non-adoption decision is recorded here; per `CLAUDE.md` §3 and §5, those decisions belong to follow-up Issues (R-03, R-04, R-06, R-08) once they open and resolve. Open questions in Section 7 should be routed into those Issues.