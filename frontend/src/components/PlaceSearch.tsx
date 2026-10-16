'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { api, type Place } from '../lib/api';
import { useT } from '../i18n';
import { Icon } from './Icon';

/** A keyboard-accessible combobox; requests are debounced and old results never replace a new query. */
export function PlaceSearch({ onSelect }: { onSelect: (place: Place) => void }) {
  const { lang } = useT();
  const th = lang === 'th';
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [answer, setAnswer] = useState<{ query: string; places: Place[]; error: boolean } | null>(null);
  const q = query.trim();
  const ready = answer?.query === q;
  const places = ready ? answer.places : [];
  const loading = q.length >= 2 && !ready;
  const label = th ? 'ค้นหาเมือง อำเภอ หรือจังหวัด' : 'Search cities, districts or provinces';

  useEffect(() => {
    const el = popup.current;
    if (!open || !el) return;
    // iOS shrinks the visual viewport for its keyboard, but leaves dvh and the map unchanged.
    const viewport = window.visualViewport;
    const stage = el.closest('.map-stage');
    let frame = 0;
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight);
        const limit = Math.min(bottom, stage?.getBoundingClientRect().bottom ?? bottom);
        const gap = parseFloat(getComputedStyle(el).marginTop) || 0;
        el.style.setProperty('--place-search-space', `${Math.max(0, limit - el.getBoundingClientRect().top - gap)}px`);
      });
    };
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update);
    return () => {
      window.cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update);
    };
  }, [open]);

  useEffect(() => {
    if (!open || q.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.places(q, controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) setAnswer({ query: q, places: data.places, error: false });
        })
        .catch(() => {
          if (!controller.signal.aborted) setAnswer({ query: q, places: [], error: true });
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [q, open]);

  const select = (place: Place) => {
    setQuery(th ? place.name_th || place.name_en : place.name_en);
    setOpen(false);
    setActive(-1);
    input.current?.blur(); // dismiss the iPhone keyboard before the map flies to the point
    onSelect(place);
  };

  return (
    <div className="place-search" role="search" aria-label={label}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
      <form className="place-search-field glass" onSubmit={(e) => {
        e.preventDefault();
        if (open && places.length) select(places[active >= 0 ? active : 0]);
      }}>
        <Icon name="search" />
        <input ref={input} type="search" role="combobox" aria-label={label} placeholder={label}
          aria-autocomplete="list" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined}
          aria-activedescendant={open && places[active] ? `${id}-${places[active].id}` : undefined}
          autoComplete="off" spellCheck={false} enterKeyHint="go" maxLength={80} value={query}
          onFocus={() => { setOpen(true); setActive(-1); }}
          onChange={(e) => { setQuery(e.target.value); setActive(-1); setOpen(true); }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Escape') { e.preventDefault(); setOpen(false); setActive(-1); }
            else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setOpen(true);
              if (places.length) {
                const next = e.key === 'ArrowDown' ? (active + 1) % places.length : (active <= 0 ? places.length - 1 : active - 1);
                setActive(next);
                document.getElementById(`${id}-${places[next].id}`)?.scrollIntoView({ block: 'nearest' });
              }
            }
          }} />
        {query && <button type="button" className="place-search-clear" aria-label={th ? 'ล้างคำค้น' : 'Clear search'}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { setQuery(''); setActive(-1); setOpen(true); input.current?.focus(); }}><Icon name="close" /></button>}
      </form>
      {open && <div ref={popup} className="place-search-popup glass">
        <ul id={`${id}-list`} role="listbox" aria-label={th ? 'ผลการค้นหาสถานที่' : 'Place search results'} aria-busy={loading}>
          {places.map((place, index) => {
            const name = th ? place.name_th || place.name_en : place.name_en;
            const kind = th ? { province: 'จังหวัด', district: 'อำเภอ/เขต', place: 'เมือง/หมู่บ้าน' }[place.kind]
              : { province: 'Province', district: 'District', place: 'City/village' }[place.kind];
            const context = th ? [place.district_th || place.district_en, place.province_th || place.province_en]
              : [place.district_en, place.province_en];
            return <li key={place.id} id={`${id}-${place.id}`} role="option" aria-selected={index === active}
              onMouseDown={(e) => e.preventDefault()} onClick={() => select(place)}>
              <strong>{name}</strong>
              <small>{[kind, ...context.filter((n) => n && n !== name)].join(' · ')}</small>
            </li>;
          })}
        </ul>
        <p className="place-search-status" role="status">
          {q.length < 2 ? (th ? 'พิมพ์อย่างน้อย 2 ตัวอักษร · ไทยหรืออังกฤษ' : 'Type at least 2 characters · Thai or English')
            : loading ? (th ? 'กำลังค้นหา…' : 'Searching…')
              : answer?.error ? (th ? 'ค้นหาไม่ได้ ลองเปลี่ยนคำค้นหรือเชื่อมต่ออีกครั้ง' : 'Search unavailable. Edit your search or reconnect.')
                : places.length === 0 ? (th ? 'ไม่พบสถานที่ ลองชื่ออื่น' : 'No places found. Try another name.')
                  : (th ? `${places.length} ผลลัพธ์` : `${places.length} results`)}
        </p>
        <p className="place-search-credit">{th ? 'ข้อมูลสถานที่: ' : 'Places: '}<a href="https://www.geonames.org/" target="_blank" rel="noreferrer">GeoNames</a> · CC BY 4.0</p>
      </div>}
    </div>
  );
}
