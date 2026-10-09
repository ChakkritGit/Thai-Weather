'use client';

import { useEffect, useState } from 'react';
import { tokens, type TokenPath } from '../design/generated/tokens';
import { categories, cssGradient, scales } from '../lib/color';
import { useT } from '../i18n';
import { useTheme } from '../lib/theme';
import { Icon } from '../components/Icon';
import { AlertBadge, LevelBadge } from '../components/SeverityBadge';
import { ChartLegend, TimeSeriesChart } from '../components/TimeSeriesChart';

const varName = (p: string) => `--${p.replace(/[._]/g, '-')}`;
const paths = Object.keys(tokens.light) as TokenPath[];

function useResolved(theme: string) {
  const [vals, setVals] = useState<Record<string, string>>({});
  useEffect(() => {
    const cs = getComputedStyle(document.documentElement);
    setVals(Object.fromEntries(paths.map((p) => [p, cs.getPropertyValue(varName(p)).trim()])));
  }, [theme]);
  return vals;
}

const PRINCIPLES = [
  { th: ['ไทยมาก่อน', 'ภาษาไทยเป็นหลัก ระยะบรรทัด ≥ 1.6 รองรับสระ/วรรณยุกต์ซ้อน ใช้ศัพท์ของกรมอุตุฯ'], en: ['Thai first', 'Thai is the primary language; line-height ≥ 1.6 for stacked vowels and tone marks; TMD vocabulary'] },
  { th: ['เตือนภัยมาก่อน', 'สิ่งที่อันตรายต้องเห็นก่อนเสมอ สีระดับเตือนภัยสงวนไว้ใช้เฉพาะเรื่องนี้ และมาพร้อมไอคอน+ข้อความ'], en: ['Warnings first', 'What is dangerous is seen first; severity colours are reserved and always paired with icon + text'] },
  { th: ['บอกความไม่แน่นอนตรงๆ', 'ฝนเขตร้อนบอกเป็นโอกาส (%) และร้อยละของพื้นที่ ไม่แสร้งว่าแม่นยำระดับจุด'], en: ['Honest uncertainty', 'Tropical rain is shown as chance and % of area – never fake point precision'] },
  { th: ['เทียบได้เสมอ', 'ทุกค่ามีค่าโมเดล 22 กม. ให้เทียบ (สีส้ม เส้นประ) ผู้ใช้เห็นว่าระบบเพิ่มอะไร'], en: ['Always comparable', 'Every value can be compared with the 22 km model (orange, dashed)'] },
  { th: ['มือถือและเน็ตช้า', 'แตะได้ ≥ 44px ข้อมูลแผนที่ 1 ไบต์/จุด บีบอัดแล้ว ~80 KB ต่อเฟรม'], en: ['Mobile & low bandwidth', 'Touch targets ≥ 44px; map data 1 byte/cell, ~80 KB per frame gzipped'] },
  { th: ['เข้าถึงได้', 'คอนทราสต์ WCAG AA, สเกลสีแยกได้สำหรับตาบอดสี, มีตารางแทนกราฟ, รองรับคีย์บอร์ด'], en: ['Accessible', 'WCAG AA contrast, CVD-checked series colours, table views, keyboard support'] },
];

export function DesignSystemPage() {
  const { lang, pick } = useT();
  const { theme } = useTheme();
  const th = lang === 'th';
  const vals = useResolved(theme);
  const group = (prefix: string) => paths.filter((p) => p.startsWith(prefix));
  const demoTimes = Array.from({ length: 24 }, (_, i) => new Date(Date.UTC(2026, 9, 9, i)).toISOString());
  const demoFine = demoTimes.map((_, i) => 26 + 6 * Math.sin(((i + 1) / 24) * 2 * Math.PI - 1.2));
  const demoCoarse = demoFine.map((v) => v * 0.9 + 2.5);

  return (
    <div className="page">
      <div className="page-inner">
        <header className="page-head">
          <h1>Design system · ฟ้าละเอียด</h1>
          <p>
            {th
              ? 'โทเคนทั้งหมดอยู่ใน design-system/tokens/*.json (รูปแบบ W3C DTCG) แล้ว build เป็น CSS variables, TypeScript และไฟล์เกณฑ์สภาพอากาศที่ backend ใช้ร่วมกัน — แหล่งความจริงเดียว'
              : 'All tokens live in design-system/tokens/*.json (W3C DTCG) and are built into CSS variables, TypeScript and a weather-scale file the backend shares – one source of truth.'}
          </p>
        </header>

        <Section title={th ? 'หลักการออกแบบ' : 'Principles'}>
          <ol className="pipeline" style={{ margin: 0, padding: 0 }}>
            {PRINCIPLES.map((p) => {
              const [a, b] = th ? p.th : p.en;
              return (
                <li key={a}>
                  <b>{a}</b>
                  <span className="muted">{b}</span>
                </li>
              );
            })}
          </ol>
        </Section>

        <Section title={th ? 'สีเชิงความหมาย (semantic)' : 'Semantic colour'}>
          {['color.bg', 'color.fg', 'color.border', 'color.accent', 'color.severity', 'color.status', 'color.map', 'color.chart'].map((g) => (
            <div key={g} style={{ display: 'grid', gap: 6 }}>
              <h3 className="muted" style={{ fontSize: 'var(--font-size-sm)' }}>
                <code>{g}.*</code>
              </h3>
              <div className="swatch-grid">
                {group(g + '.').map((p) => (
                  <div className="swatch" key={p}>
                    <div className="swatch-color" style={{ background: `var(${varName(p)})` }} />
                    <div className="swatch-meta">
                      <b>{p.slice(g.length + 1)}</b>
                      <code>{varName(p)}</code>
                      <code>{vals[p]}</code>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </Section>

        <Section title={th ? 'สีพื้นฐาน (primitive)' : 'Primitive ramps'}>
          {['monsoon', 'cloud', 'rice', 'mango', 'papaya', 'chili', 'orchid'].map((name) => {
            const steps = group(`color.${name}.`);
            return (
              <div key={name} style={{ display: 'grid', gap: 4 }}>
                <b style={{ fontSize: 'var(--font-size-sm)' }}>{name}</b>
                <div className="ramp">
                  {steps.map((p, i) => (
                    <div key={p} style={{ background: `var(${varName(p)})`, color: i < steps.length / 2 ? '#0f1318' : '#fff' }}>
                      {p.split('.').pop()}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </Section>

        <Section title={th ? 'ตัวอักษร' : 'Typography'}>
          {(['display', 'h1', 'h2', 'h3', 'body', 'bodySm', 'caption', 'data'] as const).map((k) => (
            <div className="token-row" key={k}>
              <code>.text-{k}</code>
              <span className={`text-${k}`}>{k === 'display' || k === 'data' ? '32.4° · 87%' : 'ฝนฟ้าคะนองร้อยละ 40 ของพื้นที่ ยอดดอยหนาว'}</span>
            </div>
          ))}
          <p className="muted" style={{ fontSize: 'var(--font-size-sm)' }}>
            IBM Plex Sans Thai (UI) · IBM Plex Sans Thai Looped (display) · IBM Plex Mono (tabular data)
          </p>
        </Section>

        <Section title={th ? 'ระยะห่าง มุมโค้ง เงา' : 'Space, radius, elevation'}>
          <div className="two-col">
            <div>
              {group('space.').map((p) => (
                <div className="token-row" key={p} style={{ gridTemplateColumns: '90px 1fr' }}>
                  <code>{p}</code>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: `var(${varName(p)})`, height: 10, background: 'var(--color-accent-default)', borderRadius: 2 }} />
                    <code>{vals[p]}</code>
                  </span>
                </div>
              ))}
            </div>
            <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {group('radius.').map((p) => (
                  <div key={p} style={{ width: 64, height: 64, background: 'var(--color-bg-subtle)', border: '1px solid var(--color-border-default)', borderRadius: `var(${varName(p)})`, display: 'grid', placeItems: 'center', fontSize: 11 }}>
                    {p.split('.').pop()}
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {group('shadow.').map((p) => (
                  <div key={p} className="card" style={{ width: 96, height: 64, boxShadow: `var(${varName(p)})`, display: 'grid', placeItems: 'center', fontSize: 12 }}>
                    {p}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Section>

        <Section title={th ? 'สเกลสีสภาพอากาศ' : 'Weather colour scales'}>
          {Object.entries(scales).map(([id, s]) => (
            <div key={id} style={{ display: 'grid', gap: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-size-sm)' }}>
                <b>{id}</b>
                <span className="muted">
                  {s.mode} · {s.unit}
                </span>
              </div>
              {s.mode === 'stepped' ? (
                <div className="ramp">
                  {s.stops.map((st) => (
                    <div key={st.value} style={{ background: st.color }}>
                      ≥{st.value}
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  <div className="legend-bar" style={{ height: 18, background: cssGradient(s, s.stops[0].value, s.stops[s.stops.length - 1].value) }} />
                  <div className="num muted" style={{ fontSize: 10, display: 'flex', justifyContent: 'space-between' }}>
                    {s.stops.map((st) => (
                      <span key={st.value}>{st.value}</span>
                    ))}
                  </div>
                </>
              )}
            </div>
          ))}
        </Section>

        <Section title={th ? 'เกณฑ์เชิงหมวดหมู่ (ใช้ร่วมกับ backend)' : 'Categorical thresholds (shared with backend)'}>
          <div className="two-col">
            {Object.entries(categories).map(([id, c]) => (
              <div key={id} style={{ display: 'grid', gap: 4, fontSize: 'var(--font-size-sm)' }}>
                <b>
                  {id} <span className="muted" style={{ fontWeight: 400 }}>· {c.source}</span>
                </b>
                {c.levels.map((l) => (
                  <span key={l.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <LevelBadge severity={l.severity} label={pick(l)} />
                    <span className="num muted">
                      {l.min !== undefined ? `≥ ${l.min}` : `≤ ${l.max}`} {c.unit}
                    </span>
                  </span>
                ))}
              </div>
            ))}
          </div>
        </Section>

        <Section title={th ? 'คอมโพเนนต์' : 'Components'}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn btn--primary" type="button">
              <Icon name="map" /> Primary
            </button>
            <button className="btn" type="button">
              Secondary
            </button>
            <button className="btn btn--ghost" type="button">
              Ghost
            </button>
            <button className="btn" type="button" aria-pressed="true">
              <Icon name="split" /> Toggled
            </button>
            <button className="chip" type="button" aria-pressed="true">
              <Icon name="drop" /> Chip on
            </button>
            <button className="chip" type="button">
              <Icon name="thermo" /> Chip
            </button>
            <div className="segmented" role="group">
              <button type="button" aria-pressed="true">
                วันนี้
              </button>
              <button type="button">พรุ่งนี้</button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <AlertBadge alert={{ hazard: 'heat', level: 'danger', severity: 2, value: 43, label_th: 'อันตราย', label_en: 'Danger' }} showValue />
            <AlertBadge alert={{ hazard: 'rain', level: 'veryHeavy', severity: 2, value: 112, label_th: 'ฝนหนักมาก', label_en: 'Very heavy rain' }} showValue />
            <AlertBadge alert={{ hazard: 'storm', level: 'likely', severity: 1, value: 60, label_th: 'มีพายุฝนฟ้าคะนอง', label_en: 'Thunderstorms likely' }} />
            <AlertBadge alert={{ hazard: 'rain', level: 'extreme', severity: 3, value: 180, label_th: 'เสี่ยงน้ำท่วมฉับพลัน', label_en: 'Flash-flood risk' }} />
            <span className="badge badge--demo">DEMO</span>
            <span className="badge badge--info">2 กม.</span>
          </div>
          <div className="two-col">
            <div className="now-grid">
              <div className="stat">
                <span className="stat-label">{th ? 'โอกาสฝน' : 'Chance of rain'}</span>
                <span className="stat-value">
                  40 <small>%</small>
                </span>
                <span className="stat-sub">{th ? 'โมเดล 22 กม. ฝนตก' : '22 km model: rain'}</span>
              </div>
              <div className="stat">
                <span className="stat-label">{th ? 'ดัชนีความร้อน' : 'Heat index'}</span>
                <span className="stat-value">43°</span>
                <span className="stat-sub">
                  <LevelBadge severity={2} label={th ? 'อันตราย' : 'Danger'} />
                </span>
              </div>
            </div>
            <div className="card card-pad" style={{ display: 'grid', gap: 6 }}>
              <ChartLegend fine={th ? 'ฟ้าละเอียด 2 กม.' : 'Downscaled 2 km'} coarse={th ? 'โมเดล 22 กม.' : '22 km model'} />
              <TimeSeriesChart
                title="demo"
                times={demoTimes}
                unit="°C"
                series={[
                  { key: 'f', label: '2 km', values: demoFine, kind: 'line', tone: 'fine' },
                  { key: 'c', label: '22 km', values: demoCoarse, kind: 'line', tone: 'coarse' },
                ]}
              />
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card card-pad" style={{ display: 'grid', gap: 16 }}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
