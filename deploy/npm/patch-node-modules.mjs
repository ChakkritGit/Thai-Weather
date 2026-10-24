// Replaces packages in /app/node_modules with the published tarballs in the given directory (Nginx Proxy
// Manager's yarn.lock pins versions with known CVEs), then checks both directions: every dependency of a
// replaced package resolves to a version its range accepts, and every package that depends on a replaced
// one still accepts the new version. Exceptions are listed in OUTSIDE_RANGE; anything else fails the build.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const ROOT = '/app/node_modules';
const semver = createRequire('/app/')('semver');
/** dependent → package: accepted although outside the declared range, and why */
const OUTSIDE_RANGE = {
  'get-uri>basic-ftp': 'ftp:// PAC files only (never used by NPM); 6.x keeps the Client API get-uri calls',
};

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
/** Node's lookup: <dir>/node_modules/<name>, then each parent's */
function locate(name, from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const p = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(p)) return p;
    if (dir === '/' || dir === path.dirname(dir)) return null;
  }
}
function* packages(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (name.startsWith('@')) { yield* packages(full); continue; }
    if (!fs.existsSync(path.join(full, 'package.json'))) continue;
    yield full;
    if (fs.existsSync(path.join(full, 'node_modules'))) yield* packages(path.join(full, 'node_modules'));
  }
}

const replaced = new Map();
for (const tgz of fs.readdirSync(process.argv[2]).filter((f) => f.endsWith('.tgz'))) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-'));
  execFileSync('tar', ['-xzf', path.join(process.argv[2], tgz), '-C', tmp, '--no-same-owner']);
  const pkg = read(path.join(tmp, 'package/package.json'));
  const target = path.join(ROOT, pkg.name);
  if (!fs.existsSync(target)) throw new Error(`${pkg.name} is not installed at the top level`);
  const old = read(path.join(target, 'package.json')).version;
  fs.rmSync(target, { recursive: true });
  fs.cpSync(path.join(tmp, 'package'), target, { recursive: true });
  fs.rmSync(tmp, { recursive: true });
  replaced.set(pkg.name, pkg.version);
  console.log(`${pkg.name} ${old} -> ${pkg.version}`);
}

let bad = 0;
for (const dir of packages(ROOT)) {
  const pkg = read(path.join(dir, 'package.json'));
  for (const [dep, range] of Object.entries({ ...pkg.dependencies, ...pkg.peerDependencies })) {
    if (!replaced.has(pkg.name) && !replaced.has(dep)) continue;
    const found = locate(dep, dir);
    if (!found) {
      if (pkg.peerDependencies?.[dep] || pkg.optionalDependencies?.[dep]) continue;
      console.error(`!! ${pkg.name} needs ${dep}@${range}: not installed`); bad++; continue;
    }
    const version = read(found).version;
    if (semver.satisfies(version, range, { includePrerelease: true })) continue;
    const why = OUTSIDE_RANGE[`${pkg.name}>${dep}`];
    if (why) { console.log(`   ${pkg.name} wants ${dep}@${range}, has ${version}: ${why}`); continue; }
    console.error(`!! ${pkg.name} needs ${dep}@${range}, found ${version} (${path.relative(ROOT, found)})`); bad++;
  }
}
if (bad) process.exit(1);
