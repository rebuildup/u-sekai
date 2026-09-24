# R-09 — Translation of upstream Skills into English (and the future language policy)

## Question (from draft)

Decide whether / how to translate the 19 Skills under `.claude/skills/` (currently Japanese, copied verbatim from the pinned `rebuildup/project-init@release-0-3-0` source) into English, and how to keep them in sync with future upstream revisions.

## Investigation summary

### What was covered

- **Project-side state**: confirmed the 19 Skills are identical copies from `.tmp/project-init/skills/`; the pin in `docs/rebuildup-pin.md` records `release-0-3-0` SHA `57fb4a2e5abe6f52e4fd9cb2cb88234496e47d4b`; ADR-0002 explicitly carves out the Skills as a deliberate exception to the English-only language policy; `CLAUDE.md` Section 7 restates the exception.
- **Skill-by-skill description audit**: read the YAML frontmatter of all 19 installed Skills. 17/19 have a Japanese `description` field; 2/19 (`interaction-discipline`, `writing-discipline`) already have an English `description`. 0/14 have an English body.
- **Upstream model**: confirmed upstream's own translation convention is `{name}.{lang}.md` (e.g., `PROMPT.ja.md` / `PROMPT.en.md`, `CODEX_ROLES.ja.md` / `CODEX_ROLES.en.md`). Upstream's Japanese is the primary specification; Skills themselves are not localized in upstream at `release-0-3-0`.
- **Skills specification**: confirmed the public Skill format (`vercel-labs/skills`, Anthropic Skills best-practices) requires only `name` and `description` in YAML frontmatter, ships one `SKILL.md` per skill directory, and has no built-in i18n / locale mechanism. `npx skills add` / `bunx skills add` resolve a single canonical `SKILL.md`.
- **External precedent**: surveyed three public OSS projects that ship bilingual skills (`foreverse-app/character-card-skills`, `ForceInjection/awesome-skills`, `aiskillstore/marketplace/skill-i18n`).

### What was skipped and why

- **Per-language audience size measurement**: u-sekai is pre-launch, so no production telemetry exists. A reader audience assumption is necessary and is recorded as an open question.
- **Full machine-translation benchmark across all 19 Skills**: outside the scope of a policy decision. Translation quality itself is a downstream implementation concern once the policy is chosen.
- **Alternative translation paths not tied to upstream pin (e.g., fork upstream entirely)**: outside the explicit non-scope ("re-organizing or rewriting Skill content").
- **Upstream GitHub Issue search for prior translation discussion**: the visible issue search returned no matching discussions at the time of investigation.

### Methodology notes

- All evidence below comes from public sources (GitHub repos, Anthropic platform docs, OSS projects).
- The current policy precedence for this question is `CLAUDE.md` §7 (override of upstream) → ADR-0002 (English-primary, Skills excepted) → draft R-09 (this document) → Skills specification → external precedent.
- This document follows the R-09 framing as a **survey**, not an adoption. Candidate options are listed but not "decided".
- "Drift budget" is treated as a real cost dimension because the Skills are a normative policy contract — silent semantic change would propagate into agent behavior.

## Key findings with evidence

### F1. The current Skills exception is already creating an asymmetry that affects discovery, not just readability

The Skills YAML `description` field is pre-loaded into the agent's system prompt and is the primary signal Claude uses to decide which Skill to invoke (Anthropic Skill authoring best-practices, "Writing effective descriptions"). Of the 19 installed Skills, 12 still carry Japanese `description` strings; only `interaction-discipline` and `writing-discipline` have English descriptions. This means an English-only Claude population has reduced ability to discover the other 12 Skills at all — even an agent that reads Japanese fluently will only match the description text semantically. The asymmetry is partial, not binary.

### F2. The upstream policy contract uses a parallel-file convention for translation, but does not localize Skills

The upstream `rebuildup/project-init` repository already establishes the `{name}.{lang}.md` pattern:

- `PROMPT.ja.md` (primary specification, Japanese) and `PROMPT.en.md` (English, "same operational semantics")
- `docs/roles/CODEX_ROLES.ja.md` and `CODEX_ROLES.en.md`

The README states: "日本語版。primary specification" for `PROMPT.ja.md`. The Skills directory `skills/<name>/SKILL.md` is shipped in a single language only at the pinned ref.

Implication for u-sekai: there is a **precedent within the same policy family** for parallel-file translation of normative documents. Applying the same convention to Skills would be internally consistent with upstream's own approach for `PROMPT` / `CODEX_ROLES`.

### F3. The Skills specification and CLI have no built-in i18n mechanism

- `vercel-labs/skills` resolves skills by walking directories looking for `SKILL.md`. The unit of discovery is the directory, not a specific file. There is no documented locale suffix or frontmatter `language` field (Anthropic Skills best-practices lists only `name` and `description` as required, with `metadata.internal: true` as the only optional field).
- `npx skills add <owner>/<repo>` copies whatever `SKILL.md` exists; a parallel `SKILL.en.md` would not be auto-discovered by the Skills CLI without a wrapper rule.
- A pure "frontmatter language field" approach would not match how the Skills CLI discovers files today.

### F4. Public OSS precedent exists for parallel `SKILL.<lang>.md` files, with two filename variants

- `foreverse-app/character-card-skills` and similar projects use `SKILL-en.md` (hyphen separator), with the Chinese `SKILL.md` linking to its mirror at the top via `> English version: [SKILL-en.md](SKILL-en.md)`.
- `ForceInjection/awesome-skills` uses a `Bilingual convention` section in `CLAUDE.md` stating: "Every Chinese-facing document has an English counterpart named with a `-en` suffix, and vice versa (`README.md` ↔ `README-en.md`, `SKILL.md` ↔ `SKILL-en.md`)". Cross-language links appear only as top-of-document language switchers, with internal links kept monolingual.
- `aiskillstore/marketplace/skills/guo-yu/skill-i18n` recommends `SKILL.{lang-code}.md` (e.g., `SKILL.ja.md`, `SKILL.ko.md`) and stores per-skill language preferences in `~/.claude/skill-i18n-config.json`. Its sync mechanism is "only translate when source file is newer than translations", with an `--overwrite` flag.

### F5. The Skills at the pinned ref already show non-uniform translation upstream — a drift signal

If the upstream has already changed two Skills to English descriptions while leaving the others in Japanese, a downstream translation effort will inherit a moving target. The drift between installed and upstream is `0` today (the pin holds), but the drift *within* upstream's own strategy is non-zero: translation is not a single decision upstream is making, it is happening organically per-Skill.

### F6. The Skills are a normative policy contract under the pinned-pin model

Per ADR-0001 (pin policy) and `docs/rebuildup-pin.md`:

- "Skill content" is copied verbatim from the pinned ref to "avoid semantic drift relative to the pinned reference".
- Future upgrades require an explicit ADR and manual reconciliation.
- "If the local clone's HEAD SHA differs from the pinned SHA … break the pin. Do not silently use the new SHA."

Any translation effort that touches the installed Skills must coexist with this pin contract. Translating `SKILL.md` in place would immediately break the verbatim-copy invariant. Translating into a parallel file preserves the invariant.

## Comparison tables

### Table A: Candidate translation scope

| Option | Scope | Skill CLI discovery | Drift surface | Maintenance cost | Reader coverage |
| --- | --- | --- | --- | --- | --- |
| **A1. No translation (status quo)** | None | Works (description remains Japanese) | None | Zero | International readers blocked; English-only Claude populations get reduced discovery for 12/19 Skills |
| **A2. Translate `description` frontmatter only** | 12 fields (2 already English) | Works (English descriptions) | Low (a few sentences per Skill) | Low (one line per Skill) | Discovery works; body still Japanese |
| **A3. Parallel `SKILL.en.md` per Skill** | Full bilingual, all 19 Skills | Does not auto-discover `.en.md`; needs a wrapper or human convention | High (two surfaces to keep in sync) | Medium-high (re-translate on upstream change) | Full body in English; Japanese preserved as canonical |
| **A4. Replace `SKILL.md` in place with English** | Full body | Works | Maximum (immediately breaks the verbatim-copy invariant) | Medium | Single source, English; loses the upstream contract |
| **A5. Translate by Skill priority (subset)** | 4–6 of 19 Skills (e.g., `writing-discipline`, `design-refinement`, `engineering-decisions`, `github-delivery`, `onboarding`, `interaction-discipline`) | Works for the chosen subset | Medium (partial surface) | Medium | Covers the Skills most likely to be read by international contributors in the research/design phase |

Rows = candidate options. Columns = capability / cost / reproducibility / safety / latency / portability proxy as required by R-09 template. None of these options is "adopted" — they are candidates for the follow-up Issue(s) opened if translation begins.

### Table B: Candidate sync protocols (assumes a parallel-file translation is in place)

| Protocol | Translation latency after upstream change | Drift exposure | Human attention cost |
| --- | --- | --- | --- |
| **B1. Immediate re-translate per upstream change** | None | Minimal | High (every upstream commit on a Skill triggers a translation PR) |
| **B2. Batched re-translate at sprint boundary** (release-x-y-z) | Up to one week | Bounded | Medium |
| **B3. Re-translate only when a translation-affecting delta appears in the diff** | Variable; usually short | Depends on diff-detection rule | Medium-low |
| **B4. Translate once, freeze against the pinned SHA; re-translate only on pin upgrade** | Until pin upgrade | Higher (but bounded by pin upgrade cadence) | Low |

### Table C: Candidate filename conventions for parallel translation

| Convention | Example | Precedent | Link / discoverability | Compatible with `skills` CLI |
| --- | --- | --- | --- | --- |
| **C1. `SKILL.<lang>.md` (dot suffix)** | `SKILL.en.md` | `aiskillstore/marketplace/skill-i18n`, upstream's own `PROMPT.en.md` / `CODEX_ROLES.en.md` | Need an explicit convention | No (CLI does not auto-resolve) |
| **C2. `SKILL-<lang>.md` (hyphen suffix)** | `SKILL-en.md` | `foreverse-app/character-card-skills`, `ForceInjection/awesome-skills` | Need an explicit convention | No (CLI does not auto-resolve) |
| **C3. Parallel tree `skills-en/<name>/SKILL.md`** | `skills-en/writing-discipline/SKILL.md` | None found in surveyed projects | Tree-isolated; easier to ignore in tooling | No (CLI does not auto-resolve) |
| **C4. In-place replacement** | `SKILL.md` (English) | None | Single source | Yes (CLI works out of the box) |

All three parallel-file options (C1–C3) require an explicit convention in `CLAUDE.md` and a manual or wrapper-driven discovery rule, because the Skills CLI does not auto-resolve them today.

## Differences vs u-sekai requirements (gap analysis)

| u-sekai requirement | Current state | Gap |
| --- | --- | --- |
| Repository-internal docs in English (ADR-0002, `CLAUDE.md` §7) | Skills remain Japanese (deliberate exception) | Conflict between policy intent and current artifact language |
| International contributors can onboard without Japanese | Skills unreadable without machine translation or bilingual reviewer | Partial blocker; particularly affects contributors reading `writing-discipline`, `interaction-discipline`, `design-refinement`, `onboarding` |
| English-only Claude populations can discover Skills | 17/19 `description` fields are Japanese | Discovery skew — agents may not trigger Skills whose `description` they cannot parse |
| Skills remain byte-identical to pinned upstream ref | Satisfied today via verbatim copy | Translation in place would break this; parallel files preserve it |
| Sync protocol against upstream pin upgrades (ADR-0001, `docs/rebuildup-pin.md`) | None defined for translation | Gap; needs to be defined before translation begins |

## Candidate set recommendations

These are **candidate recommendations**, expressed in the R-09 draft's required vocabulary. They are not "adopted" / "decided" / "planned specification".

### Recommendation 1: Translate the `description` frontmatter field for all 19 Skills, regardless of body translation choice

- This is the lowest-cost, highest-leverage candidate: a single sentence per Skill that is loaded into every Claude session.
- Matches what the upstream `interaction-discipline` and `writing-discipline` already do.
- Does not require a new filename convention.
- Could be merged into the existing Skills verbatim-copy by treating English descriptions as a u-sekai-owned override (parallel `SKILL.en.md`, or an explicit u-sekai ADR extending the override table in `docs/rebuildup-pin.md`).

### Recommendation 2: For full-body translation, prefer parallel `SKILL.en.md` (option C1) over in-place replacement

- Preserves the pinned-pin verbatim-copy invariant from ADR-0001 and `docs/rebuildup-pin.md`.
- Aligns with upstream's own `{name}.{lang}.md` convention used for `PROMPT` and `CODEX_ROLES`.
- The hyphen form (C2) is also viable; selection is a stylistic choice that should match upstream's existing precedent rather than introducing a new pattern.

### Recommendation 3: Consider partial translation by Skill priority rather than all-or-nothing

- In the current research/design phase, the Skills most likely to be read by international contributors are the ones that frame writing, design, interaction, onboarding, engineering decisions, and GitHub delivery — not the runtime/operational Skills (`sandbox-runtime`, `worktree-workflow`, `security-maintenance`, `agent-recovery`, `parallel-orchestration`), which are most relevant once implementation begins.
- Translating only the framing Skills keeps the drift surface small while covering the audience need.

### Recommendation 4: Adopt a sync protocol of "translate once, freeze against pinned SHA, re-translate on pin upgrade" (option B4) as the default, with an option to switch to B2 (sprint-boundary batch) if upstream Skill churn turns out to be high

- Defaulting to B4 keeps translation work tied to explicit pin-upgrade decisions, which already require an ADR per `docs/rebuildup-pin.md`. This avoids the failure mode of frequent small translation PRs that risk introducing silent semantic drift.
- B2 (sprint boundary) is a reasonable fallback if upstream's Skill revision cadence proves to be higher than expected — but it is a meaningful change to the pin policy and should be raised as an ADR if selected.

### Recommendation 5: Translation process — manual PR with human review, machine translation allowed only as a draft

- This matches the "skills are a normative policy contract" framing. Machine translation as a starting point is fine; final commit requires a human reviewer who can confirm operational semantics.
- "Coordinated upstream PR" (changing upstream to be English-first) is a candidate future path but requires coordination with the upstream maintainer and is treated as an open question rather than a current recommendation.

### Recommendation 6: Required follow-up Issue(s) when translation begins

If the project decides to begin translation, the following sub-Issues should be opened (per the R-09 acceptance criteria):

1. **R-09a — Translate `description` frontmatter for all 19 Skills**: 12 strings to translate, no filename convention required.
2. **R-09b — Establish `SKILL.en.md` parallel-file convention (filename + linking rule)**: locks in C1 (or C2) before any body translation begins, to prevent filename divergence.
3. **R-09c — Translate the priority subset of Skills** (full body): `writing-discipline`, `design-refinement`, `interaction-discipline`, `engineering-decisions`, `github-delivery`, `onboarding` are the candidate priority set based on likely international-reader surface during research/design phase.
4. **R-09d — Define sync protocol against pin upgrades**: codify B4 (default) / B2 (fallback) as an addition to `docs/rebuildup-pin.md`.
5. **R-09e — Translation process doc**: a short contributor guide on how to propose a translation PR, what human-review step is required, and what the verification surface is (frontmatter `name` unchanged, body content equivalent, no semantic drift).

## References

### Project-internal

- `CLAUDE.md` §7 — language policy, Skills exception
- `docs/adr/ADR-0002-language-policy-override.md` — English-primary policy, Skills excepted, R-09 referenced
- `docs/adr/ADR-0001-pin-rebuildup-policy.md` — pin model for upstream policy
- `docs/rebuildup-pin.md` — pinned ref `release-0-3-0` SHA `48432a73...`, override table
- `docs/research-issues/README.md` — R-09 draft (verbatim question above)
- `.tmp/project-init/` — pinned upstream local clone, full source of the 19 Skills

### Upstream and tooling

- `rebuildup/project-init` — <https://github.com/rebuildup/project-init>
- Upstream `PROMPT.ja.md` / `PROMPT.en.md` — same `{name}.{lang}.md` convention used for Skills translation candidate C1
- Upstream `docs/roles/CODEX_ROLES.ja.md` / `CODEX_ROLES.en.md` — second precedent for the same convention
- `vercel-labs/skills` — <https://github.com/vercel-labs/skills> (Skills CLI; single-file discovery)
- Anthropic Skill authoring best-practices — <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices>
- Anthropic Agent Skills overview — <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview>

### External OSS precedent for parallel-file Skill translation

- `foreverse-app/character-card-skills` — `SKILL-en.md` convention with `> English version: [SKILL-en.md](SKILL-en.md)` link — <https://github.com/foreverse-app/character-card-skills>
- `ForceInjection/awesome-skills/CLAUDE.md` — bilingual convention section, `SKILL.md` ↔ `SKILL-en.md` pairing — <https://github.com/ForceInjection/awesome-skills/blob/main/CLAUDE.md>
- `aiskillstore/marketplace/skills/guo-yu/skill-i18n/SKILL.md` — `SKILL.<lang>.md` convention with mtime-based incremental sync — <https://github.com/aiskillstore/marketplace/blob/main/skills/guo-yu/skill-i18n/SKILL.md>

## Open questions / follow-up items

1. **International-reader volume during research/design phase.** u-sekai is pre-launch; the assumed audience for Skills in this phase is small. Should the project wait until first international contributor onboarding to translate, or translate speculatively? (Affects choice between A5 priority-subset and A3 full-set.)
2. **Whether to open an upstream issue/PR against `rebuildup/project-init` proposing an English track.** This is a candidate path but requires coordination with the upstream maintainer. Not a current recommendation; flagged as an open question per the R-09 "translation process" item.
3. **Drift budget: acceptable divergence between Japanese upstream and English translation.** The pinned-pin model gives an upper bound (until next pin upgrade), but in practice translations may need to be patched for clarity before the upstream Skill itself changes. The protocol for these patches (separate commit? tagged in `rebuildup-pin.md`?) is not yet defined.
4. **Filename convention preference: `SKILL.en.md` (dot) vs `SKILL-en.md` (hyphen).** Both have external precedent; the choice should be made in R-09b (if Recommendation 2 is followed). u-sekai currently has no existing dot/hyphen convention that would force one over the other.
5. **Whether `description` translations should also live in `SKILL.en.md` (so each file is self-contained) or in a separate `frontmatter.en.yaml` overlay.** The latter is more compact but adds a second source of frontmatter truth.
6. **Verification of translation quality at PR time.** Machine-translation draft + human review is the candidate process, but the rubric for "translation is faithful to operational semantics" is not specified. This is a candidate future research question (downstream of R-09d) but is not strictly required for the R-09 decision itself.
7. **Whether the frontmatter `description` language field should be standardized across all 19 Skills to use English even if the body remains Japanese.** Recommendation 1 implies yes, but this is a project-side override of upstream's pattern (where `description` matches body language) and should be recorded explicitly in an ADR or in `docs/rebuildup-pin.md`.
