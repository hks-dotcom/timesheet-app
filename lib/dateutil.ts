// Date helpers. All dates are represented as 'YYYY-MM-DD' strings and treated
// as UTC calendar dates, so arithmetic is never affected by local timezone.

export function toUTCDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function fromUTCDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(iso: string, days: number): string {
  const date = toUTCDate(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return fromUTCDate(date);
}

// 0 = Sunday, 6 = Saturday
export function dayOfWeek(iso: string): number {
  return toUTCDate(iso).getUTCDay();
}

export function isWeekend(iso: string): boolean {
  const dow = dayOfWeek(iso);
  return dow === 0 || dow === 6;
}

export function compareISO(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function lastDayOfMonth(year: number, monthIndex0: number): string {
  // Day 0 of the next month is the last day of this month.
  const date = new Date(Date.UTC(year, monthIndex0 + 1, 0));
  return fromUTCDate(date);
}

// nth (1-based) occurrence of `weekday` (0=Sun..6=Sat) in the given month.
export function nthWeekdayOfMonth(
  year: number,
  monthIndex0: number,
  weekday: number,
  n: number,
): string {
  const first = new Date(Date.UTC(year, monthIndex0, 1));
  const firstWeekday = first.getUTCDay();
  const offset = (weekday - firstWeekday + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return fromUTCDate(new Date(Date.UTC(year, monthIndex0, day)));
}

// last occurrence of `weekday` (0=Sun..6=Sat) in the given month.
export function lastWeekdayOfMonth(
  year: number,
  monthIndex0: number,
  weekday: number,
): string {
  const last = toUTCDate(lastDayOfMonth(year, monthIndex0));
  const lastWeekday = last.getUTCDay();
  const offset = (lastWeekday - weekday + 7) % 7;
  return addDays(fromUTCDate(last), -offset);
}
