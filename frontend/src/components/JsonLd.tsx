/** schema.org structured data (rendered on the server; a data block, so the CSP does not apply). */
export function JsonLd({ data }: { data: object }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, "\\u003c"),
      }}
    />
  );
}

export const websiteLd = (base: string) => ({
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "ฟ้าละเอียด · Thai Weather HD",
  alternateName: ["ฟ้าละเอียด", "Thai Weather HD"],
  url: `${base}/`,
  inLanguage: ["th", "en"],
  description:
    "พยากรณ์อากาศความละเอียด 2 กม. ทั่วประเทศไทย: ฝน โอกาสฝน ดัชนีความร้อน พายุฝนฟ้าคะนอง และการแจ้งเตือนรายจังหวัด",
});

export const datasetLd = (base: string, updated?: string) => ({
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "Thai Weather HD – 2.2 km weather forecast for Thailand",
  alternateName: "ฟ้าละเอียด – พยากรณ์อากาศความละเอียด 2 กม.",
  description:
    "Hourly 48-hour weather forecasts for all of Thailand on a 2.2 km grid, downscaled from GFS / ECMWF / ICON with terrain, coastline, urban and convective physics: temperature, heat index, humidity, rain, chance of rain, thunderstorms, wind and cloud, plus daily summaries and alerts for the 77 provinces. Updated every 6 hours.",
  url: `${base}/developers`,
  isAccessibleForFree: true,
  license: "https://creativecommons.org/licenses/by-nc/4.0/",
  creditText: "Thai Weather HD · Open-Meteo (CC BY 4.0)",
  creator: {
    "@type": "Organization",
    name: "Thai Weather HD",
    url: `${base}/`,
  },
  keywords: [
    "weather forecast",
    "Thailand",
    "downscaling",
    "พยากรณ์อากาศ",
    "ฝน",
    "ดัชนีความร้อน",
  ],
  ...(updated ? { dateModified: updated } : {}),
  temporalCoverage: "..",
  spatialCoverage: {
    "@type": "Place",
    name: "Thailand",
    geo: { "@type": "GeoShape", box: "5.5 97.3 20.5 105.7" },
  },
  variableMeasured: [
    "air temperature",
    "heat index",
    "relative humidity",
    "precipitation",
    "probability of precipitation",
    "thunderstorm probability",
    "wind speed",
    "wind direction",
    "cloud cover",
  ],
  distribution: [
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${base}/api/v1/provinces`,
    },
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${base}/api/v1/alerts`,
    },
  ],
});
