// iOS-style number change, odometer kind: every digit that changed rolls through the digits in
// between (3 → 4 → 5 → 6 → 7), upwards when the value grew and downwards when it shrank, wrapping
// 9 → 0 like a meter. The strip is blurred while it moves and fades out at the slot's top and bottom
// edges. Unchanged digits stay still. Off with prefers-reduced-motion.
export const roller = { speed: 1 };
const EASE = 'cubic-bezier(0.25, 1, 0.35, 1)';
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

/** the value in "12.5%", "1.2 GB", "฿56,222.83" in comparable form (units matter: 900 MB < 1.1 GB) */
export function magnitude(text) {
  const m = /(-?\d[\d,]*(?:\.\d+)?)\s*(KB|MB|GB|TB|B)?/.exec(text ?? '');
  if (!m) return NaN;
  return Number(m[1].replace(/,/g, '')) * ({ KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[m[2]] ?? 1);
}

function glyph(ch) {
  const s = document.createElement('span');
  s.className = 'roll-glyph';
  s.textContent = ch;
  return s;
}

/** Shows `text` in `host`, rolling the digits that differ from what it showed before. */
export function roll(host, text) {
  const from = host.dataset.value ?? host.textContent;
  if (from === text && host.dataset.value !== undefined) return;
  host.dataset.value = text;
  host.setAttribute('aria-label', text);
  const before = magnitude(from);
  const after = magnitude(text);
  const animate = !reduced.matches && host.isConnected && from !== text && Number.isFinite(before) && Number.isFinite(after) && before !== after;
  host.classList.add('roll');
  host.replaceChildren();
  const a = [...from];
  const b = [...text];
  const offset = b.length - a.length; // right-aligned: units and decimals line up
  const dir = after > before ? 1 : -1;
  const S = roller.speed;
  b.forEach((ch, i) => {
    const slot = document.createElement('span');
    slot.className = 'roll-slot';
    slot.setAttribute('aria-hidden', 'true');
    const final = glyph(ch);
    slot.append(final);
    host.append(slot);
    const old = a[i - offset];
    if (!animate || old === ch) return;
    const delay = (b.length - 1 - i) * 25 * S; // ones first, then tens, …
    if (!/\d/.test(ch)) {
      final.animate([{ opacity: 0, filter: 'blur(3px)' }, { opacity: 1, filter: 'blur(0)' }], { duration: 300 * S, delay, easing: EASE, fill: 'backwards' });
      return;
    }
    // the digits passed on the way, in the direction of the change
    const start = old !== undefined && /\d/.test(old) ? Number(old) : 0;
    const end = Number(ch);
    const path = [start];
    for (let d = start; d !== end; ) path.push((d = (d + dir + 10) % 10));
    const h = slot.getBoundingClientRect().height;
    const strip = document.createElement('span');
    strip.className = 'roll-strip';
    for (const n of dir > 0 ? path : [...path].reverse()) {
      const g = glyph(String(n));
      g.style.height = `${h}px`;
      strip.append(g);
    }
    final.style.visibility = 'hidden';
    slot.classList.add('rolling');
    slot.append(strip);
    const dist = (path.length - 1) * h;
    const duration = Math.min(950, 420 + path.length * 55) * S;
    const move = strip.animate(
      [{ transform: `translateY(${dir > 0 ? 0 : -dist}px)` }, { transform: `translateY(${dir > 0 ? -dist : 0}px)` }],
      { duration, delay, easing: EASE, fill: 'both' },
    );
    strip.animate(
      [{ filter: 'blur(0)' }, { filter: 'blur(2.5px)', offset: 0.3 }, { filter: 'blur(1.5px)', offset: 0.7 }, { filter: 'blur(0)' }],
      { duration, delay, easing: 'linear', fill: 'both' },
    );
    move.onfinish = () => {
      strip.remove();
      final.style.visibility = '';
      slot.classList.remove('rolling');
    };
  });
}
