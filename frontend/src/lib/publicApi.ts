import { Elysia } from "elysia";
import { WebStandardAdapter } from "elysia/adapter/web-standard";

interface PublicResponses {
  llms: () => Promise<Response>;
  fullText: () => Promise<Response>;
  feed: (request: Request) => Promise<Response>;
}

/** Web-owned endpoints; forecast data and /api/v1 remain in the Python FastAPI service. */
export function createPublicApi(responses: PublicResponses) {
  return new Elysia({ adapter: WebStandardAdapter })
    .get("/api/healthz", () => Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } }))
    .get("/llms.txt", () => responses.llms())
    .get("/llms-full.txt", () => responses.fullText())
    .get("/feed.xml", ({ request }) => responses.feed(request));
}
