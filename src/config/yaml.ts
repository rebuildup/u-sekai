/**
 * The only place in u-sekai that reads YAML (issue #58).
 *
 * ## Why this is not `parseDocument(...).toJS()`
 *
 * A YAML load is the classic way an otherwise-validated configuration
 * surface becomes a hole. Measured against `yaml@2`, `toJS()` on its own
 * is *lossy in ways that matter*:
 *
 * | input                        | `toJS()` result        | hazard                |
 * | ---------------------------- | --------------------- | --------------------- |
 * | `a: 1` / `a: 2`             | `{a: 2}`              | silent last-wins      |
 * | `x: !!python/object y`      | `{x: "y"}`            | tag silently dropped  |
 * | `x: !!binary aGk=`          | `{x: {type:"Buffer"}}`| value silently decoded|
 * | `x: !!omap [ {k: v} ]`      | `{x: {}}`             | **data silently lost** |
 * | `1: a` / `true: b`          | `{"1":"a","true":"b"}`| key silently stringified |
 * | `a: [1,2` (unterminated)    | `{a: [1, 2]}`         | malformed → plausible |
 * | `a: &x 1` / `b: *x`         | billion-laughs vector | unbounded expansion   |
 *
 * A "validated" configuration that silently drops a `!!omap`, keeps the
 * last of two conflicting keys, or repairs unterminated flow is worse
 * than no validation, because the diagnostic tells the customer the
 * file was checked.
 *
 * So this module never calls `toJS()`. It walks the *node* graph and
 * builds plain data itself, rejecting outright everything it does not
 * positively recognise. Every accepted node is a string/number/boolean/
 * null scalar, a sequence, or a mapping whose keys are plain strings.
 *
 * ## The three independent guards
 *
 * 1. **Any parser error is fatal** — including a duplicate key, a
 *    tab indent, or a second document. `doc.errors` is never filtered.
 * 2. **Any parser warning is fatal** — this is what catches an
 *    unresolved or unrecognised `!tag`, which `yaml` reports as a
 *    warning and then silently discards.
 * 3. **Any node this module does not recognise is fatal** — aliases,
 *    explicitly tagged nodes, non-string keys, and the
 *    prototype-mutating key names `__proto__` / `constructor` /
 *    `prototype`.
 *
 * Guard 3 is not a claim that `yaml` is unsafe — it does not pollute
 * `Object.prototype` — it is a *policy*: this file declares authority,
 * so a key that could mutate an object's identity is refused on sight
 * rather than defended against.
 */

import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { Alias, Pair, Scalar, YAMLMap, YAMLSeq } from 'yaml';
import { UseSekaiConfigError } from './errors.js';

/**
 * Key names that can change an object's identity rather than its
 * contents. Refused anywhere in the document, at any depth.
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Depth ceiling. Anchors are already rejected, so the document is a
 * tree; the ceiling only exists so a pathological hand-written file
 * cannot exhaust the stack before validation reports a useful error.
 */
const MAX_DEPTH = 32;

/** Node shapes this module understands. */
type ReadNode = Scalar | YAMLMap | YAMLSeq | Alias;

/**
 * Parse YAML source into plain data, or throw.
 *
 * @param source raw file contents
 * @param field  dotted path used in diagnostics (the file name, by default)
 */
export function readYamlSource(source: string, field = 'u-sekai.yml'): unknown {
  if (source.trim() === '') {
    throw new UseSekaiConfigError(`${field} is empty`, field, { reason: 'empty' });
  }

  const document = parseDocument(source, {
    // YAML 1.2 core: `yes`/`no` stay strings and no scalar is a
    // timestamp or a sexagesimal, so a value's type does not depend on
    // which schema the reader happened to pick.
    version: '1.2',
    schema: 'core',
    // A repeated key is an error rather than last-wins.
    uniqueKeys: true,
    strict: true,
    prettyErrors: false,
  });

  // Guard 1. `doc.errors` is reported verbatim: no code, no severity
  // filter. A caller cannot opt into a lenient subset of them.
  if (document.errors.length > 0) {
    throw new UseSekaiConfigError(
      `${field} is not valid YAML: ${summarise(document.errors.map((e) => e.message))}`,
      field,
      { reason: 'yaml_error', codes: document.errors.map((e) => e.code) },
    );
  }

  // Guard 2. `yaml` downgrades an unrecognised `!tag` to a warning and
  // then hands back the underlying scalar, so a document can look
  // accepted while `!!set`, `!!timestamp` or a private tag quietly lost
  // its meaning. A warning is therefore a failure here.
  if (document.warnings.length > 0) {
    throw new UseSekaiConfigError(
      `${field} uses YAML features this configuration does not support: ${summarise(document.warnings.map((w) => w.message))}`,
      field,
      { reason: 'yaml_warning', codes: document.warnings.map((w) => w.code) },
    );
  }

  const contents: unknown = document.contents;
  if (contents === null || contents === undefined) {
    throw new UseSekaiConfigError(
      `${field} must declare a mapping at the top level`,
      field,
      { reason: 'no_root_node' },
    );
  }

  return readNode(contents as ReadNode, field, 0);
}

function readNode(node: ReadNode, field: string, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    throw new UseSekaiConfigError(
      `${field} nests deeper than the supported maximum of ${MAX_DEPTH}`,
      field,
      { reason: 'too_deep', maxDepth: MAX_DEPTH },
    );
  }

  // Aliases are refused rather than bounded. An anchor lets one value
  // appear under two names, which defeats the point of an authority
  // surface: reading `environments.staging.authority` no longer tells
  // you what is in effect, and a reader cannot review the file one key
  // at a time. The bomb is the lesser problem.
  if (isAlias(node)) {
    throw new UseSekaiConfigError(
      `${field} must not use YAML aliases (*anchor); write the value out in full`,
      field,
      { reason: 'alias_not_supported', anchor: node.source },
    );
  }

  if (isScalar(node)) {
    // An explicitly tagged scalar is refused whatever the tag: this
    // file has no use for `!!str` to force a type, `!!binary` to smuggle
    // encoded bytes, or a private tag to change resolution.
    if (node.tag !== undefined) {
      throw new UseSekaiConfigError(
        `${field} must not use explicit YAML tags (${node.tag}); write the plain value`,
        field,
        { reason: 'explicit_tag_not_supported', tag: node.tag },
      );
    }
    return readScalarValue(node, field);
  }

  if (isMap(node)) {
    return readMap(node, field, depth);
  }

  if (isSeq(node)) {
    return node.items.map((item, index) =>
      readNode(item as ReadNode, `${field}[${index}]`, depth + 1),
    );
  }

  throw new UseSekaiConfigError(
    `${field} contains a YAML node this configuration does not support`,
    field,
    { reason: 'unsupported_node' },
  );
}

function readScalarValue(node: Scalar, field: string): string | number | boolean | null {
  const value: unknown = node.value;
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new UseSekaiConfigError(`${field} must be a finite number`, field, {
        reason: 'not_finite',
      });
    }
    return value;
  }
  // The 1.2 core schema cannot produce one of these for a plain scalar,
  // but `!!binary` decodes to a Buffer *before* the tag is inspected on
  // some code paths, and a bigint would break every downstream integer
  // check. Refuse by observation rather than by assumption.
  throw new UseSekaiConfigError(
    `${field} must be a string, number, boolean or null`,
    field,
    { reason: 'unsupported_scalar', receivedType: describeType(value) },
  );
}

function readMap(node: YAMLMap, field: string, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const pair of node.items as ReadonlyArray<Pair<Scalar, ReadNode>>) {
    const key = readMapKey(pair, field);
    // Duplicate keys are already fatal via `doc.errors`; this is the
    // belt to that braces, and it also protects the assignment below
    // from ever overwriting a value that is already present.
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw new UseSekaiConfigError(
        `${field} declares the key "${key}" more than once`,
        `${field}.${key}`,
        { reason: 'duplicate_key' },
      );
    }
    out[key] = readNode(pair.value as ReadNode, `${field}.${key}`, depth + 1);
  }
  // Re-home onto a normal object so downstream `requireRecord` and
  // `Object.freeze` behave exactly as they do for the rest of u-sekai.
  return { ...out };
}

function readMapKey(pair: Pair<Scalar, ReadNode>, field: string): string {
  const keyNode: unknown = pair.key;
  if (keyNode === null || keyNode === undefined || !isScalar(keyNode)) {
    throw new UseSekaiConfigError(`${field} must use plain string keys`, field, {
      reason: 'non_string_key',
    });
  }
  if (keyNode.tag !== undefined) {
    throw new UseSekaiConfigError(`${field} must not use explicit YAML tags on keys`, field, {
      reason: 'explicit_tag_not_supported',
      tag: keyNode.tag,
    });
  }
  const key: unknown = keyNode.value;
  if (typeof key !== 'string') {
    // `1:` and `true:` are silently stringified by `toJS()`. A
    // configuration that reads `{"true": ...}` back is not a
    // configuration anyone reviewed.
    throw new UseSekaiConfigError(
      `${field} must use plain string keys, not ${describeType(key)}`,
      field,
      { reason: 'non_string_key', receivedType: describeType(key) },
    );
  }
  if (FORBIDDEN_KEYS.has(key)) {
    throw new UseSekaiConfigError(
      `${field} must not declare the reserved key "${key}"`,
      field,
      { reason: 'reserved_key', key },
    );
  }
  return key;
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'bigint') return 'an integer too large to represent';
  return `a ${typeof value}`;
}

function summarise(messages: ReadonlyArray<string>): string {
  return [...new Set(messages)].join('; ');
}
