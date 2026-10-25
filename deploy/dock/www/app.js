// Dock – a minimal Docker dashboard on top of Portainer's API (same origin, /api/* is proxied).
// No dependencies. All text from the server goes in via textContent, never as HTML.
import { chart } from './charts.js';
import { BRANDS } from './brands.js';
import { roll } from './roll.js';
import { LANG, LANGS, LOCALE, THEMES, setLang, setTheme, theme, tx } from './i18n.js';

const TOKEN_KEY = 'dock.jwt';
const LIST_REFRESH_MS = 10_000;
const LOG_REFRESH_MS = 3_000;
/** stopping these would cut off access to this page (or to Portainer itself) */
const PROTECTED = new Set(['portainer', 'nginx-proxy-manager', 'dock']);
/** classic Portainer for everything this page leaves out (docker.example.com → portainer.example.com) */
const PORTAINER_URL = /^https:\/\/docker\./.test(location.origin) ? location.origin.replace('//docker.', '//portainer.') : null;

const app = document.getElementById('app');
let envId = null;
let timer = 0;
let viewToken = 0; // increases on every navigation; async work for an old view is dropped
let charts = []; // charts of the current view (destroyed on navigation)
const mkChart = (host, opts) => {
  const c = chart(host, opts);
  charts.push(c);
  return c;
};

// ------------------------------------------------------------------ tiny DOM helper
function h(tag, attrs = {}, ...children) {
  const el = document.createElementNS(tag === 'svg' || tag === 'path' ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml', tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.setAttribute('class', v);
    // through the CSSOM: a style="" attribute would be blocked by the page's CSP (style-src 'self')
    else if (k === 'style') for (const decl of String(v).split(';')) { const [p, ...rest] = decl.split(':'); if (p.trim()) el.style.setProperty(p.trim(), rest.join(':').trim()); }
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const ICONS = {
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  back: 'M15 18l-6-6 6-6',
  out: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3',
  chev: 'M9 6l6 6-6 6',
  box: 'M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8',
  layers: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5',
  disk: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  ext: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  pulse: 'M3 12h4l3-8 4 16 3-8h4',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  archive: 'M3 4h18v4H3zM5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4',
  more: 'M5 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3zM12 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3zM19 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3z',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z',
  send: 'M5 12h13M12 5l7 7-7 7',
  bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  belloff: 'M8.7 3A6 6 0 0 1 18 8c0 2.7.6 4.6 1.3 6M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7M10.3 21a1.94 1.94 0 0 0 3.4 0M2 2l20 20',
  alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  checkcircle: 'M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4 12 14l-3-3',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  shield: 'M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3zM9 12l2 2 4-4',
  key: 'M13 15.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 1 1 11 0zM11.4 11.6 21 2M15.5 7.5l2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4',
  lock: 'M5 11h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM8 11V7a4 4 0 1 1 8 0v4',
  file: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5zM14 3v5h5M9 13h6M9 17h6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  contrast: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 2v20M12 7h5M12 12h7M12 17h5',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  bug: 'M9 7a3 3 0 0 1 6 0v1H9zM7 10h10v4a5 5 0 0 1-10 0zM12 10v9M3 13h4M17 13h4M5 7l2 2.5M19 7l-2 2.5M5 20l2.5-2.5M19 20l-2.5-2.5',
};
const icon = (name, cls = '') =>
  h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: cls }, h('path', { d: ICONS[name] }));

/** sets text only when it differs: an unchanged number is not re-laid-out or repainted */
function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

/** a number that rolls digit by digit when it changes (roll.js) */
function setNumber(el, text) {
  if (!el || (el.dataset.value ?? el.textContent) === text && el.dataset.value !== undefined) return;
  roll(el, text);
}

/**
 * Brings `a` (on screen) in line with `b` (just built) without replacing it, when both have the same
 * shape: text is patched (numbers slide via setNumber), inline styles copied (meters glide). Returns
 * false when the shapes differ, so the caller swaps the node instead.
 */
function morph(a, b) {
  if (a.nodeType === 3 && b.nodeType === 3) { if (a.data !== b.data) a.data = b.data; return true; }
  if (a.nodeType === 1 && b.nodeType === 1 && a.dataset.value !== undefined && a.tagName === b.tagName) {
    setNumber(a, b.textContent); // a rolling number: its glyph spans never match b's plain text
    return true;
  }
  if (a.nodeType !== 1 || b.nodeType !== 1 || a.tagName !== b.tagName || a.getAttribute('class')?.replace(/ ?roll\b/, '') !== b.getAttribute('class')
    || a.childNodes.length !== b.childNodes.length) return false;
  if (a.style.cssText !== b.style.cssText) a.style.cssText = b.style.cssText;
  for (const attr of ['title', 'aria-valuenow', 'colspan', 'href']) if (b.getAttribute(attr) !== a.getAttribute(attr)) b.hasAttribute(attr) ? a.setAttribute(attr, b.getAttribute(attr)) : a.removeAttribute(attr);
  if (a.childNodes.length === 1 && a.firstChild.nodeType === 3) {
    if (a.tagName === 'B' || a.classList.contains('tile-value') || a.classList.contains('num')) setNumber(a, b.textContent);
    else setText(a, b.textContent);
    return true;
  }
  for (let i = 0; i < a.childNodes.length; i++) {
    const x = a.childNodes[i];
    const y = b.childNodes[i];
    if (!morph(x, y)) a.replaceChild(y.cloneNode(true), x);
  }
  return true;
}
/** replaceChildren that keeps what is already there when only values changed (no re-entrance, no flicker) */
function patchChildren(parent, next) {
  const old = [...parent.children];
  if (old.length !== next.length || old.some((o, i) => o.tagName !== next[i].tagName || o.getAttribute('class') !== next[i].getAttribute('class'))) {
    parent.replaceChildren(...next);
    return;
  }
  old.forEach((o, i) => { if (!morph(o, next[i])) parent.replaceChild(next[i], o); });
}

function toast(text) {
  const t = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

// ------------------------------------------------------------------ API
class AuthError extends Error {}

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    throw new AuthError('unauthorised');
  }
  if (!res.ok && res.status !== 304) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = j.message || j.details || msg;
    } catch { /* not JSON */ }
    throw new Error(msg);
  }
  if (raw) return res;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
const docker = (path, opts) => api(`/endpoints/${envId}/docker${path}`, opts);

async function ensureEnv() {
  if (envId !== null) return envId;
  const eps = await api('/endpoints');
  const env = eps.find((e) => e.Type === 1 || e.Type === 2) ?? eps[0];
  if (!env) throw new Error(tx('ไม่พบ Docker environment ใน Portainer'));
  envId = env.Id;
  return envId;
}

// ------------------------------------------------------------------ formatting
const fmtBytes = (b) => {
  if (!Number.isFinite(b) || b < 0) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1)} ${u[i]}`;
};
const fmtPct = (p) => (Number.isFinite(p) ? `${p < 10 ? p.toFixed(1) : Math.round(p)}%` : '–');
function ago(seconds) {
  const s = Math.max(0, Math.round(Date.now() / 1000 - seconds));
  if (s < 60) return tx('เมื่อสักครู่');
  if (s < 3600) return tx('{0} นาทีที่แล้ว', Math.floor(s / 60));
  if (s < 86400) return tx('{0} ชั่วโมงที่แล้ว', Math.floor(s / 3600));
  return tx('{0} วันที่แล้ว', Math.floor(s / 86400));
}
/** Docker's English status ("Up 3 minutes (healthy)", "Exited (0) 2 hours ago") in Thai, without the health part */
function statusText(status = '') {
  const units = [[/seconds?/, tx('วินาที')], [/minutes?/, tx('นาที')], [/hours?/, tx('ชั่วโมง')], [/days?/, tx('วัน')], [/weeks?/, tx('สัปดาห์')], [/months?/, tx('เดือน')], [/years?/, tx('ปี')]];
  const dur = (d) => {
    d = d.replace(/^About an? /i, '~1 ').replace(/^Less than a second/i, '<1 second');
    for (const [re, th] of units) d = d.replace(re, th);
    return d.replace(/^an? /i, '1 ');
  };
  const s = status.replace(/\s*\((healthy|unhealthy|health: starting)\)/, '');
  let m = /^Up (.+)$/.exec(s);
  if (m) return tx('ทำงานมา {0}', dur(m[1]));
  m = /^Exited \((\d+)\) (.+) ago$/.exec(s);
  if (m) return tx('หยุดเมื่อ {0}ที่แล้ว{1}', dur(m[2]), m[1] !== '0' ? tx(' (รหัส {0})', m[1]) : '');
  return s;
}
/**
 * How long a container has been up, from its real start time. Docker's own text is coarse ("Up 31
 * hours", then "Up 3 days" and "Up 2 months"), so the list asks each container's StartedAt once.
 * Under a day: hours · under 30 days: days and hours · from 30 days: the date and time it started.
 */
const MONTH_S = 30 * 86400;
const fmtStarted = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
function upFor(s) {
  if (s < 60) return tx('ไม่ถึงนาที');
  if (s < 3600) return tx('{0} นาที', Math.floor(s / 60));
  if (s < 86400) return tx('{0} ชั่วโมง', Math.floor(s / 3600));
  const d = Math.floor(s / 86400), hrs = Math.floor((s % 86400) / 3600);
  return hrs ? tx('{0} วัน {1} ชั่วโมง', d, hrs) : tx('{0} วัน', d);
}
/** "ทำงานมา 1 วัน 7 ชั่วโมง" or "ทำงานตั้งแต่ 15 ก.ย. 2569 10:20" */
function runningSince(startedMs) {
  const s = Math.max(0, (Date.now() - startedMs) / 1000);
  return s >= MONTH_S ? tx('ทำงานตั้งแต่ {0}', fmtStarted.format(startedMs)) : tx('ทำงานมา {0}', upFor(s));
}
/** "เมื่อ 1 วัน 7 ชั่วโมงที่แล้ว" or the date, for the detail page */
function startedText(startedMs) {
  const s = Math.max(0, (Date.now() - startedMs) / 1000);
  return s >= MONTH_S ? fmtStarted.format(startedMs) : s < 60 ? tx('เมื่อสักครู่') : tx('{0}ที่แล้ว', upFor(s));
}
/** Docker's "Up …" as a rough number of seconds, only to notice a restart since StartedAt was read */
function roughUp(status = '') {
  const m = /^Up (?:(Less than a second)|(?:About )?(an?|\d+) (second|minute|hour|day|week|month|year)s?)/.exec(status);
  if (!m) return null;
  if (m[1]) return 0;
  const n = /^an?$/.test(m[2]) ? 1 : Number(m[2]);
  return n * { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 }[m[3]];
}
const startedAt = new Map(); // container id → StartedAt (ms)
/** Fill in StartedAt for running containers that lack it or have restarted; calls back as each arrives. */
function refreshStarts(list, onStart) {
  for (const c of list) {
    if (c.State !== 'running') { startedAt.delete(c.Id); continue; }
    const known = startedAt.get(c.Id);
    const rough = roughUp(c.Status);
    const age = known ? (Date.now() - known) / 1000 : null;
    // Docker rounds down (e.g. 47 hours, then "2 days"); only a clear mismatch means a restart
    if (known && (rough === null || age < 3600 || Math.abs(age - rough) < Math.max(3600, rough * 0.6))) continue;
    docker(`/containers/${c.Id}/json`).then((full) => {
      const t = Date.parse(full?.State?.StartedAt ?? '');
      if (Number.isFinite(t)) { startedAt.set(c.Id, t); onStart(c.Id); }
    }).catch(() => {});
  }
}
const labelsOf = (c) => c.Labels ?? c.Config?.Labels ?? {};
/** container name; a rolled-out replica ("apps-expenses-4") shows under its service's name */
function nameOf(c) {
  const name = (c.Names?.[0] ?? c.Name ?? c.Id.slice(0, 12)).replace(/^\//, '');
  const num = labelsOf(c)['com.docker.compose.container-number'];
  return num && labelsOf(c)['com.docker.compose.service'] && name.endsWith(`-${num}`) ? name.slice(0, -`-${num}`.length) : name;
}

/** compose project/service → [brand mark, group] */
const SERVICES = {
  'apps/web': ['nextdotjs', tx('ฟ้าละเอียด')], 'apps/api': ['fastapi', tx('ฟ้าละเอียด')], 'apps/verify': ['python', tx('ฟ้าละเอียด')],
  'apps/weather-web-api': ['rust', tx('ฟ้าละเอียด')],
  'apps/portfolio': ['nextdotjs', 'Portfolio'], 'apps/portfolio-api': ['rust', 'Portfolio'], 'apps/media': ['bun', 'Portfolio'],
  'apps/expenses': ['nextdotjs', 'Spent/Cost'], 'apps/reminders': ['bun', 'Spent/Cost'],
  'apps/whiteboard': ['nextdotjs', 'Whiteboard'], 'apps/rooms': ['bun', 'Whiteboard'],
  'apps/drive-music': ['nextdotjs', 'Drive Music'], 'apps/sync': ['bun', 'Drive Music'],
  'apps/calorieflow': ['nextdotjs', 'CalorieFlow'],
  'apps/db': ['postgresql', tx('ฐานข้อมูล')], 'apps/rest': ['postgresql', tx('ฐานข้อมูล')], 'apps/dbgw': ['bun', tx('ฐานข้อมูล')],
  'apps/health': ['bun', tx('ระบบส่วนกลาง')], 'apps/status': ['bun', tx('ระบบส่วนกลาง')], 'apps/analytics': ['bun', tx('ระบบส่วนกลาง')], 'apps/backup': ['bun', tx('ระบบส่วนกลาง')], 'apps/chat': ['bun', tx('ระบบส่วนกลาง')],
  'server/nginx-proxy-manager': ['nginxproxymanager', tx('จัดการเซิร์ฟเวอร์')], 'server/portainer': ['portainer', tx('จัดการเซิร์ฟเวอร์')],
  'server/dock': ['nginx', tx('จัดการเซิร์ฟเวอร์')], 'server/dock-metrics': ['bun', tx('จัดการเซิร์ฟเวอร์')],
};
const GROUP_ORDER = [tx('ฟ้าละเอียด'), 'Portfolio', 'Spent/Cost', 'Whiteboard', 'Drive Music', 'CalorieFlow', tx('ฐานข้อมูล'), tx('ระบบส่วนกลาง'), tx('จัดการเซิร์ฟเวอร์')];
function serviceOf(c) {
  const l = labelsOf(c);
  const known = SERVICES[`${l['com.docker.compose.project']}/${l['com.docker.compose.service']}`];
  const brand = known?.[0] ?? 'docker';
  const stack = l['com.chakkrit.stack'];
  return { brand: brand === 'nextdotjs' && ['next-bun-elysia', 'next-bun-rust'].includes(stack) ? stack
    : (brand === 'fastapi' && stack === 'rust-python') || (brand === 'bun' && stack === 'rust') ? 'rust' : brand,
    group: known?.[1] ?? l['com.docker.compose.project'] ?? tx('อื่น ๆ') };
}
/** containers in the fixed group order (unknown groups after, by name) */
function groupContainers(list) {
  const groups = new Map();
  for (const c of [...list].sort((a, b) => nameOf(a).localeCompare(nameOf(b)))) {
    const g = serviceOf(c).group;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  const rank = (g) => { const i = GROUP_ORDER.indexOf(g); return i < 0 ? GROUP_ORDER.length : i; };
  return [...groups].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}
function brandIcon(slug) {
  const b = BRANDS[slug] ?? BRANDS.docker;
  if (b.src) return h('img', { src: b.src, class: 'brand-ic', alt: b.title });
  const svg = h('svg', { viewBox: '0 0 24 24', class: 'brand-ic', role: 'img', 'aria-label': b.title }, h('path', { d: b.path, fill: b.hex ?? 'currentColor' }));
  svg.prepend(document.createElementNS('http://www.w3.org/2000/svg', 'title'));
  svg.firstChild.textContent = b.title;
  return svg;
}
/** the brand icon at the start of a row */
function leadIcon(slug) {
  if (['next-bun-elysia', 'next-bun-rust'].includes(slug)) {
    const backend = slug === 'next-bun-rust' ? 'rust' : 'elysia';
    const title = `Next.js + Bun + ${backend === 'rust' ? 'Rust' : 'Elysia'}`;
    const marks = ['nextdotjs', 'bun', backend].map((brand) => {
      const mark = brandIcon(brand);
      mark.setAttribute('aria-hidden', 'true');
      return h('span', { class: `stack-mark stack-${brand}` }, mark);
    });
    return h('span', { class: 'brand-ic brand-lead brand-stack', role: 'img', 'aria-label': title, title }, marks);
  }
  const svg = brandIcon(slug);
  svg.classList.add('brand-lead');
  return svg;
}
const groupTag = (g, n) => h('h2', { class: 'group-tag' }, h('span', { class: 'tag-chip' }, g), h('span', { class: 'group-count' }, `${n}`));

/** running + health → dot class and a Thai word */
function stateOf(c) {
  const state = c.State?.Status ?? c.State; // inspect has an object, list a string
  const health = c.State?.Health?.Status ?? /\((healthy|unhealthy|health: starting)\)/.exec(c.Status ?? '')?.[1];
  if (state === 'running') {
    if (health === 'unhealthy') return { cls: 'bad', label: tx('ไม่ปกติ (unhealthy)') };
    if (health && health.includes('starting')) return { cls: 'warn', label: tx('กำลังเริ่ม') };
    return { cls: 'ok', label: health === 'healthy' ? tx('ปกติ (healthy)') : tx('ทำงาน') };
  }
  if (state === 'restarting') return { cls: 'warn', label: tx('กำลังรีสตาร์ท') };
  if (state === 'paused') return { cls: 'warn', label: tx('หยุดชั่วคราว') };
  if (state === 'exited' || state === 'dead') return { cls: '', label: tx('หยุดอยู่') };
  return { cls: '', label: state ?? '–' };
}

/**
 * Usage from one-shot samples (≈40 ms each instead of Docker's 2 s sampling window).
 * CPU % (of all cores) comes from the difference to the previous sample of the same container,
 * so it needs two samples; memory excludes reclaimable page cache.
 */
const lastCpu = new Map(); // container id -> { total, system }
function usage(id, s) {
  const total = s.cpu_stats?.cpu_usage?.total_usage ?? 0;
  const system = s.cpu_stats?.system_cpu_usage ?? 0;
  const cpus = s.cpu_stats?.online_cpus || s.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  const prev = lastCpu.get(id);
  lastCpu.set(id, { total, system });
  const cpu = prev && system > prev.system && total >= prev.total ? ((total - prev.total) / (system - prev.system)) * cpus * 100 : NaN;
  const ms = s.memory_stats ?? {};
  const cache = ms.stats?.inactive_file ?? ms.stats?.cache ?? 0;
  const mem = ms.usage !== undefined ? ms.usage - cache : NaN;
  let rx = 0, tx = 0;
  for (const n of Object.values(s.networks ?? {})) { rx += n.rx_bytes ?? 0; tx += n.tx_bytes ?? 0; }
  return { cpu, mem, limit: ms.limit, rx, tx };
}
const sample = (id) =>
  docker(`/containers/${id}/stats?stream=false&one-shot=true`).then((s) => usage(id, s)).catch(() => null);
/** a fresh reading; takes a second sample 1 s later when there is no earlier one to compare with */
async function stats(id) {
  const first = await sample(id);
  if (!first || Number.isFinite(first.cpu)) return first;
  await new Promise((r) => setTimeout(r, 1000));
  return (await sample(id)) ?? first;
}

// ------------------------------------------------------------------ layout
const TABS = [
  ['#/', 'pulse', tx('ภาพรวม')],
  ['#/containers', 'box', tx('คอนเทนเนอร์')],
  ['#/images', 'layers', tx('อิมเมจ')],
  ['#/volumes', 'disk', tx('วอลุ่ม')],
  ['#/web', 'chart', tx('สถิติเว็บ')],
  ['#/more', 'more', tx('เพิ่มเติม')],
];
let unread = 0; // server posts in the chat not read yet (badge on เพิ่มเติม and แชท)
function badge() {
  return h('span', { class: 'badge', 'data-unread': '', hidden: !unread }, unread > 9 ? '9+' : String(unread));
}
async function refreshUnread() {
  try { unread = (await api('/chat/unread')).count ?? 0; } catch { return; }
  for (const b of document.querySelectorAll('[data-unread]')) { b.hidden = !unread; b.textContent = unread > 9 ? '9+' : String(unread); }
}
/** tapping the tab of the page you are on scrolls it back to the top */
function tabs(current) {
  return h('nav', { class: 'tabs', 'aria-label': tx('เมนู') },
    TABS.map(([href, ic, label]) => h('a', {
      href, 'aria-current': href === current ? 'page' : false, 'data-tab-bounce': true,
      onclick: (e) => {
        if (location.hash === href || (!location.hash && href === '#/')) {
          e.preventDefault();
          window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        }
      },
    }, h('span', { class: 'tab-ic', 'data-tab-icon': true }, icon(ic), href === '#/more' ? badge() : null), h('span', { class: 'tab-label' }, label))));
}
function topBar(title, { back, onRefresh, extra } = {}) {
  const refresh = onRefresh
    ? h('button', {
        class: 'icon-btn', type: 'button', 'aria-label': tx('รีเฟรช'), title: tx('รีเฟรช'),
        onclick: async (e) => {
          const b = e.currentTarget;
          b.classList.add('spin');
          try { await onRefresh(); } finally { b.classList.remove('spin'); }
        },
      }, icon('refresh'))
    : null;
  return h('header', { class: 'top' },
    back ? h('a', { class: 'icon-btn', href: back, 'aria-label': tx('กลับ') }, icon('back')) : null,
    h('h1', {}, title),
    extra ?? null,
    refresh,
    back || !PORTAINER_URL ? null : h('a', { class: 'icon-btn', href: PORTAINER_URL, 'aria-label': tx('เปิด Portainer เต็ม'), title: tx('Portainer เต็ม'), target: '_blank', rel: 'noopener' }, icon('ext')),
    back ? null : h('button', { class: 'icon-btn', type: 'button', 'aria-label': tx('ออกจากระบบ'), title: tx('ออกจากระบบ'), onclick: logout }, icon('out')));
}
function shell(...children) {
  app.replaceChildren(h('main', { class: 'shell' }, ...children));
}
const skeleton = (n = 4) => Array.from({ length: n }, () => h('div', { class: 'skeleton' }));

// ---- skeletons shaped like each page: a bar per line of text, inside the same rows, tiles and cards,
// so the page does not jump when the data arrives. Everything with .skel goes on the first render.
const bone = (w, ht = 12, cls = '') => h('span', { class: `bone ${cls}`.trim(), style: `width:${w};height:${ht}px` });
const W = (i, ws) => `${ws[i % ws.length]}%`;
/** a .list of rows: [icon] title + sub on the left, value + sub on the right */
const skelRows = (n, { icon: ic = false, side = true } = {}) => h('div', { class: 'list skel', 'aria-hidden': 'true' },
  Array.from({ length: n }, (_, i) => h('div', { class: 'row' },
    ic ? bone('32px', 32, 'bone-ic') : null,
    h('div', { class: 'row-main' }, bone(W(i, [58, 44, 66, 50, 38]), 14), bone(W(i, [34, 26, 40, 30, 22]), 11, 'bone-sub')),
    side === 'dot' ? bone('10px', 10, 'bone-dot') : side ? h('div', { class: 'row-side' }, bone('56px', 13), bone('30px', 11, 'bone-sub')) : null)));
/** stat tiles: label, big value, sub line, and the meter where the real tile has one */
const skelTiles = (n, meter = false) => Array.from({ length: n }, (_, i) => h('div', { class: 'tile skel', 'aria-hidden': 'true' },
  bone(W(i, [46, 58, 40, 52]), 11), bone(W(i, [62, 50, 70, 44]), 22, 'bone-value'), bone(W(i, [74, 60, 82, 66]), 11, 'bone-sub'),
  meter ? bone('100%', 4, 'bone-meter') : null));
/** a chart card: its title, then the plot */
const skelCard = (plot = 150, title = '32%') => h('section', { class: 'card skel', 'aria-hidden': 'true' }, bone(title, 13), bone('100%', plot, 'bone-plot'));
/** a section heading */
const skelHeading = (w = '44%') => h('div', { class: 'skel skel-heading', 'aria-hidden': 'true' }, bone(w, 16));
/** chat: a system report, your question, an answer */
const skelChat = () => [
  h('div', { class: 'msg system skel', 'aria-hidden': 'true' }, bone('30%', 10), bone('52%', 14, 'bone-sub'), bone('88%', 11, 'bone-sub'), bone('70%', 11, 'bone-sub')),
  h('div', { class: 'msg user skel', 'aria-hidden': 'true' }, bone('120px', 12, 'bone-on-accent')),
  h('div', { class: 'msg skel', 'aria-hidden': 'true' }, bone('200px', 12), bone('150px', 12, 'bone-sub')),
];
/** drops the placeholders once the real content is in */
const clearSkel = (root) => root.querySelectorAll('.skel').forEach((e) => e.remove());

// ------------------------------------------------------------------ views
// ------------------------------------------------------------------ language and theme (this device only, see i18n.js)
const THEME_LABEL = { system: 'ตามระบบ', light: 'สว่าง', dark: 'มืด' };
function segmented(options, current, pick) {
  const box = h('div', { class: 'segmented', role: 'group' });
  box.append(...options.map(([value, label]) => h('button', {
    type: 'button', 'aria-pressed': String(value === current),
    onclick: () => {
      for (const b of box.children) b.setAttribute('aria-pressed', 'false');
      box.querySelector(`[data-v="${value}"]`)?.setAttribute('aria-pressed', 'true');
      pick(value);
    },
    'data-v': value,
  }, label)));
  return box;
}
// the sign-in page has no menu, so it gets the two pickers inline
const langPicker = () => segmented(Object.entries(LANGS), LANG, setLang);
const themePicker = () => segmented(THEMES.map((t) => [t, tx(THEME_LABEL[t])]), theme(), setTheme);
const displaySummary = () => `${LANGS[LANG]} · ${tx(THEME_LABEL[theme()])}`;

/** เพิ่มเติม → การแสดงผล: two lists to pick from, a tick on the current choice (like the other sub-pages) */
function displayView() {
  const choices = (label, options, current, pick) => {
    const list = h('div', { class: 'list', role: 'radiogroup', 'aria-label': label });
    const rows = options.map(([value, text]) => h('button', {
      type: 'button', class: 'row choice', role: 'radio', 'aria-checked': String(value === current), 'data-v': value,
      onclick: () => {
        for (const r of rows) r.setAttribute('aria-checked', String(r === rows.find((x) => x.dataset.v === value)));
        pick(value);
      },
    }, h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, text)), icon('check', 'tick')));
    list.append(...rows);
    return h('section', { class: 'group' }, h('h2', { class: 'group-title' }, label), list);
  };
  shell(topBar(tx('การแสดงผล'), { back: '#/more' }),
    choices(tx('ภาษา'), Object.entries(LANGS), LANG, setLang),
    choices(tx('ธีม'), THEMES.map((t) => [t, tx(THEME_LABEL[t])]), theme(), setTheme),
    tabs('#/more'));
}

function loginView(message = '') {
  const err = h('p', { class: 'error', role: 'alert' }, message);
  const user = h('input', { class: 'field', name: 'username', autocomplete: 'username', placeholder: tx('ชื่อผู้ใช้'), required: true, autocapitalize: 'none' });
  const pass = h('input', { class: 'field', name: 'password', type: 'password', autocomplete: 'current-password', placeholder: tx('รหัสผ่าน'), required: true });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, tx('เข้าสู่ระบบ'));
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      err.textContent = '';
      try {
        const { jwt } = await api('/auth', { method: 'POST', body: { username: user.value.trim(), password: pass.value } });
        localStorage.setItem(TOKEN_KEY, jwt);
        route();
      } catch (ex) {
        err.textContent = ex instanceof AuthError || /invalid|credential/i.test(ex.message) ? tx('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง') : tx('เข้าสู่ระบบไม่สำเร็จ: {0}', ex.message);
      } finally {
        submit.disabled = false;
      }
    },
  },
  h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('box')), 'Dock'),
  user, pass, err, submit,
  h('p', { class: 'hint' }, tx('ใช้บัญชีเดียวกับ Portainer')),
  h('div', { class: 'login-prefs' }, langPicker(), themePicker()));
  app.replaceChildren(h('main', { class: 'login' }, form));
  hideSplash();
  user.focus();
}

async function containersView(token) {
  const body = h('div', {}, skelHeading('30%'), skelRows(4, { icon: true, side: 'dot' }), skelHeading('38%'), skelRows(3, { icon: true, side: 'dot' }));
  const meta = h('p', { class: 'meta' }, bone('62%', 13, 'skel'));
  const rows = new Map(); // container id → its row and the parts that change
  const sections = new Map(); // group → its section
  const load = async () => {
    const [list, info] = await Promise.all([docker('/containers/json?all=1'), docker('/info')]);
    if (token !== viewToken) return;
    clearSkel(body); clearSkel(meta);
    refreshStarts(list, (id) => {
      const r = rows.get(id);
      if (token === viewToken && r?.st && r.c?.State === 'running') setText(r.sub, `${r.st.label} · ${runningSince(startedAt.get(id))}`);
    });
    const running = list.filter((c) => c.State === 'running');
    const metaText = tx('{0}/{1}| ทำงาน · {2} CPU · {3} · {4}', running.length, list.length, info.NCPU, fmtBytes(info.MemTotal), info.OperatingSystem);
    if (meta.dataset.v !== metaText) {
      meta.dataset.v = metaText;
      meta.replaceChildren(h('b', {}, `${running.length}/${list.length}`), tx(' ทำงาน · '), `${info.NCPU} CPU · ${fmtBytes(info.MemTotal)} · ${info.OperatingSystem}`);
    }
    // grouped by the app they belong to. Rows are made once and then only their changed text is
    // touched, so a refresh never blanks the CPU / RAM numbers (no flicker).
    if (!list.length) { body.replaceChildren(h('div', { class: 'list' }, h('p', { class: 'empty' }, tx('ยังไม่มีคอนเทนเนอร์')))); return; }
    const groups = groupContainers(list);
    const seen = new Set();
    const order = groups.map(([g, cs]) => {
      let sec = sections.get(g);
      if (!sec) {
        const tag = groupTag(g, cs.length);
        const listEl = h('div', { class: 'list' });
        sec = { el: h('section', { class: 'group' }, tag, listEl), list: listEl, count: tag.querySelector('.group-count') };
        sections.set(g, sec);
      }
      setText(sec.count, `${cs.length}`);
      cs.forEach((c, i) => {
        seen.add(c.Id);
        const st = stateOf(c);
        let r = rows.get(c.Id);
        if (!r) {
          const dot = h('span', {});
          const sub = h('span', { class: 'row-sub' });
          const side = h('span', { class: 'row-side' }, h('b', {}), h('span', {}));
          // the service's icon leads the row; the state dot follows the name
          r = { el: h('a', { class: 'row', href: `#/c/${c.Id}` }, leadIcon(serviceOf(c).brand),
            h('span', { class: 'row-main' }, h('span', { class: 'row-title name-with-ic' }, h('span', { class: 'name-text' }, nameOf(c)), dot), sub),
            side, icon('chev', 'chev')), dot, sub, cpu: side.firstChild, mem: side.lastChild };
          rows.set(c.Id, r);
        }
        if (r.dot.getAttribute('class') !== `dot ${st.cls}`) r.dot.setAttribute('class', `dot ${st.cls}`);
        r.dot.title = st.label;
        r.c = c; r.st = st;
        const started = c.State === 'running' ? startedAt.get(c.Id) : null;
        setText(r.sub, `${st.label} · ${started ? runningSince(started) : statusText(c.Status)}`);
        if (c.State !== 'running') { setText(r.cpu, ''); setText(r.mem, ''); }
        if (sec.list.children[i] !== r.el) sec.list.insertBefore(r.el, sec.list.children[i] ?? null); // moves only what is out of place
      });
      while (sec.list.children.length > cs.length) sec.list.lastChild.remove();
      return sec.el;
    });
    for (const [id, r] of rows) if (!seen.has(id)) { r.el.remove(); rows.delete(id); }
    order.forEach((el, i) => { if (body.children[i] !== el) body.insertBefore(el, body.children[i] ?? null); });
    while (body.children.length > order.length) body.lastChild.remove();
    // usage per running container (one-shot samples, in parallel); the old numbers stay until the new ones arrive
    await Promise.all(running.map(async (c) => {
      const u = await stats(c.Id);
      const r = rows.get(c.Id);
      if (token !== viewToken || !u || !r) return;
      setNumber(r.cpu, fmtPct(u.cpu));
      setNumber(r.mem, fmtBytes(u.mem));
    }));
  };
  shell(topBar(tx('คอนเทนเนอร์'), { onRefresh: load }), meta, body, tabs('#/containers'));
  await load();
  if (token !== viewToken) return; // navigated away while loading: do not start a timer for an old view
  timer = setInterval(() => document.visibilityState === 'visible' && load().catch(handleError), LIST_REFRESH_MS);
}

/** "tap again to confirm" for actions that interrupt a service */
function confirmButton(label, armedLabel, run, { danger = false, disabled = false } = {}) {
  let armed = 0;
  const b = h('button', {
    class: `btn${danger ? ' danger' : ''}`, type: 'button', disabled,
    onclick: async () => {
      if (!armed) {
        b.classList.add('armed');
        b.textContent = armedLabel;
        armed = setTimeout(() => { armed = 0; b.classList.remove('armed'); b.textContent = label; }, 3000);
        return;
      }
      clearTimeout(armed);
      armed = 0;
      b.classList.remove('armed');
      b.disabled = true;
      b.textContent = tx('กำลังทำ…');
      try { await run(); } finally { b.disabled = false; b.textContent = label; }
    },
  }, label);
  return b;
}

/** Docker's multiplexed log stream (non-TTY): 8-byte frame headers [stream,0,0,0,len(4)] */
function parseLogs(buf, tty) {
  const bytes = new Uint8Array(buf);
  const dec = new TextDecoder();
  const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  if (tty) return strip(dec.decode(bytes)).split('\n').map((t) => ({ t, err: false }));
  const out = [];
  let i = 0;
  while (i + 8 <= bytes.length) {
    const stream = bytes[i];
    const len = (bytes[i + 4] << 24) | (bytes[i + 5] << 16) | (bytes[i + 6] << 8) | bytes[i + 7];
    const chunk = strip(dec.decode(bytes.subarray(i + 8, i + 8 + len)));
    for (const t of chunk.replace(/\n$/, '').split('\n')) out.push({ t, err: stream === 2 });
    i += 8 + len;
  }
  return out;
}

async function containerView(token, id) {
  // the page's shape while its details load (the list used to stay up until they came)
  const stat = (i) => h('div', { class: 'stat skel', 'aria-hidden': 'true' }, bone(W(i, [40, 64, 56]), 11), bone(W(i, [62, 74, 70]), 20, 'bone-value'));
  shell(
    topBar(bone('52%', 22), { back: '#/containers' }),
    h('p', { class: 'meta' }, bone('132px', 28, 'bone-pill')),
    h('div', { class: 'actions', 'aria-hidden': 'true' }, bone('100%', 44, 'bone-btn'), bone('100%', 44, 'bone-btn')),
    h('div', { class: 'stats' }, stat(0), stat(1), stat(2)),
    skelHeading('34%'), h('div', { class: 'mini-grid' }, skelCard(140, '16%'), skelCard(140, '30%')),
    tabs('#/containers'));
  const c = await docker(`/containers/${id}/json`);
  if (token !== viewToken) return;
  const name = nameOf(c);
  const st = stateOf(c);
  const running = c.State.Running;
  const guarded = PROTECTED.has(name);

  const act = async (verb, done) => {
    await docker(`/containers/${id}/${verb}`, { method: 'POST' });
    toast(done);
    route();
  };
  const actions = h('div', { class: 'actions' },
    running
      ? confirmButton(tx('หยุด'), tx('ยืนยันหยุด?'), () => act('stop', tx('หยุด {0} แล้ว', name)), { danger: true, disabled: guarded })
      : h('button', { class: 'btn primary', type: 'button', onclick: (e) => { e.currentTarget.disabled = true; act('start', tx('เริ่ม {0} แล้ว', name)).catch(handleError); } }, tx('เริ่ม')),
    running ? confirmButton(tx('รีสตาร์ท'), tx('ยืนยันรีสตาร์ท?'), () => act('restart', tx('รีสตาร์ท {0} แล้ว', name))) : null);

  const statBox = (label, value, sub) => h('div', { class: 'stat' }, h('span', {}, label), h('b', {}, value), sub ? h('small', {}, sub) : null);
  const statsEl = h('div', { class: 'stats' }, statBox('CPU', '…'), statBox(tx('หน่วยความจำ'), '…'), statBox(tx('เครือข่าย'), '…'));

  const ports = Object.entries(c.NetworkSettings?.Ports ?? {})
    .map(([p, binds]) => (binds?.length ? binds.map((b) => `${b.HostIp || '0.0.0.0'}:${b.HostPort} → ${p}`).join(', ') : p));
  const mounts = (c.Mounts ?? []).map((m) => `${m.Name || m.Source} → ${m.Destination}${m.RW ? '' : ' (ro)'}`);
  const kv = (pairs) => h('div', { class: 'list' }, h('dl', { class: 'kv' }, pairs.filter(([, v]) => v).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
  const info = kv([
    [tx('อิมเมจ'), c.Config.Image],
    [tx('สร้างเมื่อ'), ago(Date.parse(c.Created) / 1000)],
    [tx('เริ่มเมื่อ'), running ? startedText(Date.parse(c.State.StartedAt)) : null],
    [tx('รีสตาร์ทอัตโนมัติ'), c.HostConfig?.RestartPolicy?.Name || 'no'],
    [tx('พอร์ต'), ports.join('\n') || tx('ภายในเท่านั้น')],
    [tx('เครือข่าย'), Object.keys(c.NetworkSettings?.Networks ?? {}).join(', ')],
    [tx('ข้อมูลที่เมานต์'), mounts.join('\n')],
  ]);

  const logsEl = h('pre', { class: 'logs', tabindex: '0', 'aria-label': 'log' }, tx('กำลังโหลด…'));
  const follow = h('input', { type: 'checkbox', checked: true });
  const loadLogs = async () => {
    const res = await docker(`/containers/${id}/logs?stdout=1&stderr=1&tail=300`, { raw: true });
    const lines = parseLogs(await res.arrayBuffer(), c.Config.Tty);
    if (token !== viewToken) return;
    const atBottom = logsEl.scrollHeight - logsEl.scrollTop - logsEl.clientHeight < 40;
    logsEl.replaceChildren(...(lines.length ? lines.map((l) => (l.err ? h('span', { class: 'err' }, `${l.t}\n`) : `${l.t}\n`)) : [tx('(ไม่มี log)')]));
    if (atBottom || logsEl.dataset.first !== '1') { logsEl.scrollTop = logsEl.scrollHeight; logsEl.dataset.first = '1'; }
  };
  const loadStats = async () => {
    if (!running) { patchChildren(statsEl, [statBox(tx('สถานะ'), tx('หยุดอยู่'), c.State.FinishedAt ? ago(Date.parse(c.State.FinishedAt) / 1000) : '')]); return; }
    const u = await stats(id);
    if (token !== viewToken || !u) return;
    patchChildren(statsEl, [
      statBox('CPU', fmtPct(u.cpu)),
      statBox(tx('หน่วยความจำ'), fmtBytes(u.mem), u.limit ? tx('จาก {0}', fmtBytes(u.limit)) : ''),
      statBox(tx('เครือข่าย'), `↓ ${fmtBytes(u.rx)}`, `↑ ${fmtBytes(u.tx)}`)]);
  };

  // CPU / RAM history of this container from dock-metrics (last hour)
  const history = h('section', { class: 'group' }, h('h2', { class: 'group-title' }, tx('ย้อนหลัง 1 ชั่วโมง')));
  const histGrid = h('div', { class: 'mini-grid' });
  history.append(histGrid);
  let histCharts = null;
  const loadHistory = async () => {
    const mx = await metrics('1h').catch(() => null);
    const c = mx?.containers?.[id.slice(0, 12)];
    if (token !== viewToken) return;
    if (!c) { history.hidden = true; return; }
    history.hidden = false;
    const cpu = { times: mx.times, series: [{ name: 'CPU', color: 'var(--s1)', values: c.cpu ?? [] }], kind: 'area', format: (v) => fmtPct(v), step: mx.step };
    const mem = { times: mx.times, series: [{ name: tx('หน่วยความจำ'), color: 'var(--s2)', values: c.mem ?? [] }], kind: 'area', format: (v) => fmtBytes(v), step: mx.step };
    if (!histCharts) {
      const a = h('div', { class: 'card' }, h('h3', { class: 'card-title' }, 'CPU'));
      const b = h('div', { class: 'card' }, h('h3', { class: 'card-title' }, tx('หน่วยความจำ')));
      histGrid.append(a, b);
      histCharts = [mkChart(a, { ...cpu, label: tx('CPU ของ {0}', name), height: 140 }), mkChart(b, { ...mem, label: tx('หน่วยความจำของ {0}', name), height: 140 })];
    } else {
      histCharts[0].update(cpu);
      histCharts[1].update(mem);
    }
  };

  shell(
    topBar(name, { back: '#/containers', onRefresh: () => Promise.all([loadStats(), loadLogs(), loadHistory()]) }),
    h('p', { class: 'meta' }, h('span', { class: 'pill' }, h('span', { class: `dot ${st.cls}` }), st.label)),
    actions,
    guarded && running ? h('p', { class: 'note' }, tx('หยุดไม่ได้จากที่นี่ — ถ้าหยุดจะเข้าหน้านี้ไม่ได้ (รีสตาร์ทได้)')) : null,
    statsEl,
    history,
    h('section', { class: 'group' },
      h('div', { class: 'logs-head' }, h('h2', { class: 'group-title' }, tx('Log ล่าสุด')), h('label', { class: 'switch' }, follow, tx('อัปเดตอัตโนมัติ'))),
      logsEl),
    h('section', { class: 'group' }, h('h2', { class: 'group-title' }, tx('ข้อมูล')), info),
    tabs('#/containers'));
  await Promise.all([loadStats(), loadLogs(), loadHistory()]);
  if (token !== viewToken) return; // navigated away while loading
  let n = 0;
  timer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (follow.checked) loadLogs().catch(handleError);
    if (++n % 2 === 0) loadStats().catch(handleError);
    if (n % 4 === 0) loadHistory().catch(handleError);
  }, LOG_REFRESH_MS);
}

/** Base images the repository's Dockerfiles build FROM (build-bases.json, from deploy/dock/build-bases.mjs). */
let buildBases;
const loadBuildBases = async () => {
  buildBases ??= fetch('build-bases.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);
  return buildBases;
};

/** The build base an image is, matched by digest (or by tag for an unpinned base). */
function buildBaseOf(image, bases) {
  const digests = new Set([image.Id, ...(image.RepoDigests ?? []).map((d) => d.split('@')[1])]);
  return bases.find((b) => (b.digest ? digests.has(b.digest) : image.RepoTags?.includes(b.ref)));
}

async function imagesView(token) {
  const body = h('div', {}, skelRows(8));
  const meta = h('p', { class: 'meta' }, bone('34%', 13, 'skel'));
  const load = async () => {
    const [df, bases] = await Promise.all([docker('/system/df'), loadBuildBases()]);
    if (token !== viewToken) return;
    const images = [...(df.Images ?? [])].sort((a, b) => b.Size - a.Size);
    const total = images.reduce((s, i) => s + i.Size, 0);
    const base = new Map(images.map((i) => [i.Id, buildBaseOf(i, bases)]));
    const unused = images.filter((i) => !i.Containers && !base.get(i.Id)).length;
    const forBuild = images.filter((i) => !i.Containers && base.get(i.Id)).length;
    meta.replaceChildren(h('b', {}, `${images.length}`), tx(' อิมเมจ · {0}', fmtBytes(total)),
      unused ? tx(' · ไม่ได้ใช้ {0}', unused) : '', forBuild ? tx(' · ฐาน build {0}', forBuild) : '');
    body.replaceChildren(h('div', { class: 'list' }, images.length
      ? images.map((i) => {
          const b = base.get(i.Id);
          // a base pulled by digest only has the digest as its tag; its Dockerfile names it better
          const tag = (b && b.digest ? b.ref : null)
            ?? i.RepoTags?.find((t) => t !== '<none>:<none>') ?? i.Id.replace('sha256:', '').slice(0, 12);
          const label = i.Containers ? '' : b ? tx('ใช้ build') : tx('ไม่ได้ใช้');
          return h('div', { class: 'row' },
            h('span', { class: 'row-main' },
              h('span', { class: 'row-title', title: b ? b.files.join('\n') : null }, tag),
              h('span', { class: 'row-sub' }, `${ago(i.Created)}${label ? ' · ' : ''}`, label ? h('span', { class: 'tag' }, label) : '')),
            h('span', { class: 'row-side' }, h('b', {}, fmtBytes(i.Size)), i.Containers ? tx('ใช้ {0}', i.Containers) : ''));
        })
      : h('p', { class: 'empty' }, tx('ไม่มีอิมเมจ'))));
  };
  shell(topBar(tx('อิมเมจ'), { onRefresh: load }), meta, body, tabs('#/images'));
  await load();
}

async function volumesView(token) {
  const body = h('div', {}, skelRows(6));
  const meta = h('p', { class: 'meta' }, bone('34%', 13, 'skel'));
  const load = async () => {
    const df = await docker('/system/df');
    if (token !== viewToken) return;
    const vols = [...(df.Volumes ?? [])].sort((a, b) => (b.UsageData?.Size ?? 0) - (a.UsageData?.Size ?? 0));
    const total = vols.reduce((s, v) => s + Math.max(0, v.UsageData?.Size ?? 0), 0);
    meta.replaceChildren(h('b', {}, `${vols.length}`), tx(' วอลุ่ม · {0}', fmtBytes(total)));
    body.replaceChildren(h('div', { class: 'list' }, vols.length
      ? vols.map((v) => {
          const refs = v.UsageData?.RefCount ?? 0;
          return h('div', { class: 'row' },
            h('span', { class: 'row-main' },
              h('span', { class: 'row-title' }, v.Name),
              h('span', { class: 'row-sub' }, refs ? tx('ใช้โดย {0} คอนเทนเนอร์', refs) : tx('ไม่ได้ใช้'))),
            h('span', { class: 'row-side' }, h('b', {}, fmtBytes(v.UsageData?.Size ?? NaN))));
        })
      : h('p', { class: 'empty' }, tx('ไม่มีวอลุ่ม'))));
  };
  shell(topBar(tx('วอลุ่ม'), { onRefresh: load }), meta, body, tabs('#/volumes'));
  await load();
}


// ------------------------------------------------------------------ overview (host, proxy traffic, containers)
const metrics = (range) => api(`/metrics?range=${range}`);
const RANGES = [['1h', tx('1 ชม.'), 10_000], ['24h', tx('24 ชม.'), 60_000], ['7d', tx('7 วัน'), 300_000]];
const fmtRate = (b, short) => (Number.isFinite(b) ? `${fmtBytes(b)}${short ? '' : '/s'}` : '–');
const fmtNum = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString(LOCALE) : '–');
const lastOf = (col) => (col ? [...col].reverse().find((v) => v !== null && v !== undefined) : undefined);
const avgOf = (col) => {
  const v = (col ?? []).filter((x) => x !== null && x !== undefined);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
};
const sumOf = (col) => (col ?? []).reduce((a, b) => a + (b ?? 0), 0);
const maxOf = (col) => Math.max(...(col ?? []).filter((x) => x !== null && x !== undefined), 0);
function uptimeText(sec) {
  const d = Math.floor(sec / 86400);
  const hrs = Math.floor((sec % 86400) / 3600);
  const min = Math.floor((sec % 3600) / 60);
  return d ? tx('{0} วัน {1} ชม.', d, hrs) : hrs ? tx('{0} ชม. {1} นาที', hrs, min) : tx('{0} นาที', min);
}
const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];
let overviewRange = (() => {
  try { return localStorage.getItem('dock.range') || '1h'; } catch { return '1h'; }
})();

function tile(label, value, sub, pct, tone) {
  return h('div', { class: 'tile' },
    h('span', { class: 'tile-label' }, label),
    h('span', { class: 'tile-value' }, value),
    sub ? h('span', { class: 'tile-sub' }, sub) : null,
    Number.isFinite(pct) ? h('span', { class: 'meter', role: 'meter', 'aria-valuenow': Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': label },
      h('span', { class: `meter-fill${tone ? ` ${tone}` : ''}`, style: `width:${Math.min(100, Math.max(0, pct)).toFixed(1)}%` })) : null);
}
const pctTone = (p) => (p >= 90 ? 'bad' : p >= 75 ? 'warn' : '');
const card = (title, sub, ...children) =>
  h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { class: 'card-title' }, title), sub ? h('span', { class: 'card-sub' }, sub) : null), ...children);

async function overviewView(token) {
  const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': tx('ช่วงเวลา') },
    RANGES.map(([r, label]) => h('button', {
      type: 'button', 'aria-pressed': r === overviewRange ? 'true' : 'false',
      onclick: () => {
        overviewRange = r;
        try { localStorage.setItem('dock.range', r); } catch { /* ignore */ }
        route();
      },
    }, label)));
  const live = h('span', { class: 'live' }, h('span', { class: 'dot ok' }), tx('สด'));
  const hostLine = h('p', { class: 'meta' }, bone('92%', 13, 'skel'), bone('58%', 13, 'skel bone-sub'));
  const hostTiles = h('div', { class: 'tiles' }, skelTiles(6, true));
  const chartsGrid = h('div', { class: 'grid' }, skelCard(170, '22%'));
  const secTitle = h('h2', { class: 'section-title sec-title', hidden: true }, h('a', { href: '#/security' }, tx('ความปลอดภัย'), icon('chev', 'chev')));
  const secBox = h('div', { class: 'sec-cats', hidden: true });
  const ngTiles = h('div', { class: 'tiles' }, skelTiles(4));
  const ngGrid = h('div', { class: 'grid' }, skelCard(150, '40%'));
  const ngTables = h('div', { class: 'grid' });
  const ctrGrid = h('div', { class: 'ctr-groups' }, skelRows(4, { icon: true, side: 'dot' }));
  const groupGrids = new Map(); // group → { section, grid }
  const ctrMem = h('div', { class: 'grid' });
  const body = h('div', { class: 'overview' },
    h('div', { class: 'filters' }, seg, live),
    hostLine, hostTiles, secTitle, secBox, chartsGrid,
    h('h2', { class: 'section-title' }, tx('ทราฟฟิกเว็บ (Nginx Proxy Manager)')), ngTiles, ngGrid, ngTables,
    h('h2', { class: 'section-title' }, tx('คอนเทนเนอร์')), ctrMem, ctrGrid);
  shell(topBar(tx('ภาพรวม'), { onRefresh: () => load() }), body, tabs('#/'));
  app.querySelector('.shell').classList.add('wide');

  const C = {}; // chart handles, created on first data
  const ctrCards = new Map();
  const load = async () => {
    body.classList.add('loading');
    // the security cards are extra: an error there (or an older collector) must not break the overview
    const sec = api('/security').catch(() => null);
    const [mx, list] = await Promise.all([metrics(overviewRange), docker('/containers/json?all=1')]);
    if (token !== viewToken) return;
    body.classList.remove('loading');
    clearSkel(body);
    const { times, step, host: hs, snapshot: sn } = mx;
    sec.then((s) => {
      if (token !== viewToken || !s?.enabled) return;
      secTitle.hidden = false;
      secBox.hidden = false;
      patchChildren(secBox, secCards(s));
    });
    const T = { times, step };

    // ---- host line + tiles
    hostLine.replaceChildren(h('b', {}, sn.hostname), tx(' · {0} · เคอร์เนล {1} · เปิดเครื่องมา {2} · {3} CPU · โปรเซส {4}', sn.os, sn.kernel, uptimeText(sn.uptime_s), sn.cpus, String(sn.procs).split('/')[1] ?? '–'));
    const cpuNow = (lastOf(hs.cpu_user) ?? 0) + (lastOf(hs.cpu_system) ?? 0) + (lastOf(hs.cpu_iowait) ?? 0);
    const cpuAvg = avgOf((hs.cpu_user ?? []).map((v, i) => (v === null ? null : v + (hs.cpu_system?.[i] ?? 0) + (hs.cpu_iowait?.[i] ?? 0))));
    const memUsed = sn.mem_total - sn.mem_available;
    const memPct = (memUsed / sn.mem_total) * 100;
    const diskPct = (sn.disk_used / sn.disk_total) * 100;
    const swapUsed = sn.swap_total - sn.swap_free;
    patchChildren(hostTiles, [
      tile(tx('CPU ตอนนี้'), fmtPct(cpuNow), tx('เฉลี่ยช่วงนี้ {0} · สูงสุด {1}', fmtPct(cpuAvg), fmtPct(maxOf((hs.cpu_user ?? []).map((v, i) => (v ?? 0) + (hs.cpu_system?.[i] ?? 0) + (hs.cpu_iowait?.[i] ?? 0))))), cpuNow, pctTone(cpuNow)),
      tile(tx('หน่วยความจำ'), fmtBytes(memUsed), tx('จาก {0} · {1}', fmtBytes(sn.mem_total), fmtPct(memPct)), memPct, pctTone(memPct)),
      tile(tx('ดิสก์'), fmtBytes(sn.disk_used), tx('ว่าง {0} จาก {1}', fmtBytes(sn.disk_free), fmtBytes(sn.disk_total)), diskPct, pctTone(diskPct)),
      tile(tx('Load (1 นาที)'), sn.load[0].toFixed(2), tx('5 นาที {0} · 15 นาที {1} · เต็ม = {2}.00', sn.load[1].toFixed(2), sn.load[2].toFixed(2), sn.cpus), (sn.load[0] / sn.cpus) * 100, pctTone((sn.load[0] / sn.cpus) * 100)),
      tile(tx('เครือข่ายตอนนี้'), `↓ ${fmtRate(lastOf(hs.net_rx))}`, `↑ ${fmtRate(lastOf(hs.net_tx))}`),
      tile('Swap', fmtBytes(swapUsed), tx('จาก {0}', fmtBytes(sn.swap_total)), sn.swap_total ? (swapUsed / sn.swap_total) * 100 : NaN, ''),
    ]);

    // ---- host charts
    const hostCharts = [
      ['cpu', 'CPU', tx('% ของทุกคอร์'), { ...T, kind: 'stack', max: 100, format: (v) => fmtPct(v),
        series: [
          { name: tx('ผู้ใช้ (user)'), color: SERIES[0], values: hs.cpu_user ?? [] },
          { name: tx('ระบบ (system)'), color: SERIES[1], values: hs.cpu_system ?? [] },
          { name: tx('รอดิสก์ (iowait)'), color: SERIES[2], values: hs.cpu_iowait ?? [] },
        ] }],
      ['mem', tx('หน่วยความจำ'), tx('ทั้งหมด {0}', fmtBytes(sn.mem_total)), { ...T, kind: 'stack', format: (v) => fmtBytes(v), ref: { value: sn.mem_total, label: tx('ทั้งหมด') },
        series: [
          { name: tx('ใช้งาน'), color: SERIES[0], values: hs.mem_used ?? [] },
          { name: tx('แคช (คืนได้)'), color: SERIES[2], values: hs.mem_cache ?? [] },
        ] }],
      ['net', tx('เครือข่าย'), tx('ไบต์ต่อวินาที'), { ...T, kind: 'line', format: (v, axis) => fmtRate(v, axis),
        series: [
          { name: tx('รับ ↓'), color: SERIES[0], values: hs.net_rx ?? [] },
          { name: tx('ส่ง ↑'), color: SERIES[1], values: hs.net_tx ?? [] },
        ] }],
      ['disk', tx('ดิสก์ I/O'), tx('ไบต์ต่อวินาที'), { ...T, kind: 'line', format: (v, axis) => fmtRate(v, axis),
        series: [
          { name: tx('อ่าน'), color: SERIES[0], values: hs.disk_rd ?? [] },
          { name: tx('เขียน'), color: SERIES[1], values: hs.disk_wr ?? [] },
        ] }],
      ['load', tx('Load average (1 นาที)'), tx('เส้นอ้างอิง = {0} CPU', sn.cpus), { ...T, kind: 'area', format: (v) => v.toFixed(2), ref: { value: sn.cpus, label: `${sn.cpus} CPU` },
        series: [{ name: 'Load', color: SERIES[0], values: hs.load1 ?? [] }] }],
      ['swap', tx('Swap ที่ใช้'), tx('ทั้งหมด {0}', fmtBytes(sn.swap_total)), { ...T, kind: 'area', format: (v) => fmtBytes(v),
        series: [{ name: 'Swap', color: SERIES[6], values: hs.swap_used ?? [] }] }],
    ];
    for (const [key, title, sub, opts] of hostCharts) {
      if (!C[key]) {
        const c = card(title, sub);
        chartsGrid.append(c);
        C[key] = mkChart(c, { ...opts, label: title });
      } else C[key].update(opts);
    }

    // ---- proxy traffic
    const ng = mx.nginx ?? {};
    const hosts = Object.keys(ng).filter((k) => k !== 'all').sort((a, b) => sumOf(ng[b].req) - sumOf(ng[a].req));
    const allReq = hosts.reduce((s2, k) => s2 + sumOf(ng[k].req), 0);
    const cls = (c) => sumOf(ng.all?.[c]);
    const errors = cls('s4') + cls('s5');
    const bytes = hosts.reduce((s2, k) => s2 + sumOf(ng[k].bytes), 0);
    const spanMin = (times.length * step) / 60;
    patchChildren(ngTiles, [
      tile(tx('คำขอทั้งหมด'), fmtNum(allReq), tx('เฉลี่ย {0} ต่อนาที', (allReq / spanMin).toFixed(1))),
      tile(tx('ผู้เข้าชม (IP ไม่ซ้ำ)'), fmtNum(mx.top?.unique_clients), tx('นับจาก log ของ proxy')),
      tile(tx('ข้อผิดพลาด 4xx / 5xx'), `${fmtNum(cls('s4'))} / ${fmtNum(cls('s5'))}`, allReq ? tx('{0}% ของคำขอ', ((errors / allReq) * 100).toFixed(1)) : '–', allReq ? (errors / allReq) * 100 : NaN, errors / Math.max(1, allReq) > 0.05 ? 'warn' : ''),
      tile(tx('ข้อมูลที่ส่งออก'), fmtBytes(bytes), tx('body ของ response')),
    ]);
    const short = (hn) => hn.replace(/\.chakkritton\.com$/, '');
    const reqOpts = { ...T, kind: 'columns', legend: 'sum', format: (v) => fmtNum(v),
      series: hosts.map((k, i) => ({ name: short(k), color: SERIES[i % SERIES.length], values: ng[k].req ?? [] })) };
    const statusOpts = { ...T, kind: 'columns', legend: 'sum', format: (v) => fmtNum(v),
      series: [
        { name: tx('2xx สำเร็จ'), color: 'var(--good)', values: ng.all?.s2 ?? [] },
        { name: tx('3xx เปลี่ยนเส้นทาง'), color: 'var(--neutral)', values: ng.all?.s3 ?? [] },
        { name: tx('4xx คำขอผิด'), color: 'var(--warning)', values: ng.all?.s4 ?? [] },
        { name: tx('5xx เซิร์ฟเวอร์ผิดพลาด'), color: 'var(--critical)', values: ng.all?.s5 ?? [] },
      ] };
    const bwOpts = { ...T, kind: 'stack', legend: 'sum', format: (v) => fmtBytes(v),
      series: hosts.map((k, i) => ({ name: short(k), color: SERIES[i % SERIES.length], values: ng[k].bytes ?? [] })) };
    for (const [key, title, sub, opts] of [
      ['req', tx('คำขอตามเว็บไซต์'), tx('จำนวนต่อช่วง'), reqOpts],
      ['status', tx('สถานะ HTTP'), tx('ทุกเว็บไซต์'), statusOpts],
      ['bw', tx('ข้อมูลที่ส่งออกตามเว็บไซต์'), tx('ไบต์ต่อช่วง'), bwOpts],
    ]) {
      if (!C[key]) {
        const c = card(title, sub);
        ngGrid.append(c);
        C[key] = mkChart(c, { ...opts, label: title });
      } else C[key].update(opts);
    }
    // per-site table + top paths
    const siteRows = hosts.map((k) => {
      const req = sumOf(ng[k].req);
      const err = sumOf(ng[k].s4) + sumOf(ng[k].s5);
      return h('tr', {},
        h('td', {}, short(k)),
        h('td', { class: 'num' }, fmtNum(req)),
        h('td', { class: 'num' }, req ? `${((err / req) * 100).toFixed(1)}%` : '–'),
        h('td', { class: 'num' }, fmtBytes(sumOf(ng[k].bytes))),
        h('td', { class: 'bar-cell' }, h('span', { class: 'share', style: `width:${allReq ? ((req / allReq) * 100).toFixed(1) : 0}%` })));
    });
    const pathRows = (mx.top?.paths ?? []).map((p) => h('tr', {},
      h('td', {}, short(p.host)),
      h('td', { class: 'mono' }, `${p.method} ${p.path}`),
      h('td', { class: 'num' }, fmtNum(p.count))));
    patchChildren(ngTables, [
      card(tx('สรุปตามเว็บไซต์'), null, h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('tr', {}, h('th', {}, tx('เว็บไซต์')), h('th', { class: 'num' }, tx('คำขอ')), h('th', { class: 'num' }, tx('ผิดพลาด')), h('th', { class: 'num' }, tx('ส่งออก')), h('th', {}, tx('สัดส่วน'))),
        siteRows))),
      card(tx('หน้าที่ถูกเรียกมากที่สุด'), tx('ไม่รวมไฟล์ static'), h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('tr', {}, h('th', {}, tx('เว็บไซต์')), h('th', {}, tx('คำขอ')), h('th', { class: 'num' }, tx('ครั้ง'))),
        pathRows.length ? pathRows : h('tr', {}, h('td', { colspan: 3 }, tx('ยังไม่มีข้อมูล'))))))]);

    // ---- containers: memory stack + small multiples
    const names = new Map(list.map((c) => [c.Id.slice(0, 12), { name: nameOf(c), c }]));
    const ids = Object.keys(mx.containers ?? {}).filter((id) => names.has(id)).sort((a, b) => names.get(a).name.localeCompare(names.get(b).name));
    const color = (i) => SERIES[i % SERIES.length];
    const memOpts = { ...T, kind: 'stack', format: (v) => fmtBytes(v), ref: { value: sn.mem_total, label: tx('RAM ทั้งเครื่อง') },
      series: ids.map((id, i) => ({ name: names.get(id).name, color: color(i), values: mx.containers[id].mem ?? [] })) };
    const cpuOpts = { ...T, kind: 'line', format: (v) => fmtPct(v),
      series: ids.map((id, i) => ({ name: names.get(id).name, color: color(i), values: mx.containers[id].cpu ?? [] })) };
    for (const [key, title, sub, opts] of [
      ['cmem', tx('หน่วยความจำต่อคอนเทนเนอร์'), tx('ซ้อนกัน = รวมทั้งหมด'), memOpts],
      ['ccpu', tx('CPU ต่อคอนเทนเนอร์'), tx('% ของทุกคอร์'), cpuOpts],
    ]) {
      if (!C[key]) {
        const c = card(title, sub);
        ctrMem.append(c);
        C[key] = mkChart(c, { ...opts, label: title });
      } else C[key].update(opts);
    }
    // one titled grid per app group, in the fixed order
    const order = groupContainers(ids.map((id) => names.get(id).c)).map(([g]) => g);
    for (const g of order) {
      if (!groupGrids.has(g)) {
        const grid = h('div', { class: 'grid grid-3' });
        const section = h('section', { class: 'ctr-group' }, groupTag(g, 0), grid);
        groupGrids.set(g, { section, grid });
      }
    }
    // re-attaching a section would replay its entrance, so only out-of-place ones move
    order.forEach((g, i) => { const el = groupGrids.get(g).section; if (ctrGrid.children[i] !== el) ctrGrid.insertBefore(el, ctrGrid.children[i] ?? null); });
    while (ctrGrid.children.length > order.length) ctrGrid.lastChild.remove();
    for (const g of order) {
      const n = ids.filter((id) => serviceOf(names.get(id).c).group === g).length;
      groupGrids.get(g).section.querySelector('.group-count').textContent = `${n}`;
    }
    ids.forEach((id, i) => {
      const { name, c } = names.get(id);
      const d = mx.containers[id];
      const st = stateOf(c);
      const values = [fmtPct(lastOf(d.cpu)), fmtBytes(lastOf(d.mem)), fmtRate(lastOf(d.rx), true), fmtRate(lastOf(d.wr), true)];
      const cpuO = { ...T, kind: 'area', compact: true, format: (v) => fmtPct(v), series: [{ name: 'CPU', color: color(i), values: d.cpu ?? [] }] };
      const memO = { ...T, kind: 'area', compact: true, format: (v) => fmtBytes(v), series: [{ name: 'RAM', color: color(i), values: d.mem ?? [] }] };
      let e = ctrCards.get(id);
      if (!e) {
        const head = h('a', { class: 'mini-head', href: `#/c/${c.Id}` }, leadIcon(serviceOf(c).brand),
          h('span', { class: 'row-title name-with-ic' }, h('span', { class: 'name-text' }, name), h('span', { class: `dot ${st.cls}`, title: st.label })), icon('chev', 'chev'));
        const stWrap = h('div', { class: 'mini-stats' },
          ['CPU', 'RAM', tx('↓ เน็ต'), tx('เขียนดิสก์')].map((label, k) => h('span', {}, h('b', {}, values[k]), label)));
        const cpuBox = h('div', { class: 'mini-chart' }, h('span', { class: 'mini-label' }, 'CPU'));
        const memBox = h('div', { class: 'mini-chart' }, h('span', { class: 'mini-label' }, 'RAM'));
        const el2 = h('section', { class: 'card mini' }, head, stWrap, cpuBox, memBox);
        groupGrids.get(serviceOf(c).group).grid.append(el2);
        e = { el: el2, stWrap, cpu: mkChart(cpuBox, { ...cpuO, label: tx('CPU ของ {0}', name) }), mem: mkChart(memBox, { ...memO, label: tx('RAM ของ {0}', name) }) };
        ctrCards.set(id, e);
      } else {
        e.stWrap.querySelectorAll('b').forEach((b, k) => setNumber(b, values[k]));
        e.cpu.update(cpuO);
        e.mem.update(memO);
      }
    });
    for (const [id, e] of ctrCards) {
      if (ids.includes(id)) continue;
      e.el.remove();
      e.cpu.destroy();
      e.mem.destroy();
      ctrCards.delete(id);
    }
  };
  await load();
  if (token !== viewToken) return;
  const every = RANGES.find(([r]) => r === overviewRange)[2];
  timer = setInterval(() => document.visibilityState === 'visible' && load().catch(handleError), every);
}

// ------------------------------------------------------------------ security (dock-metrics' security watch)
// Logins, changed system files, bot probes, ports and containers, grouped in five categories. The
// overview shows one card per category; each opens its own page. Important changes also arrive in the
// chat (and as a push) through apps-chat.
const SEC_CATS = [
  ['ssh', 'key', tx('การเข้าเครื่อง (SSH)')],
  ['panel', 'lock', tx('แผงควบคุม')],
  ['files', 'file', tx('ไฟล์สำคัญ')],
  ['web', 'globe', tx('บอทสแกนเว็บ')],
  ['host', 'server', tx('พอร์ตและคอนเทนเนอร์')],
  ['images', 'bug', tx('ช่องโหว่ใน image')],
];
const SEC_LEVEL = { info: ['ok', tx('ปกติ')], warn: ['warn', tx('ควรดู')], bad: ['bad', tx('ต้องตรวจ')] };
const SEC_HEADLINE = { info: tx('ไม่พบความผิดปกติ'), warn: tx('มีเรื่องที่ควรดู'), bad: tx('มีเรื่องที่ต้องตรวจทันที') };
const PANELS = { dock: 'Dock', portainer: 'Portainer', npm: 'Nginx Proxy Manager' };
const PROBES = [
  ['secrets', tx('หาไฟล์ลับ (.env, .git)')],
  ['wordpress', 'WordPress'],
  ['php', 'PHP / phpMyAdmin'],
  ['admin', tx('แผงควบคุมทั่วไป')],
  ['traversal', tx('เจาะพาธ (../)')],
];
const PORT_NAMES = { 22: 'SSH', 80: 'HTTP', 443: 'HTTPS' };
const RISKY = {
  'docker-socket': tx('ควบคุม Docker ได้ทั้งหมด (docker.sock)'),
  privileged: tx('สิทธิ์เต็มเครื่อง (privileged)'),
  'host-network': tx('ใช้เครือข่ายของเครื่องโดยตรง'),
  'host-pid': tx('เห็นโปรเซสทั้งเครื่อง'),
  'host-ipc': tx('ใช้ IPC ของเครื่อง'),
  'host-root': tx('เมานต์ / ของเครื่อง'),
  unconfined: tx('ปิด seccomp / AppArmor'),
};
const SEV_LEVEL = { CRITICAL: 'bad', HIGH: 'warn' };
const SEV_TEXT = { CRITICAL: tx('วิกฤต'), HIGH: tx('สูง'), MEDIUM: tx('กลาง'), LOW: tx('ต่ำ'), UNKNOWN: tx('ไม่ระบุ') };
/** fixable CRITICAL / HIGH findings over the scanned images */
const fixTotals = (images) => images.reduce((t, i) => ({ c: t.c + (i.fixable?.CRITICAL ?? 0), h: t.h + (i.fixable?.HIGH ?? 0) }), { c: 0, h: 0 });
const riskyText = (f) => RISKY[f] ?? (f.startsWith('cap-add:') ? tx('เพิ่มสิทธิ์ {0}', f.slice(8)) : f);
const secDot = (level) => h('span', { class: `dot ${SEC_LEVEL[level]?.[0] ?? ''}`, title: SEC_LEVEL[level]?.[1] ?? '' });
const secWhen = (ts) => fmtTime.format(new Date(ts * 1000));
const shortKey = (k) => (k.length > 22 ? `${k.slice(0, 20)}…` : k);
/** logins in the last 24 h; the payload keeps the newest 20, so a full list reads "20+" */
const in24h = (s, rows) => {
  const n = rows.filter((r) => r.ts > s.now - 86400).length;
  return n >= 20 ? `${n}+` : fmtNum(n);
};

/** one line under each category: what is there right now */
function secSummary(s, cat) {
  const d = s.cats[cat];
  if (cat === 'ssh') return tx('เข้าสำเร็จ {0} · ไม่สำเร็จ {1} ใน 24 ชม.', in24h(s, d.logins), fmtNum(d.failed24));
  if (cat === 'panel') return tx('ล็อกอิน {0} · รหัสผิด {1} ใน 24 ชม.', in24h(s, d.logins), fmtNum(d.failed24));
  if (cat === 'files') return d.changed ? tx('ถูกแก้ {0} จาก {1} ไฟล์', d.changed, d.watched) : tx('เฝ้า {0} ไฟล์ ไม่มีการแก้', d.watched);
  if (cat === 'web') return tx('วันนี้ {0} ครั้ง · ส่วนใหญ่ได้ 404', fmtNum(d.today));
  if (cat === 'images') {
    if (!d.scanned) return tx('ยังไม่มีผลสแกน (สแกนทุกคืน)');
    const t = fixTotals(d.images);
    return tx('แก้ได้: วิกฤต {0} · สูง {1} · สแกน {2}', t.c, t.h, ago(d.scanned));
  }
  const u = d.updates;
  return [tx('พอร์ตเปิด {0}', d.ports.length), tx('อัปเดตรอ {0}', u.pending ?? '–'), u.reboot ? tx('ควรรีบูต') : null].filter(Boolean).join(' · ');
}
/** the five category cards on the overview */
function secCards(s) {
  return SEC_CATS.map(([id, ic, label]) => h('a', { class: 'sec-cat', href: `#/security/${id}` },
    h('span', { class: 'sec-cat-head' }, icon(ic, 'sec-cat-ic'), h('span', { class: 'sec-cat-name' }, label), secDot(s.cats[id].status)),
    h('span', { class: 'sec-cat-sub' }, secSummary(s, id))));
}
const eventRow = (e) => h('div', { class: 'row wrap' }, secDot(e.level),
  h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, e.title), e.detail ? h('span', { class: 'row-sub' }, e.detail) : null),
  h('div', { class: 'row-side' }, secWhen(e.ts)));
const eventList = (events, empty = tx('ยังไม่มีเหตุการณ์')) =>
  h('div', { class: 'list' }, events.length ? events.map(eventRow) : h('p', { class: 'empty' }, empty));
const listCard = (title, sub, rows, empty) =>
  card(title, sub, h('div', { class: 'list flat' }, rows.length ? rows : h('p', { class: 'empty' }, empty)));
const sideTime = (ts) => h('div', { class: 'row-side' }, secWhen(ts));
const newPill = () => h('span', { class: 'pill tone-bad' }, tx('ใหม่'));

async function securityView(token, cat) {
  const meta = SEC_CATS.find(([id]) => id === cat);
  const body = h('div', { class: 'overview' }, h('div', { class: 'tiles' }, skelTiles(4)), skelRows(5, { icon: true, side: 'dot' }));
  shell(topBar(meta ? meta[2] : tx('ความปลอดภัย'), { back: meta ? '#/security' : '#/', onRefresh: () => load() }), body, tabs('#/'));
  app.querySelector('.shell').classList.add('wide');
  let mine = []; // this page's charts, rebuilt on refresh

  const load = async () => {
    const s = await api('/security');
    if (token !== viewToken) return;
    mine.forEach((c) => c.destroy());
    charts = charts.filter((c) => !mine.includes(c));
    mine = [];
    if (!s.enabled) {
      body.replaceChildren(h('p', { class: 'empty' }, tx('ยังไม่ได้เปิดการเฝ้าระวัง')));
      return;
    }
    const chartIn = (c, opts) => { mine.push(mkChart(c, opts)); return c; };
    body.replaceChildren(...(meta ? secCategory(s, cat, chartIn) : secMain(s, load)));
  };
  await load();
  if (token !== viewToken || meta) return;
  timer = setInterval(() => document.visibilityState === 'visible' && load().catch(handleError), 30_000);
}

function secMain(s, reload) {
  const ack = s.status !== 'info'
    ? h('button', { class: 'btn', type: 'button', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { await api('/security/ack', { method: 'POST' }); await reload(); } catch (err) { handleError(err); }
      } }, icon('checkcircle'), tx('รับทราบแล้ว'))
    : null;
  return [
    h('section', { class: `sec-banner tone-${SEC_LEVEL[s.status][0]}` },
      h('span', { class: 'row-ic' }, icon('shield')),
      h('div', { class: 'row-main' },
        h('span', { class: 'row-title' }, SEC_HEADLINE[s.status]),
        h('span', { class: 'row-sub' }, tx('เฝ้าระวังตั้งแต่ {0}{1}', fmtStarted.format(new Date(s.since * 1000)), s.acked ? tx(' · รับทราบล่าสุด {0}', secWhen(s.acked)) : ''))),
      ack),
    h('div', { class: 'sec-cats' }, secCards(s)),
    h('h2', { class: 'section-title' }, tx('เหตุการณ์ล่าสุด')),
    eventList(s.events.slice(0, 40)),
    h('p', { class: 'meta sec-note' }, tx('อ่าน log ทุก 5 วินาที ตรวจไฟล์ พอร์ต และคอนเทนเนอร์ทุกนาที สแกนช่องโหว่ใน image ทุกคืน เรื่องสำคัญจะส่งเข้าแชทและแจ้งเตือนของ Dock ด้วย กด "รับทราบแล้ว" เพื่อล้างสี (ประวัติยังอยู่)')),
  ];
}

function secCategory(s, cat, chartIn) {
  const d = s.cats[cat];
  const events = s.events.filter((e) => e.cat === cat);
  const days = (rows) => rows.map((r) => r.day);
  if (cat === 'ssh') {
    const c = card(tx('ความพยายามเข้าที่ไม่สำเร็จ'), tx('รายวัน 14 วัน · ส่วนใหญ่เป็นบอทเดารหัส'));
    return [
      h('div', { class: 'tiles' },
        tile(tx('เข้าสำเร็จ 24 ชม.'), in24h(s, d.logins), tx('จาก {0} เครือข่ายที่เคยเห็น', d.networks)),
        tile(tx('ไม่สำเร็จ 24 ชม.'), fmtNum(d.failed24), tx('ปิดการเข้าด้วยรหัสผ่านไว้แล้ว')),
        tile(tx('คีย์ที่เคยใช้'), fmtNum(d.keys.length), d.keys.length === 1 ? tx('มีคีย์เดียว') : tx('ตรวจว่ารู้จักทุกอัน')),
        tile(tx('IP ที่ลองบ่อยสุด'), d.topIps[0]?.ip ?? '–', d.topIps[0] ? tx('{0} ครั้งใน 24 ชม.', fmtNum(d.topIps[0].count)) : '')),
      h('div', { class: 'grid' },
        chartIn(c, { times: days(d.failedDays), step: 86400, kind: 'columns', legend: 'sum', format: (v) => fmtNum(v), label: tx('ความพยายามเข้าที่ไม่สำเร็จ'),
          series: [{ name: tx('ไม่สำเร็จ'), color: 'var(--s5)', values: d.failedDays.map((r) => r.count) }] }),
        listCard(tx('ล็อกอินล่าสุด'), tx('เครือข่ายใหม่หรือคีย์ใหม่จะแจ้งเตือน'), d.logins.map((l) => h('div', { class: 'row' },
          h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, `${l.user}@${l.ip} `, l.new ? newPill() : null), h('span', { class: 'row-sub' }, `${l.net} · ${shortKey(l.how)}`)),
          sideTime(l.ts))), tx('ยังไม่มีการล็อกอิน')),
        listCard(tx('IP ที่พยายามบ่อยสุด'), tx('24 ชั่วโมงล่าสุด'), d.topIps.map((x) => h('div', { class: 'row' },
          h('div', { class: 'row-main' }, h('span', { class: 'row-title mono' }, x.ip)), h('div', { class: 'row-side' }, h('b', {}, fmtNum(x.count))))), tx('ไม่มี')),
        listCard(tx('คีย์ที่เคยใช้เข้า'), tx('ถ้ามีคีย์ที่ไม่รู้จัก ให้ลบออกจาก authorized_keys'), d.keys.map((k) => h('div', { class: 'row' },
          h('div', { class: 'row-main' }, h('span', { class: 'row-title mono' }, k.key)), sideTime(k.first))), tx('ยังไม่มี'))),
      h('h2', { class: 'section-title' }, tx('เหตุการณ์')), eventList(events),
    ];
  }
  if (cat === 'panel') {
    const nets = Object.entries(d.networks).map(([p, n]) => `${PANELS[p] ?? p} ${n}`).join(' · ');
    return [
      h('div', { class: 'tiles' },
        tile(tx('ล็อกอิน 24 ชม.'), in24h(s, d.logins), 'Dock, Portainer, Nginx Proxy Manager'),
        tile(tx('รหัสผิด 24 ชม.'), fmtNum(d.failed24), tx('ผิด 10 ครั้งในชั่วโมงเดียวจะแจ้งเตือน')),
        tile(tx('เครือข่ายที่รู้จัก'), nets || '–', tx('ล็อกอินจากเครือข่ายใหม่จะแจ้งเตือน'))),
      h('div', { class: 'grid' },
        listCard(tx('ล็อกอินล่าสุด'), tx('ผ่าน Cloudflare จะไม่เห็น IP จริงบางครั้ง'), d.logins.map((l) => h('div', { class: 'row' },
          h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, `${PANELS[l.via] ?? l.via} `, l.new ? newPill() : null), h('span', { class: 'row-sub' }, `${l.ip} · ${l.how}`)),
          sideTime(l.ts))), tx('ยังไม่มีการล็อกอิน'))),
      h('h2', { class: 'section-title' }, tx('การเปลี่ยนแปลงและเหตุการณ์')), eventList(events, tx('ยังไม่มีการแก้ค่า')),
    ];
  }
  if (cat === 'files') {
    const fresh = (f) => f.changed && f.changed > Math.max(s.acked, s.now - 3 * 86400);
    const files = [...d.list].sort((a, b) => (b.changed ?? 0) - (a.changed ?? 0) || (a.level === b.level ? a.path.localeCompare(b.path) : a.level === 'bad' ? -1 : 1));
    return [
      h('div', { class: 'tiles' },
        tile(tx('ไฟล์ที่เฝ้า'), fmtNum(d.watched), tx('บัญชีผู้ใช้ SSH cron systemd ไฟร์วอลล์ shell ของ root')),
        tile(tx('ถูกแก้'), fmtNum(d.changed), tx('3 วันล่าสุด หรือหลังกดรับทราบ')),
        tile(tx('ตรวจล่าสุด'), d.checked ? ago(d.checked) : '–', tx('ทุก 1 นาที'))),
      h('h2', { class: 'section-title' }, tx('เหตุการณ์')), eventList(events, tx('ยังไม่มีไฟล์ไหนถูกแก้')),
      h('h2', { class: 'section-title' }, tx('ไฟล์ที่เฝ้าอยู่')),
      h('div', { class: 'list' }, files.map((f) => h('div', { class: 'row' }, secDot(fresh(f) ? f.level : 'info'),
        h('div', { class: 'row-main' }, h('span', { class: 'row-title mono' }, f.path), h('span', { class: 'row-sub' }, f.level === 'bad' ? tx('สำคัญมาก') : tx('สำคัญ'))),
        h('div', { class: 'row-side' }, f.changed ? tx('แก้ {0}', secWhen(f.changed)) : tx('ไม่เปลี่ยน'))))),
    ];
  }
  if (cat === 'web') {
    const c = card(tx('บอทที่สแกนหาช่องโหว่'), tx('รายวัน 14 วัน ทุกเว็บรวมกัน'));
    const week = d.days.slice(-7).reduce((a, r) => a + r.probes, 0);
    const guard = d.days.reduce((a, r) => a + r.guard, 0);
    return [
      h('div', { class: 'tiles' },
        tile(tx('วันนี้'), fmtNum(d.today), tx('ครั้งที่บอทถามหาไฟล์หรือหน้าที่ไม่มีอยู่')),
        tile(tx('7 วัน'), fmtNum(week), tx('เฉลี่ย {0} ต่อวัน', fmtNum(week / 7))),
        tile(tx('ด่านกันช่องโหว่ (415)'), fmtNum(guard), tx('ครั้งที่ด่านใน NPM ตีกลับ 14 วัน'))),
      h('div', { class: 'grid' },
        chartIn(c, { times: days(d.days), step: 86400, kind: 'columns', legend: 'sum', format: (v) => fmtNum(v), label: tx('บอทที่สแกนหาช่องโหว่'),
          series: PROBES.map(([k, name], i) => ({ name, color: SERIES[i], values: d.days.map((r) => r.kinds[k] ?? 0) })) }),
        listCard(tx('ที่ถูกถามบ่อยสุด'), tx('7 วันล่าสุด'), d.topPaths.map((p) => h('div', { class: 'row' },
          h('div', { class: 'row-main' }, h('span', { class: 'row-title mono' }, p.path), h('span', { class: 'row-sub' }, siteName(p.host))),
          h('div', { class: 'row-side' }, h('b', {}, fmtNum(p.count)), ago(p.last)))), tx('ยังไม่มี'))),
      h('p', { class: 'meta sec-note' }, tx('บอทพวกนี้สแกนทุกเว็บบนอินเทอร์เน็ต และได้ 404 กลับไป ไม่ต้องทำอะไร เว้นแต่ตัวเลขพุ่งผิดปกติหรือเห็นคำขอที่ได้ 200')),
    ];
  }
  if (cat === 'images') return secImages(s, d, events);
  const u = d.updates;
  const ports = d.ports.map((p) => Number(p.replace('tcp/', ''))).sort((a, b) => a - b);
  return [
    h('div', { class: 'tiles' },
      tile(tx('พอร์ตที่เปิดรับจากภายนอก'), fmtNum(ports.length), ports.join(', ') || '–'),
      tile(tx('คอนเทนเนอร์'), `${fmtNum(d.running)} / ${fmtNum(d.containers)}`, tx('ทำงานอยู่ / ทั้งหมด')),
      tile(tx('อัปเดตระบบที่รอ'), u.pending ?? '–', u.security ? tx('ความปลอดภัย {0} รายการ', u.security) : tx('unattended-upgrades ลงของความปลอดภัยให้เอง')),
      tile(tx('เคอร์เนล'), u.kernel || '–', u.reboot ? tx('ควรรีบูตเพื่อใช้ {0}', u.newest) : tx('เป็นตัวล่าสุดที่ติดตั้ง'))),
    h('div', { class: 'grid' },
      listCard(tx('พอร์ตที่เปิด'), tx('พอร์ตใหม่จะแจ้งเตือนทันที'), ports.map((n) => {
        return h('div', { class: 'row' }, secDot(PORT_NAMES[n] ? 'info' : 'warn'),
          h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, `TCP ${n}`), h('span', { class: 'row-sub' }, PORT_NAMES[n] ?? tx('ไม่ได้ตั้งค่าไว้ในเอกสาร'))));
      }), tx('อ่านพอร์ตไม่ได้')),
      listCard(tx('คอนเทนเนอร์ที่มีสิทธิ์พิเศษ'), tx('สิทธิ์ที่เพิ่มขึ้นหรือคอนเทนเนอร์ใหม่ที่มีสิทธิ์จะแจ้งเตือน'), d.risky.map((c) => {
        const intended = PROTECTED.has(c.name) && c.flags.every((f) => f === 'docker-socket');
        return h('div', { class: 'row wrap' }, secDot(intended ? 'info' : 'warn'),
          h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, c.name, intended ? h('span', { class: 'muted' }, tx(' · ตั้งใจไว้')) : null), h('span', { class: 'row-sub' }, c.flags.map(riskyText).join(' · '))));
      }), tx('ไม่มี')),
      listCard(tx('ไม่ได้มาจาก compose'), tx('เช่นคอนเทนเนอร์ทดสอบที่รันมือ'), d.unmanaged.map((c) => h('div', { class: 'row' }, secDot(c.running ? 'warn' : 'info'),
        h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, c.name), h('span', { class: 'row-sub' }, `${c.image} · ${c.running ? tx('ทำงานอยู่') : tx('หยุดแล้ว')}`)))), tx('ไม่มี'))),
    h('h2', { class: 'section-title' }, tx('เหตุการณ์')), eventList(events),
  ];
}

/** the nightly Trivy scan (deploy/hardening/dock-image-scan.py): images worst first, then what to update */
function secImages(s, d, events) {
  if (!d.scanned) {
    return [h('p', { class: 'empty' }, tx('ยังไม่มีผลสแกน ตัวสแกนทำงานทุกคืนราว 04:10 น.')), h('h2', { class: 'section-title' }, tx('เหตุการณ์')), eventList(events)];
  }
  const t = fixTotals(d.images);
  const scanned = d.images.filter((i) => !i.error);
  const worst = (i) => [-(i.fixable?.CRITICAL ?? 0), -(i.fixable?.HIGH ?? 0), i.image];
  const images = [...d.images].sort((a, b) => {
    const x = worst(a), y = worst(b);
    return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]);
  });
  const level = (i) => (i.error ? 'warn' : i.fixable?.CRITICAL ? 'bad' : i.fixable?.HIGH ? 'warn' : 'info');
  const fixList = images.filter((i) => !i.error && (i.fixable?.CRITICAL || i.fixable?.HIGH)).map((i) =>
    listCard(i.image, tx('แก้ได้ วิกฤต {0} · สูง {1}', i.fixable.CRITICAL, i.fixable.HIGH),
      i.vulns.filter((v) => v.fixed && SEV_LEVEL[v.severity]).slice(0, 12).map((v) => h('div', { class: 'row wrap' }, secDot(SEV_LEVEL[v.severity]),
        h('div', { class: 'row-main' },
          h('span', { class: 'row-title' }, `${v.pkg} `, h('span', { class: 'muted' }, v.id)),
          h('span', { class: 'row-sub' }, `${v.installed} → ${v.fixed}${v.title ? ` · ${v.title}` : ''}`)))), tx('ไม่มี')));
  return [
    h('div', { class: 'tiles' },
      tile(tx('แก้ได้ ระดับวิกฤต'), fmtNum(t.c), tx('มีเวอร์ชันที่แก้แล้ว')),
      tile(tx('แก้ได้ ระดับสูง'), fmtNum(t.h), tx('มีเวอร์ชันที่แก้แล้ว')),
      tile(tx('image ที่สแกน'), `${fmtNum(scanned.length)} / ${fmtNum(d.images.length)}`, tx('ทุก image ที่คอนเทนเนอร์ใช้อยู่')),
      tile(tx('สแกนล่าสุด'), ago(d.scanned), tx('Trivy {0} · ทุกคืนราว 04:10 น.', d.trivy ?? ''))),
    d.dbError ? h('p', { class: 'meta sec-note' }, tx('โหลดฐานข้อมูลช่องโหว่รอบนี้ไม่สำเร็จ ใช้ฐานข้อมูลเดิมแทน: {0}', d.dbError)) : null,
    h('h2', { class: 'section-title' }, tx('image ที่ใช้อยู่')),
    h('div', { class: 'list' }, images.map((i) => h('div', { class: 'row wrap' }, secDot(level(i)),
      h('div', { class: 'row-main' },
        h('span', { class: 'row-title' }, i.image),
        h('span', { class: 'row-sub' }, i.error ?? [i.os || tx('ไม่มีระบบปฏิบัติการ (static)'), i.eosl ? tx('OS หมดระยะซัพพอร์ตแล้ว') : null, i.containers.join(', ')].filter(Boolean).join(' · '))),
      i.error ? null : h('div', { class: 'row-side' }, h('b', {}, `${i.fixable.CRITICAL} · ${i.fixable.HIGH}`),
        tx('ทั้งหมด {0}', fmtNum(Object.values(i.counts).reduce((a, n) => a + n, 0))))))),
    h('p', { class: 'meta sec-note' }, tx('ตัวเลขขวาคือรายการระดับวิกฤต · สูง ที่มีเวอร์ชันแก้แล้ว แก้โดยอัปเดต base image หรือแพ็กเกจแล้ว build ใหม่ รายการที่ยังไม่มีแพตช์ต้องรอผู้ผลิต ส่วนใหญ่อยู่ในโปรแกรมที่ไม่ได้เปิดรับจากภายนอก')),
    fixList.length ? h('h2', { class: 'section-title' }, tx('ควรอัปเดต')) : null,
    fixList.length ? h('div', { class: 'grid' }, fixList) : null,
    h('h2', { class: 'section-title' }, tx('เหตุการณ์')), eventList(events, tx('ยังไม่มีการแจ้งเตือน')),
  ];
}

// ------------------------------------------------------------------ web analytics
// Page views + Web Vitals from the sites themselves (the analytics service; replaces Vercel Analytics).
const WEB_RANGES = [[7, tx('7 วัน')], [30, tx('30 วัน')], [90, tx('90 วัน')]];
let webDays = (() => { try { return Number(localStorage.getItem('dock.webDays')) || 7; } catch { return 7; } })();
let webHost = (() => { try { return localStorage.getItem('dock.webHost') || ''; } catch { return ''; } })();
const siteName = (hn) => (hn === 'chakkritton.com' ? 'portfolio' : hn.replace(/\.chakkritton\.com$/, ''));
/** Google's "good / needs improvement" limits for the 75th percentile */
const VITALS = [
  ['LCP', 'Largest Contentful Paint', 2500, 4000, (v) => tx('{0} วิ', (v / 1000).toFixed(2))],
  ['INP', 'Interaction to Next Paint', 200, 500, (v) => `${Math.round(v)} ms`],
  ['CLS', 'Cumulative Layout Shift', 0.1, 0.25, (v) => v.toFixed(3)],
  ['FCP', 'First Contentful Paint', 1800, 3000, (v) => tx('{0} วิ', (v / 1000).toFixed(2))],
  ['TTFB', 'Time to First Byte', 800, 1800, (v) => `${Math.round(v)} ms`],
];
const vitalTone = (v, good, poor) => (v === null || v === undefined ? '' : v <= good ? 'ok' : v <= poor ? 'warn' : 'bad');
const vitalText = (tone) => ({ ok: tx('ดี'), warn: tx('ควรปรับ'), bad: tx('แย่') })[tone] ?? '–';
const COUNTRY = new Intl.DisplayNames([LANG], { type: 'region' });
const countryName = (c) => { try { return COUNTRY.of(c) ?? c; } catch { return c; } };

async function webView(token) {
  const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': tx('ช่วงเวลา') },
    WEB_RANGES.map(([d, label]) => h('button', {
      type: 'button', 'aria-pressed': d === webDays ? 'true' : 'false',
      onclick: () => { webDays = d; try { localStorage.setItem('dock.webDays', String(d)); } catch { /* ignore */ } route(); },
    }, label)));
  const sites = h('div', { class: 'segmented scroll', role: 'group', 'aria-label': tx('เว็บไซต์') });
  const tiles = h('div', { class: 'tiles' }, skelTiles(4));
  const chartGrid = h('div', { class: 'grid' }, skelCard(190, '48%'));
  const tables = h('div', { class: 'grid' }, skelRows(5));
  const vitalsBox = h('div', {}, skelCard(110, '36%'));
  const body = h('div', { class: 'overview' },
    h('div', { class: 'filters' }, seg, sites),
    tiles, chartGrid,
    h('h2', { class: 'section-title' }, tx('ความเร็วที่ผู้ใช้จริงเห็น (Web Vitals, p75)')), vitalsBox,
    h('h2', { class: 'section-title' }, tx('มาจากไหน ดูอะไร')), tables);
  shell(topBar(tx('สถิติเว็บ'), { onRefresh: () => load() }), body, tabs('#/web'));
  app.querySelector('.shell').classList.add('wide');
  let views = null;

  const load = async () => {
    body.classList.add('loading');
    const st = await api(`/analytics?days=${webDays}${webHost ? `&host=${encodeURIComponent(webHost)}` : ''}`);
    if (token !== viewToken) return;
    body.classList.remove('loading');
    clearSkel(body);
    sites.replaceChildren(...[['', tx('ทุกเว็บ')], ...st.hosts.map((hn) => [hn, siteName(hn)])].map(([hn, label]) => h('button', {
      type: 'button', 'aria-pressed': hn === (st.host ?? '') ? 'true' : 'false',
      onclick: () => { webHost = hn; try { localStorage.setItem('dock.webHost', hn); } catch { /* ignore */ } route(); },
    }, label)));

    // one point per Bangkok day, empty days included
    const DAY = 86400;
    const start = Date.parse(`${st.from}T00:00:00+07:00`) / 1000;
    const times = Array.from({ length: st.days }, (_, i) => start + i * DAY);
    const byDay = new Map(st.series.map((r) => [r.day, r]));
    const dayKey = (t) => new Date((t + 7 * 3600) * 1000).toISOString().slice(0, 10);
    const pv = times.map((t) => byDay.get(dayKey(t))?.views ?? 0);
    const uv = times.map((t) => byDay.get(dayKey(t))?.visitors ?? 0);
    const total = st.totals;
    const lcp = st.vitals.LCP;
    const lcpTone = lcp ? vitalTone(lcp.p75, 2500, 4000) : '';
    patchChildren(tiles, [
      tile(tx('ผู้เข้าชม'), fmtNum(total.visitors), tx('นับแยกรายวัน ไม่ใช้คุกกี้')),
      tile(tx('เพจวิว'), fmtNum(total.views), tx('เฉลี่ย {0} ต่อวัน', fmtNum(total.views / st.days))),
      tile(tx('หน้าต่อการเข้าชม'), total.visitors ? (total.views / total.visitors).toFixed(1) : '–', tx('เพจวิว ÷ ผู้เข้าชม')),
      tile('LCP (p75)', lcp ? VITALS[0][4](lcp.p75) : '–', lcp ? tx('{0} · จาก {1} ครั้ง', vitalText(lcpTone), fmtNum(lcp.n)) : tx('ยังไม่มีข้อมูล')),
    ]);
    // whole numbers on the axis even for a quiet week
    const opts = { times, step: DAY, kind: 'columns', legend: 'sum', format: (v) => fmtNum(v), ...(Math.max(...pv) < 4 ? { max: 4 } : {}),
      series: [{ name: tx('เพจวิว'), color: SERIES[0], values: pv }, { name: tx('ผู้เข้าชม'), color: SERIES[1], values: uv }] };
    if (!views) {
      const c = card(tx('ผู้เข้าชมและเพจวิวรายวัน'), st.host ? siteName(st.host) : tx('ทุกเว็บไซต์'));
      chartGrid.append(c);
      views = mkChart(c, { ...opts, label: tx('ผู้เข้าชมและเพจวิวรายวัน') });
    } else views.update(opts);

    patchChildren(vitalsBox, [card('Web Vitals', tx('ค่าที่ 75% ของการเข้าชมทำได้ดีกว่านี้'), h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('tr', {}, h('th', {}, tx('ตัวชี้วัด')), h('th', { class: 'num' }, tx('ทั้งหมด')), h('th', { class: 'num' }, tx('มือถือ')), h('th', { class: 'num' }, tx('เดสก์ท็อป')), h('th', {}, tx('ผล'))),
      VITALS.map(([key, label, good, poor, fmt]) => {
        const v = st.vitals[key];
        const tone = v ? vitalTone(v.p75, good, poor) : '';
        return h('tr', {},
          h('td', {}, h('b', {}, key), h('span', { class: 'muted' }, ` ${label}`)),
          h('td', { class: 'num' }, v ? fmt(v.p75) : '–'),
          h('td', { class: 'num' }, v?.mobile != null ? fmt(v.mobile) : '–'),
          h('td', { class: 'num' }, v?.desktop != null ? fmt(v.desktop) : '–'),
          h('td', {}, tone ? h('span', { class: `pill ${tone}` }, h('span', { class: `dot ${tone}` }), vitalText(tone)) : '–'));
      }))))]);

    const table = (title, sub, head, rows, render) => card(title, sub, h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('tr', {}, h('th', {}, head), h('th', { class: 'num' }, tx('ผู้เข้าชม')), h('th', { class: 'num' }, tx('เพจวิว'))),
      rows.length ? rows.map((r) => h('tr', {}, h('td', { class: render === 'mono' ? 'mono' : '' }, typeof render === 'function' ? render(r.key) : r.key),
        h('td', { class: 'num' }, fmtNum(r.visitors)), h('td', { class: 'num' }, fmtNum(r.views))))
        : h('tr', {}, h('td', { colspan: 3 }, tx('ยังไม่มีข้อมูล'))))));
    patchChildren(tables, [
      ...(st.host ? [] : [table(tx('ตามเว็บไซต์'), null, tx('เว็บไซต์'), st.perHost, siteName)]),
      table(tx('หน้าที่ถูกเปิดมากที่สุด'), null, tx('หน้า'), st.pages, 'mono'),
      table(tx('มาจาก'), tx('เว็บที่ลิงก์มา (ไม่นับการเข้าตรง)'), tx('แหล่งที่มา'), st.referrers),
      table(tx('ประเทศ'), tx('จาก Cloudflare'), tx('ประเทศ'), st.countries, countryName),
      table(tx('อุปกรณ์'), null, tx('อุปกรณ์'), st.devices, (d) => ({ mobile: tx('มือถือ'), tablet: tx('แท็บเล็ต'), desktop: tx('คอมพิวเตอร์') })[d] ?? d),
      table(tx('เบราว์เซอร์'), null, tx('เบราว์เซอร์'), st.browsers),
    ]);
  };
  await load();
  if (token !== viewToken) return;
  timer = setInterval(() => document.visibilityState === 'visible' && load().catch(handleError), 60_000);
}

// ------------------------------------------------------------------ backup bundles
// A zip of the whole server (databases, volumes, settings, code commits), encrypted with a passphrase;
// its restore.sh puts everything back on this server or a new one (deploy/apps/backup).
const fmtDate = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

async function backupView(token) {
  const pass1 = h('input', { class: 'field', type: 'password', autocomplete: 'new-password', placeholder: tx('รหัสผ่านของไฟล์ (อย่างน้อย 12 ตัว)'), minlength: 12 });
  const pass2 = h('input', { class: 'field', type: 'password', autocomplete: 'new-password', placeholder: tx('พิมพ์รหัสผ่านอีกครั้ง') });
  const status = h('p', { class: 'meta', role: 'status' }, ' ');
  const create = h('button', { class: 'btn primary', type: 'submit' }, tx('สร้างไฟล์สำรอง'));
  const form = h('form', { class: 'backup-form', onsubmit: async (e) => {
    e.preventDefault();
    if (pass1.value.length < 12) return toast(tx('รหัสผ่านต้องยาวอย่างน้อย 12 ตัว'));
    if (pass1.value !== pass2.value) return toast(tx('รหัสผ่านสองช่องไม่ตรงกัน'));
    create.disabled = true;
    try {
      await api('/backups', { method: 'POST', body: { passphrase: pass1.value } });
      pass1.value = pass2.value = '';
      toast(tx('เริ่มสร้างไฟล์สำรองแล้ว'));
      await load();
    } catch (err) {
      create.disabled = false;
      handleError(err);
    }
  } }, pass1, pass2, create, status);
  const list = h('div', { class: 'list no-enter' }, ...skelRows(1).children);
  const body = h('div', { class: 'stack' },
    card(tx('สร้างไฟล์สำรองทั้งเซิร์ฟเวอร์'), null,
      h('p', { class: 'backup-text' }, tx('รวมฐานข้อมูล ข้อมูลใน Docker volume ทุกตัว ไฟล์ตั้งค่า และ commit ของโค้ด เป็น zip เดียว ข้อมูลข้างในเข้ารหัสด้วยรหัสผ่านนี้ — ลืมรหัสผ่าน = เปิดไฟล์ไม่ได้')),
      form),
    h('h2', { class: 'section-title' }, tx('ไฟล์ที่มี (เก็บ 5 ไฟล์ล่าสุด)')), list,
    card(tx('กู้คืน'), tx('บนเครื่องเดิมหรือ Ubuntu 24.04 เครื่องใหม่'),
      h('pre', { class: 'logs backup-steps' }, tx('unzip chakkritton-server-backup-*.zip -d restore\ncd restore\nsudo bash restore.sh --check   # ตรวจก่อน ไม่เปลี่ยนอะไร\nsudo bash restore.sh           # กู้คืนทั้งหมด'))));
  shell(topBar(tx('สำรองข้อมูล'), { back: '#/more', onRefresh: () => load() }), body, tabs('#/more'));

  const load = async () => {
    const { bundles, job } = await api('/backups');
    if (token !== viewToken) return;
    const running = job && !job.done && !job.error;
    create.disabled = !!running;
    status.textContent = running ? tx('กำลังสร้าง {0} — {1}…', job.name, job.step) : job?.error ? tx('ครั้งล่าสุดไม่สำเร็จ: {0}', job.error) : ' ';
    list.replaceChildren(...(bundles.length ? bundles.map((b) => h('div', { class: 'row' },
      h('div', { class: 'row-main' },
        h('span', { class: 'row-title' }, fmtDate.format(new Date(b.created))),
        h('span', { class: 'backup-file' }, b.name),
        h('span', { class: 'row-sub' }, fmtBytes(b.size))),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          try {
            const { url } = await api(`/backups/${encodeURIComponent(b.name)}/link`, { method: 'POST' });
            location.href = url;
          } catch (err) { handleError(err); }
        } }, icon('download'), tx('ดาวน์โหลด')),
        confirmButton(tx('ลบ'), tx('แตะอีกครั้งเพื่อลบ'), async () => {
          await api(`/backups/${encodeURIComponent(b.name)}`, { method: 'DELETE' });
          await load();
        }, { danger: true }))))
      : [h('p', { class: 'empty' }, tx('ยังไม่มีไฟล์สำรอง'))]));
    clearInterval(timer);
    if (running) timer = setInterval(() => load().catch(handleError), 3000);
  };
  await load();
}

// ------------------------------------------------------------------ more: backup + chat
function moreView() {
  const item = (href, ic, title, sub, extra) => h('a', { class: 'row', href },
    h('span', { class: 'row-ic' }, icon(ic)),
    h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, title), h('span', { class: 'row-sub' }, sub)),
    extra, icon('chev', 'chev'));
  shell(topBar(tx('เพิ่มเติม')),
    h('div', { class: 'list' },
      item('#/security', 'shield', tx('ความปลอดภัย'), tx('การเข้าเครื่อง ไฟล์สำคัญ พอร์ต บอทที่สแกนเว็บ และช่องโหว่ใน image')),
      item('#/chat', 'chat', tx('แชท'), tx('สรุปรายเดือนจากระบบ และถาม–ตอบ'), badge()),
      item('#/backup', 'archive', tx('สำรองข้อมูล'), tx('ไฟล์สำรองทั้งเซิร์ฟเวอร์ และวิธีกู้คืน')),
      item('#/display', 'contrast', tx('การแสดงผล'), displaySummary())),
    tabs('#/more'));
}

// ------------------------------------------------------------------ web push (chat → this device)
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
async function currentSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}
const b64uToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
/** on: ask permission (needs the tap), subscribe, register with the chat service, send a test */
async function enablePush() {
  if (!pushSupported()) {
    toast(isIos() && !standalone() ? tx('iPhone: แชร์ → เพิ่มไปยังหน้าจอโฮม แล้วเปิด Dock จากไอคอนก่อน') : tx('เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน'));
    return false;
  }
  if ((await Notification.requestPermission()) !== 'granted') { toast(tx('ไม่ได้รับอนุญาตให้แจ้งเตือน (เปิดได้ในการตั้งค่า)')); return false; }
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api('/chat/push/key');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
  await api('/chat/push/subscribe', { method: 'POST', body: sub.toJSON() });
  await api('/chat/push/test', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
  toast(tx('เปิดการแจ้งเตือนแล้ว'));
  return true;
}
async function disablePush() {
  const sub = await currentSub();
  if (sub) {
    await api('/chat/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }
  toast(tx('ปิดการแจ้งเตือนแล้ว'));
}
function pushButton() {
  const b = h('button', { class: 'icon-btn', type: 'button' });
  const paint = (on) => {
    b.replaceChildren(icon(on ? 'bell' : 'belloff'));
    b.setAttribute('aria-label', on ? tx('ปิดการแจ้งเตือน') : tx('เปิดการแจ้งเตือน'));
    b.title = on ? tx('แจ้งเตือนเปิดอยู่ (แตะเพื่อปิด)') : tx('เปิดการแจ้งเตือน');
    b.classList.toggle('on', on);
  };
  currentSub().then((s) => paint(!!s)).catch(() => paint(false));
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      if (await currentSub()) { await disablePush(); paint(false); } else paint(await enablePush());
    } catch (err) { handleError(err); } finally { b.disabled = false; }
  });
  return b;
}

// The server posts its monthly summary here; what is typed is answered by the chat service
// (commands, or an LLM once one is configured in chat.env).
const fmtTime = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
async function chatView(token) {
  const log = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite' }, ...skelChat());
  const note = h('p', { class: 'chat-note' }, ' ');
  const input = h('textarea', { class: 'field chat-input', rows: 1, placeholder: tx('พิมพ์ข้อความ…'), maxlength: 4000, 'aria-label': tx('ข้อความ') });
  const send = h('button', { class: 'icon-btn send', type: 'submit', 'aria-label': tx('ส่ง'), disabled: true }, icon('send'));
  let lastId = 0;
  let busy = false;
  const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80;
  const toBottom = () => window.scrollTo({ top: document.documentElement.scrollHeight });
  let firstId = 0;
  let hasMore = false;
  let loadingOlder = false;
  // a server post's type → its icon and colour (instead of emoji in the text)
  const KINDS = { down: ['alert', 'bad'], up: ['checkcircle', 'ok'], report: ['chart', 'info'], security: ['shield', 'warn'] };
  /** text with its https links made tappable (built as nodes, never as HTML) */
  const linkify = (text) => text.split(/(https:\/\/[^\s]+)/g).map((part, i) =>
    i % 2 ? h('a', { href: part, target: '_blank', rel: 'noopener' }, part.replace(/^https:\/\//, '')) : part);
  /** a month report as a card: tiles, daily CPU and visitors, traffic per site, advice */
  const TIP = { bad: ['alert', 'bad'], warn: ['alert', 'warn'], info: ['info', 'info'], ok: ['checkcircle', 'ok'] };
  const dayTimes = (rows) => rows.map((r) => Date.parse(`${r.day}T00:00:00+07:00`) / 1000);
  const reportCard = (d) => {
    const body = h('div', { class: 'report' },
      h('b', { class: 'msg-title' }, d.title),
      h('div', { class: 'report-tiles' }, d.tiles.map((t) => h('div', { class: `report-tile${t.tone ? ` tone-${t.tone}` : ''}` },
        h('span', { class: 'tile-label' }, t.label), h('span', { class: 'report-value' }, t.value), t.sub ? h('span', { class: 'tile-sub' }, t.sub) : null))));
    const chartBox = (title, opts) => {
      const box = h('div', { class: 'report-chart' }, h('span', { class: 'report-h' }, title));
      body.append(box);
      requestAnimationFrame(() => mkChart(box, { ...opts, label: title, height: 120 })); // after it is in the page, so it knows its width
    };
    // columns, so a month that has only just started (one day) still shows its figure
    if (d.cpu.some((r) => r.avg !== null)) {
      chartBox(tx('CPU เฉลี่ยรายวัน'), { times: dayTimes(d.cpu), step: 86400, kind: 'columns', format: (v) => fmtPct(v),
        series: [{ name: tx('เฉลี่ย'), color: 'var(--s1)', values: d.cpu.map((r) => r.avg) }] });
    }
    if (d.visitors.length) {
      chartBox(tx('ผู้เข้าชมรายวัน'), { times: dayTimes(d.visitors), step: 86400, kind: 'columns', format: (v) => fmtNum(v),
        series: [{ name: tx('ผู้เข้าชม'), color: 'var(--s3)', values: d.visitors.map((r) => r.visitors) }] });
    }
    if (d.sites.length) {
      const top = Math.max(...d.sites.map((x) => x.requests), 1);
      body.append(h('div', { class: 'report-sites' }, h('span', { class: 'report-h' }, tx('คำขอตามเว็บ')),
        d.sites.map((x) => h('div', { class: 'site-row' },
          h('span', { class: 'site-name' }, x.site),
          h('span', { class: 'site-bar' }, h('span', { style: `width:${((x.requests / top) * 100).toFixed(1)}%` })),
          h('span', { class: 'site-num' }, fmtNum(x.requests)),
          x.errorsPct >= 1 ? h('span', { class: 'pill tone-bad' }, `5xx ${x.errorsPct.toFixed(1)}%`) : null))));
    }
    body.append(h('div', { class: 'report-tips' }, h('span', { class: 'report-h' }, tx('คำแนะนำ')),
      d.tips.map((t) => h('div', { class: `tip tip-${t.level}` }, icon(TIP[t.level][0], 'msg-ic'), h('span', {}, t.text)))));
    return body;
  };
  const bubble = (m) => {
    const kind = KINDS[m.kind];
    if (m.kind === 'report' && m.data) {
      return h('div', { class: `msg ${m.role} report-msg`, 'data-id': m.id },
        h('span', { class: 'msg-label' }, icon('chart', 'msg-ic'), m.role === 'system' ? tx('รายงานประจำเดือน') : tx('สรุป')),
        reportCard(m.data),
        h('span', { class: 'msg-time' }, fmtTime.format(new Date(m.ts))));
    }
    const [title, ...rest] = m.text.split('\n');
    return h('div', { class: `msg ${m.role}${kind ? ` kind-${kind[1]}` : ''}`, 'data-id': m.id },
      m.role === 'system' ? h('span', { class: 'msg-label' }, kind ? icon(kind[0], 'msg-ic') : null, m.kind === 'report' ? tx('รายงานประจำเดือน') : m.kind === 'security' ? tx('แจ้งเตือนความปลอดภัย') : m.kind ? tx('แจ้งเตือนระบบ') : tx('จากระบบ')) : null,
      kind
        ? h('div', { class: 'msg-text' }, h('b', { class: 'msg-title' }, title), rest.length ? '\n' : null, ...linkify(rest.join('\n')))
        : h('div', { class: 'msg-text' }, ...linkify(m.text)),
      h('span', { class: 'msg-time' }, fmtTime.format(new Date(m.ts))));
  };
  const empty = () => h('div', { class: 'chat-empty' },
    h('span', { class: 'row-ic' }, icon('chat')),
    h('b', {}, tx('ยังไม่มีข้อความ')),
    h('p', {}, tx('สรุปรายเดือนและแจ้งเตือนเว็บล่มจะมาที่นี่ หรือแตะ สรุป / เดือนก่อน / ช่วย ด้านล่างเพื่อถาม')));
  const add = (msgs) => {
    const follow = atBottom();
    log.querySelector('.chat-empty')?.remove();
    clearSkel(log);
    for (const m of msgs) if (m.id > lastId) { log.append(bubble(m)); lastId = m.id; if (!firstId) firstId = m.id; }
    if (follow) toBottom();
  };
  // scrolling to the top brings the previous page; the view stays on the message you were reading
  const older = h('div', { class: 'chat-older', hidden: true }, h('span', { class: 'spinner' }), tx('กำลังโหลดข้อความก่อนหน้า…'));
  const loadOlder = async () => {
    if (!hasMore || loadingOlder || !firstId) return;
    loadingOlder = true;
    older.hidden = false;
    try {
      const res = await api(`/chat?before=${firstId}`);
      if (token !== viewToken) return;
      const height = document.documentElement.scrollHeight;
      const y = window.scrollY;
      log.prepend(...res.messages.map(bubble));
      if (res.messages.length) firstId = res.messages[0].id;
      hasMore = res.hasMore;
      window.scrollTo({ top: y + document.documentElement.scrollHeight - height });
    } catch (err) { handleError(err); } finally { loadingOlder = false; older.hidden = true; }
  };
  const onScroll = () => { if (window.scrollY < 200) loadOlder(); };
  window.addEventListener('scroll', onScroll, { passive: true });
  const cleanupScroll = () => window.removeEventListener('scroll', onScroll);
  window.addEventListener('hashchange', cleanupScroll, { once: true });
  const load = async () => {
    const first = !lastId;
    const res = await api(first ? '/chat' : `/chat?after=${lastId}`);
    if (token !== viewToken) return;
    if (first) {
      log.replaceChildren();
      hasMore = res.hasMore;
    }
    add(res.messages);
    if (!log.querySelector('.msg')) log.replaceChildren(empty());
    note.textContent = res.llm ? ' ' : tx('ยังไม่ได้เชื่อม LLM — ตอบได้เฉพาะคำสั่ง (สรุป, เดือนก่อน, ช่วย)');
    if (res.messages.some((m) => !m.read)) { await api('/chat/read', { method: 'POST' }).catch(() => {}); refreshUnread(); }
  };
  const submit = async (text) => {
    text = text.trim();
    if (!text || busy) return;
    busy = true;
    send.disabled = true;
    const typing = h('div', { class: 'msg assistant typing' }, h('div', { class: 'msg-text' }, tx('กำลังตอบ…')));
    log.querySelector('.chat-empty')?.remove();
    clearSkel(log);
    log.append(h('div', { class: 'msg user pending' }, h('div', { class: 'msg-text' }, text)), typing);
    toBottom();
    try {
      const { messages } = await api('/chat', { method: 'POST', body: { text } });
      log.querySelector('.msg.pending')?.remove();
      typing.remove();
      add(messages);
      toBottom();
    } catch (err) {
      typing.remove();
      log.querySelector('.msg.pending')?.classList.add('failed');
      handleError(err);
    } finally {
      busy = false;
      send.disabled = !input.value.trim();
    }
  };
  const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; };
  input.addEventListener('input', () => { send.disabled = busy || !input.value.trim(); grow(); });
  // Enter sends on a computer; on a phone the return key makes a new line
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(hover: hover)').matches) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  const form = h('form', { class: 'chat-compose', onsubmit: (e) => { e.preventDefault(); const t = input.value; input.value = ''; grow(); submit(t); } },
    h('div', { class: 'chat-quick' }, // the commands go to the server in Thai (it reads them); the chips show them in the chosen language
    ['สรุป', 'เดือนก่อน', 'ช่วย'].map((c) => h('button', { type: 'button', class: 'chip', onclick: () => submit(c) }, tx(c)))),
    h('div', { class: 'chat-row' }, input, send), note);
  const clearBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': tx('ล้างแชท'), title: tx('ล้างแชท') }, icon('trash'));
  let clearArmed = 0;
  clearBtn.addEventListener('click', async () => {
    if (!clearArmed) {
      clearBtn.classList.add('armed');
      toast(tx('แตะอีกครั้งเพื่อล้างแชททั้งหมด'));
      clearArmed = window.setTimeout(() => { clearArmed = 0; clearBtn.classList.remove('armed'); }, 3000);
      return;
    }
    window.clearTimeout(clearArmed);
    clearArmed = 0;
    clearBtn.classList.remove('armed');
    try {
      await api('/chat', { method: 'DELETE' });
      lastId = 0; firstId = 0; hasMore = false;
      log.replaceChildren(empty());
      refreshUnread();
      toast(tx('ล้างแชทแล้ว'));
    } catch (err) { handleError(err); }
  });
  shell(topBar(tx('แชท'), { back: '#/more', onRefresh: () => load(), extra: [clearBtn, pushButton()] }), older, log, form, tabs('#/more'));
  app.querySelector('.shell').classList.add('chat');
  // the composer sits right on top of the tab bar, whatever height that has on this device
  const nav = app.querySelector('.tabs');
  const place = () => { form.style.bottom = `${nav.offsetHeight}px`; };
  place();
  new ResizeObserver(place).observe(nav);
  await load();
  if (token !== viewToken) return;
  toBottom();
  timer = setInterval(() => document.visibilityState === 'visible' && !busy && load().catch(handleError), 15_000);
}

// ------------------------------------------------------------------ opening splash (index.html)
const splashStart = performance.now();
/** lifts the splash once, after the first page has drawn (or at the latest after 6 s) */
function hideSplash() {
  const s = document.getElementById('splash');
  if (!s || s.dataset.state) return;
  s.dataset.state = 'waiting';
  window.setTimeout(() => {
    s.dataset.state = 'fading';
    window.setTimeout(() => s.remove(), 320);
  }, Math.max(0, 450 - (performance.now() - splashStart)));
}
window.setTimeout(hideSplash, 6000);

// ------------------------------------------------------------------ routing
async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* token may already be gone */ }
  localStorage.removeItem(TOKEN_KEY);
  envId = null;
  location.hash = '#/';
  loginView();
}

function handleError(e) {
  if (e instanceof AuthError) return loginView(tx('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'));
  toast(tx('ผิดพลาด: {0}', e.message));
}

async function route() {
  clearInterval(timer);
  charts.forEach((c) => c.destroy());
  charts = [];
  const token = ++viewToken;
  if (!localStorage.getItem(TOKEN_KEY)) return loginView();
  const hash = location.hash || '#/';
  try {
    await ensureEnv();
    refreshUnread();
    const m = /^#\/c\/([0-9a-f]{12,64})$/.exec(hash);
    if (m) await containerView(token, m[1]);
    else if (hash === '#/containers') await containersView(token);
    else if (hash === '#/images') await imagesView(token);
    else if (hash === '#/volumes') await volumesView(token);
    else if (hash === '#/web') await webView(token);
    else if (hash === '#/backup') await backupView(token);
    else if (hash === '#/display') displayView();
    else if (hash === '#/more') moreView();
    else if (hash === '#/chat') await chatView(token);
    else if (hash === '#/security') await securityView(token, null);
    else if (/^#\/security\/[a-z]+$/.test(hash)) await securityView(token, hash.slice(11));
    else await overviewView(token);
  } catch (e) {
    if (token === viewToken) handleError(e);
  }
  hideSplash();
}

// ------------------------------------------------------------------ installed-app fixes (same as the other apps' lib/pwa-chrome.ts)
// the status bar takes the colour of what is at the top of the screen; small fields are lifted to
// 16px on touch so iOS doesn't zoom; bottom tabs squish and spring back when pressed
function installPwaChrome() {
  const opaque = (c) => !!c && c !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(c);
  // what stays at the top while the page scrolls: a fixed or sticky bar (header, PIN screen, splash)
  // gives its colour; scrolling content never does, the page background is used instead
  const topColor = () => {
    let seen = '';
    for (let el = document.elementFromPoint(window.innerWidth / 2, 1); el; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (!seen && opaque(cs.backgroundColor)) seen = cs.backgroundColor;
      if (cs.position === 'fixed' || cs.position === 'sticky') return seen || getComputedStyle(document.body).backgroundColor;
    }
    const page = getComputedStyle(document.body).backgroundColor;
    return opaque(page) ? page : getComputedStyle(document.documentElement).backgroundColor;
  };
  const sync = () => {
    const c = topColor();
    let metas = [...document.querySelectorAll('meta[name=\'theme-color\']')];
    if (!metas.length) {
      const m = document.createElement('meta');
      m.name = 'theme-color';
      document.head.append(m);
      metas = [m];
    }
    for (const m of metas) if (m.content !== c) m.content = c;
  };
  let timer = 0;
  const schedule = () => {
    if (!timer) timer = window.setTimeout(() => { timer = 0; sync(); }, 120);
  };
  sync();
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'data-theme', 'hidden', 'open'] });
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, { passive: true });
  dark.addEventListener('change', schedule);

  const FIELD = 'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]), textarea, select';
  const lift = (e) => {
    const el = e.target;
    if (el?.matches?.(FIELD) && parseFloat(getComputedStyle(el).fontSize) < 16) el.style.fontSize = '16px';
  };
  const touch = window.matchMedia('(pointer: coarse)').matches;
  if (touch) {
    window.addEventListener('touchstart', lift, { capture: true, passive: true });
    window.addEventListener('focusin', lift, true);
  }

  // a bottom-nav icon squishes and springs back when pressed (links marked data-tab-bounce)
  // animate the HTML wrapper ([data-tab-icon]), not the svg: an svg transform runs on the main thread and froze
  // (no bounce at all) while the next page was mounting; an HTML element's transform runs on the compositor
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const bounce = (e) => {
    const tab = (e.target)?.closest?.('[data-tab-bounce]');
    const glyph = tab?.querySelector('[data-tab-icon]') ?? tab?.querySelector('svg');
    if (!glyph || reduced.matches) return;
    glyph.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(0.75)', offset: 0.25 }, { transform: 'scale(1.12)', offset: 0.6 }, { transform: 'scale(1)' }],
      { duration: 450, easing: 'ease-out' },
    );
  };
  window.addEventListener('pointerdown', bounce, { passive: true });

  return () => {
    window.removeEventListener('pointerdown', bounce);
    observer.disconnect();
    window.clearTimeout(timer);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('scroll', schedule);
    dark.removeEventListener('change', schedule);
    if (touch) {
      window.removeEventListener('touchstart', lift, true);
      window.removeEventListener('focusin', lift, true);
    }
  };
}

installPwaChrome();
document.getElementById('splash')?.setAttribute('aria-label', tx('กำลังโหลด…'));

// a new page starts at its top
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); route(); });
// a deploy while the Home Screen app stays open (iOS keeps it for days): reload when app.js changes
{
  const stamp = () => fetch('app.js', { method: 'HEAD', cache: 'no-store' })
    .then((r) => r.headers.get('etag') ?? r.headers.get('last-modified')).catch(() => null);
  let loaded = null;
  stamp().then((v) => { loaded = v; });
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !loaded) return;
    const now = await stamp();
    if (now && now !== loaded) location.reload();
  });
}
// push only (see sw.js); Dock keeps working without it
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
route();
