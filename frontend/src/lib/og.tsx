import { ImageResponse } from 'next/og';
import { IconGlyph } from './iconGlyph';
import { ogText, type OgText } from './ogText';
import { siteUrl } from './server';

/**
 * Link-preview cards (Open Graph / Twitter, 1200×630) drawn with `next/og`.
 * All text is shaped by HarfBuzz in IBM Plex Sans Thai (the site's own face, OFL, public/fonts) – see ogText.ts.
 */
export const OG_SIZE = { width: 1200, height: 630 };

const INK = '#16202c';
const MUTED = '#4c5a6a';
const ACCENT = '#006ea6';
const SEV: Record<1 | 2 | 3, { bg: string; fg: string }> = {
  1: { bg: '#fde68a', fg: '#5c4300' },
  2: { bg: '#ffb27a', fg: '#5a2400' },
  3: { bg: '#dc2626', fg: '#ffffff' },
};

export interface OgStat {
  label: string;
  value: string;
}

export interface OgCard {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  stats?: OgStat[];
  /** alert tier chip, e.g. { sev: 2, text: 'เตือนภัยระดับสีส้ม' } */
  badge?: { sev: 1 | 2 | 3; text: string };
}

const Img = ({ t }: { t: OgText }) => (
  // eslint-disable-next-line @next/next/no-img-element
  <img src={t.src} width={t.width} height={t.height} alt="" />
);

export async function ogImage(card: OgCard, cacheSeconds = 0): Promise<ImageResponse> {
  const host = new URL(siteUrl()).host;
  const W = OG_SIZE.width - 2 * 72;
  const [brand, brandSub, eyebrow, title, subtitle, hostText, badge, stats] = await Promise.all([
    ogText('ฟ้าละเอียด', { size: 36, weight: 700, color: INK }),
    ogText('Thai Weather HD · พยากรณ์ละเอียด 2 กม.', { size: 22, color: MUTED }),
    card.eyebrow ? ogText(card.eyebrow, { size: 28, weight: 700, color: ACCENT, maxWidth: W }) : null,
    ogText(card.title, { size: card.title.length > 28 ? 54 : 68, weight: 700, color: INK, maxWidth: W, maxLines: 2, lineHeight: 1.3 }),
    card.subtitle ? ogText(card.subtitle, { size: 28, color: MUTED, maxWidth: W, maxLines: 2, lineHeight: 1.45 }) : null,
    ogText(host, { size: 22, color: MUTED }),
    card.badge ? ogText(card.badge.text, { size: 26, weight: 700, color: SEV[card.badge.sev].fg }) : null,
    Promise.all(
      (card.stats ?? []).map(async (st) => ({
        label: await ogText(st.label, { size: 22, color: MUTED }),
        value: await ogText(st.value, { size: 44, weight: 700, color: INK }),
      })),
    ),
  ]);
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          padding: '56px 72px',
          background: 'linear-gradient(135deg, #e3f0fa 0%, #f4f7fa 55%, #fdf3e6 100%)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <IconGlyph size={72} mode="any" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Img t={brand} />
            <Img t={brandSub} />
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 40, flexGrow: 1, gap: 6 }}>
          {eyebrow && <Img t={eyebrow} />}
          <Img t={title} />
          {subtitle && <Img t={subtitle} />}
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 24 }}>
          <div style={{ display: 'flex', gap: 16 }}>
            {stats.map((st, i) => (
              <div
                key={i}
                style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '14px 24px', borderRadius: 24, background: 'rgba(255,255,255,0.85)', border: '1px solid #d5dee8' }}
              >
                <Img t={st.label} />
                <Img t={st.value} />
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 12 }}>
            {badge && card.badge && (
              <div style={{ display: 'flex', padding: '8px 22px', borderRadius: 999, background: SEV[card.badge.sev].bg }}>
                <Img t={badge} />
              </div>
            )}
            <Img t={hostText} />
          </div>
        </div>
      </div>
    ),
    {
      ...OG_SIZE,
      headers: cacheSeconds ? { 'Cache-Control': `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}` } : undefined,
    },
  );
}

export const DEFAULT_CARD: OgCard = {
  eyebrow: 'พยากรณ์อากาศทั่วประเทศไทย',
  title: 'ละเอียดถึงระดับ 2 กม. ทุกตารางนิ้วของไทย',
  subtitle: 'ฝน โอกาสฝน ดัชนีความร้อน พายุฝนฟ้าคะนอง เรดาร์ และแจ้งเตือนถึงมือถือ',
  stats: [
    { label: 'ความละเอียด', value: '2 กม.' },
    { label: 'รายจังหวัด', value: '77' },
    { label: 'เรดาร์', value: 'ทุก 10 นาที' },
  ],
};
