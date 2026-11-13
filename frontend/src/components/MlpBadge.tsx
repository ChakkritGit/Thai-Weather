import type { MlpState } from '../lib/mlpRuns';

const LABEL: Record<MlpState, { th: string; en: string }> = {
  on: { th: 'ใช้งานอยู่', en: 'In use' },
  off: { th: 'ยังไม่ใช้งาน', en: 'Not in use' },
  wait: { th: 'รอข้อมูล', en: 'Waiting for data' },
};

/** Status pill of an MLP: the words carry the meaning, the colour and the marker shape only back them up. */
export function MlpBadge({ state, th }: { state: MlpState; th: boolean }) {
  return <span className={`badge mlp-badge mlp-badge--${state}`}>{th ? LABEL[state].th : LABEL[state].en}</span>;
}
