# u-sekai architecture

```
                   ExperimentDefinition (JSON)
                                |
                                v
                          runExperiment
              +------------+----------+------------+
              |            |          |            |
              v            v          v            v
        (participant 1)        (participant 2) ...
        +-- runParticipant --+    +-- runParticipant --+
        |   capability       |    |   capability       |
        |   runtime loop     |    |   runtime loop     |
        |   self-report      |    |   self-report      |
        +---------+----------+    +---------+----------+
                  \                       /
                   \                     /
                    v                   v
                EvidenceRecorder (in-memory during run)
                          |
                          v
                  Observer (separate context)
                          |
                          v
                  RunResult + artifact tree on disk
```

## Capability model (ADR-0006)

Three orthogonal axes, enforced at the runtime layer:

- `observation`: `visual` (default) or `visualPlusAria`.
- `action`: `visualOnly` (the only value in the current functional MVP). Six human-facing
  primitives: `clickByCoords`, `tapByCoords`, `typeText`, `scroll`,
  `wait`, `finish`.
- `memory`: `fullHistory` or `limitedRecent{N}`.

Each axis is checked in its own module; a violation is recorded as a
typed event in `events.ndjson` (see `evidence-events`).

## Reasoner boundary (ADR-0005)

The participant runtime never imports a third-party LLM SDK. Provider
adapters live under `src/reasoner/providers/` and translate domain
`ReasonerRequest` -> provider-native JSON. CI uses
`scriptedReasoner`, which is fully deterministic.

## Artifact layout (ADR-0007)

See README "Output artifact" section.

## Release and publication (ADR-0010)

Source delivery and artifact publication are two separate layers. A merged
`release-<x>-<y>-<z> -> main` pull request **is** the released source state,
`main` stays protected, and pull requests land with merge commits only
(ADR-0003). Publication is an additive artifact layer on top of that state
and never requires a direct source change to `main`.

```text
      release-<x>-<y>-<z>                main
              |                            |
              |  merge commit (release PR) |
              +---------------------------->|
                                           |  released source state for version V
                                           v
                    scripts/verify-release.mjs
                      |            |            |
      package.json#version      git history   GitHub Checks API
              |            |            |
              +------ pure rules (scripts/release-rules.mjs) ------+
                                           |
                       verdict: publish | already-published | refused
                                           |
                        --apply only:  tag v<V>  +  GitHub Release v<V>
```

- `package.json#version` at the released commit is the only version input.
  The tag (`v<V>`) and the release branch (`release-<x>-<y>-<z>`) are derived
  from it; there is no command-line version override, and the ref the version
  is read from must resolve to the commit being tagged.
- The expected release commit is resolved from the `main` merge record for
  the release branch, anchored to the GitHub merge-commit subject shape. A
  deleted release branch is accepted because that merge record is the durable
  evidence; a surviving release branch must be an ancestor of the target; and
  more than one qualifying merge is a refusal rather than a newest-wins pick.
- The rules are **fail, never correct**: each check prints the expected value
  next to the observed one and a violation never adjusts a version, a tag, a
  target commit, or a required check. An answer the tool could not read — an
  unreadable check-run list, an unreadable duplicate inventory — is a refusal,
  never an assumed pass.
- The release gate is decided from check runs on the target commit, scoped to
  `main` and `release-<V>`, taking the latest run of each required check. A
  missing, unreadable, or empty gate is a refusal, never a pass. The gate list
  is a committed constant that a test checks against the real `ci.yml` job
  names.
- Branch protection is read as a **local-only** cross-check
  (`--cross-check-protection`). The publish workflow's token cannot read it, so
  in CI the committed gate is the only definition of the gate and the run says
  so rather than claiming branch protection registers nothing.
- The CLI is plan-only by default and mutates nothing until `--apply`. The
  `release-publish` workflow is `workflow_dispatch`-only, reads its `dry_run`
  switch fail-closed (only the literal `false` publishes), and is idempotent:
  an existing tag and Release at the target commit yield `already-published`
  and no new artifact.

Procedure: [`docs/release-process.md`](./release-process.md).

## Non-facts that we explicitly reject

- A participant can never reach a privileged action shape
  (`selectorClick`, `evaluateJs`, `getDomTree`, ...) — the runtime
  refuses before any adapter call.
- Synthetic Users are not real users. The current observation layer is
  not a substitute for usability testing with human participants.
- We do not silently fold three signals (participant / observer /
  evidence) into a single scalar. They live in three separate files.
- A Git tag is not a source of truth. It is a derived artifact of
  `package.json#version`, and the release gate refuses to create or move
  one that disagrees with the released commit.
