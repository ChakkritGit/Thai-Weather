#!/usr/bin/env node
// Builds the Cyber page's static data from Natural Earth (public domain, https://www.naturalearthdata.com/):
//   www/world-map.json                         equirectangular country outlines (110m), as SVG path data
//   ../apps/rust-services/src/centroids.rs     country label points (10m) for the arc start points
// Run it by hand after changing the projection or the Natural Earth tag; the outputs are committed.
//   node deploy/dock/build-map.mjs [--src DIR]   (DIR caches the downloads; default: the OS temp dir)
// The downloads are pinned to a release tag and checked against SHA-256, so a changed upstream file fails loudly.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TAG = 'v5.1.2';
const BASE = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${TAG}/geojson`;
const SOURCES = {
  'ne_110m_admin_0_countries.geojson': '6866c877d39cba9c357620878839b336d569f8c662d3cfab4cb1dbe2d39c977f',
  'ne_10m_admin_0_countries.geojson': '239eec57ac17f100a11e2536cffc56752c318b50ae765b0918ff7aab4ce8f255',
};

// The map is cropped to 84N..58S (no Antarctica) and 1000 units wide; the page projects points with the same numbers.
const LON = [-180, 180];
const LAT = [84, -58];
const W = 1000;
const H = Number(((W * (LAT[0] - LAT[1])) / (LON[1] - LON[0])).toFixed(1));
const proj = ([lon, lat]) => [((lon - LON[0]) / (LON[1] - LON[0])) * W, ((LAT[0] - lat) / (LAT[0] - LAT[1])) * H];

// DB-IP's codes that Natural Earth's 10m countries do not carry as their own entry: label points by hand
// (rough geographic centres, enough for an arc start).
const EXTRA = {
  BL: ['Saint Barthelemy', 17.9, -62.83],
  BQ: ['Caribbean Netherlands', 12.18, -68.25],
  BV: ['Bouvet Island', -54.42, 3.36],
  CC: ['Cocos (Keeling) Islands', -12.16, 96.87],
  CX: ['Christmas Island', -10.49, 105.63],
  GF: ['French Guiana', 3.93, -53.13],
  GP: ['Guadeloupe', 16.25, -61.58],
  MF: ['Saint Martin', 18.08, -63.05],
  MQ: ['Martinique', 14.65, -61.02],
  RE: ['Reunion', -21.12, 55.53],
  SJ: ['Svalbard and Jan Mayen', 78, 16],
  TK: ['Tokelau', -9.2, -171.85],
  XK: ['Kosovo', 42.6, 20.9],
  YT: ['Mayotte', -12.83, 45.17],
};

async function fetchSource(dir, name) {
  const file = join(dir, name);
  if (!existsSync(file)) {
    const res = await fetch(`${BASE}/${name}`);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const bytes = readFileSync(file);
  const sum = createHash('sha256').update(bytes).digest('hex');
  if (sum !== SOURCES[name]) throw new Error(`${name}: sha256 ${sum} does not match the pinned ${SOURCES[name]}`);
  return JSON.parse(bytes.toString('utf8'));
}

/** Douglas-Peucker on an open polyline of [x, y]; the tolerance is in map units */
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const len = Math.hypot(bx - ax, by - ay) || 1e-9;
    let far = -1;
    let dist = eps;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((by - ay) * (pts[i][0] - ax) - (bx - ax) * (pts[i][1] - ay)) / len;
      if (d > dist) { dist = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
/** a closed ring has a zero-length chord, so it is cut at the point farthest from its start first */
function simplifyRing(ring, eps) {
  let m = 1;
  let best = -1;
  ring.forEach(([x, y], i) => {
    const d = Math.hypot(x - ring[0][0], y - ring[0][1]);
    if (d > best) { best = d; m = i; }
  });
  return [...simplify(ring.slice(0, m + 1), eps), ...simplify(ring.slice(m), eps).slice(1)];
}
const area = (ring) => Math.abs(ring.reduce((s, [x, y], i) => { const [nx, ny] = ring[(i + 1) % ring.length]; return s + (x * ny - nx * y); }, 0)) / 2;
const num = (v) => { const s = v.toFixed(1).replace(/\.0$/, '').replace(/^(-?)0\./, '$1.'); return s === '-0' ? '0' : s; };

/** one ring as "M x y l dx dy ..." with deltas between the rounded points, so rounding never drifts */
function ringPath(ring) {
  const q = ring.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
  let out = `M${num(q[0][0])} ${num(q[0][1])}l`;
  let prev = '';
  for (let i = 1; i < q.length; i++) {
    const d = `${num(q[i][0] - q[i - 1][0])} ${num(q[i][1] - q[i - 1][1])}`;
    // a space is only needed where the next number does not start with a sign or a dot after a dot-number
    out += (prev && !d.startsWith('-') ? ' ' : '') + d;
    prev = d;
  }
  return `${out}z`;
}

const polygonsOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);

function buildMap(geo) {
  const countries = {};
  let other = '';
  for (const f of geo.features) {
    const cc = f.properties.ISO_A2_EH;
    if (cc === 'AQ') continue;
    const rings = [];
    for (const poly of polygonsOf(f.geometry)) {
      const outer = poly[0].map(proj).filter(([, y]) => y <= H + 0.5);
      if (outer.length < 4) continue;
      const slim = simplifyRing(outer, 0.3);
      if (slim.length >= 4) rings.push(slim);
    }
    if (!rings.length) continue;
    // islands under ~1 unit^2 are specks at this scale, but a country made of nothing else keeps its biggest one
    rings.sort((a, b) => area(b) - area(a));
    const shown = rings.filter((r, i) => i === 0 || area(r) >= 1);
    const d = shown.map(ringPath).join('');
    if (/^[A-Z]{2}$/.test(cc)) countries[cc] = (countries[cc] ?? '') + d;
    else other += d;
  }
  return { w: W, h: H, lon: LON, lat: LAT, c: countries, o: other };
}

function buildCentroids(geo) {
  const rows = new Map();
  for (const f of geo.features) {
    const cc = f.properties.ISO_A2_EH;
    if (!/^[A-Z]{2}$/.test(cc) || rows.has(cc)) continue;
    rows.set(cc, [f.properties.NAME || f.properties.NAME_EN, f.properties.LABEL_Y, f.properties.LABEL_X]);
  }
  for (const [cc, row] of Object.entries(EXTRA)) if (!rows.has(cc)) rows.set(cc, row);
  const body = [...rows.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([cc, [name, lat, lon]]) => `    (${JSON.stringify(cc)}, ${JSON.stringify(name)}, ${Number(lat).toFixed(2)}, ${Number(lon).toFixed(2)}),`)
    .join('\n');
  return `// Generated by deploy/dock/build-map.mjs from Natural Earth ${TAG} (ne_10m_admin_0_countries, public domain):
// the label point of each country (LABEL_Y, LABEL_X) and its English name. Do not edit by hand.

/// (ISO 3166-1 alpha-2, English name, latitude, longitude), sorted by code
#[rustfmt::skip]
pub const COUNTRIES: &[(&str, &str, f32, f32)] = &[
${body}
];
`;
}

const arg = process.argv.indexOf('--src');
const dir = arg > 0 ? process.argv[arg + 1] : join(tmpdir(), 'dock-build-map');
mkdirSync(dir, { recursive: true });
const map = buildMap(await fetchSource(dir, 'ne_110m_admin_0_countries.geojson'));
const json = JSON.stringify(map);
writeFileSync(join(here, 'www/world-map.json'), `${json}\n`);
writeFileSync(join(here, '../apps/rust-services/src/centroids.rs'), buildCentroids(await fetchSource(dir, 'ne_10m_admin_0_countries.geojson')));
console.log(`world-map.json ${(json.length / 1024).toFixed(1)} KB, ${Object.keys(map.c).length} countries`);
