import type { Metadata } from 'next';
import type { AlertEntry, Meta } from '@/lib/api';
import { fromApi } from '@/lib/server';
import { Warming } from '@/components/Shell';
import { AlertsPage } from '@/views/AlertsPage';

export const metadata: Metadata = {
  title: 'การเตือนภัยสภาพอากาศรายจังหวัด',
  description: 'ดัชนีความร้อนระดับอันตราย ฝนหนัก พายุฝนฟ้าคะนอง และลมแรง รายจังหวัด จากการพยากรณ์ความละเอียด 2 กม.',
  alternates: { canonical: '/alerts' },
};

export default async function AlertsRoute() {
  const [meta, data] = await Promise.all([
    fromApi<Meta>('/api/v1/meta', 60),
    fromApi<{ alerts: AlertEntry[] }>('/api/v1/alerts?min_severity=1', 120),
  ]);
  if (!meta?.run || !data) return <Warming reachable={!!meta} />;
  return <AlertsPage run={meta.run} alerts={data.alerts} />;
}
