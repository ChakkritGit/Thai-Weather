import type { PointForecast } from '@/lib/api';
import { fmtStep, nearestStep } from '@/lib/format';
import { DEFAULT_CARD, ogImage } from '@/lib/og';
import { thaiPlace } from '@/lib/seo';
import { parsePoint } from '@/lib/push';
import { fromApi } from '@/lib/server';

/** Link preview for a shared map point (/?lat=…&lon=…): the forecast for the next hours at that spot. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const pt = parsePoint(q.get('lat') ?? undefined, q.get('lon') ?? undefined);
  const d = pt ? await fromApi<PointForecast>(`/api/v1/point?lat=${pt.lat.toFixed(4)}&lon=${pt.lon.toFixed(4)}`, 900) : null;
  if (!pt || !d) return ogImage(DEFAULT_CARD, 300);
  const i = nearestStep(d.times);
  const next = (k: keyof PointForecast['fine']) => d.fine[k].slice(i, i + 4);
  const pop = Math.max(...next('pop'));
  const place = d.location.province ? thaiPlace(d.location.province.name_th) : 'จุดที่เลือก';
  return ogImage(
    {
      eyebrow: `พยากรณ์ ณ จุดนี้ · ${fmtStep(d.times[i], 'th')}`,
      title: place,
      subtitle: `${d.location.lat.toFixed(2)}°N ${d.location.lon.toFixed(2)}°E · สูง ${Math.round(d.location.elevation)} ม.`,
      stats: [
        { label: 'อุณหภูมิ', value: `${Math.round(d.fine.temp[i])}°C` },
        { label: 'โอกาสฝน 3 ชม.', value: `${Math.round(pop)}%` },
        { label: 'ดัชนีความร้อน', value: `${Math.round(Math.max(...next('heat')))}°C` },
      ],
    },
    900,
  );
}
