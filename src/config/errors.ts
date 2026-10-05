/**
 * Error type for the `u-sekai.yml` configuration surface (issue #58).
 *
 * ## Why this is a separate type from `ProductDomainError`
 *
 * #57 deliberately gave the durable product model its own error type so
 * that the domain could be used without the experiment runtime. The
 * mirror-image reason applies here: a caller needs to tell "this
 * repository's `u-sekai.yml` is wrong" apart from "a domain invariant
 * was violated while the configuration was being translated", because
 * the two have different owners and different fixes. One is a customer
 * editing a file; the other is a defect in the loader.
 *
 * Both are `Error` subclasses carrying a dotted `field` path, so a
 * diagnostic can point at `environments.staging.authority.realMoney`
 * regardless of which layer raised it.
 */

/** Prefix identifying a `USE_SEKAI_*` environment variable. */
export const ENV_VAR_PREFIX = 'USE_SEKAI_';

/**
 * Environment variable naming the configuration file.
 *
 * This is currently the *only* environment variable the configuration
 * layer reads. ADR-0011 makes the repository-controlled file the
 * authority surface, so an environment variable that could grant an
 * authority the file withheld would defeat it. See `load.ts`.
 */
export const CONFIG_PATH_ENV_VAR = `${ENV_VAR_PREFIX}CONFIG`;

/** File name read when nothing selects a different one. */
export const DEFAULT_CONFIG_FILENAME = 'u-sekai.yml';

export class UseSekaiConfigError extends Error {
  readonly kind: 'use_sekai_config_error' = 'use_sekai_config_error' as const;

  constructor(
    message: string,
    /** Dotted path of the offending field, e.g. `cohorts.regulars.size`. */
    readonly field?: string,
    readonly detail: Record<string, unknown> = {},
    /** The `ProductDomainError` this re-throws, when the domain rejected a value. */
    readonly domainCause?: Error,
  ) {
    super(message);
    this.name = 'UseSekaiConfigError';
  }
}

/**
 * Re-throw a `ProductDomainError` raised by a #57 helper as a
 * configuration error, keeping the domain's message and field path.
 *
 * The grammars that a customer can actually violate through a YAML
 * value — origins, time zones, durable ids — are owned by `src/product`
 * and are deliberately *not* restated here. Duplicating them would let
 * the file accept a URL that the domain then rejects, which is the
 * "looks validated but is not" failure this layer exists to prevent.
 */
export function asConfigError<T>(operation: () => T, fallbackField: string): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof UseSekaiConfigError) throw error;
    if (error instanceof Error && error.name === 'ProductDomainError') {
      const domainError = error as Error & {
        field?: string;
        detail?: Record<string, unknown>;
      };
      throw new UseSekaiConfigError(
        domainError.message,
        domainError.field ?? fallbackField,
        domainError.detail ?? {},
        domainError,
      );
    }
    throw error;
  }
}
