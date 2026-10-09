'use client';

import Link from 'next/link';
import { Icon } from '@/components/Icon';
import { useT } from '@/i18n';
import { paths } from '@/lib/paths';

export default function NotFound() {
  const { t } = useT();
  return (
    <div className="page">
      <div className="empty" style={{ minHeight: '60vh' }}>
        <span className="notfound-code" aria-hidden="true">
          404
        </span>
        <h1>{t('notFoundTitle')}</h1>
        <p>{t('notFoundBody')}</p>
        <div className="empty-actions">
          <Link className="btn btn--primary" href={paths.map}>
            <Icon name="map" />
            {t('backToMap')}
          </Link>
          <Link className="btn" href={paths.provinces}>
            {t('navProvinces')}
          </Link>
        </div>
      </div>
    </div>
  );
}
