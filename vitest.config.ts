import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/unit/**/*.test.ts',
      'test/integration/**/*.test.ts',
      'test/e2e/**/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    // Integration and e2e tests bind to ephemeral ports, so each test file
    // needs its own process and they must not be collapsed into one.
    //
    // There is deliberately no knob for that here. It used to read
    // `forks: { singleFork: false }`, which Vitest has carried through two
    // removals — `test.forks` was renamed to `test.poolOptions.forks` in
    // Vitest 2, and `test.poolOptions` was flattened into top-level keys
    // in Vitest 4, where `singleFork` itself was dropped in favour of
    // `maxWorkers: 1`. None of those spellings are read by Vitest 5, so
    // the setting was inert and this comment described an intent the
    // toolchain was not honouring.
    //
    // Leaving the run alone is what actually delivers the intent: the
    // defaults give every test file its own fork. Do not "restore" the
    // setting by setting `fileParallelism: false`, `maxWorkers: 1` or
    // `isolate: false` — the first two run the whole suite in a single
    // process and the third reuses one worker across files, so module
    // state (a bound port, an open handle) carries from one file into
    // the next. That is the port collision this is guarding against, and
    // Vitest 5 advertises `isolate: false` as a startup-time optimisation
    // at the end of every run, so the temptation is live.
    //
    // test/unit/toolchain/vitest-pool-config-is-effective.test.ts asserts
    // all of the above, and `tsconfig.json` keeps this file inside the
    // type-check program so an unreadable key fails `npm run typecheck`
    // rather than being ignored.
    sequence: {
      // Keep CI deterministic: integration -> e2e -> unit.
      shuffle: false,
    },
  },
});
