import { MODELS, WAIT_MS, fail, isQuota, json, parse, plain, sameSecret, toolCalls, within, type AiOut, type Env } from "./lib";

/**
 * Dock's chat model (the owner's ask, 2026-11-19: "connect the chat to the Cloudflare Worker's LLM"): Workers AI behind
 * an OpenAI-compatible POST /ai/v1/chat/completions on docker.chakkritton.com/ai/* (the Worker answers there, nothing
 * reaches the VPS). Only the chat service calls it, with `Authorization: Bearer <AI_SECRET>`; chat.env sets
 * LLM_PROVIDER=openai, LLM_BASE_URL=https://docker.chakkritton.com/ai/v1, LLM_MODEL (one of MODELS) and LLM_API_KEY
 * (= AI_SECRET). GET /ai/health answers without running a model.
 *
 * Dock shows a reply as plain text (no Markdown, and no emoji in its messages), so the Worker asks for plain text and
 * strips what still comes back. Errors carry a Thai `error.message`: the chat shows it as "ตอบไม่ได้ตอนนี้: …".
 *
 * Tools (the owner's ask, 2026-11-20): `tools` and the `tool` and assistant `tool_calls` messages pass through in the
 * OpenAI shape, and an answer may be tool calls (finish_reason "tool_calls"). `tool_choice: "none"` sends the model no
 * tools at all, so it answers with what the results said.
 */

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/ai/health") return req.method === "GET" ? json({ ok: true }) : fail(405, "GET เท่านั้น", "invalid_request_error");
    if (pathname !== "/ai/v1/chat/completions") return fail(404, "ไม่มีหน้านี้", "not_found");
    if (req.method !== "POST") return fail(405, "POST เท่านั้น", "invalid_request_error");
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!sameSecret(token, env.AI_SECRET)) return fail(401, "รหัสไม่ตรงกับของ Worker (LLM_API_KEY ใน chat.env)", "authentication_error");
    if (!(await env.LIMITER.limit({ key: "chat" })).success) return fail(429, "ถามถี่เกินไป รอสักครู่แล้วลองใหม่", "rate_limit_error");
    const body = parse(await req.text());
    if (typeof body === "string") return fail(400, body, "invalid_request_error");
    const order = [body.model, ...Object.keys(MODELS).filter((m) => m !== body.model)];
    for (const model of order) {
      const { options, suffix } = MODELS[model];
      // the suffix goes on the question: after tool results the last message is not the user's
      const asked = body.messages.findLastIndex((m) => m.role === "user");
      const messages = suffix ? body.messages.map((m, i) => (i === asked ? { ...m, content: m.content + suffix } : m)) : body.messages;
      try {
        const input = { messages, max_tokens: body.max_tokens, temperature: body.temperature, ...(body.tools ? { tools: body.tools } : {}), ...options };
        const out = await within(env.AI.run(model, input) as Promise<AiOut>, WAIT_MS);
        const usage = out.usage && typeof out.usage === "object" ? { usage: out.usage } : {};
        const answer = (message: Record<string, unknown>, finish_reason: string) =>
          json({
            id: `chatcmpl-${crypto.randomUUID()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason }],
            ...usage,
          });
        // Workers AI answers in the OpenAI shape, or as `response` (which may even arrive already parsed)
        const text = out.choices?.[0]?.message?.content ?? out.response;
        const content = typeof text === "string" ? plain(text) : "";
        const calls = toolCalls(out, body.tools);
        if (calls.length) return answer({ content: content || null, tool_calls: calls }, "tool_calls");
        if (!content) continue;
        return answer({ content }, "stop");
      } catch (err) {
        // the allocation is the account's, so another model would hit it too
        if (isQuota(err)) return fail(503, "โควตา Workers AI ของวันนี้หมดแล้ว (เริ่มใหม่ทุกวัน 07:00 น.)", "quota_exceeded");
      }
    }
    return fail(502, "โมเดลไม่ตอบ ลองใหม่อีกครั้ง", "upstream_error");
  },
};
