import type { Metadata } from 'next';
import { pageMeta } from '@/lib/seo';
import { fromApi } from '@/lib/server';
import { Warming } from '@/components/Shell';
import { MlpPage } from '@/views/MlpPage';
import type { VerificationReport } from '@/views/VerificationPage';

export const metadata: Metadata = pageMeta({
  title: 'โครงข่ายประสาทเทียม (MLP) ฝนและอุณหภูมิ: ผลการเรียนรู้รายวัน',
  description:
    'ติดตามผลการเรียนรู้รายวันของโครงข่ายประสาทเทียม (MLP) สำหรับโอกาสฝนและอุณหภูมิ: ใช้งานอยู่หรือยัง คะแนนเทียบกับวิธีเดิมเป็นอย่างไร และเส้นโค้งการเรียนรู้ของรอบล่าสุด',
  path: '/verification/mlp',
});

export default async function MlpRoute() {
  const report = await fromApi<VerificationReport>('/api/v1/verification', 300);
  if (!report) return <Warming reachable={false} />;
  return <MlpPage report={report} />;
}
