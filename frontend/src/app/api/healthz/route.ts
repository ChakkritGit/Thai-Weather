// Container liveness must stay independent of databases, sessions and native APIs.
export function GET() {
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

export function HEAD() {
  return new Response(null, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
