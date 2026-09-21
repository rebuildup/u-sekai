# Contributing

u-sekai is in the **implementation phase**. The 0.1.0 functional MVP
ships a complete vertical slice; the research backlog
(`docs/research-issues/`) continues in parallel and is open for
contribution.

This document covers Issue / PR conventions, code expectations, and the
release workflow.

---

## 1. Communication language

u-sekai is internationally oriented (e.g. Product Hunt and similar channels), so **English is the default** for:

- GitHub Issue title and body
- PR title, body, and review discussion
- `README.md` / `CONTRIBUTING.md` / `docs/` / ADR

Source code and commit messages will also be English once implementation begins. Japanese (or any other language) is fine for personal notes but should not block international review.

This is a deliberate **override** of the pinned upstream policy's "internal docs in Japanese" convention. See [`docs/rebuildup-pin.md`](./docs/rebuildup-pin.md) for the override record.

## 2. What you can contribute

- Implementation changes that keep the capability / action / memory
  boundaries in the runtime layer (see ADR-0006 and
  [`docs/architecture.md`](docs/architecture.md)).
- New `Reasoner` providers that follow ADR-0005 (HTTP only; no SDK
  lock-in inside `src/`).
- New `BrowserAdapter` implementations that expose only the human-facing
  primitives to participants.
- New self-contained demo environments alongside `src/demo/environment/`.
- Documentation, ADRs, and research-issue drafts.
- CI / quality-gate improvements that keep CI self-contained.

Out of 0.1.0 scope (still useful, but do not land on a release branch
without an explicit umbrella Issue):

- Real-user calibration, automatic persona generation, multi-provider
  matrices, accessibility simulation, advanced cognitive / forgetting
  models, GUI dashboards, Firecracker / Kubernetes, distributed
  execution.

## 3. GitHub Issue workflow

We follow the pinned rebuildup policy: **GitHub Issues are the durable work / dependency SoT**.

### Opening an Issue

- Search existing drafts in `docs/research-issues/` and open Issues first to avoid duplicates.
- Use one of the templates in `.github/ISSUE_TEMPLATE/`:
  - `research-question.md` — open questions / comparisons to make
  - `investigation.md` — concrete investigation steps
- Title and body must be in **English**.
- Include purpose, acceptance criteria, scope / non-scope, dependencies, target phase, and (when relevant) accountable assignee.
- Implementation issues should reference the relevant ADR(s) and call out which capability axes change.

### Dependencies

- Hard dependencies between Issues must be declared in the Issue body and added to the GitHub Issue dependency graph.
- Branch topology alone is **not** a substitute for dependency management.

### Closing

- Close an Issue when the conclusion is captured in `docs/` (or promoted to an ADR when the decision is long-lived).
- If work is split, keep cross-references between the original Issue and the split Issues.

## 4. Pull Request workflow

> Implementation PRs are not expected in this phase, but small documentation / template / Skill improvements may produce PRs. The basic rules below cover those.

- One PR = one Issue (or one obvious docs fix).
- Branch names are **Issue number only**: `42`. No `issue/` prefix, no slug, no title.
- Until `main` protection is enabled on the public repository, contributors may push directly. Once enabled, only `release-x-y-z -> main` release PRs may land on `main`.
- PR title and body are **English**.
- PRs must include:
  - Linked Issue
  - Assignee
  - Reviewer (or a note that no meaningful reviewer exists, with the alternate review path such as CI / explicit final review)
  - Acceptance criteria and validation evidence

### Merge authorization (mandatory)

PR quality / readiness and merge authorization are **separate states**. An agent (AI or human) may merge / squash / rebase / enable auto-merge **only** when the user has explicitly authorized merge/landing for the identified PR. Generic completion cues ("CI is green", "Ready", "approved", "fix the conflict", "handle this PR") are **not** authorization. Without explicit authorization, stop at **ready-to-merge** and report the PR identity, current head SHA, gate state, and blockers.

## 5. Design discussion

- Major design changes start in GitHub Discussions / Issue threads before any decision is recorded.
- Finalized decisions become ADRs in `docs/adr/`. Until the first ADR lands, that directory does not exist.
- Do not record undecided items as "planned specification".

## 6. AI coding agent contributions

- AI coding agents must follow this document and [`CLAUDE.md`](./CLAUDE.md).
- Do not depend on global plugin state, home-directory hidden rules, or undocumented machine-specific state.

## 7. Code of conduct

- This is a small, research-oriented project.
- Mutual respect for research perspectives and design opinions. Evidence-based disagreement is welcome.
- Disruptive, harassing, or discriminatory behavior is not tolerated.

---

This document is updated as the research phase progresses.