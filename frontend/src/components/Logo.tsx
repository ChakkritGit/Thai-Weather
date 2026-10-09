import type { SVGProps } from 'react';

/**
 * Brand mark: a sun above a horizon whose lines get finer towards the bottom –
 * "sky" (ฟ้า) resolved in ever finer detail (ละเอียด). Colours come from the
 * `.brand-mark` rules in base.css so it follows the light/dark theme.
 */
export function LogoMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false" {...props}>
      <rect className="tile" width="32" height="32" rx="9" />
      <circle className="glyph" cx="16" cy="12.5" r="5.5" />
      <rect className="glyph" x="6" y="21" width="20" height="2.2" rx="1.1" />
      <rect className="glyph-soft" x="9" y="25" width="14" height="1.6" rx="0.8" />
      <rect className="glyph-soft" x="12" y="28" width="8" height="1.1" rx="0.55" />
    </svg>
  );
}
