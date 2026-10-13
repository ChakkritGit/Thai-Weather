import type { MetadataRoute } from 'next';
import { ICON_VERSION } from '@/lib/iconGlyph';

/** Web app manifest (served at /manifest.webmanifest, linked automatically by Next). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'ฟ้าละเอียด · Thai Weather HD',
    short_name: 'ฟ้าละเอียด',
    description: 'พยากรณ์อากาศความละเอียด 2 กม. ทั่วประเทศไทย พร้อมแจ้งเตือนพายุฝนฟ้าคะนองและฝนหนักจากเรดาร์',
    lang: 'th',
    dir: 'ltr',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f4f7fa', // --color-bg-canvas
    theme_color: '#006ea6', // brand blue, same as the viewport themeColor
    categories: ['weather'],
    icons: [
      { src: `/icons/192?v=${ICON_VERSION}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `/icons/512?v=${ICON_VERSION}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `/icons/maskable-512?v=${ICON_VERSION}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: `/icons/apple-180?v=${ICON_VERSION}`, sizes: '180x180', type: 'image/png', purpose: 'any' },
    ],
  };
}
