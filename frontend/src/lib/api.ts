export interface GridDesc {
  lat0: number;
  lat1: number;
  lon0: number;
  lon1: number;
  dlat: number;
  dlon: number;
  ny: number;
  nx: number;
  resolution_km: number;
}

export interface Encoding {
  kind: 'linear' | 'sqrt';
  min: number;
  max: number;
}

export type LayerId =
  | 'temp'
  | 'heat'
  | 'rh'
  | 'rain'
  | 'pop'
  | 'heavy'
  | 'storm'
  | 'wind'
  | 'wind_dir'
  | 'cloud'
  | 'rain24';

export interface LayerMeta {
  id: LayerId;
  unit: string;
  encoding: Encoding;
  name_th: string;
  name_en: string;
  scale: string;
  daily: boolean;
}

export interface RunMeta {
  run_id: string;
  source: string;
  model: string;
  demo: boolean;
  issued: string;
  created: string;
  times: string[];
  days: { date: string; hours: number }[];
  fine_grid: GridDesc;
  coarse_grid: GridDesc;
  ensemble_members: number;
  observations_used: number;
  notes: string[];
  compute_seconds: number;
}

export interface Meta {
  status: { state: string; last_error: string | null; last_success: string | null };
  run: RunMeta | null;
  layers: LayerMeta[];
  regions: { id: string; name_th: string; name_en: string }[];
  fine_grid: GridDesc;
}

export interface Alert {
  hazard: 'heat' | 'rain' | 'storm' | 'wind' | 'hot' | 'cold';
  level: string;
  severity: 1 | 2 | 3;
  value: number;
  label_th: string;
  label_en: string;
}

export interface DaySummary {
  date: string;
  hours: number;
  tmax: number;
  tmin: number;
  tmax_high: number;
  tmin_low: number;
  heat_max: number;
  rain_mean: number;
  rain_p95: number;
  rain_coverage: number;
  storm_max: number;
  wind_max: number;
  rain_coverage_level: string | null;
  rain_level: string | null;
  alerts: Alert[];
}

export interface ProvinceInfo {
  id: string;
  index: number;
  name_th: string;
  name_en: string;
  region: string;
  lat: number;
  lon: number;
  cells: number;
}

export interface ProvinceWithDays extends ProvinceInfo {
  days: DaySummary[];
}

export interface ProvinceDetail extends ProvinceWithDays {
  times: string[];
  hourly: Record<'temp' | 'heat' | 'pop' | 'rain' | 'rain_max' | 'storm', number[]>;
}

export type Series = Record<Exclude<LayerId, 'rain24'>, number[]>;

export interface PointForecast {
  run_id: string;
  demo: boolean;
  location: {
    lat: number;
    lon: number;
    land: boolean;
    province: ProvinceInfo | null;
    elevation: number;
    model_elevation: number;
    coarse_cell: { lat: number; lon: number; size_km: number };
  };
  times: string[];
  fine: Series;
  coarse: Series;
  daily: { dates: string[]; fine_rain: number[]; coarse_rain: number[] };
  temperature_components: Record<'model' | 'lapse' | 'valley' | 'coast' | 'urban', number[]>;
}

export interface AlertEntry {
  date: string;
  province: Pick<ProvinceInfo, 'id' | 'name_th' | 'name_en' | 'region' | 'lat' | 'lon'>;
  alerts: Alert[];
}

export type RainClass = 'none' | 'light' | 'moderate' | 'heavy' | 'thunderstorm' | 'severe';
export type NowcastReason = 'disabled' | 'no_data' | 'stale' | 'no_coverage';

export interface NowcastEta {
  minutes: number;
  minutes_range: [number, number];
  class: RainClass;
  max_dbz: number;
}

export interface NowcastNearest {
  distance_km: number;
  bearing_deg: number;
  class: RainClass;
  max_dbz: number;
  approaching: boolean;
  closing_kmh: number;
}

export interface NowcastCyclone {
  id: string;
  name: string;
  source: string;
  category: 'TD' | 'TS' | 'TY';
  /** category of the forecast peak wind (GDACS); stronger than `category` when the storm is expected to intensify */
  peak_category: 'TD' | 'TS' | 'TY';
  max_wind_kmh: number;
  report_url: string | null;
  position: { lat: number; lon: number };
  distance_now_km: number;
  closest: { time: string; hours: number; distance_km: number };
  in_wind_zone_kmh: number | null;
}

/** Radar-based 0–60 min nowcast plus active tropical cyclones (GET /api/v1/nowcast). */
export interface Nowcast {
  available: boolean;
  reason: NowcastReason | null;
  frame_time: string | null;
  age_min: number | null;
  now: { class: RainClass; max_dbz: number | null } | null;
  eta_rain: NowcastEta | null;
  eta_storm: NowcastEta | null;
  nearest: NowcastNearest | null;
  motion: { speed_kmh: number; heading_deg: number | null } | null;
  cyclones: NowcastCyclone[];
  attribution: { name: string; url: string }[];
}

/** Backend origin for split deployments (e.g. web on Vercel, API elsewhere). Empty = same origin. */
const BASE = (process.env.NEXT_PUBLIC_API_BASE ?? '').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) {
    let detail = r.statusText;
    try {
      detail = (await r.json()).detail ?? detail;
    } catch {
      /* not JSON */
    }
    throw new ApiError(r.status, detail);
  }
  return r.json() as Promise<T>;
}

export interface GridData {
  codes: Uint8Array;
  ny: number;
  nx: number;
}

const gridCache = new Map<string, Promise<GridData>>();
const MAX_CACHE = 160;

async function getGrid(path: string): Promise<GridData> {
  const hit = gridCache.get(path);
  if (hit) return hit;
  const p = (async () => {
    const r = await fetch(`${BASE}${path}`);
    if (!r.ok) throw new ApiError(r.status, r.statusText);
    const buf = await r.arrayBuffer();
    return {
      codes: new Uint8Array(buf),
      ny: Number(r.headers.get('X-Grid-NY')),
      nx: Number(r.headers.get('X-Grid-NX')),
    };
  })();
  gridCache.set(path, p);
  p.catch(() => gridCache.delete(path));
  if (gridCache.size > MAX_CACHE) gridCache.delete(gridCache.keys().next().value as string);
  return p;
}

export interface RadarFrame extends GridData {
  /** ISO time of the radar frame (X-Frame-Time) */
  frameTime: string;
}

/** Latest radar frame advected `lead` minutes ahead; null when the radar is unavailable (404). */
async function getRadar(lead: number): Promise<RadarFrame | null> {
  const r = await fetch(`${BASE}/api/v1/nowcast/layer?lead=${lead}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new ApiError(r.status, r.statusText);
  const buf = await r.arrayBuffer();
  return {
    codes: new Uint8Array(buf),
    ny: Number(r.headers.get('X-Grid-NY')),
    nx: Number(r.headers.get('X-Grid-NX')),
    frameTime: r.headers.get('X-Frame-Time') ?? '',
  };
}

export const api = {
  meta: () => getJson<Meta>('/api/v1/meta'),
  layer: (runId: string, layer: LayerId, index: number, res: 'fine' | 'coarse', daily: boolean) =>
    getGrid(`/api/v1/layers/${layer}?${daily ? 'day' : 'step'}=${index}&res=${res}&run=${encodeURIComponent(runId)}`),
  staticLayer: (name: 'hillshade' | 'thai' | 'elevation') => getGrid(`/api/v1/static/${name}`),
  point: (lat: number, lon: number) =>
    getJson<PointForecast>(`/api/v1/point?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`),
  provinces: () => getJson<{ run_id: string; provinces: ProvinceWithDays[] }>('/api/v1/provinces'),
  province: (id: string) => getJson<ProvinceDetail>(`/api/v1/provinces/${id}`),
  alerts: (minSeverity = 1) =>
    getJson<{ run_id: string; demo: boolean; alerts: AlertEntry[] }>(`/api/v1/alerts?min_severity=${minSeverity}`),
  nowcast: (lat: number, lon: number) => getJson<Nowcast>(`/api/v1/nowcast?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`),
  nowcastLayer: (lead = 0) => getRadar(lead),
  geoUrl: (name: 'provinces' | 'countries') => `${BASE}/api/v1/geo/${name}`,
};
