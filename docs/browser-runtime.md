# Browser runtime (Playwright / Chromium)

The deterministic HTTP path (`npm test`, `ci.yml`) needs no browser. This
document covers the **real browser path**: `PlaywrightAdapter`, the browser
test suite, and the browser release gate.

- Decision record: [`ADR-0009`](./adr/ADR-0009-browser-evidence-and-smoke-gate.md)
- Layout: [`ADR-0007`](./adr/ADR-0007-run-artifact-structure.md)

## Requirements

| Requirement | Value |
| --- | --- |
| Node | `>= 20` (tested on 24) |
| Browser | Chromium, installed by Playwright — **not** a system Chrome |
| Browser build | whatever `playwright@^1.48.0` pins (currently Chromium 153) |
| Secrets | none. The browser path uses the deterministic scripted reasoner |
| OS packages | Linux needs Chromium's shared libraries (see below) |

## Install

```bash
npm ci
npx playwright install chromium            # browser binaries only
npx playwright install --with-deps chromium # binaries + Linux system libraries (needs sudo)
```

`--with-deps` is the command to use in CI and on a fresh machine.

### Binaries alone are not enough on Linux

Chromium links against system libraries that a bare
`npx playwright install chromium` does **not** provide. Verified on a
Ubuntu 26.04 host where the binaries were already present but the
libraries were not:

```text
$ ldd ~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome | grep 'not found'
  libasound.so.2   => not found
  libnspr4.so      => not found
  libnss3.so       => not found
  libnssutil3.so   => not found

$ npx playwright install chromium      # no-op: the binary is already there
$ npx playwright install --with-deps chromium
# Error: sudo: interactive authentication is required   (no passwordless sudo)
```

The result is a launch failure, not a test failure with a useful message:

```text
browserType.launch: Target page, context or browser has been closed
chrome-headless-shell: error while loading shared libraries:
  libnspr4.so: cannot open shared object file: No such file or directory
```

Three ways to deal with it, in order of preference:

1. **`npx playwright install --with-deps chromium`** (needs sudo). This is
   what [`browser-smoke.yml`](../.github/workflows/browser-smoke.yml) does.
2. **Rootless prefix.** Download the distribution packages, extract them
   without installing, and point the dynamic loader at them:

   ```bash
   mkdir -p /tmp/pw-deps && cd /tmp/pw-deps
   apt-get download libnspr4 libnss3 libasound2t64
   for f in *.deb; do dpkg-deb -x "$f" extracted; done
   export LD_LIBRARY_PATH=/tmp/pw-deps/extracted/usr/lib/x86_64-linux-gnu
   ```

   The package names are Ubuntu-version dependent (`libasound2t64` on
   Ubuntu >= 24.04, `libasound2` before that).
3. **Custom browser path.** `PLAYWRIGHT_BROWSERS_PATH=<dir>` before
   `npx playwright install chromium` installs into `<dir>`; export the
   same variable for every later command. The browser suite resolves the
   executable through `chromium.executablePath()` and honours it.

A missing or unlaunchable browser is a **hard failure** in
`test/browser/support/browser-runtime.ts`, which prints the install
commands. It is never converted into a skipped test.

## Run the browser path locally

```bash
npm run test:browser
```

That is the whole contract: no environment variables, no API key, no
display server. It builds `dist/` first (so the compiled CLI the suite
exercises always matches the working tree) and then runs
`test/browser/**` under [`test/vitest.browser.config.ts`](../test/vitest.browser.config.ts).

The browser suite is deliberately **not** part of `npm test`:

| Profile | Config | Suites | Browser needed |
| --- | --- | --- | --- |
| default | `vitest.config.ts` | `test/unit`, `test/integration`, `test/e2e` | no |
| browser | `test/vitest.browser.config.ts` | `test/browser` | yes |

`ci.yml` runs the default profile only, so it stays fast and works on a
machine with no browser installed.

On a host that is missing the system libraries, prefix the command:

```bash
LD_LIBRARY_PATH=/tmp/pw-deps/extracted/usr/lib/x86_64-linux-gnu npm run test:browser
```

### What the browser suite covers

| File | Proves |
| --- | --- |
| `playwright-adapter.test.ts` | real viewport, real focus rect, real SHA-256, verified selectors, coords click + typing reaches the real server, `out_of_bounds` / `selector_not_found` diagnostics, failed launch reclaims the browser |
| `playwright-full-run.test.ts` | participant -> self-report -> observer -> artifact, with the typed task visible in the demo server's own HTML |
| `privileged-leak.test.ts` | no selector / DOM / console / network reaches the participant view, the observation artifact or the Reasoner request; a deliberate leak becomes a typed `capability.violation` |
| `cli-browser-smoke.test.ts` | the shipped CLI with `--adapter playwright` produces a complete, hash-verified artifact |
| `failure-diagnostics.test.ts` | an unreachable target and a mid-run failure both fail loudly and fabricate nothing |

### Run a single browser experiment by hand

```bash
npm run build
node dist/cli/index.js run test/fixtures/experiment.task-tracker.browser.json \
  --adapter playwright --reasoner scripted --observer-reasoner scripted --out runs
```

The CLI starts the bundled demo server on an ephemeral port, so no port
needs to be reserved. `--adapter playwright` requires the browser
install above.

## Real model providers: NOT verified

`--reasoner anthropic --observer-reasoner anthropic` exercises the same
browser path with a live provider, and
[`manual-live-smoke.yml`](../.github/workflows/manual-live-smoke.yml) can
run it with a repository secret.

**This has not been verified.** No `ANTHROPIC_API_KEY` was available in
the environment where the browser path was built, so no claim is made
about live-provider behaviour over the browser adapter: not about output
shape, not about latency, not about whether a provider can drive the
coordinate action surface usefully. Treat that combination as untested
until someone runs it with a key and records the result.

The manual workflow fails loudly when the key is missing; it never skips.

## Reading the artifacts

Layout is [`ADR-0007`](./adr/ADR-0007-run-artifact-structure.md):

```text
runs/<runId>/
  manifest.json
  participants.json
  events.ndjson
  observations/<participantId>/step-NNN.json   participant-safe view
  screenshots/<participantId>/step-NNN.png     Playwright adapter only
  self-report/<participantId>.json
  observer-report.json
  result.json
  summary.md
```

Each observation JSON carries a reference to its screenshot:

```json
{
  "stepIndex": 1,
  "url": "http://127.0.0.1:43141/",
  "title": "Task Tracker",
  "visual": {
    "width": 1280,
    "height": 800,
    "screenshotHash": "740b9723f041b93526820a690e50ec885da41188836bb82971d0b5381011ae35",
    "visibleText": "Task Tracker Home | Settings Add a task Add ...",
    "focused": { "x": 8, "y": 167.6875, "width": 179, "height": 21 }
  },
  "interactiveRegions": [{ "label": "Add", "bbox": { "x": 192, "y": 167.6875, "width": 41, "height": 21 } }],
  "screenshot": {
    "path": "screenshots/p-visual-short-memory/step-001.png",
    "sha256": "740b9723f041b93526820a690e50ec885da41188836bb82971d0b5381011ae35",
    "byteLength": 24117
  }
}
```

How to use it:

- **Open a screenshot.** `xdg-open runs/<runId>/screenshots/<participantId>/step-001.png`.
- **Verify it.** `sha256sum` the file and compare with `screenshot.sha256`
  in the observation JSON. It must equal `visual.screenshotHash`, which
  is SHA-256 over the exact PNG bytes the adapter captured. A mismatch
  means the artifact was edited or truncated.
- **Check the size.** `visual.width` / `visual.height` are the live CSS
  viewport of the captured page, and the context is created with
  `deviceScaleFactor: 1`, so the PNG pixel size equals them.
- **Confirm no binary leaked into JSON.** Observation files never contain
  `screenshotPng` or `__bytes`; the bytes live only in the PNG.
- **Confirm no privilege leaked.** Observation files contain no
  `domHtml`, no `console`, no `network` and no region `selector`;
  `events.ndjson` `reasoner.request` payloads contain no markup at all.
  Both are asserted by the browser suite.
- **Read the trace.** `events.ndjson` is one JSON event per line;
  `action.result` notes say what a click actually hit, for example
  `clicked <button "Add"> at (212, 178)`.

The HTTP adapter captures no pixels, so its runs contain no
`screenshots/` tree and no `screenshot` reference. That is the expected
shape, not a missing artifact.

## Release gate

[`browser-smoke.yml`](../.github/workflows/browser-smoke.yml) runs on
push and pull request against `release-0-2-0`:

1. records `git rev-parse HEAD`, refuses to continue if it differs from
   the triggering SHA, and names the uploaded artifact
   `browser-smoke-<sha>`;
2. `npm ci`;
3. `npx playwright install --with-deps chromium`;
4. a preflight that resolves the executable and launches Chromium,
   failing the job with install instructions if either step fails;
5. `npm run lint`, `npm run typecheck`, `npm run version:check`,
   `npm run test:browser`;
6. asserts a run artifact exists and uploads it under the SHA name.

The job has no secrets and never skips. See
[`ADR-0009`](./adr/ADR-0009-browser-evidence-and-smoke-gate.md) for why
the browser path is a separate workflow instead of a job inside
`ci.yml`.
