'use client';

import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { CanvasSource, GeoJSONSource, ImageSource, Map as MLMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { api, type AirStation, type GridData, type GridDesc, type LayerMeta, type RadarFrame, type RunMeta } from '../lib/api';
import { buildRadarLut, decode, hexToRgb } from '../lib/color';
import { gridBounds, gridLines, imageCoordinates, rasterFor, renderGrid, sampleGrid, type Bounds, type Raster } from '../lib/render';
import { fmtNum } from '../lib/format';
import { useT } from '../i18n';
import { MAP_READY_EVENT } from '@/components/Splash';

export interface MapPoint {
  lat: number;
  lon: number;
}

interface Props {
  run: RunMeta;
  layer: LayerMeta;
  windLayer?: LayerMeta;
  index: number;
  res: 'fine' | 'coarse';
  lut: Uint8ClampedArray;
  theme: 'light' | 'dark';
  showGrid?: boolean;
  selected?: MapPoint | null;
  /** PM2.5 stations to draw as labelled dots (null/undefined = hidden) */
  air?: AirStation[] | null;
  /** latest radar frame to overlay above the weather layer (null/undefined = hidden) */
  radar?: RadarFrame | null;
  onSelect?: (p: MapPoint) => void;
  onMap?: (map: MLMap | null) => void;
  onLoading?: (loading: boolean) => void;
  className?: string;
  ariaLabel: string;
}

const THAILAND: [number, number, number, number] = [97.3, 5.6, 105.7, 20.5];
const LAND_ONLY = new Set(['temp', 'heat', 'rh']);
let radarLut: Uint8ClampedArray | null = null;

const CITIES: { th: string; en: string; lat: number; lon: number }[] = [
  { th: 'กรุงเทพฯ', en: 'Bangkok', lat: 13.7563, lon: 100.5018 },
  { th: 'เชียงใหม่', en: 'Chiang Mai', lat: 18.7883, lon: 98.9853 },
  { th: 'เชียงราย', en: 'Chiang Rai', lat: 19.9105, lon: 99.8406 },
  { th: 'พิษณุโลก', en: 'Phitsanulok', lat: 16.8211, lon: 100.2659 },
  { th: 'ขอนแก่น', en: 'Khon Kaen', lat: 16.4419, lon: 102.836 },
  { th: 'นครราชสีมา', en: 'Nakhon Ratchasima', lat: 14.9799, lon: 102.0978 },
  { th: 'อุบลราชธานี', en: 'Ubon Ratchathani', lat: 15.2287, lon: 104.8564 },
  { th: 'อุดรธานี', en: 'Udon Thani', lat: 17.4138, lon: 102.7872 },
  { th: 'พัทยา', en: 'Pattaya', lat: 12.9236, lon: 100.8825 },
  { th: 'หัวหิน', en: 'Hua Hin', lat: 12.5684, lon: 99.9577 },
  { th: 'สุราษฎร์ธานี', en: 'Surat Thani', lat: 9.1382, lon: 99.3215 },
  { th: 'ภูเก็ต', en: 'Phuket', lat: 7.8804, lon: 98.3923 },
  { th: 'หาดใหญ่', en: 'Hat Yai', lat: 7.0086, lon: 100.4747 },
  { th: 'ดอยอินทนนท์', en: 'Doi Inthanon', lat: 18.5885, lon: 98.4867 },
];

/** Read a CSS custom property (token) at runtime. */
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function parseColor(c: string): [number, number, number, number] {
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b, a = '1'] = m[1].split(',').map((s) => s.trim());
    return [Number(r), Number(g), Number(b), Number(a)];
  }
  return [...hexToRgb(c), 1];
}

let staticPromise: Promise<{ hillshade: GridData; thai: GridData }> | null = null;
const loadStatic = () =>
  (staticPromise ??= Promise.all([api.staticLayer('hillshade'), api.staticLayer('thai')]).then(([hillshade, thai]) => ({
    hillshade,
    thai,
  })));

const FINE_GRID_INK = 'rgb(12,16,22)';

function gridLineCollection(g: GridDesc, clip: Bounds): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: gridLines(g, clip) } }],
  };
}

function arrowImage(): ImageData {
  const s = 32;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  // arrow pointing up (north); rotated to the direction the wind blows towards
  ctx.moveTo(16, 3);
  ctx.lineTo(24, 15);
  ctx.lineTo(18.5, 14);
  ctx.lineTo(18.5, 29);
  ctx.lineTo(13.5, 29);
  ctx.lineTo(13.5, 14);
  ctx.lineTo(8, 15);
  ctx.closePath();
  ctx.fill();
  return ctx.getImageData(0, 0, s, s);
}

export function WeatherMap(props: Props) {
  const { run, layer, windLayer, index, res, lut, theme, showGrid, selected, onSelect, onMap, onLoading } = props;
  const { lang, pick } = useT();
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [ready, setReady] = useState(false);
  const rasterRef = useRef<Raster | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const radarCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const currentRef = useRef<{ data: GridData; grid: GridDesc; layer: LayerMeta } | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const cityMarkers = useRef<maplibregl.Marker[]>([]);
  const airMarkers = useRef<maplibregl.Marker[]>([]);
  const [hover, setHover] = useState<{ x: number; y: number; text: string; place: string } | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const fineBounds = gridBounds(run.fine_grid);

  // ---------------------------------------------------------------- init
  useEffect(() => {
    // the worker module is served from public/ (scripts/copy-maplibre-worker.mjs), same origin
    maplibregl.setWorkerUrl(`/maplibre/${maplibregl.getVersion()}/maplibre-gl-worker.mjs`);
    const map = new maplibregl.Map({
      container: container.current!,
      style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': token('--color-map-ocean') } }] },
      bounds: THAILAND,
      fitBoundsOptions: { padding: 24 },
      // phones: the bottom sheet covers the lower ~60 % of the map, so leave room to lift the south above it
      maxBounds: [
        [fineBounds.west - 4, fineBounds.south - (window.matchMedia('(max-width: 860px)').matches ? 12 : 3)],
        [fineBounds.east + 4, fineBounds.north + 3],
      ],
      minZoom: 4,
      maxZoom: 11,
      dragRotate: false,
      pitchWithRotate: false,
      attributionControl: false,
    });
    map.touchZoomRotate.disableRotation();
    // iOS Safari: cancel its own pinch gesture over the map, otherwise it may zoom the page instead of the map
    const el = container.current!;
    const stopPageZoom = (e: Event) => e.preventDefault();
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) el.addEventListener(type, stopPageZoom, { passive: false });
    // the map's data credits are printed under the legend (components/Legend.tsx) instead of an "i"
    // button floating between the timeline and the bottom navigation
    mapRef.current = map;
    const raster = rasterFor(fineBounds, run.fine_grid.nx * 2);
    rasterRef.current = raster;
    const canvas = document.createElement('canvas');
    canvas.width = raster.width;
    canvas.height = raster.height;
    canvasRef.current = canvas;
    const radarCanvas = document.createElement('canvas');
    radarCanvas.width = raster.width;
    radarCanvas.height = raster.height;
    radarCanvasRef.current = radarCanvas;
    const coords = imageCoordinates(fineBounds);
    const blank =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

    map.on('load', () => {
      map.addSource('countries', { type: 'geojson', data: api.geoUrl('countries') });
      map.addSource('provinces', { type: 'geojson', data: api.geoUrl('provinces'), promoteId: 'id' });
      map.addSource('hillshade', { type: 'image', url: blank, coordinates: coords });
      map.addSource('weather', { type: 'image', url: blank, coordinates: coords });
      // a canvas source: playback redraws it in place. An image source would drop its texture on every
      // updateImage(), which shows as a blank flash between radar frames.
      map.addSource('radar', { type: 'canvas', canvas: radarCanvas, coordinates: coords, animate: false });
      map.addSource('grid', { type: 'geojson', data: gridLineCollection(run.coarse_grid, fineBounds) });
      if (res === 'fine') map.addSource('fine-grid', { type: 'geojson', data: gridLineCollection(run.fine_grid, fineBounds) });
      map.addSource('wind', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addImage('arrow', arrowImage(), { sdf: true });

      map.addLayer({ id: 'countries-fill', type: 'fill', source: 'countries', filter: ['!=', ['get', 'code'], 'THA'], paint: { 'fill-color': token('--color-map-landOutside') } });
      map.addLayer({ id: 'provinces-fill', type: 'fill', source: 'provinces', paint: { 'fill-color': token('--color-map-land') } });
      map.addLayer({ id: 'hillshade', type: 'raster', source: 'hillshade', paint: { 'raster-fade-duration': 0 } });
      map.addLayer({
        id: 'weather',
        type: 'raster',
        source: 'weather',
        paint: { 'raster-opacity': 0.88, 'raster-fade-duration': 0, 'raster-resampling': res === 'coarse' ? 'nearest' : 'linear' },
      });
      map.addLayer({
        id: 'radar',
        type: 'raster',
        source: 'radar',
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 0.9, 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
      });
      map.addLayer({ id: 'grid', type: 'line', source: 'grid', layout: { visibility: 'none' }, paint: { 'line-color': token('--color-map-coarseGrid'), 'line-width': 0.8 } });
      if (res === 'fine') {
        // 2.2 km cell edges; only readable once zoomed in
        map.addLayer({
          id: 'fine-grid',
          type: 'line',
          source: 'fine-grid',
          minzoom: 8,
          layout: { visibility: 'none' },
          // dark ink in both themes: the weather colours under it are mostly light, a pale line vanishes
          paint: {
            'line-color': FINE_GRID_INK,
            'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.4, 11, 0.8],
            'line-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0, 9, 0.4, 11, 0.6],
          },
        });
      }
      map.addLayer({ id: 'provinces-line', type: 'line', source: 'provinces', paint: { 'line-color': token('--color-map-provinceBorder'), 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.4, 9, 1.2] } });
      map.addLayer({
        id: 'provinces-hover',
        type: 'line',
        source: 'provinces',
        paint: {
          'line-color': token('--color-map-provinceHover'),
          'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2, 0],
        },
      });
      map.addLayer({ id: 'countries-line', type: 'line', source: 'countries', paint: { 'line-color': token('--color-map-border'), 'line-width': 1.1 } });
      map.addLayer({
        id: 'wind',
        type: 'symbol',
        source: 'wind',
        layout: {
          'icon-image': 'arrow',
          'icon-rotate': ['+', ['get', 'dir'], 180],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-size': ['interpolate', ['linear'], ['get', 'speed'], 0, 0.3, 4, 0.5, 10, 0.75, 20, 0.95],
        },
        paint: { 'icon-color': token('--color-fg-default'), 'icon-halo-color': token('--color-bg-surface'), 'icon-halo-width': 1, 'icon-opacity': 0.8 },
      });

      for (const c of CITIES) {
        const el = document.createElement('div');
        el.className = 'city-label';
        el.textContent = lang === 'th' ? c.th : c.en;
        cityMarkers.current.push(new maplibregl.Marker({ element: el, anchor: 'left', offset: [-3, 0] }).setLngLat([c.lon, c.lat]).addTo(map));
      }
      setReady(true);
    });

    let hovered: string | number | undefined;
    map.on('mousemove', (e) => {
      const cur = currentRef.current;
      const f = map.queryRenderedFeatures(e.point, { layers: ['provinces-fill'] })[0];
      if (hovered !== undefined && hovered !== f?.id) map.setFeatureState({ source: 'provinces', id: hovered }, { hover: false });
      hovered = f?.id;
      if (hovered !== undefined) map.setFeatureState({ source: 'provinces', id: hovered }, { hover: true });
      if (!cur) return;
      const code = sampleGrid(cur.data.codes, cur.grid, e.lngLat.lat, e.lngLat.lng);
      if (code === null) return setHover(null);
      const v = decode(cur.layer.encoding, code);
      const digits = cur.layer.id === 'rain' && v < 10 ? 1 : cur.layer.unit === '%' ? 0 : 1;
      setHover({
        x: e.point.x,
        y: e.point.y,
        text: `${fmtNum(v, digits)} ${cur.layer.unit}`,
        place: f ? String(f.properties?.[lang === 'th' ? 'name_th' : 'name_en'] ?? '') : '',
      });
    });
    map.on('mouseout', () => setHover(null));
    map.on('click', (e) => onSelectRef.current?.({ lat: e.lngLat.lat, lon: e.lngLat.lng }));
    onMap?.(map);

    return () => {
      for (const type of ['gesturestart', 'gesturechange', 'gestureend']) el.removeEventListener(type, stopPageZoom);
      onMap?.(null);
      cityMarkers.current = [];
      map.remove();
      mapRef.current = null;
    };
    // map is created once per run grid
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.run_id]);

  // ------------------------------------------------------- theme colours
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.setPaintProperty('bg', 'background-color', token('--color-map-ocean'));
    map.setPaintProperty('countries-fill', 'fill-color', token('--color-map-landOutside'));
    map.setPaintProperty('provinces-fill', 'fill-color', token('--color-map-land'));
    map.setPaintProperty('provinces-line', 'line-color', token('--color-map-provinceBorder'));
    map.setPaintProperty('provinces-hover', 'line-color', token('--color-map-provinceHover'));
    map.setPaintProperty('countries-line', 'line-color', token('--color-map-border'));
    map.setPaintProperty('grid', 'line-color', token('--color-map-coarseGrid'));
    map.setPaintProperty('wind', 'icon-color', token('--color-fg-default'));
    map.setPaintProperty('wind', 'icon-halo-color', token('--color-bg-surface'));

    let cancelled = false;
    loadStatic().then(({ hillshade }) => {
      if (cancelled || !rasterRef.current) return;
      const [r, g, b, a] = parseColor(token('--color-map-hillshade'));
      const hLut = new Uint8ClampedArray(256 * 4);
      for (let i = 0; i < 256; i++) hLut.set([r, g, b, Math.round((i / 255) * a * 255)], i * 4);
      const c = document.createElement('canvas');
      c.width = rasterRef.current.width;
      c.height = rasterRef.current.height;
      renderGrid(c.getContext('2d')!, rasterRef.current, hillshade.codes, run.fine_grid, hLut, { edgeFadeDeg: 0.8, edgeBounds: fineBounds });
      (map.getSource('hillshade') as ImageSource).updateImage({ url: c.toDataURL(), coordinates: imageCoordinates(fineBounds) });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, ready]);

  // PM2.5 stations: HTML markers (the map style has no glyphs), coloured by the PCD level; a tap
  // opens the point panel there, like a tap anywhere else
  const air = props.air;
  useEffect(() => {
    const map = mapRef.current;
    airMarkers.current.forEach((m) => m.remove());
    airMarkers.current = [];
    if (!map || !ready || !air?.length) return;
    // zoomed out, the numbers overlap (Bangkok has dozens of stations): plain dots until zoom 7
    const box = map.getContainer();
    const compact = () => (box.dataset.aqCompact = map.getZoom() < 7 ? 'true' : 'false');
    compact();
    map.on('zoomend', compact);

    // the station's details above its dot: on hover (desktop) and pinned by a tap (any device)
    const th = lang === 'th';
    const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, offset: 14, maxWidth: '260px', className: 'aq-popup' });
    let pinned: string | null = null;
    popup.on('close', () => (pinned = null));
    const add = (parent: HTMLElement, tag: string, cls: string, text?: string) => {
      const n = document.createElement(tag);
      n.className = cls;
      if (text !== undefined) n.textContent = text;
      parent.appendChild(n);
      return n;
    };
    const content = (s: AirStation) => {
      const root = document.createElement('div');
      root.className = 'aq-pop';
      add(root, 'b', 'aq-pop-name', (th ? s.name_th : s.name_en || s.name_th).trim());
      if (s.area_th) add(root, 'span', 'aq-pop-area', s.area_th);
      const row = add(root, 'div', 'aq-pop-value');
      const dot = add(row, 'i', 'aq-pop-dot');
      dot.style.background = s.color ?? 'var(--color-fg-subtle)';
      add(row, 'strong', '', String(Math.round(s.pm25)));
      add(row, 'span', 'aq-pop-unit', 'µg/m³ PM2.5');
      add(root, 'span', 'aq-pop-level', `${th ? s.label_th : s.label_en}${s.aqi != null ? ` · AQI ${s.aqi}` : ''}`);
      const when = new Date(s.time).toLocaleTimeString(th ? 'th-TH' : 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
      add(root, 'span', 'aq-pop-time', th ? `วัดเมื่อ ${when} น. · Air4Thai` : `Measured ${when} · Air4Thai`);
      // taps inside the card must not reach the map (its click would close the card or pick a point)
      for (const type of ['pointerdown', 'mousedown', 'touchstart', 'click', 'dblclick'] as const) {
        root.addEventListener(type, (ev) => ev.stopPropagation());
      }
      const go = add(root, 'button', 'btn aq-pop-go', th ? 'ดูพยากรณ์ที่นี่' : 'Forecast here') as HTMLButtonElement;
      go.type = 'button';
      go.addEventListener('click', () => {
        popup.remove();
        onSelectRef.current?.({ lat: s.lat, lon: s.lon });
      });
      return root;
    };
    // open downwards in the upper half: above a dot near the top the card sat under the layer chips
    // hover: the card stays while the pointer travels from the dot into it
    let hideTimer: number | undefined;
    const keep = () => window.clearTimeout(hideTimer);
    const hideSoon = () => {
      keep();
      hideTimer = window.setTimeout(() => {
        if (!pinned) popup.remove();
      }, 250);
    };
    const show = (s: AirStation) => {
      keep();
      const y = map.project([s.lon, s.lat]).y;
      popup.options.anchor = y < map.getContainer().clientHeight * 0.5 ? 'top' : 'bottom';
      popup.setLngLat([s.lon, s.lat]).setDOMContent(content(s));
      // addTo() on an open popup closes it first, and that 'close' unpinned the card: a tap after
      // the hover (or the touch's emulated hover) left it to the next mouseleave, which hid it
      if (!popup.isOpen()) {
        popup.addTo(map);
        const el = popup.getElement();
        el?.addEventListener('mouseenter', keep);
        el?.addEventListener('mouseleave', hideSoon);
      }
      setHover(null);
    };

    for (const s of air) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'aq-marker';
      el.dataset.level = String(s.level ?? '');
      el.style.setProperty('--aq', s.color ?? 'var(--color-fg-subtle)');
      el.textContent = String(Math.round(s.pm25));
      const name = lang === 'th' ? s.name_th : s.name_en || s.name_th;
      el.setAttribute('aria-label', `${name}: PM2.5 ${Math.round(s.pm25)} µg/m³ (${lang === 'th' ? s.label_th : s.label_en})`);
      el.addEventListener('mouseenter', () => {
        if (!pinned) show(s);
      });
      el.addEventListener('mouseleave', () => {
        if (!pinned) hideSoon();
      });
      // MapLibre makes its own map 'click' from the press and release on its container, so a tap on
      // the dot also "clicked" the map: the card closed at once and the point panel opened instead.
      // Stopping the press itself keeps the gesture on the dot.
      for (const type of ['pointerdown', 'mousedown', 'touchstart', 'dblclick'] as const) {
        el.addEventListener(type, (ev) => ev.stopPropagation());
      }
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        show(s);
        pinned = s.id;
      });
      airMarkers.current.push(new maplibregl.Marker({ element: el }).setLngLat([s.lon, s.lat]).addTo(map));
    }
    return () => {
      map.off('zoomend', compact);
      keep();
      popup.remove();
    };
  }, [air, ready, lang]);

  useEffect(() => {
    cityMarkers.current.forEach((m, i) => (m.getElement().textContent = lang === 'th' ? CITIES[i].th : CITIES[i].en));
  }, [lang]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const vis = showGrid ? 'visible' : 'none';
    // the coarse map shows the driving-model cell edges, the fine map the fine-grid ones
    map.setLayoutProperty('grid', 'visibility', showGrid && res === 'coarse' ? 'visible' : 'none');
    if (map.getLayer('fine-grid')) map.setLayoutProperty('fine-grid', 'visibility', vis);
  }, [showGrid, ready, res]);

  // --------------------------------------------------------- weather layer
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    let cancelled = false;
    const grid = res === 'fine' ? run.fine_grid : run.coarse_grid;
    onLoading?.(true);
    Promise.all([api.layer(run.run_id, layer.id, index, res, layer.daily), loadStatic()])
      .then(([data, statics]) => {
        if (cancelled) return;
        const canvas = canvasRef.current!;
        renderGrid(canvas.getContext('2d')!, rasterRef.current!, data.codes, grid, lut, {
          mask: statics.thai.codes,
          maskGrid: run.fine_grid,
          // land-surface quantities are only meaningful inside Thailand;
          // rain, cloud and wind keep their context over the sea
          outsideAlpha: LAND_ONLY.has(layer.id) ? 0 : 0.6,
          edgeFadeDeg: LAND_ONLY.has(layer.id) ? 0 : 0.8,
          edgeBounds: fineBounds,
        });
        (map.getSource('weather') as ImageSource).updateImage({ url: canvas.toDataURL(), coordinates: imageCoordinates(fineBounds) });
        map.setPaintProperty('weather', 'raster-resampling', res === 'coarse' ? 'nearest' : 'linear');
        currentRef.current = { data, grid, layer };
      })
      .catch(() => undefined)
      .finally(() => {
        if (cancelled) return;
        onLoading?.(false);
        window.dispatchEvent(new Event(MAP_READY_EVENT)); // lifts the opening splash (first time only)
      });
    // prefetch the next frame for smooth playback
    const next = layer.daily ? index + 1 : index + 1;
    const max = layer.daily ? run.days.length : run.times.length;
    if (next < max) api.layer(run.run_id, layer.id, next, res, layer.daily).catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, run.run_id, layer.id, index, res, lut]);

  // ----------------------------------------------------------- radar overlay
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const frame = props.radar;
    const g = run.fine_grid;
    if (!frame || frame.ny !== g.ny || frame.nx !== g.nx || !rasterRef.current) {
      map.setLayoutProperty('radar', 'visibility', 'none');
      return;
    }
    const c = radarCanvasRef.current!;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    radarLut ??= buildRadarLut();
    renderGrid(ctx, rasterRef.current, frame.codes, g, radarLut, { edgeFadeDeg: 0.4, edgeBounds: fineBounds });
    // a paused canvas source only re-uploads its texture while playing: play for one rendered frame
    const src = map.getSource('radar') as CanvasSource;
    src.play();
    map.once('render', () => src.pause());
    map.setLayoutProperty('radar', 'visibility', 'visible');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, props.radar, run.run_id]);

  // ------------------------------------------------------------ wind arrows
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const src = map.getSource('wind') as GeoJSONSource;
    if (layer.id !== 'wind' || !windLayer) {
      src.setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    let cancelled = false;
    const grid = res === 'fine' ? run.fine_grid : run.coarse_grid;
    const stride = res === 'fine' ? 12 : Math.max(1, Math.round((12 * run.fine_grid.dlat) / run.coarse_grid.dlat));
    Promise.all([api.layer(run.run_id, 'wind', index, res, false), api.layer(run.run_id, 'wind_dir', index, res, false)]).then(
      ([speed, dir]) => {
        if (cancelled) return;
        const features: GeoJSON.Feature[] = [];
        for (let iy = stride >> 1; iy < grid.ny; iy += stride) {
          for (let ix = stride >> 1; ix < grid.nx; ix += stride) {
            const k = iy * grid.nx + ix;
            features.push({
              type: 'Feature',
              properties: { speed: decode(layer.encoding, speed.codes[k]), dir: decode(windLayer.encoding, dir.codes[k]) },
              geometry: { type: 'Point', coordinates: [grid.lon0 + ix * grid.dlon, grid.lat0 + iy * grid.dlat] },
            });
          }
        }
        src.setData({ type: 'FeatureCollection', features });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ready, run, layer, windLayer, index, res]);

  // ---------------------------------------------------------- selection pin
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    markerRef.current?.remove();
    markerRef.current = null;
    if (selected) {
      const el = document.createElement('div');
      el.className = 'pin';
      markerRef.current = new maplibregl.Marker({ element: el }).setLngLat([selected.lon, selected.lat]).addTo(map);
    }
  }, [selected, ready]);

  return (
    <div className={props.className} role="region" aria-label={props.ariaLabel}>
      <div ref={container} style={{ position: 'absolute', inset: 0 }} />
      {hover && (
        <div className="map-tooltip" style={{ left: hover.x, top: hover.y }}>
          <b>{hover.text}</b>
          {hover.place && <span> · {hover.place}</span>}
          <span className="sr-only">{pick(layer)}</span>
        </div>
      )}
    </div>
  );
}
