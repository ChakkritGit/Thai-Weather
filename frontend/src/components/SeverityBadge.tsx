import type { Alert } from '../lib/api';
import { useT } from '../i18n';
import { Icon, hazardIcon } from './Icon';

export function AlertBadge({ alert, showValue = false }: { alert: Alert; showValue?: boolean }) {
  const { pick } = useT();
  const unit = alert.hazard === 'rain' ? ' มม.' : alert.hazard === 'storm' ? '%' : alert.hazard === 'wind' ? ' m/s' : '°';
  return (
    <span className="badge" data-sev={alert.severity}>
      <Icon name={hazardIcon[alert.hazard] ?? 'alert'} />
      {pick(alert)}
      {showValue && <span className="num">{` ${Math.round(alert.value)}${unit}`}</span>}
    </span>
  );
}

export function LevelBadge({ severity, label }: { severity: number; label: string }) {
  return (
    <span className="badge" data-sev={severity}>
      {label}
    </span>
  );
}
