import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@/design/generated/tokens.css';
import '@/design/base.css';
import '@/design/data.css';
import { BottomNav, Header, Providers } from '@/components/Shell';
import { Icon } from '@/components/Icon';
import { translate } from '@/i18n/dict';
import type { AlertEntry, Meta } from '@/lib/api';
import { fromApi, getPrefs, siteUrl } from '@/lib/server';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { default: 'ฟ้าละเอียด · พยากรณ์อากาศความละเอียด 2 กม. ทั่วประเทศไทย', template: '%s · ฟ้าละเอียด' },
  description:
    'พยากรณ์อากาศความละเอียด 2 กม. สำหรับประเทศไทย ละเอียดกว่าโมเดลโลก (~25–28 กม.) กว่า 100 เท่า — ฝน โอกาสฝน ดัชนีความร้อน พายุฝนฟ้าคะนอง รายจังหวัด',
  applicationName: 'ฟ้าละเอียด – Thai Weather HD',
  openGraph: { type: 'website', siteName: 'ฟ้าละเอียด · Thai Weather HD', locale: 'th_TH', images: ['/og.png'] },
  icons: { icon: '/favicon.svg' },
  alternates: { canonical: '/' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#006ea6',
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
        <Providers lang={lang} theme={theme}>
          <div className="app">
            <Header alertCount={alertCount} />
            <div>
              {run?.demo && (
                <div className="banner banner--demo" role="note">
                  <Icon name="info" /> {t('demoBanner')}
                  {upstreamNote && <span className="subtle"> · {upstreamNote}</span>}
                </div>
              )}
            </div>
            <main className="app-main">{children}</main>
            <BottomNav alertCount={alertCount} />
          </div>
        </Providers>
      </body>
    </html>
  );
}
