import type { CustomLayerInterface, Map as MLMap } from 'maplibre-gl';

/**
 * Liquid Glass for the glass elements that float over the map (round buttons, layer chips, search field, legend,
 * timeline, radar bar, bottom nav), drawn with WebGL from the map's own pixels. Safari cannot filter a backdrop with SVG
 * (Glisse falls back to blur there), so the bend is done here, the same on every browser.
 *
 * How it works: the glass is a custom layer on top of the map, drawn in MapLibre's own WebGL context. Each frame it
 * copies the crops under the glass elements from the frame buffer into small textures (a GPU-side copy, nothing is read
 * back or moved between contexts) and draws one rounded rectangle per element that bends its texture at the rim. Only
 * the map's own render triggers it, so nothing runs while the map is idle; hover, pressed and theme colours stay plain
 * CSS on the elements (the tint is their background, over the map canvas).
 *
 * The elements are the parents of every `<GlassPane/>` (components/GlassPane.tsx registers them) plus the bottom nav.
 * Their boxes are read again only when something says they moved: a resize, a scroll of a container that holds one, a
 * running transition, a change of the page's sheet state, an element added or removed. The map then draws one frame.
 *
 * Why not an overlay canvas fed by drawImage/texImage2D: it is the same look, but moving pixels from the map's context
 * to another one stalls Safari for ~6 ms a frame whatever the crop size (measured), and Chromium for a readback.
 *
 * Not in the glass: DOM drawn over the map canvas (city labels, station dots) is not bent; the hosts blur it in CSS.
 */

/** The glass look. Lengths are CSS px. */
export interface Look {
  /**
   * Rim refraction, as Glisse's `--lg-refraction`: 1 is the full physical bend (Snell, n = 1.5, the content at the rim
   * is pulled in by up to ~9 px on a 40 px button), 0 is flat glass. Typical range 0..1. A host can override it with
   * the CSS custom property `--wgl-bend`.
   */
  bend: number;
  /**
   * Chromatic dispersion: red is displaced (1 + 0.12 * dispersion) and blue (1 - 0.12 * dispersion) times as far as
   * green, so a bent edge gets a colour fringe. 0 is none, ~2 is strong.
   */
  dispersion: number;
  /** Blur radius of the glass face, in CSS px (a mip level plus four diagonal taps). */
  blur: number;
  /** Colour saturation of the glass face; 1 leaves the map's colours as they are. */
  saturation: number;
  /** Strength of the rim light (Glisse's glint, lit from the top left); 0 turns it off. */
  rim: number;
}

export const DEFAULT_LOOK: Look = { bend: 0.75, dispersion: 1.05, blur: 4, saturation: 1.4, rim: 1 };

/** Colour-fringe width per unit of `Look.dispersion`, as a fraction of the displacement. */
const DISPERSION_UNIT = 0.12;
/** A copied crop reaches this far past its elements: room for the blur taps at a frosted rim (--wgl-blur 12). */
const PAD = 16;
const LAYER_ID = 'thwx-glass';
/** How long the layout is re-read every frame after a transition starts or ends (the longest one is 0.15 s). */
const SETTLE_MS = 400;
/** Transitions that move or fade an element; a colour change does not need the glass. */
const MOVING = new Set(['opacity', 'transform', 'translate', 'scale', 'top', 'left', 'right', 'bottom', 'width', 'height', 'inset', 'margin', 'padding']);

/**
 * Test hook, off unless a page sets `window.__mapGlassDebug`: `look` overrides the look, `probe` receives one
 * `[total, layout, copy, draw]` (ms of main-thread time) entry per drawn frame, `stats` is filled with the last layout's
 * counts, `off` skips the glass (to compare with the fallback).
 */
interface Debug {
  look?: Partial<Look>;
  probe?: number[][];
  stats?: { hosts: number; clusters: number; pixels: number };
  off?: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A crop of a canvas, in its device pixels. */
export interface Crop {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Round `want` (CSS px, relative to the canvas's top left) out to whole device pixels of a canvas that is
 * `cw` x `ch` pixels and `k` pixels per CSS px, clamped to the canvas. Null when nothing of it is on the canvas.
 */
export function cropRect(want: Rect, k: number, cw: number, ch: number): Crop | null {
  const sx = Math.max(0, Math.floor(want.x * k));
  const sy = Math.max(0, Math.floor(want.y * k));
  const ex = Math.min(cw, Math.ceil((want.x + want.w) * k));
  const ey = Math.min(ch, Math.ceil((want.y + want.h) * k));
  return ex > sx && ey > sy ? { sx, sy, sw: ex - sx, sh: ey - sy } : null;
}

/** Smallest rect holding all of `rects`, grown by `pad` on every side. */
export function unionRect(rects: Rect[], pad: number): Rect {
  const x0 = Math.min(...rects.map((r) => r.x)) - pad;
  const y0 = Math.min(...rects.map((r) => r.y)) - pad;
  const x1 = Math.max(...rects.map((r) => r.x + r.w)) + pad;
  const y1 = Math.max(...rects.map((r) => r.y + r.h)) + pad;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The part both rects share, or null when they do not overlap. */
export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/**
 * Group rects that overlap, directly or through others: one crop per group instead of one per element, and no crop
 * for the empty space between the chip row and the bottom panes. Returns the indices of each group.
 */
export function clusterRects(rects: Rect[]): number[][] {
  const parent = rects.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (intersectRect(rects[i], rects[j])) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, number[]>();
  rects.forEach((_, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), i]);
  });
  return [...groups.values()];
}

// ---------------------------------------------------------------------------------------------- the glass elements

const hosts = new Set<HTMLElement>();
/** hosts that move without any event to tell (the tab bar's lens follows a finger): read every frame while here */
const live = new Set<HTMLElement>();
const watchers = new Set<() => void>();

/**
 * Register an element as map glass: the page's glass panes call this for their parent. Returns the function that
 * takes it out again. Registering costs nothing while no map glass runs. A `live` host is measured every frame, so
 * register one only while it moves.
 */
export function trackGlassHost(el: HTMLElement, opts: { live?: boolean } = {}): () => void {
  hosts.add(el);
  if (opts.live) live.add(el);
  watchers.forEach((w) => w());
  return () => {
    hosts.delete(el);
    live.delete(el);
    watchers.forEach((w) => w());
  };
}

// ------------------------------------------------------------------------------------------------------- the shaders

const VERT = `#version 300 es
uniform vec2 uSize;
uniform vec4 uRect;
out vec2 vPos;
void main() {
  // a strip of two triangles from gl_VertexID, one px wider than the element for its antialiased edge
  vec2 u = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vPos = uRect.xy - 1.0 + u * (uRect.zw + 2.0);
  gl_Position = vec4(vPos.x / uSize.x * 2.0 - 1.0, 1.0 - vPos.y / uSize.y * 2.0, 0.0, 1.0);
}`;

/**
 * Same optics as Glisse (node_modules/glisse, maps()): a squircle bevel whose slope refracts at n = 1.5, displacement
 * strongest at the rim and zero on the flat face, plus its glint. Positions are CSS px from the map canvas's top
 * left; the texture holds the crop `uBox` (same units, its row 0 is the bottom, as a frame buffer copy leaves it).
 * `uClip` (x0, y0, x1, y1) is where the element is visible: a scroll container or the canvas edge cuts it. With `uRim`
 * only the bevel is drawn and it fades into the map under it: a text pane blurs its face in CSS, so the face is not
 * worth the fill rate (a pane covers far more pixels than the bevel).
 */
const FRAG = `#version 300 es
precision highp float;
uniform vec2 uSize;
uniform vec4 uRect, uBox, uClip;
uniform float uRadius, uBezel, uThick, uAlpha, uRimOnly;
uniform float uBend, uDisp, uBlur, uLod, uSat, uRim, uPx;
uniform sampler2D uTex;
in vec2 vPos;
out vec4 o;

vec3 tap(vec2 p) {
  vec2 uv = (p - uBox.xy) / uBox.zw;
  return textureLod(uTex, vec2(uv.x, 1.0 - uv.y), uLod).rgb;
}
// a soft face: the mip level does most of the blur, a ring of eight taps hides its blocks
vec3 soft(vec2 p) {
  float k = uBlur * 0.5;
  float j = uBlur * 0.7;
  vec3 c = 2.0 * tap(p) + tap(p + vec2(k, k)) + tap(p + vec2(-k, k)) + tap(p + vec2(k, -k)) + tap(p + vec2(-k, -k));
  c += tap(p + vec2(j, 0.0)) + tap(p + vec2(-j, 0.0)) + tap(p + vec2(0.0, j)) + tap(p + vec2(0.0, -j));
  return c / 10.0;
}

void main() {
  if (vPos.x < uClip.x || vPos.y < uClip.y || vPos.x > uClip.z || vPos.y > uClip.w) discard;
  vec2 half_ = uRect.zw * 0.5;
  vec2 pc = vPos - (uRect.xy + half_);
  vec2 q = abs(pc) - (half_ - uRadius);
  vec2 oq = max(q, 0.0);
  float len = length(oq);
  float d = uRadius - (len + min(max(q.x, q.y), 0.0));
  float cover = clamp(d * uPx + 0.5, 0.0, 1.0);
  float fade = uRimOnly > 0.5 ? 1.0 - smoothstep(uBezel * 0.5, uBezel + 1.0, d) : 1.0;
  if (cover <= 0.0 || fade <= 0.0) discard;

  // outward normal of the rounded rectangle
  vec2 n = len > 0.0 ? oq / len * sign(pc) : (q.x > q.y ? vec2(sign(pc.x), 0.0) : vec2(0.0, sign(pc.y)));

  // refraction at the bevel: how far the sample is pulled in from the rim
  float t = clamp(d / uBezel, 0.001, 1.0);
  float surf = pow(1.0 - pow(1.0 - t, 4.0), 0.25);
  float inc = atan(pow(1.0 - t, 3.0), surf * surf * surf);
  float shift = tan(inc - asin(sin(inc) / 1.5)) * (uThick + surf * uBezel) * uBend;

  vec3 col;
  if (shift < 0.01) {
    col = soft(vPos);
  } else {
    vec2 off = -n * shift;
    col = vec3(soft(vPos + off * (1.0 + DISP_UNIT * uDisp)).r, soft(vPos + off).g, soft(vPos + off * (1.0 - DISP_UNIT * uDisp)).b);
  }
  col = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, uSat);

  // rim light, lit from the top left
  float light = -(n.x + n.y) * 0.70710678;
  float glint = pow(max(light, 0.0), 3.0);
  float refl = pow(max(-light, 0.0), 3.0);
  float rim = exp(-pow((d - 0.4) / 0.38, 2.0));
  float bloom = exp(-pow(d / (uBezel * 0.22), 2.0));
  float a = clamp(rim * (0.045 + 0.52 * glint + 0.2 * refl) + bloom * 0.02 * glint, 0.0, 1.0) * uRim;
  col = mix(col, vec3(1.0), a);

  // premultiplied: the layer is blended with MapLibre's (ONE, ONE_MINUS_SRC_ALPHA)
  float c = cover * uAlpha * fade;
  o = vec4(col * c, c);
}`.replace(/DISP_UNIT/g, DISPERSION_UNIT.toFixed(3));

/** One glass element: its rounded rectangle in CSS px from the canvas's top left, where it shows, and its bevel. */
interface Host extends Rect {
  radius: number;
  /** the bevel Glisse sizes for an element of this size */
  bezel: number;
  thick: number;
  bend: number;
  /** blur of its face in CSS px: frosted rims on text panes, a near-clear lens on the tab bar */
  blur: number;
  alpha: number;
  clip: Rect;
  /** only the bent rim is drawn; the face is left to the map under the host's own CSS blur (a text pane) */
  rim: boolean;
}

/** The elements that share one crop of the frame, with the crop and the CSS box it covers. */
interface Cluster {
  crop: Crop;
  box: Rect;
  hosts: Host[];
}

interface Layout {
  clusters: Cluster[];
  /** device pixels per CSS px, and the canvas's CSS size and pixel size */
  k: number;
  cssW: number;
  cssH: number;
  cw: number;
  ch: number;
}

export interface MapGlassOptions {
  /** the map under the glass */
  map: MLMap;
  /** true once the first frame is drawn (the page then drops its fallback), false when the glass cannot draw */
  onActive: (active: boolean) => void;
}

export interface MapGlass {
  destroy(): void;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
  return s;
}

/** Radius of the border box as the browser draws it (999px pills, 50% circles), never beyond a half side. */
function cornerRadius(cs: CSSStyleDeclaration, w: number, h: number): number {
  const c = cs.borderTopLeftRadius;
  const v = parseFloat(c);
  return Math.min(w / 2, h / 2, Number.isFinite(v) ? (c.endsWith('%') ? (Math.min(w, h) * v) / 100 : v) : 0);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const asRect = (r: DOMRect): Rect => ({ x: r.left, y: r.top, w: r.width, h: r.height });

/** What sits above an element: the product of the opacities, and the box the scroll containers leave visible. */
interface Above {
  opacity: number;
  clip: Rect | null;
}
const NOTHING: Above = { opacity: 1, clip: null };

/** Start the glass over `opts.map`; it reports through `onActive`. Null when switched off by the test hook. */
export function createMapGlass(opts: MapGlassOptions): MapGlass | null {
  const { map, onActive } = opts;
  const debug = (globalThis as { __mapGlassDebug?: Debug }).__mapGlassDebug;
  if (debug?.off) return null;
  const look: Look = { ...DEFAULT_LOOK, ...debug?.look };
  const probe = debug?.probe;

  let gl: WebGL2RenderingContext | null = null;
  let program: WebGLProgram | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  let uni: Record<string, WebGLUniformLocation | null> = {};
  /** one texture per cluster, grown as needed: the crop's pixel size and whether the texture has that size */
  let pool: { tex: WebGLTexture; w: number; h: number }[] = [];
  let layout: Layout | null = null;
  let dirty = true;
  let added = false;
  let active = false;
  let dead = false;
  let settleUntil = 0;
  let raf = 0;

  const setActive = (on: boolean) => {
    if (active === on) return;
    active = on;
    onActive(on);
  };

  /** Read every glass element's box, and what hides part of it, against the map canvas. Null when nothing shows. */
  const measure = (): Layout | null => {
    const canvas = map.getCanvas();
    const cr = canvas.getBoundingClientRect();
    if (!cr.width || !canvas.width) return null;
    const k = canvas.width / cr.width;
    const screen = asRect(cr);
    // each container is read once for all the elements inside it
    const above = new Map<Element, Above>();
    const over = (el: Element | null): Above => {
      if (!el || el === document.documentElement) return NOTHING;
      const known = above.get(el);
      if (known) return known;
      const up = over(el.parentElement);
      const cs = getComputedStyle(el);
      let clip = up.clip;
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const own = asRect(el.getBoundingClientRect());
        clip = clip ? intersectRect(clip, own) ?? { x: 0, y: 0, w: 0, h: 0 } : own;
      }
      const a = { opacity: up.opacity * (parseFloat(cs.opacity) || 0), clip };
      above.set(el, a);
      return a;
    };

    const found: Host[] = [];
    for (const el of hosts) {
      if (!el.isConnected) continue;
      const r = asRect(el.getBoundingClientRect());
      if (r.w < 1 || r.h < 1) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden') continue;
      const up = over(el.parentElement);
      const alpha = up.opacity * (parseFloat(cs.opacity) || 0);
      if (alpha < 0.004) continue;
      const onScreen = intersectRect(r, screen);
      const shown = onScreen && (up.clip ? intersectRect(onScreen, up.clip) : onScreen);
      if (!shown) continue;
      // --wgl-bend 0 is flat glass: the host's own CSS tint and blur are all it needs, no pass for it
      const bend = parseFloat(cs.getPropertyValue('--wgl-bend'));
      if (bend === 0) continue;
      const m = Math.min(r.w, r.h);
      const blur = parseFloat(cs.getPropertyValue('--wgl-blur'));
      found.push({
        x: r.x - cr.left,
        y: r.y - cr.top,
        w: r.w,
        h: r.h,
        radius: cornerRadius(cs, r.w, r.h),
        bezel: clamp(m * 0.12, 4, 10),
        thick: clamp(m * 0.2, 8, 24),
        bend: Number.isFinite(bend) ? bend : look.bend,
        blur: Number.isFinite(blur) ? blur : look.blur,
        alpha: Math.min(1, alpha),
        clip: { x: shown.x - cr.left, y: shown.y - cr.top, w: shown.w, h: shown.h },
        rim: parseFloat(cs.getPropertyValue('--wgl-face')) === 0,
      });
      // a button, chip or pane that changes size must be noticed too
      ro.observe(el);
    }
    if (!found.length) return null;

    const clusters: Cluster[] = [];
    let pixels = 0;
    // grown by one more px than the crop, so elements that stand a gap of two pads apart share a crop
    for (const group of clusterRects(found.map((h) => unionRect([h.clip], PAD + 1)))) {
      const members = group.map((i) => found[i]);
      const crop = cropRect(unionRect(members.map((h) => h.clip), PAD), k, canvas.width, canvas.height);
      if (!crop) continue;
      const { sx, sy, sw, sh } = crop;
      pixels += sw * sh;
      clusters.push({ crop, box: { x: sx / k, y: sy / k, w: sw / k, h: sh / k }, hosts: members });
    }
    if (debug) debug.stats = { hosts: found.length, clusters: clusters.length, pixels };
    return { clusters, k, cssW: cr.width, cssH: cr.height, cw: canvas.width, ch: canvas.height };
  };

  const build = (g: WebGL2RenderingContext) => {
    const vs = compile(g, g.VERTEX_SHADER, VERT);
    const fs = compile(g, g.FRAGMENT_SHADER, FRAG);
    const p = g.createProgram()!;
    g.attachShader(p, vs);
    g.attachShader(p, fs);
    g.linkProgram(p);
    g.deleteShader(vs);
    g.deleteShader(fs);
    if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(p) ?? 'link');
    program = p;
    uni = {};
    for (const n of ['uSize', 'uRect', 'uBox', 'uClip', 'uRadius', 'uBezel', 'uThick', 'uAlpha', 'uRimOnly', 'uBend', 'uDisp', 'uBlur', 'uLod', 'uSat', 'uRim', 'uPx', 'uTex']) uni[n] = g.getUniformLocation(p, n);
    // WebGL 2 draws attribute-less geometry from gl_VertexID; a bound VAO keeps the state tidy
    vao = g.createVertexArray();
    pool = [];
  };

  const texture = (g: WebGL2RenderingContext, i: number) => {
    if (!pool[i]) {
      const tex = g.createTexture()!;
      g.bindTexture(g.TEXTURE_2D, tex);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR_MIPMAP_LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
      pool[i] = { tex, w: 0, h: 0 };
    }
    return pool[i];
  };

  const release = () => {
    if (gl && program) {
      gl.deleteProgram(program);
      for (const t of pool) gl.deleteTexture(t.tex);
      gl.deleteVertexArray(vao);
    }
    program = vao = null;
    pool = [];
    gl = null;
  };

  const paint = (g: WebGL2RenderingContext) => {
    if (!program) return;
    const t0 = probe ? performance.now() : 0;
    const canvas = map.getCanvas();
    // layout is read again only when an observer says the boxes moved or the canvas changed size: no layout read per frame
    if (dirty || !layout || layout.cw !== canvas.width || layout.ch !== canvas.height) {
      layout = measure();
      dirty = false;
    }
    const L = layout;
    if (!L) return;
    const t1 = probe ? performance.now() : 0;

    // the frame so far, cropped under the elements: the map has drawn every layer below this one straight into the
    // canvas. All crops are taken before anything is drawn, so a glass never lands in another one's crop.
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    g.activeTexture(g.TEXTURE0);
    L.clusters.forEach((c, i) => {
      const { sx, sy, sw, sh } = c.crop;
      const t = texture(g, i);
      g.bindTexture(g.TEXTURE_2D, t.tex);
      if (t.w !== sw || t.h !== sh) {
        g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, sw, sh, 0, g.RGBA, g.UNSIGNED_BYTE, null);
        t.w = sw;
        t.h = sh;
      }
      g.copyTexSubImage2D(g.TEXTURE_2D, 0, 0, 0, sx, L.ch - sy - sh, sw, sh);
      g.generateMipmap(g.TEXTURE_2D);
    });
    const t2 = probe ? performance.now() : 0;

    g.viewport(0, 0, L.cw, L.ch);
    g.disable(g.DEPTH_TEST);
    g.disable(g.CULL_FACE);
    g.disable(g.SCISSOR_TEST);
    g.useProgram(program);
    g.bindVertexArray(vao);
    g.uniform1i(uni.uTex, 0);
    g.uniform2f(uni.uSize, L.cssW, L.cssH);
    g.uniform1f(uni.uPx, L.k);
    g.uniform1f(uni.uDisp, look.dispersion);
    g.uniform1f(uni.uSat, look.saturation);
    g.uniform1f(uni.uRim, look.rim);
    L.clusters.forEach((c, i) => {
      g.bindTexture(g.TEXTURE_2D, pool[i].tex);
      g.uniform4f(uni.uBox, c.box.x, c.box.y, c.box.w, c.box.h);
      for (const h of c.hosts) {
        g.uniform4f(uni.uRect, h.x, h.y, h.w, h.h);
        g.uniform4f(uni.uClip, h.clip.x, h.clip.y, h.clip.x + h.clip.w, h.clip.y + h.clip.h);
        g.uniform1f(uni.uRadius, h.radius);
        g.uniform1f(uni.uBezel, h.bezel);
        g.uniform1f(uni.uThick, h.thick);
        g.uniform1f(uni.uBend, h.bend);
        g.uniform1f(uni.uBlur, h.blur);
        g.uniform1f(uni.uLod, Math.log2(Math.max(1, h.blur * L.k)));
        g.uniform1f(uni.uAlpha, h.alpha);
        g.uniform1f(uni.uRimOnly, h.rim ? 1 : 0);
        g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
      }
    });
    g.bindVertexArray(null);
    if (probe) {
      const t3 = performance.now();
      probe.push([t3 - t0, t1 - t0, t2 - t1, t3 - t2]);
    }
    setActive(true);
  };

  // the layer is removed after the frame that failed: taking it out of the style mid-render would break the map's loop
  const fail = (e: unknown) => {
    console.warn('mapGlass: falling back to the plain glass', e);
    setActive(false);
    queueMicrotask(teardown);
  };

  const layer: CustomLayerInterface = {
    id: LAYER_ID,
    type: 'custom',
    renderingMode: '2d',
    onAdd(_m, g) {
      try {
        gl = g;
        build(g);
      } catch (e) {
        fail(e);
      }
    },
    render(g) {
      try {
        paint(g);
      } catch (e) {
        fail(e);
      }
    },
    onRemove() {
      release();
    },
  };

  /** Add the layer once the style can take it, and keep it the top one (the page adds its own layers on load). */
  const attach = () => {
    if (dead || added) return;
    try {
      map.addLayer(layer);
      added = true;
    } catch {
      // the style is not loaded yet: the next styledata tries again
    }
  };
  const onStyleData = () => {
    if (!added) return attach();
    const order = map.getLayersOrder();
    if (order[order.length - 1] !== LAYER_ID) map.moveLayer(LAYER_ID);
  };
  const onLost = () => {
    added = false;
    setActive(false);
  };
  const onRestored = () => attach();

  /** The boxes may have moved: read them in the map's next frame, which has to be drawn for the layer to run. */
  const relayout = () => {
    dirty = true;
    map.triggerRepaint();
  };
  const ro = new ResizeObserver(relayout);

  /** While something moves or fades, the layout is read every frame (a transition fires no resize or scroll). */
  const settle = () => {
    settleUntil = performance.now() + SETTLE_MS;
    if (raf) return;
    const tick = () => {
      raf = 0;
      if (dead) return;
      relayout();
      if (performance.now() < settleUntil) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };
  const onTransition = (e: TransitionEvent) => {
    if (!MOVING.has(e.propertyName)) return;
    const t = e.target as Element;
    for (const h of hosts) {
      if (t.contains(h) || h.contains(t)) return settle();
    }
  };
  // a scrolling container that holds glass (the layer chips) moves it without a resize
  const onScroll = (e: Event) => {
    const t = e.target as Node;
    if (t === document) return;
    for (const h of hosts) {
      if (t.contains(h)) return relayout();
    }
  };

  const stage = map.getContainer().closest('.map-page');
  // the sheet state moves the bottom panes (a position change, no resize)
  const mo = new MutationObserver(relayout);
  // a live host (the dragged lens) keeps the layout read every frame until it is taken out
  let liveRaf = 0;
  const follow = () => {
    liveRaf = 0;
    if (dead || !live.size) return;
    relayout();
    liveRaf = requestAnimationFrame(follow);
  };
  const watcher = () => {
    relayout();
    if (live.size && !liveRaf) liveRaf = requestAnimationFrame(follow);
  };

  const teardown = () => {
    if (dead) return;
    dead = true;
    if (raf) cancelAnimationFrame(raf);
    if (liveRaf) cancelAnimationFrame(liveRaf);
    ro.disconnect();
    mo.disconnect();
    watchers.delete(watcher);
    window.removeEventListener('resize', relayout);
    window.visualViewport?.removeEventListener('resize', relayout);
    document.removeEventListener('scroll', onScroll, true);
    document.removeEventListener('transitionrun', onTransition, true);
    document.removeEventListener('transitionend', onTransition, true);
    map.off('styledata', onStyleData);
    map.off('webglcontextlost', onLost);
    map.off('webglcontextrestored', onRestored);
    try {
      if (added) map.removeLayer(LAYER_ID);
      map.triggerRepaint();
    } catch {
      // the map is already gone
    }
    release();
    setActive(false);
  };

  map.on('styledata', onStyleData);
  map.on('webglcontextlost', onLost);
  map.on('webglcontextrestored', onRestored);
  window.addEventListener('resize', relayout);
  window.visualViewport?.addEventListener('resize', relayout);
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  document.addEventListener('transitionrun', onTransition, true);
  document.addEventListener('transitionend', onTransition, true);
  watchers.add(watcher);
  if (stage) mo.observe(stage, { attributes: true, attributeFilter: ['data-sheet'] });
  ro.observe(map.getContainer());
  attach();
  relayout();

  return { destroy: teardown };
}
