/**
 * whoami.chakkritton.com: a bare full-screen terminal that types `whoami` and answers, then runs
 * `status --watch`: the status Worker's JSON (service binding STATUS, proxied at /status.json) drawn as a
 * box table and polled every 15 s, with a `watch`-style header that ticks every second. curl and other
 * plain clients get the whoami answer as text, the way the command would print it.
 */
const NAME = "chakkrit-ton";
const STATUS_JSON = "https://status.chakkritton.com/api/status";

type Env = { STATUS: { fetch(input: string): Promise<Response> } };

// The page's script, raw so its backslashes and quotes reach the browser untouched. No template literals in it.
const SCRIPT = String.raw`
(() => {
  const t = document.getElementById("t");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const POLL = 15000;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const prompt = '<span class="p">guest@chakkritton</span>:<span class="h">~</span>$ ';
  const cursor = '<span class="cur"></span>';
  const wait = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
  const pad = (s, n, right) => (right ? " ".repeat(Math.max(0, n - s.length)) + s : s + " ".repeat(Math.max(0, n - s.length)));
  const clock = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
  const ago = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    return Math.floor(s / 86400) + "d";
  };

  // macOS's own format, without the year, so it fits one line on a phone
  const d = new Date().toString();
  let history = '<span class="d">Last login: ' + d.slice(0, 10) + d.slice(15, 24) + " on ttys001</span>\n";
  let data = null, error = "", fetchedAt = 0, live = false;

  async function type(cmd) {
    for (let i = 1; i <= cmd.length; i++) {
      t.innerHTML = history + prompt + esc(cmd.slice(0, i)) + cursor;
      await wait(80 + Math.random() * 80);
    }
    await wait(260);
    history += prompt + esc(cmd) + "\n";
  }

  // characters that fit on one line, so a phone gets the narrow table
  function columns() {
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(50);
    t.appendChild(probe);
    const w = probe.getBoundingClientRect().width / 50;
    probe.remove();
    const cs = getComputedStyle(t);
    return Math.floor((t.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) / w);
  }

  // the column the table is sorted by (null: the status page's own order) and which way; kept per viewer
  let sort = { col: null, asc: true };
  try { sort = Object.assign(sort, JSON.parse(localStorage.getItem("whoami-sort") || "{}")); } catch {}
  const RANK = { down: 0, slow: 1, unknown: 2, up: 3 };
  const keyOf = (s, col, now) =>
    col === 0 ? s.id
      : col === 1 ? RANK[s.status] ?? 2
      : col === 2 ? (s.status === "unknown" || !s.ms ? Infinity : s.ms)
      : col === 3 ? s.uptime90 ?? -1
      : s.since ? now - s.since : Infinity;
  function sorted(list) {
    if (sort.col === null) return list;
    const now = Date.now();
    return list.slice().sort((a, b) => {
      const x = keyOf(a, sort.col, now), y = keyOf(b, sort.col, now);
      const c = typeof x === "string" ? x.localeCompare(y) : x - y;
      return (sort.asc ? c : -c) || a.id.localeCompare(b.id);
    });
  }
  // a header press: the same column flips the order, a third press goes back to the status page's order
  t.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button[data-col]");
    if (!b) return;
    const col = Number(b.dataset.col);
    sort = sort.col !== col ? { col, asc: true } : sort.asc ? { col, asc: false } : { col: null, asc: true };
    try { localStorage.setItem("whoami-sort", JSON.stringify(sort)); } catch {}
    focusCol = col;
    render();
  });
  // the screen is redrawn every second, so a keyboard user's header focus is put back each time
  let focusCol = null;
  t.addEventListener("focusin", (e) => { if (e.target.dataset && e.target.dataset.col) focusCol = Number(e.target.dataset.col); });
  t.addEventListener("focusout", (e) => { if (!e.relatedTarget || !t.contains(e.relatedTarget)) setTimeout(() => { if (!t.contains(document.activeElement)) focusCol = null; }); });

  function table() {
    const wide = columns() >= 62;
    if (!wide && sort.col === 4) sort = { col: null, asc: true };
    const tone = { up: "ok", slow: "warn", down: "bad", unknown: "d" };
    const rows = sorted(data.services).map((s) => ({
      cells: [s.id, "● " + s.status, s.status === "unknown" || !s.ms ? "-" : s.ms + " ms", s.uptime90 == null ? "-" : s.uptime90.toFixed(1) + "%"]
        .concat(wide ? [s.since ? ago(Date.now() - s.since) : "-"] : []),
      tone: tone[s.status] || "d",
    }));
    const head = ["SERVICE", "STATUS", "LATENCY", "UPTIME"].concat(wide ? ["SINCE"] : []);
    const right = [false, false, true, true, true];
    const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r.cells[i].length)));
    const line = (l, m, r) => '<span class="d">' + l + w.map((n) => "─".repeat(n + 2)).join(m) + r + "</span>\n";
    const bar = '<span class="d">│</span>';
    const row = (cells, cls) =>
      bar + cells.map((c, i) => " " + (cls[i] ? '<span class="' + cls[i] + '">' : "") + esc(pad(c, w[i], right[i])) + (cls[i] ? "</span>" : "") + " ").join(bar) + bar + "\n";
    const header = bar + head.map((h, i) =>
      '<button class="hd' + (sort.col === i ? " on" : "") + '" data-col="' + i + '" aria-label="sort by ' + h.toLowerCase() + '">' +
      // the arrow takes the cell's trailing space, so sorting never widens or shifts a column
      " " + esc(pad(h, w[i], false)) + (sort.col === i ? (sort.asc ? "▲" : "▼") : " ") + "</button>").join(bar) + bar + "\n";
    // its own block with terminal line height, so the box-drawing lines join up, sized by its width in cells
    const width = w.reduce((a, n) => a + n + 3, 1);
    let out = '<span class="tb" style="--n:' + width + '">' + line("┌", "┬", "┐") + header + line("├", "┼", "┤");
    for (const r of rows) out += row(r.cells, ["", r.tone, "", "", ""]);
    out += line("└", "┴", "┘") + "</span>";
    const counts = { up: 0, slow: 0, down: 0, unknown: 0 };
    for (const s of data.services) counts[s.status] = (counts[s.status] || 0) + 1;
    out += '<span class="ok">' + counts.up + " up</span>";
    if (counts.slow) out += '  <span class="warn">' + counts.slow + " slow</span>";
    if (counts.down) out += '  <span class="bad">' + counts.down + " down</span>";
    if (counts.unknown) out += '  <span class="d">' + counts.unknown + " unknown</span>";
    const open = data.incidents.filter((i) => !i.end).length;
    out += '<span class="d">  ·  incidents 7d: ' + data.incidents.length + (open ? ", " + open + " open" : "") + "</span>\n";
    return out;
  }

  function render() {
    const now = Date.now();
    let out = history;
    out += '<span class="d">Every ' + POLL / 1000 + ".0s: status" + " ".repeat(4) + clock(now) + "</span>\n";
    if (data) {
      const next = data.lastRun ? data.lastRun + 300000 - now : 0;
      out += '<span class="d">checked ' + (data.lastRun ? clock(data.lastRun) + " (" + ago(now - data.lastRun) + " ago)" : "-") +
        (next > 0 ? "  ·  next " + Math.floor(next / 60000) + ":" + String(Math.floor((next % 60000) / 1000)).padStart(2, "0") : "  ·  next any moment") +
        "</span>\n\n" + table();
    } else if (!error) out += "\nconnecting...\n";
    if (error) out += '<span class="bad">status: ' + esc(error) + "</span>\n";
    out += '\n<span class="' + (live ? "ok" : "d") + '">●</span><span class="d"> ' + (live ? "live" : "paused") +
      "  ·  updated " + (fetchedAt ? ago(now - fetchedAt) + " ago" : "-") + (data ? "  ·  tap a header to sort" : "") + "</span>" + cursor;
    t.innerHTML = out;
    if (focusCol !== null) t.querySelector('button[data-col="' + focusCol + '"]')?.focus({ preventScroll: true });
  }

  async function poll() {
    if (document.visibilityState !== "visible") return;
    try {
      const r = await fetch("/status.json", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      data = await r.json();
      fetchedAt = Date.now();
      error = "";
      live = true;
    } catch (e) {
      error = "could not reach the status page (" + (e && e.message ? e.message : e) + ")";
      live = false;
    }
    render();
  }

  (async () => {
    t.innerHTML = history + prompt + cursor;
    await wait(700);
    await type("whoami");
    history += "${NAME}\n"; // filled in by the template
    t.innerHTML = history + prompt + cursor;
    await wait(900);
    await type("status --watch");
    await poll();
    setInterval(poll, POLL);
    setInterval(render, 1000);
    addEventListener("resize", render);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") poll();
      else { live = false; render(); }
    });
  })();
})();
`;

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
  :root { --bg: #0b0d10; --ink: #e6e6e6; --dim: #7d8590; --ok: #33d17a; --you: #58a6ff; --warn: #e3b341; --bad: #ff6b6b; }
  html, body { height: 100%; margin: 0; background: var(--bg); }
  body { color: var(--ink); font: 15px/1.6 ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; }
  @media (max-width: 480px) { body { font-size: 13px; } }
  pre {
    margin: 0; padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) 16px max(16px, env(safe-area-inset-left));
    white-space: pre-wrap; word-break: break-word; font: inherit; line-height: 1.45;
  }
  .p, .ok { color: var(--ok); } .h { color: var(--you); } .d { color: var(--dim); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  .hd { font-weight: 700; }
  button.hd { all: unset; font-weight: 700; white-space: pre; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  button.hd:hover, button.hd.on { color: var(--you); }
  button.hd:focus-visible { outline: 1px dashed var(--you); outline-offset: -1px; }
  /* shrinks to fit when a phone is a column or two short (a monospace cell is ~0.61em wide) */
  .tb { display: block; line-height: 1.18; font-size: min(1em, calc((100vw - 32px) / (var(--n) * 0.62))); }
  .cur { display: inline-block; width: .6em; height: 1.15em; vertical-align: -.2em; background: var(--ink); animation: b 1s steps(1) infinite; }
  @keyframes b { 50% { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .cur { animation: none; } }
</style>
</head>
<body>
<main aria-label="Terminal">
  <pre id="t" aria-live="polite"><noscript><span class="p">guest@chakkritton</span>:<span class="h">~</span>$ whoami
${NAME}
</noscript></pre>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;

const HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed\n", { status: 405, headers: { Allow: "GET, HEAD" } });
    if (url.pathname === "/status.json") {
      const r = await env.STATUS.fetch(STATUS_JSON).catch(() => null);
      if (!r?.ok) return new Response('{"error":"status unavailable"}', { status: 502, headers: { ...HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
      return new Response(r.body, { headers: { ...HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    if (url.pathname !== "/") return Response.redirect(`${url.origin}/`, 301);
    const html = (req.headers.get("accept") ?? "").includes("text/html");
    return html
      ? new Response(PAGE, { headers: { ...HEADERS, Vary: "Accept", "Cache-Control": "public, max-age=300", "Content-Type": "text/html; charset=utf-8" } })
      : new Response(`${NAME}\n`, { headers: { ...HEADERS, Vary: "Accept", "Cache-Control": "public, max-age=300", "Content-Type": "text/plain; charset=utf-8" } });
  },
};
