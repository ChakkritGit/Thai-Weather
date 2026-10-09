import { useCallback, useEffect, useState } from 'react';
import { api, type Meta } from './lib/api';
import { href, useRoute, type Route } from './lib/router';
import { useAsync } from './lib/useAsync';
import { LangProvider, useT, type Lang } from './i18n';
import { Icon, type IconName } from './components/Icon';
import { MapPage } from './pages/MapPage';
import { ProvincesPage } from './pages/ProvincesPage';
import { AlertsPage } from './pages/AlertsPage';
import { MethodPage } from './pages/MethodPage';
import { DesignSystemPage } from './pages/DesignSystemPage';

type Theme = 'light' | 'dark';

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
};

export default function App() {
  const [lang, setLang] = useState<Lang>(() => (read('thwx.lang') as Lang) || 'th');
  const [theme, setTheme] = useState<Theme>(
    () => (read('thwx.theme') as Theme) || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = lang;
    write('thwx.theme', theme);
    write('thwx.lang', lang);
  }, [theme, lang]);

  return (
    <LangProvider lang={lang}>
      <Shell
        theme={theme}
        onTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        onLang={() => setLang((l) => (l === 'th' ? 'en' : 'th'))}
      />
    </LangProvider>
  );
}

function Shell({ theme, onTheme, onLang }: { theme: Theme; onTheme: () => void; onLang: () => void }) {
  const { t } = useT();
  const route = useRoute();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .meta()
      .then((m) => {
        setMeta(m);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(load, [load]);
  // poll while the first run is computing, then refresh every 15 min for new runs
  useEffect(() => {
    const id = window.setInterval(load, meta?.run ? 15 * 60_000 : 8_000);
    return () => window.clearInterval(id);
  }, [load, meta?.run]);

  const run = meta?.run ?? null;
  const { data: alerts } = useAsync(run ? `alerts:${run.run_id}` : null, () => api.alerts(1));
  const today = run?.days[0]?.date;
  const alertCount = alerts?.alerts.filter((a) => a.date === today && a.alerts.some((x) => x.severity >= 2)).length ?? 0;

  const upstreamNote = run?.notes.find((n) => n.startsWith('Upstream'));

  return (
    <div className="app">
      <Header route={route} theme={theme} onTheme={onTheme} onLang={onLang} alertCount={alertCount} />
      <div>
        {run?.demo && (
          <div className="banner banner--demo" role="note">
            <Icon name="info" /> {t('demoBanner')}
            {upstreamNote && <span className="subtle"> · {upstreamNote}</span>}
          </div>
        )}
      </div>
      {!meta || !run ? (
        <main className="page">
          <div className="empty" style={{ minHeight: '60vh' }}>
            {error ? (
              <>
                <Icon name="alert" width={32} />
                <p>{error}</p>
                <button className="btn" type="button" onClick={load}>
                  {t('retry')}
                </button>
              </>
            ) : (
              <>
                <span className="spinner" />
                <p>{meta ? t('warming') : t('loading')}</p>
              </>
            )}
          </div>
        </main>
      ) : (
        <main style={{ minHeight: 0, display: 'grid' }}>
          {route.page === 'map' && <MapPage key={run.run_id} meta={meta} run={run} theme={theme} />}
          {route.page === 'provinces' && <ProvincesPage meta={meta} run={run} selectedId={route.param} />}
          {route.page === 'alerts' && <AlertsPage run={run} />}
          {route.page === 'method' && <MethodPage run={run} />}
          {route.page === 'design' && <DesignSystemPage theme={theme} />}
        </main>
      )}
      <BottomNav route={route} alertCount={alertCount} />
    </div>
  );
}

const NAV: { page: Route['page']; icon: IconName; key: 'navMap' | 'navProvinces' | 'navAlerts' | 'navMethod' | 'navDesign' }[] = [
  { page: 'map', icon: 'map', key: 'navMap' },
  { page: 'provinces', icon: 'list', key: 'navProvinces' },
  { page: 'alerts', icon: 'alert', key: 'navAlerts' },
  { page: 'method', icon: 'book', key: 'navMethod' },
  { page: 'design', icon: 'palette', key: 'navDesign' },
];

function Header({
  route,
  theme,
  onTheme,
  onLang,
  alertCount,
}: {
  route: Route;
  theme: Theme;
  onTheme: () => void;
  onLang: () => void;
  alertCount: number;
}) {
  const { t } = useT();
  return (
    <header className="header">
      <a className="brand" href={href('map')}>
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
      </a>
      <nav className="nav" aria-label="main">
        {NAV.map((n) => (
          <a key={n.page} href={href(n.page)} aria-current={route.page === n.page ? 'page' : undefined}>
            {t(n.key)}
            {n.page === 'alerts' && alertCount > 0 && <span className="count">{alertCount}</span>}
          </a>
        ))}
      </nav>
      <div className="header-actions">
        <button type="button" className="icon-btn" onClick={onLang} aria-label="Language">
          {t('language') === 'English' ? 'EN' : 'TH'}
        </button>
        <button type="button" className="icon-btn" onClick={onTheme} aria-label={t('theme')}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
      </div>
    </header>
  );
}

function BottomNav({ route, alertCount }: { route: Route; alertCount: number }) {
  const { t } = useT();
  return (
    <nav className="bottom-nav" aria-label="main">
      {NAV.slice(0, 4).map((n) => (
        <a key={n.page} href={href(n.page)} aria-current={route.page === n.page ? 'page' : undefined}>
          <Icon name={n.icon} />
          {t(n.key)}
          {n.page === 'alerts' && alertCount > 0 && <span className="count">{alertCount}</span>}
        </a>
      ))}
    </nav>
  );
}
