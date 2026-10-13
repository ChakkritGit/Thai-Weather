// MapLibre 6 loads its web worker from a separate module next to the main bundle, which the Next
// bundler does not emit. Copy the worker (and the shared module it imports) into public/ under the
// package version, so the browser fetches them from this origin; WeatherMap points setWorkerUrl here.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(root, 'node_modules', 'maplibre-gl');
const { version } = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
const out = join(root, 'public', 'maplibre', version);
mkdirSync(out, { recursive: true });
for (const f of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) copyFileSync(join(pkg, 'dist', f), join(out, f));
copyFileSync(join(pkg, 'LICENSE.txt'), join(out, 'LICENSE.txt'));
console.log(`maplibre-gl ${version} worker → public/maplibre/${version}/`);
