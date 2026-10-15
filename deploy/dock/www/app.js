// Dock – a minimal Docker dashboard on top of Portainer's API (same origin, /api/* is proxied).
// No dependencies. All text from the server goes in via textContent, never as HTML.
import { chart } from './charts.js';
import { BRANDS } from './brands.js';
import { roll } from './roll.js';

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
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
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
  if (!env) throw new Error('ไม่พบ Docker environment ใน Portainer');
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
  if (s < 60) return 'เมื่อสักครู่';
  if (s < 3600) return `${Math.floor(s / 60)} นาทีที่แล้ว`;
  if (s < 86400) return `${Math.floor(s / 3600)} ชั่วโมงที่แล้ว`;
  return `${Math.floor(s / 86400)} วันที่แล้ว`;
}
/** Docker's English status ("Up 3 minutes (healthy)", "Exited (0) 2 hours ago") in Thai, without the health part */
function statusText(status = '') {
  const units = [[/seconds?/, 'วินาที'], [/minutes?/, 'นาที'], [/hours?/, 'ชั่วโมง'], [/days?/, 'วัน'], [/weeks?/, 'สัปดาห์'], [/months?/, 'เดือน'], [/years?/, 'ปี']];
  const dur = (d) => {
    d = d.replace(/^About an? /i, '~1 ').replace(/^Less than a second/i, '<1 second');
    for (const [re, th] of units) d = d.replace(re, th);
    return d.replace(/^an? /i, '1 ');
  };
  const s = status.replace(/\s*\((healthy|unhealthy|health: starting)\)/, '');
  let m = /^Up (.+)$/.exec(s);
  if (m) return `ทำงานมา ${dur(m[1])}`;
  m = /^Exited \((\d+)\) (.+) ago$/.exec(s);
  if (m) return `หยุดเมื่อ ${dur(m[2])}ที่แล้ว${m[1] !== '0' ? ` (รหัส ${m[1]})` : ''}`;
  return s;
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
  'thai-weather/web': ['nextdotjs', 'ฟ้าละเอียด'], 'thai-weather/api': ['fastapi', 'ฟ้าละเอียด'], 'thai-weather/verify': ['python', 'ฟ้าละเอียด'],
  'apps/portfolio': ['nextdotjs', 'Portfolio'], 'apps/media': ['bun', 'Portfolio'],
  'apps/expenses': ['nextdotjs', 'Spent/Cost'], 'apps/reminders': ['bun', 'Spent/Cost'],
  'apps/whiteboard': ['nextdotjs', 'Whiteboard'], 'apps/rooms': ['bun', 'Whiteboard'],
  'apps/drive-music': ['nextdotjs', 'Drive Music'], 'apps/sync': ['bun', 'Drive Music'],
  'apps/db': ['postgresql', 'ฐานข้อมูล'], 'apps/rest': ['postgresql', 'ฐานข้อมูล'], 'apps/dbgw': ['bun', 'ฐานข้อมูล'],
  'apps/status': ['bun', 'ระบบส่วนกลาง'], 'apps/analytics': ['bun', 'ระบบส่วนกลาง'], 'apps/backup': ['bun', 'ระบบส่วนกลาง'], 'apps/chat': ['bun', 'ระบบส่วนกลาง'],
  'thai-weather/nginx-proxy-manager': ['nginxproxymanager', 'จัดการเซิร์ฟเวอร์'], 'thai-weather/portainer': ['portainer', 'จัดการเซิร์ฟเวอร์'],
  'thai-weather/dock': ['nginx', 'จัดการเซิร์ฟเวอร์'], 'thai-weather/dock-metrics': ['bun', 'จัดการเซิร์ฟเวอร์'],
};
const GROUP_ORDER = ['ฟ้าละเอียด', 'Portfolio', 'Spent/Cost', 'Whiteboard', 'Drive Music', 'ฐานข้อมูล', 'ระบบส่วนกลาง', 'จัดการเซิร์ฟเวอร์'];
function serviceOf(c) {
  const l = labelsOf(c);
  const known = SERVICES[`${l['com.docker.compose.project']}/${l['com.docker.compose.service']}`];
  return { brand: known?.[0] ?? 'docker', group: known?.[1] ?? l['com.docker.compose.project'] ?? 'อื่น ๆ' };
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
  const svg = h('svg', { viewBox: '0 0 24 24', class: 'brand-ic', role: 'img', 'aria-label': b.title }, h('path', { d: b.path, fill: b.hex ?? 'currentColor' }));
  svg.prepend(document.createElementNS('http://www.w3.org/2000/svg', 'title'));
  svg.firstChild.textContent = b.title;
  return svg;
}
const groupTag = (g, n) => h('h2', { class: 'group-tag' }, h('span', { class: 'tag-chip' }, g), h('span', { class: 'group-count' }, `${n}`));

/** running + health → dot class and a Thai word */
function stateOf(c) {
  const state = c.State?.Status ?? c.State; // inspect has an object, list a string
  const health = c.State?.Health?.Status ?? /\((healthy|unhealthy|health: starting)\)/.exec(c.Status ?? '')?.[1];
  if (state === 'running') {
    if (health === 'unhealthy') return { cls: 'bad', label: 'ไม่ปกติ (unhealthy)' };
    if (health && health.includes('starting')) return { cls: 'warn', label: 'กำลังเริ่ม' };
    return { cls: 'ok', label: health === 'healthy' ? 'ปกติ (healthy)' : 'ทำงาน' };
  }
  if (state === 'restarting') return { cls: 'warn', label: 'กำลังรีสตาร์ท' };
  if (state === 'paused') return { cls: 'warn', label: 'หยุดชั่วคราว' };
  if (state === 'exited' || state === 'dead') return { cls: '', label: 'หยุดอยู่' };
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
  ['#/', 'pulse', 'ภาพรวม'],
  ['#/containers', 'box', 'คอนเทนเนอร์'],
  ['#/images', 'layers', 'อิมเมจ'],
  ['#/volumes', 'disk', 'วอลุ่ม'],
  ['#/web', 'chart', 'สถิติเว็บ'],
  ['#/more', 'more', 'เพิ่มเติม'],
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
  return h('nav', { class: 'tabs', 'aria-label': 'เมนู' },
    TABS.map(([href, ic, label]) => h('a', {
      href, 'aria-current': href === current ? 'page' : false, 'data-tab-bounce': true,
      onclick: (e) => {
        if (location.hash === href || (!location.hash && href === '#/')) {
          e.preventDefault();
          window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        }
      },
    }, h('span', { class: 'tab-ic' }, icon(ic), href === '#/more' ? badge() : null), label)));
}
function topBar(title, { back, onRefresh, extra } = {}) {
  const refresh = onRefresh
    ? h('button', {
        class: 'icon-btn', type: 'button', 'aria-label': 'รีเฟรช', title: 'รีเฟรช',
        onclick: async (e) => {
          const b = e.currentTarget;
          b.classList.add('spin');
          try { await onRefresh(); } finally { b.classList.remove('spin'); }
        },
      }, icon('refresh'))
    : null;
  return h('header', { class: 'top' },
    back ? h('a', { class: 'icon-btn', href: back, 'aria-label': 'กลับ' }, icon('back')) : null,
    h('h1', {}, title),
    extra ?? null,
    refresh,
    back || !PORTAINER_URL ? null : h('a', { class: 'icon-btn', href: PORTAINER_URL, 'aria-label': 'เปิด Portainer เต็ม', title: 'Portainer เต็ม', target: '_blank', rel: 'noopener' }, icon('ext')),
    back ? null : h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'ออกจากระบบ', title: 'ออกจากระบบ', onclick: logout }, icon('out')));
}
function shell(...children) {
  app.replaceChildren(h('main', { class: 'shell' }, ...children));
}
const skeleton = (n = 4) => Array.from({ length: n }, () => h('div', { class: 'skeleton' }));

// ------------------------------------------------------------------ views
function loginView(message = '') {
  const err = h('p', { class: 'error', role: 'alert' }, message);
  const user = h('input', { class: 'field', name: 'username', autocomplete: 'username', placeholder: 'ชื่อผู้ใช้', required: true, autocapitalize: 'none' });
  const pass = h('input', { class: 'field', name: 'password', type: 'password', autocomplete: 'current-password', placeholder: 'รหัสผ่าน', required: true });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'เข้าสู่ระบบ');
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
        err.textContent = ex instanceof AuthError || /invalid|credential/i.test(ex.message) ? 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' : `เข้าสู่ระบบไม่สำเร็จ: ${ex.message}`;
      } finally {
        submit.disabled = false;
      }
    },
  },
  h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('box')), 'Dock'),
  user, pass, err, submit,
  h('p', { class: 'hint' }, 'ใช้บัญชีเดียวกับ Portainer'));
  app.replaceChildren(h('main', { class: 'login' }, form));
  hideSplash();
  user.focus();
}

async function containersView(token) {
  const body = h('div', {}, skeleton());
  const meta = h('p', { class: 'meta' }, ' ');
  const rows = new Map(); // container id → its row and the parts that change
  const sections = new Map(); // group → its section
  const load = async () => {
    const [list, info] = await Promise.all([docker('/containers/json?all=1'), docker('/info')]);
    if (token !== viewToken) return;
    const running = list.filter((c) => c.State === 'running');
    const metaText = `${running.length}/${list.length}| ทำงาน · ${info.NCPU} CPU · ${fmtBytes(info.MemTotal)} · ${info.OperatingSystem}`;
    if (meta.dataset.v !== metaText) {
      meta.dataset.v = metaText;
      meta.replaceChildren(h('b', {}, `${running.length}/${list.length}`), ' ทำงาน · ', `${info.NCPU} CPU · ${fmtBytes(info.MemTotal)} · ${info.OperatingSystem}`);
    }
    // grouped by the app they belong to. Rows are made once and then only their changed text is
    // touched, so a refresh never blanks the CPU / RAM numbers (no flicker).
    if (!list.length) { body.replaceChildren(h('div', { class: 'list' }, h('p', { class: 'empty' }, 'ยังไม่มีคอนเทนเนอร์'))); return; }
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
          r = { el: h('a', { class: 'row', href: `#/c/${c.Id}` }, dot,
            h('span', { class: 'row-main' }, h('span', { class: 'row-title name-with-ic' }, h('span', { class: 'name-text' }, nameOf(c)), brandIcon(serviceOf(c).brand)), sub),
            side, icon('chev', 'chev')), dot, sub, cpu: side.firstChild, mem: side.lastChild };
          rows.set(c.Id, r);
        }
        if (r.dot.getAttribute('class') !== `dot ${st.cls}`) r.dot.setAttribute('class', `dot ${st.cls}`);
        r.dot.title = st.label;
        setText(r.sub, `${st.label} · ${statusText(c.Status)}`);
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
  shell(topBar('คอนเทนเนอร์', { onRefresh: load }), meta, body, tabs('#/containers'));
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
      b.textContent = 'กำลังทำ…';
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
      ? confirmButton('หยุด', 'ยืนยันหยุด?', () => act('stop', `หยุด ${name} แล้ว`), { danger: true, disabled: guarded })
      : h('button', { class: 'btn primary', type: 'button', onclick: (e) => { e.currentTarget.disabled = true; act('start', `เริ่ม ${name} แล้ว`).catch(handleError); } }, 'เริ่ม'),
    running ? confirmButton('รีสตาร์ท', 'ยืนยันรีสตาร์ท?', () => act('restart', `รีสตาร์ท ${name} แล้ว`)) : null);

  const statBox = (label, value, sub) => h('div', { class: 'stat' }, h('span', {}, label), h('b', {}, value), sub ? h('small', {}, sub) : null);
  const statsEl = h('div', { class: 'stats' }, statBox('CPU', '…'), statBox('หน่วยความจำ', '…'), statBox('เครือข่าย', '…'));

  const ports = Object.entries(c.NetworkSettings?.Ports ?? {})
    .map(([p, binds]) => (binds?.length ? binds.map((b) => `${b.HostIp || '0.0.0.0'}:${b.HostPort} → ${p}`).join(', ') : p));
  const mounts = (c.Mounts ?? []).map((m) => `${m.Name || m.Source} → ${m.Destination}${m.RW ? '' : ' (ro)'}`);
  const kv = (pairs) => h('div', { class: 'list' }, h('dl', { class: 'kv' }, pairs.filter(([, v]) => v).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
  const info = kv([
    ['อิมเมจ', c.Config.Image],
    ['สร้างเมื่อ', ago(Date.parse(c.Created) / 1000)],
    ['เริ่มเมื่อ', running ? ago(Date.parse(c.State.StartedAt) / 1000) : null],
    ['รีสตาร์ทอัตโนมัติ', c.HostConfig?.RestartPolicy?.Name || 'no'],
    ['พอร์ต', ports.join('\n') || 'ภายในเท่านั้น'],
    ['เครือข่าย', Object.keys(c.NetworkSettings?.Networks ?? {}).join(', ')],
    ['ข้อมูลที่เมานต์', mounts.join('\n')],
  ]);

  const logsEl = h('pre', { class: 'logs', tabindex: '0', 'aria-label': 'log' }, 'กำลังโหลด…');
  const follow = h('input', { type: 'checkbox', checked: true });
  const loadLogs = async () => {
    const res = await docker(`/containers/${id}/logs?stdout=1&stderr=1&tail=300`, { raw: true });
    const lines = parseLogs(await res.arrayBuffer(), c.Config.Tty);
    if (token !== viewToken) return;
    const atBottom = logsEl.scrollHeight - logsEl.scrollTop - logsEl.clientHeight < 40;
    logsEl.replaceChildren(...(lines.length ? lines.map((l) => (l.err ? h('span', { class: 'err' }, `${l.t}\n`) : `${l.t}\n`)) : ['(ไม่มี log)']));
    if (atBottom || logsEl.dataset.first !== '1') { logsEl.scrollTop = logsEl.scrollHeight; logsEl.dataset.first = '1'; }
  };
  const loadStats = async () => {
    if (!running) { patchChildren(statsEl, [statBox('สถานะ', 'หยุดอยู่', c.State.FinishedAt ? ago(Date.parse(c.State.FinishedAt) / 1000) : '')]); return; }
    const u = await stats(id);
    if (token !== viewToken || !u) return;
    patchChildren(statsEl, [
      statBox('CPU', fmtPct(u.cpu)),
      statBox('หน่วยความจำ', fmtBytes(u.mem), u.limit ? `จาก ${fmtBytes(u.limit)}` : ''),
      statBox('เครือข่าย', `↓ ${fmtBytes(u.rx)}`, `↑ ${fmtBytes(u.tx)}`)]);
  };

  // CPU / RAM history of this container from dock-metrics (last hour)
  const history = h('section', { class: 'group' }, h('h2', { class: 'group-title' }, 'ย้อนหลัง 1 ชั่วโมง'));
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
    const mem = { times: mx.times, series: [{ name: 'หน่วยความจำ', color: 'var(--s2)', values: c.mem ?? [] }], kind: 'area', format: (v) => fmtBytes(v), step: mx.step };
    if (!histCharts) {
      const a = h('div', { class: 'card' }, h('h3', { class: 'card-title' }, 'CPU'));
      const b = h('div', { class: 'card' }, h('h3', { class: 'card-title' }, 'หน่วยความจำ'));
      histGrid.append(a, b);
      histCharts = [mkChart(a, { ...cpu, label: `CPU ของ ${name}`, height: 140 }), mkChart(b, { ...mem, label: `หน่วยความจำของ ${name}`, height: 140 })];
    } else {
      histCharts[0].update(cpu);
      histCharts[1].update(mem);
    }
  };

  shell(
    topBar(name, { back: '#/containers', onRefresh: () => Promise.all([loadStats(), loadLogs(), loadHistory()]) }),
    h('p', { class: 'meta' }, h('span', { class: 'pill' }, h('span', { class: `dot ${st.cls}` }), st.label)),
    actions,
    guarded && running ? h('p', { class: 'note' }, 'หยุดไม่ได้จากที่นี่ — ถ้าหยุดจะเข้าหน้านี้ไม่ได้ (รีสตาร์ทได้)') : null,
    statsEl,
    history,
    h('section', { class: 'group' },
      h('div', { class: 'logs-head' }, h('h2', { class: 'group-title' }, 'Log ล่าสุด'), h('label', { class: 'switch' }, follow, 'อัปเดตอัตโนมัติ')),
      logsEl),
    h('section', { class: 'group' }, h('h2', { class: 'group-title' }, 'ข้อมูล'), info),
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

async function imagesView(token) {
  const body = h('div', {}, skeleton());
  const meta = h('p', { class: 'meta' }, ' ');
  const load = async () => {
    const df = await docker('/system/df');
    if (token !== viewToken) return;
    const images = [...(df.Images ?? [])].sort((a, b) => b.Size - a.Size);
    const total = images.reduce((s, i) => s + i.Size, 0);
    const unused = images.filter((i) => !i.Containers).length;
    meta.replaceChildren(h('b', {}, `${images.length}`), ` อิมเมจ · ${fmtBytes(total)}`, unused ? ` · ไม่ได้ใช้ ${unused}` : '');
    body.replaceChildren(h('div', { class: 'list' }, images.length
      ? images.map((i) => {
          const tag = i.RepoTags?.find((t) => t !== '<none>:<none>') ?? i.Id.replace('sha256:', '').slice(0, 12);
          return h('div', { class: 'row' },
            h('span', { class: 'row-main' },
              h('span', { class: 'row-title' }, tag),
              h('span', { class: 'row-sub' }, `${ago(i.Created)}${i.Containers ? '' : ' · '}`, i.Containers ? '' : h('span', { class: 'tag' }, 'ไม่ได้ใช้'))),
            h('span', { class: 'row-side' }, h('b', {}, fmtBytes(i.Size)), i.Containers ? `ใช้ ${i.Containers}` : ''));
        })
      : h('p', { class: 'empty' }, 'ไม่มีอิมเมจ')));
  };
  shell(topBar('อิมเมจ', { onRefresh: load }), meta, body, tabs('#/images'));
  await load();
}

async function volumesView(token) {
  const body = h('div', {}, skeleton(3));
  const meta = h('p', { class: 'meta' }, ' ');
  const load = async () => {
    const df = await docker('/system/df');
    if (token !== viewToken) return;
    const vols = [...(df.Volumes ?? [])].sort((a, b) => (b.UsageData?.Size ?? 0) - (a.UsageData?.Size ?? 0));
    const total = vols.reduce((s, v) => s + Math.max(0, v.UsageData?.Size ?? 0), 0);
    meta.replaceChildren(h('b', {}, `${vols.length}`), ` วอลุ่ม · ${fmtBytes(total)}`);
    body.replaceChildren(h('div', { class: 'list' }, vols.length
      ? vols.map((v) => {
          const refs = v.UsageData?.RefCount ?? 0;
          return h('div', { class: 'row' },
            h('span', { class: 'row-main' },
              h('span', { class: 'row-title' }, v.Name),
              h('span', { class: 'row-sub' }, refs ? `ใช้โดย ${refs} คอนเทนเนอร์` : 'ไม่ได้ใช้')),
            h('span', { class: 'row-side' }, h('b', {}, fmtBytes(v.UsageData?.Size ?? NaN))));
        })
      : h('p', { class: 'empty' }, 'ไม่มีวอลุ่ม')));
  };
  shell(topBar('วอลุ่ม', { onRefresh: load }), meta, body, tabs('#/volumes'));
  await load();
}


// ------------------------------------------------------------------ overview (host, proxy traffic, containers)
const metrics = (range) => api(`/metrics?range=${range}`);
const RANGES = [['1h', '1 ชม.', 10_000], ['24h', '24 ชม.', 60_000], ['7d', '7 วัน', 300_000]];
const fmtRate = (b, short) => (Number.isFinite(b) ? `${fmtBytes(b)}${short ? '' : '/s'}` : '–');
const fmtNum = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('th-TH') : '–');
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
  return d ? `${d} วัน ${hrs} ชม.` : hrs ? `${hrs} ชม. ${min} นาที` : `${min} นาที`;
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
  const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'ช่วงเวลา' },
    RANGES.map(([r, label]) => h('button', {
      type: 'button', 'aria-pressed': r === overviewRange ? 'true' : 'false',
      onclick: () => {
        overviewRange = r;
        try { localStorage.setItem('dock.range', r); } catch { /* ignore */ }
        route();
      },
    }, label)));
  const live = h('span', { class: 'live' }, h('span', { class: 'dot ok' }), 'สด');
  const hostLine = h('p', { class: 'meta' }, ' ');
  const hostTiles = h('div', { class: 'tiles' }, skeleton(4));
  const chartsGrid = h('div', { class: 'grid' });
  const ngTiles = h('div', { class: 'tiles' });
  const ngGrid = h('div', { class: 'grid' });
  const ngTables = h('div', { class: 'grid' });
  const ctrGrid = h('div', { class: 'ctr-groups' });
  const groupGrids = new Map(); // group → { section, grid }
  const ctrMem = h('div', { class: 'grid' });
  const body = h('div', { class: 'overview' },
    h('div', { class: 'filters' }, seg, live),
    hostLine, hostTiles, chartsGrid,
    h('h2', { class: 'section-title' }, 'ทราฟฟิกเว็บ (Nginx Proxy Manager)'), ngTiles, ngGrid, ngTables,
    h('h2', { class: 'section-title' }, 'คอนเทนเนอร์'), ctrMem, ctrGrid);
  shell(topBar('ภาพรวม', { onRefresh: () => load() }), body, tabs('#/'));
  app.querySelector('.shell').classList.add('wide');

  const C = {}; // chart handles, created on first data
  const ctrCards = new Map();
  const load = async () => {
    body.classList.add('loading');
    const [mx, list] = await Promise.all([metrics(overviewRange), docker('/containers/json?all=1')]);
    if (token !== viewToken) return;
    body.classList.remove('loading');
    const { times, step, host: hs, snapshot: sn } = mx;
    const T = { times, step };

    // ---- host line + tiles
    hostLine.replaceChildren(h('b', {}, sn.hostname), ` · ${sn.os} · เคอร์เนล ${sn.kernel} · เปิดเครื่องมา ${uptimeText(sn.uptime_s)} · ${sn.cpus} CPU · โปรเซส ${String(sn.procs).split('/')[1] ?? '–'}`);
    const cpuNow = (lastOf(hs.cpu_user) ?? 0) + (lastOf(hs.cpu_system) ?? 0) + (lastOf(hs.cpu_iowait) ?? 0);
    const cpuAvg = avgOf((hs.cpu_user ?? []).map((v, i) => (v === null ? null : v + (hs.cpu_system?.[i] ?? 0) + (hs.cpu_iowait?.[i] ?? 0))));
    const memUsed = sn.mem_total - sn.mem_available;
    const memPct = (memUsed / sn.mem_total) * 100;
    const diskPct = (sn.disk_used / sn.disk_total) * 100;
    const swapUsed = sn.swap_total - sn.swap_free;
    patchChildren(hostTiles, [
      tile('CPU ตอนนี้', fmtPct(cpuNow), `เฉลี่ยช่วงนี้ ${fmtPct(cpuAvg)} · สูงสุด ${fmtPct(maxOf((hs.cpu_user ?? []).map((v, i) => (v ?? 0) + (hs.cpu_system?.[i] ?? 0) + (hs.cpu_iowait?.[i] ?? 0))))}`, cpuNow, pctTone(cpuNow)),
      tile('หน่วยความจำ', fmtBytes(memUsed), `จาก ${fmtBytes(sn.mem_total)} · ${fmtPct(memPct)}`, memPct, pctTone(memPct)),
      tile('ดิสก์', fmtBytes(sn.disk_used), `ว่าง ${fmtBytes(sn.disk_free)} จาก ${fmtBytes(sn.disk_total)}`, diskPct, pctTone(diskPct)),
      tile('Load (1 นาที)', sn.load[0].toFixed(2), `5 นาที ${sn.load[1].toFixed(2)} · 15 นาที ${sn.load[2].toFixed(2)} · เต็ม = ${sn.cpus}.00`, (sn.load[0] / sn.cpus) * 100, pctTone((sn.load[0] / sn.cpus) * 100)),
      tile('เครือข่ายตอนนี้', `↓ ${fmtRate(lastOf(hs.net_rx))}`, `↑ ${fmtRate(lastOf(hs.net_tx))}`),
      tile('Swap', fmtBytes(swapUsed), `จาก ${fmtBytes(sn.swap_total)}`, sn.swap_total ? (swapUsed / sn.swap_total) * 100 : NaN, ''),
    ]);

    // ---- host charts
    const hostCharts = [
      ['cpu', 'CPU', '% ของทุกคอร์', { ...T, kind: 'stack', max: 100, format: (v) => fmtPct(v),
        series: [
          { name: 'ผู้ใช้ (user)', color: SERIES[0], values: hs.cpu_user ?? [] },
          { name: 'ระบบ (system)', color: SERIES[1], values: hs.cpu_system ?? [] },
          { name: 'รอดิสก์ (iowait)', color: SERIES[2], values: hs.cpu_iowait ?? [] },
        ] }],
      ['mem', 'หน่วยความจำ', `ทั้งหมด ${fmtBytes(sn.mem_total)}`, { ...T, kind: 'stack', format: (v) => fmtBytes(v), ref: { value: sn.mem_total, label: 'ทั้งหมด' },
        series: [
          { name: 'ใช้งาน', color: SERIES[0], values: hs.mem_used ?? [] },
          { name: 'แคช (คืนได้)', color: SERIES[2], values: hs.mem_cache ?? [] },
        ] }],
      ['net', 'เครือข่าย', 'ไบต์ต่อวินาที', { ...T, kind: 'line', format: (v, axis) => fmtRate(v, axis),
        series: [
          { name: 'รับ ↓', color: SERIES[0], values: hs.net_rx ?? [] },
          { name: 'ส่ง ↑', color: SERIES[1], values: hs.net_tx ?? [] },
        ] }],
      ['disk', 'ดิสก์ I/O', 'ไบต์ต่อวินาที', { ...T, kind: 'line', format: (v, axis) => fmtRate(v, axis),
        series: [
          { name: 'อ่าน', color: SERIES[0], values: hs.disk_rd ?? [] },
          { name: 'เขียน', color: SERIES[1], values: hs.disk_wr ?? [] },
        ] }],
      ['load', 'Load average (1 นาที)', `เส้นอ้างอิง = ${sn.cpus} CPU`, { ...T, kind: 'area', format: (v) => v.toFixed(2), ref: { value: sn.cpus, label: `${sn.cpus} CPU` },
        series: [{ name: 'Load', color: SERIES[0], values: hs.load1 ?? [] }] }],
      ['swap', 'Swap ที่ใช้', `ทั้งหมด ${fmtBytes(sn.swap_total)}`, { ...T, kind: 'area', format: (v) => fmtBytes(v),
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
      tile('คำขอทั้งหมด', fmtNum(allReq), `เฉลี่ย ${(allReq / spanMin).toFixed(1)} ต่อนาที`),
      tile('ผู้เข้าชม (IP ไม่ซ้ำ)', fmtNum(mx.top?.unique_clients), 'นับจาก log ของ proxy'),
      tile('ข้อผิดพลาด 4xx / 5xx', `${fmtNum(cls('s4'))} / ${fmtNum(cls('s5'))}`, allReq ? `${((errors / allReq) * 100).toFixed(1)}% ของคำขอ` : '–', allReq ? (errors / allReq) * 100 : NaN, errors / Math.max(1, allReq) > 0.05 ? 'warn' : ''),
      tile('ข้อมูลที่ส่งออก', fmtBytes(bytes), 'body ของ response'),
    ]);
    const short = (hn) => hn.replace(/\.chakkritton\.com$/, '');
    const reqOpts = { ...T, kind: 'columns', legend: 'sum', format: (v) => fmtNum(v),
      series: hosts.map((k, i) => ({ name: short(k), color: SERIES[i % SERIES.length], values: ng[k].req ?? [] })) };
    const statusOpts = { ...T, kind: 'columns', legend: 'sum', format: (v) => fmtNum(v),
      series: [
        { name: '2xx สำเร็จ', color: 'var(--good)', values: ng.all?.s2 ?? [] },
        { name: '3xx เปลี่ยนเส้นทาง', color: 'var(--neutral)', values: ng.all?.s3 ?? [] },
        { name: '4xx คำขอผิด', color: 'var(--warning)', values: ng.all?.s4 ?? [] },
        { name: '5xx เซิร์ฟเวอร์ผิดพลาด', color: 'var(--critical)', values: ng.all?.s5 ?? [] },
      ] };
    const bwOpts = { ...T, kind: 'stack', legend: 'sum', format: (v) => fmtBytes(v),
      series: hosts.map((k, i) => ({ name: short(k), color: SERIES[i % SERIES.length], values: ng[k].bytes ?? [] })) };
    for (const [key, title, sub, opts] of [
      ['req', 'คำขอตามเว็บไซต์', 'จำนวนต่อช่วง', reqOpts],
      ['status', 'สถานะ HTTP', 'ทุกเว็บไซต์', statusOpts],
      ['bw', 'ข้อมูลที่ส่งออกตามเว็บไซต์', 'ไบต์ต่อช่วง', bwOpts],
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
      card('สรุปตามเว็บไซต์', null, h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('tr', {}, h('th', {}, 'เว็บไซต์'), h('th', { class: 'num' }, 'คำขอ'), h('th', { class: 'num' }, 'ผิดพลาด'), h('th', { class: 'num' }, 'ส่งออก'), h('th', {}, 'สัดส่วน')),
        siteRows))),
      card('หน้าที่ถูกเรียกมากที่สุด', 'ไม่รวมไฟล์ static', h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('tr', {}, h('th', {}, 'เว็บไซต์'), h('th', {}, 'คำขอ'), h('th', { class: 'num' }, 'ครั้ง')),
        pathRows.length ? pathRows : h('tr', {}, h('td', { colspan: 3 }, 'ยังไม่มีข้อมูล')))))]);

    // ---- containers: memory stack + small multiples
    const names = new Map(list.map((c) => [c.Id.slice(0, 12), { name: nameOf(c), c }]));
    const ids = Object.keys(mx.containers ?? {}).filter((id) => names.has(id)).sort((a, b) => names.get(a).name.localeCompare(names.get(b).name));
    const color = (i) => SERIES[i % SERIES.length];
    const memOpts = { ...T, kind: 'stack', format: (v) => fmtBytes(v), ref: { value: sn.mem_total, label: 'RAM ทั้งเครื่อง' },
      series: ids.map((id, i) => ({ name: names.get(id).name, color: color(i), values: mx.containers[id].mem ?? [] })) };
    const cpuOpts = { ...T, kind: 'line', format: (v) => fmtPct(v),
      series: ids.map((id, i) => ({ name: names.get(id).name, color: color(i), values: mx.containers[id].cpu ?? [] })) };
    for (const [key, title, sub, opts] of [
      ['cmem', 'หน่วยความจำต่อคอนเทนเนอร์', 'ซ้อนกัน = รวมทั้งหมด', memOpts],
      ['ccpu', 'CPU ต่อคอนเทนเนอร์', '% ของทุกคอร์', cpuOpts],
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
        const head = h('a', { class: 'mini-head', href: `#/c/${c.Id}` }, h('span', { class: `dot ${st.cls}` }),
          h('span', { class: 'row-title name-with-ic' }, h('span', { class: 'name-text' }, name), brandIcon(serviceOf(c).brand)), icon('chev', 'chev'));
        const stWrap = h('div', { class: 'mini-stats' },
          ['CPU', 'RAM', '↓ เน็ต', 'เขียนดิสก์'].map((label, k) => h('span', {}, h('b', {}, values[k]), label)));
        const cpuBox = h('div', { class: 'mini-chart' }, h('span', { class: 'mini-label' }, 'CPU'));
        const memBox = h('div', { class: 'mini-chart' }, h('span', { class: 'mini-label' }, 'RAM'));
        const el2 = h('section', { class: 'card mini' }, head, stWrap, cpuBox, memBox);
        groupGrids.get(serviceOf(c).group).grid.append(el2);
        e = { el: el2, stWrap, cpu: mkChart(cpuBox, { ...cpuO, label: `CPU ของ ${name}` }), mem: mkChart(memBox, { ...memO, label: `RAM ของ ${name}` }) };
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

// ------------------------------------------------------------------ web analytics
// Page views + Web Vitals from the sites themselves (the analytics service; replaces Vercel Analytics).
const WEB_RANGES = [[7, '7 วัน'], [30, '30 วัน'], [90, '90 วัน']];
let webDays = (() => { try { return Number(localStorage.getItem('dock.webDays')) || 7; } catch { return 7; } })();
let webHost = (() => { try { return localStorage.getItem('dock.webHost') || ''; } catch { return ''; } })();
const siteName = (hn) => (hn === 'chakkritton.com' ? 'portfolio' : hn.replace(/\.chakkritton\.com$/, ''));
/** Google's "good / needs improvement" limits for the 75th percentile */
const VITALS = [
  ['LCP', 'Largest Contentful Paint', 2500, 4000, (v) => `${(v / 1000).toFixed(2)} วิ`],
  ['INP', 'Interaction to Next Paint', 200, 500, (v) => `${Math.round(v)} ms`],
  ['CLS', 'Cumulative Layout Shift', 0.1, 0.25, (v) => v.toFixed(3)],
  ['FCP', 'First Contentful Paint', 1800, 3000, (v) => `${(v / 1000).toFixed(2)} วิ`],
  ['TTFB', 'Time to First Byte', 800, 1800, (v) => `${Math.round(v)} ms`],
];
const vitalTone = (v, good, poor) => (v === null || v === undefined ? '' : v <= good ? 'ok' : v <= poor ? 'warn' : 'bad');
const vitalText = (tone) => ({ ok: 'ดี', warn: 'ควรปรับ', bad: 'แย่' })[tone] ?? '–';
const COUNTRY = new Intl.DisplayNames(['th'], { type: 'region' });
const countryName = (c) => { try { return COUNTRY.of(c) ?? c; } catch { return c; } };

async function webView(token) {
  const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'ช่วงเวลา' },
    WEB_RANGES.map(([d, label]) => h('button', {
      type: 'button', 'aria-pressed': d === webDays ? 'true' : 'false',
      onclick: () => { webDays = d; try { localStorage.setItem('dock.webDays', String(d)); } catch { /* ignore */ } route(); },
    }, label)));
  const sites = h('div', { class: 'segmented scroll', role: 'group', 'aria-label': 'เว็บไซต์' });
  const tiles = h('div', { class: 'tiles' }, skeleton(4));
  const chartGrid = h('div', { class: 'grid' });
  const tables = h('div', { class: 'grid' });
  const vitalsBox = h('div', {});
  const body = h('div', { class: 'overview' },
    h('div', { class: 'filters' }, seg, sites),
    tiles, chartGrid,
    h('h2', { class: 'section-title' }, 'ความเร็วที่ผู้ใช้จริงเห็น (Web Vitals, p75)'), vitalsBox,
    h('h2', { class: 'section-title' }, 'มาจากไหน ดูอะไร'), tables);
  shell(topBar('สถิติเว็บ', { onRefresh: () => load() }), body, tabs('#/web'));
  app.querySelector('.shell').classList.add('wide');
  let views = null;

  const load = async () => {
    body.classList.add('loading');
    const st = await api(`/analytics?days=${webDays}${webHost ? `&host=${encodeURIComponent(webHost)}` : ''}`);
    if (token !== viewToken) return;
    body.classList.remove('loading');
    sites.replaceChildren(...[['', 'ทุกเว็บ'], ...st.hosts.map((hn) => [hn, siteName(hn)])].map(([hn, label]) => h('button', {
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
      tile('ผู้เข้าชม', fmtNum(total.visitors), 'นับแยกรายวัน ไม่ใช้คุกกี้'),
      tile('เพจวิว', fmtNum(total.views), `เฉลี่ย ${fmtNum(total.views / st.days)} ต่อวัน`),
      tile('หน้าต่อการเข้าชม', total.visitors ? (total.views / total.visitors).toFixed(1) : '–', 'เพจวิว ÷ ผู้เข้าชม'),
      tile('LCP (p75)', lcp ? VITALS[0][4](lcp.p75) : '–', lcp ? `${vitalText(lcpTone)} · จาก ${fmtNum(lcp.n)} ครั้ง` : 'ยังไม่มีข้อมูล'),
    ]);
    // whole numbers on the axis even for a quiet week
    const opts = { times, step: DAY, kind: 'columns', legend: 'sum', format: (v) => fmtNum(v), ...(Math.max(...pv) < 4 ? { max: 4 } : {}),
      series: [{ name: 'เพจวิว', color: SERIES[0], values: pv }, { name: 'ผู้เข้าชม', color: SERIES[1], values: uv }] };
    if (!views) {
      const c = card('ผู้เข้าชมและเพจวิวรายวัน', st.host ? siteName(st.host) : 'ทุกเว็บไซต์');
      chartGrid.append(c);
      views = mkChart(c, { ...opts, label: 'ผู้เข้าชมและเพจวิวรายวัน' });
    } else views.update(opts);

    patchChildren(vitalsBox, [card('Web Vitals', 'ค่าที่ 75% ของการเข้าชมทำได้ดีกว่านี้', h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('tr', {}, h('th', {}, 'ตัวชี้วัด'), h('th', { class: 'num' }, 'ทั้งหมด'), h('th', { class: 'num' }, 'มือถือ'), h('th', { class: 'num' }, 'เดสก์ท็อป'), h('th', {}, 'ผล')),
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
      h('tr', {}, h('th', {}, head), h('th', { class: 'num' }, 'ผู้เข้าชม'), h('th', { class: 'num' }, 'เพจวิว')),
      rows.length ? rows.map((r) => h('tr', {}, h('td', { class: render === 'mono' ? 'mono' : '' }, typeof render === 'function' ? render(r.key) : r.key),
        h('td', { class: 'num' }, fmtNum(r.visitors)), h('td', { class: 'num' }, fmtNum(r.views))))
        : h('tr', {}, h('td', { colspan: 3 }, 'ยังไม่มีข้อมูล')))));
    patchChildren(tables, [
      ...(st.host ? [] : [table('ตามเว็บไซต์', null, 'เว็บไซต์', st.perHost, siteName)]),
      table('หน้าที่ถูกเปิดมากที่สุด', null, 'หน้า', st.pages, 'mono'),
      table('มาจาก', 'เว็บที่ลิงก์มา (ไม่นับการเข้าตรง)', 'แหล่งที่มา', st.referrers),
      table('ประเทศ', 'จาก Cloudflare', 'ประเทศ', st.countries, countryName),
      table('อุปกรณ์', null, 'อุปกรณ์', st.devices, (d) => ({ mobile: 'มือถือ', tablet: 'แท็บเล็ต', desktop: 'คอมพิวเตอร์' })[d] ?? d),
      table('เบราว์เซอร์', null, 'เบราว์เซอร์', st.browsers),
    ]);
  };
  await load();
  if (token !== viewToken) return;
  timer = setInterval(() => document.visibilityState === 'visible' && load().catch(handleError), 60_000);
}

// ------------------------------------------------------------------ backup bundles
// A zip of the whole server (databases, volumes, settings, code commits), encrypted with a passphrase;
// its restore.sh puts everything back on this server or a new one (deploy/apps/backup).
const fmtDate = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

async function backupView(token) {
  const pass1 = h('input', { class: 'field', type: 'password', autocomplete: 'new-password', placeholder: 'รหัสผ่านของไฟล์ (อย่างน้อย 12 ตัว)', minlength: 12 });
  const pass2 = h('input', { class: 'field', type: 'password', autocomplete: 'new-password', placeholder: 'พิมพ์รหัสผ่านอีกครั้ง' });
  const status = h('p', { class: 'meta', role: 'status' }, ' ');
  const create = h('button', { class: 'btn primary', type: 'submit' }, 'สร้างไฟล์สำรอง');
  const form = h('form', { class: 'backup-form', onsubmit: async (e) => {
    e.preventDefault();
    if (pass1.value.length < 12) return toast('รหัสผ่านต้องยาวอย่างน้อย 12 ตัว');
    if (pass1.value !== pass2.value) return toast('รหัสผ่านสองช่องไม่ตรงกัน');
    create.disabled = true;
    try {
      await api('/backups', { method: 'POST', body: { passphrase: pass1.value } });
      pass1.value = pass2.value = '';
      toast('เริ่มสร้างไฟล์สำรองแล้ว');
      await load();
    } catch (err) {
      create.disabled = false;
      handleError(err);
    }
  } }, pass1, pass2, create, status);
  const list = h('div', { class: 'list no-enter' }, skeleton(2));
  const body = h('div', { class: 'stack' },
    card('สร้างไฟล์สำรองทั้งเซิร์ฟเวอร์', null,
      h('p', { class: 'backup-text' }, 'รวมฐานข้อมูล ข้อมูลใน Docker volume ทุกตัว ไฟล์ตั้งค่า และ commit ของโค้ด เป็น zip เดียว ข้อมูลข้างในเข้ารหัสด้วยรหัสผ่านนี้ — ลืมรหัสผ่าน = เปิดไฟล์ไม่ได้'),
      form),
    h('h2', { class: 'section-title' }, 'ไฟล์ที่มี (เก็บ 5 ไฟล์ล่าสุด)'), list,
    card('กู้คืน', 'บนเครื่องเดิมหรือ Ubuntu 24.04 เครื่องใหม่',
      h('pre', { class: 'logs backup-steps' }, 'unzip thai-weather-backup-*.zip -d restore\ncd restore\nsudo bash restore.sh --check   # ตรวจก่อน ไม่เปลี่ยนอะไร\nsudo bash restore.sh           # กู้คืนทั้งหมด')));
  shell(topBar('สำรองข้อมูล', { back: '#/more', onRefresh: () => load() }), body, tabs('#/more'));

  const load = async () => {
    const { bundles, job } = await api('/backups');
    if (token !== viewToken) return;
    const running = job && !job.done && !job.error;
    create.disabled = !!running;
    status.textContent = running ? `กำลังสร้าง ${job.name} — ${job.step}…` : job?.error ? `ครั้งล่าสุดไม่สำเร็จ: ${job.error}` : ' ';
    list.replaceChildren(...(bundles.length ? bundles.map((b) => h('div', { class: 'row' },
      h('div', { class: 'row-main' },
        h('span', { class: 'row-title' }, fmtDate.format(new Date(b.created))),
        h('span', { class: 'row-sub' }, `${fmtBytes(b.size)} · ${b.name}`)),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          try {
            const { url } = await api(`/backups/${encodeURIComponent(b.name)}/link`, { method: 'POST' });
            location.href = url;
          } catch (err) { handleError(err); }
        } }, 'ดาวน์โหลด'),
        confirmButton('ลบ', 'แตะอีกครั้งเพื่อลบ', async () => {
          await api(`/backups/${encodeURIComponent(b.name)}`, { method: 'DELETE' });
          await load();
        }, { danger: true }))))
      : [h('p', { class: 'empty' }, 'ยังไม่มีไฟล์สำรอง')]));
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
  shell(topBar('เพิ่มเติม'),
    h('div', { class: 'list' },
      item('#/chat', 'chat', 'แชท', 'สรุปรายเดือนจากระบบ และถาม–ตอบ', badge()),
      item('#/backup', 'archive', 'สำรองข้อมูล', 'ไฟล์สำรองทั้งเซิร์ฟเวอร์ และวิธีกู้คืน')),
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
    toast(isIos() && !standalone() ? 'iPhone: แชร์ → เพิ่มไปยังหน้าจอโฮม แล้วเปิด Dock จากไอคอนก่อน' : 'เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน');
    return false;
  }
  if ((await Notification.requestPermission()) !== 'granted') { toast('ไม่ได้รับอนุญาตให้แจ้งเตือน (เปิดได้ในการตั้งค่า)'); return false; }
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api('/chat/push/key');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
  await api('/chat/push/subscribe', { method: 'POST', body: sub.toJSON() });
  await api('/chat/push/test', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
  toast('เปิดการแจ้งเตือนแล้ว');
  return true;
}
async function disablePush() {
  const sub = await currentSub();
  if (sub) {
    await api('/chat/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }
  toast('ปิดการแจ้งเตือนแล้ว');
}
function pushButton() {
  const b = h('button', { class: 'icon-btn', type: 'button' });
  const paint = (on) => {
    b.replaceChildren(icon(on ? 'bell' : 'belloff'));
    b.setAttribute('aria-label', on ? 'ปิดการแจ้งเตือน' : 'เปิดการแจ้งเตือน');
    b.title = on ? 'แจ้งเตือนเปิดอยู่ (แตะเพื่อปิด)' : 'เปิดการแจ้งเตือน';
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
const fmtTime = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
async function chatView(token) {
  const log = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite' }, skeleton(3));
  const note = h('p', { class: 'chat-note' }, ' ');
  const input = h('textarea', { class: 'field chat-input', rows: 1, placeholder: 'พิมพ์ข้อความ…', maxlength: 4000, 'aria-label': 'ข้อความ' });
  const send = h('button', { class: 'icon-btn send', type: 'submit', 'aria-label': 'ส่ง', disabled: true }, icon('send'));
  let lastId = 0;
  let busy = false;
  const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80;
  const toBottom = () => window.scrollTo({ top: document.documentElement.scrollHeight });
  let firstId = 0;
  let hasMore = false;
  let loadingOlder = false;
  // a server post's type → its icon and colour (instead of emoji in the text)
  const KINDS = { down: ['alert', 'bad'], up: ['checkcircle', 'ok'], report: ['chart', 'info'] };
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
    if (d.cpu.filter((r) => r.avg !== null).length >= 2) {
      chartBox('CPU รายวัน', { times: dayTimes(d.cpu), step: 86400, kind: 'area', format: (v) => fmtPct(v),
        series: [{ name: 'เฉลี่ย', color: 'var(--s1)', values: d.cpu.map((r) => r.avg) }] });
    }
    if (d.visitors.length >= 2) {
      chartBox('ผู้เข้าชมรายวัน', { times: dayTimes(d.visitors), step: 86400, kind: 'columns', format: (v) => fmtNum(v),
        series: [{ name: 'ผู้เข้าชม', color: 'var(--s3)', values: d.visitors.map((r) => r.visitors) }] });
    }
    if (d.sites.length) {
      const top = Math.max(...d.sites.map((x) => x.requests), 1);
      body.append(h('div', { class: 'report-sites' }, h('span', { class: 'report-h' }, 'คำขอตามเว็บ'),
        d.sites.map((x) => h('div', { class: 'site-row' },
          h('span', { class: 'site-name' }, x.site),
          h('span', { class: 'site-bar' }, h('span', { style: `width:${((x.requests / top) * 100).toFixed(1)}%` })),
          h('span', { class: 'site-num' }, fmtNum(x.requests)),
          x.errorsPct >= 1 ? h('span', { class: 'pill tone-bad' }, `5xx ${x.errorsPct.toFixed(1)}%`) : null))));
    }
    body.append(h('div', { class: 'report-tips' }, h('span', { class: 'report-h' }, 'คำแนะนำ'),
      d.tips.map((t) => h('div', { class: `tip tip-${t.level}` }, icon(TIP[t.level][0], 'msg-ic'), h('span', {}, t.text)))));
    return body;
  };
  const bubble = (m) => {
    const kind = KINDS[m.kind];
    if (m.kind === 'report' && m.data) {
      return h('div', { class: `msg ${m.role} report-msg`, 'data-id': m.id },
        h('span', { class: 'msg-label' }, icon('chart', 'msg-ic'), m.role === 'system' ? 'รายงานประจำเดือน' : 'สรุป'),
        reportCard(m.data),
        h('span', { class: 'msg-time' }, fmtTime.format(new Date(m.ts))));
    }
    const [title, ...rest] = m.text.split('\n');
    return h('div', { class: `msg ${m.role}${kind ? ` kind-${kind[1]}` : ''}`, 'data-id': m.id },
      m.role === 'system' ? h('span', { class: 'msg-label' }, kind ? icon(kind[0], 'msg-ic') : null, m.kind === 'report' ? 'รายงานประจำเดือน' : m.kind ? 'แจ้งเตือนระบบ' : 'จากระบบ') : null,
      kind
        ? h('div', { class: 'msg-text' }, h('b', { class: 'msg-title' }, title), rest.length ? '\n' : null, ...linkify(rest.join('\n')))
        : h('div', { class: 'msg-text' }, ...linkify(m.text)),
      h('span', { class: 'msg-time' }, fmtTime.format(new Date(m.ts))));
  };
  const empty = () => h('div', { class: 'chat-empty' },
    h('span', { class: 'row-ic' }, icon('chat')),
    h('b', {}, 'ยังไม่มีข้อความ'),
    h('p', {}, 'สรุปรายเดือนและแจ้งเตือนเว็บล่มจะมาที่นี่ หรือแตะ สรุป / เดือนก่อน / ช่วย ด้านล่างเพื่อถาม'));
  const add = (msgs) => {
    const follow = atBottom();
    log.querySelector('.chat-empty')?.remove();
    for (const m of msgs) if (m.id > lastId) { log.append(bubble(m)); lastId = m.id; if (!firstId) firstId = m.id; }
    if (follow) toBottom();
  };
  // scrolling to the top brings the previous page; the view stays on the message you were reading
  const older = h('div', { class: 'chat-older', hidden: true }, h('span', { class: 'spinner' }), 'กำลังโหลดข้อความก่อนหน้า…');
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
    note.textContent = res.llm ? ' ' : 'ยังไม่ได้เชื่อม LLM — ตอบได้เฉพาะคำสั่ง (สรุป, เดือนก่อน, ช่วย)';
    if (res.messages.some((m) => !m.read)) { await api('/chat/read', { method: 'POST' }).catch(() => {}); refreshUnread(); }
  };
  const submit = async (text) => {
    text = text.trim();
    if (!text || busy) return;
    busy = true;
    send.disabled = true;
    const typing = h('div', { class: 'msg assistant typing' }, h('div', { class: 'msg-text' }, 'กำลังตอบ…'));
    log.querySelector('.chat-empty')?.remove();
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
    h('div', { class: 'chat-quick' }, ['สรุป', 'เดือนก่อน', 'ช่วย'].map((t) => h('button', { type: 'button', class: 'chip', onclick: () => submit(t) }, t))),
    h('div', { class: 'chat-row' }, input, send), note);
  const clearBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'ล้างแชท', title: 'ล้างแชท' }, icon('trash'));
  let clearArmed = 0;
  clearBtn.addEventListener('click', async () => {
    if (!clearArmed) {
      clearBtn.classList.add('armed');
      toast('แตะอีกครั้งเพื่อล้างแชททั้งหมด');
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
      toast('ล้างแชทแล้ว');
    } catch (err) { handleError(err); }
  });
  shell(topBar('แชท', { back: '#/more', onRefresh: () => load(), extra: [clearBtn, pushButton()] }), older, log, form, tabs('#/more'));
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
  if (e instanceof AuthError) return loginView('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  toast(`ผิดพลาด: ${e.message}`);
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
    else if (hash === '#/more') moreView();
    else if (hash === '#/chat') await chatView(token);
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
  const topColor = () => {
    let el = document.elementFromPoint(window.innerWidth / 2, 1);
    while (el) {
      const c = getComputedStyle(el).backgroundColor;
      if (opaque(c)) return c;
      el = el.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
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
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const bounce = (e) => {
    const tab = (e.target)?.closest?.('[data-tab-bounce]');
    const glyph = tab?.querySelector('svg');
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

// a new page starts at its top
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); route(); });
// push only (see sw.js); Dock keeps working without it
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
route();
