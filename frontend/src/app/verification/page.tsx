import type { Metadata } from 'next';
import { pageMeta } from '@/lib/seo';
import { fromApi } from '@/lib/server';
import { Warming } from '@/components/Shell';
import { VerificationPage, type VerificationReport } from '@/views/VerificationPage';

export const metadata: Metadata = pageMeta({
  title: 'พยากรณ์แม่นแค่ไหน: ผลตรวจกับสถานีตรวจอากาศ',
  description:
    'เทียบพยากรณ์อากาศความละเอียด 2.2 กม. กับค่าที่สถานีตรวจอากาศวัดได้จริงทุกชั่วโมง: อุณหภูมิคลาดเคลื่อนเท่าไร ดีกว่าโมเดลโลกแค่ไหน โอกาสฝนเชื่อได้แค่ไหน และระบบเรียนรู้อะไรจากสถานี',
  path: '/verification',
});

export default async function VerificationRoute() {
  const report = await fromApi<VerificationReport>('/api/v1/verification', 300);
  if (!report) return <Warming reachable={false} />;
  return <VerificationPage report={report} />;
}
