/** Shared bits of the machine-readable routes: /feed.xml, /llms.txt, /llms-full.txt. */
import type { AlertEntry, Meta, ProvinceWithDays } from "./api";
import { fromApi, siteUrl } from "./server";

export const xml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** "พฤหัสบดี 16 ตุลาคม 2569" for a Bangkok calendar date "2026-10-16". */
export function thaiDay(date: string): string {
  return new Date(`${date}T12:00:00+07:00`).toLocaleDateString("th-TH", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Bangkok",
  });
}

export function bangkokTime(iso: string): string {
  return new Date(iso).toLocaleString("th-TH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Bangkok",
  });
}

export async function machineData(withProvinces = false) {
  const [meta, alerts, provinces] = await Promise.all([
    fromApi<Meta & { scales?: Scales }>("/api/v1/meta", 600),
    fromApi<{ alerts: AlertEntry[] }>("/api/v1/alerts", 600),
    withProvinces
      ? fromApi<{ provinces: ProvinceWithDays[] }>("/api/v1/provinces", 600)
      : Promise.resolve(null),
  ]);
  return {
    base: siteUrl(),
    meta,
    alerts: alerts?.alerts ?? [],
    provinces: provinces?.provinces ?? [],
  };
}

export interface ScaleLevel {
  id: string;
  min?: number;
  max?: number;
  severity: number;
  label_th: string;
  label_en: string;
}
export interface Scales {
  categories: Record<
    string,
    { unit: string; source: string; levels: ScaleLevel[] }
  >;
}

export const textResponse = (body: string, type: string) =>
  new Response(body, {
    headers: {
      "Content-Type": `${type}; charset=utf-8`,
      "Cache-Control": "public, max-age=600, stale-while-revalidate=3600",
    },
  });
