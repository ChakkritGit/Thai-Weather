'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MLMap } from 'maplibre-gl';
import type { LayerId, Meta, RunMeta } from '../lib/api';
import { buildLut } from '../lib/color';
import { fmtHour, fmtKm, nearestStep, thaiDate } from '../lib/format';
import { nextFrameId } from '../lib/radarHistory';
import { useRadar } from '../lib/useRadar';
import { useT } from '../i18n';
import { useTheme } from '../lib/theme';
import { Icon } from '../components/Icon';
import { LayerPicker } from '../components/LayerPicker';
import { LocateCta, type LocateStatus } from '../components/LocateCta';
import { Legend } from '../components/Legend';
import { RadarControl } from '../components/RadarControl';
import { OverviewPanel } from '../components/OverviewPanel';
import { PointPanel } from '../components/PointPanel';
import { Timeline } from '../components/Timeline';
import { WeatherMap, type MapPoint } from '../components/WeatherMap';

const STORE_KEY = 'thwx.layer';
const LOC_KEY = 'thwx.lastLocation';

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
  const [layerId, setLayerId] = useState<LayerId>(initialLayer);
  const nowIdx = useMemo(() => nearestStep(run.times), [run.times]);
  const [step, setStep] = useState(nowIdx);
  const [day, setDay] = useState(0);
  const [playing, setPlaying] = useState(false);
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
  const maps = useRef<{ fine: MLMap | null; coarse: MLMap | null }>({ fine: null, coarse: null });
  // a point to fly to once the fine map exists and has loaded
  const pendingFly = useRef<MapPoint | null>(null);
  const flyTo = useCallback((p: MapPoint, zoom = 8) => {
    const m = maps.current.fine;
    if (!m) {
      pendingFly.current = p;
      return;
    }
    const go = () => m.flyTo({ center: [p.lon, p.lat], zoom });
    if (m.loaded()) go();
    else m.once('load', go);
  }, []);

  const layer = meta.layers.find((l) => l.id === layerId) ?? meta.layers[0];
  const windLayer = meta.layers.find((l) => l.id === 'wind_dir');
  const lut = useMemo(() => buildLut(layer), [layer]);
  const index = layer.daily ? day : step;

  useEffect(() => {
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
      if (m && initialPoint) m.once('load', () => m.flyTo({ center: [initialPoint.lon, initialPoint.lat], zoom: 7.5 }));
      else if (m && pendingFly.current) {
        const p = pendingFly.current;
        pendingFly.current = null;
        m.once('load', () => m.flyTo({ center: [p.lon, p.lat], zoom: 8 }));
      }
    },
    [syncMaps, initialPoint],
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
  const canLocate = typeof navigator !== 'undefined' && 'geolocation' in navigator;

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
  const common = { run, layer, windLayer, index, lut, theme, selected, showGrid: compare, radar: atNow ? radar.frame : null, onSelect: setSelected };

  return (
    <div className="map-page">
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

        <LayerPicker layers={meta.layers} value={layerId} onChange={setLayerId} />

        <div className="map-tools" data-cta={canLocate && !selected && !compare ? 'true' : undefined}>
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
            aria-pressed={compare}
            aria-label={compareLabel}
            title={compareLabel}
            onClick={() => setCompare((c) => !c)}
          >
            <Icon name="split" />
            <span className="btn-label">{compareLabel}</span>
          </button>
          {canLocate && (
            <button
              type="button"
              className="btn btn--icon btn--locate"
              onClick={() => locate()}
              aria-label={lang === 'th' ? 'ตำแหน่งของฉัน' : 'My location'}
              title={lang === 'th' ? 'ตำแหน่งของฉัน' : 'My location'}
            >
              <Icon name="locate" />
            </button>
          )}
          {radarOn && <RadarControl radar={radar} active={atNow} playing={playing} onPlaying={togglePlay} onSelect={onRadarSelect} />}
        </div>

        {canLocate && !selected && !compare && <LocateCta variant="float" status={locateStatus} onLocate={() => locate()} />}

        {loading && (
          <div className="map-loading glass" role="status">
            <span className="spinner" /> {t('loading')}
          </div>
        )}

        <div className="map-bottom">
          <Legend layer={layer} />
          <Timeline
            run={run}
            daily={layer.daily}
            index={index}
            onChange={onTimeline}
            playing={playing}
            onPlaying={togglePlay}
            label={radarTimeLabel}
          />
        </div>
      </div>

      <aside className="map-sidebar" data-open={selected ? 'true' : 'false'} aria-label={selected ? t('next48') : t('overview')}>
        {selected ? (
          <PointPanel point={selected} step={step} nowIndex={nowIdx} fineKm={run.fine_grid.resolution_km} coarseKm={run.coarse_grid.resolution_km} onClose={() => setSelected(null)} />
        ) : (
          <>
            {canLocate && <LocateCta variant="card" status={locateStatus} onLocate={() => locate()} />}
            <OverviewPanel run={run} dayIndex={day} />
          </>
        )}
      </aside>
    </div>
  );
}
