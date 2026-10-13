import type { Metadata } from 'next';
import { pageMeta } from '@/lib/seo';
import type { AlertEntry, Meta } from '@/lib/api';
import { fromApi } from '@/lib/server';
import { Warming } from '@/components/Shell';
import { PushSettings } from '@/components/PushSettings';
import { parsePoint } from '@/lib/push';
import { AlertsPage } from '@/views/AlertsPage';

export const metadata: Metadata = pageMeta({
  title: 'การเตือนภัยสภาพอากาศรายจังหวัด',
  description:
    'ดัชนีความร้อนระดับอันตราย ฝนหนัก พายุฝนฟ้าคะนอง และลมแรง รายจังหวัด จากการพยากรณ์ความละเอียด 2 กม.',
  path: '/alerts',
});

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function AlertsRoute({ searchParams }: { searchParams: Search }) {
  const [meta, data, q] = await Promise.all([
    fromApi<Meta>('/api/v1/meta', 60),
    fromApi<{ alerts: AlertEntry[] }>('/api/v1/alerts?min_severity=1', 120),
    searchParams,
  ]);
  // a point handed over from the map (/alerts?lat=…&lon=…#notifications)
  const point = parsePoint(q.lat, q.lon);
  if (!meta?.run || !data) {
    // the alert settings do not need a forecast: keep them usable while the first run is computed
    return (
      <>
        <Warming reachable={!!meta} />
        <div className="page">
          <div className="page-inner">
            <PushSettings initial={point} />
          </div>
        </div>
      </>
    );
  }
  return <AlertsPage run={meta.run} alerts={data.alerts} pushPoint={point} />;
}
