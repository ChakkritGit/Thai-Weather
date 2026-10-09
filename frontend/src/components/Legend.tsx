import type { LayerMeta } from '../lib/api';
import { categories, hexToRgb, scales } from '../lib/color';
import { useT } from '../i18n';

const CATEGORY_FOR_SCALE: Record<string, string> = { heatIndex: 'heatIndex' };

/** Legend for the active map layer, generated from the weather-scale tokens. */
export function Legend({ layer }: { layer: LayerMeta }) {
  const { pick, lang } = useT();
  const scale = scales[layer.scale];
  if (!scale) return null;
  const cat = CATEGORY_FOR_SCALE[layer.scale];

  if (scale.mode === 'stepped' && cat) {
    const levels = categories[cat].levels;
    return (
      <div className="legend glass" aria-label={`${pick(layer)} legend`}>
        <div className="legend-title">
          <span>{pick(layer)}</span>
          <span className="muted">{layer.unit}</span>
        </div>
        <div className="legend-steps">
          {levels.map((l, i) => (
            <span key={l.id}>
              <i style={{ background: scale.stops[i]?.color ?? l.color }} />
              {pick(l)} <span className="num muted">{l.min !== undefined ? `≥${l.min}` : `<${(l.max ?? 0) + 0.1}`}</span>
            </span>
          ))}
        </div>
        <div className="subtle" style={{ marginTop: 4 }}>
          {lang === 'th' ? 'เกณฑ์ดัชนีความร้อน กรมอนามัย' : 'Thai Dept. of Health heat-index levels'}
        </div>
      </div>
    );
  }

  const stops = scale.stops;
  const n = stops.length;
  // stops are evenly spaced so non-linear scales (rain) stay readable
  const gradient = `linear-gradient(90deg, ${stops
    .map((s, i) => {
      const [r, g, b] = hexToRgb(s.color);
      return `rgba(${r},${g},${b},${Math.max(s.alpha ?? 1, 0.12)}) ${((i / (n - 1)) * 100).toFixed(1)}%`;
    })
    .join(', ')})`;
  const tickEvery = n > 9 ? 2 : 1;
  return (
    <div className="legend glass" aria-label={`${pick(layer)} legend`}>
      <div className="legend-title">
        <span>{pick(layer)}</span>
        <span className="muted">{layer.unit}</span>
      </div>
      <div className="legend-bar" style={{ background: gradient }} />
      <div className="legend-ticks" aria-hidden="true">
        {stops.map((s, i) =>
          i % tickEvery === 0 || i === n - 1 ? (
            <span key={i} style={{ left: `${(i / (n - 1)) * 100}%` }}>
              {s.value}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}
