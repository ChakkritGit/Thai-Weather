import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@/design/generated/tokens.css';
import '@/design/base.css';
import '@/design/data.css';
import { BottomNav, Footer, Header, Providers, SkipLink } from '@/components/Shell';
import { Icon } from '@/components/Icon';
import { ServiceWorkerRegister } from '@/components/ServiceWorkerRegister';
import { translate } from '@/i18n/dict';
import type { AlertEntry, Meta } from '@/lib/api';
import { fromApi, getPrefs, siteUrl } from '@/lib/server';
import { SITE_NAME } from '@/lib/seo';
import { SPLASH_SPECS } from '@/lib/splash';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { default: 'ฟ้าละเอียด · พยากรณ์อากาศความละเอียด 2 กม. ทั่วประเทศไทย', template: '%s · ฟ้าละเอียด' },
  description:
    'พยากรณ์อากาศความละเอียด 2 กม. สำหรับประเทศไทย ละเอียดกว่าโมเดลโลก (~25–28 กม.) กว่า 100 เท่า — ฝน โอกาสฝน ดัชนีความร้อน พายุฝนฟ้าคะนอง รายจังหวัด',
  applicationName: 'ฟ้าละเอียด – Thai Weather HD',
  openGraph: { type: 'website', siteName: SITE_NAME, locale: 'th_TH', url: '/', images: [{ url: '/og', width: 1200, height: 630 }] },
  twitter: { card: 'summary_large_image', images: ['/og'] },
  // an explicit `icons` replaces Next's file-based apple-icon, so the touch icon is listed here too
  icons: { icon: '/favicon.svg', apple: [{ url: '/icons/apple-180', sizes: '180x180', type: 'image/png' }] },
  appleWebApp: {
    capable: true,
    title: 'ฟ้าละเอียด',
    statusBarStyle: 'default',
    startupImage: SPLASH_SPECS.map((s) => ({ url: `/splash/${s.id}`, media: s.media })),
  },
  // iOS still reads the legacy tag for standalone launch + startup images
  other: { 'apple-mobile-web-app-capable': 'yes' },
  alternates: { canonical: '/' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#181d25' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { lang, theme } = await getPrefs();
  const { t } = translate(lang);
  const meta = await fromApi<Meta>('/api/v1/meta', 60);
  const run = meta?.run ?? null;
  const alerts = run ? await fromApi<{ alerts: AlertEntry[] }>('/api/v1/alerts?min_severity=1', 120) : null;
  const today = run?.days[0]?.date;
  const alertCount = alerts?.alerts.filter((a) => a.date === today).length ?? 0;
  const upstreamNote = run?.notes.find((n) => n.startsWith('Upstream'));

  return (
    <html lang={lang} data-theme={theme ?? undefined} suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Thai+Looped:wght@500;600&family=IBM+Plex+Sans+Thai:wght@400;500;600;700&display=swap"
        />
      </head>
      <body>
        <ServiceWorkerRegister />
        <Providers lang={lang} theme={theme}>
          <div className="app">
            <SkipLink />
            <Header alertCount={alertCount} />
            <div>
              {run?.demo && (
                <div className="banner banner--demo" role="note">
                  <Icon name="info" /> {t('demoBanner')}
                  {upstreamNote && <span className="subtle"> · {upstreamNote}</span>}
                </div>
              )}
            </div>
            <main className="app-main" id="main">
              {children}
              <Footer updated={run?.created ?? null} />
            </main>
            <BottomNav alertCount={alertCount} />
          </div>
        </Providers>
      </body>
    </html>
  );
}
