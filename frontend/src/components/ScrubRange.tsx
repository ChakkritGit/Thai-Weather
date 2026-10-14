'use client';

import { useRef } from 'react';

/** Thumb width in px (base.css `.range::-webkit-slider-thumb`): the value maps over the track minus it. */
const THUMB = 20;

/**
 * A range input that also seeks where a finger touches it and follows the finger from there.
 * iOS Safari's native slider only moves when the thumb itself is dragged, so tapping the track (or a
 * thumb pinned at the right edge, like the latest radar frame) did nothing. Mouse and keyboard keep the
 * native behaviour.
 */
export function ScrubRange({
  min = 0,
  max,
  value,
  onChange,
  className = 'range',
  ...aria
}: {
  min?: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
  className?: string;
  'aria-label': string;
  'aria-valuetext'?: string;
}) {
  const last = useRef(value);
  last.current = value;

  const fromX = (el: HTMLElement, x: number) => {
    const r = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (x - r.left - THUMB / 2) / Math.max(1, r.width - THUMB)));
    return Math.round(min + f * (max - min));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLInputElement>) => {
    if (e.pointerType === 'mouse' || max <= min) return;
    const el = e.currentTarget;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const seek = (x: number) => {
      const v = fromX(el, x);
      if (v !== last.current) {
        last.current = v;
        onChange(v);
      }
    };
    seek(e.clientX);
    const move = (ev: PointerEvent) => seek(ev.clientX);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  return (
    <input
      className={className}
      type="range"
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      onPointerDown={onPointerDown}
      {...aria}
    />
  );
}
