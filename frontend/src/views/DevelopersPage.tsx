'use client';

import { type ReactNode, useState } from 'react';
import { useT } from '../i18n';

const ORIGIN = 'https://thai-weather.chakkritton.com';
const BASE = `${ORIGIN}/api/v1`;
const PER_MIN = 60;
const PER_DAY = 5000;

type Lang = 'th' | 'en';
type Param = { name: string; req?: boolean; th: string; en: string };
type Endpoint = {
  path: string;
  example: string;
  th: string;
  en: string;
  params?: Param[];
  fields: { name: string; th: string; en: string }[];
};

const LATLON: Param[] = [
  { name: 'lat', req: true, th: 'ละติจูด 5.5–20.5', en: 'latitude 5.5–20.5' },
  { name: 'lon', req: true, th: 'ลองจิจูด 97.3–105.7', en: 'longitude 97.3–105.7' },
];

const ENDPOINTS: Endpoint[] = [
  {
    path: '/forecast',
    example: '/forecast?lat=18.79&lon=98.98',
    th: 'ชุดเดียวจบสำหรับแอปสภาพอากาศ: ตอนนี้, 48 ชั่วโมง, 10 วัน, รหัสสภาพอากาศสำหรับไอคอน, ดวงอาทิตย์ ดวงจันทร์ และ PM2.5',
    en: 'Everything a weather app needs in one call: now, 48 hours, 10 days, condition codes for icons, sun, moon and PM2.5',
    params: LATLON,
    fields: [
      { name: 'current, hourly[]', th: 'temp, feels_like, rh, dew_point, rain, pop, storm, wind, wind_dir, cloud, pressure (hPa), uv_clear_sky, condition', en: 'temp, feels_like, rh, dew_point, rain, pop, storm, wind, wind_dir, cloud, pressure (hPa), uv_clear_sky, condition' },
      { name: 'condition.code', th: 'clear, mostly_clear, partly_cloudy, mostly_cloudy, cloudy, fog, drizzle, rain, heavy_rain, thunderstorm (+ night สำหรับไอคอนกลางคืน)', en: 'clear, mostly_clear, partly_cloudy, mostly_cloudy, cloudy, fog, drizzle, rain, heavy_rain, thunderstorm (+ night for night icons)' },
      { name: 'daily[]', th: 'tmin, tmax, rain_mm, pop_max, uv_clear_sky_max, condition, sunrise, sunset, moon (ข้างขึ้นข้างแรม) — source: "fine" = 2.2 กม. (2 วันแรก), "met" = MET Norway (วันที่ 3–10, ~9 กม., ไม่มี pop_max)', en: 'tmin, tmax, rain_mm, pop_max, uv_clear_sky_max, condition, sunrise, sunset, moon — source: "fine" = 2.2 km (first 2 days), "met" = MET Norway (days 3–10, ~9 km, no pop_max)' },
      { name: 'air', th: 'PM2.5 (µg/m³), AQI และระดับสีของกรมควบคุมมลพิษ จากสถานี Air4Thai ใกล้ที่สุดภายใน 50 กม. (null ถ้าไม่มี)', en: 'PM2.5 (µg/m³), AQI and the PCD colour level from the nearest Air4Thai station within 50 km (null if none)' },
      { name: 'uv_clear_sky', th: 'UV เมื่อฟ้าเปิด (ยังไม่หักเมฆ) จึงเป็นค่าสูงสุดที่เป็นไปได้', en: 'UV for a clear sky (clouds not subtracted), so an upper bound' },
      { name: 'gust, visibility_km', th: 'ค่าประมาณ ไม่ใช่ผลจากแบบจำลองโดยตรง: ลมกระโชก (m/s) = ลมเฉลี่ย × 1.5 + ลมจากพายุฝนฟ้าคะนองตามโอกาสเกิดพายุ · ทัศนวิสัย (กม., สูงสุด 20) จากความแรงฝน ความชื้น/หมอก และ PM2.5 (12 ชม. แรก) · daily[].gust_max ในวันที่มาจาก 2.2 กม.', en: 'Estimates, not direct model output: gust (m/s) = mean wind × 1.5 plus thunderstorm outflow weighted by storm chance · visibility (km, capped at 20) from rain rate, humidity/fog and PM2.5 (first 12 h) · daily[].gust_max on 2.2 km days' },
    ],
  },
  {
    path: '/point',
    example: '/point?lat=18.79&lon=98.98',
    th: 'พยากรณ์รายชั่วโมง 48 ชั่วโมงที่ความละเอียด 2.2 กม. ณ จุดที่ระบุ พร้อมค่าจากโมเดลโลก (~28 กม.) ไว้เทียบ',
    en: 'Hourly 48-hour forecast at 2.2 km for one location, with the raw global model (~28 km) for comparison',
    params: LATLON,
    fields: [
      { name: 'times[]', th: 'เวลา ISO 8601 (UTC) ของแต่ละชั่วโมง', en: 'ISO 8601 times (UTC), one per hour' },
      {
        name: 'fine.{temp, heat, rh, rain, pop, heavy, storm, wind, wind_dir, cloud}',
        th: 'ค่ารายชั่วโมง: อุณหภูมิ °C, ดัชนีความร้อน °C, ความชื้น %, ฝน มม./ชม., โอกาสฝน %, โอกาสฝนหนัก %, โอกาสพายุ %, ลม ม./วินาที, ทิศลม °, เมฆ %',
        en: 'hourly values: temperature °C, heat index °C, humidity %, rain mm/h, chance of rain %, heavy rain %, storm %, wind m/s, wind direction °, cloud %',
      },
      {
        name: 'fine.rain',
        th: 'ปริมาณฝนแบบ probability-matched: ตำแหน่งตามค่าเฉลี่ยของ ensemble แต่ขนาดฝนเหมือนสมาชิกจริง จึงไม่เป็นฝนปรอยกว้าง ๆ — ใช้ fine.pop สำหรับ "โอกาสฝน"',
        en: 'probability-matched rain: placed by the ensemble mean, sized like a real member, so it is not a wide drizzle — use fine.pop for the chance of rain',
      },
      { name: 'coarse.*', th: 'ค่าเดียวกันจากโมเดลโลกก่อนลดย่อส่วน', en: 'the same values from the global model before downscaling' },
      { name: 'daily.{dates, fine_rain}', th: 'ฝนสะสมรายวัน มม. (ตามวันเวลาไทย)', en: 'daily rain total in mm (Bangkok days)' },
      { name: 'location', th: 'จุดกริดที่ใช้ จังหวัด ความสูงจริงและความสูงในโมเดล', en: 'grid cell used, province, real and model elevation' },
    ],
  },
  {
    path: '/provinces',
    example: '/provinces',
    th: 'สรุปรายวันของทั้ง 77 จังหวัด: สูงสุด/ต่ำสุด ฝนเฉลี่ย พื้นที่ฝนตก ระดับฝนตามเกณฑ์กรมอุตุฯ และการเตือน',
    en: 'Daily summary for all 77 provinces: max/min, mean rain, rain coverage, TMD rain level and alerts',
    fields: [
      { name: 'provinces[].id', th: 'รหัสจังหวัด ISO 3166-2 เช่น TH-10 (กรุงเทพฯ), TH-50 (เชียงใหม่)', en: 'ISO 3166-2 code, e.g. TH-10 (Bangkok), TH-50 (Chiang Mai)' },
      {
        name: 'provinces[].days[]',
        th: 'date, tmax, tmin, heat_max, rain_mean, rain_coverage (%), rain_level, alerts[] — partial=true คือวันที่ข้อมูลไม่ครบวัน',
        en: 'date, tmax, tmin, heat_max, rain_mean, rain_coverage (%), rain_level, alerts[] — partial=true means the day is not fully covered',
      },
    ],
  },
  {
    path: '/provinces/{id}',
    example: '/provinces/TH-50',
    th: 'พยากรณ์รายชั่วโมงและรายวันของจังหวัดเดียว (ค่ากลางของทุกช่องกริดในจังหวัด)',
    en: 'Hourly and daily forecast for one province (province-wide statistics over its grid cells)',
    params: [{ name: 'id', req: true, th: 'รหัสจังหวัดจาก /provinces', en: 'province id from /provinces' }],
    fields: [
      { name: 'hourly.{temp, heat, pop, rain, rain_max, storm}', th: 'ค่ารายชั่วโมงตาม times[]', en: 'hourly values aligned with times[]' },
      { name: 'days[]', th: 'เหมือนใน /provinces', en: 'as in /provinces' },
    ],
  },
  {
    path: '/alerts',
    example: '/alerts?min_severity=2',
    th: 'การเตือนรายจังหวัดรายวัน: ฝนหนัก พายุฝนฟ้าคะนอง ลมแรง ร้อนจัด อากาศหนาว และน้ำค้างแข็ง',
    en: 'Province alerts by day: heavy rain, thunderstorms, strong wind, heat, cold and frost',
    params: [
      { name: 'min_severity', th: '1 เฝ้าระวัง (เหลือง), 2 เตือน (ส้ม), 3 อันตราย (แดง) — ค่าเริ่มต้น 1', en: '1 watch (yellow), 2 warning (orange), 3 danger (red) — default 1' },
    ],
    fields: [
      { name: 'alerts[].{date, province, alerts[]}', th: 'แต่ละรายการมี hazard, level, severity, value, label_th, label_en', en: 'each alert has hazard, level, severity, value, label_th, label_en' },
    ],
  },
  {
    path: '/nowcast',
    example: '/nowcast?lat=13.75&lon=100.5',
    th: 'ฝนจากเรดาร์ 0–60 นาทีข้างหน้า ณ จุดที่ระบุ (กำลังจะตก/ตกอยู่/พายุ) และพายุหมุนเขตร้อนที่อยู่ใกล้',
    en: 'Radar rain 0–60 min ahead for a point (arriving / raining / storm) and nearby tropical cyclones',
    params: LATLON,
    fields: [
      { name: 'available, reason', th: 'false เมื่อไม่มีข้อมูลเรดาร์ (reason: no_data, stale, no_coverage)', en: 'false when radar is missing (reason: no_data, stale, no_coverage)' },
      { name: 'now, eta_rain, eta_storm, nearest, motion', th: 'สถานะตอนนี้ เวลาที่ฝน/พายุจะถึง (นาที) กลุ่มฝนที่ใกล้สุด และทิศทางเคลื่อนที่', en: 'current state, minutes until rain/storm, nearest echo and motion' },
      { name: 'cyclones[]', th: 'พายุหมุนจาก GDACS พร้อมระยะห่าง', en: 'cyclones from GDACS with distance' },
    ],
  },
  {
    path: '/meta',
    example: '/meta',
    th: 'ข้อมูลรอบพยากรณ์ปัจจุบัน ชั้นข้อมูลและหน่วย สเกลสี เกณฑ์การเตือน และกริด 2.2 กม.',
    en: 'Current run, layers and units, colour scales, alert thresholds and the 2.2 km grid',
    fields: [
      { name: 'run.{run_id, issued, created, times}', th: 'รอบพยากรณ์ อัปเดตทุก 6 ชั่วโมง', en: 'the forecast run; updated every 6 hours' },
      { name: 'scales', th: 'เกณฑ์ระดับฝน อุณหภูมิ ดัชนีความร้อน และการเตือน', en: 'rain, temperature, heat-index and alert thresholds' },
    ],
  },
  {
    path: '/verification',
    example: '/verification',
    th: 'ผลตรวจความแม่นยำล่าสุด เทียบกับสถานีตรวจอากาศสนามบิน 30 วัน (อัปเดตทุกชั่วโมง) และสถานะสิ่งที่ระบบเรียนรู้ — ชุดเดียวกับหน้า /verification',
    en: 'The latest accuracy report against airport stations over 30 days (hourly) and what the forecast learns — the data behind /verification',
    fields: [
      { name: 'temperature.{overall, by_lead, by_hour, by_station}', th: 'n, bias, mae, rmse ต่อแหล่ง (fine, gfs_raw, openmeteo) °C', en: 'n, bias, mae, rmse per source (fine, gfs_raw, openmeteo), °C' },
      { name: 'rain.by_source', th: 'จับได้ (pod) เตือนเก้อ (far) csi ความถี่ (freq_bias) ของ "ฝนตกหรือไม่" ช่วง 3 ชม.', en: 'pod, far, csi, freq_bias of rain occurrence in 3-hour windows' },
      { name: 'pop.reliability', th: 'โอกาสฝนที่พยากรณ์เทียบกับที่ตกจริง แยกช่วง', en: 'forecast chance of rain vs observed frequency, per bin' },
      { name: 'learning', th: 'การปรับโอกาสฝน การแก้อุณหภูมิรายสถานี และสถานะ MLP', en: 'rain calibration, station temperature bias and the MLP status' },
    ],
  },
];

const SNIPPETS: Record<'curl' | 'js' | 'python', string> = {
  curl: `curl "${BASE}/point?lat=13.75&lon=100.5"`,
  js: `const r = await fetch('${BASE}/point?lat=13.75&lon=100.5');
if (r.status === 429) throw new Error('retry in ' + r.headers.get('Retry-After') + ' s');
const d = await r.json();
console.log(d.times[0], d.fine.temp[0] + ' °C', d.fine.pop[0] + ' %');`,
  python: `import httpx

r = httpx.get("${BASE}/point", params={"lat": 13.75, "lon": 100.5})
r.raise_for_status()
d = r.json()
for t, temp, pop in zip(d["times"], d["fine"]["temp"], d["fine"]["pop"]):
    print(t, temp, "°C", pop, "%")`,
};

export function DevelopersPage() {
  const { lang } = useT();
  const th = lang === 'th';
  const [tab, setTab] = useState<keyof typeof SNIPPETS>('curl');

  return (
    <div className="page">
      <div className="page-inner">
        <header className="page-head">
          <h1>{th ? 'API พยากรณ์อากาศฟรี' : 'Free weather API'}</h1>
          <p>
            {th
              ? 'พยากรณ์อากาศละเอียด 2.2 กม. ทั่วประเทศไทยในรูป JSON ใช้ได้ฟรี ไม่ต้องสมัครหรือใช้คีย์ เรียกจากเว็บเบราว์เซอร์ได้โดยตรง (เปิด CORS) จำกัดจำนวนครั้งต่อ IP เพื่อให้ทุกคนใช้ได้'
              : 'Thailand-wide 2.2 km forecasts as JSON. Free, no sign-up or key, callable straight from the browser (CORS enabled), with per-IP limits so everyone gets a fair share.'}
          </p>
        </header>

        <section className="card card-pad dev-grid">
          <div className="dev-facts">
            <Fact label={th ? 'Base URL' : 'Base URL'} value={<code>{BASE}</code>} />
            <Fact label={th ? 'ต่อนาที' : 'Per minute'} value={`${PER_MIN} ${th ? 'ครั้ง / IP' : 'requests / IP'}`} />
            <Fact label={th ? 'ต่อวัน' : 'Per day'} value={`${PER_DAY.toLocaleString()} ${th ? 'ครั้ง / IP' : 'requests / IP'}`} />
            <Fact label={th ? 'อัปเดต' : 'Updates'} value={th ? 'ทุก 6 ชั่วโมง · เรดาร์ทุก 5 นาที' : 'every 6 h · radar every 5 min'} />
          </div>
        </section>

        <section className="card card-pad" style={{ display: 'grid', gap: 12 }}>
          <h2>{th ? 'เริ่มใช้งาน' : 'Quick start'}</h2>
          <div className="segmented" role="group" aria-label={th ? 'ภาษา' : 'Language'}>
            {(['curl', 'js', 'python'] as const).map((k) => (
              <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>
                {k === 'js' ? 'JavaScript' : k === 'python' ? 'Python' : 'curl'}
              </button>
            ))}
          </div>
          <Code text={SNIPPETS[tab]} lang={lang} />
        </section>

        <section className="card card-pad prose">
          <h2>{th ? 'ขีดจำกัดการใช้งาน' : 'Rate limits'}</h2>
          <ul>
            <li>
              {th
                ? `${PER_MIN} ครั้งต่อนาที (เติมคืนทีละครั้งทุก ${60 / PER_MIN} วินาที) และ ${PER_DAY.toLocaleString()} ครั้งต่อวันต่อ IP นับวันใหม่เวลา 00:00 น. ตามเวลาไทย`
                : `${PER_MIN} per minute (one more every ${60 / PER_MIN} s) and ${PER_DAY.toLocaleString()} per day per IP; the day resets at 00:00 Bangkok time.`}
            </li>
            <li>
              {th ? 'ทุกคำตอบบอกโควตาที่เหลือใน header: ' : 'Every response carries the remaining quota: '}
              <code>X-RateLimit-Limit</code>, <code>X-RateLimit-Remaining</code>, <code>X-RateLimit-Reset</code>, <code>X-RateLimit-Limit-Day</code>,{' '}
              <code>X-RateLimit-Remaining-Day</code>
            </li>
            <li>
              {th ? 'เกินโควตาจะได้ ' : 'Over the limit you get '}
              <code>429 Too Many Requests</code>
              {th ? ' พร้อม ' : ' with '}
              <code>Retry-After</code>
              {th ? ' (วินาที) ให้รอตามนั้นแล้วค่อยเรียกใหม่' : ' (seconds); wait that long before retrying.'}
            </li>
            <li>
              {th
                ? 'พยากรณ์เปลี่ยนทุก 6 ชั่วโมง ควรเก็บแคชไว้ใช้ซ้ำ (ดู run.created ใน /meta) แทนการเรียกซ้ำทุกครั้งที่มีผู้ใช้เปิดหน้า'
                : 'The forecast changes every 6 hours: cache responses (see run.created in /meta) instead of calling once per page view.'}
            </li>
          </ul>
          <Code
            lang={lang}
            text={`HTTP/1.1 429 Too Many Requests
Retry-After: 18
X-RateLimit-Remaining: 0

{"error": "rate_limited", "detail": "Free API limit reached (60/min per IP). Retry after 18 s.", "retry_after": 18}`}
          />
        </section>

        <section style={{ display: 'grid', gap: 12 }}>
          <h2>{th ? 'Endpoints' : 'Endpoints'}</h2>
          {ENDPOINTS.map((e) => (
            <EndpointCard key={e.path} e={e} lang={lang} />
          ))}
        </section>

        <section className="two-col">
          <div className="card card-pad prose">
            <h2>{th ? 'รูปแบบข้อมูล' : 'Data notes'}</h2>
            <ul>
              <li>{th ? 'เวลาทั้งหมดเป็น ISO 8601 แบบ UTC ส่วนวันที่รายวันเป็นวันตามเวลาไทย (UTC+7)' : 'All times are ISO 8601 in UTC; daily dates are Bangkok days (UTC+7).'}</li>
              <li>{th ? 'ค่าเก็บแบบ 8 บิต อุณหภูมิละเอียดราว 0.28 °C ฝนละเอียดขึ้นเมื่อค่าน้อย' : 'Values are stored as 8-bit: temperature to about 0.28 °C; rain is finer at low amounts.'}</li>
              <li>{th ? 'ครอบคลุมเฉพาะกรอบประเทศไทย จุดนอกกรอบได้ 422' : 'Thailand’s bounding box only; points outside return 422.'}</li>
              <li>
                {th ? 'Schema แบบ OpenAPI: ' : 'OpenAPI schema: '}
                <a href="/api/v1/openapi.json">/api/v1/openapi.json</a>
              </li>
            </ul>
          </div>
          <div className="card card-pad prose">
            <h2>{th ? 'เงื่อนไขการใช้' : 'Terms'}</h2>
            <ul>
              <li>
                {th
                  ? 'ใช้ได้ฟรีเพื่อการศึกษา งานส่วนตัว และงานที่ไม่แสวงหากำไร ข้อมูลต้นทางมาจาก Open-Meteo แผนฟรีที่ไม่อนุญาตการใช้เชิงพาณิชย์'
                  : 'Free for education, personal and non-commercial projects: the upstream data comes from Open-Meteo’s free, non-commercial tier.'}
              </li>
              <li>
                {th ? 'ต้องให้เครดิต: ' : 'Attribution required: '}
                <code>Thai Weather HD · Open-Meteo (CC BY 4.0)</code>
                {th ? ' และ RainViewer / GDACS เมื่อใช้ /nowcast · MET Norway (CC BY 4.0) และ Air4Thai กรมควบคุมมลพิษ เมื่อใช้ /forecast' : ', plus RainViewer / GDACS when using /nowcast, and MET Norway (CC BY 4.0) and Air4Thai (Pollution Control Department) when using /forecast'}
              </li>
              <li>
                {th
                  ? 'เป็นพยากรณ์เชิงสถิติ–พลวัต ไม่รับประกันความถูกต้อง และไม่ใช้แทนประกาศเตือนภัยของกรมอุตุนิยมวิทยา'
                  : 'A statistical–dynamical forecast without warranty; it does not replace Thai Meteorological Department warnings.'}
              </li>
              <li>{th ? 'ขีดจำกัดและรูปแบบข้อมูลอาจเปลี่ยนได้ เวอร์ชัน v1 จะเพิ่มฟิลด์ได้แต่ไม่ลบฟิลด์เดิม' : 'Limits may change. v1 may gain fields but will not drop existing ones.'}</li>
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="dev-fact">
      <span className="muted">{label}</span>
      <b>{value}</b>
    </div>
  );
}

function Code({ text, lang }: { text: string; lang: Lang }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="dev-code">
      <pre>
        <code>{text}</code>
      </pre>
      <button
        type="button"
        className="btn btn--ghost dev-copy"
        onClick={() => {
          navigator.clipboard?.writeText(text).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => {},
          );
        }}
      >
        {copied ? (lang === 'th' ? 'คัดลอกแล้ว' : 'Copied') : lang === 'th' ? 'คัดลอก' : 'Copy'}
      </button>
    </div>
  );
}

function EndpointCard({ e, lang }: { e: Endpoint; lang: Lang }) {
  const th = lang === 'th';
  const [state, setState] = useState<{ loading: boolean; body?: string; status?: number }>({ loading: false });

  const tryIt = async () => {
    setState({ loading: true });
    try {
      const r = await fetch(`/api/v1${e.example}`);
      const text = JSON.stringify(await r.json(), null, 2);
      const lines = text.split('\n');
      setState({ loading: false, status: r.status, body: lines.length > 40 ? `${lines.slice(0, 40).join('\n')}\n…` : text });
    } catch {
      setState({ loading: false, status: 0, body: th ? 'เรียกไม่สำเร็จ' : 'Request failed' });
    }
  };

  return (
    <article className="card card-pad dev-endpoint">
      <div className="dev-endpoint-head">
        <span className="badge badge--info">GET</span>
        <code className="dev-path">{e.path}</code>
      </div>
      <p className="muted">{th ? e.th : e.en}</p>
      {e.params && (
        <table className="data-table dev-table">
          <thead>
            <tr>
              <th>{th ? 'พารามิเตอร์' : 'Parameter'}</th>
              <th>{th ? 'คำอธิบาย' : 'Description'}</th>
            </tr>
          </thead>
          <tbody>
            {e.params.map((p) => (
              <tr key={p.name}>
                <td>
                  <code>{p.name}</code>
                  {p.req && <span className="muted"> *</span>}
                </td>
                <td>{th ? p.th : p.en}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ul className="dev-fields">
        {e.fields.map((f) => (
          <li key={f.name}>
            <code>{f.name}</code> <span className="muted">{th ? f.th : f.en}</span>
          </li>
        ))}
      </ul>
      <div className="dev-try">
        <code className="dev-example">GET {e.example}</code>
        <button type="button" className="btn" onClick={tryIt} disabled={state.loading}>
          {state.loading ? (th ? 'กำลังเรียก…' : 'Calling…') : th ? 'ลองเรียก' : 'Try it'}
        </button>
      </div>
      {state.body !== undefined && (
        <div className="dev-code">
          <pre>
            <code>
              {state.status ? `HTTP ${state.status}\n\n` : ''}
              {state.body}
            </code>
          </pre>
        </div>
      )}
    </article>
  );
}
