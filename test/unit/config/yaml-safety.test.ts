/**
 * The YAML edge cases that turn a validated configuration surface into
 * a hole (issue #58).
 *
 * Every case here is hand-written YAML, because the point is to feed the
 * loader documents a serialiser would refuse to produce. Each one was
 * chosen because `yaml`'s own `toJS()` handles it *lossily and
 * silently* — silently keeping the last of two conflicting keys,
 * silently decoding `!!binary`, silently discarding an `!!omap` and the
 * data in it, silently stringifying a numeric key, and silently
 * "repairing" an unterminated flow. A loader built on `toJS()` would
 * accept all of them and report success.
 *
 * `readYamlSource` is the only YAML reader in u-sekai, so these cases
 * cannot be bypassed by another code path.
 */

import { describe, expect, it } from 'vitest';
import { parseUseSekaiConfigText, readYamlSource, UseSekaiConfigError } from '../../../src/config/index.js';
import { expectConfigError } from './support.js';

const provenance = { configPath: '/synthetic/u-sekai.yml', configPathSource: 'default' as const };

/** Feed a hand-written document to the loader. */
const load = (source: string) => parseUseSekaiConfigText(source, provenance);

const HEADER = 'version: 1\nproduct:\n  id: acme\nenvironments:\n  develop:\n    class: develop\n    url: https://develop.acme.example\n';

describe('duplicate keys', () => {
  it('rejects a repeated top-level key', () => {
    const error = expectConfigError(() =>
      load('version: 1\nversion: 1\nproduct:\n  id: acme\nenvironments: {}\n'),
    );
    expect(error.message).toMatch(/not valid YAML/i);
  });

  it('rejects a repeated key nested inside an environment', () => {
    // The classic ambiguity: two `authority:` blocks, so which one grants
    // what? `toJS()` keeps the last and says nothing.
    const error = expectConfigError(() =>
      load(
        `${HEADER}    authority:\n      destructiveActions: true\n    authority:\n      destructiveActions: false\n`,
      ),
    );
    expect(error.message).toMatch(/not valid YAML/i);
  });

  it('rejects a repeated scalar key on a permission', () => {
    const error = expectConfigError(() =>
      load(`${HEADER}    authority:\n      destructiveActions: true\n      destructiveActions: true\n`),
    );
    expect(error.message).toMatch(/not valid YAML/i);
  });

  it('rejects a repeated key two levels down', () => {
    const error = expectConfigError(() =>
      load(`${HEADER}    authority:\n      realMoney:\n        enabled: true\n        enabled: false\n`),
    );
    expect(error.message).toMatch(/not valid YAML/i);
  });
});

describe('keys that can change an object identity', () => {
  // `yaml` does not actually pollute `Object.prototype` on this version,
  // so these cases are policy rather than a patch over a live hole. That
  // is the intent: a file that declares authority should not be able to
  // name a key that mutates identity, whatever the parser does next
  // version. The pollution assertion below pins the current behaviour so
  // a dependency bump that changed it would fail loudly.
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    it(`rejects a top-level "${key}" key`, () => {
      const error = expectConfigError(() => load(`${key}:\n  polluted: true\n${HEADER}`));
      expect(error.message).toMatch(new RegExp(`reserved key "${key}"`));
    });

    it(`rejects a nested "${key}" key`, () => {
      const error = expectConfigError(() =>
        load(`${HEADER}    authority:\n      ${key}:\n        polluted: true\n`),
      );
      expect(error.message).toMatch(new RegExp(`reserved key "${key}"`));
    });
  }

  it('leaves Object.prototype untouched when a document tries', () => {
    expectConfigError(() =>
      load('product:\n  __proto__:\n    polluted: yes-please\nversion: 1\n'),
    );
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('non-string keys', () => {
  it('rejects a numeric key, which toJS would stringify to "1"', () => {
    const error = expectConfigError(() =>
      load('1: acme\nversion: 1\nproduct:\n  id: acme\nenvironments:\n  develop:\n    class: develop\n    url: https://develop.acme.example\n'),
    );
    expect(error.message).toMatch(/plain string keys/i);
  });

  it('rejects a boolean key, which toJS would stringify to "true"', () => {
    const error = expectConfigError(() => load(`version: 1\nproduct:\n  true: acme\n`));
    expect(error.message).toMatch(/plain string keys/i);
  });

  it('rejects a key nested in an environment', () => {
    const error = expectConfigError(() => load(`${HEADER}    2: staging\n`));
    expect(error.message).toMatch(/plain string keys/i);
  });
});

describe('anchors and aliases', () => {
  it('rejects an alias used as a value', () => {
    const error = expectConfigError(() =>
      load(`${HEADER}  staging:\n    class: &cls staging\n` + `  production:\n    class: *cls\n`),
    );
    expect(error.message).toMatch(/must not use YAML aliases/i);
  });

  it('rejects a YAML merge key', () => {
    // `<<:` is a merge performed with an alias; the document that defines
    // it without an alias is inert but the intent is the same, and a
    // reader auditing one key at a time must not be surprised by it.
    const error = expectConfigError(() =>
      load(`${HEADER}  extra:\n    <<:\n      class: staging\n`),
    );
    expect(error.message).toMatch(/unknown key\(s\)|aliases/i);
  });

  it('rejects an alias inside a permission block', () => {
    const error = expectConfigError(() =>
      load(
        `${HEADER}    authority: &a\n      destructiveActions: false\n  second:\n    class: production\n    authority: *a\n`,
      ),
    );
    expect(error.message).toMatch(/must not use YAML aliases|unknown key\(s\)/i);
  });
});

describe('explicit tags', () => {
  it('rejects an unrecognised tag, which yaml only warns about', () => {
    // `!!python/object` resolves to a warning and the raw string. Loading
    // it would mean a file could name a type this configuration has no
    // meaning for and still be reported as valid.
    const error = expectConfigError(() => load(`${HEADER}    name: !!python/object x\n`));
    expect(error.message).toMatch(/does not support|explicit YAML tags/i);
  });

  it('rejects a private tag', () => {
    const error = expectConfigError(() => load(`${HEADER}    name: !secret value\n`));
    expect(error.message).toMatch(/does not support|explicit YAML tags/i);
  });

  it('rejects !!binary, which decodes to bytes without complaint', () => {
    const error = expectConfigError(() => load(`${HEADER}    name: !!binary aGk=\n`));
    expect(error.message).toMatch(/does not support|explicit YAML tags/i);
  });

  it('rejects !!omap, whose entries toJS discards entirely', () => {
    // The most dangerous of the set: `!!omap` under a key silently
    // resolves to `{}`, so a document that declared data would load as
    // one that declared none.
    const error = expectConfigError(() =>
      load(`${HEADER}    notes: !!omap\n      - class: production\n`),
    );
    expect(error.message).toMatch(/does not support|explicit YAML tags/i);
  });

  it('rejects !!str used to force a type', () => {
    const error = expectConfigError(() => load(`${HEADER}    name: !!str 123\n`));
    expect(error.message).toMatch(/does not support|explicit YAML tags/i);
  });
});

describe('malformed documents', () => {
  it('rejects an unterminated flow sequence rather than repairing it', () => {
    const error = expectConfigError(() => load(`${HEADER}    notes: [a, b\n`));
    expect(error.message).toMatch(/not valid YAML/i);
  });

  it('rejects a tab used as indentation', () => {
    const error = expectConfigError(() => load('version: 1\nproduct:\n\tid: acme\n'));
    expect(error.message).toMatch(/not valid YAML/i);
  });

  it('rejects a second document in the file', () => {
    // A multi-document file is ambiguous about which document is the
    // authority, and the parser would otherwise keep only the first.
    const error = expectConfigError(() => load(`${HEADER}---\nversion: 2\n`));
    expect(error.message).toMatch(/not valid YAML/i);
  });

  it('rejects an empty file', () => {
    const error = expectConfigError(() => load(''));
    expect(error.message).toMatch(/empty/i);
  });

  it('rejects a file of only comments', () => {
    // A comment-only file has no root node at all, so it is refused for
    // declaring nothing rather than for being blank. Both are rejections;
    // the message just names the more accurate reason.
    const error = expectConfigError(() => load('# nothing here\n'));
    expect(error.message).toMatch(/empty|must declare a mapping/i);
  });

  it('rejects a document whose root is a list', () => {
    const error = expectConfigError(() => load('- version: 1\n- product: acme\n'));
    expect(error.message).toMatch(/must be a mapping|must be a string/i);
  });

  it('rejects a document whose root is a scalar', () => {
    const error = expectConfigError(() => load('just-a-string\n'));
    expect(error.message).toMatch(/must be a mapping|must be a string/i);
  });
});

describe('the reader itself', () => {
  it('is total: every rejection is a UseSekaiConfigError', () => {
    // Checked through the loader, not the reader: a top-level list is
    // valid YAML, and it is the schema that refuses it. Either way the
    // caller sees a config error, never a partial value.
    const bad = [
      'a: 1\na: 2\n',
      '__proto__: {}\n',
      '- 1\n- 2\n',
      '',
      'a: !!omap\n  - k: v\n',
      'a: &x 1\nb: *x\n',
      '1: a\n',
      'version: 2\nproduct:\n  id: acme\nenvironments: {}\n',
    ];
    for (const source of bad) {
      let thrown: unknown;
      try {
        load(source);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `expected a rejection for: ${JSON.stringify(source)}`).toBeInstanceOf(
        UseSekaiConfigError,
      );
    }
  });

  it('accepts the plain shapes it promises and nothing exotic', () => {
    expect(readYamlSource('a: 1\nb: two\nc: true\nd: null\ne: [1, 2]\nf:\n  g: h\n')).toEqual({
      a: 1,
      b: 'two',
      c: true,
      d: null,
      e: [1, 2],
      f: { g: 'h' },
    });
  });

  it('reads "yes" and "no" as the strings YAML 1.2 defines them to be', () => {
    // Under a 1.1-style reader these would be booleans, so a file that
    // validated would mean something different on another machine.
    expect(readYamlSource('a: yes\nb: no\nc: on\n')).toEqual({ a: 'yes', b: 'no', c: 'on' });
  });

  it('reads a date-like scalar as a string, not a timestamp', () => {
    expect(readYamlSource('a: 2026-10-01\n')).toEqual({ a: '2026-10-01' });
  });

  it('refuses a nesting deeper than the supported maximum', () => {
    // Distinct keys all the way down, so this exercises the depth ceiling
    // rather than tripping the duplicate-key check on the way.
    const lines: string[] = [];
    for (let i = 0; i < 64; i += 1) lines.push(`${'  '.repeat(i)}k${i}:`);
    lines.push(`${'  '.repeat(64)}leaf: 1`);
    const error = expectConfigError(() => readYamlSource(lines.join('\n') + '\n'));
    expect(error.message).toMatch(/nests deeper/i);
  });
});
