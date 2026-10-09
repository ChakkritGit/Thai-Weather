import type { ProvinceInfo } from './api';

/** URL slug for a province, e.g. "Chiang Mai" → "chiang-mai". */
export const provinceSlug = (p: Pick<ProvinceInfo, 'name_en'>) =>
  p.name_en
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export function findProvince<T extends Pick<ProvinceInfo, 'id' | 'name_en'>>(list: T[], slug: string): T | undefined {
  const s = decodeURIComponent(slug).toLowerCase();
  return list.find((p) => provinceSlug(p) === s || p.id.toLowerCase() === s);
}

export const paths = {
  map: '/',
  mapAt: (lat: number, lon: number) => `/?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`,
  provinces: '/provinces',
  province: (p: Pick<ProvinceInfo, 'name_en'>) => `/provinces/${provinceSlug(p)}`,
  alerts: '/alerts',
  method: '/method',
  design: '/design',
};
