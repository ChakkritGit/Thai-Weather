'use client';

import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LangProvider, useT, type DictKey, type Lang } from '../i18n';
import { ThemeProvider, useTheme, type Theme } from '../lib/theme';
import { paths } from '../lib/paths';
import { Icon, type IconName } from './Icon';

export function Providers({ lang, theme, children }: { lang: Lang; theme: Theme | null; children: ReactNode }) {
  return (
    <LangProvider initial={lang}>
      <ThemeProvider initial={theme}>{children}</ThemeProvider>
    </LangProvider>
  );
}

const NAV: { href: string; icon: IconName; key: DictKey }[] = [
  { href: paths.map, icon: 'map', key: 'navMap' },
  { href: paths.provinces, icon: 'list', key: 'navProvinces' },
  { href: paths.alerts, icon: 'alert', key: 'navAlerts' },
  { href: paths.method, icon: 'book', key: 'navMethod' },
  { href: paths.design, icon: 'palette', key: 'navDesign' },
];

function useActive() {
  const pathname = usePathname() ?? '/';
  return (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
}

export function Header({ alertCount }: { alertCount: number }) {
  const { t, lang, setLang } = useT();
  const { theme, toggle } = useTheme();
  const active = useActive();
  return (
    <header className="header">
      <Link className="brand" href={paths.map}>
        <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="8" fill="var(--color-accent-default)" />
          <g fill="var(--color-fg-onAccent)">
            {[0, 1, 2].flatMap((r) =>
              [0, 1, 2].map((c) => (
                <rect key={`${r}${c}`} x={7 + c * 6.5} y={7 + r * 6.5} width="5" height="5" rx="1" opacity={r === c ? 1 : Math.abs(r - c) === 1 ? 0.75 : 0.5} />
              )),
            )}
          </g>
        </svg>
        <span>
          <span className="brand-name">{t('brand')}</span>
          <span className="brand-tag" style={{ display: 'block' }}>
            {t('tagline')}
          </span>
        </span>
      </Link>
      <nav className="nav" aria-label="main">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} aria-current={active(n.href) ? 'page' : undefined}>
            {t(n.key)}
            {n.href === paths.alerts && alertCount > 0 && <span className="count">{alertCount}</span>}
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
      {NAV.slice(0, 4).map((n) => (
        <Link key={n.href} href={n.href} aria-current={active(n.href) ? 'page' : undefined}>
          <Icon name={n.icon} />
          {t(n.key)}
          {n.href === paths.alerts && alertCount > 0 && <span className="count">{alertCount}</span>}
        </Link>
      ))}
    </nav>
  );
}

/** Shown while the backend computes its first run (or is unreachable); re-checks automatically. */
export function Warming({ reachable }: { reachable: boolean }) {
  const { t, lang } = useT();
  const router = useRouter();
  useEffect(() => {
    const id = window.setInterval(() => router.refresh(), 8000);
    return () => window.clearInterval(id);
  }, [router]);
  return (
    <div className="page">
      <div className="empty" style={{ minHeight: '60vh' }}>
        {reachable ? <span className="spinner" /> : <Icon name="alert" width={32} />}
        <p>
          {reachable
            ? t('warming')
            : lang === 'th'
              ? 'ติดต่อเซิร์ฟเวอร์พยากรณ์ไม่ได้ (ตรวจสอบ THWX_API_URL)'
              : 'Cannot reach the forecast server (check THWX_API_URL)'}
        </p>
        <button className="btn" type="button" onClick={() => router.refresh()}>
          {t('retry')}
        </button>
      </div>
    </div>
  );
}
