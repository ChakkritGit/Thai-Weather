import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { Meta, ProvinceDetail, ProvinceWithDays } from '@/lib/api';
import { forecastSentence } from '@/lib/forecastText';
import { findProvince, paths } from '@/lib/paths';
import { fromApi, getPrefs } from '@/lib/server';
import { Warming } from '@/components/Shell';
import { ProvinceView } from '@/views/ProvinceView';

type Params = { params: Promise<{ slug: string }> };

async function load(slug: string) {
  const list = await fromApi<{ provinces: ProvinceWithDays[] }>('/api/v1/provinces', 300);
  if (!list) return { status: 'down' as const };
  const p = findProvince(list.provinces, slug);
  if (!p) return { status: 'missing' as const };
  return { status: 'ok' as const, province: p };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const res = await load(slug);
  if (res.status !== 'ok') return { title: 'พยากรณ์อากาศรายจังหวัด' };
  const p = res.province;
  const { lang } = await getPrefs();
  const day = p.days.find((d) => d.hours >= 12) ?? p.days[0];
  const title = lang === 'th' ? `พยากรณ์อากาศ${p.name_th} ความละเอียด 2 กม.` : `${p.name_en} weather forecast (2 km)`;
  const description = day ? forecastSentence(day, lang) : undefined;
  return {
    title,
    description,
    alternates: { canonical: paths.province(p) },
    openGraph: { title, description, url: paths.province(p) },
  };
}

export default async function ProvinceRoute({ params }: Params) {
  const { slug } = await params;
  const res = await load(slug);
  if (res.status === 'missing') notFound();
  if (res.status === 'down') return <Warming reachable={false} />;
  const [data, meta] = await Promise.all([
    fromApi<ProvinceDetail>(`/api/v1/provinces/${res.province.id}`, 300),
    fromApi<Meta>('/api/v1/meta', 300),
  ]);
  if (!data) return <Warming reachable={false} />;
  const { lang } = await getPrefs();
  const region = meta?.regions.find((r) => r.id === data.region);
  return <ProvinceView data={data} regionName={region ? (lang === 'th' ? region.name_th : region.name_en) : ''} />;
}
