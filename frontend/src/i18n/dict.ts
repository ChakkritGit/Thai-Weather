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
  compare: { th: 'เทียบ {coarse} กม. ↔ {fine} กม.', en: 'Compare {coarse} km ↔ {fine} km' },
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
  modelElevation: { th: 'ความสูงในโมเดล {km} กม.', en: 'Height in {km} km model' },
  why: { th: 'ทำไมต่างจากโมเดล {km} กม.?', en: 'Why does this differ from the {km} km model?' },
  modelCoarse: { th: 'โมเดล {km} กม.', en: '{km} km model' },
  fineModel: { th: 'ฟ้าละเอียด {km} กม.', en: 'Downscaled {km} km' },
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
  nowcastTitle: { th: 'ฝนใน 1 ชั่วโมงข้างหน้า', en: 'Rain in the next hour' },
  nowcastError: { th: 'โหลดข้อมูลเรดาร์ไม่สำเร็จ', en: 'Could not load radar data' },
  radarAt: { th: 'เรดาร์', en: 'Radar' },
  radarOff: { th: 'เรดาร์ยังไม่พร้อมใช้งาน', en: 'Radar not available' },
  radar: { th: 'เรดาร์', en: 'Radar' },
  cyclones: { th: 'พายุหมุนเขตร้อน', en: 'Tropical cyclones' },
  dataFrom: { th: 'ข้อมูล', en: 'Data' },
  radarEstimate: { th: 'ประเมินจากเรดาร์ เป็นการคาดการณ์ ไม่ใช่คำเตือนทางการ', en: 'Radar-based estimate, not an official warning' },
  skipToContent: { th: 'ข้ามไปยังเนื้อหา', en: 'Skip to content' },
  footerNote: {
    th: 'ข้อมูลประกอบการตัดสินใจ ไม่ใช่ประกาศทางการ — ติดตามประกาศกรมอุตุนิยมวิทยา',
    en: 'Decision-support information, not an official announcement – follow the Thai Meteorological Department.',
  },
  footerSources: {
    th: 'แหล่งข้อมูล: NOAA GFS (ผ่าน Open-Meteo) · RainViewer · GDACS · IEM',
    en: 'Sources: NOAA GFS via Open-Meteo · RainViewer · GDACS · IEM',
  },
  footerUpdated: { th: 'อัปเดตล่าสุด', en: 'Last updated' },
  footerMore: { th: 'เพิ่มเติม', en: 'More' },
  locateCta: { th: 'ดูพยากรณ์ ณ ตำแหน่งของคุณ', en: 'Forecast for your location' },
  locateHint: { th: 'ใช้ตำแหน่งปัจจุบันจากอุปกรณ์', en: 'Uses your device location' },
  locating: { th: 'กำลังหาตำแหน่ง…', en: 'Finding your location…' },
  locateDenied: {
    th: 'เข้าถึงตำแหน่งไม่ได้ อนุญาตสิทธิ์ตำแหน่งในเบราว์เซอร์แล้วลองใหม่',
    en: 'Location access is blocked. Allow it in your browser and try again.',
  },
  locateFailed: { th: 'ระบุตำแหน่งไม่สำเร็จ ลองใหม่อีกครั้ง', en: 'Could not find your location. Please try again.' },
  notFoundTitle: { th: 'ไม่พบหน้านี้', en: 'Page not found' },
  notFoundBody: { th: 'ลิงก์อาจไม่ถูกต้อง หรือหน้านี้ถูกย้ายไปแล้ว', en: 'The link may be wrong, or the page has moved.' },
  backToMap: { th: 'กลับไปที่แผนที่', en: 'Back to the map' },
  errorTitle: { th: 'ขออภัย เกิดข้อผิดพลาดบางอย่าง', en: 'Sorry, something went wrong' },
  errorBody: { th: 'ข้อมูลอาจโหลดไม่ครบ ลองใหม่อีกครั้งในอีกสักครู่', en: 'The data may not have loaded fully. Please try again in a moment.' },
  unreachableTitle: { th: 'ยังเชื่อมต่อเซิร์ฟเวอร์พยากรณ์ไม่ได้', en: 'Cannot reach the forecast server' },
  unreachableBody: {
    th: 'ระบบจะลองเชื่อมต่อใหม่ให้อัตโนมัติ หรือกดลองใหม่ได้เลย',
    en: 'We will keep retrying automatically, or you can retry now.',
  },
  warmingTitle: { th: 'กำลังเตรียมพยากรณ์รอบแรก', en: 'Preparing the first forecast' },
  chartKeys: { th: 'ใช้ปุ่มลูกศรซ้าย–ขวาเพื่อดูค่ารายชั่วโมง', en: 'Use the left and right arrow keys to read hourly values' },
} as const;

export type DictKey = keyof typeof dict;

type Named = { name_th?: string; name_en?: string; label_th?: string; label_en?: string };

/** Translation helpers usable from server and client components alike. */
export function translate(lang: Lang) {
  const t = (k: DictKey, params?: Record<string, string | number>) => {
    const s: string = dict[k][lang];
    return params ? s.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m)) : s;
  };
  const pick = (o: Named) => (lang === 'th' ? (o.name_th ?? o.label_th ?? '') : (o.name_en ?? o.label_en ?? ''));
  return { t, lang, pick };
}

export const isLang = (v: unknown): v is Lang => v === 'th' || v === 'en';
