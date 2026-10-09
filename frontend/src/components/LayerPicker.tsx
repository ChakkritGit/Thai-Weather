import type { LayerId, LayerMeta } from '../lib/api';
import { useT } from '../i18n';
import { Icon, type IconName } from './Icon';

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
  return (
    <div className="map-layers" role="radiogroup" aria-label={t('layers')}>
      {PICKER.filter((p) => available.has(p.id)).map((p) => (
        <button
          key={p.id}
          type="button"
          role="radio"
          aria-checked={value === p.id}
          className="chip"
          onClick={() => onChange(p.id)}
        >
          <Icon name={p.icon} />
          {lang === 'th' ? p.th : p.en}
        </button>
      ))}
    </div>
  );
}
