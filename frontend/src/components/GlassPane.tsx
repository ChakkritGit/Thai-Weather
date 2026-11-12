'use client';

import type { CSSProperties } from 'react';
import { Glass } from 'glisse';

// inline: Glisse adds its own stylesheet at run time, after ours, and its .lg-glass is position: relative
const placed: CSSProperties = { position: 'absolute', inset: 0, zIndex: -1, borderRadius: 'inherit', pointerEvents: 'none' };

/**
 * Liquid Glass under a floating surface, as the host's first child: Chromium bends the live map at the rim, Safari and
 * Firefox keep the blur and the rim light. The host needs position, `isolation: isolate` and no backdrop-filter (base.css).
 */
export function GlassPane() {
  return <Glass aria-hidden style={placed} />;
}
