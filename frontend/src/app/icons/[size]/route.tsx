import { ImageResponse } from 'next/og';
import { IconGlyph, type IconMode } from '@/lib/iconGlyph';

/** PWA / notification icons, rendered once at build time: /icons/192, /icons/512, /icons/maskable-512, /icons/badge-96. */
export const dynamic = 'force-static';

const SPECS: Record<string, { px: number; mode: IconMode }> = {
  '192': { px: 192, mode: 'any' },
  '512': { px: 512, mode: 'any' },
  'maskable-512': { px: 512, mode: 'maskable' },
  'badge-96': { px: 96, mode: 'badge' },
};

export function generateStaticParams() {
  return Object.keys(SPECS).map((size) => ({ size }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ size: string }> }) {
  const spec = SPECS[(await params).size];
  if (!spec) return new Response('Not found', { status: 404 });
  return new ImageResponse(<IconGlyph size={spec.px} mode={spec.mode} />, { width: spec.px, height: spec.px });
}
