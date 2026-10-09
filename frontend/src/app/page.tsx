import type { Meta } from '@/lib/api';
import { fromApi } from '@/lib/server';
import { Warming } from '@/components/Shell';
import MapClient from '@/views/MapClient';

export default async function MapRoute({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const meta = await fromApi<Meta>('/api/v1/meta', 30);
  if (!meta?.run) return <Warming reachable={!!meta} />;
  const lat = Number(sp.lat);
  const lon = Number(sp.lon);
  const initialPoint = Number.isFinite(lat) && Number.isFinite(lon) && sp.lat && sp.lon ? { lat, lon } : null;
  return <MapClient key={meta.run.run_id} meta={meta} run={meta.run} initialPoint={initialPoint} />;
}
