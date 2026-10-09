'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import '@/design/push.css';
import { api } from '../lib/api';
import { DEFAULT_PREFS, quietLabel, roundCoord, type PushPrefs } from '../lib/push';
import { usePush, type PushError } from '../lib/usePush';
import { useT } from '../i18n';
import type { DictKey } from '../i18n/dict';

const ERRORS: Record<PushError, DictKey> = {
  denied: 'pushErrDenied',
  outside: 'pushErrOutside',
  full: 'pushErrFull',
  rate: 'pushErrRate',
  gone: 'pushErrGone',
  failed: 'pushErrFailed',
};

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

function Bell() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9Zm4 9.5a2 2 0 0 0 4 0" />
    </svg>
  );
}

/**
 * "Alert me when a storm / heavy rain / cyclone is about to reach this spot" – Web Push opt-in.
 * One subscription per device: it is tied to one saved location, which can be moved here.
 */
export function PushControl({ lat, lon }: { lat: number; lon: number }) {
  const { t, lang, pick } = useT();
  const push = usePush();
  const { stored, support, busy, error } = push;
  const uid = useId();

  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [prefs, setPrefs] = useState<PushPrefs>(DEFAULT_PREFS);
  const [note, setNote] = useState<string | null>(null);

  const here = !!stored && Math.abs(stored.lat - roundCoord(lat)) < 0.015 && Math.abs(stored.lon - roundCoord(lon)) < 0.015;

  const openForm = () => {
    setNote(null);
    setPrefs(stored?.prefs ?? DEFAULT_PREFS);
    setLabel(here ? (stored?.label ?? '') : '');
    setOpen(true);
  };

  // pre-fill the place name with the province once the form is open (best effort)
  useEffect(() => {
    if (!open || label) return;
    let cancelled = false;
    api
      .point(lat, lon)
      .then((d) => {
        const name = d.location.province ? pick(d.location.province) : '';
        if (!cancelled && name) setLabel((cur) => cur || name);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lat, lon]);

  if (support === 'checking' || support === 'unsupported') return null;

  if (support === 'ios-install') {
    return (
      <div className="push-box">
        <p className="push-title">
          <Bell /> {t('pushIos')}
        </p>
        <p className="push-note">{t('pushIosHow')}</p>
      </div>
    );
  }
  if (support === 'denied') {
    return (
      <div className="push-box">
        <p className="push-title">
          <Bell /> {t('pushTitle')}
        </p>
        <p className="push-note">{t('pushDenied')}</p>
      </div>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const quietOn = prefs.quiet_start !== prefs.quiet_end;
    const clean: PushPrefs = quietOn ? prefs : { ...prefs, quiet_start: 0, quiet_end: 0 };
    if (await push.save(roundCoord(lat), roundCoord(lon), label.trim(), clean)) {
      setOpen(false);
      setNote(null);
    }
  };

  const test = async () => {
    setNote(null);
    if (await push.sendTest()) setNote(t('pushTestSent'));
  };

  const errorText = error ? t(ERRORS[error]) : null;
  const msg = errorText ? (
    <p className="push-msg" data-kind="error" role="alert">
      {errorText}
    </p>
  ) : note ? (
    <p className="push-msg" data-kind="ok" role="status">
      {note}
    </p>
  ) : null;

  if (!open && !stored) {
    return (
      <div className="push-box">
        <div className="push-head">
          <p className="push-title">
            <Bell /> {t('pushTitle')}
          </p>
          <button type="button" className="btn btn--primary" onClick={openForm}>
            {t('pushEnable')}
          </button>
        </div>
        {msg}
        <p className="push-note">{t('pushPrivacy')}</p>
      </div>
    );
  }

  if (!open && stored) {
    return (
      <div className="push-box">
        <p className="push-title">
          <Bell /> {here ? t('pushOn') : t('pushElsewhere')}
          {stored.label ? ` · ${stored.label}` : ''}
        </p>
        <div className="push-actions">
          <button type="button" className="btn" onClick={openForm} disabled={busy}>
            {here ? t('pushUpdate') : t('pushMove')}
          </button>
          <button type="button" className="btn" onClick={test} disabled={busy}>
            {t('pushTest')}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void push.remove()} disabled={busy}>
            {t('pushCancel')}
          </button>
        </div>
        {msg}
        <p className="push-note">{t('pushPrivacy')}</p>
      </div>
    );
  }

  const quietOn = prefs.quiet_start !== prefs.quiet_end;
  const set = (p: Partial<PushPrefs>) => setPrefs((cur) => ({ ...cur, ...p }));
  const nothing = !prefs.storm && !prefs.heavy_rain && !prefs.cyclone;

  return (
    <form className="push-box push-form" onSubmit={submit}>
      <p className="push-title">
        <Bell /> {t('pushTitle')}
      </p>
      <label className="push-field" htmlFor={`${uid}-label`}>
        <span>{t('pushLabel')}</span>
        <input
          id={`${uid}-label`}
          className="push-input"
          value={label}
          maxLength={60}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={lang === 'th' ? 'เช่น บ้าน, ที่ทำงาน' : 'e.g. Home, Work'}
        />
      </label>
      <fieldset className="push-toggles">
        <label className="push-check">
          <input type="checkbox" checked={prefs.storm} onChange={(e) => set({ storm: e.target.checked })} /> {t('pushStorm')}
        </label>
        <label className="push-check">
          <input type="checkbox" checked={prefs.heavy_rain} onChange={(e) => set({ heavy_rain: e.target.checked })} /> {t('pushHeavy')}
        </label>
        <label className="push-check">
          <input type="checkbox" checked={prefs.cyclone} onChange={(e) => set({ cyclone: e.target.checked })} /> {t('pushCyclone')}
        </label>
      </fieldset>
      <div className="push-field">
        <label className="push-check">
          <input
            type="checkbox"
            checked={quietOn}
            onChange={(e) => set(e.target.checked ? { quiet_start: 22, quiet_end: 6 } : { quiet_start: 0, quiet_end: 0 })}
          />{' '}
          {t('pushQuiet')}
          {quietOn && <span className="subtle"> ({quietLabel(prefs)})</span>}
        </label>
        {quietOn && (
          <div className="push-quiet">
            <span className="push-legend">{t('pushQuietFrom')}</span>
            <select
              className="push-select"
              aria-label={t('pushQuietFrom')}
              value={prefs.quiet_start}
              onChange={(e) => set({ quiet_start: Number(e.target.value) })}
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {hh(h)}
                </option>
              ))}
            </select>
            <span className="push-legend">{t('pushQuietTo')}</span>
            <select
              className="push-select"
              aria-label={t('pushQuietTo')}
              value={prefs.quiet_end}
              onChange={(e) => set({ quiet_end: Number(e.target.value) })}
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {hh(h)}
                </option>
              ))}
            </select>
          </div>
        )}
        {quietOn && <p className="push-note">{t('pushQuietNote')}</p>}
      </div>
      <div className="push-actions">
        <button type="submit" className="btn btn--primary" disabled={busy || nothing}>
          {here ? t('pushUpdate') : t('pushSave')}
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => setOpen(false)} disabled={busy}>
          {t('close')}
        </button>
      </div>
      {msg}
      <p className="push-note">{t('pushPrivacy')}</p>
    </form>
  );
}
