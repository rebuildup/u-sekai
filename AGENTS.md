# AGENTS.md — u-sekai agent dispatcher

This repository follows the project-local development organization defined by:

1. [`constitution/CONSTITUTION.md`](./constitution/CONSTITUTION.md) — top-level organizational guarantees.
2. [`organization/profiles/release-driven-solo.md`](./organization/profiles/release-driven-solo.md) — current release-driven Operating Model.
3. [`CLAUDE.md`](./CLAUDE.md) — project-specific contract, architecture boundaries, language policy, release workflow, and Skill routing.

Do not copy the full upstream initialization prompt into this file. Load only the project-local Skill needed for the current task from `.claude/skills/`.

u-sekai intentionally uses English for project-authored documentation, GitHub Issues, Pull Requests, and review discussion. Upstream-authored Skills remain verbatim Japanese copies. When local procedure and upstream defaults differ, preserve explicit u-sekai ADRs while maintaining the Constitution.


## Agent Skills lifecycle

project-init 由来の Agent Skills は **project-local** に管理し、global install を canonical にしない。

- 初回導入 / 全体 reconcile: `bunx skills add rebuildup/project-init --skill '*' --agent claude-code opencode codex -y`
- fresh clone から lock を復元: `bunx skills install`
- 継続更新: `bunx skills update -p -y`
- `skills-lock.json` は `skills` CLI が生成・更新する source/freshness metadata として commit する。手で hash / source entry を捏造しない。
- upstream-managed Skill 本文は手編集しない。project 固有の refinement / override は別の project-local Skill、adapter、ADR、docs に置き、次回 update で上書きされない構造にする。
- update 後は Git diff と applicable quality gate を確認し、upstream 更新を無条件に current project policy とみなさない。

Bun はここでは Agent Skills 管理用の project tooling であり、product runtime / package manager の既存 decision を自動的に置換しない。
