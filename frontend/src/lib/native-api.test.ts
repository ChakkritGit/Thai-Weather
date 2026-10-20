import { it as test } from "vitest";
import assert from "node:assert/strict";
import { createNativeApiProxy } from "./native-api";
import { GET as live, HEAD as liveHead } from "../app/api/healthz/route";

const path = "/feed.xml";

test("native proxy preserves fixed destinations, query, response bytes and cache policy", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const proxy = createNativeApiProxy(() => "http://native.test/ignored", async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response("<rss>ฟ้าละเอียด</rss>", {
      status: 503,
      headers: {
        "Content-Type": "application/rss+xml; charset=utf-8",
        "Cache-Control": "public, s-maxage=15",
        "Set-Cookie": "private=must-not-forward",
        "Authorization": "must-not-forward",
      },
    });
  });
  const response = await proxy(new Request("https://attacker.test/untrusted?all=1&all=0&x=%2F", {
    headers: { Cookie: "session=private", Authorization: "Bearer private", "x-sync-secret": "untrusted" },
  }), path);
  assert.equal(calls[0].url, "http://native.test/feed.xml?all=1&all=0&x=%2F");
  assert.equal(calls[0].init?.method, "GET");
  assert.equal(calls[0].init?.credentials, "omit");
  assert.equal(calls[0].init?.cache, "no-store");
  assert.equal(calls[0].init?.redirect, "manual");
  assert.equal(calls[0].init?.body, undefined);
  assert.ok(calls[0].init?.signal instanceof AbortSignal);
  assert.deepEqual(Array.from(new Headers(calls[0].init?.headers)), []);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "<rss>ฟ้าละเอียด</rss>");
  assert.equal(response.headers.get("cache-control"), "public, s-maxage=15");
  assert.equal(response.headers.get("content-type"), "application/rss+xml; charset=utf-8");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("authorization"), null);
});

test("HEAD retains native status and headers with no body", async () => {
  let method: string | undefined;
  const proxy = createNativeApiProxy(() => "http://native.test", async (_url, init) => {
    method = init?.method;
    return new Response("ignored even if the upstream sends a body", {
      headers: { "Cache-Control": "public, max-age=600", "Content-Type": "text/plain" },
    });
  });
  const response = await proxy(new Request("https://site.test/", { method: "HEAD" }), path);
  assert.equal(method, "HEAD");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("cache-control"), "public, max-age=600");
});

test("runtime configuration is read for each request", async () => {
  let base = "http://first.test";
  const calls: string[] = [];
  const proxy = createNativeApiProxy(() => base, async (url) => {
    calls.push(String(url));
    return new Response("ok");
  });
  await proxy(new Request("https://site.test/"), path);
  base = "http://second.test";
  await proxy(new Request("https://site.test/"), path);
  assert.deepEqual(calls, [`http://first.test${path}`, `http://second.test${path}`]);
});

test("unavailable native services return sanitized errors and empty HEAD bodies", async () => {
  const proxy = createNativeApiProxy(() => "http://native.test", async () => { throw new Error("private backend detail"); });
  for (const method of ["GET", "HEAD"]) {
    const response = await proxy(new Request("https://site.test/", { method }), path);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), method === "HEAD" ? "" : JSON.stringify({ error: "Bad gateway" }));
  }
});

test("Next liveness returns no-store JSON and supports HEAD without native dependencies", async () => {
  const response = live();
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get("cache-control"), "no-store");
  const head = liveHead();
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("cache-control"), "no-store");
  assert.equal(await head.text(), "");
});
