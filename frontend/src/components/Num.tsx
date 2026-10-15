'use client';

import { useLayoutEffect, useRef } from 'react';

/**
 * A number that slides in when it changes: up when it grew, down when it shrank (off with reduced
 * motion). Used where values change in place, e.g. scrubbing the timeline.
 */
export function Num({ value, className }: { value: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(value);
  useLayoutEffect(() => {
    const before = parseFloat(prev.current.replace(/,/g, ''));
    const after = parseFloat(value.replace(/,/g, ''));
    prev.current = value;
    const el = ref.current;
    if (!el || !Number.isFinite(before) || !Number.isFinite(after) || before === after) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const dir = after > before ? 1 : -1;
    el.animate(
      [{ transform: `translateY(${dir * 0.35}em)`, opacity: 0.2 }, { transform: 'none', opacity: 1 }],
      { duration: 320, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    );
  }, [value]);
  return (
    <span ref={ref} className={className ? `num ${className}` : 'num'}>
      {value}
    </span>
  );
}
