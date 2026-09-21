// Display formatting. Always UTC — dates are 'YYYY-MM-DD' calendar dates
// and event timestamps carry an explicit offset, so there is never a
// local-timezone ambiguity to introduce.

export function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function formatDateLong(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function formatDateFull(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  return `${date}, ${time} UTC`;
}

export function formatHours(n: number): string {
  return (Number(n) || 0).toFixed(2);
}

export function formatMoney(n: number): string {
  return `$${(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// The one rounding rule money uses anywhere in this app: nearest cent,
// half rounding up. Applied once when an amount is computed (hours x
// rate), and again on any sum of already-rounded amounts (a journal
// total, a grand total), so floating point's inexact binary
// representation of decimals never surfaces as an off-by-a-fraction-of-a-
// cent total.
export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}
