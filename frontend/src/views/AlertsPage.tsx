'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { AlertEntry, RunMeta } from '../lib/api';
import { coverageNote, hazardName, hazardSource, isPartialDay, maxSeverity, tierInfo } from '../lib/alertText';
import { fmtDay } from '../lib/format';
import { paths } from '../lib/paths';
import { categories, type CategoryLevel } from '../lib/color';
import { useT } from '../i18n';
import { Icon } from '../components/Icon';
import { AlertBadge, TierChip } from '../components/SeverityBadge';

/** Hazard → token category, in table order. */
const CRITERIA = [
  ['heat', 'heatIndex'],
  ['rain', 'rainDaily'],
  ['storm', 'thunder'],
  ['wind', 'wind'],
  ['hot', 'tempMax'],
  ['cold', 'tempMin'],
] as const;

/** Levels that only describe "nothing special" are left out of the criteria table. */
const PLAIN_LEVELS = new Set(['normal', 'none', 'light', 'moderate', 'cool']);

function threshold(l: CategoryLevel, unit: string): string {
  return l.min !== undefined ? `≥ ${l.min} ${unit}` : `≤ ${l.max} ${unit}`;
}

export function AlertsPage({ run, alerts }: { run: RunMeta; alerts: AlertEntry[] }) {
  const { t, lang, pick } = useT();
  const th = lang === 'th';
  const [minSev, setMinSev] = useState(1);

  const byDay = run.days.map((d) => ({
    day: d,
    entries: alerts
      .filter((a) => a.date === d.date)
      .map((a) => ({ ...a, alerts: a.alerts.filter((x) => x.severity >= minSev) }))
      .filter((a) => a.alerts.length > 0)
      .sort((a, b) => maxSeverity(b.alerts) - maxSeverity(a.alerts)),
  }));
  const withAlerts = byDay.filter((x) => x.entries.length > 0);
  const quiet = byDay.filter((x) => x.entries.length === 0);

  return (
    <div className="page">
      <div className="page-inner">
        <header className="page-head">
          <h1>{th ? 'การแจ้งเตือนสภาพอากาศรายจังหวัด' : 'Province weather alerts'}</h1>
          <p>
            {th
              ? 'สร้างอัตโนมัติจากผลพยากรณ์ 2 กม. ตามเกณฑ์ดัชนีความร้อนของกรมอนามัย เกณฑ์ปริมาณฝนและอุณหภูมิของกรมอุตุนิยมวิทยา และมาตราโบฟอร์ต — เป็นข้อมูลประกอบ ไม่ใช่ประกาศเตือนภัยทางการ'
              : 'Generated automatically from the 2 km forecast using Dept. of Health heat-index levels, TMD rainfall and temperature terms and the Beaufort scale – guidance only, not an official warning.'}
          </p>
        </header>
        <div className="toolbar">
          <span className="muted" style={{ fontSize: 'var(--font-size-sm)' }}>{t('minSeverity')}:</span>
          <div className="segmented" role="group" aria-label={t('minSeverity')}>
            {([1, 2, 3] as const).map((s) => (
              <button key={s} type="button" aria-pressed={minSev === s} onClick={() => setMinSev(s)}>
                <span className="badge" data-sev={s} style={{ minHeight: 18, padding: '0 6px' }}>
                  {tierInfo(s, lang).name}
                </span>
              </button>
            ))}
          </div>
        </div>

        {withAlerts.map(({ day, entries }) => {
          const note = coverageNote(day, lang);
          return (
            <section key={day.date} className="card card-pad" style={{ display: 'grid', gap: 8 }}>
              <h2 style={{ fontSize: 'var(--font-size-lg)', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
                <span>{fmtDay(day.date, lang, true)}</span>
                <span className="muted" style={{ fontSize: 'var(--font-size-sm)', fontWeight: 400 }}>
                  · {entries.length} {t('provincesUnit')}
                </span>
                {note && <span className="partial-note">{note}</span>}
              </h2>
              {isPartialDay(day) && (
                <p className="subtle" style={{ fontSize: 'var(--font-size-xs)' }}>
                  {th ? 'วันนี้มีข้อมูลบางช่วงเวลา การแจ้งเตือนอิงเฉพาะช่วงที่มีข้อมูล' : 'Only part of this day is covered; alerts are based on the available hours.'}
                </p>
              )}
              <div>
                {entries.map((e) => (
                  <Link key={e.province.id} className="alert-row" href={paths.province(e.province)}>
                    <span className="sev-bar" data-sev={maxSeverity(e.alerts)} />
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
            </section>
          );
        })}

        {quiet.length > 0 && (
          <p className="quiet-line">
            <Icon name="sun" width={18} />
            <span>
              {quiet.map((x) => fmtDay(x.day.date, lang)).join(' · ')} — <b>{t('noAlerts')}</b>
            </span>
          </p>
        )}

        <section className="card card-pad" style={{ display: 'grid', gap: 12 }}>
          <h2 style={{ fontSize: 'var(--font-size-md)' }}>{th ? 'ระดับการแจ้งเตือนและเกณฑ์ที่ใช้' : 'Alert tiers and thresholds'}</h2>
          <div className="tier-legend">
            {([1, 2, 3] as const).map((s) => (
              <TierChip key={s} severity={s} advice />
            ))}
          </div>
          <p className="muted" style={{ fontSize: 'var(--font-size-sm)' }}>
            {th
              ? 'สีเหลือง ส้ม แดง ใช้กับการแจ้งเตือนเท่านั้น ส่วนชื่อระดับของแต่ละปรากฏการณ์ (เช่น ดัชนีความร้อน “เตือนภัย” ของกรมอนามัย) เป็นศัพท์ตามต้นทาง ใช้เป็นข้อมูลประกอบและไม่ถือเป็นการแจ้งเตือนหากไม่มีสี'
              : 'Yellow, orange and red are used for alerts only. The level names of each phenomenon (e.g. the Dept. of Health heat-index level “เตือนภัย”) are the source’s own terms: information only, not an alert unless a tier colour is shown.'}
          </p>
          <div className="table-wrap">
            <table className="data-table criteria-table">
              <thead>
                <tr>
                  <th>{th ? 'ปรากฏการณ์ (แหล่งที่มา)' : 'Phenomenon (source)'}</th>
                  <th>{th ? 'ระดับตามต้นทาง' : 'Source level'}</th>
                  <th className="num">{th ? 'เกณฑ์' : 'Threshold'}</th>
                  <th>{th ? 'ระดับแจ้งเตือน' : 'Alert tier'}</th>
                </tr>
              </thead>
              <tbody>
                {CRITERIA.flatMap(([hazard, cat]) => {
                  const c = categories[cat];
                  const levels = c.levels.filter((l) => !PLAIN_LEVELS.has(l.id));
                  const src = hazardSource(hazard, lang);
                  return levels.map((l, i) => (
                    <tr key={`${hazard}-${l.id}`} className={l.severity === 0 ? 'is-info' : undefined}>
                      <td>{i === 0 && <b>{hazardName(hazard, lang)}{src ? ` (${src})` : ''}</b>}</td>
                      <td>{pick(l)}</td>
                      <td className="num">{threshold(l, c.unit)}</td>
                      <td>
                        {l.severity >= 1 && l.severity <= 3 ? (
                          <TierChip severity={l.severity as 1 | 2 | 3} />
                        ) : (
                          <span className="muted">{th ? 'ข้อมูลประกอบ (ไม่แจ้งเตือน)' : 'information only'}</span>
                        )}
                      </td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>
          <p className="subtle" style={{ fontSize: 'var(--font-size-xs)' }}>
            {th
              ? 'ค่าที่ใช้ตัดสินต่อจังหวัด: ดัชนีความร้อนสูงสุด (เปอร์เซ็นไทล์ที่ 95 ของกริดในจังหวัด) · ฝนรายวัน (เปอร์เซ็นไทล์ที่ 95) · โอกาสพายุฝนฟ้าคะนองสูงสุด · ลมแรง (เปอร์เซ็นไทล์ที่ 95) · อุณหภูมิสูงสุด/ต่ำสุดตามค่ากลางของจังหวัด'
              : 'Value used per province: heat index maximum (95th percentile of cells) · daily rain (95th percentile) · peak thunderstorm chance · wind (95th percentile) · day max / min temperature as the province median.'}
          </p>
        </section>
      </div>
    </div>
  );
}
