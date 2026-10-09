'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Meta, ProvinceWithDays, RunMeta } from '../lib/api';
import { categorise } from '../lib/color';
import { fmtDay, fmtNum } from '../lib/format';
import { paths } from '../lib/paths';
import { useT } from '../i18n';
import { Icon } from '../components/Icon';
import { AlertBadge, LevelBadge } from '../components/SeverityBadge';

export function ProvincesView({ meta, run, provinces }: { meta: Meta; run: RunMeta; provinces: ProvinceWithDays[] }) {
  const { t, lang, pick } = useT();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [region, setRegion] = useState('all');
  const [day, setDay] = useState(run.days.length > 1 && run.days[0].hours < 12 ? 1 : 0);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return provinces
      .filter((p) => region === 'all' || p.region === region)
      .filter((p) => !needle || p.name_th.includes(needle) || p.name_en.toLowerCase().includes(needle))
      .sort((a, b) => (lang === 'th' ? a.name_th.localeCompare(b.name_th, 'th') : a.name_en.localeCompare(b.name_en)));
  }, [provinces, q, region, lang]);

  return (
    <div className="page">
      <div className="page-inner">
        <header className="page-head">
          <h1>{lang === 'th' ? 'พยากรณ์อากาศรายจังหวัด' : 'Forecast by province'}</h1>
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

        <div className="card table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{lang === 'th' ? 'จังหวัด' : 'Province'}</th>
                <th className="num">
                  {t('tmin')}–{t('tmax')} °C
                </th>
                <th className="num">{t('heatIndex')}</th>
                <th>{t('areaRain')}</th>
                <th className="num">{t('maxRain')}</th>
                <th>{t('navAlerts')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const d = p.days[day];
                if (!d) return null;
                const heat = categorise('heatIndex', d.heat_max);
                const cov = categorise('rainCoverage', d.rain_coverage);
                return (
                  <tr key={p.id} onClick={() => router.push(paths.province(p))}>
                    <td>
                      <Link href={paths.province(p)} onClick={(e) => e.stopPropagation()} style={{ color: 'inherit', fontWeight: 500 }}>
                        {pick(p)}
                      </Link>
                      <div className="subtle" style={{ fontSize: 'var(--font-size-xs)' }}>
                        {pick(meta.regions.find((r) => r.id === p.region) ?? { name_th: '', name_en: '' })}
                      </div>
                    </td>
                    <td className="num">
                      {fmtNum(d.tmin, 0)}–{fmtNum(d.tmax, 0)}
                    </td>
                    <td className="num">
                      {fmtNum(d.heat_max, 0)} {heat && heat.severity >= 1 && <LevelBadge severity={heat.severity} label={pick(heat)} />}
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
      </div>
    </div>
  );
}
