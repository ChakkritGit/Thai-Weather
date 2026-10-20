import { forecastSentence } from "@/lib/forecastText";
import { hazardLevelText, maxSeverity, tierInfo } from "@/lib/alertText";
import {
  bangkokTime,
  machineData,
  textResponse,
  thaiDay,
} from "./machineText";
import { paths } from "@/lib/paths";
import { thaiPlace } from "@/lib/seo";


const CATEGORY_NAMES: Record<string, string> = {
  heatIndex: "Heat index (°C)",
  rainDaily: "Rain in 24 h (mm)",
  rainCoverage: "Rain coverage (% of area)",
  tempMax: "Daily maximum temperature (°C)",
  tempMin: "Daily minimum temperature (°C)",
  thunder: "Thunderstorm chance (%)",
  wind: "Wind (m/s)",
};

/** The long companion of /llms.txt: method, thresholds and the current forecast, as Markdown. */
export async function fullTextResponse() {
  const { base, meta, alerts, provinces } = await machineData(true);
  const run = meta?.run;
  const out: string[] = [];
  out.push(`# ฟ้าละเอียด · Thai Weather HD — full text

> 2.2 km weather forecasts for Thailand. Site: ${base}. API docs: ${base}${paths.developers}. Not an official TMD warning service; for official warnings see the Thai Meteorological Department (tmd.go.th).
${run ? `\nForecast run ${run.run_id}, created ${bangkokTime(run.created)} Bangkok time, ${run.times.length} hourly steps from ${bangkokTime(run.times[0])}.` : ""}

## Method

1. Global model fields (GFS, ECMWF IFS, ICON via Open-Meteo, ~25–28 km) are interpolated to a 2.2 km grid (${meta ? `${meta.fine_grid.ny} × ${meta.fine_grid.nx}` : "751 × 421"} points).
2. Temperature is corrected for the real terrain height (lapse rate), cold-air pooling in valleys, sea/land contrast and Bangkok's urban heat island.
3. Rain uses a ${run?.ensemble_members ?? 8}-member stochastic ensemble of convective cells, so it is given as chance of rain and % of area rather than a single deterministic field.
4. Live station reports (METAR) correct the first hours; a temperature bias learned per station and hour of day from the last 30 days is subtracted from every hour.
5. Chance of rain is recalibrated daily against the rain stations report.
6. Verified every 15 minutes against independent hold-out stations; temperature is off by about 1.5 °C on average.

Limitations: it cannot create storms the global model lacks; exact positions of convective cells are uncertain; mountain stations are scarce.

## Alert thresholds

Severity: 1 = yellow (watch), 2 = orange (warning), 3 = red (danger). Province alerts use province-wide statistics (thunderstorms, rain and wind need ~5 % of the province, not one cell).
`);
  for (const [id, cat] of Object.entries(meta?.scales?.categories ?? {})) {
    const lv = cat.levels.filter((l) => l.severity > 0);
    if (!lv.length) continue;
    const range = (l: (typeof lv)[number]) =>
      l.min !== undefined ? `≥ ${l.min}` : `≤ ${l.max}`;
    out.push(
      `- ${CATEGORY_NAMES[id] ?? id}: ${lv.map((l) => `${l.label_en} / ${l.label_th} ${range(l)} (severity ${l.severity})`).join("; ")}. Source: ${cat.source}`,
    );
  }

  const warn = alerts.filter((a) => maxSeverity(a.alerts) >= 2);
  out.push(`\n## Orange and red alerts\n`);
  out.push(
    warn.length
      ? warn
          .map(
            (a) =>
              `- ${a.date} ${a.province.name_en} (${thaiPlace(a.province.name_th)}): ${tierInfo(maxSeverity(a.alerts), "en").name} — ${a.alerts.map((x) => hazardLevelText(x, "en")).join(", ")}`,
          )
          .join("\n")
      : "- none in this run",
  );

  out.push(
    `\n## Forecast by province\n\nOne line per province for each forecast day (Bangkok dates). Province pages: ${base}/provinces/<name>, e.g. ${base}${paths.province({ name_en: "Chiang Mai" })}.\n`,
  );
  for (const p of provinces) {
    out.push(`### ${p.name_en} — ${thaiPlace(p.name_th)} (${p.id})\n`);
    for (const d of p.days) {
      out.push(
        `- ${d.date} (${thaiDay(d.date)}): ${forecastSentence(d, "en")} / ${forecastSentence(d, "th")}`,
      );
    }
    out.push("");
  }

  out.push(`## API

No key; 60 requests/min and 5,000/day per IP; JSON; CORS enabled. Base URL ${base}/api/v1. Endpoints: /point?lat=&lon= (hourly 2.2 km forecast), /provinces, /provinces/{id}, /alerts?min_severity=1..3, /nowcast?lat=&lon=, /meta. Schema: ${base}/api/v1/openapi.json. Free for non-commercial use with attribution "Thai Weather HD · Open-Meteo (CC BY 4.0)".
`);
  return textResponse(out.join("\n"), "text/plain");
}
