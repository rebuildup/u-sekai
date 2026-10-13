# Testing

Install the locked dependencies with `npm ci`. The browser-free integration
gate is `npm run ci`: lint, typecheck, version alignment, build, and all unit,
integration, and CLI E2E tests. It requires no external API keys.

For focused verification, run these commands from the repository root:

```bash
npm run build
npm run test:unit
npm run test:integration
npm run test:e2e
```

Build before running integration or E2E tests because they exercise the
compiled CLI. Each command's default Vitest reporter prints the executed
file and test counts. A successful run must discover at least one file;
`passWithNoTests: false` explicitly makes an empty selection fail.

The scripts use Vitest's positional file filters while retaining the common
configuration. To run a narrower selection, invoke Vitest directly:

```bash
npx vitest run test/unit/config/
```

Additional positional filters are alternatives, not an intersection with a
script's existing suite filter. Use the direct command above for a subset.
Avoid `--dir`: it changes the discovery directory, which makes the configured
repository-relative include patterns fail to find the intended files. See
the [Vitest CLI documentation](https://vitest.dev/guide/cli).

`test/integration/test-discovery.test.ts` checks each package script's actual
arguments through `vitest list --filesOnly --json`. It compares the complete
selection with the test files on disk and checks that an empty selection exits
with code 1. This guard runs in
both `npm run test:integration` and `npm run ci`; its expected counts grow
with the suites rather than relying on a fixed snapshot.

Listing files proves discovery only. Execute the relevant suite to claim its
tests passed. The separate `npm run test:browser` gate needs Chromium; see
[Browser runtime](./browser-runtime.md) for setup and scope.
