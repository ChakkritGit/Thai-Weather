import type { Metadata } from 'next';
import { pageMeta } from '@/lib/seo';
import type { Meta } from '@/lib/api';
import { fromApi } from '@/lib/server';
import { MethodPage } from '@/views/MethodPage';

export const metadata: Metadata = pageMeta({
  title: 'วิธีการ: ทำไมต้องความละเอียด 2 กม. สำหรับประเทศเขตร้อน',
  description:
    'ปัญหาของโมเดลพยากรณ์โลกกริดราว 25–28 กม. ในประเทศเขตร้อน และวิธีลดย่อส่วน (downscaling) เป็น 2 กม. ด้วยฟิสิกส์ภูมิประเทศ ชายฝั่ง เมือง และฝนพาความร้อน',
  path: '/method',
});

export default async function MethodRoute() {
  const meta = await fromApi<Meta>('/api/v1/meta', 300);
  return <MethodPage run={meta?.run ?? null} />;
}
