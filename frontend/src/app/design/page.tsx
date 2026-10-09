import type { Metadata } from 'next';
import { DesignSystemPage } from '@/views/DesignSystemPage';

export const metadata: Metadata = {
  title: 'Design system',
  description: 'Design tokens, weather colour scales and components of ฟ้าละเอียด / Thai Weather HD.',
  alternates: { canonical: '/design' },
};

export default function DesignRoute() {
  return <DesignSystemPage />;
}
