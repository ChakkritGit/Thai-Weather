import type { MetadataRoute } from "next";
import type { Meta, ProvinceWithDays } from "@/lib/api";
import { paths } from "@/lib/paths";
import { fromApi, siteUrl } from "@/lib/server";

// SITE_URL is a runtime setting (unset while the Docker image builds): render per request, not at build time
export const dynamic = "force-dynamic";

/** Last edit of the method and API docs pages (bump when they change). */
const DOCS_UPDATED = new Date("2026-10-16");

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  // forecast pages change when a new run is made (every 6 h), not on every request
  const meta = await fromApi<Meta>("/api/v1/meta", 600);
  const updated = meta?.run?.created ? new Date(meta.run.created) : new Date();
  const forecast = [paths.map, paths.provinces, paths.alerts].map((p, i) => ({
    url: `${base}${p}`,
    lastModified: updated,
    changeFrequency: "hourly" as const,
    priority: i === 0 ? 1 : 0.9,
  }));
  const docs = [paths.method, paths.developers].map((p) => ({
    url: `${base}${p}`,
    lastModified: DOCS_UPDATED,
    changeFrequency: "monthly" as const,
    priority: 0.6,
  }));
  const data = await fromApi<{ provinces: ProvinceWithDays[] }>(
    "/api/v1/provinces",
    3600,
  );
  const provinces = (data?.provinces ?? []).map((p) => ({
    url: `${base}${paths.province(p)}`,
    lastModified: updated,
    changeFrequency: "hourly" as const,
    priority: 0.8,
  }));
  return [...forecast, ...provinces, ...docs];
}
