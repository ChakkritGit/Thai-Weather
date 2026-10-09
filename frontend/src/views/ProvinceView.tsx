'use client';

import Link from 'next/link';
import type { ProvinceDetail } from '../lib/api';
import { forecastSentence } from '../lib/forecastText';
import { fmtDay, nearestStep } from '../lib/format';
import { paths } from '../lib/paths';
import { useT } from '../i18n';
import { Icon } from '../components/Icon';
import { AlertBadge } from '../components/SeverityBadge';
import { TimeSeriesChart } from '../components/TimeSeriesChart';

/** Server-rendered (SSR) province forecast page – the text is indexable by search engines. */
export function ProvinceView({ data, regionName }: { data: ProvinceDetail; regionName: string }) {
  const { t, lang, pick } = useT();
  const now = nearestStep(data.times);
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
              ? `ความละเอียด 2 กม. จาก ${data.cells.toLocaleString()} จุดกริดในจังหวัด (โมเดลโลก 22 กม. มีราว ${Math.max(1, Math.round(data.cells / 100))} จุด)`
              : `2 km resolution from ${data.cells.toLocaleString()} grid cells in the province (a 22 km global model has about ${Math.max(1, Math.round(data.cells / 100))})`}
          </p>
        </header>

        {data.days.map((d) => (
          <section key={d.date} className="card card-pad" style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <h2 style={{ fontSize: 'var(--font-size-lg)' }}>{fmtDay(d.date, lang, true)}</h2>
              {d.hours < 24 && (
                <span className="subtle">
                  {d.hours} {lang === 'th' ? 'ชั่วโมงที่มีข้อมูล' : 'h covered'}
                </span>
              )}
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

        <section className="card card-pad" style={{ display: 'grid', gap: 8 }}>
          <h2 style={{ fontSize: 'var(--font-size-lg)' }}>{t('hourly')}</h2>
          <p className="subtle" style={{ fontSize: 'var(--font-size-xs)' }}>
            {lang === 'th'
              ? 'อุณหภูมิเฉลี่ยทั้งจังหวัด (°C) และโอกาสฝนเฉลี่ย (%) จากกริด 2 กม.'
              : 'Province-mean temperature (°C) and chance of rain (%) from the 2 km grid'}
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
            <Icon name="map" /> {lang === 'th' ? 'ดูบนแผนที่ความละเอียด 2 กม.' : 'Open on the 2 km map'}
          </Link>
        </div>
      </div>
    </div>
  );
}
