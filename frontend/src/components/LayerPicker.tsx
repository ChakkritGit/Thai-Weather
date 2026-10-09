'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LayerId, LayerMeta } from '../lib/api';
import { useT } from '../i18n';
import type { IconName } from './Icon';

export const PICKER: { id: LayerId; icon: IconName; th: string; en: string }[] = [
  { id: 'temp', icon: 'thermo', th: 'อุณหภูมิ', en: 'Temperature' },
  { id: 'heat', icon: 'heat', th: 'ดัชนีความร้อน', en: 'Heat index' },
  { id: 'rain', icon: 'drop', th: 'ฝน', en: 'Rain' },
  { id: 'pop', icon: 'drop', th: 'โอกาสฝน', en: 'Rain chance' },
  { id: 'storm', icon: 'bolt', th: 'พายุฝนฟ้าคะนอง', en: 'Thunderstorms' },
  { id: 'rain24', icon: 'drop', th: 'ฝนสะสม 24 ชม.', en: '24 h rain' },
  { id: 'wind', icon: 'wind', th: 'ลม', en: 'Wind' },
  { id: 'rh', icon: 'cloud', th: 'ความชื้น', en: 'Humidity' },
  { id: 'cloud', icon: 'cloud', th: 'เมฆ', en: 'Cloud' },
];

/**
 * Layer chips in one horizontally scrollable row. Edge fades appear on the side
 * that has more chips, and the active chip is scrolled into view.
 */
export function LayerPicker({
  layers,
  value,
  onChange,
}: {
  layers: LayerMeta[];
  value: LayerId;
  onChange: (id: LayerId) => void;
}) {
  const { lang, t } = useT();
  const available = new Set(layers.map((l) => l.id));
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft > 4;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setFade((f) => (f.start === start && f.end === end ? f : { start, end }));
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  useEffect(() => {
    const active = ref.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [value]);

  return (
    <div
      ref={ref}
      className="map-layers"
      role="radiogroup"
      aria-label={t('layers')}
      data-fade-start={fade.start}
      data-fade-end={fade.end}
      onScroll={measure}
    >
      {PICKER.filter((p) => available.has(p.id)).map((p) => (
        <button key={p.id} type="button" role="radio" aria-checked={value === p.id} className="chip" onClick={() => onChange(p.id)}>
          {lang === 'th' ? p.th : p.en}
        </button>
      ))}
    </div>
  );
}
