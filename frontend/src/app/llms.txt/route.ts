import { bangkokTime, machineData, textResponse } from "@/lib/machineText";
import { paths } from "@/lib/paths";

export const dynamic = "force-dynamic";

/** https://llmstxt.org — what the site is, where its pages and data are, for language models. */
export async function GET() {
  const { base, meta } = await machineData();
  const run = meta?.run;
  const body = `# ฟ้าละเอียด · Thai Weather HD

> Weather forecasts for all of Thailand at 2.2 km resolution (about 160× more detail per area than the ~28 km global models), downscaled from GFS / ECMWF / ICON with terrain, coastline, urban-heat and convective-rain physics. Hourly for 48 hours, by point, by province (77) and as province alerts. Updated every 6 hours; radar nowcast every 5 minutes. Thai and English. Not an official Thai Meteorological Department (TMD) product.

${run ? `Current forecast run: ${run.run_id}, created ${bangkokTime(run.created)} (Bangkok time).` : ""}
For a location, prefer the JSON API over scraping pages: no key, ${"60"} requests/min and 5,000/day per IP.

## Pages

- [Map / แผนที่](${base}${paths.map}): interactive 2.2 km map of temperature, heat index, rain, chance of rain, storms, wind and radar
- [Provinces / รายจังหวัด](${base}${paths.provinces}): daily forecast for all 77 provinces; each has its own page such as ${base}${paths.province({ name_en: "Chiang Mai" })}
- [Alerts / แจ้งเตือน](${base}${paths.alerts}): heavy rain, thunderstorms, strong wind, heat, cold and frost by province and day
- [Method / วิธีการ](${base}${paths.method}): why 2 km matters in the tropics, the processing pipeline, verification and limitations
- [Accuracy / พยากรณ์แม่นแค่ไหน](${base}${paths.verification}): hourly verification against station reports, and what the forecast learns from them
- [Free API docs / API ฟรี](${base}${paths.developers}): endpoints, limits, examples and terms

## API

- [OpenAPI schema](${base}/api/v1/openapi.json)
- [Point forecast](${base}/api/v1/point?lat=13.75&lon=100.5): hourly temp, heat index, humidity, rain, chance of rain, storms, wind, cloud at one location
- [Province summaries](${base}/api/v1/provinces): daily max/min, rain and alerts for the 77 provinces
- [Alerts](${base}/api/v1/alerts?min_severity=2): orange and red province alerts
- [Radar nowcast](${base}/api/v1/nowcast?lat=13.75&lon=100.5): rain in the next 0–60 minutes and tropical cyclones

## Optional

- [Full text for language models](${base}/llms-full.txt): method, alert thresholds and today's forecast for every province
- [Alerts feed (RSS)](${base}/feed.xml)
- [Sitemap](${base}/sitemap.xml)
`;
  return textResponse(body, "text/plain");
}
