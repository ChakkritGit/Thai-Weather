'use client';

import { api, type ProvinceWithDays, type RunMeta } from '../lib/api';
import { coverageNote, maxSeverity, sourceLabel, tierCounts } from '../lib/alertText';
import { fmtDateTime, fmtDay, fmtNum } from '../lib/format';
import Link from 'next/link';
import { paths } from '../lib/paths';
import { useAsync } from '../lib/useAsync';
import { useT } from '../i18n';
import { Icon } from './Icon';
import { AlertBadge, TierChip } from './SeverityBadge';

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
  const th = lang === 'th';
  const rows = data.provinces.map((p) => ({ p, d: p.days[dayIndex] })).filter((r) => r.d);
  const maxBy = (f: (r: { p: ProvinceWithDays; d: ProvinceWithDays['days'][0] }) => number) =>
    rows.reduce((best, r) => (f(r) > f(best) ? r : best), rows[0]);
  const hottest = maxBy((r) => r.d.heat_max);
  const wettest = maxBy((r) => r.d.rain_p95);
  const coldest = maxBy((r) => -r.d.tmin_low);
  const withAlerts = rows.filter((r) => r.d.alerts.length > 0);
  const [yellow, orange, red] = tierCounts(rows.map((r) => r.d.alerts));
  const top = [...withAlerts].sort((a, b) => maxSeverity(b.d.alerts) - maxSeverity(a.d.alerts)).slice(0, 8);
  const note = coverageNote(day, lang);
  const partialSuffix = note ? (th ? ' (เท่าที่มีข้อมูล)' : ' (so far)') : '';

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h2>{t('overview')}</h2>
          <p className="muted" style={{ fontSize: 'var(--font-size-sm)', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {fmtDay(day.date, lang, true)}
            {note && <span className="partial-note">{note}</span>}
          </p>
        </div>
      </div>

      <div className="now-grid">
        <Tile icon="heat" label={`${th ? 'ร้อนที่สุด (ดัชนีความร้อน)' : 'Highest heat index'}${partialSuffix}`} value={`${fmtNum(hottest.d.heat_max, 0)}°`} where={pick(hottest.p)} />
        <Tile icon="drop" label={th ? 'ฝนมากที่สุด' : 'Heaviest rain'} value={`${fmtNum(wettest.d.rain_p95, 0)} ${th ? 'มม.' : 'mm'}`} where={pick(wettest.p)} />
        <Tile icon="mountain" label={`${th ? 'เย็นที่สุด' : 'Coldest spot'}${partialSuffix}`} value={`${fmtNum(coldest.d.tmin_low, 0)}°`} where={pick(coldest.p)} />
        <div className="stat">
          <span className="stat-label">{th ? 'จังหวัดที่มีการแจ้งเตือน' : 'Provinces with alerts'}</span>
          <span className="stat-value">
            {withAlerts.length}
            <span className="muted" style={{ fontSize: 'var(--font-size-sm)', fontWeight: 400 }}> / {rows.length}</span>
          </span>
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            <TierChip severity={3} count={red} />
            <TierChip severity={2} count={orange} />
            <TierChip severity={1} count={yellow} />
          </span>
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
                <span className="sev-bar" data-sev={maxSeverity(d.alerts)} />
                <span>
                  <span className="name">{pick(p)}</span>
                  <span className="badges">
                    {d.alerts.map((a) => (
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
        <p style={{ fontSize: 'var(--font-size-sm)' }}>
          {t('updatedAt')} <b className="num">{fmtDateTime(run.created ?? run.issued, lang)}</b> · {t('source')}{' '}
          {sourceLabel(run, lang)}
        </p>
        <details className="tech-details">
          <summary>{t('techDetails')}</summary>
          <dl className="kv">
            <dt>{t('source')}</dt>
            <dd>
              {run.source} · {run.model}
            </dd>
            <dt>{t('issued')}</dt>
            <dd>{fmtDateTime(run.issued, lang)}</dd>
            <dt>{th ? 'ความละเอียด' : 'Resolution'}</dt>
            <dd>
              {fmtNum(run.coarse_grid.resolution_km, 1)} → <b>{fmtNum(run.fine_grid.resolution_km, 1)}</b> {th ? 'กม.' : 'km'}
            </dd>
            <dt>{t('gridPoints')}</dt>
            <dd>{(run.fine_grid.nx * run.fine_grid.ny).toLocaleString()}</dd>
            <dt>{t('members')}</dt>
            <dd>{run.ensemble_members}</dd>
            {run.observations_used > 0 && (
              <>
                <dt>{th ? 'สถานีตรวจวัด' : 'Stations used'}</dt>
                <dd>{run.observations_used}</dd>
              </>
            )}
          </dl>
        </details>
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
