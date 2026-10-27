/**
 * whoami.chakkritton.com: a terminal window that types `whoami` and answers. curl and other plain
 * clients get the answer as text, the way the command would print it.
 */
const NAME = "chakkrit-ton";

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0b0d10">
<title>whoami</title>
<meta name="description" content="$ whoami">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230b0d10'/%3E%3Cpath d='M8 10l6 6-6 6' fill='none' stroke='%2333d17a' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M16 23h8' stroke='%23e6e6e6' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E">
<style>
  :root { --bg: #0b0d10; --win: #14171c; --bar: #1c2027; --ink: #e6e6e6; --dim: #7d8590; --ok: #33d17a; --you: #58a6ff; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: grid; place-items: center; padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
    background: radial-gradient(60rem 40rem at 50% -10%, #1a2a22, transparent 60%), var(--bg);
    color: var(--ink); font: 15px/1.6 ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  }
  .win { width: min(640px, 100%); border-radius: 12px; background: var(--win); border: 1px solid #262b33;
    box-shadow: 0 30px 80px rgb(0 0 0 / .55); overflow: hidden; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 11px 14px; background: var(--bar); border-bottom: 1px solid #262b33; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .bar span:nth-child(1) { background: #ff5f57; } .bar span:nth-child(2) { background: #febc2e; } .bar span:nth-child(3) { background: #28c840; }
  .title { flex: 1; text-align: center; margin-right: 52px; color: var(--dim); font-size: 13px; }
  pre { margin: 0; padding: 18px 18px 22px; min-height: 13rem; white-space: pre-wrap; word-break: break-word; font: inherit; }
  .p { color: var(--ok); } .h { color: var(--you); } .d { color: var(--dim); }
  .cur { display: inline-block; width: .6em; height: 1.15em; vertical-align: -.2em; background: var(--ink); animation: b 1s steps(1) infinite; }
  @keyframes b { 50% { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .cur { animation: none; } }
</style>
</head>
<body>
<main class="win" aria-label="Terminal">
  <div class="bar" aria-hidden="true"><span class="dot"></span><span class="dot"></span><span class="dot"></span><div class="title">guest@chakkritton: ~</div></div>
  <pre id="t"><noscript><span class="p">guest@chakkritton</span>:<span class="h">~</span>$ whoami
${NAME}
</noscript></pre>
</main>
<script>
(() => {
  const t = document.getElementById("t");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const prompt = () => '<span class="p">guest@chakkritton</span>:<span class="h">~</span>$ ';
  const wait = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
  const cursor = '<span class="cur"></span>';
  async function type(done, cmd) {
    for (let i = 1; i <= cmd.length; i++) {
      t.innerHTML = done + prompt() + cmd.slice(0, i) + cursor;
      await wait(90 + Math.random() * 80);
    }
    await wait(260);
  }
  (async () => {
    let done = '<span class="d">Last login: ' + new Date().toString().slice(0, 24) + ' on ttys001</span>\\n';
    t.innerHTML = done + prompt() + cursor;
    await wait(700);
    await type(done, "whoami");
    done += prompt() + "whoami\\n${NAME}\\n";
    t.innerHTML = done + prompt() + cursor;
  })();
})();
</script>
</body>
</html>`;

const HEADERS = {
  "Cache-Control": "public, max-age=300",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  Vary: "Accept",
};

export default {
  fetch(req: Request): Response {
    const url = new URL(req.url);
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed\n", { status: 405, headers: { Allow: "GET, HEAD" } });
    if (url.pathname !== "/") return Response.redirect(`${url.origin}/`, 301);
    const html = (req.headers.get("accept") ?? "").includes("text/html");
    return html
      ? new Response(PAGE, { headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8" } })
      : new Response(`${NAME}\n`, { headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
  },
};
