'use client';

import type { RunMeta } from '../lib/api';
import { scaleColor, scales } from '../lib/color';
import { useT } from '../i18n';

const STEPS = [
  {
    th: ['รับข้อมูลโมเดลโลก', 'GFS / ECMWF / ICON ผ่าน Open-Meteo ที่ค่าดิบของกริด (~25–28 กม.) ไม่ใช้ค่าที่ปรับแล้ว'],
    en: ['Ingest the global model', 'GFS / ECMWF / ICON via Open-Meteo at raw grid-cell values (~25–28 km)'],
  },
  {
    th: ['ประมาณค่าลงกริด 2 กม.', 'Bilinear interpolation ลงกริด 0.02° (751×421 จุด ≈ 316,000 จุด)'],
    en: ['Interpolate to 2 km', 'Bilinear interpolation onto a 0.02° grid (751×421 ≈ 316,000 cells)'],
  },
  {
    th: ['ปรับอุณหภูมิ/ความชื้นตามฟิสิกส์', 'Lapse rate ตามความสูงจริง · อากาศเย็นสะสมในแอ่ง · ความต่างบก–ทะเล · เกาะความร้อนเมือง · คงค่าความชื้นจำเพาะ'],
    en: ['Physics for temperature & humidity', 'Lapse rate to true height · basin cold pools · land–sea contrast · urban heat island · conserve specific humidity'],
  },
  {
    th: ['ลมตามภูมิประเทศ', 'ลมเร่งบนสันเขา เบี่ยงตามหุบเขา (MicroMet) และแรงเสียดทานบก/ทะเล'],
    en: ['Terrain-aware wind', 'Ridge speed-up and valley diversion (MicroMet) plus land/sea roughness'],
  },
  {
    th: ['ฝนแบบเขตร้อน', 'ฝนภูเขาด้านรับลม/เงาฝน · ลมบก-ลมทะเล · ensemble พายุฝนฟ้าคะนองขนาดเซลล์ 5–20 กม.'],
    en: ['Tropical rainfall', 'Windward orographic rain / rain shadow · sea & land breezes · ensemble of 5–20 km convective cells'],
  },
  {
    th: ['แก้ไขด้วยสถานีตรวจวัด', 'รับค่าจากสถานี (กรมอุตุฯ, สสน., สถานีชุมชน) แล้วกระจายค่าคลาดเคลื่อนตามระยะทาง/ความสูง'],
    en: ['Correct with stations', 'Ingest station observations (TMD, HII, citizen) and spread residuals by distance and height'],
  },
  {
    th: ['ผลิตภัณฑ์', 'ดัชนีความร้อน · โอกาสฝน · ร้อยละพื้นที่ฝนตก · พายุฝนฟ้าคะนอง · สรุปรายจังหวัดและการแจ้งเตือน'],
    en: ['Products', 'Heat index · chance of rain · % area with rain · thunderstorms · province summaries & alerts'],
  },
];

const FALLBACK = { coarse_grid: { resolution_km: 27.8 }, fine_grid: { resolution_km: 2.2 } };

type MethodRun = Pick<RunMeta, 'coarse_grid' | 'fine_grid'> &
  Partial<Pick<RunMeta, 'ensemble_members' | 'observations_used' | 'source' | 'model' | 'demo' | 'issued'>>;

export function MethodPage({ run }: { run: MethodRun | null }) {
  const { lang } = useT();
  const grids = run ?? (FALLBACK as MethodRun);
  const th = lang === 'th';
  const ratio = Math.round((grids.coarse_grid.resolution_km / grids.fine_grid.resolution_km) ** 2);

  return (
    <div className="page">
      <div className="page-inner">
        <header className="page-head">
          <h1>{th ? 'ทำไมต้องความละเอียด 2 กม. สำหรับประเทศเขตร้อน' : 'Why 2 km resolution for the tropics'}</h1>
          <p>
            {th
              ? `โมเดลพยากรณ์ระดับโลกที่ประเทศไทยใช้อยู่มีระยะกริดราว ${grids.coarse_grid.resolution_km} กม. หนึ่งช่องกริดจึงครอบคลุมพื้นที่ ~${Math.round(grids.coarse_grid.resolution_km ** 2)} ตร.กม. — ใหญ่กว่าเมืองทั้งเมือง และใหญ่กว่าพายุฝนฟ้าคะนองเขตร้อนส่วนใหญ่ ระบบนี้ลดย่อส่วน (downscale) ลงเป็น ${grids.fine_grid.resolution_km} กม. ได้รายละเอียดมากขึ้น ${ratio} เท่าต่อพื้นที่`
              : `The global models Thailand relies on have ~${grids.coarse_grid.resolution_km} km grid spacing – one cell covers ~${Math.round(grids.coarse_grid.resolution_km ** 2)} km², bigger than a whole city and bigger than most tropical thunderstorms. This system downscales to ${grids.fine_grid.resolution_km} km: ${ratio}× more detail per area.`}
          </p>
        </header>

        <section className="two-col">
          <GridIllustration coarse km={grids.coarse_grid.resolution_km} />
          <GridIllustration km={grids.fine_grid.resolution_km} />
        </section>

        <section className="card card-pad prose">
          <h2>{th ? 'ปัญหาที่พบในเขตร้อน' : 'What goes wrong in the tropics'}</h2>
          <ul>
            {(th
              ? [
                  'ฝนเขตร้อนเป็นฝนพาความร้อน (convective) เซลล์ฝนกว้าง 5–20 กม. โมเดลโลกจึงเกลี่ยฝนหนักในจุดเดียวให้เป็นฝนเล็กน้อยทั้งช่องกริด — “ฝนตกทั้งจังหวัด แต่ไม่หนักที่ไหนเลย”',
                  'ภูมิประเทศถูกทำให้เรียบ: ดอยอินทนนท์สูง 2,565 ม. แต่ในโมเดลเหลือไม่ถึงครึ่ง อุณหภูมิบนยอดดอยจึงคลาดเคลื่อนได้เกิน 5 °C',
                  'ฝนภูเขาด้านรับลมมรสุมตะวันตกเฉียงใต้ (เช่น ระนอง ตราด) และเงาฝนด้านหลังเขาหายไป',
                  'จังหวัดชายฝั่งถูกผสมกับทะเลในช่องกริดเดียว ลมบก–ลมทะเลและฝนช่วงบ่ายจึงผิดตำแหน่ง',
                  'เกาะความร้อนกรุงเทพฯ (กลางคืนอุ่นกว่าชานเมือง 2–4 °C) ไม่ปรากฏ ทำให้ประเมินดัชนีความร้อนต่ำเกินไป',
                ]
              : [
                  'Tropical rain is convective, in cells 5–20 km wide. A global model smears one heavy cell into light rain over the whole box – “rain everywhere, heavy nowhere”.',
                  'Terrain is flattened: Doi Inthanon is 2,565 m but less than half that in the model, so mountain temperatures can be off by more than 5 °C.',
                  'Windward monsoon rain (Ranong, Trat) and lee-side rain shadows disappear.',
                  'Coastal provinces are blended with the sea, so sea/land breezes and afternoon storms are misplaced.',
                  'Bangkok’s urban heat island (2–4 °C warmer at night) is missing, underestimating heat stress.',
                ]
            ).map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </section>

        <section className="card card-pad" style={{ display: 'grid', gap: 12 }}>
          <h2>{th ? 'ขั้นตอนการประมวลผล' : 'Processing pipeline'}</h2>
          <ol className="pipeline" style={{ margin: 0, padding: 0 }}>
            {STEPS.map((s) => {
              const [title, body] = th ? s.th : s.en;
              return (
                <li key={title}>
                  <b>{title}</b>
                  <span className="muted">{body}</span>
                </li>
              );
            })}
          </ol>
        </section>

        {run && (
          <section className="card card-pad" style={{ display: 'grid', gap: 8 }}>
            <h2>{th ? 'รายละเอียดทางเทคนิคของรอบพยากรณ์ล่าสุด' : 'Technical details of the latest run'}</h2>
            <dl className="kv">
              {run.source && (
                <>
                  <dt>{th ? 'แหล่งข้อมูล' : 'Source'}</dt>
                  <dd>
                    {run.source} · {run.model}
                  </dd>
                </>
              )}
              <dt>{th ? 'ความละเอียดโมเดลโลก' : 'Global-model resolution'}</dt>
              <dd>
                0.25° ≈ {grids.coarse_grid.resolution_km} {th ? 'กม.' : 'km'}
              </dd>
              <dt>{th ? 'ความละเอียดหลังลดย่อส่วน' : 'Downscaled resolution'}</dt>
              <dd>
                {grids.fine_grid.resolution_km} {th ? 'กม.' : 'km'}
              </dd>
              <dt>{th ? 'จำนวนจุดกริด' : 'Grid points'}</dt>
              <dd>{(grids.fine_grid.nx * grids.fine_grid.ny).toLocaleString()}</dd>
              {run.ensemble_members !== undefined && (
                <>
                  <dt>{th ? 'จำนวนสมาชิกชุดพยากรณ์ (ensemble)' : 'Ensemble members'}</dt>
                  <dd>{run.ensemble_members}</dd>
                </>
              )}
              {!!run.observations_used && (
                <>
                  <dt>{th ? 'สถานีตรวจวัดที่ใช้แก้ไขค่า' : 'Stations used for correction'}</dt>
                  <dd>{run.observations_used}</dd>
                </>
              )}
            </dl>
          </section>
        )}

        <section className="two-col">
          <div className="card card-pad prose">
            <h2>{th ? 'ข้อจำกัดที่ควรรู้' : 'Limitations'}</h2>
            <ul>
              {(th
                ? [
                    'นี่คือการลดย่อส่วนเชิงสถิติ–พลวัต (statistical–dynamical) ไม่ใช่โมเดลเชิงตัวเลขเต็มรูปแบบ ไม่สามารถสร้างพายุที่โมเดลโลกไม่มีได้',
                    'ตำแหน่งเซลล์ฝนแต่ละเซลล์เป็นความน่าจะเป็น จึงแสดงเป็น “โอกาสฝน” และ “ร้อยละของพื้นที่”',
                    'ควรรัน WRF 3 กม. (ไฟล์ตั้งค่าอยู่ใน infra/wrf) คู่กันเมื่อมีทรัพยากรคำนวณ แล้วใช้ระบบนี้เป็นตัวลดย่อส่วน/แก้ไขค่าต่อ',
                    'ต้องตรวจสอบ (verify) กับข้อมูลสถานีของกรมอุตุนิยมวิทยาอย่างต่อเนื่องก่อนใช้ในงานเตือนภัยจริง',
                  ]
                : [
                    'This is statistical–dynamical downscaling, not a full NWP model; it cannot create storms the global model lacks.',
                    'Exact convective-cell positions are uncertain, so they are expressed as chance of rain and % of area.',
                    'Run WRF at 3 km (configs in infra/wrf) alongside when compute allows, and feed it through the same pipeline.',
                    'Continuous verification against TMD station data is required before operational warning use.',
                  ]
              ).map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
          <div className="card card-pad prose">
            <h2>{th ? 'แหล่งข้อมูล' : 'Data sources'}</h2>
            <ul>
              <li>Open-Meteo forecast API (GFS, ECMWF IFS, ICON) — CC BY 4.0</li>
              <li>AWS Terrain Tiles (SRTM, GMTED2010, ETOPO1)</li>
              <li>Natural Earth 1:10m boundaries (public domain)</li>
              <li>{th ? 'เกณฑ์ดัชนีความร้อน: กรมอนามัย' : 'Heat-index levels: Thai Department of Health'}</li>
              <li>{th ? 'ศัพท์และเกณฑ์ฝน/อุณหภูมิ: กรมอุตุนิยมวิทยา' : 'Rain/temperature terms: Thai Meteorological Department'}</li>
            </ul>
            <p className="muted" style={{ fontSize: 'var(--font-size-sm)' }}>
              API: <code>/api/v1/meta</code> · <code>/api/v1/point</code> · <code>/api/v1/provinces</code> · <code>/docs</code>
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

/** Schematic: one global-model cell versus the 2 km cells inside it, with convective rain. */
function GridIllustration({ coarse = false, km }: { coarse?: boolean; km: number }) {
  const { lang } = useT();
  const n = 10;
  const size = 220;
  const cell = size / n;
  // two convective cells inside one coarse box
  const rain = (x: number, y: number) =>
    Math.max(0, 60 * Math.exp(-((x - 3) ** 2 + (y - 6) ** 2) / 3) + 35 * Math.exp(-((x - 7.5) ** 2 + (y - 2.5) ** 2) / 2));
  const mean = Array.from({ length: n * n }, (_, k) => rain(k % n, Math.floor(k / n))).reduce((a, b) => a + b, 0) / (n * n);
  const color = (v: number) => {
    const [r, g, b, a] = scaleColor(scales.rainRate, v);
    return a < 20 ? 'transparent' : `rgba(${r},${g},${b},${(a / 255).toFixed(2)})`;
  };
  return (
    <figure className="card card-pad" style={{ margin: 0, display: 'grid', gap: 8, justifyItems: 'center' }}>
      <svg viewBox={`0 0 ${size} ${size}`} width="100%" style={{ maxWidth: 260 }} role="img" aria-label={`${km} km`}>
        <rect width={size} height={size} fill="var(--color-map-land)" stroke="var(--color-border-strong)" />
        {coarse ? (
          <rect width={size} height={size} fill={color(mean)} opacity={0.85} />
        ) : (
          Array.from({ length: n * n }, (_, k) => {
            const x = k % n;
            const y = Math.floor(k / n);
            return <rect key={k} x={x * cell} y={y * cell} width={cell} height={cell} fill={color(rain(x, y))} opacity={0.9} stroke="var(--color-bg-surface)" strokeWidth={0.5} />;
          })
        )}
      </svg>
      <figcaption style={{ textAlign: 'center', fontSize: 'var(--font-size-sm)' }}>
        <b>{coarse ? (lang === 'th' ? `โมเดลโลก ~${Math.round(km)} กม.: 1 ช่อง` : `Global model ~${Math.round(km)} km: 1 cell`) : lang === 'th' ? 'ฟ้าละเอียด 2 กม.: 100 ช่อง' : 'Downscaled 2 km: 100 cells'}</b>
        <div className="muted">
          {coarse
            ? lang === 'th'
              ? `ฝนเฉลี่ย ${mean.toFixed(1)} มม./ชม. ทั่วทั้งช่อง`
              : `${mean.toFixed(1)} mm/h spread over the whole cell`
            : lang === 'th'
              ? 'เห็นเซลล์ฝนหนัก 2 จุด และพื้นที่ที่ไม่มีฝน'
              : 'Two heavy cells – and the dry area between them'}
        </div>
      </figcaption>
    </figure>
  );
}
