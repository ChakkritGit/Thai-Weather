'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { AlertEntry, RunMeta } from '../lib/api';
import { fmtDay } from '../lib/format';
import { paths } from '../lib/paths';
import { categories } from '../lib/color';
import { useT } from '../i18n';
import { Icon } from '../components/Icon';
import { AlertBadge } from '../components/SeverityBadge';

export function AlertsPage({ run, alerts }: { run: RunMeta; alerts: AlertEntry[] }) {
  const { t, lang, pick } = useT();
  const [minSev, setMinSev] = useState(2);
  const sevLabels = { 1: lang === 'th' ? 'เฝ้าระวัง' : 'Advisory', 2: lang === 'th' ? 'เตือนภัย' : 'Warning', 3: lang === 'th' ? 'อันตราย' : 'Danger' };

  const byDay = run.days.map((d) => ({
    day: d,
    entries: alerts
      .filter((a) => a.date === d.date)
      .map((a) => ({ ...a, alerts: a.alerts.filter((x) => x.severity >= minSev) }))
      .filter((a) => a.alerts.length > 0)
      .sort((a, b) => Math.max(...b.alerts.map((x) => x.severity)) - Math.max(...a.alerts.map((x) => x.severity))),
  }));

  return (
    <div className="page">
      <div className="page-inner">
        <header className="page-head">
          <h1>{lang === 'th' ? 'การเตือนภัยรายจังหวัด' : 'Province alerts'}</h1>
          <p>
            {lang === 'th'
              ? 'สร้างอัตโนมัติจากผลพยากรณ์ 2 กม. ตามเกณฑ์ดัชนีความร้อนของกรมอนามัย เกณฑ์ปริมาณฝนและอุณหภูมิของกรมอุตุนิยมวิทยา และมาตราโบฟอร์ต — เป็นข้อมูลประกอบ ไม่ใช่ประกาศเตือนภัยทางการ'
              : 'Generated automatically from the 2 km forecast using Dept. of Health heat-index levels, TMD rainfall and temperature terms and the Beaufort scale – guidance only, not an official warning.'}
          </p>
        </header>
        <div className="toolbar">
          <span className="muted" style={{ fontSize: 'var(--font-size-sm)' }}>{t('minSeverity')}:</span>
          <div className="segmented" role="group" aria-label={t('minSeverity')}>
            {([1, 2, 3] as const).map((s) => (
              <button key={s} type="button" aria-pressed={minSev === s} onClick={() => setMinSev(s)}>
                <span className="badge" data-sev={s} style={{ minHeight: 18, padding: '0 6px' }}>{sevLabels[s]}</span>
              </button>
            ))}
          </div>
        </div>
        {byDay.map(({ day, entries }) => (
            <section key={day.date} className="card card-pad" style={{ display: 'grid', gap: 8 }}>
              <h2 style={{ fontSize: 'var(--font-size-lg)' }}>
                {fmtDay(day.date, lang, true)}{' '}
                <span className="muted" style={{ fontSize: 'var(--font-size-sm)', fontWeight: 400 }}>
                  · {entries.length} {lang === 'th' ? 'จังหวัด' : 'provinces'}
                </span>
              </h2>
              {entries.length === 0 ? (
                <div className="empty" style={{ padding: 16 }}>
                  <Icon name="sun" width={24} />
                  {t('noAlerts')}
                </div>
              ) : (
                <div>
                  {entries.map((e) => (
                    <Link key={e.province.id} className="alert-row" href={paths.province(e.province)}>
                      <span className="sev-bar" data-sev={Math.max(...e.alerts.map((a) => a.severity))} />
                      <span>
                        <span className="name">{pick(e.province)}</span>
                        <span className="badges">
                          {e.alerts.map((a) => (
                            <AlertBadge key={a.hazard} alert={a} showValue />
                          ))}
                        </span>
                      </span>
                      <Icon name="chevron" width={16} className="subtle" />
                    </Link>
                  ))}
                </div>
              )}
            </section>
          ))}
        <section className="card card-pad" style={{ display: 'grid', gap: 8 }}>
          <h2 style={{ fontSize: 'var(--font-size-md)' }}>{lang === 'th' ? 'เกณฑ์ที่ใช้' : 'Thresholds used'}</h2>
          <div className="two-col">
            {(['heatIndex', 'rainDaily', 'tempMin', 'wind'] as const).map((k) => (
              <div key={k} style={{ display: 'grid', gap: 4, fontSize: 'var(--font-size-sm)' }}>
                <b>{categories[k].source}</b>
                {categories[k].levels.map((l) => (
                  <span key={l.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="badge" data-sev={l.severity}>{pick(l)}</span>
                    <span className="num muted">
                      {l.min !== undefined ? `≥ ${l.min}` : `≤ ${l.max}`} {categories[k].unit}
                    </span>
                  </span>
                ))}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
