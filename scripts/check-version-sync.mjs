import { readFileSync } from 'node:fs';

/**
 * @param {string} relativePath
 * @returns {Record<string, unknown>}
 */
function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

const pkg = readJson('../package.json');
const lock = readJson('../package-lock.json');
const errors = [];

if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
  errors.push(`package.json version must be stable semver x.y.z, got ${JSON.stringify(pkg.version)}`);
}

if (lock.version !== pkg.version) {
  errors.push(`package-lock.json version ${JSON.stringify(lock.version)} != package.json version ${JSON.stringify(pkg.version)}`);
}

const lockPackages = asRecord(lock.packages);
if (asRecord(lockPackages['']).version !== pkg.version) {
  errors.push(`package-lock root version ${JSON.stringify(asRecord(lockPackages['']).version)} != package.json version ${JSON.stringify(pkg.version)}`);
}

const ref = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || '';
if (ref.startsWith('release-') && typeof pkg.version === 'string') {
  const expected = `release-${pkg.version.replaceAll('.', '-')}`;
  if (ref !== expected) {
    errors.push(`release branch ${JSON.stringify(ref)} != expected ${JSON.stringify(expected)} from package.json`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`version-sync: ${error}`);
  process.exit(1);
}

console.log(`version-sync: ok (${pkg.version})`);
