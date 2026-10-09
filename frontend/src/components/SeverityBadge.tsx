'use client';

import type { Alert } from '../lib/api';
import { alertTitle, alertValueText, hazardName, tierInfo } from '../lib/alertText';
import { useT } from '../i18n';
import { Icon, hazardIcon } from './Icon';

/** Coloured alert chip: always "<tier colour> · <hazard>" so one word means one thing everywhere. */
export function AlertBadge({ alert, showValue = false }: { alert: Alert; showValue?: boolean }) {
  const { lang, pick } = useT();
  const tier = tierInfo(alert.severity, lang);
  return (
    <span className="badge" data-sev={alert.severity} title={alertTitle(alert, lang)}>
      <Icon name={hazardIcon[alert.hazard] ?? 'alert'} />
      <span>{tier.name}</span>
      <span aria-hidden="true">·</span>
      <span>
        {hazardName(alert.hazard, lang)}
        {showValue && `: ${pick(alert)} ${alertValueText(alert, lang)}`}
      </span>
    </span>
  );
}

/** Tier chip without a hazard: "เหลือง" / "ส้ม" / "แดง" (optionally with a count). */
export function TierChip({ severity, count, advice = false }: { severity: 1 | 2 | 3; count?: number; advice?: boolean }) {
  const { lang } = useT();
  const tier = tierInfo(severity, lang);
  return (
    <span className="badge" data-sev={severity}>
      {advice ? tier.label : tier.name}
      {count !== undefined && <span className="num">{count}</span>}
    </span>
  );
}

/**
 * A hazard level (e.g. heat-index "เตือนภัย" of the Dept. of Health). Plain
 * muted text, never a coloured alert chip; pass `hazard` to prefix its name.
 */
export function LevelBadge({ label, hazard }: { severity?: number; label: string; hazard?: string }) {
  return (
    <span className="level-tag">
      {hazard ? `${hazard}: ` : ''}
      {label}
    </span>
  );
}
