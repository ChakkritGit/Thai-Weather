import {
  hazardLevelText,
  alertValueText,
  maxSeverity,
  tierInfo,
} from "@/lib/alertText";
import {
  bangkokTime,
  machineData,
  textResponse,
  thaiDay,
  xml,
} from "./machineText";
import { paths } from "@/lib/paths";
import { thaiPlace } from "@/lib/seo";

// SITE_URL is a runtime setting: render per request (the API answers are cached for 10 min)

/**
 * RSS 2.0: one item per province and day with an orange or red alert (yellow ones too with ?all=1),
 * plus one summary item per forecast run. GUIDs are stable while an alert stays the same, so readers
 * do not repeat it every run.
 */
export async function feedResponse(req: Request) {
  const all = new URL(req.url).searchParams.get("all") === "1";
  const { base, meta, alerts } = await machineData();
  const run = meta?.run;
  const built = new Date(run?.created ?? Date.now()).toUTCString();
  const shown = alerts.filter((a) => maxSeverity(a.alerts) >= (all ? 1 : 2));

  const items = shown.map((a) => {
    const sev = maxSeverity(a.alerts);
    const tier = tierInfo(sev, "th");
    const link = `${base}${paths.province(a.province)}`;
    const what = a.alerts.map((x) => hazardLevelText(x, "th")).join(" · ");
    const detail = a.alerts
      .map((x) => `${hazardLevelText(x, "th")} (${alertValueText(x, "th")})`)
      .join(", ");
    const guid = `${a.date}-${a.province.id}-${a.alerts
      .map((x) => `${x.hazard}${x.severity}`)
      .sort()
      .join("-")}`;
    return `    <item>
      <title>${xml(`${tier.name}: ${thaiPlace(a.province.name_th)} ${thaiDay(a.date)} – ${what}`)}</title>
      <link>${xml(link)}</link>
      <guid isPermaLink="false">${xml(guid)}</guid>
      <pubDate>${built}</pubDate>
      <category>${xml(tier.name)}</category>
      <description>${xml(`${tier.advice}. ${detail}${a.partial ? ` (ข้อมูลถึง ${a.until} น.)` : ""} · ${a.province.name_en}`)}</description>
    </item>`;
  });

  if (run) {
    const red = alerts.filter((a) => maxSeverity(a.alerts) === 3).length;
    const orange = alerts.filter((a) => maxSeverity(a.alerts) === 2).length;
    const yellow = alerts.filter((a) => maxSeverity(a.alerts) === 1).length;
    items.unshift(`    <item>
      <title>${xml(`พยากรณ์รอบใหม่ ${bangkokTime(run.created)} น.: แดง ${red} · ส้ม ${orange} · เหลือง ${yellow} จังหวัด-วัน`)}</title>
      <link>${base}${paths.alerts}</link>
      <guid isPermaLink="false">${xml(run.run_id)}</guid>
      <pubDate>${built}</pubDate>
      <description>${xml(`พยากรณ์อากาศความละเอียด 2.2 กม. ทั่วประเทศไทย ${run.times.length} ชั่วโมงข้างหน้า (${run.model ?? run.source ?? ""})`)}</description>
    </item>`);
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>ฟ้าละเอียด · แจ้งเตือนสภาพอากาศรายจังหวัด</title>
    <link>${base}${paths.alerts}</link>
    <atom:link href="${base}/feed.xml${all ? "?all=1" : ""}" rel="self" type="application/rss+xml" />
    <description>การแจ้งเตือนฝนหนัก พายุ ลมแรง ความร้อน และอากาศหนาวรายจังหวัด จากพยากรณ์ความละเอียด 2.2 กม. อัปเดตทุก 6 ชั่วโมง (ไม่ใช่ประกาศทางการของกรมอุตุนิยมวิทยา)</description>
    <language>th</language>
    <lastBuildDate>${built}</lastBuildDate>
    <ttl>60</ttl>
    <image><url>${base}/app-icons/icon-192.png</url><title>ฟ้าละเอียด</title><link>${base}${paths.alerts}</link></image>
${items.join("\n")}
  </channel>
</rss>
`;
  return textResponse(body, "application/rss+xml");
}
