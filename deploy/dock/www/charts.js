// Small SVG time-series charts for Dock (no dependencies).
// Lines 2px, area wash ~10%, stacked fills separated by the surface, columns <= 24px with a 4px rounded
// top, hairline grid, one y-axis. Crosshair + tooltip listing every series (pointer and keyboard),
// legend for >= 2 series, a table view for every chart. All text is set with textContent.
import { LOCALE, tx } from './i18n.js';

const SVG = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, ns = SVG) => {
  const e = document.createElementNS(ns, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, v);
  return e;
};
const div = (cls, text) => {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
};

/** "var(--s1)" → the current theme's colour (SVG attributes cannot hold CSS variables) */
const resolve = (c) => (c.startsWith('var(') ? getComputedStyle(document.documentElement).getPropertyValue(c.slice(4, -1)).trim() || c : c);
const live = new Set(); // rendered charts, redrawn when the OS switches light / dark
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => live.forEach((r) => r()));
// … or when the theme is picked in Dock (i18n.js setTheme)
window.addEventListener('dock-theme', () => live.forEach((r) => r()));

/** 0, 25, 50 … – clean tick steps (1 / 2 / 2.5 / 5 × 10^k) */
export function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const top = Math.ceil(max / step) * step;
  const out = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(+v.toFixed(10));
  return out;
}

const timeFmt = (rangeS, daily = false) => {
  const opts = daily || rangeS > 2 * 86400
    ? { weekday: 'short', day: 'numeric' }
    : { hour: '2-digit', minute: '2-digit', hour12: false };
  const f = new Intl.DateTimeFormat(LOCALE, { ...opts, timeZone: 'Asia/Bangkok' });
  return (t) => f.format(new Date(t * 1000));
};
const fullTime = new Intl.DateTimeFormat(LOCALE, { timeZone: 'Asia/Bangkok', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/** Wall-clock ticks shared by every chart with the same time range and width. */
function timeTicks(start, end, width) {
  const count = Math.max(1, Math.min(6, Math.floor(width / 80)));
  const raw = (end - start) / count;
  const interval = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 259200, 604800]
    .reduce((best, s) => Math.abs(s - raw) < Math.abs(best - raw) ? s : best, Math.ceil(raw / 86400) * 86400);
  const offset = 7 * 3600; // Align days to midnight in Bangkok, including on devices in other zones.
  const out = [];
  for (let t = Math.ceil((start + offset) / interval) * interval - offset; t < end; t += interval) {
    const px = ((t - start) / (end - start)) * width;
    if (px >= 24 && px <= width - 24) out.push(t);
  }
  return out.length ? out : [(start + end) / 2];
}

/** Sum consecutive points so a columns chart never has more than `max` bars (counters only). */
function bin(times, series, max, step) {
  const n = times.length;
  const k = Math.max(1, Math.ceil(n / max));
  if (k === 1) return { times, series, ends: times.map((t) => t + step) };
  const t2 = [];
  const ends = [];
  for (let i = 0; i < n; i += k) {
    t2.push(times[i]);
    ends.push(times[Math.min(n, i + k) - 1] + step);
  }
  const s2 = series.map((s) => {
    const v = [];
    for (let i = 0; i < n; i += k) {
      let sum = null;
      for (let j = i; j < Math.min(n, i + k); j++) if (s.values[j] !== null && s.values[j] !== undefined) sum = (sum ?? 0) + s.values[j];
      v.push(sum);
    }
    return { ...s, values: v };
  });
  return { times: t2, series: s2, ends };
}

/**
 * chart(host, opts) → { update(opts) }
 * opts: { times: unix s[], series: [{ name, color, values: (number|null)[] }], kind: 'line'|'area'|'stack'|'columns',
 *         format: v => string, max?: number, ref?: { value, label }, height?: number, compact?: boolean, label: string,
 *         step?: seconds per bucket (time domain and tooltip) }
 */
export function chart(host, initial) {
  const wrap = div('chart');
  const plot = div('chart-plot');
  const tip = div('chart-tip');
  tip.hidden = true;
  const legend = div('chart-legend');
  const details = document.createElement('details');
  details.className = 'chart-table';
  const summary = document.createElement('summary');
  summary.textContent = tx('ดูเป็นตาราง');
  details.append(summary);
  plot.append(tip);
  wrap.append(plot);
  host.append(wrap);
  let opts = initial;
  let svg = null;
  let geo = null;
  let index = -1;

  function render() {
    const o = opts;
    const compact = !!o.compact;
    const W = Math.max(120, plot.clientWidth || host.clientWidth || 300);
    const H = o.height ?? (compact ? 72 : 180);
    const m = compact ? { l: 0, r: 0, t: 6, b: 2 } : { l: 46, r: 10, t: 10, b: 24 };
    let { times } = o;
    let series = o.series.map((ser) => ({ ...ser, color: resolve(ser.color) }));
    const step = o.step ?? (times.length > 1 ? times[1] - times[0] : 1);
    // Keep the original range even when a series starts late or columns are rebinned.
    const t0 = times[0] ?? 0;
    const t1 = (times[times.length - 1] ?? t0) + step;
    const calendar = o.kind === 'columns' && step >= 86400;
    let ends = [];
    if (o.kind === 'columns') ({ times, series, ends } = bin(times, series, Math.max(12, Math.floor((W - m.l - m.r) / 9)), step));
    const n = times.length;
    const stacked = o.kind === 'stack' || o.kind === 'columns';
    // stacked tops per index
    const tops = series.map(() => new Array(n).fill(null));
    const bases = series.map(() => new Array(n).fill(null));
    for (let i = 0; i < n; i++) {
      let acc = 0;
      series.forEach((s, si) => {
        const v = s.values[i];
        if (v === null || v === undefined) return;
        bases[si][i] = stacked ? acc : 0;
        acc = stacked ? acc + v : v;
        tops[si][i] = stacked ? acc : v;
      });
    }
    let maxV = 0;
    for (const col of tops) for (const v of col) if (v !== null && v > maxV) maxV = v;
    if (o.ref) maxV = Math.max(maxV, o.ref.value);
    const ticks = o.max !== undefined ? niceTicks(o.max, 4) : niceTicks(maxV * 1.08 || 1, compact ? 2 : 4);
    const yMax = ticks[ticks.length - 1];
    const pw = W - m.l - m.r;
    const ph = H - m.t - m.b;
    const x = (t) => m.l + ((t - t0) / (t1 - t0)) * pw;
    const slot = pw / Math.max(1, n);
    // Daily reports use labelled slots; metrics use the actual interval's centre on one time scale.
    const pointX = (i) => calendar ? m.l + slot * (i + 0.5)
      : x(o.kind === 'columns' ? (times[i] + ends[i]) / 2 : times[i] + step / 2);
    const y = (v) => m.t + ph - (v / yMax) * ph;
    geo = { times, series, ends, tops, pointX, m, W, H, n };

    const s = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': o.label });
    // grid + y labels
    for (const tv of ticks) {
      const yy = Math.round(y(tv)) + 0.5;
      s.append(el('line', { x1: m.l, x2: W - m.r, y1: yy, y2: yy, class: tv === 0 ? 'axis' : 'gridline' }));
      if (!compact) {
        const label = el('text', { x: m.l - 6, y: yy + 4, class: 'tick', 'text-anchor': 'end' });
        label.textContent = o.format(tv, true);
        s.append(label);
      }
    }
    // x labels
    if (!compact && n > 0) {
      const f = timeFmt(t1 - t0, calendar);
      const labels = [];
      if (calendar) {
        // Sample real buckets so the date, column, crosshair and tooltip agree.
        const count = Math.min(n, Math.max(1, Math.min(8, Math.floor(pw / 64))));
        for (let j = 0; j < count; j++) {
          const i = count === 1 ? 0 : Math.round(((n - 1) * j) / (count - 1));
          labels.push({ t: times[i], px: pointX(i) });
        }
      } else {
        for (const t of timeTicks(t0, t1, pw)) labels.push({ t, px: x(t) });
      }
      for (const { t, px } of labels) {
        const label = el('text', { x: px, y: H - 6, class: 'tick', 'text-anchor': 'middle' });
        label.textContent = f(t);
        s.append(label);
      }
    }
    if (o.ref) {
      const yy = Math.round(y(o.ref.value)) + 0.5;
      s.append(el('line', { x1: m.l, x2: W - m.r, y1: yy, y2: yy, class: 'ref' }));
      if (!compact) {
        const label = el('text', { x: W - m.r, y: yy - 5, class: 'tick ref-label', 'text-anchor': 'end' });
        label.textContent = o.ref.label;
        s.append(label);
      }
    }

    if (o.kind === 'columns') {
      for (let i = 0; i < n; i++) {
        const span = calendar ? slot : x(ends[i]) - x(times[i]);
        const bw = Math.max(2, Math.min(24, span - 2));
        const gap = span > 6 ? 2 : 1;
        const cx = pointX(i);
        let topIdx = -1;
        series.forEach((_, si) => { if (tops[si][i] !== null && tops[si][i] > bases[si][i]) topIdx = si; });
        series.forEach((ser, si) => {
          const top = tops[si][i];
          const base = bases[si][i];
          if (top === null || top <= base) return;
          const y0 = y(base) - (base > 0 ? gap : 0);
          const y1 = y(top);
          const h = Math.max(0, y0 - y1);
          if (h < 0.5) return;
          const r = si === topIdx ? Math.min(4, bw / 2, h) : 0;
          const xL = cx - bw / 2;
          const d = r
            ? `M${xL},${y0}V${y1 + r}Q${xL},${y1} ${xL + r},${y1}H${xL + bw - r}Q${xL + bw},${y1} ${xL + bw},${y1 + r}V${y0}Z`
            : `M${xL},${y0}V${y1}H${xL + bw}V${y0}Z`;
          s.append(el('path', { d, fill: ser.color }));
        });
      }
    } else {
      // areas first, then lines on top
      series.forEach((ser, si) => {
        if (o.kind === 'line') return;
        let d = '';
        let seg = [];
        const flush = () => {
          if (seg.length > 1) {
            d += `M${seg.map((i) => `${pointX(i)},${y(tops[si][i])}`).join('L')}`;
            d += `L${seg.slice().reverse().map((i) => `${pointX(i)},${y(bases[si][i])}`).join('L')}Z`;
          }
          seg = [];
        };
        for (let i = 0; i < n; i++) (tops[si][i] === null ? flush() : seg.push(i));
        flush();
        if (d) s.append(el('path', { d, fill: ser.color, class: stacked ? 'band' : 'wash' }));
      });
      series.forEach((ser, si) => {
        let d = '';
        let pen = false;
        for (let i = 0; i < n; i++) {
          const v = tops[si][i];
          if (v === null) { pen = false; continue; }
          d += `${pen ? 'L' : 'M'}${pointX(i).toFixed(1)},${y(v).toFixed(1)}`;
          pen = true;
        }
        if (d) s.append(el('path', { d, stroke: ser.color, class: 'line' }));
      });
    }
    // crosshair + markers layer
    const cross = el('g', { class: 'cross', visibility: 'hidden' });
    cross.append(el('line', { y1: m.t, y2: H - m.b, class: 'cross-line' }));
    series.forEach((ser) => cross.append(el('circle', { r: 4, fill: ser.color, class: 'cross-dot' })));
    s.append(cross);
    geo.cross = cross;
    geo.y = y;

    if (svg) svg.replaceWith(s);
    else plot.prepend(s);
    svg = s;

    // legend (>= 2 series)
    legend.replaceChildren();
    if (series.length > 1 && !compact) {
      for (const ser of series) {
        const item = div('legend-item');
        const key = document.createElement('span');
        key.className = o.kind === 'line' ? 'key key-line' : 'key key-box';
        key.style.background = ser.color;
        // counters (requests, bytes per bucket) show the range total, gauges the latest value
        const latest = o.legend === 'sum'
          ? o.series.find((x) => x.name === ser.name).values.reduce((a, b) => a + (b ?? 0), 0)
          : [...ser.values].reverse().find((v) => v !== null && v !== undefined);
        const name = document.createElement('span');
        name.textContent = ser.name;
        const val = document.createElement('b');
        val.textContent = latest === undefined ? '–' : o.format(latest);
        item.append(key, name, val);
        legend.append(item);
      }
      if (!legend.isConnected) wrap.append(legend);
    }
    // table view
    if (!compact) {
      const table = document.createElement('table');
      const head = document.createElement('tr');
      for (const h of [tx('เวลา'), ...series.map((s2) => s2.name)]) {
        const th = document.createElement('th');
        th.textContent = h;
        head.append(th);
      }
      table.append(head);
      const rows = Math.min(24, n);
      for (let r = 0; r < rows; r++) {
        const i = Math.round(((n - 1) * r) / Math.max(1, rows - 1));
        const tr = document.createElement('tr');
        const td0 = document.createElement('td');
        td0.textContent = fullTime.format(new Date(times[i] * 1000));
        tr.append(td0);
        for (const ser of series) {
          const td = document.createElement('td');
          const v = ser.values[i];
          td.textContent = v === null || v === undefined ? '–' : o.format(v);
          tr.append(td);
        }
        table.append(tr);
      }
      details.querySelector('table')?.remove();
      details.append(table);
      if (!details.isConnected) wrap.append(details);
    }
    if (index >= 0) show(Math.min(index, n - 1));
  }

  function show(i) {
    if (!geo || geo.n === 0) return;
    index = i;
    const { times, series, ends, tops, pointX, y, cross, W, m } = geo;
    const px = pointX(i);
    cross.setAttribute('visibility', 'visible');
    cross.querySelector('.cross-line').setAttribute('x1', px);
    cross.querySelector('.cross-line').setAttribute('x2', px);
    cross.querySelectorAll('.cross-dot').forEach((dot, si) => {
      const v = tops[si][i];
      dot.setAttribute('visibility', v === null || opts.kind === 'columns' ? 'hidden' : 'visible');
      if (v !== null) { dot.setAttribute('cx', px); dot.setAttribute('cy', y(v)); }
    });
    const step = opts.kind === 'columns' ? ends[i] - times[i] : (opts.step ?? 0);
    const head = div('tip-time', fullTime.format(new Date(times[i] * 1000)) + (step >= 120 ? tx(' · {0} นาที', Math.round(step / 60)) : ''));
    const rows = series.map((ser) => {
      const r = div('tip-row');
      const key = document.createElement('span');
      key.className = 'key key-line';
      key.style.background = ser.color;
      const v = document.createElement('b');
      const val = ser.values[i];
      v.textContent = val === null || val === undefined ? '–' : opts.format(val);
      const name = document.createElement('span');
      name.textContent = ser.name;
      r.append(key, v, name);
      return r;
    });
    tip.replaceChildren(head, ...rows);
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.max(0, Math.min(W - tw, px + (px > W / 2 ? -tw - 12 : 12)))}px`;
    tip.style.top = `${m.t}px`;
  }
  function hide() {
    index = -1;
    tip.hidden = true;
    geo?.cross.setAttribute('visibility', 'hidden');
  }
  const nearest = (clientX) => {
    const r = plot.getBoundingClientRect();
    const px = clientX - r.left;
    let best = 0;
    let bd = Infinity;
    geo.times.forEach((_, i) => {
      const d = Math.abs(geo.pointX(i) - px);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };
  plot.tabIndex = 0;
  plot.setAttribute('aria-label', tx('{0} – ใช้ปุ่มลูกศรเพื่อดูค่า', initial.label));
  plot.addEventListener('pointermove', (e) => geo && show(nearest(e.clientX)));
  plot.addEventListener('pointerdown', (e) => geo && show(nearest(e.clientX)));
  plot.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && hide());
  plot.addEventListener('blur', hide);
  plot.addEventListener('keydown', (e) => {
    if (!geo) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const base = index < 0 ? geo.n - 1 : index;
      show(Math.max(0, Math.min(geo.n - 1, base + (e.key === 'ArrowLeft' ? -1 : 1))));
    } else if (e.key === 'Escape') hide();
  });
  let lastW = 0;
  const ro = new ResizeObserver(() => {
    const w = Math.round(plot.clientWidth);
    if (w && w !== lastW) { lastW = w; render(); }
  });
  ro.observe(plot);
  live.add(render);
  render();
  return {
    update(next) {
      opts = { ...opts, ...next };
      render();
    },
    destroy() {
      ro.disconnect();
      live.delete(render);
    },
  };
}
