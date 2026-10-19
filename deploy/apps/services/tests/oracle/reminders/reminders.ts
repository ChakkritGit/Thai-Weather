// Plain TypeScript, no Deno or Node APIs: the Edge Function imports it and
// vitest tests it (supabase/functions/_shared/reminders.test.ts).

export type Due = { name: string; amount: number; due_date: string };

const DAY = 86_400_000;

/** Today's ISO date in Bangkok — the function runs in UTC, where 00:00–07:00 in Bangkok is yesterday. */
export function bangkokToday(now = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Bangkok" }).format(now);
}

export function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

const baht = (n: number) => `฿${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n)}`;

function line(label: string, items: Due[]): string | null {
  if (items.length === 0) return null;
  const shown = items.slice(0, 3).map((e) => `${e.name} ${baht(e.amount)}`).join(", ");
  return `${label}: ${shown}${items.length > 3 ? ` และอีก ${items.length - 3} รายการ` : ""}`;
}

/**
 * One notification per person per morning, not one per bill: overdue first,
 * then due today, then due tomorrow. `entries` are that person's unpaid
 * entries due on or before tomorrow. Null when there is nothing to say.
 */
export function reminderFor(entries: Due[], today: string): { title: string; body: string } | null {
  const tomorrow = addDays(today, 1);
  const byDate = (a: Due, b: Due) => a.due_date.localeCompare(b.due_date);
  const overdue = entries.filter((e) => e.due_date < today).sort(byDate);
  const dueToday = entries.filter((e) => e.due_date === today);
  const dueTomorrow = entries.filter((e) => e.due_date === tomorrow);
  if (overdue.length + dueToday.length + dueTomorrow.length === 0) return null;

  const title = overdue.length
    ? `เกินกำหนด ${overdue.length} รายการ`
    : dueToday.length
      ? `ครบกำหนดวันนี้ ${dueToday.length} รายการ`
      : `พรุ่งนี้ครบกำหนด ${dueTomorrow.length} รายการ`;
  const body = [line("เกินกำหนด", overdue), line("ครบวันนี้", dueToday), line("พรุ่งนี้", dueTomorrow)]
    .filter(Boolean)
    .join("\n");
  return { title, body };
}

export type PlanRow = { id: string; user_id: string; name: string; amount: number; category: string; day_of_month: number; active: boolean };

/**
 * Plan entries to write for a month nobody has opened yet: active plans whose
 * user has no plan entry in it. `month` is 0-based, like the app's. Mirrors
 * `plannedRowsFor` + `dueDateFor` in src/lib (data.ts, month.ts), duplicated
 * because this folder cannot import from src/: keep them in step.
 */
export function missingMonthRows(plans: PlanRow[], usersWithRows: Set<string>, year: number, month: number) {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return plans
    .filter((p) => p.active && !usersWithRows.has(p.user_id))
    .map((p) => ({
      user_id: p.user_id,
      plan_id: p.id,
      name: p.name,
      amount: p.amount,
      category: p.category,
      due_date: `${year}-${pad(month + 1)}-${pad(Math.min(p.day_of_month, last))}`,
      paid_at: null,
    }));
}

/** First day of the month after "YYYY-MM", for a `.lt` bound that is valid in 28- to 31-day months. */
export function nextMonthStart(ym: string): string {
  return new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 1)).toISOString().slice(0, 10);
}
