import type { Metadata } from "next";
import { pageMeta } from "@/lib/seo";
import type { Meta } from "@/lib/api";
import { fromApi, siteUrl } from "@/lib/server";
import { JsonLd, datasetLd } from "@/components/JsonLd";
import { DevelopersPage } from "@/views/DevelopersPage";

export const metadata: Metadata = pageMeta({
  title: "API พยากรณ์อากาศฟรี สำหรับนักพัฒนา",
  description:
    "API JSON ฟรีของพยากรณ์อากาศละเอียด 2.2 กม. ทั่วประเทศไทย: รายจุด รายจังหวัด การเตือน และเรดาร์ ไม่ต้องใช้คีย์ จำกัด 60 ครั้งต่อนาทีต่อ IP",
  path: "/developers",
});

export default async function DevelopersRoute() {
  const meta = await fromApi<Meta>("/api/v1/meta", 600);
  return (
    <>
      <JsonLd data={datasetLd(siteUrl(), meta?.run?.created)} />
      <DevelopersPage />
    </>
  );
}
