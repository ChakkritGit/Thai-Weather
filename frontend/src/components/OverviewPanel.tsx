'use client';

import { api, type ProvinceWithDays, type RunMeta } from '../lib/api';
import { fmtDateTime, fmtDay, fmtNum } from '../lib/format';
import Link from 'next/link';
import { paths } from '../lib/paths';
import { useAsync } from '../lib/useAsync';
import { useT } from '../i18n';
import { Icon } from './Icon';
import { AlertBadge } from './SeverityBadge';

export function OverviewPanel({ run, dayIndex }: { run: RunMeta; dayIndex: number }) {
  const { t, lang, pick } = useT();
  const { data } = useAsync(`provinces:${run.run_id}`, api.provinces);
  const day = run.days[dayIndex];

  if (!data) {
    return (
      <div className="panel" aria-busy="true">
        <div className="skeleton" style={{ height: 28, width: '50%' }} />
        <div className="skeleton" style={{ height: 120 }} />
        <div className="skeleton" style={{ height: 220 }} />
      </div>
    );
  }
  const rows = data.provinces.map((p) => ({ p, d: p.days[dayIndex] })).filter((r) => r.d);
  const maxBy = (f: (r: { p: ProvinceWithDays; d: ProvinceWithDays['days'][0] }) => number) =>
    rows.reduce((best, r) => (f(r) > f(best) ? r : best), rows[0]);
  const hottest = maxBy((r) => r.d.heat_max);
  const wettest = maxBy((r) => r.d.rain_p95);
  const coldest = maxBy((r) => -r.d.tmin_low);
  const bySev = [3, 2, 1].map((s) => rows.filter((r) => Math.max(0, ...r.d.alerts.map((a) => a.severity)) === s).length);
  const top = rows
    .filter((r) => r.d.alerts.some((a) => a.severity >= 2))
    .sort((a, b) => Math.max(...b.d.alerts.map((x) => x.severity)) - Math.max(...a.d.alerts.map((x) => x.severity)))
    .slice(0, 8);

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h2>{t('overview')}</h2>
          <p className="muted" style={{ fontSize: 'var(--font-size-sm)' }}>
            {fmtDay(day.date, lang, true)}
          </p>
        </div>
      </div>

      <div className="now-grid">
        <Tile icon="heat" label={lang === 'th' ? 'ร้อนที่สุด (ดัชนีความร้อน)' : 'Highest heat index'} value={`${fmtNum(hottest.d.heat_max, 0)}°`} where={pick(hottest.p)} />
        <Tile icon="drop" label={lang === 'th' ? 'ฝนมากที่สุด' : 'Heaviest rain'} value={`${fmtNum(wettest.d.rain_p95, 0)} ${lang === 'th' ? 'มม.' : 'mm'}`} where={pick(wettest.p)} />
        <Tile icon="mountain" label={lang === 'th' ? 'เย็นที่สุด' : 'Coldest spot'} value={`${fmtNum(coldest.d.tmin_low, 0)}°`} where={pick(coldest.p)} />
        <div className="stat">
          <span className="stat-label">{lang === 'th' ? 'จังหวัดที่มีการเตือน' : 'Provinces with alerts'}</span>
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            {[3, 2, 1].map((s, k) => (
              <span key={s} className="badge" data-sev={s}>
                <span className="num">{bySev[k]}</span>
              </span>
            ))}
          </span>
          <span className="stat-sub">{lang === 'th' ? 'อันตราย · เตือนภัย · เฝ้าระวัง' : 'danger · warning · advisory'}</span>
        </div>
      </div>

      <section className="panel-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h3>{t('topAlerts')}</h3>
          <Link href={paths.alerts} style={{ fontSize: 'var(--font-size-sm)' }}>
            {t('seeAll')}
          </Link>
        </div>
        {top.length === 0 ? (
          <p className="muted" style={{ fontSize: 'var(--font-size-sm)' }}>
            {t('noAlerts')}
          </p>
        ) : (
          <div>
            {top.map(({ p, d }) => (
              <Link key={p.id} className="alert-row" href={paths.province(p)}>
                <span className="sev-bar" data-sev={Math.max(...d.alerts.map((a) => a.severity))} />
                <span>
                  <span className="name">{pick(p)}</span>
                  <span className="badges">
                    {d.alerts
                      .filter((a) => a.severity >= 2)
                      .map((a) => (
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

      <section className="panel-section">
        <h3>{lang === 'th' ? 'ข้อมูลรอบพยากรณ์' : 'Forecast run'}</h3>
        <dl className="kv">
          <dt>{t('source')}</dt>
          <dd>
            {run.source} · {run.model}
          </dd>
          <dt>{t('issued')}</dt>
          <dd>{fmtDateTime(run.issued, lang)}</dd>
          <dt>{lang === 'th' ? 'ความละเอียด' : 'Resolution'}</dt>
          <dd>
            {run.coarse_grid.resolution_km} → <b>{run.fine_grid.resolution_km}</b> {lang === 'th' ? 'กม.' : 'km'} (
            {(run.fine_grid.nx * run.fine_grid.ny).toLocaleString()} {lang === 'th' ? 'จุดกริด' : 'cells'})
          </dd>
          <dt>{t('members')}</dt>
          <dd>{run.ensemble_members}</dd>
          {run.observations_used > 0 && (
            <>
              <dt>{lang === 'th' ? 'สถานีตรวจวัด' : 'Stations used'}</dt>
              <dd>{run.observations_used}</dd>
            </>
          )}
        </dl>
        <p className="subtle" style={{ fontSize: 'var(--font-size-xs)' }}>
          <Icon name="info" width={14} style={{ verticalAlign: '-2px' }} /> {t('clickHint')}
        </p>
      </section>
    </div>
  );
}

function Tile({ icon, label, value, where }: { icon: 'heat' | 'drop' | 'mountain'; label: string; value: string; where: string }) {
  return (
    <div className="stat">
      <span className="stat-label">
        <Icon name={icon} width={13} style={{ verticalAlign: '-2px' }} /> {label}
      </span>
      <span className="stat-value">{value}</span>
      <span className="stat-sub">{where}</span>
    </div>
  );
}
