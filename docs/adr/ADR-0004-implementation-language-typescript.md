# ADR-0004: TypeScript + Node + Vitest as the 0.1.0 implementation stack

- **Status**: accepted
- **Date**: 2026-09-21
- **Deciders**: project lead (@rebuildup)

## Context

With issue #10 (R-08) and the 0.1.0 release scope, implementation has started.
The first end-to-end slice has to ship within the same release, so an
implementation stack must be chosen now and recorded.

Constraints drawn from [`CLAUDE.md`](../../CLAUDE.md) and the release scope:

- The domain model must not depend on Playwright / LLM SDK types, so the
  language must let us keep a pure-typed domain layer separate from
  adapters.
- We need first-class support for browser automation (Playwright) and HTTP
  calls (LLM providers) without taking on heavy build/runtime overheads.
- The repo has to ship a CLI, so a binary is desirable.
- A reasonable test runner that can host both unit and end-to-end tests
  without separate toolchains is desirable.
- CI runs without external API keys, so determinism and offline-ability matter.

## Decision

| Layer | Choice |
| --- | --- |
| Language | TypeScript (strict mode) |
| Module system | ESM (`"type": "module"`, `NodeNext` resolution) |
| Runtime | Node.js (>= 20; tested on Node 24) |
| Test runner | Vitest |
| Type checker | `tsc --noEmit` as part of `npm run typecheck` |
| Lint | ESLint flat config with `@typescript-eslint` |
| Build | `tsc` to `dist/`; package becomes a single CLI |
| Package manager | npm (CI uses `npm ci`) |

Rationale:

- Playwright's strongest API surface and examples are JavaScript / TypeScript,
  and `fetch` (used for LLM provider HTTP calls) is built into Node 20+.
- Strict TypeScript lets us keep the domain layer pure by surfacing any
  accidental third-party import as a compile error.
- Vitest runs unit, integration, and Playwright-backed e2e in one process,
  which keeps CI configuration small.

## Consequences

Positive:

- A single language covers domain, adapters, and CLI.
- Pure-typed domain layer is enforceable at the type level by importing
  only from `./domain/*` within `src/domain/**`.
- Vitest's `pool: forks` plays well with the demo environment binding to an
  ephemeral port per test.

Negative / trade-offs:

- TypeScript build / type-check cost is a CI step we must keep green.
- ESLint flat config is newer; we adopt a conservative ruleset (`recommended`
  + `@typescript-eslint/recommended-type-checked`) to avoid surprises.

Operational:

- All third-party imports inside `src/domain/**` are disallowed by ESLint
  `no-restricted-imports` (configured in `.eslintrc/eslint.config.js`).
- The package's `package.json` declares `"engines": { "node": ">=20" }`.
- `npm run ci` runs `lint`, `typecheck`, `test`, `build` in order.

## Alternatives considered

- **Python**: rejected — Playwright Python works but does not give us a
  single-language domain-vs-adapter split, and the existing pinned
  rebuildup policy is JS/TS-first.
- **Go**: rejected — Playwright Go bindings lag behind; multi-process IPC
  for observers is heavier than needed at 0.1.0 scale.
- **Rust**: rejected — overkill for a research-grade MVP; observer evidence
  generation already exercises enough string handling that ergonomic
  ergonomics matter more than raw speed.
- **JavaScript without TypeScript**: rejected — strict typing helps keep the
  capability boundaries honest.

## References

- [Issue #15](../../.github/../issues/15) — 0.1.0 functional MVP umbrella.
- [Issue #16](../../.github/../issues/16) — architecture / public contract.
- [`CLAUDE.md`](../../CLAUDE.md) Section 3 — what *not* to do in research phase.
