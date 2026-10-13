import { ImageResponse } from 'next/og';
import { IconGlyph, type IconMode } from '@/lib/iconGlyph';

/** PWA / notification icons, rendered once at build time: /icons/192, /icons/512, /icons/maskable-512, /icons/badge-96, /icons/apple-180. */
export const dynamic = 'force-static';

const SPECS: Record<string, { px: number; mode: IconMode }> = {
  // opaque full-bleed: iOS rejects home-screen icons with transparent corners (it masks them itself)
  '192': { px: 192, mode: 'apple' },
  '512': { px: 512, mode: 'apple' },
  'maskable-512': { px: 512, mode: 'maskable' },
  'badge-96': { px: 96, mode: 'badge' },
  // apple-touch-icon: full-bleed, iOS rounds the corners itself
  'apple-180': { px: 180, mode: 'apple' },
};

export function generateStaticParams() {
  return Object.keys(SPECS).map((size) => ({ size }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ size: string }> }) {
  const spec = SPECS[(await params).size];
  if (!spec) return new Response('Not found', { status: 404 });
  return new ImageResponse(<IconGlyph size={spec.px} mode={spec.mode} />, { width: spec.px, height: spec.px });
}
