'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MLMap } from 'maplibre-gl';
import type { LayerId, Meta, RunMeta } from '../lib/api';
import { buildLut, cssGradient, radarScale } from '../lib/color';
import { fmtHour, nearestStep, thaiDate } from '../lib/format';
import { useRadar } from '../lib/useRadar';
import { useT } from '../i18n';
import { useTheme } from '../lib/theme';
import { Icon } from '../components/Icon';
import { LayerPicker } from '../components/LayerPicker';
import { Legend } from '../components/Legend';
import { OverviewPanel } from '../components/OverviewPanel';
import { PointPanel } from '../components/PointPanel';
import { Timeline } from '../components/Timeline';
import { WeatherMap, type MapPoint } from '../components/WeatherMap';

const STORE_KEY = 'thwx.layer';

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
  const maps = useRef<{ fine: MLMap | null; coarse: MLMap | null }>({ fine: null, coarse: null });

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

  const locate = () => {
    navigator.geolocation?.getCurrentPosition((pos) => {
      const p = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      setSelected(p);
      maps.current.fine?.flyTo({ center: [p.lon, p.lat], zoom: 8 });
    });
  };

  const common = { run, layer, windLayer, index, lut, theme, selected, radar: radar.frame, onSelect: setSelected };

  return (
    <div className="map-page">
      <div className="map-stage" ref={stageRef}>
        <WeatherMap
          {...common}
          res="fine"
          className="map-canvas"
          onMap={onFineMap}
          onLoading={setLoading}
          ariaLabel={`${t('fine2')} – ${lang === 'th' ? layer.name_th : layer.name_en}`}
        />
        {compare && (
          <>
            <WeatherMap
              {...common}
              res="coarse"
              showGrid
              className="map-canvas map-canvas--top"
              onMap={onCoarseMap}
              ariaLabel={`${t('model22')} – ${lang === 'th' ? layer.name_th : layer.name_en}`}
            />
            <style>{`.map-canvas--top{clip-path:inset(0 ${(1 - split) * 100}% 0 0)}`}</style>
            <div className="compare-tag glass" style={{ left: `calc(${split * 100}% - 12px)`, transform: 'translateX(-100%)' }}>
              {t('compareLeft')} · {run.coarse_grid.resolution_km} {lang === 'th' ? 'กม.' : 'km'}
              <small>{run.model}</small>
            </div>
            <div className="compare-tag glass" style={{ left: `calc(${split * 100}% + 12px)` }}>
              {t('compareRight')} · {run.fine_grid.resolution_km} {lang === 'th' ? 'กม.' : 'km'}
              <small>{lang === 'th' ? 'ภูมิประเทศ + ฟิสิกส์เขตร้อน' : 'terrain + tropical physics'}</small>
            </div>
            <div className="compare-handle" style={{ left: `${split * 100}%` }}>
              <button
                type="button"
                className="compare-knob"
                onPointerDown={dragSplit}
                onKeyDown={onSplitKey}
                role="slider"
                aria-label={t('compare')}
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

        <div className="map-tools">
          <button type="button" className="btn" aria-pressed={radarOn} onClick={() => setRadarOn((r) => !r)}>
            <Icon name="radar" />
            {t('radar')}
          </button>
          <button type="button" className="btn" aria-pressed={compare} onClick={() => setCompare((c) => !c)}>
            <Icon name="split" />
            {t('compare')}
          </button>
          {typeof navigator !== 'undefined' && 'geolocation' in navigator && (
            <button type="button" className="btn" onClick={locate} aria-label={lang === 'th' ? 'ตำแหน่งของฉัน' : 'My location'}>
              <Icon name="locate" />
            </button>
          )}
          {radarOn && (
            <div className="radar-tag glass" role="status">
              {radar.status === 'ready' && radar.frame ? (
                <>
                  <b>
                    {t('radarAt')} {fmtHour(radar.frame.frameTime, lang)}
                    {lang === 'th' ? ' น.' : ''}
                  </b>
                  <span className="muted"> · RainViewer</span>
                  <div className="radar-tag-bar" style={{ background: cssGradient(radarScale, 12, 70) }} aria-hidden="true" />
                  <div className="radar-tag-scale muted" aria-hidden="true">
                    {[20, 40, 60].map((v) => (
                      <span key={v} style={{ left: `${((v - 12) / 58) * 100}%` }}>
                        {v}
                      </span>
                    ))}
                  </div>
                </>
              ) : radar.status === 'loading' ? (
                <span className="muted">{t('loading')}</span>
              ) : (
                <span className="muted">{t('radarOff')}</span>
              )}
            </div>
          )}
        </div>

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
            onChange={layer.daily ? setDay : setStep}
            playing={playing}
            onPlaying={setPlaying}
          />
        </div>
      </div>

      <aside className="map-sidebar" data-open={selected ? 'true' : 'false'} aria-label={selected ? t('next48') : t('overview')}>
        {selected ? (
          <PointPanel point={selected} step={step} nowIndex={nowIdx} onClose={() => setSelected(null)} />
        ) : (
          <OverviewPanel run={run} dayIndex={day} />
        )}
      </aside>
    </div>
  );
}
