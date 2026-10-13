import { ImageResponse } from 'next/og';
import { IconGlyph } from '@/lib/iconGlyph';
import { SPLASH_BG, SPLASH_SPECS } from '@/lib/splash';

/** iOS launch screens, rendered once at build time: /splash/393x852@3-light etc. (see lib/splash.ts). */
export const dynamic = 'force-static';

export function generateStaticParams() {
  return SPLASH_SPECS.map((s) => ({ spec: s.id }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ spec: string }> }) {
  const id = (await params).spec;
  const spec = SPLASH_SPECS.find((s) => s.id === id);
  if (!spec) return new Response('Not found', { status: 404 });
  const icon = Math.round(Math.min(spec.width, spec.height) * 0.28);
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: SPLASH_BG[spec.theme] }}>
        <IconGlyph size={icon} mode="any" />
      </div>
    ),
    { width: spec.width, height: spec.height },
  );
}
