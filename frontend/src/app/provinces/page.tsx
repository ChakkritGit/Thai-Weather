import type { Metadata } from 'next';
import type { Meta, ProvinceWithDays } from '@/lib/api';
import { fromApi } from '@/lib/server';
import { Warming } from '@/components/Shell';
import { ProvincesView } from '@/views/ProvincesView';

export const metadata: Metadata = {
  title: 'พยากรณ์อากาศรายจังหวัด 77 จังหวัด',
  description: 'พยากรณ์อากาศ 2 วัน ทุกจังหวัดของประเทศไทย จากกริดความละเอียด 2 กม. — ร้อยละพื้นที่ฝนตก ปริมาณฝน อุณหภูมิ ดัชนีความร้อน และการเตือนภัย',
  alternates: { canonical: '/provinces' },
};

export default async function ProvincesRoute() {
  const [meta, data] = await Promise.all([
    fromApi<Meta>('/api/v1/meta', 60),
    fromApi<{ provinces: ProvinceWithDays[] }>('/api/v1/provinces', 300),
  ]);
  if (!meta?.run || !data) return <Warming reachable={!!meta} />;
  return <ProvincesView meta={meta} run={meta.run} provinces={data.provinces} />;
}
