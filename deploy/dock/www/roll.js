// iOS-style number change: each character that changed rolls on its own, the new one in from below
// and the old one out upwards when the value grew (the other way when it shrank), blurred while it
// moves. Characters that stayed the same do not move. Off with prefers-reduced-motion.
const DURATION = 420;
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
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

/**
 * Shows `text` in `host`, rolling the characters that differ from what it showed before.
 * The current value is kept in host.dataset.value (the DOM holds outgoing glyphs mid-roll).
 */
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
    const blur = 'blur(3px)';
    now.animate(
      [{ transform: `translateY(${dir * 70}%)`, filter: blur, opacity: 0 }, { transform: 'none', filter: 'blur(0)', opacity: 1 }],
      { duration: DURATION, delay, easing: EASE, fill: 'backwards' },
    );
    if (old === undefined || old === ' ') return;
    const out = glyph(old);
    out.classList.add('roll-out');
    slot.append(out);
    out.animate(
      [{ transform: 'none', filter: 'blur(0)', opacity: 1 }, { transform: `translateY(${-dir * 70}%)`, filter: blur, opacity: 0 }],
      { duration: DURATION * 0.8, delay, easing: EASE, fill: 'forwards' },
    ).onfinish = () => out.remove();
  });
}
