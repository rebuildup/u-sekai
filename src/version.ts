import { createRequire } from 'node:module';

interface PackageMetadata {
  readonly version?: unknown;
}

const require = createRequire(import.meta.url);
const metadata = require('../package.json') as PackageMetadata;

if (typeof metadata.version !== 'string' || metadata.version.length === 0) {
  throw new Error('package.json must contain a non-empty version string');
}

/** Canonical package/release version sourced from package.json. */
export const VERSION = metadata.version;
