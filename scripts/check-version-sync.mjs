import { readFileSync } from 'node:fs';

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
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

if (lock.packages?.['']?.version !== pkg.version) {
  errors.push(`package-lock root version ${JSON.stringify(lock.packages?.['']?.version)} != package.json version ${JSON.stringify(pkg.version)}`);
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
