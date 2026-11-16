/**
 * Copied from CalorieFlow (src/lib/dom-glass.ts): keep the two in step.
 *
 * Liquid Glass refraction where the live backdrop cannot be filtered (Safari, every iOS browser, Firefox). A thin copy
 * of the page content behind a glass pane is bent by an SVG displacement filter set through CSS `filter: url()`, which
 * those browsers do apply to HTML. Only the blocks that meet the pane are cloned, and the copy follows the scroll by
 * moving one element, so a scroll frame never clones. Glisse's own copy mode (data-glisse-backdrop) clones the whole
 * subtree and re-reads styles every frame; in WebKit it fell to 26-36 fps and stalled for seconds on each change.
 *
 * The copy is drawn at 1/SCALE of the screen's resolution and scaled back up: the blur hides the loss, and the filter
 * runs on SCALE^2 fewer pixels (iOS Simulator, DPR 3: 58-60 fps at 1/3 against 28-34 fps at full resolution).
 */

const SVGNS = "http://www.w3.org/2000/svg";
/** content kept around the pane so the bend has pixels to pull in from (CSS px) */
const MARGIN = 14;
/** document height held above and below the pane, so a scroll rarely has to clone (CSS px) */
const REACH = 900;
const SCALE = 3;
/** a subtree with at most this many elements is cloned whole */
const MAX_NODES = 80;
/** changes are folded together this long, but never held past MAX_WAIT (a ticking element must not starve them) */
const IDLE_MS = 80;
const MAX_WAIT_MS = 400;
/** the follow loop stops after this many frames without movement */
const STILL_FRAMES = 12;

const SKIP_TAG = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "LINK", "META", "DIALOG"]);
/** never copied: fixed and sticky layers do not scroll with the page (Tailwind class tokens, found without styles) */
const FLOATING = ".fixed, .sticky, [data-dg-skip]";
/** live media: a clone would load and play again, so it becomes a still box */
const MEDIA = new Set(["VIDEO", "IFRAME", "EMBED", "OBJECT", "AUDIO"]);
// a clone placed outside its own ancestors still needs the values it inherited from them
const INHERITED = [
  "color", "font-family", "font-size", "font-style", "font-weight", "font-variant", "font-feature-settings",
  "font-stretch", "line-height", "letter-spacing", "word-spacing", "text-align", "text-indent", "text-transform",
  "text-shadow", "white-space", "word-break", "overflow-wrap", "direction", "text-rendering", "-webkit-text-fill-color",
  "-webkit-font-smoothing", "list-style-type", "font-variant-numeric",
];
const PLACED =
  "position:absolute;margin:0;min-width:0;max-width:none;min-height:0;max-height:none;box-sizing:border-box;" +
  "transform:none;translate:none;scale:none;rotate:none;float:none;inset:auto;animation:none;transition:none;";

type Block = { el: Element; x: number; y: number; w: number; h: number; shallow: boolean };
type Live = { node: HTMLElement; w: number; h: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const transparent = (c: string) => c === "transparent" || /^rgba\(.*,\s*0\)$/.test(c);
const svg = (name: string, attrs: Record<string, string | number>) => {
  const el = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};
const hasText = (el: Element) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim() !== "");

/* Lens: Glisse 0.4.3's displacement field (MIT) for a rounded pane, with a neutral margin around it. */

let defs: SVGDefsElement | undefined;
const lenses = new Map<string, string>();

function defsRoot() {
  if (defs?.isConnected) return defs;
  const root = svg("svg", { width: 0, height: 0, "aria-hidden": "true" });
  (root as SVGElement).style.cssText = "position:absolute;pointer-events:none";
  defs = svg("defs", {}) as SVGDefsElement;
  root.append(defs);
  document.body.append(root);
  return defs;
}

/** Return the bend's height by distance from the rim: Snell's law through a squircle bezel. */
function profile(bezel: number, thickness: number) {
  const samples = new Float32Array(128);
  let maximum = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = Math.max(0.001, i / (samples.length - 1));
    const surface = (1 - (1 - t) ** 4) ** 0.25;
    const incident = Math.atan((1 - t) ** 3 / surface ** 3);
    const refracted = Math.asin(Math.sin(incident) / 1.5);
    samples[i] = Math.tan(incident - refracted) * (thickness + surface * bezel);
    maximum = Math.max(maximum, samples[i]);
  }
  return { samples, maximum };
}

function field(width: number, height: number, radius: number, shrink: number, bezelIn?: number, thickIn?: number) {
  // the copy is drawn at 1/shrink of the device resolution, so a coarser field is enough
  const density = clamp((devicePixelRatio || 1) / shrink, 1, 2);
  const full = { w: width + 2 * MARGIN, h: height + 2 * MARGIN };
  // a much wider, thicker bevel than Glisse's (0.12 / 0.2 of the short side), as on Thai Weather's map glass: at
  // Glisse's size the bend read too faintly on a phone, above all along the long top and bottom edges (2026-11-16)
  const bezel = bezelIn ?? clamp(Math.min(width, height) * 0.35, 8, 24);
  const { samples, maximum } = profile(bezel, thickIn ?? clamp(Math.min(width, height) * 0.6, 16, 48));
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(full.w * density);
  canvas.height = Math.ceil(full.h * density);
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++)
    for (let x = 0; x < canvas.width; x++) {
      const px = ((x + 0.5) * full.w) / canvas.width - full.w / 2;
      const py = ((y + 0.5) * full.h) / canvas.height - full.h / 2;
      const qx = Math.abs(px) - (width / 2 - radius);
      const qy = Math.abs(py) - (height / 2 - radius);
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      const length = Math.hypot(ox, oy);
      const distance = radius - (length + Math.min(Math.max(qx, qy), 0));
      const nx = length > 0 ? (ox / length) * Math.sign(px) : qx > qy ? Math.sign(px) : 0;
      const ny = length > 0 ? (oy / length) * Math.sign(py) : qx > qy ? 0 : Math.sign(py);
      let shift = 0;
      if (distance >= 0 && distance < bezel) {
        const s = (distance / bezel) * (samples.length - 1);
        const lo = Math.floor(s);
        const a = samples[lo];
        shift = a + (samples[Math.min(lo + 1, samples.length - 1)] - a) * (s - lo);
      }
      // inward (-1), as Glisse's pane: the rim pulls in what lies just outside it
      const i = (y * canvas.width + x) * 4;
      img.data[i] = Math.round(127.5 - ((nx * shift) / maximum) * 127.5);
      img.data[i + 1] = Math.round(127.5 - ((ny * shift) / maximum) * 127.5);
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return { url: canvas.toDataURL(), scale: maximum * 2 };
}

/**
 * Return the id of a filter that bends a pane of this size, drawn on a box MARGIN px larger on every side. WebKit draws
 * nothing for an HTML element whose filter uses userSpaceOnUse units, so the region is the element's own box.
 */
/**
 * How far red and blue are bent apart, as a fraction of the bend: Thai Weather's map glass (DISPERSION_UNIT 0.12 times
 * its --wgl-disp), so both apps look alike (the owner's ask). The lifted lens: disp 4, a wide fringe as iOS's.
 */
const LENS_SPREAD = 0.48;
/** the lifted lens bends more than a bar, as Thai Weather's (--wgl-bend 1.3) */
const LENS_BEND = 1.3;

function lens(width: number, height: number, radius: number, shrink: number, tune: { bezel?: number; thickness?: number; level: number; spread?: number }) {
  const key = [width, height, radius, shrink, tune.bezel, tune.thickness, tune.level, tune.spread, devicePixelRatio].join("-");
  const cached = lenses.get(key);
  if (cached) return cached;
  const { url, scale } = field(width, height, radius, shrink, tune.bezel, tune.thickness);
  const id = `dg-lens-${lenses.size}`;
  const f = svg("filter", { id, x: 0, y: 0, width: 1, height: 1, "color-interpolation-filters": "sRGB" });
  // the displacement is in the filtered box's own pixels, `shrink` times larger than the screen's
  const k = (scale * tune.level) / shrink;
  const bend = (by: number, result: string) => svg("feDisplacementMap", { in: "SourceGraphic", in2: "field", scale: k * by, xChannelSelector: "R", yChannelSelector: "G", result });
  f.append(svg("feImage", { href: url, preserveAspectRatio: "none", result: "field" }));
  const spread = tune.spread ?? 0;
  if (spread > 0) {
    // red bent further than green, blue less: each channel kept from its own pass, then added back together
    const only = (inp: string, row: number, result: string) => {
      const m = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0];
      m[row * 5 + row] = 1;
      return svg("feColorMatrix", { in: inp, type: "matrix", values: m.join(" "), result });
    };
    const add = (a: string, b: string, result: string) => svg("feComposite", { in: a, in2: b, operator: "arithmetic", k1: 0, k2: 1, k3: 1, k4: 0, result });
    f.append(bend(1 + spread, "r0"), only("r0", 0, "r"), bend(1, "g0"), only("g0", 1, "g"), bend(1 - spread, "b0"), only("b0", 2, "b"), add("r", "g", "rg"), add("rg", "b", "bent"));
  } else f.append(bend(1, "bent"));
  f.append(svg("feColorMatrix", { in: "bent", type: "saturate", values: 1.5 }));
  defsRoot().append(f);
  lenses.set(key, id);
  return id;
}

/* Source: the page content, indexed into blocks that are cheap to find by position and to clone. */

export type SourceStats = { blocks: number; clones: number; indexMs: number; live: number };

export class GlassSource {
  readonly root: HTMLElement;
  readonly scroller: Window | HTMLElement;
  blocks: Block[] = [];
  stats: SourceStats = { blocks: 0, clones: 0, indexMs: 0, live: 0 };
  private byEl = new Map<Element, Block>();
  private strips = new Set<Strip>();
  private dirty = new Set<Element>();
  private full = false;
  private timer = 0;
  private since = 0;
  private reasons = new Set<string>();
  private frame = 0;
  private still = 0;
  private poked = 0;
  private pointer = false;
  private cleanups: (() => void)[] = [];

  constructor(root: HTMLElement, scroller: Window | HTMLElement = window) {
    this.root = root;
    this.scroller = scroller;
    this.index();
    const note = (records: MutationRecord[]) => {
      for (const r of records) {
        let el: Element | null = r.target instanceof Element ? r.target : r.target.parentElement;
        while (el && el !== root && !this.byEl.has(el)) el = el.parentElement;
        // a change inside a block redraws that block; one in the shell around blocks only moves them (re-indexed)
        if (el && el !== root) this.dirty.add(el);
      }
      this.schedule();
    };
    const mo = new MutationObserver(note);
    mo.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    // the theme and the skin change every colour: the clones' inlined colours must be taken again
    const theme = new MutationObserver(() => this.schedule(true));
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-skin"] });
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const rescheme = () => this.schedule(true);
    scheme.addEventListener("change", rescheme);
    // a late image or font moves everything below it
    const ro = new ResizeObserver(() => this.schedule());
    ro.observe(root);
    const load = () => this.schedule();
    root.addEventListener("load", load, true);
    document.fonts?.ready.then(() => this.cleanups.length && load());

    const opts = { passive: true, capture: true } as const;
    const kick = () => this.kick();
    const down = () => {
      this.pointer = true;
      this.kick();
    };
    const up = () => (this.pointer = false);
    const move = () => this.pointer && this.kick();
    // a bar settling or a pane's own transition moves the pane with no scroll event
    const moved = (e: Event) => {
      const t = e.target as Node;
      for (const s of this.strips) if (t.contains?.(s.pane)) return this.kick();
    };
    scroller.addEventListener("scroll", kick, { passive: true });
    window.addEventListener("resize", kick);
    visualViewport?.addEventListener("resize", kick);
    visualViewport?.addEventListener("scroll", kick);
    window.addEventListener("pointerdown", down, opts);
    window.addEventListener("pointermove", move, opts);
    window.addEventListener("pointerup", up, opts);
    window.addEventListener("pointercancel", up, opts);
    window.addEventListener("transitionrun", moved, opts);
    window.addEventListener("transitionend", moved, opts);
    this.cleanups.push(() => {
      mo.disconnect();
      theme.disconnect();
      ro.disconnect();
      scheme.removeEventListener("change", rescheme);
      root.removeEventListener("load", load, true);
      scroller.removeEventListener("scroll", kick);
      window.removeEventListener("resize", kick);
      visualViewport?.removeEventListener("resize", kick);
      visualViewport?.removeEventListener("scroll", kick);
      window.removeEventListener("pointerdown", down, opts);
      window.removeEventListener("pointermove", move, opts);
      window.removeEventListener("pointerup", up, opts);
      window.removeEventListener("pointercancel", up, opts);
      window.removeEventListener("transitionrun", moved, opts);
      window.removeEventListener("transitionend", moved, opts);
    });
  }

  /** the scroll offset the blocks' coordinates are measured against */
  offset() {
    const s = this.scroller;
    return s instanceof Window ? { x: s.scrollX, y: s.scrollY } : { x: s.scrollLeft, y: s.scrollTop };
  }

  /** the scroller's top-left in the viewport */
  origin() {
    const s = this.scroller;
    if (s instanceof Window) return { x: 0, y: 0 };
    const r = s.getBoundingClientRect();
    return { x: r.left, y: r.top };
  }

  /** Walk the content once: blocks are the largest elements that are cheap enough to clone whole. */
  private index() {
    const t0 = performance.now();
    const o = this.offset();
    const at = this.origin();
    const counts = new Map<Element, number>();
    const count = (el: Element): number => {
      let n = 1;
      for (const c of el.children) n += count(c);
      counts.set(el, n);
      return n;
    };
    count(this.root);
    // a block holding a floating layer is split, so the layer itself is reached and left out
    const floats = new Set<Element>();
    for (const f of this.root.querySelectorAll(FLOATING))
      for (let p: Element | null = f; p && p !== this.root && !floats.has(p); p = p.parentElement) floats.add(p);
    const next: Block[] = [];
    const push = (el: Element, shallow: boolean) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      next.push({ el, x: r.left - at.x + o.x, y: r.top - at.y + o.y, w: r.width, h: r.height, shallow });
    };
    const painted = (cs: CSSStyleDeclaration) =>
      !transparent(cs.backgroundColor) || cs.backgroundImage !== "none" || cs.boxShadow !== "none" || parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderBottomWidth) > 0;
    const visit = (parent: Element) => {
      for (const el of parent.children) {
        if (SKIP_TAG.has(el.tagName) || el.hasAttribute("data-dg-skip")) continue;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.position === "fixed" || cs.position === "sticky") continue;
        if (cs.display === "contents") {
          visit(el);
          continue;
        }
        const floating = floats.has(el);
        if (!floating && ((counts.get(el) ?? 1) <= MAX_NODES || !el.firstElementChild || hasText(el))) {
          push(el, false);
          continue;
        }
        if (painted(cs)) push(el, true);
        visit(el);
      }
    };
    if (painted(getComputedStyle(this.root))) push(this.root, true);
    visit(this.root);
    next.sort((a, b) => a.y - b.y);
    this.blocks = next;
    this.byEl = new Map(next.map((b) => [b.el, b]));
    this.stats.blocks = next.length;
    this.stats.indexMs = performance.now() - t0;
  }

  private schedule(full = false) {
    if (full) this.full = true;
    const now = performance.now();
    if (!this.timer) this.since = now;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.flush(), now - this.since > MAX_WAIT_MS ? 0 : IDLE_MS);
  }

  private flush() {
    this.timer = 0;
    const dirty = new Set(this.dirty);
    const full = this.full;
    this.dirty.clear();
    this.full = false;
    this.index();
    for (const s of this.strips) s.refresh(dirty, full);
  }

  /**
   * Lay a bent copy of the content under `pane` (a glass element whose parent is positioned). `follow`: the pane is
   * moved and scaled by a transform (the tab bar's lifted lens); the copy takes the same transform every frame, sits
   * above its siblings' glass (it covers the bar, as on iOS) and is near clear, a magnifier.
   */
  attach(pane: HTMLElement, opts: { follow?: boolean; under?: HTMLElement } = {}) {
    const strip = new Strip(this, pane, !!opts.follow, opts.under);
    this.strips.add(strip);
    if (this.reasons.size) strip.show(false);
    return () => {
      strip.destroy();
      this.strips.delete(strip);
    };
  }

  /** Hide the copies (the panes fall back to Glisse's blur) while any reason holds. */
  suspend(reason: string, on: boolean) {
    const was = this.reasons.size > 0;
    if (on) this.reasons.add(reason);
    else this.reasons.delete(reason);
    const now = this.reasons.size > 0;
    if (was === now) return;
    for (const s of this.strips) s.show(!now);
    // changes were indexed meanwhile but the hidden copies may have missed a redraw
    if (!now) this.schedule();
  }

  get suspended() {
    return this.reasons.size > 0;
  }

  /** Follow the panes every frame until they have been still for a while (a scroll, a bar settling, a pull). */
  kick() {
    this.poked = performance.now();
    if (!this.frame && !this.suspended) this.frame = requestAnimationFrame(this.tick);
  }

  private tick = () => {
    this.frame = 0;
    let moved = false;
    // every strip reads first, then all write: a write between two reads forces a layout per strip in a frame
    const writes = [...this.strips].map((s) => s.measure());
    for (const w of writes) moved = (w?.() ?? false) || moved;
    this.still = moved || performance.now() - this.poked < 100 ? 0 : this.still + 1;
    if (this.still < STILL_FRAMES) this.frame = requestAnimationFrame(this.tick);
    let live = 0;
    for (const s of this.strips) live += s.size;
    this.stats.live = live;
  };

  destroy() {
    clearTimeout(this.timer);
    cancelAnimationFrame(this.frame);
    for (const c of this.cleanups) c();
    this.cleanups = [];
    for (const s of this.strips) s.destroy();
    this.strips.clear();
  }
}

/* Strip: the filtered copy under one glass pane. */

class Strip {
  readonly el = document.createElement("div");
  private world = document.createElement("div");
  private live = new Map<Element, Live>();
  private loaded = { top: 1, bottom: 0 };
  private ro: ResizeObserver;
  private io: IntersectionObserver;
  private onScreen = true;
  private shown = true;
  private at = "";
  private ghost = document.createElement("div");
  /** the copy is drawn at 1/k resolution: SCALE for the bars that ride a scroll, half for the lens (1/3 showed as
   * blocks; full resolution with the colour fringe's three passes stuttered on the owner's iPhone) */
  private k: number;

  constructor(
    private src: GlassSource,
    readonly pane: HTMLElement,
    private follow = false,
    /** the bar under a lens: drawn into the lens's copy, so its edges show bent through the lens, as on iOS */
    private under?: HTMLElement,
  ) {
    this.k = follow ? 2 : SCALE;
    if (under) {
      const cs = getComputedStyle(under);
      this.ghost.style.cssText =
        `position:absolute;pointer-events:none;background-color:${cs.backgroundColor};` +
        `background-image:${cs.backgroundImage};background-size:100% 100%;` +
        "box-shadow:inset 0 0 0 1.5px rgb(255 255 255 / 0.55),inset 0 1px 2px rgb(255 255 255 / 0.4),0 0 0 1px rgb(0 0 0 / 0.14);";
      this.world.append(this.ghost);
    }
    // contain: the clones never touch the page's layout; the box is the pane's plus the margin, at 1/k
    this.el.style.cssText = `position:absolute;z-index:${follow ? 0 : -2};overflow:hidden;pointer-events:none;transform-origin:0 0;contain:strict;`;
    this.el.className = "dg-strip";
    this.el.setAttribute("aria-hidden", "true");
    this.el.setAttribute("inert", "");
    // zoom, not a transform: on iOS Safari a transformed descendant makes the filtered element draw nothing
    this.world.style.cssText = `position:absolute;left:0;top:0;zoom:${1 / this.k};`;
    this.el.append(this.world);
    pane.before(this.el);
    // Glisse drops the pane's own backdrop blur when it carries a copy
    pane.setAttribute("data-copy", "");
    this.restyle();
    this.ro = new ResizeObserver(() => {
      this.restyle();
      this.update(true);
    });
    this.ro.observe(pane);
    this.io = new IntersectionObserver((e) => {
      this.onScreen = e[e.length - 1].isIntersecting;
      if (this.onScreen) this.update(true);
    });
    this.io.observe(pane);
    this.update(true);
  }

  get size() {
    return this.live.size;
  }

  /** Read the pane's shape and colour, and set the filter for its size (cached). */
  private restyle() {
    const p = this.pane;
    const w = p.offsetWidth;
    const h = p.offsetHeight;
    if (!w || !h) return;
    const cs = getComputedStyle(p);
    const corner = cs.borderTopLeftRadius;
    const radius = Math.min(w / 2, h / 2, corner.endsWith("%") ? (Math.min(w, h) * parseFloat(corner)) / 100 : parseFloat(corner) || 0);
    const num = (n: string) => {
      const v = parseFloat(cs.getPropertyValue(n));
      return Number.isFinite(v) ? v : undefined;
    };
    const blur = this.follow ? 0.5 : (num("--lg-blur") ?? 3);
    // --dg-spread: a bar's own colour fringe (off unless set: the three passes cost a scroll frame)
    const level = (num("--lg-refraction") ?? 1) * (this.follow ? LENS_BEND : 1);
    const id = lens(w, h, radius, this.k, { bezel: num("--lg-bezel"), thickness: num("--lg-thickness"), level, spread: this.follow ? LENS_SPREAD : num("--dg-spread") });
    const s = this.el.style;
    s.left = `${p.offsetLeft - MARGIN}px`;
    s.top = `${p.offsetTop - MARGIN}px`;
    s.width = `${(w + 2 * MARGIN) / this.k}px`;
    s.height = `${(h + 2 * MARGIN) / this.k}px`;
    s.transform = `scale(${this.k})`;
    s.filter = `blur(${blur / this.k}px) url("#${id}")`;
    s.clipPath = `inset(${MARGIN / this.k}px round ${radius / this.k}px)`;
    // opaque: the live page must not show through, or a copy a frame late would ghost over it
    let bg = "";
    for (let n: Element | null = this.src.root; n && !bg; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (!transparent(c)) bg = c;
    }
    s.backgroundColor = bg;
  }

  show(on: boolean) {
    this.shown = on;
    this.el.style.display = on ? "" : "none";
    if (on) {
      this.pane.setAttribute("data-copy", "");
      this.update(true);
    } else this.pane.removeAttribute("data-copy");
  }

  /** Move the copy under the pane; load or drop blocks near the edge of what is loaded. Returns whether it moved. */
  update(force = false) {
    return this.measure(force)?.() ?? false;
  }

  /** Read the layout this frame needs; the returned function writes it (see GlassSource.tick). */
  measure(force = false): (() => boolean) | null {
    if (!this.shown || (!this.onScreen && !force)) return null;
    const r = this.pane.getBoundingClientRect();
    const w = this.pane.offsetWidth;
    const h = this.pane.offsetHeight;
    if (!r.width || !w) return null;
    // from the centre: a pane scaled or stretched about its middle (the add button's give) keeps its content centred
    const left = r.left + r.width / 2 - w / 2;
    const top = r.top + r.height / 2 - h / 2;
    const o = this.src.offset();
    const at = this.src.origin();
    const dpr = devicePixelRatio || 1;
    const tx = Math.round((MARGIN - left + at.x - o.x) * dpr) / dpr;
    const ty = Math.round((MARGIN - top + at.y - o.y) * dpr) / dpr;
    const t = this.follow ? getComputedStyle(this.pane).transform : "none";
    const u = this.under?.getBoundingClientRect();
    return () => this.write(force, w, h, left, top, o, at, tx, ty, t, u);
  }

  private write(force: boolean, w: number, h: number, left: number, top: number, o: { x: number; y: number }, at: { x: number; y: number }, tx: number, ty: number, t: string, u: DOMRect | undefined) {
    const key = `${tx},${ty}`;
    const moved = key !== this.at;
    if (moved) {
      this.at = key;
      this.world.style.left = `${tx}px`;
      this.world.style.top = `${ty}px`;
    }
    if (this.follow) {
      // the pane's own transform (translate and scale about its centre), applied about the same point of the copy
      const cx = MARGIN + w / 2;
      const cy = MARGIN + h / 2;
      const next = t === "none" ? `scale(${this.k})` : `translate(${cx}px, ${cy}px) ${t} translate(${-cx}px, ${-cy}px) scale(${this.k})`;
      if (this.el.style.transform !== next) this.el.style.transform = next;
      // a grown lens is scaled unevenly; its clip's corners are drawn elliptical so the screen shows a capsule
      const m = t.match(/^matrix\(([^,]+),[^,]+,[^,]+,([^,]+),/);
      const sx = m ? parseFloat(m[1]) || 1 : 1;
      const sy = m ? parseFloat(m[2]) || 1 : 1;
      const round = Math.min(w * sx, h * sy) / 2;
      const clip = `inset(${MARGIN / this.k}px round ${round / sx / this.k}px / ${round / sy / this.k}px)`;
      if (this.el.style.clipPath !== clip) this.el.style.clipPath = clip;
      if (u) {
        // placed so that after the lens's scale it lands on the bar's true place: the lens magnifies the page, but the
        // bar keeps its size and only its edges bend at the rim, as on iOS (scaled with the lens, its edges sat on the rim)
        const cx0 = left + w / 2;
        const cy0 = top + h / 2;
        const g = this.ghost.style;
        g.left = `${(u.left - cx0) / sx + cx0 - at.x + o.x}px`;
        g.top = `${(u.top - cy0) / sy + cy0 - at.y + o.y}px`;
        g.width = `${u.width / sx}px`;
        g.height = `${u.height / sy}px`;
        const ur = Math.min(u.width, u.height) / 2;
        g.borderRadius = `${ur / sx}px / ${ur / sy}px`;
      }
    }
    const docTop = o.y + top - at.y - MARGIN;
    const docBottom = o.y + top + h - at.y + MARGIN;
    if (force || docTop < this.loaded.top + REACH / 3 || docBottom > this.loaded.bottom - REACH / 3) this.sync(docTop - REACH, docBottom + REACH);
    // the bar's copy lies over the cloned blocks, which sync appends
    if (this.under && this.world.lastChild !== this.ghost) this.world.append(this.ghost);
    return moved;
  }

  /** Make the copy hold exactly the blocks that overlap [top, bottom]. */
  private sync(top: number, bottom: number) {
    const want = new Set<Element>();
    const add: Block[] = [];
    for (const b of this.src.blocks) {
      if (b.y > bottom) break;
      if (b.y + b.h < top) continue;
      want.add(b.el);
      if (!this.live.has(b.el)) add.push(b);
    }
    for (const [el, l] of this.live)
      if (!want.has(el)) {
        l.node.remove();
        this.live.delete(el);
      }
    const frag = document.createDocumentFragment();
    for (const b of add) frag.append(this.clone(b));
    this.world.append(frag);
    this.loaded = { top, bottom };
  }

  /** The source changed: move the blocks that moved, redraw the changed ones (all of them for a new theme). */
  refresh(dirty: Set<Element>, full: boolean) {
    this.restyle();
    const now = new Map(this.src.blocks.map((b) => [b.el, b]));
    for (const [el, l] of this.live) {
      const b = now.get(el);
      if (!b || full || dirty.has(el) || Math.abs(b.w - l.w) > 0.5 || Math.abs(b.h - l.h) > 0.5) {
        l.node.remove();
        this.live.delete(el);
      } else {
        l.node.style.left = `${b.x}px`;
        l.node.style.top = `${b.y}px`;
      }
    }
    this.loaded = { top: 1, bottom: 0 };
    this.update(true);
  }

  /** Clone one block and place it at its document position. */
  private clone(b: Block) {
    const src = b.el as HTMLElement;
    const node = copy(src, !b.shallow, false) as HTMLElement;
    const cs = getComputedStyle(src);
    for (const name of INHERITED) node.style.setProperty(name, cs.getPropertyValue(name));
    // a shell (its children are blocks of their own) keeps no z-index: one (a sheet's) painted it over its content
    node.style.cssText += `;${PLACED}left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;${b.shallow ? "z-index:auto;" : ""}`;
    this.live.set(b.el, { node, w: b.w, h: b.h });
    this.src.stats.clones++;
    return node;
  }

  destroy() {
    this.ro.disconnect();
    this.io.disconnect();
    this.el.remove();
    this.pane.removeAttribute("data-copy");
  }
}

/**
 * Copy a node node by node rather than with a deep cloneNode: a cloned <video> would start loading as soon as its src
 * is copied, so live media is swapped for a still box before it exists.
 */
function copy(o: Node, deep: boolean, inSvg: boolean): Node {
  if (!(o instanceof Element)) return o.cloneNode(false);
  if (MEDIA.has(o.tagName)) return still(o as HTMLElement);
  const c = o.cloneNode(false) as Element;
  const svgNow = inSvg || o.tagName === "svg";
  // ids inside an SVG stay: its gradients and clips point at them, and the original's come first anyway
  if (c.id && !svgNow) c.removeAttribute("id");
  if (c instanceof HTMLImageElement && o instanceof HTMLImageElement) {
    c.loading = "eager";
    if (o.currentSrc) {
      c.src = o.currentSrc;
      c.removeAttribute("srcset");
      c.removeAttribute("sizes");
    }
  } else if (c instanceof HTMLCanvasElement && o instanceof HTMLCanvasElement) {
    try {
      c.getContext("2d")?.drawImage(o, 0, 0);
    } catch {
      // a zero-size canvas: the copy stays blank
    }
  } else if (c instanceof HTMLInputElement || c instanceof HTMLTextAreaElement || c instanceof HTMLSelectElement) {
    // a copied radio with the same name would join, and uncheck, the original's group
    c.removeAttribute("name");
    if (!(c instanceof HTMLSelectElement)) c.value = (o as HTMLInputElement).value;
  }
  if (deep) for (let n = o.firstChild; n; n = n.nextSibling) if (n.nodeType !== 8) c.appendChild(copy(n, true, svgNow));
  return c;
}

/** A still stand-in for a video, frame or embed: its box and background, and a video's poster. */
function still(o: HTMLElement) {
  const d = document.createElement("div");
  d.className = o.className;
  const cs = getComputedStyle(o);
  d.style.cssText = `display:${cs.display === "inline" ? "inline-block" : cs.display};width:${o.offsetWidth}px;height:${o.offsetHeight}px;border-radius:${cs.borderRadius};background-color:${transparent(cs.backgroundColor) ? "#000" : cs.backgroundColor};`;
  if (o instanceof HTMLVideoElement && o.poster) d.style.background = `center / cover no-repeat url("${o.poster.replace(/"/g, "%22")}")`;
  return d;
}
