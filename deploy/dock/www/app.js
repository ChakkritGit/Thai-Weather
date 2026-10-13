// Dock – a minimal Docker dashboard on top of Portainer's API (same origin, /api/* is proxied).
// No dependencies. All text from the server goes in via textContent, never as HTML.

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

// ------------------------------------------------------------------ tiny DOM helper
function h(tag, attrs = {}, ...children) {
  const el = document.createElementNS(tag === 'svg' || tag === 'path' ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml', tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.setAttribute('class', v);
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
};
const icon = (name, cls = '') =>
  h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: cls }, h('path', { d: ICONS[name] }));

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
const nameOf = (c) => (c.Names?.[0] ?? c.Name ?? c.Id.slice(0, 12)).replace(/^\//, '');

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

/** CPU % (of all cores) and memory without page cache, from a one-shot stats sample */
function usage(s) {
  const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
  const cpus = s.cpu_stats?.online_cpus || s.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  const cpu = sysDelta > 0 && cpuDelta >= 0 ? (cpuDelta / sysDelta) * cpus * 100 : NaN;
  const ms = s.memory_stats ?? {};
  const cache = ms.stats?.inactive_file ?? ms.stats?.cache ?? 0;
  const mem = ms.usage !== undefined ? ms.usage - cache : NaN;
  let rx = 0, tx = 0;
  for (const n of Object.values(s.networks ?? {})) { rx += n.rx_bytes ?? 0; tx += n.tx_bytes ?? 0; }
  return { cpu, mem, limit: ms.limit, rx, tx };
}
const stats = (id) => docker(`/containers/${id}/stats?stream=false`).then(usage).catch(() => null);

// ------------------------------------------------------------------ layout
const TABS = [
  ['#/', 'box', 'คอนเทนเนอร์'],
  ['#/images', 'layers', 'อิมเมจ'],
  ['#/volumes', 'disk', 'วอลุ่ม'],
];
function tabs(current) {
  return h('nav', { class: 'tabs', 'aria-label': 'เมนู' },
    TABS.map(([href, ic, label]) => h('a', { href, 'aria-current': href === current ? 'page' : false }, icon(ic), label)));
}
function topBar(title, { back, onRefresh } = {}) {
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
  user.focus();
}

async function containersView(token) {
  const body = h('div', {}, skeleton());
  const meta = h('p', { class: 'meta' }, ' ');
  const load = async () => {
    const [list, info] = await Promise.all([docker('/containers/json?all=1'), docker('/info')]);
    if (token !== viewToken) return;
    const running = list.filter((c) => c.State === 'running');
    meta.replaceChildren(h('b', {}, `${running.length}/${list.length}`), ' ทำงาน · ', `${info.NCPU} CPU · ${fmtBytes(info.MemTotal)} · ${info.OperatingSystem}`);
    // group by compose project, standalone containers last
    const groups = new Map();
    for (const c of list.sort((a, b) => nameOf(a).localeCompare(nameOf(b)))) {
      const g = c.Labels?.['com.docker.compose.project'] ?? 'อื่น ๆ';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    }
    const sides = new Map();
    body.replaceChildren(...[...groups].map(([g, cs]) =>
      h('section', { class: 'group' },
        h('h2', { class: 'group-title' }, g),
        h('div', { class: 'list' }, cs.map((c) => {
          const st = stateOf(c);
          const side = h('span', { class: 'row-side' });
          sides.set(c.Id, side);
          return h('a', { class: 'row', href: `#/c/${c.Id}` },
            h('span', { class: `dot ${st.cls}`, title: st.label }),
            h('span', { class: 'row-main' },
              h('span', { class: 'row-title' }, nameOf(c)),
              h('span', { class: 'row-sub' }, `${st.label} · ${c.Status}`)),
            side,
            icon('chev', 'chev'));
        })))));
    if (!list.length) body.replaceChildren(h('div', { class: 'list' }, h('p', { class: 'empty' }, 'ยังไม่มีคอนเทนเนอร์')));
    // usage per running container (one-shot samples, in parallel)
    await Promise.all(running.map(async (c) => {
      const u = await stats(c.Id);
      if (token !== viewToken || !u) return;
      sides.get(c.Id)?.replaceChildren(h('b', {}, fmtPct(u.cpu)), fmtBytes(u.mem));
    }));
  };
  shell(topBar('คอนเทนเนอร์', { onRefresh: load }), meta, body, tabs('#/'));
  await load();
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
      ? confirmButton('หยุด', 'แตะอีกครั้งเพื่อหยุด', () => act('stop', `หยุด ${name} แล้ว`), { danger: true, disabled: guarded })
      : h('button', { class: 'btn primary', type: 'button', onclick: (e) => { e.currentTarget.disabled = true; act('start', `เริ่ม ${name} แล้ว`).catch(handleError); } }, 'เริ่ม'),
    running ? confirmButton('รีสตาร์ท', 'แตะอีกครั้งเพื่อรีสตาร์ท', () => act('restart', `รีสตาร์ท ${name} แล้ว`)) : null);

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
    if (!running) { statsEl.replaceChildren(statBox('สถานะ', 'หยุดอยู่', c.State.FinishedAt ? ago(Date.parse(c.State.FinishedAt) / 1000) : '')); return; }
    const u = await stats(id);
    if (token !== viewToken || !u) return;
    statsEl.replaceChildren(
      statBox('CPU', fmtPct(u.cpu)),
      statBox('หน่วยความจำ', fmtBytes(u.mem), u.limit ? `จาก ${fmtBytes(u.limit)}` : ''),
      statBox('เครือข่าย', `↓ ${fmtBytes(u.rx)}`, `↑ ${fmtBytes(u.tx)}`));
  };

  shell(
    topBar(name, { back: '#/', onRefresh: () => Promise.all([loadStats(), loadLogs()]) }),
    h('p', { class: 'meta' }, h('span', { class: 'pill' }, h('span', { class: `dot ${st.cls}` }), st.label)),
    actions,
    guarded && running ? h('p', { class: 'note' }, 'หยุดไม่ได้จากที่นี่ — ถ้าหยุดจะเข้าหน้านี้ไม่ได้ (รีสตาร์ทได้)') : null,
    statsEl,
    h('section', { class: 'group' },
      h('div', { class: 'logs-head' }, h('h2', { class: 'group-title' }, 'Log ล่าสุด'), h('label', { class: 'switch' }, follow, 'อัปเดตอัตโนมัติ')),
      logsEl),
    h('section', { class: 'group' }, h('h2', { class: 'group-title' }, 'ข้อมูล'), info),
    tabs('#/'));
  await Promise.all([loadStats(), loadLogs()]);
  let n = 0;
  timer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (follow.checked) loadLogs().catch(handleError);
    if (++n % 3 === 0) loadStats().catch(handleError);
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
  const token = ++viewToken;
  if (!localStorage.getItem(TOKEN_KEY)) return loginView();
  const hash = location.hash || '#/';
  try {
    await ensureEnv();
    const m = /^#\/c\/([0-9a-f]{12,64})$/.exec(hash);
    if (m) await containerView(token, m[1]);
    else if (hash === '#/images') await imagesView(token);
    else if (hash === '#/volumes') await volumesView(token);
    else await containersView(token);
  } catch (e) {
    if (token === viewToken) handleError(e);
  }
}

window.addEventListener('hashchange', route);
route();
