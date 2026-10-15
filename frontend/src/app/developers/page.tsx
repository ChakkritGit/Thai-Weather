import type { Metadata } from 'next';
import { pageMeta } from '@/lib/seo';
import { DevelopersPage } from '@/views/DevelopersPage';

export const metadata: Metadata = pageMeta({
  title: 'API พยากรณ์อากาศฟรี สำหรับนักพัฒนา',
  description:
    'API JSON ฟรีของพยากรณ์อากาศละเอียด 2.2 กม. ทั่วประเทศไทย: รายจุด รายจังหวัด การเตือน และเรดาร์ ไม่ต้องใช้คีย์ จำกัด 60 ครั้งต่อนาทีต่อ IP',
  path: '/developers',
});

export default function DevelopersRoute() {
  return <DevelopersPage />;
}
