import type { GridDesc } from './api';

/**
 * Draw a regular lat/lon grid into a canvas laid out in Web-Mercator space.
 *
 * MapLibre stretches image sources linearly between their corners in
 * Mercator coordinates, so each canvas row is mapped back to its true
 * latitude here – otherwise a 15°-tall lat/lon image would be misplaced by
 * up to ~15 km, more than the 2 km cells we are trying to show.
 */

const RAD = Math.PI / 180;
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));
const invMercY = (y: number) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD;

export interface Bounds {
  west: number;
  east: number;
  south: number;
  north: number;
}

/** Outer cell edges of a grid. */
export function gridBounds(g: GridDesc): Bounds {
  return {
    west: g.lon0 - g.dlon / 2,
    east: g.lon1 + g.dlon / 2,
    south: g.lat0 - g.dlat / 2,
    north: g.lat1 + g.dlat / 2,
  };
}

export function imageCoordinates(b: Bounds): [[number, number], [number, number], [number, number], [number, number]] {
  return [
    [b.west, b.north],
    [b.east, b.north],
    [b.east, b.south],
    [b.west, b.south],
  ];
}

export interface Raster {
  width: number;
  height: number;
  lats: Float64Array; // per canvas row
  lons: Float64Array; // per canvas column
}

export function rasterFor(bounds: Bounds, width: number): Raster {
  const yN = mercY(bounds.north);
  const yS = mercY(bounds.south);
  const height = Math.round((width * (yN - yS)) / ((bounds.east - bounds.west) * RAD));
  const lats = new Float64Array(height);
  const lons = new Float64Array(width);
  for (let r = 0; r < height; r++) lats[r] = invMercY(yN - ((r + 0.5) / height) * (yN - yS));
  for (let c = 0; c < width; c++) lons[c] = bounds.west + ((c + 0.5) / width) * (bounds.east - bounds.west);
  return { width, height, lats, lons };
}

function indexMap(raster: Raster, g: GridDesc) {
  const rows = new Int32Array(raster.height);
  const cols = new Int32Array(raster.width);
  for (let r = 0; r < raster.height; r++) {
    rows[r] = Math.min(g.ny - 1, Math.max(0, Math.round((raster.lats[r] - g.lat0) / g.dlat)));
  }
  for (let c = 0; c < raster.width; c++) {
    cols[c] = Math.min(g.nx - 1, Math.max(0, Math.round((raster.lons[c] - g.lon0) / g.dlon)));
  }
  return { rows, cols };
}

const indexCache = new WeakMap<Raster, Map<string, ReturnType<typeof indexMap>>>();
function cachedIndex(raster: Raster, g: GridDesc) {
  let m = indexCache.get(raster);
  if (!m) indexCache.set(raster, (m = new Map()));
  const key = `${g.lat0},${g.lon0},${g.dlat},${g.dlon},${g.ny},${g.nx}`;
  let v = m.get(key);
  if (!v) m.set(key, (v = indexMap(raster, g)));
  return v;
}

export interface RenderOptions {
  /** 0/1 mask on `maskGrid`; cells with 0 are drawn with `outsideAlpha`. */
  mask?: Uint8Array;
  maskGrid?: GridDesc;
  outsideAlpha?: number;
  alpha?: number;
  /** fade the layer out over this many degrees towards the domain edge */
  edgeFadeDeg?: number;
  edgeBounds?: Bounds;
}

function edgeFade(values: Float64Array, lo: number, hi: number, width: number): Float32Array {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const d = Math.min(values[i] - lo, hi - values[i]);
    out[i] = width > 0 ? Math.max(0, Math.min(1, d / width)) : 1;
  }
  return out;
}

export function renderGrid(
  ctx: CanvasRenderingContext2D,
  raster: Raster,
  codes: Uint8Array,
  grid: GridDesc,
  lut: Uint8ClampedArray,
  opts: RenderOptions = {},
): void {
  const { rows, cols } = cachedIndex(raster, grid);
  const m = opts.mask && opts.maskGrid ? cachedIndex(raster, opts.maskGrid) : null;
  const img = ctx.createImageData(raster.width, raster.height);
  const out = img.data;
  const outside = opts.outsideAlpha ?? 1;
  const alpha = opts.alpha ?? 1;
  const eb = opts.edgeBounds;
  const fw = opts.edgeFadeDeg ?? 0;
  const rowFade = eb ? edgeFade(raster.lats, eb.south, eb.north, fw) : null;
  const colFade = eb ? edgeFade(raster.lons, eb.west, eb.east, fw) : null;
  let p = 0;
  for (let r = 0; r < raster.height; r++) {
    const base = rows[r] * grid.nx;
    const mBase = m ? m.rows[r] * opts.maskGrid!.nx : 0;
    const rf = rowFade ? rowFade[r] : 1;
    for (let c = 0; c < raster.width; c++, p += 4) {
      const l = codes[base + cols[c]] * 4;
      let a = lut[l + 3] * alpha * rf * (colFade ? colFade[c] : 1);
      if (m && opts.mask![mBase + m.cols[c]] === 0) a *= outside;
      out[p] = lut[l];
      out[p + 1] = lut[l + 1];
      out[p + 2] = lut[l + 2];
      out[p + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Value lookup for hover read-outs (nearest cell). */
export function sampleGrid(codes: Uint8Array, g: GridDesc, lat: number, lon: number): number | null {
  const iy = Math.round((lat - g.lat0) / g.dlat);
  const ix = Math.round((lon - g.lon0) / g.dlon);
  if (iy < 0 || ix < 0 || iy >= g.ny || ix >= g.nx) return null;
  return codes[iy * g.nx + ix];
}
