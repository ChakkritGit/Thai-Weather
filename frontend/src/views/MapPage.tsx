'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MLMap } from 'maplibre-gl';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { api, type AirForecast, type AirStation, type LayerId, type Meta, type RunMeta } from '../lib/api';
import { buildLut } from '../lib/color';
import { fmtHour, fmtKm, nearestStep, thaiDate } from '../lib/format';
import { nextFrameId } from '../lib/radarHistory';
import { decodeFrame, frameIndex } from '../lib/pmField';
import { useRadar } from '../lib/useRadar';
import { useT } from '../i18n';
import { useTheme } from '../lib/theme';
import { Icon } from '../components/Icon';
import { LayerPicker } from '../components/LayerPicker';
import { LocateCta, type LocateStatus } from '../components/LocateCta';
import { Legend, MapCredit } from '../components/Legend';
import { RadarControl } from '../components/RadarControl';
import { OverviewPanel } from '../components/OverviewPanel';
import { PointPanel } from '../components/PointPanel';
import { PlaceSearch } from '../components/PlaceSearch';
import { Timeline } from '../components/Timeline';
import type { MapPoint } from '../components/WeatherMap';

/**
 * Only the map itself needs the browser (MapLibre uses `window` and WebGL), so only it loads on the
 * client: the rest of this page (sidebar, legend, timeline) is in the server's HTML and paints with
 * the first frame. When the whole page was client-only, its largest text came ~5 s later on a phone.
 */
const WeatherMap = dynamic(() => import('../components/WeatherMap').then((m) => m.WeatherMap), { ssr: false });

const STORE_KEY = 'thwx.layer';
/** Phones: the point panel is a bottom sheet (see base.css, max-width 860px). */
const SHEET_MQ = '(max-width: 860px)';
/** Height of a collapsed ("peek") sheet: handle + place name. Keep in step with --sheet-peek. */
const SHEET_PEEK_PX = 96;
/** Space the layer chips and top controls take over the map. */
const TOP_CONTROLS_PX = 104;
const LOC_KEY = 'thwx.lastLocation';

/**
 * The map center that shows `p` `dy` pixels below the middle of the map at `zoom` (Web Mercator,
 * 512 px tiles). Used instead of the camera `offset` option, which MapLibre 6.11 ends up ignoring.
 */
function centerShowing(p: MapPoint, zoom: number, dy: number): [number, number] {
  if (!dy) return [p.lon, p.lat];
  const world = 512 * 2 ** zoom;
  const y = (1 - Math.log(Math.tan(Math.PI / 4 + (p.lat * Math.PI) / 360)) / Math.PI) / 2 - dy / world;
  return [p.lon, (360 / Math.PI) * Math.atan(Math.exp(Math.PI * (1 - 2 * y))) - 90];
}

function lastLocation(): MapPoint | null {
  try {
    const p = JSON.parse(localStorage.getItem(LOC_KEY) ?? 'null');
    return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? { lat: p.lat, lon: p.lon } : null;
  } catch {
    return null;
  }
}

/** True only when the user already granted location access – never triggers a permission prompt. */
async function locationGranted(): Promise<boolean> {
  try {
    const st = await navigator.permissions?.query({ name: 'geolocation' });
    return st?.state === 'granted';
  } catch {
    return false;
  }
}

function initialLayer(): LayerId {
  try {
    return (localStorage.getItem(STORE_KEY) as LayerId) || 'temp';
  } catch {
    return 'temp';
  }
}

export default function MapPage({ meta, run, initialPoint }: { meta: Meta; run: RunMeta; initialPoint?: MapPoint | null }) {
  const { t, lang } = useT();
  const { theme } = useTheme();
  // the stored layer is read after hydration: the server cannot see it, and both renders must match
  const [layerId, setLayerId] = useState<LayerId>('temp');
  useEffect(() => {
    const stored = initialLayer();
    if (stored !== 'temp') setLayerId(stored);
  }, []);
  // The clock behind "now": ticks every minute and again whenever the page comes back (an iPhone
  // resumes a home-screen app with its old state), so the current hour never goes stale.
  const [clock, setClock] = useState(() => Date.now());
  const nowIdx = useMemo(() => nearestStep(run.times, clock), [run.times, clock]);
  const [step, setStep] = useState(nowIdx);
  const [day, setDay] = useState(0);
  const [playing, setPlaying] = useState(false);
  const router = useRouter();
  useEffect(() => {
    let hiddenAt = 0;
    let lastRefresh = Date.now();
    // a newer forecast run replaces this page (it is keyed by run id); the server answer is cached 30 s
    const refreshRun = () => {
      lastRefresh = Date.now();
      router.refresh();
    };
    const tick = () => {
      setClock(Date.now());
      if (document.visibilityState === 'visible' && Date.now() - lastRefresh > 30 * 60_000) refreshRun();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      setClock(Date.now());
      if (hiddenAt && Date.now() - hiddenAt > 10 * 60_000) refreshRun();
    };
    const id = window.setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', tick);
    };
  }, [router]);
  // following "now": when the hour moves on, a timeline that sat on the old "now" moves with it
  // (one the user moved elsewhere, or playback, is left alone)
  const prevNow = useRef(nowIdx);
  useEffect(() => {
    const prev = prevNow.current;
    prevNow.current = nowIdx;
    if (prev === nowIdx || playing) return;
    setStep((s) => (s === prev ? nowIdx : s));
  }, [nowIdx, playing]);
  const [compare, setCompare] = useState(false);
  const [split, setSplit] = useState(0.5);
  const [selected, setSelectedState] = useState<MapPoint | null>(initialPoint ?? null);
  // keep the selected point in the URL so a forecast location can be shared
  const setSelected = useCallback((p: MapPoint | null) => {
    setSelectedState(p);
    const url = p ? `?lat=${p.lat.toFixed(3)}&lon=${p.lon.toFixed(3)}` : window.location.pathname;
    window.history.replaceState(null, '', url);
  }, []);
  const [loading, setLoading] = useState(false);
  const [radarOn, setRadarOn] = useState(false);
  const radar = useRadar(radarOn);
  const stageRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [gridOn, setGridOn] = useState(false);
  // PM2.5 now at the Air4Thai stations, fetched while shown and every 10 minutes after
  const [airOn, setAirOn] = useState(false);
  const [airStations, setAirStations] = useState<AirStation[] | null>(null);
  // and the PM2.5 forecast field (FMI SILAM), drawn for the timeline's hour in place of the weather layer
  const [airForecast, setAirForecast] = useState<AirForecast | null>(null);
  useEffect(() => {
    if (!airOn) return;
    let cancelled = false;
    const load = () => api.airForecast().then((d) => !cancelled && setAirForecast(d)).catch(() => {});
    load();
    const timer = window.setInterval(load, 30 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [airOn]);
  useEffect(() => {
    if (!airOn) return;
    let cancelled = false;
    const load = () => api.airStations().then((d) => !cancelled && setAirStations(d.stations)).catch(() => {});
    load();
    const timer = window.setInterval(load, 10 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [airOn]);
  const sheetRef = useRef<HTMLElement>(null);
  const [peek, setPeek] = useState(false);
  const peekRef = useRef(peek);
  peekRef.current = peek;
  const maps = useRef<{ fine: MLMap | null; coarse: MLMap | null }>({ fine: null, coarse: null });

  /** Phones: how far above the map's middle a point must sit to be in the middle of the area left above the sheet. */
  const sheetLift = useCallback((): number => {
    const stage = stageRef.current;
    if (!stage || !window.matchMedia(SHEET_MQ).matches) return 0;
    const h = stage.clientHeight;
    const cover = peekRef.current ? SHEET_PEEK_PX : h * 0.62;
    return Math.round((TOP_CONTROLS_PX - cover) / 2);
  }, []);
  // a point to fly to once the fine map exists and has loaded
  const pendingFly = useRef<MapPoint | null>(null);
  /** when flyTo last started (locate / a shared link): such a selection already lands above the sheet */
  const flewAt = useRef(0);
  const flyTo = useCallback((p: MapPoint, zoom = 8) => {
    const m = maps.current.fine;
    if (!m) {
      pendingFly.current = p;
      return;
    }
    const go = () => {
      flewAt.current = Date.now();
      m.flyTo({ center: centerShowing(p, zoom, sheetLift()), zoom });
    };
    if (m.loaded()) go();
    else m.once('load', go);
  }, [sheetLift]);

  const layer = meta.layers.find((l) => l.id === layerId) ?? meta.layers[0];
  const windLayer = meta.layers.find((l) => l.id === 'wind_dir');
  const lut = useMemo(() => buildLut(layer), [layer]);
  const index = layer.daily ? day : step;

  const layerSaved = useRef(false);
  useEffect(() => {
    // not on the first render, which still shows the default before the stored layer is read
    if (!layerSaved.current) {
      layerSaved.current = true;
      return;
    }
    try {
      localStorage.setItem(STORE_KEY, layerId);
    } catch {
      /* storage unavailable */
    }
  }, [layerId]);

  // hide the secondary tag lines when the stage is too narrow for them
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < 560));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // keep the daily selector in step with the hourly timeline
  useEffect(() => {
    const d = run.days.findIndex((x) => x.date === thaiDate(run.times[step]));
    if (d >= 0) setDay(d);
  }, [step, run]);

  const unsync = useRef<(() => void) | null>(null);
  const syncMaps = useCallback(() => {
    unsync.current?.();
    unsync.current = null;
    const { fine, coarse } = maps.current;
    if (!fine || !coarse) return;
    let lock = false;
    const follow = (src: MLMap, dst: MLMap) => () => {
      if (lock) return;
      lock = true;
      dst.jumpTo({ center: src.getCenter(), zoom: src.getZoom() });
      lock = false;
    };
    const a = follow(fine, coarse);
    const b = follow(coarse, fine);
    coarse.jumpTo({ center: fine.getCenter(), zoom: fine.getZoom() });
    fine.on('move', a);
    coarse.on('move', b);
    unsync.current = () => {
      fine.off('move', a);
      coarse.off('move', b);
    };
  }, []);

  const onFineMap = useCallback(
    (m: MLMap | null) => {
      maps.current.fine = m;
      syncMaps();
      if (m && initialPoint) m.once('load', () => m.flyTo({ center: centerShowing(initialPoint, 7.5, sheetLift()), zoom: 7.5 }));
      else if (m && pendingFly.current) {
        const p = pendingFly.current;
        pendingFly.current = null;
        m.once('load', () => m.flyTo({ center: centerShowing(p, 8, sheetLift()), zoom: 8 }));
      }
    },
    [syncMaps, initialPoint, sheetLift],
  );
  const onCoarseMap = useCallback(
    (m: MLMap | null) => {
      maps.current.coarse = m;
      syncMaps();
    },
    [syncMaps],
  );

  const dragSplit = (e: React.PointerEvent) => {
    const el = stageRef.current!;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      setSplit(Math.min(0.95, Math.max(0.05, (ev.clientX - r.left) / r.width)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onSplitKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') setSplit((s) => Math.max(0.05, s - 0.05));
    if (e.key === 'ArrowRight') setSplit((s) => Math.min(0.95, s + 0.05));
  };

  // ------------------------------------------------------------ phone bottom sheet
  // A new point opens the sheet fully; a point the open sheet would hide is moved up into view.
  useEffect(() => {
    setPeek(false);
    const m = maps.current.fine;
    const stage = stageRef.current;
    if (!selected || !m || !stage || !window.matchMedia(SHEET_MQ).matches) return;
    if (Date.now() - flewAt.current < 1000) return; // locate already flies it into view
    const y = m.project([selected.lon, selected.lat]).y;
    const sheetTop = stage.clientHeight * (1 - 0.62);
    if (y > sheetTop - 40 || y < TOP_CONTROLS_PX) m.easeTo({ center: centerShowing(selected, m.getZoom(), sheetLift()), duration: 450 });
  }, [selected, sheetLift]);

  // Drag the sheet: down to a peek (just the place name), down again to close, up to open. From the
  // handle any time, from the content only while it is scrolled to the top (otherwise it scrolls).
  const closeSheet = useRef(() => setSelected(null));
  closeSheet.current = () => setSelected(null);
  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const mq = window.matchMedia(SHEET_MQ);
    let startY = 0;
    let dy = 0;
    let dragging = false;
    let fromHandle = false;
    let base: number | null = null;
    const start = (e: TouchEvent) => {
      if (!mq.matches || el.dataset.open !== 'true' || e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      fromHandle = y - el.getBoundingClientRect().top < 44;
      if (!fromHandle && el.scrollTop > 0) return;
      startY = y;
      dy = 0;
      base = null;
      dragging = true;
    };
    const move = (e: TouchEvent) => {
      if (!dragging) return;
      dy = e.touches[0].clientY - startY;
      const peeked = el.dataset.peek === 'true';
      if (!fromHandle && !peeked && dy < 0) {
        dragging = false; // an upward swipe on the content is a scroll
        return;
      }
      e.preventDefault();
      if (base === null) base = new DOMMatrix(getComputedStyle(el).transform).m42; // where the sheet sits now
      el.style.transition = 'none';
      el.style.transform = `translateY(${Math.max(0, base + dy)}px)`;
    };
    const end = () => {
      if (!dragging) return;
      dragging = false;
      el.style.transition = '';
      el.style.transform = '';
      if (Math.abs(dy) < 8) return; // a tap: the handle button handles it
      if (el.dataset.peek !== 'true') {
        if (dy > 70) setPeek(true);
      } else if (dy < -40) setPeek(false);
      else if (dy > 50) closeSheet.current();
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
    };
  }, []);

  // the grid only reads once zoomed in (cells are ~4 px wide at zoom 8): turning it on zooms there
  const toggleGrid = useCallback(() => {
    setGridOn((on) => {
      const m = maps.current.fine;
      if (!on && m && m.getZoom() < 9) {
        const c = selected ? { center: centerShowing(selected, 9.5, sheetLift()) } : {};
        m.easeTo({ zoom: 9.5, duration: 600, ...c });
      }
      return !on;
    });
  }, [selected, sheetLift]);

  const [locateStatus, setLocateStatus] = useState<LocateStatus>('idle');
  const locate = useCallback(
    (opts: { quiet?: boolean } = {}) => {
      if (!navigator.geolocation) {
        if (!opts.quiet) setLocateStatus('failed');
        return;
      }
      if (!opts.quiet) setLocateStatus('locating');
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const p = { lat: pos.coords.latitude, lon: pos.coords.longitude };
          try {
            localStorage.setItem(LOC_KEY, JSON.stringify(p));
          } catch {
            /* storage unavailable */
          }
          setLocateStatus('idle');
          setSelected(p);
          flyTo(p);
        },
        (err) => {
          if (!opts.quiet) setLocateStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'failed');
        },
        { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 },
      );
    },
    [setSelected, flyTo],
  );

  // Location already granted earlier and no point in the URL: show it right away on load –
  // the last known position instantly, then a fresh fix. Never asks for permission by itself.
  useEffect(() => {
    if (initialPoint || !('geolocation' in navigator)) return;
    let cancelled = false;
    locationGranted().then((granted) => {
      if (!granted || cancelled) return;
      const last = lastLocation();
      if (last) {
        setSelected(last);
        flyTo(last);
      }
      locate({ quiet: true });
    });
    return () => {
      cancelled = true;
    };
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // known only in the browser: false in the server's HTML, then set after hydration
  const [canLocate, setCanLocate] = useState(false);
  useEffect(() => setCanLocate('geolocation' in navigator), []);

  // ------------------------------------------------------------ one playback for radar + forecast
  // With the radar on, Play runs the observed frames of the past hour up to the latest, then the
  // forecast hours from now on, then starts over; one play / pause state drives both controls.
  // The radar is an observation of "now": it is shown only while the timeline sits on the current hour.
  const radarFrames = radar.frames;
  const radarFirst = radarFrames[0]?.id ?? null;
  const radarLast = radarFrames[radarFrames.length - 1]?.id ?? null;
  const radarPlayable = radarOn && radarFrames.length > 1;
  const atNow = layer.daily || step === nowIdx;
  const phase = useRef<'radar' | 'forecast'>('forecast');
  const hold = useRef(0);
  const live = useRef({ radar, radarPlayable, radarFirst, radarLast, daily: layer.daily, nowIdx, n: run.times.length });
  live.current = { radar, radarPlayable, radarFirst, radarLast, daily: layer.daily, nowIdx, n: run.times.length };

  const togglePlay = useCallback(
    (p: boolean) => {
      if (p && radarPlayable && atNow) {
        phase.current = 'radar';
        hold.current = 0;
        if (radar.selectedId === radarLast && radarFirst) radar.select(radarFirst); // start from the oldest frame
      } else {
        phase.current = 'forecast';
      }
      setPlaying(p);
    },
    [radarPlayable, atNow, radar, radarFirst, radarLast],
  );

  useEffect(() => {
    if (!playing) return;
    let timer = 0;
    const tick = () => {
      const L = live.current;
      if (phase.current === 'radar' && L.radarPlayable) {
        const cur = L.radar.selectedId;
        if (cur === L.radarLast) {
          if (hold.current < 2) hold.current += 1; // rest on the latest frame for a moment
          else {
            hold.current = 0;
            if (L.daily || L.nowIdx + 1 >= L.n) {
              if (L.radarFirst) L.radar.select(L.radarFirst); // nothing ahead: loop the radar
            } else {
              phase.current = 'forecast';
              setStep(L.nowIdx + 1);
            }
          }
        } else {
          const next = nextFrameId(L.radar.frames, cur);
          if (next && L.radar.isLoaded(next)) L.radar.select(next); // else wait for the download
        }
      } else if (!L.daily) {
        setStep((s) => {
          if (s + 1 < L.n) return s + 1;
          if (L.radarPlayable && L.radarFirst) {
            phase.current = 'radar';
            L.radar.select(L.radarFirst);
            return L.nowIdx;
          }
          return L.radarPlayable ? L.nowIdx : 0;
        });
      } else {
        setPlaying(false); // daily layers have no hourly playback
        return;
      }
      timer = window.setTimeout(tick, phase.current === 'radar' ? 700 : 650);
    };
    timer = window.setTimeout(tick, phase.current === 'radar' ? 700 : 650);
    return () => window.clearTimeout(timer);
  }, [playing]);

  // back on "now" (Now button, slider): show the latest radar frame again
  const onTimeline = useCallback(
    (i: number) => {
      if (layer.daily) return setDay(i);
      setStep(i);
      if (i === nowIdx && radarLast) radar.select(radarLast);
      phase.current = 'forecast';
    },
    [layer.daily, nowIdx, radarLast, radar],
  );
  // picking a radar frame pauses and moves the timeline to the current hour
  const onRadarSelect = useCallback(
    (id: string) => {
      setPlaying(false);
      setStep(nowIdx);
      radar.select(id);
    },
    [nowIdx, radar],
  );
  const radarTimeLabel =
    radarOn && atNow && radar.frame && !radar.isLatest
      ? `${t('radarPast')} ${fmtHour(radar.frame.frameTime, lang)}${lang === 'th' ? ' น.' : ''}`
      : undefined;

  const compareLabel = t('compare', { coarse: fmtKm(run.coarse_grid.resolution_km, lang), fine: fmtKm(run.fine_grid.resolution_km, lang) });
  const gridLabel = t('gridLines', { km: fmtKm(run.fine_grid.resolution_km, lang) });
  const pmFrame = useMemo(() => {
    if (!airOn || !airForecast) return null;
    const i = frameIndex(airForecast, run.times[step] ?? run.times[0]);
    return i < 0 ? null : { field: airForecast, frame: decodeFrame(airForecast.frames[i]) };
  }, [airOn, airForecast, run.times, step]);
  const common = { run, layer, windLayer, index, lut, theme, selected, showGrid: compare || gridOn, radar: atNow ? radar.frame : null, air: airOn ? airStations : null, pm: pmFrame, onSelect: setSelected };

  return (
    <div className="map-page" data-sheet={selected ? (peek ? 'peek' : 'open') : undefined}>
      <div className="map-stage" ref={stageRef}>
        <WeatherMap
          {...common}
          res="fine"
          className="map-canvas"
          onMap={onFineMap}
          onLoading={setLoading}
          ariaLabel={`${t('fineModel', { km: fmtKm(run.fine_grid.resolution_km, lang) })} – ${lang === 'th' ? layer.name_th : layer.name_en}`}
        />
        {compare && (
          <>
            <WeatherMap
              {...common}
              res="coarse"
              className="map-canvas map-canvas--top"
              onMap={onCoarseMap}
              ariaLabel={`${t('modelCoarse', { km: fmtKm(run.coarse_grid.resolution_km, lang) })} – ${lang === 'th' ? layer.name_th : layer.name_en}`}
            />
            <style>{`.map-canvas--top{clip-path:inset(0 ${(1 - split) * 100}% 0 0)}`}</style>
            <div className="compare-slot compare-slot--left" style={{ left: 8, width: `max(96px, calc(${split * 100}% - 20px))` }}>
              <div className="compare-tag glass">
                {t('compareLeft')} · {fmtKm(run.coarse_grid.resolution_km, lang)} {lang === 'th' ? 'กม.' : 'km'}
                {!narrow && <small>{run.model}</small>}
              </div>
            </div>
            <div className="compare-slot" style={{ left: `min(calc(${split * 100}% + 12px), calc(100% - 104px))`, right: 8 }}>
              <div className="compare-tag glass">
                {t('compareRight')} · {fmtKm(run.fine_grid.resolution_km, lang)} {lang === 'th' ? 'กม.' : 'km'}
                {!narrow && <small>{lang === 'th' ? 'ภูมิประเทศ + ฟิสิกส์เขตร้อน' : 'terrain + tropical physics'}</small>}
              </div>
            </div>
            <div className="compare-handle" style={{ left: `${split * 100}%` }}>
              <button
                type="button"
                className="compare-knob"
                onPointerDown={dragSplit}
                onKeyDown={onSplitKey}
                role="slider"
                aria-label={compareLabel}
                aria-valuemin={5}
                aria-valuemax={95}
                aria-valuenow={Math.round(split * 100)}
              >
                <Icon name="split" />
              </button>
            </div>
          </>
        )}

        <LayerPicker
          layers={meta.layers}
          value={pmFrame ? null : layerId}
          onChange={(id) => {
            // picking a weather layer leaves the PM2.5 view: the two are never on the map together
            setAirOn(false);
            setLayerId(id);
          }}
        />

        <PlaceSearch onSelect={(place) => {
          const point = { lat: place.lat, lon: place.lon };
          setPeek(false);
          setSelected(point);
          flyTo(point, place.kind === 'province' ? 8 : 10);
        }} />

        <div className="map-tools">
          {canLocate && <LocateCta status={locateStatus} onLocate={() => locate()} />}
          <button
            type="button"
            className="btn btn--icon-narrow"
            aria-pressed={radarOn}
            aria-label={t('radar')}
            title={t('radar')}
            onClick={() => setRadarOn((r) => !r)}
          >
            <Icon name="radar" />
            <span className="btn-label">{t('radar')}</span>
          </button>
          <button
            type="button"
            className="btn btn--icon-narrow"
            aria-pressed={airOn}
            aria-label={lang === 'th' ? 'PM2.5 ตอนนี้ (สถานี Air4Thai)' : 'PM2.5 now (Air4Thai stations)'}
            title={lang === 'th' ? 'PM2.5 ตอนนี้ (สถานี Air4Thai)' : 'PM2.5 now (Air4Thai stations)'}
            onClick={() => setAirOn((on) => !on)}
          >
            <Icon name="air" />
            <span className="btn-label">PM2.5</span>
          </button>
          <button
            type="button"
            className="btn btn--icon-narrow"
            aria-pressed={compare}
            aria-label={compareLabel}
            title={compareLabel}
            onClick={() => setCompare((c) => !c)}
          >
            <Icon name="split" />
            <span className="btn-label">{compareLabel}</span>
          </button>
          <button
            type="button"
            className="btn btn--icon-narrow"
            aria-pressed={gridOn || compare}
            disabled={compare}
            aria-label={gridLabel}
            title={gridLabel}
            onClick={toggleGrid}
          >
            <Icon name="grid" />
            <span className="btn-label">{gridLabel}</span>
          </button>
        </div>

        {loading && (
          <div className="map-loading glass" role="status">
            <span className="spinner" /> {t('loading')}
          </div>
        )}

        <div className="map-bottom">
          {radarOn && <RadarControl radar={radar} active={atNow} onSelect={onRadarSelect} />}
          {!pmFrame && <Legend layer={layer} />}
          {airOn && <AirLegend lang={lang} count={airStations?.length ?? null} forecast={pmFrame !== null} />}
          <Timeline
            run={run}
            daily={layer.daily}
            index={index}
            nowIndex={nowIdx}
            onChange={onTimeline}
            playing={playing}
            onPlaying={togglePlay}
            label={radarTimeLabel}
          />
        </div>
      </div>

      <aside
        ref={sheetRef}
        className="map-sidebar"
        data-open={selected ? 'true' : 'false'}
        data-peek={selected && peek ? 'true' : undefined}
        aria-label={selected ? t('next48') : t('overview')}
      >
        {selected && (
          <button
            type="button"
            className="sheet-handle"
            aria-expanded={!peek}
            aria-label={peek ? t('sheetExpand') : t('sheetCollapse')}
            onClick={() => setPeek((x) => !x)}
          />
        )}
        {selected ? (
          <PointPanel point={selected} step={step} nowIndex={nowIdx} fineKm={run.fine_grid.resolution_km} coarseKm={run.coarse_grid.resolution_km} onClose={() => setSelected(null)} />
        ) : (
          <>
            <OverviewPanel run={run} dayIndex={day} />
          </>
        )}
      </aside>
    </div>
  );
}


const AIR_LEVELS: [string, string, string, string][] = [
  ['#3bccff', 'ดีมาก', 'Very good', 'คุณภาพอากาศดีมาก'],
  ['#92d050', 'ดี', 'Good', 'คุณภาพอากาศดี'],
  ['#ffff00', 'ปานกลาง', 'Moderate', 'ปานกลาง'],
  ['#ffa200', 'เริ่มมีผล', 'Sensitive', 'เริ่มมีผลกระทบต่อสุขภาพ'],
  ['#f04646', 'มีผล', 'Unhealthy', 'มีผลกระทบต่อสุขภาพ'],
];

/** The PCD's PM2.5 levels, under the weather legend while the stations are shown. */
function AirLegend({ lang, count, forecast }: { lang: 'th' | 'en'; count: number | null; forecast: boolean }) {
  const th = lang === 'th';
  return (
    <div
      className="air-legend glass"
      role="note"
      title={th ? 'PM2.5 ตอนนี้ (µg/m³) จากสถานี Air4Thai กรมควบคุมมลพิษ · ซูมเข้าเพื่อดูตัวเลข' : 'PM2.5 now (µg/m³), Air4Thai stations (Pollution Control Department) · zoom in for numbers'}
    >
      <b>PM2.5</b>
      {AIR_LEVELS.map(([c, t, e, full]) => (
        <span key={c} title={th ? full : e}>
          <i style={{ background: c }} /> {th ? t : e}
        </span>
      ))}
      <span className="subtle">
        {count === null ? '…' : th ? `จุด = วัดจริง ${count} สถานี` : `dots = ${count} stations`}
        {forecast ? (th ? ' · สี = พยากรณ์ FMI SILAM ~22 กม. ปรับตามค่าสถานี' : ' · shading = FMI SILAM forecast (~22 km) adjusted to the stations') : ''}
      </span>
      {/* the weather legend (and its credits) is hidden while the PM2.5 forecast has the map */}
      {forecast && <MapCredit lang={lang} />}
    </div>
  );
}
