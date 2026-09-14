# Contributing

u-sekai is a **research / design phase** project. Implementation contributions are not yet accepted; instead, we welcome **participation in the research and design discussion** and **pointers to relevant literature and existing work**.

This document covers how to join the conversation and how Issues / PRs flow through GitHub. It will be extended with implementation guidelines once the design phase closes.

---

## 1. Communication language

u-sekai is internationally oriented (e.g. Product Hunt and similar channels), so **English is the default** for:

- GitHub Issue title and body
- PR title, body, and review discussion
- `README.md` / `CONTRIBUTING.md` / `docs/` / ADR

Source code and commit messages will also be English once implementation begins. Japanese (or any other language) is fine for personal notes but should not block international review.

This is a deliberate **override** of the pinned upstream policy's "internal docs in Japanese" convention. See [`docs/rebuildup-pin.md`](./docs/rebuildup-pin.md) for the override record.

## 2. Contributions welcome in this phase

- Adding references (papers, OSS, benchmarks, blog posts, talks) to the drafts in [`docs/research-issues/`](docs/research-issues/)
- Proposing new research questions (file an Issue using `research-question.md`, or add a draft to `docs/research-issues/`)
- Proposing investigation steps (file an Issue using `investigation.md`)
- Refining terminology, scope, and non-scope statements
- Reviewing and updating existing drafts

**Implementation contributions (code, configs, CI changes, etc.) are not accepted in this phase.** The architecture and language are still undecided.

## 3. GitHub Issue workflow

We follow the pinned rebuildup policy: **GitHub Issues are the durable work / dependency SoT**.

### Opening an Issue

- Search existing drafts in `docs/research-issues/` and open Issues first to avoid duplicates.
- Use one of the templates in `.github/ISSUE_TEMPLATE/`:
  - `research-question.md` — open questions / comparisons to make
  - `investigation.md` — concrete investigation steps
- Title and body must be in **English**.
- Include purpose, acceptance criteria, scope / non-scope, dependencies, target phase, and (when relevant) accountable assignee.

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