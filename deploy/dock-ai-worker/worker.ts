/**
 * Dock's chat model (the owner's ask, 2026-11-19: "connect the chat to the Cloudflare Worker's LLM"): Workers AI behind
 * an OpenAI-compatible POST /ai/v1/chat/completions on docker.chakkritton.com/ai/* (the Worker answers there, nothing
 * reaches the VPS). Only the chat service calls it, with `Authorization: Bearer <AI_SECRET>`; chat.env sets
 * LLM_PROVIDER=openai, LLM_BASE_URL=https://docker.chakkritton.com/ai/v1, LLM_MODEL (one of MODELS) and LLM_API_KEY
 * (= AI_SECRET). GET /ai/health answers without running a model.
 *
 * Dock shows a reply as plain text (no Markdown, and no emoji in its messages), so the Worker asks for plain text and
 * strips what still comes back. Errors carry a Thai `error.message`: the chat shows it as "ตอบไม่ได้ตอนนี้: …".
 */
type Role = "system" | "user" | "assistant";
export type Msg = { role: Role; content: string };
type Env = {
  AI: { run(model: string, input: unknown): Promise<unknown> };
  LIMITER: { limit(o: { key: string }): Promise<{ success: boolean }> };
  AI_SECRET?: string;
};
type AiOut = { response?: unknown; choices?: { message?: { content?: unknown } }[]; usage?: unknown };

/**
 * The models LLM_MODEL may name, the first by default, each with what makes it answer without thinking first (Dock
 * waits for the whole answer, and a thinking model can spend its tokens reasoning; the same options as CalorieFlow's
 * AI Worker). When one fails or is slow the next is tried, the same messages.
 */
export const MODELS: Record<string, { options: Record<string, unknown>; suffix?: string }> = {
  "@cf/google/gemma-4-26b-a4b-it": { options: { reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } } },
  "@cf/qwen/qwen3-30b-a3b-fp8": { options: {}, suffix: " /no_think" },
};
const DEFAULT_MODEL = Object.keys(MODELS)[0];
/** each model's turn: two stay well inside the 60 s that the proxies in front of Dock wait for a reply */
const WAIT_MS = 25_000;
const MAX_MESSAGES = 40;
const MAX_CHARS = 60_000;

/** Dock's messages are plain text; asked for in the system message (the rules there are the chat service's own) */
export const STYLE =
  "รูปแบบคำตอบ: Dock แสดงคำตอบเป็นตัวอักษรธรรมดา ห้ามใช้ Markdown ทุกแบบ (ดอกจันทำตัวหนา เครื่องหมาย # นำหัวข้อ โค้ดบล็อก หรือตาราง) " +
  "และห้ามใช้อีโมจิ ถ้าจะแจกแจงให้ขึ้นบรรทัดใหม่แล้วนำหน้าด้วย •";
/** the chat service's own replies when no model answered: not the model's words, so left out of what it reads */
const PLACEHOLDER = /^(ยังไม่ได้เชื่อม LLM|ตอบไม่ได้ตอนนี้)/;

/** Constant-time, so a secret cannot be guessed a byte at a time from response timing. */
export function sameSecret(a: string, b: string | undefined): boolean {
  if (!b) return false;
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * One system message first, then turns that alternate and end with the user's: Gemma's chat template refuses any
 * other order, and the chat service sends its last 12 messages as they are (the oldest can be an answer). An
 * unanswered question goes with the placeholder after it. Null when no question is left to answer.
 */
export function normalize(messages: Msg[]): Msg[] | null {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content.trim()).filter(Boolean);
  const kept: Msg[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "assistant" && PLACEHOLDER.test(m.content.trim())) {
      if (kept.at(-1)?.role === "user") kept.pop();
      continue;
    }
    kept.push({ role: m.role, content: m.content });
  }
  const turns: Msg[] = [];
  for (const m of kept) {
    const last = turns.at(-1);
    if (last?.role === m.role) last.content += `\n\n${m.content}`;
    else turns.push(m);
  }
  while (turns[0]?.role === "assistant") turns.shift();
  if (turns.at(-1)?.role !== "user") return null;
  return [{ role: "system", content: [...system, STYLE].join("\n\n") }, ...turns];
}

/** The request, or why it cannot be answered (Thai, shown in the chat). */
export function parse(raw: string): { model: string; messages: Msg[]; max_tokens: number; temperature: number } | string {
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(raw);
  } catch {
    return "คำขอไม่ใช่ JSON";
  }
  if (!b || typeof b !== "object") return "คำขอไม่ใช่ JSON";
  if (b.stream === true) return "Worker นี้ตอบทีเดียวทั้งข้อความ ไม่ส่งแบบ stream";
  const model = b.model == null || b.model === "" ? DEFAULT_MODEL : String(b.model);
  if (!Object.hasOwn(MODELS, model)) return `ไม่รู้จักโมเดล ${model} (LLM_MODEL ใน chat.env ใช้ได้: ${Object.keys(MODELS).join(", ")})`;
  if (!Array.isArray(b.messages) || !b.messages.length || b.messages.length > MAX_MESSAGES) return `messages ต้องมี 1-${MAX_MESSAGES} ข้อความ`;
  let size = 0;
  const messages: Msg[] = [];
  for (const m of b.messages as Record<string, unknown>[]) {
    if (!m || !["system", "user", "assistant"].includes(m.role as string) || typeof m.content !== "string") {
      return "แต่ละข้อความต้องมี role (system, user หรือ assistant) และ content เป็นตัวอักษร";
    }
    size += m.content.length;
    messages.push({ role: m.role as Role, content: m.content });
  }
  if (size > MAX_CHARS) return `ข้อความรวมกันยาวเกิน ${MAX_CHARS.toLocaleString("en-US")} ตัวอักษร`;
  const turns = normalize(messages);
  if (!turns) return "ไม่มีคำถามให้ตอบ (ข้อความสุดท้ายต้องเป็นของผู้ใช้)";
  const max = Number(b.max_tokens);
  const temp = Number(b.temperature);
  return {
    model,
    messages: turns,
    max_tokens: Number.isFinite(max) && max > 0 ? Math.min(Math.round(max), 1024) : 800,
    temperature: Number.isFinite(temp) ? Math.min(Math.max(temp, 0), 1) : 0.3,
  };
}

/** emoji, with their skin tones, flags, keycaps and joiners */
const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}⃣️‍]/gu;

/** A reply as Dock can show it: no thinking, no Markdown marks (list items become •), no emoji. */
export function plain(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^[ \t]*```[^\n]*$/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ")
    .replace(EMOJI, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const fail = (status: number, message: string, type: string) => json({ error: { message, type } }, status);
const isQuota = (err: unknown) => /allocation|neuron|quota|4006/i.test(String((err as Error)?.message ?? err));

/** `run`, or a rejection once `ms` have passed */
async function within<T>(run: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([run, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

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
      const messages = suffix
        ? body.messages.map((m, i, all) => (i === all.length - 1 ? { ...m, content: m.content + suffix } : m))
        : body.messages;
      try {
        const run = env.AI.run(model, { messages, max_tokens: body.max_tokens, temperature: body.temperature, ...options }) as Promise<AiOut>;
        const out = await within(run, WAIT_MS);
        // Workers AI answers in the OpenAI shape, or as `response` (which may even arrive already parsed)
        const text = out.choices?.[0]?.message?.content ?? out.response;
        const content = typeof text === "string" ? plain(text) : "";
        if (!content) continue;
        return json({
          id: `chatcmpl-${crypto.randomUUID()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          ...(out.usage && typeof out.usage === "object" ? { usage: out.usage } : {}),
        });
      } catch (err) {
        // the allocation is the account's, so another model would hit it too
        if (isQuota(err)) return fail(503, "โควตา Workers AI ของวันนี้หมดแล้ว (เริ่มใหม่ทุกวัน 07:00 น.)", "quota_exceeded");
      }
    }
    return fail(502, "โมเดลไม่ตอบ ลองใหม่อีกครั้ง", "upstream_error");
  },
};
