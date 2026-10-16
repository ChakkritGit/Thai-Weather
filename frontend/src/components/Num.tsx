'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { roll } from '@/lib/roll';

/**
 * A figure that rolls digit by digit when it changes (iOS style, lib/roll.ts). React renders the
 * first value only; after that roll() owns the content, so React never fights it.
 */
export function Num({ value, className }: { value: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [first] = useState(value);
  useLayoutEffect(() => {
    if (ref.current) roll(ref.current, value);
  }, [value]);
  return (
    <span ref={ref} className={className}>
      {first}
    </span>
  );
}
