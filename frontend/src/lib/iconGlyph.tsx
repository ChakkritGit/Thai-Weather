/**
 * The app icon (the 3×3 "grid cells" mark of public/favicon.svg), drawn with plain flex boxes so
 * Next's `ImageResponse` (satori) can render it to PNG at build time – no external assets.
 */

export type IconMode =
  /** rounded square, for the manifest "any" icons */
  | 'any'
  /** full-bleed square with the mark inside the maskable safe zone (Android adaptive icons) */
  | 'maskable'
  /** full-bleed square; iOS applies its own corner radius */
  | 'apple'
  /** white mark on transparent: the monochrome status-bar badge of a notification */
  | 'badge';

const BRAND = '#006ea6';

export function IconGlyph({ size, mode }: { size: number; mode: IconMode }) {
  const span = size * (mode === 'maskable' ? 0.4 : mode === 'badge' ? 0.8 : 0.56);
  const cell = (span * 5) / 18;
  const gap = (span * 1.5) / 18;
  const rows = [0, 1, 2];
  return (
    <div
      style={{
        width: size,
        height: size,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap,
        background: mode === 'badge' ? 'transparent' : BRAND,
        borderRadius: mode === 'any' ? size * 0.25 : 0,
      }}
    >
      {rows.map((r) => (
        <div key={r} style={{ display: 'flex', gap }}>
          {rows.map((c) => (
            <div
              key={c}
              style={{
                width: cell,
                height: cell,
                borderRadius: cell * 0.2,
                background: '#ffffff',
                opacity: 1 - 0.25 * Math.abs(r - c),
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
