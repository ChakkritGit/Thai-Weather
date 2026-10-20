/** Golden parity against the frozen Elysia-era renderers, using synthetic HTTP only. */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { weatherScales } from "@/design/generated/tokens";
import { llmsResponse } from "../../tests/oracle/weather/llmsResponse";
import { fullTextResponse } from "../../tests/oracle/weather/fullTextResponse";
import { feedResponse } from "../../tests/oracle/weather/feedResponse";

const { state } = vi.hoisted(() => ({ state: {
  site: "https://fixture.test",
  data: {} as Record<string, unknown>,
} }));
vi.mock("@/lib/server", () => ({
  siteUrl: () => state.site,
  fromApi: async (path: string) => structuredClone(state.data[path] ?? null),
}));

const binary = process.env.APPS_RUST_TEST_BIN;
let native: ChildProcess | undefined;
let server: Server | undefined;
afterEach(async () => {
  if (native && native.exitCode === null) {
    const exited = once(native, "exit");
    native.kill("SIGTERM");
    await exited;
  }
  native = undefined;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

function fixture() {
  const place = { id: "fixture", name_th: "ทดสอบ", name_en: "Test & 'Province'" };
  const hazards = ["heat", "rain", "storm", "wind", "hot", "cold", "unknown"];
  return {
    "/api/v1/meta": {
      run: { run_id: "fixture<&>", created: "2026-10-19T23:30:00Z", times: ["2026-10-20T00:00:00Z"], model: "test<&>", ensemble_members: 8 },
      fine_grid: { ny: 751, nx: 421 }, scales: weatherScales,
    },
    "/api/v1/alerts": { alerts: [1, 2, 3].map((severity) => ({
      date: "2026-10-20", province: place, partial: true, until: "23:00",
      alerts: hazards.map((hazard) => ({ hazard, severity, value: -1.5, label_th: "ทดสอบ <&>\"'", label_en: "Test <&>\"'" })),
    })) },
    "/api/v1/provinces": { provinces: [{ ...place, days: [0, 5, 10, 39, 40, 61, 80, 100].map((rain_coverage, i) => ({
      date: "2026-10-20", hours: i % 2 ? 12 : 24, partial: i === 0 ? false : undefined, until: i % 2 ? "16:00" : null,
      tmin: i === 0 ? -1.5 : 24.5, tmax: 33.5, tmin_low: i === 0 ? -8 : 15,
      heat_max: [31, 32, 40.9, 41, 53.9, 54, 50, 34][i],
      rain_p95: [0, 10, 35.1, 90.1, 150, 300, 500, 1][i], rain_coverage, storm_max: i % 2 ? 40 : 39,
    })) }] },
  } as Record<string, unknown>;
}

async function start(data: Record<string, unknown>, mode = "ok") {
  state.data = data;
  const seen: string[] = [];
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    expect(req.headers.cookie).toBeUndefined();
    expect(req.headers.authorization).toBeUndefined();
    if (mode === "down") { res.writeHead(503); res.end("private upstream error"); return; }
    res.setHeader("content-type", "application/json");
    res.end(mode === "malformed" ? "{broken" : JSON.stringify(data[req.url ?? ""]));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address");
  const allocator = createServer();
  allocator.listen(0, "127.0.0.1");
  await once(allocator, "listening");
  const available = allocator.address();
  if (!available || typeof available === "string") throw new Error("fixture port");
  await new Promise<void>((resolve) => allocator.close(() => resolve()));
  const port = available.port;
  native = spawn(binary!, ["weather-web-api"], {
    env: { ...process.env, PORT: String(port), THWX_API_URL: `http://127.0.0.1:${address.port}`, SITE_URL: `${state.site}/` },
    stdio: "ignore",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { base: `http://127.0.0.1:${port}`, seen }; } catch { /* wait for bind */ }
    if (native.exitCode !== null) throw new Error("native process exited");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("native startup timeout");
}

describe.skipIf(!binary)("native Weather machine routes", () => {
  it.each(["", "?all=1", "?all=0&all=1", "?all=1&all=0"])("matches every original byte, headers and HEAD (%s)", async (query) => {
    const { base, seen } = await start(fixture());
    const routes = [
      ["/llms.txt", llmsResponse], ["/llms-full.txt", fullTextResponse], ["/feed.xml", feedResponse],
    ] as const;
    for (const [path, original] of routes) {
      const request = new Request(`${base}${path}${query}`);
      const expected = await original(request);
      const actual = await fetch(request);
      expect(actual.status).toBe(expected.status);
      expect(actual.headers.get("content-type")).toBe(expected.headers.get("content-type"));
      expect(actual.headers.get("cache-control")).toBe(expected.headers.get("cache-control"));
      expect(await actual.text()).toBe(await expected.text());
      const head = await fetch(request, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    }
    expect(seen.sort()).toEqual(["GET /api/v1/alerts", "GET /api/v1/meta", "GET /api/v1/provinces"]);
  });

  it.each(["down", "malformed"])("uses the original fallback when the upstream is %s", async (mode) => {
    const { base } = await start({}, mode);
    for (const [path, original] of [["/llms.txt", llmsResponse], ["/llms-full.txt", fullTextResponse]] as const) {
      const request = new Request(`${base}${path}`);
      expect(await (await fetch(request)).text()).toBe(await (await original()).text());
    }
    // No-run RSS uses current wall-clock seconds; normalize only that field.
    const request = new Request(`${base}/feed.xml?all=1`);
    const dates = /<lastBuildDate>.*?<\/lastBuildDate>/g;
    expect((await (await fetch(request)).text()).replace(dates, "<lastBuildDate/>"))
      .toBe((await (await feedResponse(request)).text()).replace(dates, "<lastBuildDate/>"));
  });

  it("coalesces concurrent reads while fetching independent paths", async () => {
    const { base, seen } = await start(fixture());
    const responses = await Promise.all(Array.from({ length: 12 }, () => fetch(`${base}/llms-full.txt`)));
    expect(responses.every((r) => r.ok)).toBe(true);
    await Promise.all(responses.map((r) => r.text()));
    expect(seen.sort()).toEqual(["GET /api/v1/alerts", "GET /api/v1/meta", "GET /api/v1/provinces"]);
  });
});
