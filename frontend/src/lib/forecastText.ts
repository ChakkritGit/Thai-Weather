import type { DaySummary } from './api';
import { categorise } from './color';
import type { Lang } from '../i18n';

/**
 * Generate a short forecast sentence in the style of TMD public forecasts,
 * e.g. "มีฝนฟ้าคะนองร้อยละ 40 ของพื้นที่ … อุณหภูมิต่ำสุด 24–25 องศาเซลเซียส".
 * The area percentage is something only the 2 km ensemble can provide.
 */
export function forecastSentence(d: DaySummary, lang: Lang): string {
  const parts: string[] = [];
  const cov = Math.round(d.rain_coverage / 10) * 10;
  const cat = categorise('rainCoverage', d.rain_coverage);
  const thunder = d.storm_max >= 40;
  const amount = categorise('rainDaily', d.rain_p95);
  const heavy = amount && amount.severity >= 1;
  const lo = Math.round(d.tmin);
  const hi = Math.round(d.tmax);

  if (lang === 'th') {
    if (cat) {
      parts.push(`${thunder ? 'มีฝนฟ้าคะนอง' : 'มีฝน'}ร้อยละ ${cov} ของพื้นที่ (${cat.label_th})`);
      if (heavy) parts.push(`และมี${amount!.label_th}บางแห่ง`);
    } else {
      parts.push(d.heat_max >= 41 ? 'อากาศร้อนอบอ้าว' : 'ท้องฟ้ามีเมฆบางส่วน ฝนน้อย');
    }
    parts.push(`อุณหภูมิต่ำสุด ${lo - 1}–${lo} องศาเซลเซียส สูงสุด ${hi}–${hi + 1} องศาเซลเซียส`);
    if (d.tmin_low < d.tmin - 4) parts.push(`ยอดดอยต่ำสุด ${Math.round(d.tmin_low)} องศาเซลเซียส`);
    if (d.heat_max >= 32) {
      const h = categorise('heatIndex', d.heat_max);
      parts.push(`ดัชนีความร้อนสูงสุด ${Math.round(d.heat_max)} °C (ระดับ${h?.label_th ?? ''})`);
    }
    return parts.join(' ');
  }
  if (cat) {
    parts.push(`${thunder ? 'Thunderstorms' : 'Rain'} over ${cov}% of the area (${cat.label_en.toLowerCase()})`);
    if (heavy) parts.push(`with ${amount!.label_en.toLowerCase()} in places.`);
    else parts[parts.length - 1] += '.';
  } else {
    parts.push(d.heat_max >= 41 ? 'Hot and humid.' : 'Partly cloudy, little rain.');
  }
  parts.push(`Low ${lo - 1}–${lo} °C, high ${hi}–${hi + 1} °C.`);
  if (d.tmin_low < d.tmin - 4) parts.push(`Mountain tops down to ${Math.round(d.tmin_low)} °C.`);
  if (d.heat_max >= 32) parts.push(`Heat index up to ${Math.round(d.heat_max)} °C.`);
  return parts.join(' ');
}
