import type { Metadata } from 'next';

export const SITE_NAME = 'ฟ้าละเอียด · Thai Weather HD';

/** `<link rel="alternate">` to the alerts feed; every page's `alternates` replaces the layout's, so each carries it. */
export const FEED_ALTERNATE = { 'application/rss+xml': [{ url: '/feed.xml', title: 'ฟ้าละเอียด · แจ้งเตือนรายจังหวัด' }] };

/**
 * Complete share metadata for one page. A page's `openGraph` replaces the layout's (Next does not
 * merge it), so every page builds the whole set here: title, description, url, image, card type.
 */
export function pageMeta({
  title,
  description,
  path,
  image = '/og',
  imageAlt,
  absoluteTitle = false,
}: {
  title: string;
  description?: string;
  path: string;
  image?: string;
  imageAlt?: string;
  /** use `title` as is instead of the "%s · ฟ้าละเอียด" template */
  absoluteTitle?: boolean;
}): Metadata {
  const images = [{ url: image, width: 1200, height: 630, alt: imageAlt ?? title }];
  return {
    title: absoluteTitle ? { absolute: title } : title,
    description,
    alternates: { canonical: path, types: FEED_ALTERNATE },
    openGraph: { type: 'website', siteName: SITE_NAME, locale: 'th_TH', title, description, url: path, images },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}

/** "จังหวัดเชียงใหม่", but Bangkok is a special administrative area, not a จังหวัด. */
export const thaiPlace = (nameTh: string) => (nameTh === 'กรุงเทพมหานคร' ? nameTh : `จังหวัด${nameTh}`);
