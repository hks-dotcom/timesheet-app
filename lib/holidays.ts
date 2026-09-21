// US federal holidays, derived by rule (no table, no DB). Includes the
// standard "observed" shift: a fixed-date holiday that falls on Saturday is
// observed the preceding Friday; one that falls on Sunday is observed the
// following Monday. Floating (nth-weekday) holidays always land on a
// weekday already, so they are never shifted.

import { addDays, dayOfWeek, lastWeekdayOfMonth, nthWeekdayOfMonth } from "./dateutil";

export interface Holiday {
  date: string; // YYYY-MM-DD, observed date
  name: string;
}

function observedFixedDate(year: number, monthIndex0: number, day: number): string {
  const iso = `${year}-${String(monthIndex0 + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const dow = dayOfWeek(iso);
  if (dow === 6) return addDays(iso, -1); // Saturday -> Friday
  if (dow === 0) return addDays(iso, 1); // Sunday -> Monday
  return iso;
}

export function federalHolidaysForYear(year: number): Holiday[] {
  const MON = 1;
  const THU = 4;
  return [
    { date: observedFixedDate(year, 0, 1), name: "New Year's Day" },
    { date: nthWeekdayOfMonth(year, 0, MON, 3), name: "Martin Luther King Jr. Day" },
    { date: nthWeekdayOfMonth(year, 1, MON, 3), name: "Washington's Birthday" },
    { date: lastWeekdayOfMonth(year, 4, MON), name: "Memorial Day" },
    { date: observedFixedDate(year, 5, 19), name: "Juneteenth National Independence Day" },
    { date: observedFixedDate(year, 6, 4), name: "Independence Day" },
    { date: nthWeekdayOfMonth(year, 8, MON, 1), name: "Labor Day" },
    { date: nthWeekdayOfMonth(year, 9, MON, 2), name: "Columbus Day" },
    { date: observedFixedDate(year, 10, 11), name: "Veterans Day" },
    { date: nthWeekdayOfMonth(year, 10, THU, 4), name: "Thanksgiving Day" },
    { date: observedFixedDate(year, 11, 25), name: "Christmas Day" },
  ];
}

export function federalHolidaysForYears(years: number[]): Holiday[] {
  const seen = new Set<number>();
  const result: Holiday[] = [];
  for (const year of years) {
    if (seen.has(year)) continue;
    seen.add(year);
    result.push(...federalHolidaysForYear(year));
  }
  result.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return result;
}

export function federalHolidaySetForYears(years: number[]): Set<string> {
  return new Set(federalHolidaysForYears(years).map((h) => h.date));
}
