# CLAUDE.md — project-local policy for u-sekai

> Dispatcher file for AI coding agents / AI agents.
> Detailed rules are progressively disclosed into `.claude/skills/` and the linked docs.
>
> This file is tuned for the **research / design phase**. It will be recomposed when implementation begins.

---

## 1. Project identity / boundaries

- **Project name**: u-sekai
- **Vision**: Build a general-purpose research infrastructure that drives **Synthetic Users** (AI agents standing in for human users with diverse capabilities, perceptions, operating environments, memories, preferences, and situations) to **explore digital environments such as Web apps** in order to surface unknown usage patterns, mistakes, perception gaps, and subjective UX.
- **Initial target**: Web environments, but the concept itself is **not Web-limited**.
- **Current phase**: **research / design phase**. Implementation has not started.
- **Non-goals**: replacement for fixed E2E tests; production traffic replay; lock-in to a single Web framework or SaaS.

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

## 3. What NOT to do in this phase

- Treat any undecided item (programming language, framework, runtime, SDK, browser automation library, agent SDK, model provider, directory structure, package layout) as **adopted** before the corresponding research Issue is resolved.
- Write undecided items in `README.md` / `docs/` as "planned specification".
- Prematurely introduce formatter, lint, type-check, CI workflow, `Containerfile`, `.py` script, or other tooling while the implementation language is still undecided.
- Produce a hypothetical / spike implementation before the corresponding design decision is finalized.
- Prioritize "writing code quickly" over "keeping later design exploration possible".

## 4. What to do in this phase

- Open GitHub Issues for research questions; update the drafts in `docs/research-issues/`.
- Add references to existing research / OSS / case studies / benchmarks to Issues / discussions.
- Promote only **finalized** decisions to ADRs(drafts do not become ADRs).
- Accept contributions to docs / Issues / templates / Skills only. Implementation contributions are not accepted yet.

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
| Internal development docs | English |
| `README.md` / `CONTRIBUTING.md` | English |
| GitHub Issue title / body | English |
| PR title / body / review discussion | English |
| Branch names | identifier / version only |

If a contributor prefers Japanese for a specific file, that is fine locally but should not block international review.

## 8. Skill discovery

This file plus the relevant Skill under `.claude/skills/` are the only documents to read for a normal task. Do not re-read the upstream `PROMPT.*.md` files from `.tmp/project-init/` on every task — they are reference material, not per-task context.

Currently installed Skills(phase-appropriate subset):

- [`.claude/skills/engineering-decisions/`](./.claude/skills/engineering-decisions/SKILL.md) — decision precedence, user escalation, "what not to decide yet"
- [`.claude/skills/github-delivery/`](./.claude/skills/github-delivery/SKILL.md) — Issue / PR / weekly release / Draft PR lifecycle / merge authorization separation
- [`.claude/skills/onboarding/`](./.claude/skills/onboarding/SKILL.md) — fresh contributor / fresh agent onboarding, repository-controlled knowledge design

Additional Skills exist in the pinned upstream source at `.tmp/project-init/skills/` (e.g. `quality-gate`, `sandbox-runtime`, `agent-recovery`, `security-maintenance`, `parallel-orchestration`, `policy-evaluation`, `design-refinement`, `writing-discipline`, `interaction-discipline`, `linear-release-control`, `worktree-workflow`). **Install them only when the phase actually needs them**, not before.

Do **not** introduce CI workflow / formatter / lint / type-check / `Containerfile` / `.py` script until the implementation language is decided and implementation artifacts exist.

## 9. Secret / temporary / reference policy

- No secrets in commits, logs, snapshots, or agent results.
- Real env files: `.env` / `.env.development` / `.env.production` — never committed.
- Examples: `.env.example` etc. — allowed to commit.
- Temporary artifacts: `.tmp/`(gitignored).
- External reference repositories: `.reference/`(gitignored).
- Do not add new `.py` scripts for automation, generation, migration, validation, build/test support, or temporary analysis. Use TypeScript / JavaScript / shell / the project's actual implementation language instead.

## 10. Idempotent reconciliation

This file / Skills / templates / Issue configuration is **idempotent reconciliation**. Do not regenerate correct state; only update what differs. When updating a Skill, verify the canonical source under `.tmp/project-init/skills/` and reconcile if the pinned ref has changed.

---

## References (progressive disclosure)

- [`.claude/skills/engineering-decisions/`](./.claude/skills/engineering-decisions/SKILL.md)
- [`.claude/skills/github-delivery/`](./.claude/skills/github-delivery/SKILL.md)
- [`.claude/skills/onboarding/`](./.claude/skills/onboarding/SKILL.md)
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — contribution policy (research / design phase)
- [`README.md`](./README.md) — vision / non-goals / current status
- [`docs/research-issues/`](./docs/research-issues/) — draft research questions
- [`docs/rebuildup-pin.md`](./docs/rebuildup-pin.md) — pinned rebuildup/project-init source
- `docs/adr/` — long-lived design decisions(not yet created)