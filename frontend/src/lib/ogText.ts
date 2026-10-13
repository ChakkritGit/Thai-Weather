import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Thai text for the link-preview cards, shaped with HarfBuzz and drawn as SVG paths.
 *
 * `next/og` (satori) does not apply OpenType mark positioning, so a tone mark on an upper vowel
 * (ที่, พื้น, กระบี่) is lost.  HarfBuzz shapes the text like a browser does; each line becomes an
 * SVG image that satori places like any other element.
 */
export type OgWeight = 400 | 700;

type HB = typeof import('harfbuzzjs');
type Loaded = { hb: HB; font: InstanceType<HB['Font']>; upem: number; asc: number; desc: number };

const FILES: Record<OgWeight, string> = { 400: 'IBMPlexSansThai-Regular.ttf', 700: 'IBMPlexSansThai-Bold.ttf' };
const fonts = new Map<OgWeight, Promise<Loaded>>();

function load(weight: OgWeight): Promise<Loaded> {
  let p = fonts.get(weight);
  if (!p) {
    p = (async () => {
      const hb = await import('harfbuzzjs');
      const data = await readFile(join(process.cwd(), 'public', 'fonts', FILES[weight]));
      const face = new hb.Face(new hb.Blob(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
      const font = new hb.Font(face);
      const ext = font.hExtents();
      return { hb, font, upem: face.upem, asc: ext.ascender, desc: ext.descender };
    })();
    fonts.set(weight, p);
  }
  return p;
}

interface Run {
  /** advance width in font units */
  width: number;
  glyphs: { d: string; x: number; y: number }[];
}

function shape(f: Loaded, text: string): Run {
  const buf = new f.hb.Buffer();
  buf.addText(text);
  buf.guessSegmentProperties();
  f.hb.shape(f.font, buf);
  const infos = buf.getGlyphInfos();
  const pos = buf.getGlyphPositions();
  let x = 0;
  const glyphs: Run['glyphs'] = [];
  infos.forEach((g, i) => {
    const d = f.font.glyphToPath(g.codepoint);
    if (d) glyphs.push({ d, x: x + pos[i].xOffset, y: pos[i].yOffset });
    x += pos[i].xAdvance;
  });
  return { width: x, glyphs };
}

/** Greedy line breaking on Thai/English word boundaries; the last allowed line ends in "…" when cut. */
function wrap(f: Loaded, text: string, maxUnits: number, maxLines: number): string[] {
  const words = [...new Intl.Segmenter('th', { granularity: 'word' }).segment(text)].map((s) => s.segment);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur + w;
    if (cur && shape(f, next.trimEnd()).width > maxUnits) {
      lines.push(cur.trimEnd());
      cur = w.trimStart();
    } else {
      cur = next;
    }
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last && shape(f, `${last}…`).width > maxUnits) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last.trimEnd()}…`;
  return kept;
}

export interface OgText {
  src: string;
  width: number;
  height: number;
}

export async function ogText(
  text: string,
  opts: { size: number; weight?: OgWeight; color: string; maxWidth?: number; maxLines?: number; lineHeight?: number },
): Promise<OgText> {
  const f = await load(opts.weight ?? 400);
  const scale = opts.size / f.upem;
  const lineH = opts.size * (opts.lineHeight ?? 1.4);
  const lines = opts.maxWidth ? wrap(f, text, opts.maxWidth / scale, opts.maxLines ?? 1) : [text];
  const runs = lines.map((l) => shape(f, l));
  const width = Math.ceil(Math.max(1, ...runs.map((r) => r.width)) * scale);
  const height = Math.ceil(lineH * runs.length);
  // baseline of each line, in font units, so ascender + descender sit centred in the line box
  const pad = (lineH / scale - (f.asc - f.desc)) / 2;
  const body = runs
    .map((r, i) => {
      const base = (i * lineH) / scale + pad + f.asc;
      const paths = r.glyphs.map((g) => `<path transform="translate(${g.x} ${g.y})" d="${g.d}"/>`).join('');
      return `<g transform="translate(0 ${base}) scale(1 -1)">${paths}</g>`;
    })
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g fill="${opts.color}" transform="scale(${scale})">${body}</g></svg>`;
  return { src: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, width, height };
}
