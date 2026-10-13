import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/server';

// SITE_URL is a runtime setting (unset while the Docker image builds): render per request, not at build time
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/api/'] }],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
