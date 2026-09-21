# CLAUDE.md — project-local policy for u-sekai

> Dispatcher file for AI coding agents / AI agents.
> Detailed rules are progressively disclosed into `.claude/skills/` and the linked docs.
>
> This file is tuned for the **implementation phase**. The current release
> ships a functional vertical slice; the research backlog is tracked
> under [`docs/research-issues/`](./docs/research-issues/) and is not a
> release blocker.

---

## 1. Project identity / boundaries

- **Project name**: u-sekai
- **Vision**: Build a general-purpose research infrastructure that drives **Synthetic Users** (AI agents standing in for human users with diverse capabilities, perceptions, operating environments, memories, preferences, and situations) to **explore digital environments such as Web apps** in order to surface unknown usage patterns, mistakes, perception gaps, and subjective UX.
- **Initial target**: Web environments, but the concept itself is **not Web-limited**.
- **Current phase**: **implementation phase**. The functional MVP is shipping (see [`README.md`](./README.md) Quick Start, [`docs/architecture.md`](./docs/architecture.md), and ADR-0004..0007).
- **Non-goals**: replacement for fixed E2E tests; production traffic replay; lock-in to a single Web framework or SaaS; foundation-model-as-domain-model; auto-generated universal UX score.

See [`README.md`](./README.md) and [`CONTRIBUTING.md`](./CONTRIBUTING.md) for details.

## 2. Source / work SoT

| Concern | Canonical SoT |
| --- | --- |
| Released code / config / docs | Git `main` branch |
| Active investigation / design tasks | GitHub Issues |
| Task dependencies | GitHub Issue dependency graph |
| Long-lived design decisions | `docs/adr/`(not yet created; first ADR lands when a decision is finalized) |
| Draft research questions | `docs/research-issues/` |
| Pinned reference policy source | `.tmp/project-init/` at `release-0-1-1` (SHA `48432a73...`); see [`docs/rebuildup-pin.md`](./docs/rebuildup-pin.md) |

Conversation history, native session IDs, agent-private memory, local shell history — **none of these are SoT**.

## 3. Implementation-phase guardrails

- **Layer boundaries (ADR-0005, ADR-0006)** are enforced at compile time. Any direct import from `src/domain/**` or `src/capability/**` of a third-party SDK (Playwright, OpenAI, Anthropic SDK, langchain, ...) is forbidden by `eslint.config.js`.
- **Capability, action, and memory enforcement live in code, not in prompts.** A capability violation MUST be recorded as a typed event (`evidence-events`) and terminate the participant with `terminationReason: 'capabilityViolation'`.
- **Synthetic Users are not real users.** README and `docs/non-reality.md` carry the disclaimer; do not delete it in a refinement pass.
- **Reasoner provider boundary is HTTP-only.** No SDK lock-in inside `src/`. See ADR-0005.
- **CI never depends on external API keys.** Manual live-smoke is a separate `workflow_dispatch` workflow.
- **Research backlog (`docs/research-issues/`)** is not a release blocker; the functional MVP is. Do not regress implementation to research mid-release.

## 4. What to do in this phase

- Open GitHub Issues for behavioural changes that affect the public contract.
- Promote only **finalized** decisions to ADRs; drafts in `docs/research-issues/` are not ADRs.
- Implementation PRs follow the durable-issue workflow: one Issue = one ticket branch = one ticket PR; `release-*` aggregates to a single release PR.
- Tests covering capability enforcement, scripted Reasoner behaviour, and end-to-end CLI invocation are non-optional.

## 5. Engineering decision precedence

Resolve decisions in this order:

1. **project-wide policy / canonical architecture / invariant**(this file / `CONTRIBUTING.md` / `docs/adr/` when present / pinned [`rebuildup/project-init@release-0-1-1`](./docs/rebuildup-pin.md))
2. **design / specification / explicit task instruction**(Issue body / user instruction)
3. **coherent existing implementation majority**(currently a minority in this repo)
4. **current official framework / runtime / SDK guidance**(applies once language is decided)
5. established ecosystem convention
6. local best judgment

Within the same level, prefer the more specific and newer canonical source.

### Self-evident decisions — do not escalate

Make reversible, local decisions yourself when the precedence yields one answer and no public contract, security/privacy implication, cost implication, or release-scope change is involved.

### User escalation — escalate only real decisions

Escalate to the user only when:

- Canonical sources conflict and product semantics change
- Acceptance criteria allow materially different user-visible behavior
- Irreversible / destructive operation is involved
- A public / external API contract is being fixed
- Security / privacy / compliance risk must be accepted
- A meaningful cost increase is involved
- Release scope / date is changing
- An explicit design-first approval gate is requested

When asking, investigate discoverable facts first and present options, impact, and a recommendation.

## 6. Branch / release policy (direction only)

- Normal sprint length: **one week**.
- Each sprint creates `release-<major>-<minor>-<patch>` from `main`.
- Ticket branches are **Issue number only** (no `issue/` prefix, slug, or title).
- One top-level Issue = one durable ticket branch = one ticket PR.
- Issue dependency graph is the canonical dependency SoT.
- Independent ticket PRs target the release branch.
- Same-release linear hard dependencies may use the immediate predecessor ticket branch as PR base.
- After public-repo enablement, the **only** canonical path to `main` is `release-x-y-z -> main` release PR.

> Note: this repository has not yet enabled `main` protection or the release workflow. When it does, this file and `CONTRIBUTING.md` will be updated in the same change.

### Merge authorization vs. PR readiness (mandatory)

Per the pinned rebuildup policy (ADR-0012 in upstream):

- **PR quality / readiness** is a separate state from **merge authorization**.
- Agent / subagent / Coordinator / Supervisor may perform merge, squash merge, rebase merge, stacked landing, auto-merge enablement, or equivalent **only** when the user explicitly authorizes merge/landing for the identified PR or a clearly bounded PR set.
- "Review this", "handle this", "fix the conflict", "CI is green", "approval received", "Ready / mergeable state", or other generic completion cues are **not** merge authorization.
- Without explicit authorization, stop at **ready-to-merge** and report: PR identity, current head SHA, gate state, blockers.
- Do **not** carry authorization across PRs. Re-validate if head / base / target release / scope changes materially after authorization.

This rule applies to all AI agents touching this repository.

## 7. Language policy (u-sekai override)

The pinned upstream policy defaults internal docs / Issues / PRs to Japanese. u-sekai **overrides** that because the project is internationally oriented (Product Hunt and similar channels).

| Concern | Language |
| --- | --- |
| Source code(filename, identifier, comment, log, config identifier) | English |
| Commit message | English `<work-prefix>: <extremely concise title>` |
| `README.md` / `CONTRIBUTING.md` / `CLAUDE.md` / u-sekai-authored docs | English |
| GitHub Issue title / body | English |
| PR title / body / review discussion | English |
| `.claude/skills/*.md` (upstream-authored Skills) | **Japanese (upstream default — deliberate exception)** |
| Branch names | identifier / version only |

If a contributor prefers Japanese for a specific file, that is fine locally but should not block international review.

> The Skills under `.claude/skills/` are currently kept in Japanese because they are direct copies from the pinned upstream `rebuildup/project-init@release-0-1-1` source. Translating them risks semantic drift relative to the pinned reference. Translation is tracked as a follow-up research issue (R-09 in [`docs/research-issues/README.md`](./docs/research-issues/README.md)) and is **not** part of this init commit.

## 8. Skill discovery

This file plus the relevant Skill under `.claude/skills/` are the only documents to read for a normal task. Do not re-read the upstream `PROMPT.*.md` files from `.tmp/project-init/` on every task — they are reference material, not per-task context.

All 14 Skills from the pinned upstream source are installed under `.claude/skills/`. Load only the Skills relevant to the current task.

| Skill | Purpose |
| --- | --- |
| `engineering-decisions` | Decision precedence, naming/design/ADR/dependency adoption, compatibility, escalation |
| `design-refinement` | Evidence reading, fact/decision separation, dependency-aware decision frontier |
| `writing-discipline` | Select → Compose → Reread: convert context dumps to reader-oriented artifacts |
| `interaction-discipline` | Preserve agent-owned work, present verified state / blockers / dependencies actionably |
| `github-delivery` | Issue / PR / weekly release / stacked PR / Draft PR lifecycle / merge authorization separation |
| `linear-release-control` | Optional Linear profile for release planning / health reconciliation |
| `parallel-orchestration` | Subagent decomposition, snapshot/result, stack-ready dependency integration |
| `sandbox-runtime` | Isolated runtime and cross-platform portability |
| `worktree-workflow` | Worktrunk-based WSL/Linux worktree operations, project-local hooks, host port/process lifecycle |
| `quality-gate` | Stack-aware quality profile, current-SHA revalidation, verification taxonomy, GitHub Actions efficiency |
| `policy-evaluation` | Execution profile, deterministic/latent policy eval, blind comparative evaluation, context budget |
| `security-maintenance` | Framework/runtime vulnerability intake / triage / remediation |
| `onboarding` | Fresh contributor / fresh agent onboarding, repository-controlled knowledge design |
| `agent-recovery` | Session / sandbox / context interruption recovery |

The Skills are written in Japanese (see Section 7 for the rationale). When reconciling with upstream, compare against `.tmp/project-init/skills/`.

Do **not** introduce CI workflow / formatter / lint / type-check / `Containerfile` / `.py` script until the implementation language is decided and implementation artifacts exist.

## 9. Secret / temporary / reference policy

- No secrets in commits, logs, snapshots, or agent results. The Anthropic API key (and any future provider key) is consumed via `process.env` only and **never** written to artifact files.
- Real env files: `.env` / `.env.development` / `.env.production` — never committed.
- Examples: `.env.example` etc. — allowed to commit.
- Temporary artifacts: `.tmp/`(gitignored).
- External reference repositories: `.reference/`(gitignored).
- Do not add new `.py` scripts for automation, generation, migration, validation, build/test support, or temporary analysis. Use TypeScript / JavaScript / shell / the project's actual implementation language instead. The implementation language is **TypeScript (ESM, NodeNext)** per ADR-0004.

## 10. Idempotent reconciliation

This file / Skills / templates / Issue configuration is **idempotent reconciliation**. Do not regenerate correct state; only update what differs. When updating a Skill, verify the canonical source under `.tmp/project-init/skills/` and reconcile if the pinned ref has changed.

---

## References (progressive disclosure)

- [`.claude/skills/`](./.claude/skills/) — all installed skills (see Section 8 for the list)
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — contribution policy (research / design phase)
- [`README.md`](./README.md) — vision / non-goals / current status
- [`docs/research-issues/`](./docs/research-issues/) — draft research questions
- [`docs/rebuildup-pin.md`](./docs/rebuildup-pin.md) — pinned rebuildup/project-init source
- `docs/adr/` — long-lived design decisions(not yet created)