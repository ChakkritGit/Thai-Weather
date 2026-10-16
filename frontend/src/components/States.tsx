'use client';

import type { ReactNode } from 'react';
import { useT } from '../i18n';
import { Icon, type IconName } from './Icon';

/** One shape for "nothing here", "something broke" and "not found". */
export function StateMessage({
  icon,
  title,
  children,
  actions,
  role,
  minHeight = '50vh',
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  role?: 'alert' | 'status';
  minHeight?: string;
}) {
  return (
    <div className="empty" role={role} style={{ minHeight }}>
      {icon && (
        <span className="empty-icon">
          <Icon name={icon} />
        </span>
      )}
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {actions && <div className="empty-actions">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, children, minHeight }: { title: string; children?: ReactNode; minHeight?: string }) {
  return (
    <StateMessage icon="cloud" title={title} minHeight={minHeight}>
      {children}
    </StateMessage>
  );
}

/** Friendly failure with a retry button. */
export function ErrorState({
  title,
  children,
  onRetry,
  minHeight,
}: {
  title?: string;
  children?: ReactNode;
  onRetry?: () => void;
  minHeight?: string;
}) {
  const { t } = useT();
  return (
    <StateMessage
      icon="cloudOff"
      role="alert"
      title={title ?? t('errorTitle')}
      minHeight={minHeight}
      actions={
        onRetry && (
          <button type="button" className="btn" onClick={onRetry}>
            <Icon name="refresh" />
            {t('retry')}
          </button>
        )
      }
    >
      {children ?? t('errorBody')}
    </StateMessage>
  );
}

/* ------------------------------------------------------------ skeletons */

export function PanelSkeleton() {
  return (
    <div className="panel" aria-busy="true" aria-live="polite">
      <div className="skeleton skeleton--title" />
      <div className="skeleton skeleton--block" />
      <div className="skel-stack">
        <div className="skeleton skeleton--text" style={{ width: '90%' }} />
        <div className="skeleton skeleton--text" style={{ width: '75%' }} />
        <div className="skeleton skeleton--text" style={{ width: '82%' }} />
      </div>
    </div>
  );
}

export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="card" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skel-row" key={i}>
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ))}
    </div>
  );
}

export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="skel-grid" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="skeleton skeleton--block" key={i} style={{ height: 112 }} />
      ))}
    </div>
  );
}

/** A text page (method, developers): a few cards of paragraph lines. */
function ArticleSkeleton() {
  return (
    <div className="skel-stack-lg" aria-busy="true">
      {[5, 4, 6].map((lines, i) => (
        <div className="card card-pad skel-stack" key={i}>
          <div className="skeleton skeleton--text" style={{ width: '40%', height: 20 }} />
          {Array.from({ length: lines }, (_, j) => (
            <div className="skeleton skeleton--text" key={j} style={{ width: `${[96, 88, 92, 70, 84, 60][j % 6]}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** The verification report: a row of score tiles, then chart cards. */
function ReportSkeleton() {
  return (
    <div className="skel-stack-lg" aria-busy="true">
      <div className="skel-grid">
        {Array.from({ length: 3 }, (_, i) => (
          <div className="skeleton skeleton--block" key={i} style={{ height: 96 }} />
        ))}
      </div>
      {[180, 240].map((h, i) => (
        <div className="card card-pad skel-stack" key={i}>
          <div className="skeleton skeleton--text" style={{ width: '45%', height: 20 }} />
          <div className="skeleton skeleton--block" style={{ height: h }} />
        </div>
      ))}
    </div>
  );
}

/** Route-level placeholder used by `loading.tsx` files. */
export function PageSkeleton({ variant = 'table' }: { variant?: 'table' | 'cards' | 'article' | 'report' }) {
  const { t } = useT();
  return (
    <div className="page" role="status" aria-label={t('loading')}>
      <div className="page-inner">
        <div className="page-head">
          <div className="skeleton skeleton--title" />
          <div className="skeleton skeleton--text" style={{ width: 'min(520px, 80%)' }} />
        </div>
        {variant === 'cards' ? <CardGridSkeleton /> : variant === 'article' ? <ArticleSkeleton /> : variant === 'report' ? <ReportSkeleton /> : <TableSkeleton />}
      </div>
    </div>
  );
}
