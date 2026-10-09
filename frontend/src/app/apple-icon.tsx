import { ImageResponse } from 'next/og';
import { IconGlyph } from '@/lib/iconGlyph';

/** apple-touch-icon: Next adds the <link rel="apple-touch-icon"> automatically. */
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(<IconGlyph size={180} mode="apple" />, size);
}
