// Pure, deterministic seed data builder. No DB access here — this module
// only computes plain-object rows in memory, keyed by string "keys" that
// db/seed.ts resolves to real database ids at insert time. Because it's
// pure it can be run standalone (see `npm run db:seed -- --dry-run`) to
// inspect exactly what a real run would insert, with no DATABASE_URL.

import { addDays, dayOfWeek, fromUTCDate } from "../lib/dateutil";
import { federalHolidaysForYears } from "../lib/holidays";
import { getPayRunForWeekEnding, type PayRun } from "../lib/paycalendar";

// ---------------------------------------------------------------------------
// deterministic PRNG (mulberry32) — fixed seed so two runs are identical.
// ---------------------------------------------------------------------------

const SEED = 88172645;

function mulberry32(seed: number) {
  let a = seed;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, min: number, maxInclusive: number): number {
  return min + Math.floor(rng() * (maxInclusive - min + 1));
}

function randFloat(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

function chance(rng: () => number, p: number): boolean {
  return rng() < p;
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[randInt(rng, 0, arr.length - 1)];
}

// ---------------------------------------------------------------------------
// datetime helpers (ISO date -> ISO datetime strings, UTC)
// ---------------------------------------------------------------------------

function atTime(dateISO: string, hour: number, minute: number): string {
  return `${dateISO}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
}

function shiftHours(dt: string, hours: number): string {
  const d = new Date(dt);
  d.setUTCHours(d.getUTCHours() + hours);
  return d.toISOString();
}

function maxDT(a: string, b: string): string {
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function minDT(a: string, b: string): string {
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
}

function mostRecentFriday(now: Date): string {
  let iso = fromUTCDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
  while (dayOfWeek(iso) !== 5) iso = addDays(iso, -1);
  return iso;
}

// ---------------------------------------------------------------------------
// static reference data
// ---------------------------------------------------------------------------

export interface EntityRow {
  key: string;
  name: string;
  domain: string;
}

export interface AccountRow {
  code: string;
  name: string;
}

export interface StreamRow {
  key: string;
  entityKey: string;
  name: string;
  billable: boolean;
  customerRule: "required" | "optional" | "none";
  defaultAccount: string | null;
}

export interface CustomerRow {
  key: string;
  entityKey: string;
  name: string;
  status: "Active" | "Churned";
}

export interface UserRow {
  key: string;
  name: string;
  entityKey: string;
  role: "intern" | "consultant" | "manager" | "admin";
  payType: "hourly" | "salaried";
  function: string;
  managerKey: string | null;
  weeklyCap: number;
  dailyCap: number;
  active: boolean;
}

export interface RateRow {
  userKey: string;
  hourly: number;
  effectiveFrom: string;
}

export interface HolidayRow {
  date: string;
  name: string;
}

export interface TimeOffRow {
  userKey: string;
  date: string;
  label: string;
}

export interface TimesheetRow {
  key: string;
  userKey: string;
  entityKey: string;
  weekEnding: string;
  streamKey: string;
  customerKey: string | null;
  notes: string | null;
}

export interface EventRow {
  timesheetKey: string;
  type: "created" | "submitted" | "returned" | "approved" | "processed" | "reopened";
  actorKey: string;
  at: string;
  payload: Record<string, unknown>;
}

export interface NotificationRow {
  userKey: string;
  at: string;
  readAt: string | null;
  text: string;
  target: Record<string, unknown>;
}

export interface ChaseRow {
  at: string;
  byUserKey: string;
  targetUserKey: string;
}

export interface AdminLogRow {
  at: string;
  actorKey: string;
  userKey: string;
  text: string;
}

export interface SeedResult {
  anchor: string;
  weeks: number;
  entities: EntityRow[];
  accounts: AccountRow[];
  streams: StreamRow[];
  customers: CustomerRow[];
  users: UserRow[];
  rates: RateRow[];
  holidays: HolidayRow[];
  timeOff: TimeOffRow[];
  timesheets: TimesheetRow[];
  events: EventRow[];
  notifications: NotificationRow[];
  chases: ChaseRow[];
  adminLog: AdminLogRow[];
  notes: string[];
}

const WEEKS = 104;

const ACCOUNTS: AccountRow[] = [
  { code: "5000", name: "COGS — Delivery Labour" },
  { code: "5020", name: "COGS — Support" },
  { code: "6000", name: "S&M — People" },
  { code: "6100", name: "R&D — People" },
  { code: "6200", name: "G&A — People" },
];

const FUNCTION_ACCOUNT: Record<string, string> = {
  Delivery: "5000",
  "Solutions & Support": "5020",
  "Product Engineering": "6100",
  "R&D": "6100",
  "Sales & Marketing": "6000",
  "G&A": "6200",
};

const ENTITIES: EntityRow[] = [
  { key: "corethread", name: "CoreThread", domain: "corethread" },
  { key: "nexcore", name: "NexCore", domain: "nexcore" },
];

const STREAMS: StreamRow[] = [
  { key: "ct-tm", entityKey: "corethread", name: "T&M", billable: true, customerRule: "required", defaultAccount: "5000" },
  { key: "ct-support", entityKey: "corethread", name: "Support", billable: true, customerRule: "required", defaultAccount: "5020" },
  { key: "ct-milestone", entityKey: "corethread", name: "Milestone", billable: true, customerRule: "required", defaultAccount: "5000" },
  { key: "ct-internal", entityKey: "corethread", name: "Internal", billable: false, customerRule: "none", defaultAccount: null },
  { key: "nc-radariq", entityKey: "nexcore", name: "RadarIQ", billable: true, customerRule: "optional", defaultAccount: "5000" },
  { key: "nc-hiveiq", entityKey: "nexcore", name: "HiveIQ", billable: true, customerRule: "optional", defaultAccount: "5000" },
  { key: "nc-traceiq", entityKey: "nexcore", name: "TraceIQ", billable: true, customerRule: "optional", defaultAccount: "5000" },
  { key: "nc-apertureiq", entityKey: "nexcore", name: "ApertureIQ", billable: true, customerRule: "optional", defaultAccount: "5000" },
  { key: "nc-internal", entityKey: "nexcore", name: "Internal", billable: false, customerRule: "none", defaultAccount: null },
];

const CUSTOMERS: CustomerRow[] = [
  { key: "ct-bramwell", entityKey: "corethread", name: "Bramwell & Voss", status: "Active" },
  { key: "ct-harrow", entityKey: "corethread", name: "Harrow Logistics", status: "Active" },
  { key: "ct-quillon", entityKey: "corethread", name: "Quillon Media", status: "Churned" },
  { key: "ct-petrel", entityKey: "corethread", name: "Petrel Systems", status: "Active" },
  { key: "nc-aurica", entityKey: "nexcore", name: "Aurica Health", status: "Active" },
  { key: "nc-fenwick", entityKey: "nexcore", name: "Fenwick Robotics", status: "Active" },
  { key: "nc-solstice", entityKey: "nexcore", name: "Solstice Analytics", status: "Churned" },
];

interface RosterUser extends UserRow {
  hireWeeksAgo?: number;
  terminationWeeksAgo?: number;
  streamKey?: string;
  rateSchedule?: { weeksAgo: number; hourly: number }[];
}

const ROSTER: RosterUser[] = [
  // CoreThread
  { key: "priya", name: "Priya Nakamura", entityKey: "corethread", role: "admin", payType: "salaried", function: "G&A", managerKey: null, weeklyCap: 40, dailyCap: 8, active: true },
  { key: "marcus", name: "Marcus Whitfield", entityKey: "corethread", role: "manager", payType: "salaried", function: "Delivery", managerKey: null, weeklyCap: 40, dailyCap: 8, active: true },
  { key: "elena", name: "Elena Sokolova", entityKey: "corethread", role: "manager", payType: "salaried", function: "Solutions & Support", managerKey: null, weeklyCap: 40, dailyCap: 8, active: true },
  {
    key: "diego", name: "Diego Alvarez", entityKey: "corethread", role: "consultant", payType: "hourly",
    function: "Delivery", managerKey: "marcus", weeklyCap: 40, dailyCap: 8, active: true,
    hireWeeksAgo: 103, streamKey: "ct-tm",
    rateSchedule: [{ weeksAgo: 103, hourly: 52 }, { weeksAgo: 60, hourly: 57 }, { weeksAgo: 20, hourly: 62 }],
  },
  {
    key: "fatima", name: "Fatima Haidari", entityKey: "corethread", role: "consultant", payType: "hourly",
    function: "Delivery", managerKey: "marcus", weeklyCap: 40, dailyCap: 8, active: true,
    hireWeeksAgo: 103, streamKey: "ct-milestone",
    rateSchedule: [{ weeksAgo: 103, hourly: 48 }, { weeksAgo: 45, hourly: 53 }],
  },
  {
    key: "owen", name: "Owen Bright", entityKey: "corethread", role: "intern", payType: "hourly",
    function: "Delivery", managerKey: "marcus", weeklyCap: 20, dailyCap: 6, active: true,
    hireWeeksAgo: 40, streamKey: "ct-tm",
    rateSchedule: [{ weeksAgo: 40, hourly: 24 }],
  },
  {
    key: "grace", name: "Grace Odum", entityKey: "corethread", role: "consultant", payType: "hourly",
    function: "Solutions & Support", managerKey: "elena", weeklyCap: 40, dailyCap: 8, active: true,
    hireWeeksAgo: 103, streamKey: "ct-support",
    rateSchedule: [{ weeksAgo: 103, hourly: 50 }, { weeksAgo: 70, hourly: 54 }, { weeksAgo: 30, hourly: 58 }],
  },
  {
    key: "ravi", name: "Ravi Chandran", entityKey: "corethread", role: "consultant", payType: "hourly",
    function: "Solutions & Support", managerKey: "elena", weeklyCap: 40, dailyCap: 8, active: false,
    hireWeeksAgo: 90, terminationWeeksAgo: 25, streamKey: "ct-support",
    rateSchedule: [{ weeksAgo: 90, hourly: 49 }, { weeksAgo: 50, hourly: 53 }],
  },
  {
    key: "lucia", name: "Lucia Ferraro", entityKey: "corethread", role: "intern", payType: "hourly",
    function: "Delivery", managerKey: "marcus", weeklyCap: 24, dailyCap: 8, active: true,
    hireWeeksAgo: 15, streamKey: "ct-tm",
    rateSchedule: [{ weeksAgo: 15, hourly: 23 }],
  },
  // NexCore
  { key: "samuel", name: "Samuel Okafor", entityKey: "nexcore", role: "admin", payType: "salaried", function: "G&A", managerKey: null, weeklyCap: 40, dailyCap: 8, active: true },
  { key: "ingrid", name: "Ingrid Larsson", entityKey: "nexcore", role: "manager", payType: "salaried", function: "Product Engineering", managerKey: null, weeklyCap: 40, dailyCap: 8, active: true },
  { key: "kenji", name: "Kenji Watanabe", entityKey: "nexcore", role: "manager", payType: "salaried", function: "R&D", managerKey: null, weeklyCap: 40, dailyCap: 8, active: true },
  {
    key: "tobias", name: "Tobias Reinholt", entityKey: "nexcore", role: "consultant", payType: "hourly",
    function: "Product Engineering", managerKey: "ingrid", weeklyCap: 40, dailyCap: 8, active: true,
    hireWeeksAgo: 103, streamKey: "nc-radariq",
    rateSchedule: [{ weeksAgo: 103, hourly: 55 }, { weeksAgo: 65, hourly: 60 }, { weeksAgo: 25, hourly: 66 }],
  },
  {
    key: "naledi", name: "Naledi Mokoena", entityKey: "nexcore", role: "consultant", payType: "hourly",
    function: "Product Engineering", managerKey: "ingrid", weeklyCap: 40, dailyCap: 8, active: true,
    hireWeeksAgo: 103, streamKey: "nc-apertureiq",
    rateSchedule: [{ weeksAgo: 103, hourly: 51 }, { weeksAgo: 48, hourly: 56 }],
  },
  {
    key: "yusuf", name: "Yusuf Demir", entityKey: "nexcore", role: "consultant", payType: "hourly",
    function: "R&D", managerKey: "kenji", weeklyCap: 40, dailyCap: 8, active: true,
    hireWeeksAgo: 103, streamKey: "nc-hiveiq",
    rateSchedule: [{ weeksAgo: 103, hourly: 53 }, { weeksAgo: 55, hourly: 58 }],
  },
  {
    key: "chloe", name: "Chloe Bergman", entityKey: "nexcore", role: "intern", payType: "hourly",
    function: "R&D", managerKey: "kenji", weeklyCap: 25, dailyCap: 8, active: true,
    hireWeeksAgo: 25, streamKey: "nc-traceiq",
    rateSchedule: [{ weeksAgo: 25, hourly: 25 }],
  },
  {
    key: "aditi", name: "Aditi Rao", entityKey: "nexcore", role: "consultant", payType: "hourly",
    function: "Product Engineering", managerKey: "ingrid", weeklyCap: 40, dailyCap: 8, active: true,
    hireWeeksAgo: 70, streamKey: "nc-radariq",
    rateSchedule: [{ weeksAgo: 70, hourly: 54 }, { weeksAgo: 30, hourly: 59 }],
  },
];

const PAYROLL_ADMIN_BY_ENTITY: Record<string, string> = {
  corethread: "priya",
  nexcore: "samuel",
};

// Deliberate scenarios, called out in the repo prompt. Each names the exact
// (user, weeksAgo) pair it applies to.
const RETURNED_RESUBMITTED = { userKey: "grace", weeksAgo: 12 };
const OVERRIDE_APPROVED = { userKey: "tobias", weeksAgo: 8 };
const LATE_SUBMISSION = { userKey: "yusuf", weeksAgo: 6 };

const TIME_OFF_PLAN: { userKey: string; weeksAgo: number; dayOffset: number; label: string }[] = [
  { userKey: "diego", weeksAgo: 33, dayOffset: -3, label: "Vacation" },
  { userKey: "diego", weeksAgo: 33, dayOffset: -2, label: "Vacation" },
  { userKey: "grace", weeksAgo: 18, dayOffset: -4, label: "Vacation" },
  { userKey: "naledi", weeksAgo: 70, dayOffset: -1, label: "Sick Day" },
  { userKey: "yusuf", weeksAgo: 40, dayOffset: -2, label: "Vacation" },
  { userKey: "yusuf", weeksAgo: 40, dayOffset: -1, label: "Vacation" },
  { userKey: "aditi", weeksAgo: 12, dayOffset: -3, label: "Sick Day" },
];

// ---------------------------------------------------------------------------
// build()
// ---------------------------------------------------------------------------

export function buildSeed(now: Date = new Date()): SeedResult {
  const rng = mulberry32(SEED);
  const anchor = mostRecentFriday(now);
  const notes: string[] = [];

  const users: UserRow[] = ROSTER.map((u) => ({
    key: u.key,
    name: u.name,
    entityKey: u.entityKey,
    role: u.role,
    payType: u.payType,
    function: u.function,
    managerKey: u.managerKey,
    weeklyCap: u.weeklyCap,
    dailyCap: u.dailyCap,
    active: u.active,
  }));

  const rates: RateRow[] = [];
  for (const u of ROSTER) {
    if (!u.rateSchedule) continue;
    for (const r of u.rateSchedule) {
      rates.push({
        userKey: u.key,
        hourly: r.hourly,
        effectiveFrom: addDays(anchor, -(7 * r.weeksAgo + 4)), // Monday of that week
      });
    }
  }

  function rateAsOf(userKey: string, weekEndingISO: string): RateRow {
    const userRates = rates
      .filter((r) => r.userKey === userKey && r.effectiveFrom <= weekEndingISO)
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
    const r = userRates[0];
    if (!r) throw new Error(`no rate in force for ${userKey} as of ${weekEndingISO}`);
    return r;
  }

  // Holidays: every year the seed touches, plus two years ahead.
  const oldestWeekEnding = addDays(anchor, -7 * (WEEKS - 1));
  const minYear = Number(oldestWeekEnding.slice(0, 4));
  const maxYear = Number(anchor.slice(0, 4));
  const years: number[] = [];
  for (let y = minYear; y <= maxYear + 2; y++) years.push(y);
  const holidays: HolidayRow[] = federalHolidaysForYears(years).map((h) => ({ date: h.date, name: h.name }));
  const holidaySet = new Set(holidays.map((h) => h.date));

  const timeOff: TimeOffRow[] = TIME_OFF_PLAN.map((t) => ({
    userKey: t.userKey,
    date: addDays(addDays(anchor, -7 * t.weeksAgo), t.dayOffset),
    label: t.label,
  }));
  const timeOffByUser = new Map<string, Set<string>>();
  for (const t of timeOff) {
    if (!timeOffByUser.has(t.userKey)) timeOffByUser.set(t.userKey, new Set());
    timeOffByUser.get(t.userKey)!.add(t.date);
  }

  const todayISO = fromUTCDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));

  const timesheets: TimesheetRow[] = [];
  const events: EventRow[] = [];
  const notifications: NotificationRow[] = [];
  const chases: ChaseRow[] = [];
  const adminLog: AdminLogRow[] = [];

  const streamByKey = new Map(STREAMS.map((s) => [s.key, s]));
  const customersByEntity = new Map<string, CustomerRow[]>();
  for (const c of CUSTOMERS) {
    if (!customersByEntity.has(c.entityKey)) customersByEntity.set(c.entityKey, []);
    customersByEntity.get(c.entityKey)!.push(c);
  }

  for (const u of ROSTER) {
    if (u.payType !== "hourly" || u.hireWeeksAgo === undefined || !u.streamKey) continue;

    const homeStream = streamByKey.get(u.streamKey)!;
    const internalStream = streamByKey.get(`${u.entityKey === "corethread" ? "ct" : "nc"}-internal`)!;
    const entityCustomers = customersByEntity.get(u.entityKey) ?? [];
    const managerKey = u.managerKey!;
    const payrollAdminKey = PAYROLL_ADMIN_BY_ENTITY[u.entityKey];
    const startWeeksAgo = u.terminationWeeksAgo ?? 0;

    for (let weeksAgo = u.hireWeeksAgo; weeksAgo >= startWeeksAgo; weeksAgo--) {
      const weekEnding = addDays(anchor, -7 * weeksAgo);
      const weekMonday = addDays(weekEnding, -4);
      const payRun: PayRun = getPayRunForWeekEnding(weekEnding);
      const rate = rateAsOf(u.key, weekEnding);

      const isReturned = RETURNED_RESUBMITTED.userKey === u.key && RETURNED_RESUBMITTED.weeksAgo === weeksAgo;
      const isOverride = OVERRIDE_APPROVED.userKey === u.key && OVERRIDE_APPROVED.weeksAgo === weeksAgo;
      const isLate = LATE_SUBMISSION.userKey === u.key && LATE_SUBMISSION.weeksAgo === weeksAgo;

      // stream / customer for this week
      const useInternal = !isReturned && !isOverride && !isLate && chance(rng, 0.12);
      const stream = useInternal ? internalStream : homeStream;
      let customerKey: string | null = null;
      if (stream.customerRule === "required" && entityCustomers.length > 0) {
        customerKey = pick(rng, entityCustomers).key;
      } else if (stream.customerRule === "optional" && entityCustomers.length > 0 && chance(rng, 0.5)) {
        customerKey = pick(rng, entityCustomers).key;
      }

      // daily hours
      const workDays = [-4, -3, -2, -1, 0].map((off) => addDays(weekEnding, off));
      const dayKeys = ["mon", "tue", "wed", "thu", "fri"] as const;
      const userTimeOff = timeOffByUser.get(u.key) ?? new Set<string>();
      const blocked = workDays.map((d) => holidaySet.has(d) || userTimeOff.has(d));
      const eligibleCount = blocked.filter((b) => !b).length;

      const rawHours = workDays.map((_, i) => (blocked[i] ? 0 : randFloat(rng, u.dailyCap * 0.6, u.dailyCap)));
      let total = rawHours.reduce((a, b) => a + b, 0);
      if (total > u.weeklyCap && total > 0) {
        const scale = u.weeklyCap / total;
        for (let i = 0; i < rawHours.length; i++) rawHours[i] *= scale;
        total = u.weeklyCap;
      }
      const hours: Record<string, number> = {};
      let roundedTotal = 0;
      dayKeys.forEach((k, i) => {
        const v = Math.round(rawHours[i] * 4) / 4; // nearest quarter hour
        hours[k] = v;
        roundedTotal += v;
      });
      roundedTotal = Math.round(roundedTotal * 100) / 100;

      // status bucket
      let bucket: "draft" | "submitted" | "approved" | "processed";
      if (isReturned || isOverride || isLate) {
        bucket = "processed";
      } else if (todayISO >= payRun.payday) {
        bucket = "processed";
      } else if (todayISO >= payRun.due) {
        bucket = chance(rng, 0.6) ? "approved" : "submitted";
      } else {
        bucket = chance(rng, 0.5) ? "draft" : "submitted";
      }

      const timesheetKey = `${u.key}#${weekEnding}`;
      timesheets.push({
        key: timesheetKey,
        userKey: u.key,
        entityKey: u.entityKey,
        weekEnding,
        streamKey: stream.key,
        customerKey,
        notes: null,
      });

      const createdAt = atTime(weekMonday, 9, 0);
      events.push({ timesheetKey, type: "created", actorKey: u.key, at: createdAt, payload: {} });

      if (bucket === "draft") {
        if (chance(rng, 0.5)) {
          chases.push({ at: shiftHours(atTime(todayISO, 9, 0), -randInt(rng, 0, 48)), byUserKey: managerKey, targetUserKey: u.key });
        }
        continue;
      }

      // submission
      let submittedAt: string;
      if (isLate) {
        submittedAt = atTime(addDays(payRun.due, 1), 11, 0);
      } else {
        const candidate = shiftHours(atTime(weekEnding, 17, 0), randInt(rng, 0, 2) * 24);
        const cappedByDue = minDT(candidate, atTime(payRun.due, 23, 0));
        submittedAt = minDT(cappedByDue, atTime(todayISO, 23, 0));
      }

      const submittedPayload: Record<string, unknown> = {
        hours,
        totalHours: roundedTotal,
        weeklyCap: u.weeklyCap,
        dailyCap: u.dailyCap,
      };
      if (isLate) {
        submittedPayload.late = true;
        submittedPayload.reason = "Out sick most of the week; submitted after catching up on hours.";
      }

      events.push({ timesheetKey, type: "submitted", actorKey: u.key, at: submittedAt, payload: submittedPayload });
      notifications.push({
        userKey: managerKey,
        at: shiftHours(submittedAt, 1),
        readAt: chance(rng, 0.7) ? shiftHours(submittedAt, randInt(rng, 2, 40)) : null,
        text: `${u.name} submitted their timesheet for week ending ${weekEnding}.`,
        target: { timesheetKey, weekEnding },
      });

      let lastSubmitAt = submittedAt;

      if (isReturned) {
        const returnedAt = shiftHours(submittedAt, 24);
        events.push({
          timesheetKey,
          type: "returned",
          actorKey: managerKey,
          at: returnedAt,
          payload: { reason: "Hours didn't reconcile with the sprint burn-down — please re-check Thursday before resubmitting." },
        });
        notifications.push({
          userKey: u.key,
          at: shiftHours(returnedAt, 1),
          readAt: shiftHours(returnedAt, randInt(rng, 2, 20)),
          text: `Your timesheet for week ending ${weekEnding} was returned.`,
          target: { timesheetKey, weekEnding },
        });
        const resubmittedAt = shiftHours(returnedAt, 24);
        events.push({
          timesheetKey,
          type: "submitted",
          actorKey: u.key,
          at: resubmittedAt,
          payload: { ...submittedPayload, resubmission: true },
        });
        lastSubmitAt = resubmittedAt;
      }

      if (bucket === "submitted") continue;

      // approval
      const approverKey = isOverride ? payrollAdminKey : managerKey;
      const approvedAt = maxDT(shiftHours(lastSubmitAt, 24), atTime(payRun.due, 12, 0));
      const approvedPayload: Record<string, unknown> = { hourly: rate.hourly, rateEffectiveFrom: rate.effectiveFrom };
      if (isOverride) approvedPayload.override = true;
      events.push({ timesheetKey, type: "approved", actorKey: approverKey, at: approvedAt, payload: approvedPayload });

      if (isOverride) {
        adminLog.push({
          at: shiftHours(approvedAt, 1),
          actorKey: payrollAdminKey,
          userKey: u.key,
          text: `Override-approved week ending ${weekEnding} (manager out of office).`,
        });
      }

      if (bucket === "approved") continue;

      // processed
      const expenseAccount = stream.billable ? (stream.defaultAccount as string) : FUNCTION_ACCOUNT[u.function];
      const processedAt = maxDT(atTime(payRun.payday, 10, 0), shiftHours(approvedAt, 24));
      events.push({
        timesheetKey,
        type: "processed",
        actorKey: payrollAdminKey,
        at: processedAt,
        payload: { expenseAccount, payRun: { payday: payRun.payday, due: payRun.due, cutoff: payRun.cutoff } },
      });

      void eligibleCount; // computed for clarity/debuggability, not otherwise needed
    }

    if (u.terminationWeeksAgo !== undefined) {
      adminLog.push({
        at: atTime(addDays(anchor, -7 * u.terminationWeeksAgo + 3), 15, 0),
        actorKey: PAYROLL_ADMIN_BY_ENTITY[u.entityKey],
        userKey: u.key,
        text: `Marked ${u.name} inactive (last day of work).`,
      });
    }
  }

  notes.push(
    "NexCore's four product streams (RadarIQ, HiveIQ, TraceIQ, ApertureIQ) are not explicitly marked " +
      "billable in the prompt the way CoreThread's T&M/Support/Milestone are — I treated them as billable " +
      "(customer optional) since they are product-delivery streams, and gave them default_account 5000 " +
      "(COGS — Delivery Labour), same as CoreThread's non-Support billable streams.",
  );
  notes.push(
    "Billable-stream default accounts: Support -> 5020 (COGS — Support, matches the account name); " +
      "T&M, Milestone, and all four NexCore product streams -> 5000 (COGS — Delivery Labour). This is an " +
      "assumption since the prompt names only two COGS accounts for several billable streams.",
  );
  notes.push(
    "'2-3 rate changes for each long-tenured person' was read as 2-3 total rate rows (i.e. hire rate plus 1-2 " +
      "raises), not 2-3 raises after hire. The six full-104-week-tenure people got 2 or 3 rate rows each.",
  );
  notes.push(
    "Caps (weekly_cap/daily_cap) are not effective-dated in the schema, unlike rates. 'the weekly/daily caps in " +
      "force' at submission is read as the user's current cap value at seed time, since there is no cap history " +
      "to snapshot from.",
  );

  return {
    anchor,
    weeks: WEEKS,
    entities: ENTITIES,
    accounts: ACCOUNTS,
    streams: STREAMS,
    customers: CUSTOMERS,
    users,
    rates,
    holidays,
    timeOff,
    timesheets,
    events,
    notifications,
    chases,
    adminLog,
    notes,
  };
}

export function summarize(seed: SeedResult): string {
  const lines: string[] = [];
  lines.push(`anchor (most recent Friday): ${seed.anchor}`);
  lines.push(`weeks of history: ${seed.weeks}`);
  lines.push("");
  lines.push("row counts:");
  const counts: [string, number][] = [
    ["entities", seed.entities.length],
    ["accounts", seed.accounts.length],
    ["streams", seed.streams.length],
    ["customers", seed.customers.length],
    ["users", seed.users.length],
    ["rates", seed.rates.length],
    ["holidays", seed.holidays.length],
    ["time_off", seed.timeOff.length],
    ["timesheets", seed.timesheets.length],
    ["events", seed.events.length],
    ["notifications", seed.notifications.length],
    ["chases", seed.chases.length],
    ["admin_log", seed.adminLog.length],
  ];
  for (const [name, count] of counts) lines.push(`  ${name.padEnd(14)} ${count}`);
  lines.push("");
  lines.push("hourly roster (tenure / rate rows):");
  for (const u of ROSTER) {
    if (u.payType !== "hourly") continue;
    const rates = seed.rates.filter((r) => r.userKey === u.key).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
    const rateStr = rates.map((r) => `$${r.hourly}/hr from ${r.effectiveFrom}`).join(", ");
    const tenure = u.terminationWeeksAgo !== undefined
      ? `hired ${u.hireWeeksAgo}w ago, left ${u.terminationWeeksAgo}w ago (deactivated)`
      : `hired ${u.hireWeeksAgo}w ago, active`;
    lines.push(`  ${u.name} (${u.entityKey}, ${u.role}, ${u.function}) — ${tenure}`);
    lines.push(`      rates: ${rateStr}`);
  }
  lines.push("");
  lines.push("notes:");
  for (const n of seed.notes) lines.push(`  - ${n}`);
  return lines.join("\n");
}

if (require.main === module) {
  const seed = buildSeed(new Date());
  console.log(summarize(seed));
}
