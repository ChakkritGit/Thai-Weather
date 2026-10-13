import { DEFAULT_CARD, ogImage } from '@/lib/og';

/** Default link preview (site, list pages). Rendered once at build time. */
export const dynamic = 'force-static';

export async function GET() {
  return ogImage(DEFAULT_CARD);
}
