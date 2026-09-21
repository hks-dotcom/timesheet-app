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
//
// Math.round(n * 100) / 100 is NOT reliably round-half-up here: a hard
// half-cent tie is common in this domain (hours are always a multiple of
// 0.25, rates are numeric(8,2) — about a quarter of all (hours, rate)
// pairs land exactly on one), and the intermediate n * 100 can itself
// land a hair below the true .5 in binary (the classic 1.005 -> 1.00
// failure), silently rounding the wrong way. A brute-force scan across
// hours 0..60 (step 0.25) x rates $0.01..$200.00 found 142,519 such
// mismatches out of 1.2M exact ties (11.9%) — see the account in
// lib/format.test.ts. Restricted to the whole-and-half-dollar rates the
// seed currently uses, there were none, which is why this went
// unnoticed: it's a real bug in the general rate range the schema and UI
// both permit, just not the one the seed happens to exercise.
//
// The fix makes the actual round-to-the-cent decision with integer
// arithmetic on decimal digits, not a second float rounding step.
// n.toFixed(6) is exact given n's own bits (per spec, not itself another
// approximation) and gives four digits more precision than this domain's
// true accuracy needs (hours and rates each carry at most 2 true decimal
// digits, so their product has at most 4) — enough margin that the
// ~1e-13-relative noise a float multiplication leaves on an exact
// half-cent value never reaches the digit this reads to decide "round up
// or not". That digit is compared as a character, in integer cents, with
// no further float rounding of any kind.
export function roundMoney(n: number): number {
  const sign = n < 0 ? -1 : 1;
  const abs = Math.abs(n);
  const [wholeStr, fracStrRaw] = abs.toFixed(6).split(".");
  const fracStr = (fracStrRaw ?? "").padEnd(6, "0");
  const centsDigits = fracStr.slice(0, 2);
  const roundUp = fracStr.charCodeAt(2) >= "5".charCodeAt(0);
  const cents = Number(wholeStr) * 100 + Number(centsDigits) + (roundUp ? 1 : 0);
  return (sign * cents) / 100;
}
