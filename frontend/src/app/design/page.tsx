import type { Metadata } from 'next';
import { pageMeta } from '@/lib/seo';
import { DesignSystemPage } from '@/views/DesignSystemPage';

export const metadata: Metadata = pageMeta({
  title: 'Design system',
  description:
    'Design tokens, weather colour scales and components of ฟ้าละเอียด / Thai Weather HD.',
  path: '/design',
});

export default function DesignRoute() {
  return <DesignSystemPage />;
}
