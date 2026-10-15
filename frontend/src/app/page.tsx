import type { Metadata } from 'next';
import type { Meta, PointForecast } from '@/lib/api';
import { parsePoint } from '@/lib/push';
import { pageMeta, thaiPlace } from '@/lib/seo';
import { fromApi } from '@/lib/server';
import { Warming } from '@/components/Shell';
import { Splash } from '@/components/Splash';
import MapClient from '@/views/MapClient';

type Search = { searchParams: Promise<Record<string, string | undefined>> };

/** A shared map point (/?lat=…&lon=…) gets its own preview: place name, coordinates and a forecast card. */
export async function generateMetadata({ searchParams }: Search): Promise<Metadata> {
  const sp = await searchParams;
  const pt = parsePoint(sp.lat, sp.lon);
  if (!pt) {
    return pageMeta({
      title: 'ฟ้าละเอียด · พยากรณ์อากาศความละเอียด 2 กม. ทั่วประเทศไทย',
      description:
        'พยากรณ์อากาศความละเอียด 2 กม. สำหรับประเทศไทย ละเอียดกว่าโมเดลโลก (~25–28 กม.) กว่า 100 เท่า — ฝน โอกาสฝน ดัชนีความร้อน พายุฝนฟ้าคะนอง รายจังหวัด',
      path: '/',
      absoluteTitle: true,
    });
  }
  const d = await fromApi<PointForecast>(`/api/v1/point?lat=${pt.lat.toFixed(4)}&lon=${pt.lon.toFixed(4)}`, 900);
  const place = d?.location.province ? thaiPlace(d.location.province.name_th) : 'จุดที่เลือก';
  const coords = `${pt.lat.toFixed(2)}°N ${pt.lon.toFixed(2)}°E`;
  const q = `lat=${pt.lat.toFixed(3)}&lon=${pt.lon.toFixed(3)}`;
  const meta = pageMeta({
    title: `พยากรณ์อากาศ ${place} (${coords})`,
    description: `พยากรณ์รายชั่วโมงความละเอียด 2 กม. ณ ${coords}: อุณหภูมิ โอกาสฝน ดัชนีความร้อน และเรดาร์ฝนล่าสุด`,
    path: '/',
    image: `/og/point?${q}`,
  });
  // Next resolves a root og:url to the bare origin (dropping ?lat&lon), which would make Facebook show the
  // home-page preview for every shared point: leave og:url out so crawlers use the shared link itself.
  return { ...meta, openGraph: { ...meta.openGraph, url: undefined } };
}

export default async function MapRoute({ searchParams }: Search) {
  const sp = await searchParams;
  const meta = await fromApi<Meta>('/api/v1/meta', 30);
  if (!meta?.run) return <Warming reachable={!!meta} />;
  const lat = Number(sp.lat);
  const lon = Number(sp.lon);
  const initialPoint = Number.isFinite(lat) && Number.isFinite(lon) && sp.lat && sp.lon ? { lat, lon } : null;
  return (
    <>
      <Splash />
      <MapClient key={meta.run.run_id} meta={meta} run={meta.run} initialPoint={initialPoint} />
    </>
  );
}
