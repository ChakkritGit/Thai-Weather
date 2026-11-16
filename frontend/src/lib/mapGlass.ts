import type { CustomLayerInterface, Map as MLMap } from 'maplibre-gl';

/**
 * Liquid Glass for the round map buttons, drawn with WebGL from the map's own pixels. Safari cannot filter a
 * backdrop with SVG (Glisse falls back to blur there), so the bend is done here, the same on every browser.
 *
 * How it works: the glass is a custom layer on top of the map, drawn in MapLibre's own WebGL context. Each frame it
 * copies only the crop under the button column from the frame buffer into a small texture (a GPU-side copy, nothing
 * is read back or moved between contexts) and draws one rounded quad per button that bends that texture at its rim.
 * Only the map's own render triggers it, so nothing runs while the map is idle; hover, pressed and theme colours stay
 * plain CSS on the buttons (the tint is their background, over the map canvas).
 *
 * Why not an overlay canvas fed by drawImage/texImage2D: it is the same look, but moving pixels from the map's context
 * to another one stalls Safari for ~6 ms a frame whatever the crop size (measured), and Chromium for a readback.
 *
 * Not in the glass: DOM drawn over the map canvas (city labels, station dots). They stay crisp under the tint.
 */

/** The glass look. Lengths are CSS px. */
export interface Look {
  /**
   * Rim refraction, as Glisse's `--lg-refraction`: 1 is the full physical bend (Snell, n = 1.5, the content at the rim
   * is pulled in by up to ~9 px on a 40 px button), 0 is flat glass. Typical range 0..1.
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

export const DEFAULT_LOOK: Look = { bend: 0.75, dispersion: 1.05, blur: 2.5, saturation: 1.4, rim: 1 };

/** Colour-fringe width per unit of `Look.dispersion`, as a fraction of the displacement. */
const DISPERSION_UNIT = 0.12;
/** The copied crop reaches this far past the buttons: room for the blur taps at the rim. */
const PAD = 4;
const LAYER_ID = 'thwx-glass';

/**
 * Test hook, off unless a page sets `window.__mapGlassDebug`: `look` overrides the look, `probe` receives one
 * `[total, layout, copy, draw]` (ms of main-thread time) entry per drawn frame, `off` skips the glass (to compare
 * with the fallback).
 */
interface Debug {
  look?: Partial<Look>;
  probe?: number[][];
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

const VERT = `#version 300 es
uniform vec2 uSize;
uniform vec4 uRect;
out vec2 vPos;
void main() {
  // a strip of two triangles from gl_VertexID, one px wider than the button for its antialiased edge
  vec2 u = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vPos = uRect.xy - 1.0 + u * (uRect.zw + 2.0);
  gl_Position = vec4(vPos.x / uSize.x * 2.0 - 1.0, 1.0 - vPos.y / uSize.y * 2.0, 0.0, 1.0);
}`;

/**
 * Same optics as Glisse (node_modules/glisse, maps()): a squircle bevel whose slope refracts at n = 1.5, displacement
 * strongest at the rim and zero on the flat face, plus its glint. Positions are CSS px from the map canvas's top
 * left; the texture holds the crop `uBox` (same units, its row 0 is the bottom, as a frame buffer copy leaves it).
 */
const FRAG = `#version 300 es
precision highp float;
uniform vec2 uSize;
uniform vec4 uRect, uBox;
uniform float uRadius, uBezel, uThick;
uniform float uBend, uDisp, uBlur, uLod, uSat, uRim, uPx;
uniform sampler2D uTex;
in vec2 vPos;
out vec4 o;

vec3 tap(vec2 p) {
  vec2 uv = (p - uBox.xy) / uBox.zw;
  return textureLod(uTex, vec2(uv.x, 1.0 - uv.y), uLod).rgb;
}
// a soft face: the mip level does most of the blur, the diagonal taps hide its blocks
vec3 soft(vec2 p) {
  float k = uBlur * 0.5;
  return (2.0 * tap(p) + tap(p + vec2(k, k)) + tap(p + vec2(-k, k)) + tap(p + vec2(k, -k)) + tap(p + vec2(-k, -k))) / 6.0;
}

void main() {
  vec2 half_ = uRect.zw * 0.5;
  vec2 pc = vPos - (uRect.xy + half_);
  vec2 q = abs(pc) - (half_ - uRadius);
  vec2 oq = max(q, 0.0);
  float len = length(oq);
  float d = uRadius - (len + min(max(q.x, q.y), 0.0));
  float cover = clamp(d * uPx + 0.5, 0.0, 1.0);
  if (cover <= 0.0) discard;

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
  o = vec4(col * cover, cover);
}`.replace(/DISP_UNIT/g, DISPERSION_UNIT.toFixed(3));

/** One button's glass: its rounded rectangle in CSS px from the canvas's top left, and the bevel Glisse sizes for it. */
interface Shape extends Rect {
  radius: number;
  bezel: number;
  thick: number;
}

/** What the last layout pass read, and the canvas size it was read against. */
interface Layout {
  shapes: Shape[];
  crop: Crop;
  /** the crop as a CSS box, for the shader */
  box: Rect;
  /** device pixels per CSS px, and the canvas's CSS size */
  k: number;
  cssW: number;
  cssH: number;
  cw: number;
  ch: number;
}

export interface MapGlassOptions {
  /** the toolbar that holds the buttons (`.btn`) */
  host: HTMLElement;
  /** the map under the buttons */
  map: MLMap;
  /** true once the first frame is drawn (the page then drops its fallback), false when the glass cannot draw */
  onActive: (active: boolean) => void;
}

export interface MapGlass {
  /** draw nothing while true (the toolbar is faded out): the glass is part of the map's pixels, not of the DOM */
  setSuspended(suspended: boolean): void;
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
function cornerRadius(el: HTMLElement, w: number, h: number): number {
  const c = getComputedStyle(el).borderTopLeftRadius;
  const v = parseFloat(c);
  return Math.min(w / 2, h / 2, Number.isFinite(v) ? (c.endsWith('%') ? (Math.min(w, h) * v) / 100 : v) : 0);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Start the glass over `opts.map`; it reports through `onActive`. Null when switched off by the test hook. */
export function createMapGlass(opts: MapGlassOptions): MapGlass | null {
  const { host, map, onActive } = opts;
  const debug = (globalThis as { __mapGlassDebug?: Debug }).__mapGlassDebug;
  if (debug?.off) return null;
  const look: Look = { ...DEFAULT_LOOK, ...debug?.look };
  const probe = debug?.probe;

  let gl: WebGL2RenderingContext | null = null;
  let program: WebGLProgram | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  let tex: WebGLTexture | null = null;
  let texW = 0;
  let texH = 0;
  let uni: Record<string, WebGLUniformLocation | null> = {};
  let layout: Layout | null = null;
  let dirty = true;
  let added = false;
  let active = false;
  let suspended = false;
  let dead = false;

  const setActive = (on: boolean) => {
    if (active === on) return;
    active = on;
    onActive(on);
  };

  /** Read the buttons' boxes and where they lie over the map canvas. Null when there is nothing to draw. */
  const measure = (): Layout | null => {
    const canvas = map.getCanvas();
    const hr = host.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    const buttons = [...host.querySelectorAll<HTMLElement>('.btn')];
    if (!buttons.length || !hr.width || !cr.width || !canvas.width) return null;
    // a button that changes size without the toolbar changing size (a label shown) must be noticed too
    for (const el of buttons) ro.observe(el);
    const k = canvas.width / cr.width;
    const shapes: Shape[] = buttons.map((el) => {
      const r = el.getBoundingClientRect();
      const m = Math.min(r.width, r.height);
      return {
        x: r.left - cr.left,
        y: r.top - cr.top,
        w: r.width,
        h: r.height,
        radius: cornerRadius(el, r.width, r.height),
        // the bevel Glisse sizes for a button of this size
        bezel: clamp(m * 0.12, 4, 10),
        thick: clamp(m * 0.2, 8, 24),
      };
    });
    const crop = cropRect(unionRect(shapes, PAD), k, canvas.width, canvas.height);
    if (!crop) return null;
    const { sx, sy, sw, sh } = crop;
    return {
      shapes,
      crop,
      box: { x: sx / k, y: sy / k, w: sw / k, h: sh / k },
      k,
      cssW: cr.width,
      cssH: cr.height,
      cw: canvas.width,
      ch: canvas.height,
    };
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
    for (const n of ['uSize', 'uRect', 'uBox', 'uRadius', 'uBezel', 'uThick', 'uBend', 'uDisp', 'uBlur', 'uLod', 'uSat', 'uRim', 'uPx', 'uTex']) uni[n] = g.getUniformLocation(p, n);
    // WebGL 2 draws attribute-less geometry from gl_VertexID; a bound VAO keeps the state tidy
    vao = g.createVertexArray();
    tex = g.createTexture();
    g.bindTexture(g.TEXTURE_2D, tex);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR_MIPMAP_LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    texW = texH = 0;
  };

  const release = () => {
    if (gl && program) {
      gl.deleteProgram(program);
      gl.deleteTexture(tex);
      gl.deleteVertexArray(vao);
    }
    program = vao = tex = null;
    gl = null;
  };

  const paint = (g: WebGL2RenderingContext) => {
    if (suspended || !program) return;
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

    // the frame so far, cropped to the buttons: the map has drawn every layer below this one straight into the canvas
    const { sx, sy, sw, sh } = L.crop;
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, tex);
    if (texW !== sw || texH !== sh) {
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, sw, sh, 0, g.RGBA, g.UNSIGNED_BYTE, null);
      texW = sw;
      texH = sh;
    }
    g.copyTexSubImage2D(g.TEXTURE_2D, 0, 0, 0, sx, L.ch - sy - sh, sw, sh);
    g.generateMipmap(g.TEXTURE_2D);
    const t2 = probe ? performance.now() : 0;

    g.viewport(0, 0, L.cw, L.ch);
    g.disable(g.DEPTH_TEST);
    g.disable(g.CULL_FACE);
    g.disable(g.SCISSOR_TEST);
    g.useProgram(program);
    g.bindVertexArray(vao);
    g.uniform1i(uni.uTex, 0);
    g.uniform2f(uni.uSize, L.cssW, L.cssH);
    g.uniform4f(uni.uBox, L.box.x, L.box.y, L.box.w, L.box.h);
    g.uniform1f(uni.uPx, L.k);
    g.uniform1f(uni.uBend, look.bend);
    g.uniform1f(uni.uDisp, look.dispersion);
    g.uniform1f(uni.uBlur, look.blur);
    g.uniform1f(uni.uLod, Math.log2(Math.max(1, look.blur * L.k)));
    g.uniform1f(uni.uSat, look.saturation);
    g.uniform1f(uni.uRim, look.rim);
    for (const s of L.shapes) {
      g.uniform4f(uni.uRect, s.x, s.y, s.w, s.h);
      g.uniform1f(uni.uRadius, s.radius);
      g.uniform1f(uni.uBezel, s.bezel);
      g.uniform1f(uni.uThick, s.thick);
      g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    }
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
    suspended = true;
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

  /** The map has to draw once more to apply a layout change (an idle map would never run the layer). */
  const repaint = () => map.triggerRepaint();
  const relayout = () => {
    dirty = true;
    repaint();
  };
  const ro = new ResizeObserver(relayout);

  const teardown = () => {
    if (dead) return;
    dead = true;
    ro.disconnect();
    window.removeEventListener('resize', relayout);
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
  ro.observe(host);
  ro.observe(map.getContainer());
  attach();
  repaint();

  return {
    setSuspended(s) {
      if (suspended === s) return;
      suspended = s;
      repaint();
    },
    destroy: teardown,
  };
}
