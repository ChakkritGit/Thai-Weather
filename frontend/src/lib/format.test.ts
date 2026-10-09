import { afterEach, describe, expect, it, vi } from 'vitest';
import { fmtDateTime, fmtDay, fmtHour, fmtStep } from './format';

afterEach(() => vi.restoreAllMocks());

describe('shared Bangkok date formatting', () => {
  it('renders the confirmed alerts quiet-line text deterministically', () => {
    const dates = ['2026-10-09', '2026-10-10', '2026-10-11'];
    expect(dates.map((date) => fmtDay(date, 'en')).join(' · ')).toBe('Fri 9 Oct · Sat 10 Oct · Sun 11 Oct');
    expect(dates.map((date) => fmtDay(date, 'th')).join(' · ')).toBe('ศ. 9 ต.ค. · ส. 10 ต.ค. · อา. 11 ต.ค.');
    expect(fmtDay(dates[0], 'en', true)).toBe('Friday 9 Oct');
    expect(fmtDay(dates[0], 'th', true)).toBe('วันศุกร์ที่ 9 ต.ค.');
  });

  it('keeps the existing readable date/time separators and clock format', () => {
    const iso = '2026-10-09T06:24:00Z';
    expect(fmtStep(iso, 'en')).toBe('Fri 9 Oct, 13:24');
    expect(fmtStep(iso, 'th')).toBe('ศ. 9 ต.ค. 13:24');
    expect(fmtDateTime(iso, 'en')).toBe('9 Oct 2026, 13:24');
    expect(fmtDateTime(iso, 'th')).toBe('9 ต.ค. 2569 13:24');
    expect(fmtHour(iso, 'en')).toBe('13:24');
    expect(fmtHour(iso, 'th')).toBe('13:24');
  });

  it('uses Bangkok midnight and the correct calendar year across UTC day/year boundaries', () => {
    const midnight = '2026-10-08T17:00:00Z';
    expect(fmtHour(midnight, 'en')).toBe('00:00');
    expect(fmtStep(midnight, 'en')).toBe('Fri 9 Oct, 00:00');
    expect(fmtStep('2026-10-09T18:05:00Z', 'th')).toBe('ส. 10 ต.ค. 01:05');
    expect(fmtDateTime('2026-12-31T17:05:00Z', 'en')).toBe('1 Jan 2027, 00:05');
    expect(fmtDateTime('2026-12-31T17:05:00Z', 'th')).toBe('1 ม.ค. 2570 00:05');
  });

  it('keeps the weekday/date aligned through leap-day and month rollover', () => {
    expect(fmtDay('2024-02-29', 'en', true)).toBe('Thursday 29 Feb');
    expect(fmtDay('2024-02-29', 'th', true)).toBe('วันพฤหัสบดีที่ 29 ก.พ.');
    expect(fmtStep('2024-02-29T16:59:00Z', 'th')).toBe('พฤ. 29 ก.พ. 23:59');
    expect(fmtStep('2024-02-29T17:00:00Z', 'en')).toBe('Fri 1 Mar, 00:00');
  });

  it('ignores divergent ICU literals and Thai weekday strings while preserving numeric date parts', () => {
    const originalParts = Intl.DateTimeFormat.prototype.formatToParts;
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    const render = () => (['th', 'en'] as const).flatMap((lang) => [
      fmtDay('2026-10-09', lang), fmtDay('2026-10-09', lang, true),
      fmtStep('2026-10-09T06:24:00Z', lang), fmtDateTime('2026-10-09T06:24:00Z', lang),
      fmtHour('2026-10-09T06:24:00Z', lang),
    ]);
    const expected = render();
    for (const variant of [{ literal: ' ', weekday: 'ศุกร์' }, { literal: ', ', weekday: 'ศ.' }, { literal: '\u202f/\u202f', weekday: 'Fri' }]) {
      spy.mockImplementation(function (this: Intl.DateTimeFormat, date) {
        const numericParts = originalParts.call(this, date).map((part) =>
          part.type === 'literal' ? { ...part, value: variant.literal } : part,
        );
        // Runtime locale names are deliberately irrelevant to our shared labels.
        return [{ type: 'weekday', value: variant.weekday }, ...numericParts];
      });
      expect(render()).toEqual(expected);
    }
  });
});
