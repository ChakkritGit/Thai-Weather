'use client';

import { useEffect, useState } from 'react';
import { api, type PointForecast } from '../lib/api';
import { categorise } from '../lib/color';
import { compass, fmtDay, fmtKm, fmtNum, fmtStep } from '../lib/format';
import { useT } from '../i18n';
import { Icon } from './Icon';
import { NowcastCard } from './NowcastCard';
import { LevelBadge } from './SeverityBadge';
import { ChartLegend, TimeSeriesChart } from './TimeSeriesChart';
import type { MapPoint } from './WeatherMap';

interface Props {
  point: MapPoint;
  step: number;
  nowIndex: number;
  /** resolutions of the two grids in km (from the run) */
  fineKm: number;
  coarseKm: number;
  onClose: () => void;
}

export function PointPanel({ point, step, nowIndex, fineKm, coarseKm, onClose }: Props) {
  const { t, lang, pick } = useT();
  const [data, setData] = useState<PointForecast | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'chart' | 'table'>('chart');

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .point(point.lat, point.lon)
      .then((d) => !cancelled && setData(d))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [point.lat, point.lon]);

  if (error) {
    return (
      <div className="panel">
        <PanelHead title={`${point.lat.toFixed(2)}°N ${point.lon.toFixed(2)}°E`} onClose={onClose} closeLabel={t('close')} />
        <div className="empty">
          <Icon name="info" width={28} />
          <p>{error}</p>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="panel" aria-busy="true">
        <div className="skeleton" style={{ height: 28, width: '60%' }} />
        <div className="skeleton" style={{ height: 72 }} />
        <div className="skeleton" style={{ height: 150 }} />
        <div className="skeleton" style={{ height: 150 }} />
      </div>
    );
  }

  const i = Math.min(step, data.times.length - 1);
  const f = data.fine;
  const c = data.coarse;
  const comps = data.temperature_components;
  const heatCat = categorise('heatIndex', f.heat[i]);
  const loc = data.location;
  const title = loc.province ? pick(loc.province) : lang === 'th' ? (loc.land ? 'นอกประเทศไทย' : 'ทะเล') : loc.land ? 'Outside Thailand' : 'Sea';
  const coarseKmText = fmtKm(coarseKm, lang);
  const labels = { fine: t('fineModel', { km: fmtKm(fineKm, lang) }), coarse: t('modelCoarse', { km: coarseKmText }) };

  const parts = [
    { key: 'lapse', label: t('lapse'), v: comps.lapse[i] },
    { key: 'valley', label: t('valley'), v: comps.valley[i] },
    { key: 'coast', label: t('coast'), v: comps.coast[i] },
    { key: 'urban', label: t('urban'), v: comps.urban[i] },
  ];
  const maxAbs = Math.max(1, ...parts.map((p) => Math.abs(p.v)));

  return (
    <div className="panel">
      <PanelHead
        title={title}
        subtitle={`${loc.lat.toFixed(2)}°N ${loc.lon.toFixed(2)}°E · ${t('elevation')} ${loc.elevation} ${lang === 'th' ? 'ม.' : 'm'}`}
        onClose={onClose}
        closeLabel={t('close')}
      />

      <div className="hero">
        <div className="hero-temp">{fmtNum(f.temp[i], 0)}°</div>
        <div className="hero-meta">
          <span>{fmtStep(data.times[i], lang)}</span>
          <span>
            {labels.coarse}: <b className="num" style={{ color: 'var(--color-chart-coarse)' }}>{fmtNum(c.temp[i], 0)}°</b>
          </span>
          {heatCat && (
            <span>
              {t('heatIndex')} <b className="num">{fmtNum(f.heat[i], 0)}°</b>{' '}
              <LevelBadge severity={Math.max(heatCat.severity, heatCat.id === 'caution' ? 1 : 0)} label={pick(heatCat)} />
            </span>
          )}
        </div>
      </div>

      <NowcastCard lat={point.lat} lon={point.lon} />

      <div className="now-grid">
        <Stat label={t('chanceOfRain')} value={fmtNum(f.pop[i], 0)} unit="%" sub={`${labels.coarse} ${c.pop[i] >= 50 ? (lang === 'th' ? 'ฝนตก' : 'rain') : lang === 'th' ? 'ไม่มีฝน' : 'dry'}`} />
        <Stat label={t('rain')} value={fmtNum(f.rain[i], 1)} unit={lang === 'th' ? 'มม./ชม.' : 'mm/h'} sub={`${labels.coarse} ${fmtNum(c.rain[i], 1)}`} />
        <Stat label={t('wind')} value={fmtNum(f.wind[i], 1)} unit="m/s" sub={`${lang === 'th' ? 'จากทิศ' : 'from'} ${compass(f.wind_dir[i], lang)}`} />
        <Stat label={t('thunder')} value={fmtNum(f.storm[i], 0)} unit="%" sub={`${t('humidity')} ${fmtNum(f.rh[i], 0)}%`} />
      </div>

      <section className="panel-section" aria-labelledby="why-h">
        <h3 id="why-h">{t('why', { km: coarseKmText })}</h3>
        <div className="waterfall">
          <div className="wf-row">
            <span>{labels.coarse} <span className="subtle">({loc.model_elevation} {lang === 'th' ? 'ม.' : 'm'})</span></span>
            <span />
            <span className="wf-val">{fmtNum(comps.model[i], 1)}°</span>
          </div>
          {parts.map((p) => (
            <div className="wf-row" key={p.key}>
              <span className={Math.abs(p.v) < 0.05 ? 'subtle' : undefined}>{p.label}</span>
              <span className="wf-track" aria-hidden="true">
                <span
                  className="wf-bar"
                  data-sign={p.v >= 0 ? '+' : '-'}
                  style={{
                    left: p.v >= 0 ? '50%' : `${50 - (Math.abs(p.v) / maxAbs) * 50}%`,
                    width: `${(Math.abs(p.v) / maxAbs) * 50}%`,
                  }}
                />
              </span>
              <span className="wf-val">
                {p.v >= 0 ? '+' : '−'}
                {fmtNum(Math.abs(p.v), 1)}°
              </span>
            </div>
          ))}
          <div className="wf-row wf-total">
            <span>{labels.fine}</span>
            <span />
            <span className="wf-val">{fmtNum(comps.model[i] + parts.reduce((a, p) => a + p.v, 0), 1)}°</span>
          </div>
        </div>
      </section>

      <section className="panel-section">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <h3>{t('next48')}</h3>
          <div className="segmented" role="group">
            <button type="button" aria-pressed={view === 'chart'} onClick={() => setView('chart')}>
              {t('chart')}
            </button>
            <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>
              {t('table')}
            </button>
          </div>
        </div>
        <ChartLegend fine={labels.fine} coarse={labels.coarse} />
        {view === 'chart' ? (
          <>
            <ChartTitle>{t('temperature')} (°C)</ChartTitle>
            <TimeSeriesChart
              title={t('temperature')}
              times={data.times}
              unit="°C"
              nowIndex={nowIndex}
              fineKm={fineKm}
              coarseKm={coarseKm}
              series={[
                { key: 'f', label: labels.fine, values: f.temp, kind: 'line', tone: 'fine' },
                { key: 'c', label: labels.coarse, values: c.temp, kind: 'line', tone: 'coarse' },
              ]}
            />
            <ChartTitle>{t('chanceOfRain')} (%)</ChartTitle>
            <TimeSeriesChart
              title={t('chanceOfRain')}
              times={data.times}
              unit="%"
              digits={0}
              zeroBased
              yMax={100}
              nowIndex={nowIndex}
              fineKm={fineKm}
              coarseKm={coarseKm}
              series={[
                { key: 'f', label: labels.fine, values: f.pop, kind: 'line', tone: 'fine' },
                { key: 'c', label: labels.coarse, values: c.pop, kind: 'line', tone: 'coarse' },
              ]}
            />
            <ChartTitle>{t('rain')} ({lang === 'th' ? 'มม./ชม.' : 'mm/h'})</ChartTitle>
            <TimeSeriesChart
              title={t('rain')}
              times={data.times}
              unit={lang === 'th' ? 'มม.' : 'mm'}
              zeroBased
              nowIndex={nowIndex}
              fineKm={fineKm}
              coarseKm={coarseKm}
              series={[
                { key: 'f', label: labels.fine, values: f.rain, kind: 'bar', tone: 'fine' },
                { key: 'c', label: labels.coarse, values: c.rain, kind: 'bar', tone: 'coarse' },
              ]}
            />
          </>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 360 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('time')}</th>
                  <th className="num">°C</th>
                  <th className="num">{coarseKmText} km</th>
                  <th className="num">HI</th>
                  <th className="num">{lang === 'th' ? 'โอกาสฝน' : 'Rain %'}</th>
                  <th className="num">mm/h</th>
                </tr>
              </thead>
              <tbody>
                {data.times.map((tm, k) => (
                  <tr key={tm}>
                    <td>{fmtStep(tm, lang)}</td>
                    <td className="num">{fmtNum(f.temp[k], 1)}</td>
                    <td className="num">{fmtNum(c.temp[k], 1)}</td>
                    <td className="num">{fmtNum(f.heat[k], 0)}</td>
                    <td className="num">{fmtNum(f.pop[k], 0)}</td>
                    <td className="num">{fmtNum(f.rain[k], 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel-section">
        <h3>{lang === 'th' ? 'ฝนสะสมรายวัน' : 'Daily rainfall'}</h3>
        <div className="day-cards">
          {data.daily.dates.map((d, k) => {
            const cat = categorise('rainDaily', data.daily.fine_rain[k]);
            return (
              <div className="day-card" key={d}>
                <b>{fmtDay(d, lang)}</b>
                <span className="temps">
                  {fmtNum(data.daily.fine_rain[k], 1)} <small className="muted">{lang === 'th' ? 'มม.' : 'mm'}</small>
                </span>
                <span className="subtle">
                  {labels.coarse} {fmtNum(data.daily.coarse_rain[k], 1)}
                </span>
                {cat && <LevelBadge severity={cat.severity} label={pick(cat)} />}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function ChartTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, marginTop: 4 }}>{children}</div>;
}

function Stat({ label, value, unit, sub }: { label: string; value: string; unit: string; sub?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {value} <small>{unit}</small>
      </span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

export function PanelHead({
  title,
  subtitle,
  onClose,
  closeLabel,
}: {
  title: string;
  subtitle?: string;
  onClose?: () => void;
  closeLabel?: string;
}) {
  return (
    <div className="panel-head">
      <div>
        <h2>{title}</h2>
        {subtitle && <p className="muted" style={{ fontSize: 'var(--font-size-xs)' }}>{subtitle}</p>}
      </div>
      {onClose && (
        <button type="button" className="icon-btn" onClick={onClose} aria-label={closeLabel}>
          <Icon name="close" />
        </button>
      )}
    </div>
  );
}
