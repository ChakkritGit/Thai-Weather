/**
 * Two fixes for the app installed on a phone (the same in every app):
 * - the status bar takes the colour of whatever is at the top of the screen right now (a blue PIN
 *   screen, the splash, the dark theme), so iOS never fades a mismatched theme-color into the page;
 * - iOS zooms into a field whose text is under 16px: on touch screens such a field gets 16px as it
 *   is touched, before the zoom decision. Pinch-zoom is untouched.
 */
export function installPwaChrome(): () => void {
  const opaque = (c: string) => !!c && c !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(c);
  const topColor = () => {
    let el = document.elementFromPoint(window.innerWidth / 2, 1);
    while (el) {
      const c = getComputedStyle(el).backgroundColor;
      if (opaque(c)) return c;
      el = el.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  };
  const sync = () => {
    const c = topColor();
    let metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name=\'theme-color\']')];
    if (!metas.length) {
      const m = document.createElement('meta');
      m.name = 'theme-color';
      document.head.append(m);
      metas = [m];
    }
    for (const m of metas) if (m.content !== c) m.content = c;
  };
  let timer = 0;
  const schedule = () => {
    if (!timer) timer = window.setTimeout(() => { timer = 0; sync(); }, 120);
  };
  sync();
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'data-theme', 'hidden', 'open'] });
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, { passive: true });
  dark.addEventListener('change', schedule);

  const FIELD = 'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]), textarea, select';
  const lift = (e: Event) => {
    const el = e.target as HTMLElement | null;
    if (el?.matches?.(FIELD) && parseFloat(getComputedStyle(el).fontSize) < 16) el.style.fontSize = '16px';
  };
  const touch = window.matchMedia('(pointer: coarse)').matches;
  if (touch) {
    window.addEventListener('touchstart', lift, { capture: true, passive: true });
    window.addEventListener('focusin', lift, true);
  }

  // a bottom-nav icon squishes and springs back when pressed (links marked data-tab-bounce)
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const bounce = (e: PointerEvent) => {
    const tab = (e.target as HTMLElement | null)?.closest?.('[data-tab-bounce]');
    const glyph = tab?.querySelector('svg');
    if (!glyph || reduced.matches) return;
    glyph.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(0.75)', offset: 0.25 }, { transform: 'scale(1.12)', offset: 0.6 }, { transform: 'scale(1)' }],
      { duration: 450, easing: 'ease-out' },
    );
  };
  window.addEventListener('pointerdown', bounce, { passive: true });

  return () => {
    window.removeEventListener('pointerdown', bounce);
    observer.disconnect();
    window.clearTimeout(timer);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('scroll', schedule);
    dark.removeEventListener('change', schedule);
    if (touch) {
      window.removeEventListener('touchstart', lift, true);
      window.removeEventListener('focusin', lift, true);
    }
  };
}
