'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LangProvider, useT, type DictKey, type Lang } from '../i18n';
import { ThemeProvider, useTheme, type Theme } from '../lib/theme';
import { fmtDateTime } from '../lib/format';
import { paths } from '../lib/paths';
import { Icon, type IconName } from './Icon';
import { ErrorState, StateMessage } from './States';

export function Providers({ lang, theme, children }: { lang: Lang; theme: Theme | null; children: ReactNode }) {
  return (
    <LangProvider initial={lang}>
      <ThemeProvider initial={theme}>{children}</ThemeProvider>
    </LangProvider>
  );
}

/** Main navigation. The design-system page stays routable but is linked from the footer. */
const NAV: { href: string; icon: IconName; key: DictKey }[] = [
  { href: paths.map, icon: 'map', key: 'navMap' },
  { href: paths.provinces, icon: 'list', key: 'navProvinces' },
  { href: paths.alerts, icon: 'alert', key: 'navAlerts' },
  { href: paths.method, icon: 'book', key: 'navMethod' },
];

function useActive() {
  const pathname = usePathname() ?? '/';
  return (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
}

export function SkipLink() {
  const { t } = useT();
  return (
    <a className="skip-link" href="#main">
      {t('skipToContent')}
    </a>
  );
}

/**
 * Live clock in Thailand time: weekday, date, month, year (Buddhist era in Thai), hours and minutes.
 * Rendered only in the browser (no server time baked into the page) and ticks on the minute.
 */
function Clock() {
  const { lang } = useT();
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    let timer = 0;
    const tick = () => {
      const d = new Date();
      setNow(d);
      timer = window.setTimeout(tick, 60_000 - (d.getSeconds() * 1000 + d.getMilliseconds()) + 50);
    };
    tick();
    const wake = () => document.visibilityState === 'visible' && setNow(new Date());
    document.addEventListener('visibilitychange', wake);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
    };
  }, []);
  const locale = lang === 'th' ? 'th-TH' : 'en-GB';
  const tz = 'Asia/Bangkok';
  if (!now) return <span className="clock" aria-hidden="true" />;
  const day = new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: 'short' }).format(now);
  const date = new Intl.DateTimeFormat(locale, { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' }).format(now);
  const time = new Intl.DateTimeFormat(locale, { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  const full = new Intl.DateTimeFormat(locale, { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(now);
  return (
    <time className="clock" dateTime={now.toISOString()} title={full} aria-label={full}>
      <span className="clock-day">{day}</span>
      <span className="clock-date">{date}</span>
      <span className="clock-time num">{time}</span>
    </time>
  );
}

export function Header({ alertCount }: { alertCount: number }) {
  const { t, lang, setLang } = useT();
  const { theme, toggle } = useTheme();
  const active = useActive();
  return (
    <header className="header">
      <Clock />
      <nav className="nav" aria-label="main">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} aria-current={active(n.href) ? 'page' : undefined}>
            {t(n.key)}
            {n.href === paths.alerts && alertCount > 0 && (
              <span className="count" aria-label={`${alertCount}`}>
                {alertCount}
              </span>
            )}
          </Link>
        ))}
      </nav>
      <div className="header-actions">
        <button type="button" className="icon-btn" onClick={() => setLang(lang === 'th' ? 'en' : 'th')} aria-label="Language / ภาษา">
          {lang === 'th' ? 'EN' : 'TH'}
        </button>
        <button type="button" className="icon-btn" onClick={toggle} aria-label={t('theme')}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
      </div>
    </header>
  );
}

export function BottomNav({ alertCount }: { alertCount: number }) {
  const { t } = useT();
  const active = useActive();
  return (
    <nav className="bottom-nav" aria-label="main">
      {NAV.map((n) => (
        <Link key={n.href} href={n.href} aria-current={active(n.href) ? 'page' : undefined} data-tab-bounce>
          <Icon name={n.icon} />
          <span className="label">{t(n.key)}</span>
          {n.href === paths.alerts && alertCount > 0 && <span className="count">{alertCount}</span>}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Slim site footer for the pages that scroll (not shown over the full-screen map).
 * Carries the data sources, the "not an official announcement" notice and the
 * run time of the forecast currently shown.
 */
export function Footer({ updated }: { updated: string | null }) {
  const { t, lang } = useT();
  const pathname = usePathname() ?? '/';
  if (pathname === '/') return null;
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <p className="site-footer-note">{t('footerNote')}</p>
        <p className="site-footer-meta">
          {t('footerSources')}
          {updated && (
            <>
              <span className="sep" aria-hidden="true">
                ·
              </span>
              {t('footerUpdated')}{' '}
              <time className="num" dateTime={updated}>
                {fmtDateTime(updated, lang)}
              </time>
            </>
          )}
        </p>
        <nav aria-label={t('footerMore')}>
          <Link href={paths.method}>{t('navMethod')}</Link>
          <Link href={paths.design}>{t('navDesign')}</Link>
        </nav>
      </div>
    </footer>
  );
}

/** Shown while the backend computes its first run (or is unreachable); re-checks automatically. */
export function Warming({ reachable }: { reachable: boolean }) {
  const { t } = useT();
  const router = useRouter();
  useEffect(() => {
    const id = window.setInterval(() => router.refresh(), 8000);
    return () => window.clearInterval(id);
  }, [router]);
  return (
    <div className="page">
      {reachable ? (
        <StateMessage
          role="status"
          title={t('warmingTitle')}
          minHeight="60vh"
          actions={
            <button className="btn" type="button" onClick={() => router.refresh()}>
              <Icon name="refresh" />
              {t('retry')}
            </button>
          }
        >
          <span className="spinner" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 8 }} />
          {t('warming')}
        </StateMessage>
      ) : (
        <ErrorState title={t('unreachableTitle')} onRetry={() => router.refresh()} minHeight="60vh">
          {t('unreachableBody')}
        </ErrorState>
      )}
    </div>
  );
}
