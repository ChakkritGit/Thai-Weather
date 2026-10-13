import { DEFAULT_CARD, ogImage } from '@/lib/og';

/**
 * Default link preview (site, list pages). Rendered on request – the card shows SITE_URL, which only
 * exists at run time – and cached by browsers / crawlers for a day.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  return ogImage(DEFAULT_CARD, 86400);
}
