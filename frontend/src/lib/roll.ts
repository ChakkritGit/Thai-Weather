/**
 * iOS-style number change: each character that changed rolls on its own, the new one in from below
 * and the old one out upwards when the value grew (the other way when it shrank), blurred while it
 * moves. Unchanged characters stay still. Off with prefers-reduced-motion. (Same as Dock's roll.js.)
 */
const DURATION = 420;
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** the value in '12.5%', '1.2 GB', '฿56,222.83' in comparable form */
export function magnitude(text: string): number {
  const m = /(-?\d[\d,]*(?:\.\d+)?)\s*(KB|MB|GB|TB|B)?/.exec(text);
  if (!m) return NaN;
  const unit: Record<string, number> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Number(m[1].replace(/,/g, '')) * (unit[m[2] ?? ''] ?? 1);
}

function glyph(ch: string) {
  const s = document.createElement('span');
  s.className = 'roll-glyph';
  s.textContent = ch;
  return s;
}

/** Shows `text` in `host`, rolling the characters that differ from what it showed before. */
export function roll(host: HTMLElement, text: string) {
  const from = host.dataset.value ?? host.textContent ?? '';
  if (from === text && host.dataset.value !== undefined) return;
  host.dataset.value = text;
  const before = magnitude(from);
  const after = magnitude(text);
  const animate =
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
    from !== text && Number.isFinite(before) && Number.isFinite(after) && before !== after;
  host.classList.add('roll');
  host.replaceChildren();
  const a = [...from];
  const b = [...text];
  const offset = b.length - a.length; // right-aligned: units and decimals line up
  const dir = after > before ? 1 : -1;
  b.forEach((ch, i) => {
    const slot = document.createElement('span');
    slot.className = 'roll-slot';
    slot.setAttribute('aria-hidden', 'true');
    const now = glyph(ch);
    slot.append(now);
    host.append(slot);
    const old = a[i - offset];
    if (!animate || old === ch) return;
    const delay = (b.length - 1 - i) * 18; // ones first, then tens, …
    now.animate(
      [{ transform: `translateY(${dir * 70}%)`, filter: 'blur(3px)', opacity: 0 }, { transform: 'none', filter: 'blur(0)', opacity: 1 }],
      { duration: DURATION, delay, easing: EASE, fill: 'backwards' },
    );
    if (old === undefined || old === ' ') return;
    const out = glyph(old);
    out.classList.add('roll-out');
    slot.append(out);
    out.animate(
      [{ transform: 'none', filter: 'blur(0)', opacity: 1 }, { transform: `translateY(${-dir * 70}%)`, filter: 'blur(3px)', opacity: 0 }],
      { duration: DURATION * 0.8, delay, easing: EASE, fill: 'forwards' },
    ).onfinish = () => out.remove();
  });
}
