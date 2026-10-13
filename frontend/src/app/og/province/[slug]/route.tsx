import type { ProvinceWithDays } from '@/lib/api';
import { maxSeverity, tierInfo } from '@/lib/alertText';
import { fmtDay } from '@/lib/format';
import { DEFAULT_CARD, ogImage } from '@/lib/og';
import { thaiPlace } from '@/lib/seo';
import { findProvince } from '@/lib/paths';
import { fromApi } from '@/lib/server';

/** Link preview for a province page: today's numbers from the latest run (falls back to the default card). */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const list = await fromApi<{ provinces: ProvinceWithDays[] }>('/api/v1/provinces', 900);
  const p = list ? findProvince(list.provinces, slug) : undefined;
  const day = p?.days.find((d) => d.hours >= 12) ?? p?.days[0];
  if (!p || !day) return ogImage(DEFAULT_CARD, 300);
  const sev = maxSeverity(day.alerts);
  return ogImage(
    {
      eyebrow: `พยากรณ์อากาศ${fmtDay(day.date, 'th', true)}`,
      title: thaiPlace(p.name_th),
      subtitle: `${p.name_en} · ความละเอียด 2 กม.`,
      stats: [
        { label: 'อุณหภูมิ', value: `${Math.round(day.tmin)}–${Math.round(day.tmax)}°C` },
        { label: 'พื้นที่ฝนตก', value: `${Math.round(day.rain_coverage)}%` },
        { label: 'ดัชนีความร้อน', value: `${Math.round(day.heat_max)}°C` },
      ],
      badge: sev >= 1 ? { sev: sev as 1 | 2 | 3, text: `เตือนภัย${tierInfo(sev as 1 | 2 | 3, 'th').name}` } : undefined,
    },
    1800,
  );
}
