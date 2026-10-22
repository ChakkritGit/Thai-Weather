#!/usr/bin/env node
/**
 * Lists the base images this repository's Dockerfiles build FROM, for Dock's image page
 * (www/build-bases.json). No container runs from a build base, so without this list Dock calls
 * them unused although the next build needs them.
 *
 * Usage:  node deploy/dock/build-bases.mjs [--check]
 *   --check  exit 1 if www/build-bases.json is stale (used in CI)
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const OUT = join(HERE, 'www/build-bases.json');
const SKIP = new Set(['node_modules', '.git', 'target', '.next', '.venv']);

function* dockerfiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* dockerfiles(path);
    else if (entry.name === 'Dockerfile' || entry.name.endsWith('.Dockerfile')) yield path;
  }
}

const bases = new Map();
for (const file of dockerfiles(REPO)) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(line.trim())?.[1];
    if (!from || from === 'scratch') continue;
    const [ref, digest = null] = from.split('@');
    const key = `${ref}@${digest}`;
    const base = bases.get(key) ?? { ref, digest, files: [] };
    const where = relative(REPO, file);
    if (!base.files.includes(where)) base.files.push(where);
    bases.set(key, base);
  }
}

const json = `${JSON.stringify([...bases.values()].sort((a, b) => a.ref.localeCompare(b.ref)), null, 2)}\n`;
if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(OUT, 'utf8'); } catch {}
  if (current !== json) {
    console.error(`${relative(REPO, OUT)} is stale: run node deploy/dock/build-bases.mjs`);
    process.exit(1);
  }
} else {
  writeFileSync(OUT, json);
  console.log(`${relative(REPO, OUT)}: ${bases.size} base images`);
}
