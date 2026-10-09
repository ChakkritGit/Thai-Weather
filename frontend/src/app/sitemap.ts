import type { MetadataRoute } from 'next';
import type { ProvinceWithDays } from '@/lib/api';
import { paths } from '@/lib/paths';
import { fromApi, siteUrl } from '@/lib/server';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const now = new Date();
  const fixed = [paths.map, paths.provinces, paths.alerts, paths.method].map((p) => ({
    url: `${base}${p}`,
    lastModified: now,
    changeFrequency: 'hourly' as const,
  }));
  const data = await fromApi<{ provinces: ProvinceWithDays[] }>('/api/v1/provinces', 3600);
  const provinces = (data?.provinces ?? []).map((p) => ({
    url: `${base}${paths.province(p)}`,
    lastModified: now,
    changeFrequency: 'hourly' as const,
  }));
  return [...fixed, ...provinces];
}
