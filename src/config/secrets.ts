/**
 * Secret *references* — the only thing `u-sekai.yml` is allowed to say
 * about a credential (issue #58).
 *
 * ## References, never values
 *
 * ADR-0011 and `docs/product/configuration-and-authority.md` both state
 * that the repository-controlled file stores a reference and that the
 * approved secret authority resolves it elsewhere. This module is the
 * whole of that layer's involvement: it checks the *shape* of a
 * reference and hands the reference back verbatim. It has no resolver,
 * performs no I/O, and cannot return a secret value because it has no
 * code path that could produce one.
 *
 * ## Diagnostics never echo the offending text
 *
 * The most likely mistake is pasting the secret itself where a
 * reference belongs. Every message below therefore names the *field* and
 * the rule, and never includes the text it rejected — a diagnostic that
 * printed a leaked credential would copy it into CI logs, a test
 * snapshot and an issue tracker. This is why `received` is absent from
 * every `detail` in this file.
 *
 * ## Why only `secret:` and not `env:`
 *
 * A `${env:NAME}` form would be resolved from the process environment,
 * which is not an "approved secret authority" and is inherited by every
 * child process, CI job and log-capturing wrapper. The reference
 * grammar is deliberately a single closed form so that the set of
 * things this file can say about a credential is small, reviewable and
 * finite. Widening it is a decision that needs its own threat model,
 * not a second alternative in a regular expression.
 */

import { UseSekaiConfigError } from './errors.js';
import { requireMapping } from './validate.js';

/** The one supported reference form, e.g. `${secret:ACCOUNT_FACTORY_TOKEN}`. */
const SECRET_REFERENCE_PATTERN = /^\$\{secret:([A-Z][A-Z0-9_]{0,127})\}$/;

/** Registry key that names a reference, e.g. `accountFactoryToken`. */
const SECRET_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface DeclaredSecret {
  /** Registry key the rest of the file refers to. */
  readonly name: string;
  /**
   * The reference exactly as written in the file. Preserved verbatim:
   * this layer never rewrites, normalises or resolves it.
   */
  readonly reference: string;
}

/**
 * Validate a declared secret reference and return it unchanged.
 *
 * @param field dotted path used in diagnostics
 */
export function parseSecretReference(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new UseSekaiConfigError(
      `${field} must be a string holding a \${secret:NAME} reference`,
      field,
      { reason: 'wrong_type' },
    );
  }

  const match = SECRET_REFERENCE_PATTERN.exec(value);
  if (match) {
    return value;
  }

  // No branch below includes `value`. See the module docstring.
  throw new UseSekaiConfigError(
    `${field} must be a \${secret:NAME} reference (e.g. "\${secret:ACCOUNT_FACTORY_TOKEN}"); ` +
      'u-sekai.yml never stores a secret value. Use an uppercase reference name — ' +
      'lower-case env-var, file-path and URL forms are not resolved by this configuration.',
    field,
    { reason: 'not_a_secret_reference' },
  );
}

/** The reference name inside `${secret:NAME}`, for diagnostics and lookups. */
export function secretReferenceName(reference: string): string {
  const match = SECRET_REFERENCE_PATTERN.exec(reference);
  if (!match || match[1] === undefined) {
    // Unreachable for a value produced by `parseSecretReference`; kept
    // total so a caller holding an unvalidated string still gets a
    // defined answer rather than a silent `undefined`.
    throw new UseSekaiConfigError('not a secret reference', undefined, {
      reason: 'not_a_secret_reference',
    });
  }
  return match[1];
}

/** Validate a `secrets:` registry key. */
function parseSecretRegistryName(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SECRET_NAME_PATTERN.test(value)) {
    throw new UseSekaiConfigError(
      `${field} must be a name of letters, digits and underscores, starting with a letter`,
      field,
      { reason: 'invalid_registry_name' },
    );
  }
  return value;
}

/** Read and validate a `secrets:` block into a frozen, ordered list. */
export function parseSecretRegistry(value: unknown, field: string): ReadonlyArray<DeclaredSecret> {
  if (value === undefined) return Object.freeze([]);
  const raw = requireMapping(value, field);
  const declared: DeclaredSecret[] = [];
  const seenReferences = new Set<string>();

  // Sorted so the parsed order — and therefore `JSON.stringify` of the
  // loaded configuration — does not depend on the key order the YAML
  // happened to be written in.
  for (const key of Object.keys(raw).sort()) {
    const keyField = `${field}.${key}`;
    const name = parseSecretRegistryName(key, keyField);
    const reference = parseSecretReference(raw[key], keyField);

    const referenceName = secretReferenceName(reference);
    if (seenReferences.has(referenceName)) {
      // Two registry names for one reference means the file describes
      // the same secret in two ways, and the answer to "what is
      // accountFactoryToken?" depends on which key a reader happened to
      // look at. Refuse it.
      throw new UseSekaiConfigError(
        `${keyField} already declares \${secret:${referenceName}}; ` +
          'one reference must have exactly one name in a file',
        keyField,
        { reason: 'duplicate_reference', referenceName },
      );
    }
    seenReferences.add(referenceName);
    declared.push(Object.freeze({ name, reference }));
  }

  return Object.freeze(declared);
}
