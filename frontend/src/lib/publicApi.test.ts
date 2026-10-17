import { describe, expect, it } from "vitest";
import { createPublicApi } from "./publicApi";

describe("web-owned HTTP routes", () => {
  it("preserves text, RSS query parameters and cache headers", async () => {
    const app = createPublicApi({
      llms: async () => new Response("# ฟ้าละเอียด", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=600" } }),
      fullText: async () => new Response("# Full forecast"),
      feed: async (request) => new Response(new URL(request.url).searchParams.get("all") === "1" ? "<rss>all</rss>" : "<rss>warnings</rss>", { headers: { "Content-Type": "application/rss+xml" } }),
    });
    const text = await app.fetch(new Request("http://localhost/llms.txt"));
    expect(await text.text()).toBe("# ฟ้าละเอียด");
    expect(text.headers.get("cache-control")).toBe("public, max-age=600");
    expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await (await app.fetch(new Request("http://localhost/llms-full.txt"))).text()).toBe("# Full forecast");
    for (const query of ["", "?all=1"]) {
      const response = await app.fetch(new Request(`http://localhost/feed.xml${query}`));
      expect(await response.text()).toBe(query ? "<rss>all</rss>" : "<rss>warnings</rss>");
      expect(response.headers.get("content-type")).toBe("application/rss+xml");
    }
    const head = await app.fetch(new Request("http://localhost/llms.txt", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("probes liveness without reading forecast data and leaves FastAPI paths unclaimed", async () => {
    const unexpected = async (): Promise<never> => { throw new Error("must not read forecasts"); };
    const app = createPublicApi({ llms: unexpected, fullText: unexpected, feed: unexpected });
    const response = await app.fetch(new Request("http://localhost/api/healthz"));
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await app.fetch(new Request("http://localhost/api/v1/health"))).status).toBe(404);
  });
});
