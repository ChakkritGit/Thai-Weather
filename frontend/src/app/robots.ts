import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/server';

// SITE_URL is a runtime setting (unset while the Docker image builds): render per request, not at build time
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  return {
    // the API is documented at /developers; crawlers only need its schema, not the data endpoints
    rules: [{ userAgent: '*', allow: ['/', '/api/v1/openapi.json'], disallow: ['/api/'] }],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
