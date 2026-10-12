'use client';

import Link from 'next/link';
import type { ProvinceDetail } from '../lib/api';
import { coverageNote } from '../lib/alertText';
import { forecastSentence } from '../lib/forecastText';
import { fmtDay, fmtKm, nearestStep } from '../lib/format';
import { paths } from '../lib/paths';
import { useT } from '../i18n';
import { Icon } from '../components/Icon';
import { AlertBadge } from '../components/SeverityBadge';
import { TimeSeriesChart } from '../components/TimeSeriesChart';

/** Server-rendered (SSR) province forecast page – the text is indexable by search engines. */
export function ProvinceView({ data, regionName, fineKm, coarseKm }: { data: ProvinceDetail; regionName: string; fineKm?: number; coarseKm?: number }) {
  const { t, lang, pick } = useT();
  const now = nearestStep(data.times);
  const fineLabel = fineKm === undefined
    ? (lang === 'th' ? 'กริดละเอียด' : 'Downscaled grid')
    : t('fineModel', { km: fmtKm(fineKm, lang) });
  const globalCells = fineKm && coarseKm
    ? Math.max(1, Math.round(data.cells / (coarseKm / fineKm) ** 2))
    : null;
  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 820 }}>
        <nav className="muted" style={{ fontSize: 'var(--font-size-sm)' }} aria-label="breadcrumb">
          <Link href={paths.provinces}>{t('navProvinces')}</Link> › {regionName}
        </nav>
        <header className="page-head">
          <h1>
            {lang === 'th' ? 'พยากรณ์อากาศ' : 'Weather forecast · '}
            {pick(data)}
          </h1>
          <p>
            {lang === 'th'
              ? `${fineLabel} จาก ${data.cells.toLocaleString()} จุดกริดในจังหวัด`
              : `${fineLabel} from ${data.cells.toLocaleString()} grid cells in the province`}
          </p>
          {globalCells !== null && coarseKm !== undefined && (
            <p className="subtle">
              {lang === 'th'
                ? `สำหรับเปรียบเทียบ: โมเดลโลก ${fmtKm(coarseKm, lang)} กม. มีราว ${globalCells.toLocaleString()} จุดกริดในจังหวัด`
                : `For comparison: the ${fmtKm(coarseKm, lang)} km global model has about ${globalCells.toLocaleString()} grid cells in the province`}
            </p>
          )}
        </header>

        {data.days.map((d) => (
          <section key={d.date} className="card card-pad" style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <h2 style={{ fontSize: 'var(--font-size-lg)' }}>{fmtDay(d.date, lang, true)}</h2>
              {coverageNote(d, lang) ? (
                <span className="partial-note">{coverageNote(d, lang)}</span>
              ) : (
                d.hours < 24 && (
                  <span className="subtle">
                    {d.hours} {lang === 'th' ? 'ชั่วโมงที่มีข้อมูล' : 'h covered'}
                  </span>
                )
              )}
            </div>
            <p>{forecastSentence(d, lang)}</p>
            {d.alerts.length > 0 && (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                {d.alerts.map((a) => (
                  <AlertBadge key={a.hazard} alert={a} showValue />
                ))}
                {coverageNote(d, lang) && (
                  <span className="level-tag">{lang === 'th' ? 'อิงเฉพาะช่วงที่มีข้อมูล' : 'based on the available hours'}</span>
                )}
              </div>
            )}
          </section>
        ))}

        <section className="card card-pad" style={{ display: 'grid', gap: 8 }}>
          <h2 style={{ fontSize: 'var(--font-size-lg)' }}>{t('hourly')}</h2>
          <p className="subtle" style={{ fontSize: 'var(--font-size-xs)' }}>
            {lang === 'th'
              ? `อุณหภูมิเฉลี่ยทั้งจังหวัด (°C) และโอกาสฝนเฉลี่ย (%) จาก${fineLabel}`
              : `Province-mean temperature (°C) and chance of rain (%) from ${fineLabel}`}
          </p>
          <TimeSeriesChart
            title={t('temperature')}
            times={data.times}
            unit="°C"
            nowIndex={now}
            series={[{ key: 't', label: t('temperature'), values: data.hourly.temp, kind: 'line', tone: 'fine' }]}
          />
          <TimeSeriesChart
            title={t('chanceOfRain')}
            times={data.times}
            unit="%"
            digits={0}
            zeroBased
            yMax={100}
            nowIndex={now}
            series={[{ key: 'p', label: t('chanceOfRain'), values: data.hourly.pop, kind: 'bar', tone: 'fine' }]}
          />
        </section>

        <div>
          <Link className="btn btn--primary btn--lg" href={paths.mapAt(data.lat, data.lon)}>
            <Icon name="map" /> {lang === 'th' ? `ดูบนแผนที่${fineLabel}` : `Open on the ${fineLabel} map`}
          </Link>
        </div>
      </div>
    </div>
  );
}
