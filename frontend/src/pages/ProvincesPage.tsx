import { useEffect, useMemo, useState } from 'react';
import { api, type Meta, type RunMeta } from '../lib/api';
import { categorise } from '../lib/color';
import { forecastSentence } from '../lib/forecastText';
import { fmtDay, fmtNum, nearestStep } from '../lib/format';
import { href } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { useT } from '../i18n';
import { Icon } from '../components/Icon';
import { PanelHead } from '../components/PointPanel';
import { AlertBadge, LevelBadge } from '../components/SeverityBadge';
import { TimeSeriesChart } from '../components/TimeSeriesChart';

export function ProvincesPage({ meta, run, selectedId }: { meta: Meta; run: RunMeta; selectedId?: string }) {
  const { t, lang, pick } = useT();
  const { data, error } = useAsync(`provinces:${run.run_id}`, api.provinces);
  const [q, setQ] = useState('');
  const [region, setRegion] = useState('all');
  const [day, setDay] = useState(run.days.length > 1 && run.days[0].hours < 12 ? 1 : 0);

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.provinces
      .filter((p) => region === 'all' || p.region === region)
      .filter((p) => !needle || p.name_th.includes(needle) || p.name_en.toLowerCase().includes(needle))
      .sort((a, b) => a.name_th.localeCompare(b.name_th, 'th'));
  }, [data, q, region]);

  return (
    <div className="page">
      <div className="page-inner">
        <header className="page-head">
          <h1>{lang === 'th' ? 'พยากรณ์รายจังหวัด' : 'Forecast by province'}</h1>
          <p>
            {lang === 'th'
              ? 'สรุปจากกริด 2 กม. ทุกจุดในจังหวัด — บอกได้ว่าฝนตกกี่เปอร์เซ็นต์ของพื้นที่ ซึ่งโมเดล 22 กม. ที่มีเพียง 3–4 จุดต่อจังหวัดทำไม่ได้'
              : 'Summarised from every 2 km cell in each province – including the share of the area that gets rain, which a 22 km model with 3–4 cells per province cannot tell.'}
          </p>
        </header>

        <div className="toolbar">
          <label style={{ position: 'relative', flex: '1 1 220px' }}>
            <span className="sr-only">{t('search')}</span>
            <input className="input" style={{ width: '100%', paddingLeft: 34 }} placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} />
            <Icon name="search" width={16} style={{ position: 'absolute', left: 10, top: 12 }} className="subtle" />
          </label>
          <select className="input" value={region} onChange={(e) => setRegion(e.target.value)} aria-label={t('allRegions')}>
            <option value="all">{t('allRegions')}</option>
            {meta.regions.map((r) => (
              <option key={r.id} value={r.id}>
                {pick(r)}
              </option>
            ))}
          </select>
          <div className="segmented" role="group" aria-label={t('daily')}>
            {run.days.map((d, i) => (
              <button key={d.date} type="button" aria-pressed={i === day} onClick={() => setDay(i)}>
                {fmtDay(d.date, lang)}
              </button>
            ))}
          </div>
        </div>

        {error && <div className="empty">{error.message}</div>}
        {!data && !error && <div className="skeleton" style={{ height: 400 }} />}
        {data && (
          <div className="card table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{lang === 'th' ? 'จังหวัด' : 'Province'}</th>
                  <th className="num">{t('tmin')}–{t('tmax')} °C</th>
                  <th className="num">{t('heatIndex')}</th>
                  <th>{t('areaRain')}</th>
                  <th className="num">{t('maxRain')}</th>
                  <th>{t('navAlerts')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const d = p.days[day];
                  const heat = categorise('heatIndex', d.heat_max);
                  const cov = categorise('rainCoverage', d.rain_coverage);
                  return (
                    <tr key={p.id} onClick={() => (window.location.hash = href('provinces', p.id))}>
                      <td>
                        <a href={href('provinces', p.id)} onClick={(e) => e.stopPropagation()} style={{ color: 'inherit', fontWeight: 500 }}>
                          {pick(p)}
                        </a>
                        <div className="subtle" style={{ fontSize: 'var(--font-size-xs)' }}>
                          {pick(meta.regions.find((r) => r.id === p.region) ?? { name_th: '', name_en: '' })}
                        </div>
                      </td>
                      <td className="num">
                        {fmtNum(d.tmin, 0)}–{fmtNum(d.tmax, 0)}
                      </td>
                      <td className="num">
                        {fmtNum(d.heat_max, 0)}{' '}
                        {heat && heat.severity >= 1 && <LevelBadge severity={heat.severity} label={pick(heat)} />}
                      </td>
                      <td>
                        <span className="num">{fmtNum(d.rain_coverage, 0)}%</span>{' '}
                        <span className="muted" style={{ fontSize: 'var(--font-size-xs)' }}>
                          {cov ? pick(cov) : ''}
                        </span>
                      </td>
                      <td className="num">{fmtNum(d.rain_p95, 1)}</td>
                      <td>
                        <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {d.alerts.map((a) => (
                            <AlertBadge key={a.hazard} alert={a} />
                          ))}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {selectedId && <ProvinceDrawer id={selectedId} run={run} />}
    </div>
  );
}

function ProvinceDrawer({ id, run }: { id: string; run: RunMeta }) {
  const { t, lang, pick } = useT();
  const { data } = useAsync(`province:${run.run_id}:${id}`, () => api.province(id));
  const close = () => (window.location.hash = href('provinces'));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="drawer-scrim" onClick={close}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label={data ? pick(data) : t('loading')} onClick={(e) => e.stopPropagation()}>
        {!data ? (
          <div className="panel">
            <div className="skeleton" style={{ height: 28, width: '50%' }} />
            <div className="skeleton" style={{ height: 200 }} />
          </div>
        ) : (
          <div className="panel">
            <PanelHead
              title={pick(data)}
              subtitle={`${lang === 'th' ? 'จุดกริด 2 กม.' : '2 km cells'}: ${data.cells.toLocaleString()} · ${lang === 'th' ? 'เทียบโมเดล 22 กม. ≈' : 'vs 22 km model ≈'} ${Math.max(1, Math.round(data.cells / 100))}`}
              onClose={close}
              closeLabel={t('close')}
            />
            {data.days.map((d) => (
              <section key={d.date} className="card card-pad" style={{ display: 'grid', gap: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <b>{fmtDay(d.date, lang, true)}</b>
                  {d.hours < 24 && <span className="subtle">{d.hours} {lang === 'th' ? 'ชั่วโมงแรก' : 'h covered'}</span>}
                </div>
                <p>{forecastSentence(d, lang)}</p>
                {d.alerts.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {d.alerts.map((a) => (
                      <AlertBadge key={a.hazard} alert={a} showValue />
                    ))}
                  </div>
                )}
              </section>
            ))}
            <section className="panel-section">
              <h3>{t('hourly')}</h3>
              <p className="subtle" style={{ fontSize: 'var(--font-size-xs)' }}>
                {lang === 'th' ? 'อุณหภูมิเฉลี่ยทั้งจังหวัด (°C) และโอกาสฝนเฉลี่ย (%) จากกริด 2 กม.' : 'Province-mean temperature (°C) and chance of rain (%) from the 2 km grid'}
              </p>
              <TimeSeriesChart
                title={t('temperature')}
                times={data.times}
                unit="°C"
                nowIndex={nearestStep(data.times)}
                series={[{ key: 't', label: t('temperature'), values: data.hourly.temp, kind: 'line', tone: 'fine' }]}
              />
              <TimeSeriesChart
                title={t('chanceOfRain')}
                times={data.times}
                unit="%"
                digits={0}
                zeroBased
                yMax={100}
                nowIndex={nearestStep(data.times)}
                series={[{ key: 'p', label: t('chanceOfRain'), values: data.hourly.pop, kind: 'bar', tone: 'fine' }]}
              />
            </section>
            <a className="btn" href={`${href('map')}`} onClick={() => sessionStorage.setItem('thwx.focus', JSON.stringify([data.lon, data.lat]))}>
              <Icon name="map" /> {lang === 'th' ? 'ดูบนแผนที่' : 'View on map'}
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
