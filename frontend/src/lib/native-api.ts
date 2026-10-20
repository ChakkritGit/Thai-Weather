type ApiPath = "/llms.txt" | "/llms-full.txt" | "/feed.xml";

/** Fixed native destinations; no browser headers, credentials or redirects are forwarded. */
export function createNativeApiProxy(
  baseUrl: () => string,
  request: typeof fetch = fetch,
) {
  return async (incoming: Request, path: ApiPath) => {
    const head = incoming.method === "HEAD";
    try {
      const target = new URL(path, baseUrl());
      target.search = new URL(incoming.url).search;
      const upstream = await request(target, {
        method: head ? "HEAD" : "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      const headers = new Headers();
      for (const name of ["content-type", "cache-control", "etag", "last-modified"]) {
        const value = upstream.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      return new Response(head ? null : upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch {
      const response = Response.json({ error: "Bad gateway" }, {
        status: 502,
        headers: { "Cache-Control": "no-store" },
      });
      return head ? new Response(null, { status: response.status, headers: response.headers }) : response;
    }
  };
}
