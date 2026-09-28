# ADR-0009: Browser evidence persistence, the region contract, and the browser smoke gate

- **Status**: accepted
- **Date**: 2026-09-27
- **Deciders**: project lead (@rebuildup)

## Context

`PlaywrightAdapter` shipped with the 0.1.0 vertical slice but was never
exercised by a gate. Inspecting it against the contract in
[`ADR-0007`](./ADR-0007-run-artifact-structure.md) and
[`ADR-0006`](./ADR-0006-capability-model-observation-action-memory.md)
surfaced three separate problems:

1. **Evidence.** `FileArtifactIO.writeObservation` serialized the whole
   `ParticipantObservation` through a `jsonReplacer` that turned a
   `Uint8Array` into `{ __bytes: [ ... ] }`. One 1280x800 screenshot became
   a multi-megabyte integer array inside the observation JSON, so
   `screenshots/<participantId>/step-NNN.png` — the path ADR-0007 already
   documented — was never written.
2. **Region contract.** The adapter reported `[button][data-uid="3"]` for
   every interactive element. The demo pages have no `data-uid`
   attributes, so the value was a fiction no CSS engine could resolve.
   Meanwhile `screenshotHash` was a 32-bit FNV-1a value behind a domain
   comment that promised SHA-256, `visual.width/height` were hardcoded to
   1280x800 regardless of the real viewport, `focused` was always the zero
   rect, and `observedAfter` echoed values that were only refreshed by the
   *next* `observe()`.
3. **Gating.** `ci.yml` runs a deterministic HTTP-only suite. Nothing in
   CI could tell whether the real browser path still worked, so a browser
   regression would surface as a user-visible failure with no gate behind
   it.

## Decision

### 1. Screenshots are files, references are metadata

A captured screenshot is written as a real PNG at the ADR-0007 path
`screenshots/<participantId>/step-NNN.png`. The observation JSON records a
reference object and nothing else:

```json
"screenshot": {
  "path": "screenshots/<participantId>/step-NNN.png",
  "sha256": "<sha-256 of the bytes on disk>",
  "byteLength": 12345
}
```

- `visual.screenshotPng` is an **in-memory-only** field. It is stripped
  before serialization; `visual.screenshotHash` stays so a reader can
  correlate the observation with the file without opening it.
- `screenshot.sha256` is computed from the bytes actually written, and
  `visual.screenshotHash` is a real SHA-256 over the same bytes
  (`sha256Hex` in `src/evidence/hash.ts`, `node:crypto`). The two must
  agree, which is what the tests assert by hashing the file on disk.
- Serializing binary into JSON is now a **loud failure**, not a silent
  expansion. `jsonReplacer` throws and names the correct mechanism.
- Adapters that capture no pixels (the HTTP adapter) write no
  `screenshots/` tree and no `screenshot` reference. Absence is the
  correct representation of "no pixels captured".

### 2. `interactiveRegions` carries a verified selector, or none

`ObserverObservation.interactiveRegions[].selector` becomes **optional**.
An adapter reports a selector only when the live page resolves the
candidate back to exactly the same element; when it cannot prove that, the
field is omitted. The adapter builds candidates most-specific-first
(`#id`, then `name` / `aria-label` / `type` / `href` / `placeholder` /
`role` attribute hints, then a structural `tag:nth-of-type(n)` path) and
verifies each with `querySelectorAll(candidate).length === 1`.

On the bundled demo page the reported paths are real and resolvable:

```text
a[href="/"]            a[href="/settings"]      a[href="/help"]
input[name="title"]    button[type="submit"]
```

`HttpAdapter` keeps its region shape (it parses HTML without a DOM and
cannot resolve a path) and its `selector` values are documented as
synthetic region ids, not CSS.

**The participant view is selector-free regardless, and that is the
invariant that matters.** `applyParticipantObservation` maps every region
to `{ label, bbox }` and nothing else, so a selector can never reach a
participant regardless of what an adapter reports. `assertNoPrivilegedLeak`
now enforces that mechanically, and it enforces more than key presence:

1. no privileged key (`domHtml`, `console`, `network`) is reachable;
2. every reachable key, at any depth, belongs to the participant
   observation schema — a `selector` on a region or an unknown field under
   `visual` is a violation whatever its value;
3. every participant-visible value equals the projection
   `applyParticipantObservation` produces from the observer view
   (whitespace-collapsed and capped visible text, control characters
   stripped from the title, region label + bbox only, clamped ARIA).

Check 3 is what makes content smuggling decidable: a value that came from
anywhere other than its permitted source cannot equal its projection. A
leak is recorded as a typed `capability.violation` event and terminates
the participant with `terminationReason: 'capabilityViolation'`.

Because the filter re-projects content, the only fields a mis-implemented
adapter can leak through are the ones copied **by reference** — today
`visual.focused` and `visual.screenshotPng`. Check 2 covers that vector.

### 3. Failures are typed, and a broken browser fails the gate

`ActionResult.code` is used as the existing vocabulary intends:

| Situation | Result |
| --- | --- |
| coordinates outside the live viewport, or no element there | `error` / `out_of_bounds` |
| `typeText` with nothing focused, or a non-editable focus | `error` / `selector_not_found` |
| a click that leaves the document unsettled after the timeout | `error` / `timeout` |
| any other primitive failure | `error` / `unknown` |

A settle timeout is returned, never swallowed: a page that does not finish
loading is reported as a timeout, not as a success with a stale `url`/
`title`. `observedAfter` is always re-read from the live page after the
action settles, and the navigation watcher is armed *before* the input is
dispatched so a click that swaps the document cannot report the outgoing
one. `close()` collects page/context/browser teardown errors and rethrows
them as a single `AdapterError`; a failed `open()` attaches its teardown
report to the diagnostic it raises. Diagnostic stubs
(`__recentForTest()` returning `[]`) are replaced with the real record.

The browser path is gated by a **separate workflow**,
`.github/workflows/browser-smoke.yml`, rather than a job inside
`ci.yml`:

- `ci.yml` stays the fast, deterministic, browser-free gate. A separate
  profile (`test/vitest.browser.config.ts`) keeps browser tests out of
  `npm test`, so the default suite remains runnable with no browser
  installed.
- The gate installs the browser explicitly
  (`npx playwright install --with-deps chromium`) and runs a preflight
  that resolves the executable and launches it. A missing or unlaunchable
  browser **fails the job** with install instructions. It never skips: a
  green check that did not run would falsely signal browser coverage to a
  release gate. Same precedent as `manual-live-smoke.yml`.
- The gate is bound to a commit: it records `git rev-parse HEAD`, refuses
  to continue if that differs from the triggering SHA, and uploads the
  run artifact as `browser-smoke-<sha>`.
- No secrets. The reasoner is the deterministic scripted provider and the
  target is the in-repo demo server, so the gate is reproducible and
  offline.

Because the CLI's exit code is not a sufficient browser-smoke signal (see
Consequences), the suite asserts the gate condition on artifact
contents — every participant terminated `finish`, screenshots exist, and
their recorded hashes match the bytes on disk.

## Consequences

Positive:

- The artifact is readable and diffable again: a screenshot is a PNG with
  a verifiable hash, not a JSON integer array.
- Observer-facing region data is trustworthy: a selector either resolves
  or is absent, and no consumer has to guess which.
- The participant-facing view is enforced by an exact, mechanical check
  rather than by value comparison that passed on empty or differently
  shaped leaks.
- A browser regression is caught by a gate bound to the release SHA, and a
  missing browser is a loud failure rather than a silent green.

Negative / trade-offs:

- A click now waits for a bounded settle (navigation grace + `load`), so
  the browser path is slower than a bare `mouse.click`. Correctness of
  `observedAfter` was worth the latency.
- `selector` is optional, so consumers of `ObserverObservation` must
  handle its absence. `HttpAdapter` still populates it.
- The browser gate duplicates lint/typecheck/version-sync that `ci.yml`
  also runs. That is deliberate: a release gate should not depend on
  another workflow having run.
- `visual.screenshotPng` is still carried in memory for the whole run. At
  0.2.0 scale that is a few MB per participant; a streaming design is
  deferred.

Operational:

- `docs/browser-runtime.md` documents the install, the Linux system
  libraries Chromium needs (binaries alone are not enough), how to run the
  path locally, and how to read the artifacts.
- Browser tests are excluded from `npm test`. A test that skips when the
  browser is missing is a false green, so the browser profile fails
  loudly instead.
- **Known gap, not fixed here:** `src/cli/index.ts` exits 0 when a
  participant fails *inside* the step loop (`terminationReasons:
  {<id>: 'error'}`), and the run artifact records the `error` reason
  without the adapter's diagnostic text. An `open()` failure does abort
  the run and exit 2. Both behaviours live in files this change does not
  own; until they are addressed, a browser gate must assert on artifact
  termination reasons, not on the process exit code.
- **Not verified:** the browser path with a live model provider. No API key
  was available, so no claim is made about that combination.

## Alternatives considered

- **Keep `data-uid` selectors and add the attributes to the demo pages**:
  rejected. It makes the fiction true for one app and false for every
  other, and it leaks an internal addressing scheme into the contract.
- **Drop `selector` from the observer view entirely**: rejected for 0.2.0.
  The observer's job includes pointing at what it saw, and a verified path
  is useful. Optionality gives the safety without losing the capability.
- **Store screenshots as base64 inside the observation JSON**: rejected.
  Unreadable without tooling, unpinnable by content hash, and it makes one
  file grow with every step.
- **Add the browser suite as a job in `ci.yml`**: rejected. It would make
  the deterministic gate depend on a browser download and slow every PR.
- **Skip the browser tests when no browser is present**: rejected. A skip
  is a green that claims coverage that does not exist.

## References

- [Issue #25](https://github.com/rebuildup/u-sekai/issues/25)
- [`ADR-0006`](./ADR-0006-capability-model-observation-action-memory.md)
- [`ADR-0007`](./ADR-0007-run-artifact-structure.md)
- [`docs/browser-runtime.md`](../browser-runtime.md)
