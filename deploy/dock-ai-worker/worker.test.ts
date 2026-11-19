import { describe, expect, test } from "bun:test";
import worker, { MODELS, STYLE, normalize, parse, plain, sameSecret, type Msg } from "./worker";

const [GEMMA, QWEN] = Object.keys(MODELS);
const SECRET = "test-secret-not-real";

/** A stand-in for the Worker's bindings: each model's answer (a function, so one can throw), and the rate limit. */
function env(answers: Record<string, (input: unknown) => unknown>, allowed = true) {
  const calls: { model: string; input: Record<string, unknown> }[] = [];
  return {
    calls,
    env: {
      AI_SECRET: SECRET,
      LIMITER: { limit: async () => ({ success: allowed }) },
      AI: {
        run: async (model: string, input: unknown) => {
          calls.push({ model, input: input as Record<string, unknown> });
          const answer = answers[model];
          if (!answer) throw new Error("no such model");
          return answer(input);
        },
      },
    },
  };
}

const ask = (body: unknown, auth = `Bearer ${SECRET}`, path = "/ai/v1/chat/completions") =>
  new Request(`https://docker.example.invalid${path}`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const chat = (messages: Msg[], extra: Record<string, unknown> = {}) => ({ model: GEMMA, max_tokens: 800, messages, ...extra });

describe("sameSecret", () => {
  test("only the same value", () => {
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abd", "abc")).toBe(false);
    expect(sameSecret("abcd", "abc")).toBe(false);
    expect(sameSecret("", undefined)).toBe(false);
  });
});

describe("normalize", () => {
  test("one system message first, with the style rules after the chat's own", () => {
    const out = normalize([
      { role: "system", content: "ตอบเป็นภาษาไทย" },
      { role: "user", content: "สวัสดี" },
    ])!;
    expect(out[0]).toEqual({ role: "system", content: `ตอบเป็นภาษาไทย\n\n${STYLE}` });
    expect(out.slice(1)).toEqual([{ role: "user", content: "สวัสดี" }]);
  });
  test("history starting with an answer, and an unanswered question with its placeholder, are left out", () => {
    const out = normalize([
      { role: "system", content: "s" },
      { role: "assistant", content: "สรุปเดือนตุลาคม" },
      { role: "user", content: "เมื่อวานเว็บล่มไหม" },
      { role: "assistant", content: "ยังไม่ได้เชื่อม LLM จึงตอบได้เฉพาะคำสั่ง" },
      { role: "user", content: "สรุป" },
      { role: "assistant", content: "สรุปเดือนพฤศจิกายน" },
      { role: "user", content: "CPU สูงสุดวันไหน" },
    ])!;
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(out[1].content).toBe("สรุป");
  });
  test("questions in a row become one turn; no question at the end is null", () => {
    const out = normalize([
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ])!;
    expect(out.slice(1)).toEqual([{ role: "user", content: "a\n\nb" }]);
    expect(normalize([{ role: "user", content: "a" }, { role: "assistant", content: "b" }])).toBeNull();
    expect(normalize([{ role: "system", content: "s" }])).toBeNull();
  });
});

describe("parse", () => {
  test("defaults and limits", () => {
    const p = parse(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));
    expect(typeof p).toBe("object");
    if (typeof p === "string") return;
    expect(p.model).toBe(GEMMA);
    expect(p.max_tokens).toBe(800);
    expect(p.temperature).toBe(0.3);
    const q = parse(JSON.stringify({ model: QWEN, max_tokens: 5000, temperature: 3, messages: [{ role: "user", content: "hi" }] }));
    if (typeof q === "string") throw new Error(q);
    expect([q.model, q.max_tokens, q.temperature]).toEqual([QWEN, 1024, 1]);
  });
  test("refusals say why, in Thai", () => {
    expect(parse("{")).toBe("คำขอไม่ใช่ JSON");
    expect(parse(JSON.stringify({ model: "@cf/x/y", messages: [{ role: "user", content: "hi" }] }))).toStartWith("ไม่รู้จักโมเดล @cf/x/y");
    expect(parse(JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }))).toContain("stream");
    expect(parse(JSON.stringify({ messages: [] }))).toContain("1-40");
    expect(parse(JSON.stringify({ messages: [{ role: "tool", content: "x" }] }))).toContain("role");
    expect(parse(JSON.stringify({ messages: [{ role: "user", content: "x".repeat(60_001) }] }))).toContain("60,000");
  });
});

describe("plain", () => {
  test("Markdown marks, thinking and emoji go; Thai, numbers and • stay", () => {
    const md = "<think>x</think>## สรุป\n**CPU** เฉลี่ย `12%` \u{1F680}\n- ดิสก์ 31 GB\n* แรม 2.9 GB\n```\nlog\n```\n\n\n• สำรองข้อมูลแล้ว ✅";
    expect(plain(md)).toBe("สรุป\nCPU เฉลี่ย 12%\n• ดิสก์ 31 GB\n• แรม 2.9 GB\n\nlog\n\n• สำรองข้อมูลแล้ว");
    expect(plain("-5% จากเดือนก่อน")).toBe("-5% จากเดือนก่อน");
  });
});

describe("fetch", () => {
  const ok = (content: string) => () => ({ choices: [{ message: { content } }], usage: { total_tokens: 10 } });
  const question = chat([
    { role: "system", content: "ข้อมูลล่าสุดของระบบ" },
    { role: "user", content: "CPU เป็นยังไง" },
  ]);

  test("an OpenAI-shaped answer from the asked model, thinking off", async () => {
    const t = env({ [GEMMA]: ok("**CPU** ปกติ") });
    const res = await worker.fetch(ask(question), t.env);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { model: string; choices: { message: { role: string; content: string } }[]; usage: unknown };
    expect(j.model).toBe(GEMMA);
    expect(j.choices[0].message).toEqual({ role: "assistant", content: "CPU ปกติ" });
    expect(j.usage).toEqual({ total_tokens: 10 });
    expect(t.calls[0].input.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect((t.calls[0].input.messages as Msg[])[0].content).toContain(STYLE);
  });

  test("the next model when one fails, with its own way to skip thinking", async () => {
    const t = env({ [GEMMA]: () => { throw new Error("5xx"); }, [QWEN]: () => ({ response: "ตอบจาก qwen" }) });
    const res = await worker.fetch(ask(question), t.env);
    const j = (await res.json()) as { model: string; choices: { message: { content: string } }[] };
    expect([res.status, j.model, j.choices[0].message.content]).toEqual([200, QWEN, "ตอบจาก qwen"]);
    expect((t.calls[1].input.messages as Msg[]).at(-1)!.content).toEndWith(" /no_think");
  });

  test("an empty quota stops at once; every model failing is a 502", async () => {
    const quota = env({ [GEMMA]: () => { throw new Error("4006: daily free allocation of neurons used up"); }, [QWEN]: ok("x") });
    const q = await worker.fetch(ask(question), quota.env);
    expect([q.status, quota.calls.length]).toEqual([503, 1]);
    expect(((await q.json()) as { error: { message: string } }).error.message).toContain("โควตา");
    const down = env({});
    expect((await worker.fetch(ask(question), down.env)).status).toBe(502);
  });

  test("no secret, a wrong path, the rate limit and a bad body", async () => {
    const t = env({ [GEMMA]: ok("x") });
    expect((await worker.fetch(ask(question, "Bearer nope"), t.env)).status).toBe(401);
    expect((await worker.fetch(ask(question, ""), t.env)).status).toBe(401);
    expect((await worker.fetch(ask(question, undefined, "/ai/run"), t.env)).status).toBe(404);
    expect((await worker.fetch(ask(question), env({ [GEMMA]: ok("x") }, false).env)).status).toBe(429);
    expect((await worker.fetch(ask({ messages: [] }), t.env)).status).toBe(400);
    expect(t.calls.length).toBe(0);
    const health = await worker.fetch(new Request("https://docker.example.invalid/ai/health"), t.env);
    expect([health.status, await health.json()]).toEqual([200, { ok: true }]);
  });
});
