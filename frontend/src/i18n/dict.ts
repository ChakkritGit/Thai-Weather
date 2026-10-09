export type Lang = 'th' | 'en';

export const dict = {
  brand: { th: 'ฟ้าละเอียด', en: 'Thai Weather HD' },
  tagline: { th: 'พยากรณ์อากาศความละเอียด 2 กม.', en: '2 km high-resolution forecast' },
  navMap: { th: 'แผนที่', en: 'Map' },
  navProvinces: { th: 'รายจังหวัด', en: 'Provinces' },
  navAlerts: { th: 'เตือนภัย', en: 'Alerts' },
  navMethod: { th: 'วิธีการ', en: 'Method' },
  navDesign: { th: 'Design system', en: 'Design system' },
  demoBanner: {
    th: 'โหมดสาธิต: ข้อมูลโมเดลจำลองจากภูมิอากาศ ไม่ใช่การพยากรณ์จริง',
    en: 'Demo mode: synthetic climatology-driven model data – not a real forecast',
  },
  compare: { th: 'เทียบ 22 กม. ↔ 2 กม.', en: 'Compare 22 km ↔ 2 km' },
  compareLeft: { th: 'โมเดลโลก', en: 'Global model' },
  compareRight: { th: 'ฟ้าละเอียด', en: 'Downscaled' },
  play: { th: 'เล่น', en: 'Play' },
  pause: { th: 'หยุด', en: 'Pause' },
  now: { th: 'ตอนนี้', en: 'Now' },
  loading: { th: 'กำลังโหลด…', en: 'Loading…' },
  warming: {
    th: 'ระบบกำลังคำนวณการพยากรณ์รอบแรก อาจใช้เวลาประมาณ 1 นาที',
    en: 'The first forecast run is being computed – this takes about a minute',
  },
  retry: { th: 'ลองใหม่', en: 'Retry' },
  clickHint: { th: 'แตะบนแผนที่เพื่อดูพยากรณ์รายจุด', en: 'Tap the map for a point forecast' },
  elevation: { th: 'ความสูง', en: 'Elevation' },
  modelElevation: { th: 'ความสูงในโมเดล 22 กม.', en: 'Height in 22 km model' },
  why: { th: 'ทำไมต่างจากโมเดล 22 กม.?', en: 'Why does this differ from the 22 km model?' },
  model22: { th: 'โมเดล 22 กม.', en: '22 km model' },
  fine2: { th: 'ฟ้าละเอียด 2 กม.', en: 'Downscaled 2 km' },
  lapse: { th: 'ความสูงภูมิประเทศ', en: 'Terrain height' },
  valley: { th: 'อากาศเย็นสะสมในหุบเขา', en: 'Valley cold pool' },
  coast: { th: 'ผลจากชายฝั่ง/ทะเล', en: 'Land–sea contrast' },
  urban: { th: 'เกาะความร้อนเมือง', en: 'Urban heat island' },
  temperature: { th: 'อุณหภูมิ', en: 'Temperature' },
  heatIndex: { th: 'ดัชนีความร้อน', en: 'Heat index' },
  rain: { th: 'ฝน', en: 'Rain' },
  chanceOfRain: { th: 'โอกาสฝน', en: 'Chance of rain' },
  wind: { th: 'ลม', en: 'Wind' },
  humidity: { th: 'ความชื้น', en: 'Humidity' },
  thunder: { th: 'พายุฝนฟ้าคะนอง', en: 'Thunderstorms' },
  next48: { th: 'พยากรณ์ 48 ชั่วโมง', en: '48-hour forecast' },
  daily: { th: 'รายวัน', en: 'Daily' },
  hourly: { th: 'รายชั่วโมง', en: 'Hourly' },
  close: { th: 'ปิด', en: 'Close' },
  search: { th: 'ค้นหาจังหวัด', en: 'Search province' },
  allRegions: { th: 'ทุกภาค', en: 'All regions' },
  noAlerts: { th: 'ไม่มีการเตือนภัยในระดับนี้', en: 'No alerts at this level' },
  minSeverity: { th: 'ระดับขั้นต่ำ', en: 'Minimum level' },
  areaRain: { th: 'พื้นที่ฝนตก', en: 'Rain area' },
  maxRain: { th: 'ฝนสูงสุด', en: 'Max rain' },
  tmax: { th: 'สูงสุด', en: 'High' },
  tmin: { th: 'ต่ำสุด', en: 'Low' },
  peaks: { th: 'ยอดดอย', en: 'Peaks' },
  source: { th: 'แหล่งข้อมูล', en: 'Source' },
  issued: { th: 'ออกเมื่อ', en: 'Issued' },
  members: { th: 'สมาชิก ensemble', en: 'Ensemble members' },
  openDetail: { th: 'ดูรายละเอียด', en: 'Details' },
  forecastText: { th: 'คำพยากรณ์', en: 'Forecast' },
  overview: { th: 'ภาพรวมประเทศไทย', en: 'Thailand overview' },
  topAlerts: { th: 'การเตือนภัยสำคัญ', en: 'Key alerts' },
  seeAll: { th: 'ดูทั้งหมด', en: 'See all' },
  layers: { th: 'ชั้นข้อมูล', en: 'Layers' },
  theme: { th: 'สลับธีม', en: 'Toggle theme' },
  language: { th: 'English', en: 'ภาษาไทย' },
  table: { th: 'ตาราง', en: 'Table' },
  chart: { th: 'กราฟ', en: 'Chart' },
  time: { th: 'เวลา', en: 'Time' },
} as const;

export type DictKey = keyof typeof dict;

type Named = { name_th?: string; name_en?: string; label_th?: string; label_en?: string };

/** Translation helpers usable from server and client components alike. */
export function translate(lang: Lang) {
  const t = (k: DictKey) => dict[k][lang];
  const pick = (o: Named) => (lang === 'th' ? (o.name_th ?? o.label_th ?? '') : (o.name_en ?? o.label_en ?? ''));
  return { t, lang, pick };
}

export const isLang = (v: unknown): v is Lang => v === 'th' || v === 'en';
