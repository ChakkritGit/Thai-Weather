// Dock's Cyber page (#/cyber): where attacks on the server come from, drawn on a world map.
// Data: dock-metrics' /api/security/attacks (view-only: it never becomes a security event, a chat message
// or a push). Outlines: world-map.json (Natural Earth, public domain; deploy/dock/build-map.mjs).
// Everything is built with DOM calls and textContent; colours and motion live in style.css (the page's CSP
// has no inline styles, so only the CSSOM is used for per-element values).
import { LOCALE, tx } from './i18n.js';

const SVG = 'http://www.w3.org/2000/svg';
const KINDS = ['ssh', 'scan', 'web'];
const RANGES = [[1, tx('24 ชม.')], [7, tx('7 วัน')], [30, tx('30 วัน')]];
/** arcs that also carry flowing dashes: every animated path repaints the map, so only the busiest few */
const FLOW_MAX = 24;
const LIST_SHORT = 12;
const PORT_NAMES = {
  21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS', 80: 'HTTP', 110: 'POP3', 123: 'NTP', 143: 'IMAP', 161: 'SNMP',
  389: 'LDAP', 443: 'HTTPS', 445: 'SMB', 465: 'SMTPS', 587: 'SMTP', 993: 'IMAPS', 1433: 'MSSQL', 1723: 'PPTP', 1900: 'SSDP',
  2375: 'Docker', 3306: 'MySQL', 3389: 'RDP', 5060: 'SIP', 5432: 'PostgreSQL', 5900: 'VNC', 6379: 'Redis', 8080: 'HTTP alt',
  8443: 'HTTPS alt', 9200: 'Elasticsearch', 27017: 'MongoDB',
};

let days = (() => {
  try { const v = Number(localStorage.getItem('dock.cyberDays')); return [1, 7, 30].includes(v) ? v : 1; } catch { return 1; }
})();

const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v);
  for (const c of kids) el.append(c);
  return el;
};

let mapPromise = null;
/** the outlines are fetched once per page load; a failed fetch is tried again on the next visit */
const loadMap = () => {
  mapPromise ??= fetch('world-map.json')
    .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
    .catch((e) => { mapPromise = null; throw e; });
  return mapPromise;
};

const dominant = (r) => KINDS.reduce((a, k) => (r[k] > r[a] ? k : a), 'scan');
const fmtDate = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' });
const fmtClock = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false });

/** "tcp/22" -> "TCP 22 · SSH" */
function portText(key) {
  const [proto, port] = key.split('/');
  const name = PORT_NAMES[port];
  return `${proto.toUpperCase()} ${port}${name ? ` · ${name}` : ''}`;
}

/** A quadratic arc from a source to the server, bowed upward (longer lines bow more) */
function arcPath([x0, y0], [x1, y1]) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const cx = (x0 + x1) / 2;
  const cy = Math.max(4, (y0 + y1) / 2 - dist * 0.28);
  return `M${x0.toFixed(1)} ${y0.toFixed(1)}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}

/** The SVG map: land once, then `draw(data)` replaces the arcs, dots and the server mark */
function createMap(m, label) {
  const root = svg('svg', { class: 'cy-map', viewBox: `0 0 ${m.w} ${m.h}`, role: 'img', 'aria-label': tx('แผนที่โลกแสดงที่มาของการโจมตี') });
  const land = svg('g');
  const lands = new Map();
  for (const [cc, d] of Object.entries(m.c)) {
    const p = svg('path', { class: 'cy-land', d, 'data-cc': cc });
    lands.set(cc, p);
    land.append(p);
  }
  if (m.o) land.append(svg('path', { class: 'cy-land', d: m.o }));
  const arcs = svg('g');
  const dots = svg('g');
  const marks = svg('g');
  root.append(land, arcs, dots, marks);

  const at = (lat, lon) => [((lon - m.lon[0]) / (m.lon[1] - m.lon[0])) * m.w, ((m.lat[0] - lat) / (m.lat[0] - m.lat[1])) * m.h];
  let places = new Map();
  let scale = 1;
  let selected = '';
  let last = null;
  let width = 0;

  function select(cc) {
    selected = cc;
    root.classList.toggle('has-sel', Boolean(cc));
    for (const el of root.querySelectorAll('[data-cc]')) {
      const on = Boolean(cc) && el.getAttribute('data-cc') === cc;
      el.classList.toggle('on', on);
      if (el.classList.contains('cy-arc')) el.setAttribute('stroke-width', (Number(el.getAttribute('data-w')) * (on ? 2 : 1)).toFixed(2));
    }
    for (const t of marks.querySelectorAll('.cy-sel-label')) t.remove();
    const p = places.get(cc);
    if (p) marks.append(svg('text', { class: 'cy-label cy-sel-label', x: p.x.toFixed(1), y: (p.y - 7 * scale).toFixed(1), 'text-anchor': 'middle', 'font-size': (10.5 * scale).toFixed(2) }, label(p.r)));
  }

  function draw(data) {
    last = data;
    width = root.getBoundingClientRect().width;
    // map units per CSS pixel: strokes and dots keep their on-screen size at any width
    scale = m.w / Math.max(240, width || m.w);
    const k = scale;
    const home = at(data.server.lat, data.server.lon);
    const rows = data.countries.filter((r) => r.lat !== null && r.lon !== null);
    const max = Math.max(1, ...data.countries.map((r) => r.total));
    const dash = 5 * k;
    const gap = 9 * k;
    root.style.setProperty('--cy-period', String(-(dash + gap)));
    arcs.replaceChildren();
    dots.replaceChildren();
    marks.replaceChildren();
    places = new Map();
    for (const p of lands.values()) { p.classList.remove('hit', 'k-ssh', 'k-scan', 'k-web'); p.style.removeProperty('--heat'); }
    // smallest first: the busiest sources end up on top
    const ordered = [...rows].sort((a, b) => a.total - b.total);
    ordered.forEach((r, i) => {
      const frac = Math.sqrt(r.total / max);
      const kind = dominant(r);
      const own = r.cc === data.server.cc;
      const [x, y] = own ? home : at(r.lat, r.lon);
      places.set(r.cc, { x, y, r });
      const tint = lands.get(r.cc);
      if (tint) {
        tint.classList.add('hit', `k-${kind}`);
        tint.style.setProperty('--heat', (0.3 + 0.7 * frac).toFixed(2));
      }
      if (!own) {
        const d = arcPath([x, y], home);
        const w = (0.7 + 2.3 * frac) * k;
        arcs.append(svg('path', { class: `cy-arc k-${kind}`, d, 'stroke-width': w.toFixed(2), 'data-w': w.toFixed(2), 'stroke-opacity': (0.3 + 0.55 * frac).toFixed(2), 'data-cc': r.cc }));
        if (i >= ordered.length - FLOW_MAX) {
          arcs.append(svg('path', { class: `cy-flow k-${kind}`, d, 'stroke-width': (1.5 * k).toFixed(2), 'stroke-dasharray': `${dash.toFixed(2)} ${gap.toFixed(2)}`, 'data-cc': r.cc }));
        }
      }
      const radius = (2.4 + 4.4 * frac) * k;
      dots.append(svg('circle', { class: `cy-dot k-${kind}${own ? ' own' : ''}`, cx: x.toFixed(1), cy: y.toFixed(1), r: (own ? radius + 5 * k : radius).toFixed(2), 'stroke-width': k.toFixed(2), 'data-cc': r.cc }, svg('title', {}, label(r))));
    });
    const [hx, hy] = home.map((v) => v.toFixed(1));
    marks.append(
      svg('circle', { class: 'cy-pulse', cx: hx, cy: hy, r: (6 * k).toFixed(2), 'stroke-width': (1.4 * k).toFixed(2) }),
      svg('circle', { class: 'cy-pulse two', cx: hx, cy: hy, r: (6 * k).toFixed(2), 'stroke-width': (1.4 * k).toFixed(2) }),
      svg('circle', { class: 'cy-home', cx: hx, cy: hy, r: (3.6 * k).toFixed(2), 'stroke-width': (1.5 * k).toFixed(2) }),
      svg('text', { class: 'cy-label', x: (home[0] - 8 * k).toFixed(1), y: (home[1] + 3.6 * k).toFixed(1), 'text-anchor': 'end', 'font-size': (10.5 * k).toFixed(2), 'stroke-width': (3 * k).toFixed(2) }, tx('กรุงเทพฯ')),
    );
    select(places.has(selected) ? selected : '');
  }

  // a phone rotated, a window resized: strokes and dots are in map units, so they are drawn again
  new ResizeObserver(() => {
    if (!root.isConnected || !last) return;
    if (Math.abs(root.getBoundingClientRect().width - width) > 4) draw(last);
  }).observe(root);
  root.addEventListener('click', (e) => {
    const t = e.target.closest?.('[data-cc]');
    // only a country that attacked can be picked; the rest of the land is just map
    if (t && places.has(t.getAttribute('data-cc'))) root.dispatchEvent(new CustomEvent('cy-pick', { detail: t.getAttribute('data-cc') }));
  });
  return { root, draw, select };
}

export async function cyberView(token, d) {
  const { h, api, shell, topBar, tabs, handleError, card, tile, fmtNum, countryName, isCurrent, every, reload } = d;
  const name = (r) => countryName(r.cc) === r.cc ? r.name : countryName(r.cc);
  const label = (r) => `${name(r)}: ${fmtNum(r.total)}`;
  const kindLabel = { ssh: tx('SSH'), scan: tx('สแกนพอร์ต'), web: tx('บอทเว็บ') };
  const chips = (r) => KINDS.filter((k) => r[k] > 0).map((k) => h('span', { class: `cy-chip k-${k}` }, h('i', {}), `${kindLabel[k]} ${fmtNum(r[k])}`));

  const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': tx('ช่วงเวลา') },
    RANGES.map(([n, text]) => h('button', {
      type: 'button', 'aria-pressed': n === days ? 'true' : 'false',
      onclick: () => { days = n; try { localStorage.setItem('dock.cyberDays', String(n)); } catch { /* ignore */ } reload(); },
    }, text)));
  const meta = h('p', { class: 'meta cy-meta' });
  const tiles = h('div', { class: 'tiles' }, d.skelTiles(4));
  const mapHost = h('div', { class: 'cy-stage' });
  const legend = h('div', { class: 'cy-legend' },
    KINDS.map((k) => h('span', { class: `cy-chip k-${k}` }, h('i', {}), { ssh: tx('ล็อกอิน SSH ไม่สำเร็จ'), scan: tx('สแกนพอร์ต (ไฟร์วอลล์)'), web: tx('บอทสแกนเว็บ') }[k])),
    h('span', { class: 'cy-hint' }, tx('ขนาดจุดและความหนาเส้น = จำนวนครั้ง · แตะประเทศเพื่อเลือก')));
  const credit = h('p', { class: 'cy-credit' },
    'IP geolocation by ', h('a', { href: 'https://db-ip.com', target: '_blank', rel: 'noopener' }, 'DB-IP'), ' (CC BY 4.0)',
    ' · Natural Earth');
  const mapCard = h('section', { class: 'card cy-card' }, mapHost, legend, credit);
  const countryBox = h('div', { class: 'list flat' });
  const portBox = h('div', { class: 'list flat' });
  const ipBox = h('div', { class: 'list flat' });
  const note = h('p', { class: 'meta sec-note' });
  // the range picker stays where it is built: the glass control that replaces it sits beside it
  const slot = h('div', { class: 'cy-slot' }, d.skelCard(200, '30%'));
  const body = h('div', { class: 'overview cy' }, h('div', { class: 'filters' }, seg), meta, tiles, slot);
  shell(topBar(tx('แผนที่การโจมตี'), { back: '#/security', onRefresh: () => load() }), body, tabs('#/'));
  document.querySelector('.shell')?.classList.add('wide');

  let ctl = null;
  let built = false;
  let selected = '';
  let showAll = false;
  let data = null;

  const pick = (cc) => {
    selected = selected === cc ? '' : cc;
    ctl?.select(selected);
    for (const row of countryBox.querySelectorAll('[data-cc]')) row.setAttribute('aria-pressed', String(row.getAttribute('data-cc') === selected));
    if (selected) mapCard.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };

  function countryRows() {
    const rows = showAll ? data.countries : data.countries.slice(0, LIST_SHORT);
    const max = Math.max(1, data.countries[0]?.total ?? 1);
    const list = rows.map((r, i) => h('button', {
      type: 'button', class: `row cy-row k-${dominant(r)}`, 'data-cc': r.cc, 'aria-pressed': String(r.cc === selected), onclick: () => pick(r.cc),
    },
    h('span', { class: 'cy-rank' }, String(i + 1)),
    h('div', { class: 'row-main' },
      h('span', { class: 'row-title' }, name(r)),
      h('span', { class: 'cy-kinds' }, chips(r)),
      h('span', { class: 'meter cy-bar', 'aria-hidden': 'true' }, h('span', { class: 'meter-fill', style: `width:${Math.max(2, (r.total / max) * 100).toFixed(1)}%` }))),
    h('div', { class: 'row-side' }, h('b', {}, fmtNum(r.total)))));
    if (data.countries.length > LIST_SHORT) {
      list.push(h('button', { type: 'button', class: 'row cy-more', onclick: () => { showAll = !showAll; countryBox.replaceChildren(...countryRows()); } },
        h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, showAll ? tx('แสดงน้อยลง') : tx('แสดงทั้งหมด {0} ประเทศ', data.countries.length)))));
    }
    return list.length ? list : [h('p', { class: 'empty' }, tx('ยังไม่พบการโจมตีในช่วงนี้'))];
  }

  function fill(s) {
    data = s;
    const t = s.totals;
    tiles.replaceChildren(
      tile(tx('ทั้งหมด'), fmtNum(t.total), tx('จาก {0} ประเทศ', fmtNum(s.countries.length))),
      tile(tx('ล็อกอิน SSH ไม่สำเร็จ'), fmtNum(t.ssh), tx('เดารหัสผ่านเข้าเครื่อง')),
      tile(tx('สแกนพอร์ต'), fmtNum(t.scan), tx('ไฟร์วอลล์บล็อกไว้')),
      tile(tx('บอทสแกนเว็บ'), fmtNum(t.web), tx('หาไฟล์ลับและช่องโหว่ของเว็บ')));
    const since = new Date(s.since * 1000);
    const first = s.firstDay && s.firstDay > s.since ? tx(' · มีข้อมูลตั้งแต่ {0}', fmtDate.format(new Date(s.firstDay * 1000))) : '';
    meta.textContent = `${s.days === 1 ? tx('24 ชั่วโมงล่าสุด') : tx('{0} วันล่าสุด (ตั้งแต่ {1})', s.days, fmtDate.format(since))}${first} · ${tx('อัปเดต {0}', fmtClock.format(new Date(s.now * 1000)))}`;
    ctl?.draw(s);
    countryBox.replaceChildren(...countryRows());
    portBox.replaceChildren(...(s.topPorts.length
      ? s.topPorts.map((p) => h('div', { class: 'row' },
        h('div', { class: 'row-main' }, h('span', { class: 'row-title' }, portText(p.port)),
          h('span', { class: 'meter cy-bar k-scan', 'aria-hidden': 'true' }, h('span', { class: 'meter-fill', style: `width:${Math.max(2, (p.count / s.topPorts[0].count) * 100).toFixed(1)}%` }))),
        h('div', { class: 'row-side' }, h('b', {}, fmtNum(p.count)))))
      : [h('p', { class: 'empty' }, tx('ไม่มี'))]));
    ipBox.replaceChildren(...(s.topIps.length
      ? s.topIps.map((x) => h('div', { class: 'row wrap' },
        h('div', { class: 'row-main' }, h('span', { class: 'row-title mono' }, x.ip),
          h('span', { class: 'cy-kinds' }, h('span', { class: 'cy-cc' }, countryName(x.cc) === x.cc ? x.cc : countryName(x.cc)), chips(x))),
        h('div', { class: 'row-side' }, h('b', {}, fmtNum(x.total)))))
      : [h('p', { class: 'empty' }, tx('ไม่มี'))]));
    const u = s.unlocated;
    note.textContent = [
      u.webCloudflare ? tx('ไม่รวมบอทเว็บที่เข้าผ่าน Cloudflare {0} ครั้ง (ไม่เห็น IP จริง)', fmtNum(u.webCloudflare)) : '',
      u.unknown ? tx('ไม่รวม {0} ครั้งจาก IP ที่ไม่รู้ประเทศ', fmtNum(u.unknown)) : '',
      tx('ตำแหน่งเป็นระดับประเทศ (จุดกลางประเทศ) ไม่ใช่ที่อยู่จริงของผู้โจมตี ฐานข้อมูล IP เดือน {0}', s.geo.month || '–'),
      tx('หน้านี้ดูอย่างเดียว: ไม่สร้างเหตุการณ์ ไม่ส่งเข้าแชท และไม่ส่งแจ้งเตือน'),
    ].filter(Boolean).join(' ');
  }

  function build(m) {
    if (m) {
      ctl = createMap(m, label);
      ctl.root.addEventListener('cy-pick', (e) => pick(e.detail));
      mapHost.replaceChildren(ctl.root);
    } else {
      mapHost.replaceChildren(h('p', { class: 'empty' }, tx('โหลดแผนที่ไม่สำเร็จ')));
    }
    slot.replaceChildren(
      mapCard,
      h('div', { class: 'grid cy-grid' },
        card(tx('ประเทศต้นทาง'), tx('แตะเพื่อดูเส้นบนแผนที่'), countryBox),
        h('div', { class: 'cy-col' },
          card(tx('พอร์ตที่ถูกสแกนบ่อย'), tx('ไฟร์วอลล์บล็อกไว้'), portBox),
          card(tx('IP ที่โจมตีบ่อยสุด'), tx('ตัวอย่างบางส่วน ไม่ใช่ทุก IP'), ipBox))),
      note);
    built = true;
  }

  async function load() {
    const [s, m] = await Promise.all([api(`/security/attacks?days=${days}`), loadMap().catch(() => null)]);
    if (!isCurrent(token)) return;
    if (!s.enabled) {
      body.replaceChildren(h('p', { class: 'empty' }, tx('ยังไม่ได้เปิดแผนที่การโจมตี (ไม่มีฐานข้อมูล IP)')));
      return;
    }
    if (!built) build(m);
    fill(s);
  }

  try {
    await load();
  } catch (e) {
    handleError(e);
    return;
  }
  every(() => load().catch(handleError), 60_000);
}
