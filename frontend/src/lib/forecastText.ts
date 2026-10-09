import type { DaySummary } from './api';
import { categorise } from './color';
import { isPartialDay } from './alertText';
import type { Lang } from '../i18n/dict';

const HEAVY_RAIN = new Set(['heavy', 'veryHeavy', 'extreme']);

/**
 * Generate a short forecast sentence in the style of TMD public forecasts,
 * e.g. "มีฝนฟ้าคะนองร้อยละ 40 ของพื้นที่ … อุณหภูมิต่ำสุด 24–25 องศาเซลเซียส".
 * The area percentage is something only the 2 km ensemble can provide.
 *
 * For a partial day (fewer than 18 forecast hours) the temperature extremes
 * are those of the covered hours only, so they are worded "as far as the data
 * goes" instead of being presented as the daily max/min.
 */
export function forecastSentence(d: DaySummary, lang: Lang): string {
  const parts: string[] = [];
  const partial = isPartialDay(d);
  const cov = Math.round(d.rain_coverage / 10) * 10;
  const cat = categorise('rainCoverage', d.rain_coverage);
  const thunder = d.storm_max >= 40;
  const amount = categorise('rainDaily', d.rain_p95);
  const heavy = !!amount && HEAVY_RAIN.has(amount.id);
  const lo = Math.round(d.tmin);
  const hi = Math.round(d.tmax);

  if (lang === 'th') {
    if (cat) {
      parts.push(`${thunder ? 'มีฝนฟ้าคะนอง' : 'มีฝน'}ร้อยละ ${cov} ของพื้นที่ (${cat.label_th})`);
      if (heavy) parts.push(`และมี${amount!.label_th}บางแห่ง`);
    } else {
      parts.push(d.heat_max >= 41 ? 'อากาศร้อนอบอ้าว' : 'ท้องฟ้ามีเมฆบางส่วน ฝนน้อย');
    }
    if (partial) {
      parts.push(
        `${d.until ? `ข้อมูลถึง ${d.until} น. ` : ''}อุณหภูมิต่ำสุดเท่าที่มีข้อมูล ${lo} องศาเซลเซียส สูงสุดเท่าที่มีข้อมูล ${hi} องศาเซลเซียส`,
      );
    } else {
      parts.push(`อุณหภูมิต่ำสุด ${lo - 1}–${lo} องศาเซลเซียส สูงสุด ${hi}–${hi + 1} องศาเซลเซียส`);
    }
    if (d.tmin_low < d.tmin - 4) parts.push(`ยอดดอยต่ำสุด${partial ? 'เท่าที่มีข้อมูล' : ''} ${Math.round(d.tmin_low)} องศาเซลเซียส`);
    if (d.heat_max >= 32) {
      const h = categorise('heatIndex', d.heat_max);
      parts.push(
        `ดัชนีความร้อนสูงสุด${partial ? 'เท่าที่มีข้อมูล' : ''} ${Math.round(d.heat_max)} °C (เกณฑ์กรมอนามัย: ระดับ${h?.label_th ?? ''})`,
      );
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
  if (partial) {
    parts.push(
      `${d.until ? `Data until ${d.until}. ` : ''}Lowest so far ${lo} °C, highest so far ${hi} °C (not the full-day extremes).`,
    );
  } else {
    parts.push(`Low ${lo - 1}–${lo} °C, high ${hi}–${hi + 1} °C.`);
  }
  if (d.tmin_low < d.tmin - 4) parts.push(`Mountain tops down to ${Math.round(d.tmin_low)} °C.`);
  if (d.heat_max >= 32) {
    const h = categorise('heatIndex', d.heat_max);
    parts.push(
      `Heat index up to ${Math.round(d.heat_max)} °C (Dept. of Health level: ${h?.label_en.toLowerCase() ?? ''}).`,
    );
  }
  return parts.join(' ');
}
