/** What the Worker (worker.ts) is made of: its request checks, message order, models and plain-text answers. A Worker
 * module may export only its handlers (workerd refuses other values), so these live here, where the tests reach them. */
type Role = "system" | "user" | "assistant" | "tool";
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type Msg = { role: Role; content: string; tool_calls?: ToolCall[]; tool_call_id?: string };
export type Tool = { type: "function"; function: { name: string; description?: string; parameters?: unknown } };
export type Env = {
  AI: { run(model: string, input: unknown): Promise<unknown> };
  LIMITER: { limit(o: { key: string }): Promise<{ success: boolean }> };
  AI_SECRET?: string;
};
type RawCall = { id?: unknown; name?: unknown; arguments?: unknown; function?: { name?: unknown; arguments?: unknown } };
export type AiOut = {
  response?: unknown;
  tool_calls?: RawCall[];
  choices?: { message?: { content?: unknown; tool_calls?: RawCall[] } }[];
  usage?: unknown;
};

/**
 * The models LLM_MODEL may name, the first by default, each with what makes it answer without thinking first (Dock
 * waits for the whole answer, and a thinking model can spend its tokens reasoning; the same options as CalorieFlow's
 * AI Worker). When one fails or is slow the next is tried, the same messages. DeepSeek V4.1 Flash (tools, reasoning
 * "none") since 2026-11-20, when Workers AI retired Qwen 3 30B, the second until then.
 */
export const MODELS: Record<string, { options: Record<string, unknown> }> = {
  "@cf/google/gemma-4-26b-a4b-it": { options: { reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } } },
  "@cf/deepseek-ai/deepseek-v4.1-flash-1017": { options: { reasoning_effort: "none" } },
};
const DEFAULT_MODEL = Object.keys(MODELS)[0];
/** each model's turn: two stay well inside the 60 s that the proxies in front of Dock wait for a reply */
export const WAIT_MS = 25_000;
/** a question with a few rounds of tool calls: the chat's history (12), then calls and their results */
const MAX_MESSAGES = 80;
const MAX_CHARS = 120_000;
const MAX_TOOLS = 48;
const MAX_CALLS = 8;
/** what OpenAI allows in a function's name */
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

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
 * One system message first, then turns that alternate and end with the user's (or with tool results): Gemma's chat
 * template refuses any other order, and the chat service sends its last 12 messages as they are (the oldest can be an
 * answer). An unanswered question goes with the placeholder after it. A model's tool calls and their results are kept
 * as they are, never merged. Null when no question is left to answer.
 */
export function normalize(messages: Msg[]): Msg[] | null {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content.trim()).filter(Boolean);
  const plainTurn = (m: Msg | undefined) => (m?.role === "user" || m?.role === "assistant") && !m.tool_calls?.length;
  const kept: Msg[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (plainTurn(m) && m.role === "assistant" && PLACEHOLDER.test(m.content.trim())) {
      if (kept.at(-1)?.role === "user") kept.pop();
      continue;
    }
    kept.push({ ...m });
  }
  const turns: Msg[] = [];
  for (const m of kept) {
    const last = turns.at(-1);
    if (last && last.role === m.role && plainTurn(last) && plainTurn(m)) last.content += `\n\n${m.content}`;
    else turns.push(m);
  }
  while (turns.length && turns[0].role !== "user") turns.shift();
  const end = turns.at(-1)?.role;
  if (end !== "user" && end !== "tool") return null;
  return [{ role: "system", content: [...system, STYLE].join("\n\n") }, ...turns];
}

/** An assistant message's tool calls as the model gets them back, or why not. */
function readCalls(raw: unknown): ToolCall[] | string {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_CALLS) return `tool_calls ต้องมี 1-${MAX_CALLS} รายการ`;
  const calls: ToolCall[] = [];
  for (const c of raw as RawCall[]) {
    const name = c?.function?.name;
    const args = c?.function?.arguments;
    if (typeof c?.id !== "string" || !c.id || c.id.length > 100 || typeof name !== "string" || !NAME.test(name)) {
      return "tool_calls แต่ละรายการต้องมี id และ function.name";
    }
    calls.push({ id: c.id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) } });
  }
  return calls;
}

/** The tools the model may call, or why not. */
function readTools(raw: unknown): Tool[] | string {
  if (!Array.isArray(raw) || raw.length > MAX_TOOLS) return `tools ต้องเป็นรายการไม่เกิน ${MAX_TOOLS} อย่าง`;
  const tools: Tool[] = [];
  for (const t of raw as { type?: unknown; function?: { name?: unknown; description?: unknown; parameters?: unknown } }[]) {
    const f = t?.function;
    if (t?.type !== "function" || typeof f?.name !== "string" || !NAME.test(f.name)) return "tools แต่ละอย่างต้องเป็น function ที่มีชื่อ";
    if (tools.some((x) => x.function.name === f.name)) return `tools มีชื่อ ${f.name} ซ้ำ`;
    tools.push({
      type: "function",
      function: {
        name: f.name,
        ...(typeof f.description === "string" ? { description: f.description.slice(0, 2000) } : {}),
        parameters: f.parameters && typeof f.parameters === "object" ? f.parameters : { type: "object", properties: {} },
      },
    });
  }
  return tools;
}

/** The request, or why it cannot be answered (Thai, shown in the chat). */
export function parse(
  raw: string,
): { model: string; messages: Msg[]; tools?: Tool[]; max_tokens: number; temperature: number } | string {
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
    const role = m?.role as Role;
    if (!["system", "user", "assistant", "tool"].includes(role)) return "แต่ละข้อความต้องมี role (system, user, assistant หรือ tool)";
    // a model's tool calls come back with no words (content null)
    const calls = role === "assistant" && m.tool_calls != null ? readCalls(m.tool_calls) : undefined;
    if (typeof calls === "string") return calls;
    const content = m.content == null && calls ? "" : m.content;
    if (typeof content !== "string") return "content ของแต่ละข้อความต้องเป็นตัวอักษร";
    const msg: Msg = { role, content };
    if (calls) msg.tool_calls = calls;
    if (role === "tool") {
      if (typeof m.tool_call_id !== "string" || !m.tool_call_id || m.tool_call_id.length > 100) return "ผลของเครื่องมือต้องมี tool_call_id";
      msg.tool_call_id = m.tool_call_id;
    }
    size += content.length + (calls ? JSON.stringify(calls).length : 0);
    messages.push(msg);
  }
  if (size > MAX_CHARS) return `ข้อความรวมกันยาวเกิน ${MAX_CHARS.toLocaleString("en-US")} ตัวอักษร`;
  const choice = b.tool_choice ?? "auto";
  if (choice !== "auto" && choice !== "none") return 'tool_choice ใช้ได้แค่ "auto" หรือ "none"';
  const tools = b.tools == null ? [] : readTools(b.tools);
  if (typeof tools === "string") return tools;
  if (JSON.stringify(tools).length > 60_000) return "tools ยาวเกินไป";
  const turns = normalize(messages);
  if (!turns) return "ไม่มีคำถามให้ตอบ (ข้อความสุดท้ายต้องเป็นของผู้ใช้หรือผลของเครื่องมือ)";
  const max = Number(b.max_tokens);
  const temp = Number(b.temperature);
  return {
    model,
    messages: turns,
    ...(tools.length && choice === "auto" ? { tools } : {}),
    max_tokens: Number.isFinite(max) && max > 0 ? Math.min(Math.round(max), 1024) : 800,
    temperature: Number.isFinite(temp) ? Math.min(Math.max(temp, 0), 1) : 0.3,
  };
}

/**
 * The model's tool calls in the OpenAI shape, from either shape Workers AI answers in (`choices[0].message.tool_calls`,
 * or a top-level `tool_calls` of `{name, arguments}`), each with an id. Calls to tools it was not given are dropped.
 */
export function toolCalls(out: AiOut, tools: Tool[] | undefined): ToolCall[] {
  const raw = out.choices?.[0]?.message?.tool_calls ?? out.tool_calls;
  if (!tools?.length || !Array.isArray(raw)) return [];
  const known = new Set(tools.map((t) => t.function.name));
  return raw.slice(0, MAX_CALLS).flatMap((c, i) => {
    const name = c?.function?.name ?? c?.name;
    if (typeof name !== "string" || !known.has(name)) return [];
    const args = c?.function ? c.function.arguments : c?.arguments;
    const id = typeof c?.id === "string" && c.id ? c.id.slice(0, 100) : `call_${i}_${crypto.randomUUID().slice(0, 8)}`;
    return [{ id, type: "function" as const, function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) } }];
  });
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

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
export const fail = (status: number, message: string, type: string) => json({ error: { message, type } }, status);
export const isQuota = (err: unknown) => /allocation|neuron|quota|4006/i.test(String((err as Error)?.message ?? err));

/** `run`, or a rejection once `ms` have passed */
export async function within<T>(run: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([run, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

