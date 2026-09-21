// Pure, deterministic seed data builder. No DB access here — this module
// computes plain-object rows in memory, with every row's id and every
// foreign key already resolved to a deterministic integer, so db/seed.ts
// never has to infer id-to-row linkage from insertion or RETURNING order.
// Because it's pure (only a local file read for customers.csv, no network,
// no DB) it can be run standalone (see `npm run db:seed -- --dry-run`) to
// inspect exactly what a real run would insert, with no DATABASE_URL.

import fs from "node:fs";
import path from "node:path";
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
// deterministic id generator — one counter per table, always started fresh
// so two runs assign identical ids to identical rows in identical order.
// ---------------------------------------------------------------------------

function makeIdGen(): () => number {
  let next = 1;
  return () => next++;
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
// output row shapes — every id and every FK is a resolved integer, ready
// to insert as-is (accounts and holidays keep their natural text/date PK).
// ---------------------------------------------------------------------------

export interface EntityRow {
  id: number;
  name: string;
  domain: string;
}

export interface AccountRow {
  code: string;
  name: string;
}

export interface StreamRow {
  id: number;
  entityId: number;
  name: string;
  billable: boolean;
  customerRule: "required" | "optional" | "none";
  defaultAccount: string | null;
}

export interface CustomerRow {
  id: number;
  entityId: number;
  name: string;
  status: "Active" | "Churned";
}

export interface UserRow {
  id: number;
  name: string;
  entityId: number;
  role: "intern" | "consultant" | "manager" | "admin";
  payType: "hourly" | "salaried";
  function: string;
  managerId: number | null;
  weeklyCap: number;
  dailyCap: number;
  active: boolean;
}

export interface RateRow {
  id: number;
  userId: number;
  hourly: number;
  effectiveFrom: string;
}

export interface HolidayRow {
  date: string;
  name: string;
}

export interface TimeOffRow {
  id: number;
  userId: number;
  date: string;
  label: string;
}

export interface TimesheetRow {
  id: number;
  userId: number;
  entityId: number;
  weekEnding: string;
  streamId: number;
  customerId: number | null;
  notes: string | null;
}

export interface EventRow {
  id: number;
  timesheetId: number;
  type: "created" | "submitted" | "returned" | "approved" | "processed" | "reopened";
  actorId: number;
  at: string;
  payload: Record<string, unknown>;
}

export interface NotificationRow {
  id: number;
  userId: number;
  at: string;
  readAt: string | null;
  text: string;
  target: Record<string, unknown>;
}

export interface ChaseRow {
  id: number;
  at: string;
  byUserId: number;
  targetUserId: number;
}

export interface AdminLogRow {
  id: number;
  at: string;
  actorId: number;
  userId: number;
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

// ---------------------------------------------------------------------------
// static reference data
// ---------------------------------------------------------------------------

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

const ENTITY_DEFS = [
  { key: "corethread", name: "CoreThread", domain: "corethread" },
  { key: "nexcore", name: "NexCore", domain: "nexcore" },
] as const;

const ENTITY_KEY_BY_NAME: Record<string, string> = {
  CoreThread: "corethread",
  NexCore: "nexcore",
};

// Only CoreThread's T&M, Support and Milestone are billable. NexCore's
// four product streams are NOT billable (customer stays optional on them),
// so their expense account always resolves from the person's function.
const STREAM_DEFS = [
  { key: "ct-tm", entityKey: "corethread", name: "T&M", billable: true, customerRule: "required" as const, defaultAccount: "5000" },
  { key: "ct-support", entityKey: "corethread", name: "Support", billable: true, customerRule: "required" as const, defaultAccount: "5020" },
  { key: "ct-milestone", entityKey: "corethread", name: "Milestone", billable: true, customerRule: "required" as const, defaultAccount: "5000" },
  { key: "ct-internal", entityKey: "corethread", name: "Internal", billable: false, customerRule: "none" as const, defaultAccount: null },
  { key: "nc-radariq", entityKey: "nexcore", name: "RadarIQ", billable: false, customerRule: "optional" as const, defaultAccount: null },
  { key: "nc-hiveiq", entityKey: "nexcore", name: "HiveIQ", billable: false, customerRule: "optional" as const, defaultAccount: null },
  { key: "nc-traceiq", entityKey: "nexcore", name: "TraceIQ", billable: false, customerRule: "optional" as const, defaultAccount: null },
  { key: "nc-apertureiq", entityKey: "nexcore", name: "ApertureIQ", billable: false, customerRule: "optional" as const, defaultAccount: null },
  { key: "nc-internal", entityKey: "nexcore", name: "Internal", billable: false, customerRule: "none" as const, defaultAccount: null },
];

// Weeks older than this (in weeksAgo terms) may draw a Churned customer;
// weeks at or inside this threshold only draw Active ones.
const CHURNED_ELIGIBLE_AFTER_WEEKS = 40;

interface CustomerCsvRow {
  entityKey: string;
  name: string;
  status: "Active" | "Churned";
}

function loadCustomersFromCsv(): CustomerCsvRow[] {
  const csvPath = path.join(__dirname, "data", "customers.csv");
  const raw = fs.readFileSync(csvPath, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const [header, ...rows] = lines;
  if (header.trim() !== "entity,name,status") {
    throw new Error(`db/data/customers.csv: unexpected header "${header}"`);
  }
  return rows.map((line) => {
    const [entityName, name, status] = line.split(",");
    const entityKey = ENTITY_KEY_BY_NAME[entityName];
    if (!entityKey) throw new Error(`db/data/customers.csv: unknown entity "${entityName}"`);
    if (status !== "Active" && status !== "Churned") {
      throw new Error(`db/data/customers.csv: unexpected status "${status}" for "${name}"`);
    }
    return { entityKey, name, status };
  });
}

interface RosterUser {
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
  hireWeeksAgo?: number;
  terminationWeeksAgo?: number;
  streamKey?: string;
  rateSchedule?: { weeksAgo: number; hourly: number }[];
}

const ROSTER: RosterUser[] = [
  // CoreThread
  { key: "meera", name: "Meera Brown", entityKey: "corethread", role: "manager", payType: "salaried", function: "Delivery", managerKey: null, weeklyCap: 40, dailyCap: 8, active: true },
  { key: "adam", name: "Adam Walker", entityKey: "corethread", role: "admin", payType: "salaried", function: "G&A", managerKey: null, weeklyCap: 40, dailyCap: 8, active: true },
  {
    key: "bob", name: "Bob Ellis", entityKey: "corethread", role: "intern", payType: "hourly",
    function: "Delivery", managerKey: "meera", weeklyCap: 40, dailyCap: 8, active: true,
    hireWeeksAgo: 11, streamKey: "ct-tm",
    rateSchedule: [{ weeksAgo: 11, hourly: 22.0 }],
  },
  {
    key: "daniel", name: "Daniel Scott", entityKey: "corethread", role: "consultant", payType: "hourly",
    function: "Delivery", managerKey: "meera", weeklyCap: 40, dailyCap: 8, active: true,
    hireWeeksAgo: 103, streamKey: "ct-milestone",
    rateSchedule: [{ weeksAgo: 104, hourly: 68.0 }, { weeksAgo: 58, hourly: 74.0 }, { weeksAgo: 14, hourly: 79.5 }],
  },
  {
    key: "ashley", name: "Ashley Davis", entityKey: "corethread", role: "consultant", payType: "hourly",
    function: "Solutions & Support", managerKey: "meera", weeklyCap: 40, dailyCap: 8, active: true,
    hireWeeksAgo: 73, streamKey: "ct-support",
    rateSchedule: [{ weeksAgo: 73, hourly: 60.0 }, { weeksAgo: 26, hourly: 66.0 }],
  },
  {
    key: "tara", name: "Tara Young", entityKey: "corethread", role: "consultant", payType: "hourly",
    function: "Sales & Marketing", managerKey: "meera", weeklyCap: 24, dailyCap: 6, active: true,
    hireWeeksAgo: 38, streamKey: "ct-internal",
    rateSchedule: [{ weeksAgo: 38, hourly: 48.0 }, { weeksAgo: 12, hourly: 52.0 }],
  },
  {
    key: "nikhil", name: "Nikhil King", entityKey: "corethread", role: "consultant", payType: "hourly",
    function: "Delivery", managerKey: "meera", weeklyCap: 40, dailyCap: 8, active: false,
    hireWeeksAgo: 103, terminationWeeksAgo: 9, streamKey: "ct-tm",
    rateSchedule: [{ weeksAgo: 104, hourly: 62.0 }],
  },
  // NexCore
  { key: "ananya", name: "Ananya Scott", entityKey: "nexcore", role: "manager", payType: "salaried", function: "Product Engineering", managerKey: null, weeklyCap: 40, dailyCap: 8, active: true },
  { key: "kevin", name: "Kevin Anderson", entityKey: "nexcore", role: "admin", payType: "salaried", function: "G&A", managerKey: null, weeklyCap: 40, dailyCap: 8, active: true },
  {
    key: "jason", name: "Jason Walker", entityKey: "nexcore", role: "consultant", payType: "hourly",
    function: "Product Engineering", managerKey: "ananya", weeklyCap: 40, dailyCap: 8, active: true,
    hireWeeksAgo: 103, streamKey: "nc-radariq",
    rateSchedule: [{ weeksAgo: 104, hourly: 70.0 }, { weeksAgo: 49, hourly: 76.0 }, { weeksAgo: 9, hourly: 82.0 }],
  },
  {
    key: "sunita", name: "Sunita Green", entityKey: "nexcore", role: "consultant", payType: "hourly",
    function: "Solutions & Support", managerKey: "ananya", weeklyCap: 40, dailyCap: 8, active: true,
    hireWeeksAgo: 57, streamKey: "nc-hiveiq",
    rateSchedule: [{ weeksAgo: 57, hourly: 55.0 }, { weeksAgo: 18, hourly: 59.5 }],
  },
];

const PAYROLL_ADMIN_BY_ENTITY: Record<string, string> = {
  corethread: "adam",
  nexcore: "kevin",
};

// Deliberate scenarios named in the review. Each names the exact
// (user, weeksAgo) pair it applies to.
const RETURNED_RESUBMITTED = { userKey: "bob", weeksAgo: 3 };
const OVERRIDE_APPROVED = { userKey: "jason", weeksAgo: 6 };
const LATE_SUBMISSION = { userKey: "ashley", weeksAgo: 2 };

const TIME_OFF_PLAN: { userKey: string; weeksAgo: number; dayOffset: number; label: string }[] = [
  { userKey: "daniel", weeksAgo: 33, dayOffset: -3, label: "Vacation" },
  { userKey: "daniel", weeksAgo: 33, dayOffset: -2, label: "Vacation" },
  { userKey: "ashley", weeksAgo: 50, dayOffset: -4, label: "Vacation" },
  { userKey: "jason", weeksAgo: 70, dayOffset: -1, label: "Sick Day" },
  { userKey: "sunita", weeksAgo: 40, dayOffset: -2, label: "Vacation" },
  { userKey: "sunita", weeksAgo: 40, dayOffset: -1, label: "Vacation" },
  { userKey: "tara", weeksAgo: 20, dayOffset: -3, label: "Sick Day" },
];

// ---------------------------------------------------------------------------
// build()
// ---------------------------------------------------------------------------

export function buildSeed(now: Date = new Date()): SeedResult {
  const rng = mulberry32(SEED);
  const anchor = mostRecentFriday(now);
  const notes: string[] = [];

  const nextEntityId = makeIdGen();
  const entities: EntityRow[] = ENTITY_DEFS.map((e) => ({ id: nextEntityId(), name: e.name, domain: e.domain }));
  const entityIdByKey = new Map<string, number>();
  ENTITY_DEFS.forEach((e, i) => entityIdByKey.set(e.key, entities[i].id));

  const nextStreamId = makeIdGen();
  const streams: StreamRow[] = STREAM_DEFS.map((s) => ({
    id: nextStreamId(),
    entityId: entityIdByKey.get(s.entityKey)!,
    name: s.name,
    billable: s.billable,
    customerRule: s.customerRule,
    defaultAccount: s.defaultAccount,
  }));
  const streamByKey = new Map<string, StreamRow>();
  STREAM_DEFS.forEach((s, i) => streamByKey.set(s.key, streams[i]));

  const nextCustomerId = makeIdGen();
  const customerDefs = loadCustomersFromCsv();
  const customers: CustomerRow[] = customerDefs.map((c) => ({
    id: nextCustomerId(),
    entityId: entityIdByKey.get(c.entityKey)!,
    name: c.name,
    status: c.status,
  }));
  const customersByEntity = new Map<string, CustomerRow[]>();
  customerDefs.forEach((c, i) => {
    if (!customersByEntity.has(c.entityKey)) customersByEntity.set(c.entityKey, []);
    customersByEntity.get(c.entityKey)!.push(customers[i]);
  });

  function pickCustomer(rng: () => number, entityKey: string, weeksAgo: number): CustomerRow | null {
    const pool = customersByEntity.get(entityKey) ?? [];
    const eligible = weeksAgo > CHURNED_ELIGIBLE_AFTER_WEEKS ? pool : pool.filter((c) => c.status === "Active");
    if (eligible.length === 0) return null;
    return pick(rng, eligible);
  }

  const nextUserId = makeIdGen();
  const users: UserRow[] = [];
  const userIdByKey = new Map<string, number>();
  for (const u of ROSTER) {
    const id = nextUserId();
    userIdByKey.set(u.key, id);
    users.push({
      id,
      name: u.name,
      entityId: entityIdByKey.get(u.entityKey)!,
      role: u.role,
      payType: u.payType,
      function: u.function,
      managerId: null, // backfilled below, once every user has an id
      weeklyCap: u.weeklyCap,
      dailyCap: u.dailyCap,
      active: u.active,
    });
  }
  users.forEach((u, i) => {
    const managerKey = ROSTER[i].managerKey;
    u.managerId = managerKey ? userIdByKey.get(managerKey)! : null;
  });

  const nextRateId = makeIdGen();
  const rates: RateRow[] = [];
  for (const u of ROSTER) {
    if (!u.rateSchedule) continue;
    for (const r of u.rateSchedule) {
      rates.push({
        id: nextRateId(),
        userId: userIdByKey.get(u.key)!,
        hourly: r.hourly,
        effectiveFrom: addDays(anchor, -7 * r.weeksAgo), // the anchor Friday minus the stated weeks
      });
    }
  }

  function rateAsOf(userKey: string, weekEndingISO: string): RateRow {
    const userId = userIdByKey.get(userKey)!;
    const userRates = rates
      .filter((r) => r.userId === userId && r.effectiveFrom <= weekEndingISO)
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

  const nextTimeOffId = makeIdGen();
  const timeOff: TimeOffRow[] = TIME_OFF_PLAN.map((t) => ({
    id: nextTimeOffId(),
    userId: userIdByKey.get(t.userKey)!,
    date: addDays(addDays(anchor, -7 * t.weeksAgo), t.dayOffset),
    label: t.label,
  }));
  const timeOffByUser = new Map<number, Set<string>>();
  for (const t of timeOff) {
    if (!timeOffByUser.has(t.userId)) timeOffByUser.set(t.userId, new Set());
    timeOffByUser.get(t.userId)!.add(t.date);
  }

  const todayISO = fromUTCDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));

  const nextTimesheetId = makeIdGen();
  const nextEventId = makeIdGen();
  const nextChaseId = makeIdGen();
  const nextAdminLogId = makeIdGen();

  const timesheets: TimesheetRow[] = [];
  const events: EventRow[] = [];
  const chases: ChaseRow[] = [];
  const adminLog: AdminLogRow[] = [];

  // Captured while walking the roster below, used to build the (at most 5)
  // notifications afterwards — each one needs a real timesheet id and a
  // real timestamp from the specific scenario it describes.
  const scenario: {
    bob?: { timesheetId: number; weekEnding: string; returnedAt: string; resubmittedAt: string };
    ashley?: { timesheetId: number; weekEnding: string; submittedAt: string };
    jason?: { timesheetId: number; weekEnding: string; approvedAt: string };
  } = {};

  for (const u of ROSTER) {
    if (u.payType !== "hourly" || u.hireWeeksAgo === undefined || !u.streamKey) continue;

    const homeStream = streamByKey.get(u.streamKey)!;
    const internalStream = streamByKey.get(`${u.entityKey === "corethread" ? "ct" : "nc"}-internal`)!;
    const managerId = userIdByKey.get(u.managerKey!)!;
    const userId = userIdByKey.get(u.key)!;
    const payrollAdminKey = PAYROLL_ADMIN_BY_ENTITY[u.entityKey];
    const payrollAdminId = userIdByKey.get(payrollAdminKey)!;
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
      const useInternal = !isReturned && !isOverride && !isLate && homeStream.id !== internalStream.id && chance(rng, 0.12);
      const stream = useInternal ? internalStream : homeStream;
      let customer: CustomerRow | null = null;
      if (stream.customerRule === "required") {
        customer = pickCustomer(rng, u.entityKey, weeksAgo);
      } else if (stream.customerRule === "optional" && chance(rng, 0.5)) {
        customer = pickCustomer(rng, u.entityKey, weeksAgo);
      }

      // daily hours
      const workDays = [-4, -3, -2, -1, 0].map((off) => addDays(weekEnding, off));
      const dayKeys = ["mon", "tue", "wed", "thu", "fri"] as const;
      const userTimeOff = timeOffByUser.get(userId) ?? new Set<string>();
      const blocked = workDays.map((d) => holidaySet.has(d) || userTimeOff.has(d));

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

      const timesheetId = nextTimesheetId();
      timesheets.push({
        id: timesheetId,
        userId,
        entityId: entityIdByKey.get(u.entityKey)!,
        weekEnding,
        streamId: stream.id,
        customerId: customer?.id ?? null,
        notes: null,
      });

      const createdAt = atTime(weekMonday, 9, 0);
      events.push({ id: nextEventId(), timesheetId, type: "created", actorId: userId, at: createdAt, payload: {} });

      if (bucket === "draft") {
        if (chance(rng, 0.5)) {
          chases.push({
            id: nextChaseId(),
            at: shiftHours(atTime(todayISO, 9, 0), -randInt(rng, 0, 48)),
            byUserId: managerId,
            targetUserId: userId,
          });
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

      events.push({ id: nextEventId(), timesheetId, type: "submitted", actorId: userId, at: submittedAt, payload: submittedPayload });

      if (isLate) {
        scenario.ashley = { timesheetId, weekEnding, submittedAt };
      }

      let lastSubmitAt = submittedAt;

      if (isReturned) {
        const returnedAt = shiftHours(submittedAt, 24);
        events.push({
          id: nextEventId(),
          timesheetId,
          type: "returned",
          actorId: managerId,
          at: returnedAt,
          payload: { reason: "Hours didn't reconcile with the sprint burn-down — please re-check Thursday before resubmitting." },
        });
        const resubmittedAt = shiftHours(returnedAt, 24);
        events.push({
          id: nextEventId(),
          timesheetId,
          type: "submitted",
          actorId: userId,
          at: resubmittedAt,
          payload: { ...submittedPayload, resubmission: true },
        });
        lastSubmitAt = resubmittedAt;
        scenario.bob = { timesheetId, weekEnding, returnedAt, resubmittedAt };
      }

      if (bucket === "submitted") continue;

      // approval
      const approverId = isOverride ? payrollAdminId : managerId;
      const approvedAt = maxDT(shiftHours(lastSubmitAt, 24), atTime(payRun.due, 12, 0));
      const approvedPayload: Record<string, unknown> = { hourly: rate.hourly, rateEffectiveFrom: rate.effectiveFrom };
      if (isOverride) approvedPayload.override = true;
      events.push({ id: nextEventId(), timesheetId, type: "approved", actorId: approverId, at: approvedAt, payload: approvedPayload });

      if (isOverride) {
        adminLog.push({
          id: nextAdminLogId(),
          at: shiftHours(approvedAt, 1),
          actorId: payrollAdminId,
          userId,
          text: `Override-approved week ending ${weekEnding} (manager out of office).`,
        });
        scenario.jason = { timesheetId, weekEnding, approvedAt };
      }

      if (bucket === "approved") continue;

      // processed
      const expenseAccount = stream.billable ? (stream.defaultAccount as string) : FUNCTION_ACCOUNT[u.function];
      const processedAt = maxDT(atTime(payRun.payday, 10, 0), shiftHours(approvedAt, 24));
      events.push({
        id: nextEventId(),
        timesheetId,
        type: "processed",
        actorId: payrollAdminId,
        at: processedAt,
        payload: { expenseAccount, payRun: { payday: payRun.payday, due: payRun.due, cutoff: payRun.cutoff } },
      });
    }

    if (u.terminationWeeksAgo !== undefined) {
      adminLog.push({
        id: nextAdminLogId(),
        at: atTime(addDays(anchor, -7 * u.terminationWeeksAgo + 3), 15, 0),
        actorId: userIdByKey.get(PAYROLL_ADMIN_BY_ENTITY[u.entityKey])!,
        userId: userIdByKey.get(u.key)!,
        text: `Marked ${u.name} inactive (last day of work).`,
      });
    }
  }

  // At most five notifications, each targeting a real timesheet that
  // belongs to the notified user's own entity — one thread per scenario
  // rather than one per event.
  const nextNotificationId = makeIdGen();
  const notifications: NotificationRow[] = [];
  if (scenario.bob) {
    notifications.push({
      id: nextNotificationId(),
      userId: userIdByKey.get("bob")!,
      at: shiftHours(scenario.bob.returnedAt, 1),
      readAt: shiftHours(scenario.bob.returnedAt, 6),
      text: `Your timesheet for week ending ${scenario.bob.weekEnding} was returned.`,
      target: { timesheetId: scenario.bob.timesheetId, weekEnding: scenario.bob.weekEnding },
    });
    notifications.push({
      id: nextNotificationId(),
      userId: userIdByKey.get("meera")!,
      at: shiftHours(scenario.bob.resubmittedAt, 1),
      readAt: shiftHours(scenario.bob.resubmittedAt, 10),
      text: `Bob Ellis resubmitted their timesheet for week ending ${scenario.bob.weekEnding}.`,
      target: { timesheetId: scenario.bob.timesheetId, weekEnding: scenario.bob.weekEnding },
    });
  }
  if (scenario.ashley) {
    notifications.push({
      id: nextNotificationId(),
      userId: userIdByKey.get("meera")!,
      at: shiftHours(scenario.ashley.submittedAt, 1),
      readAt: shiftHours(scenario.ashley.submittedAt, 14),
      text: `Ashley Davis submitted a late timesheet for week ending ${scenario.ashley.weekEnding}.`,
      target: { timesheetId: scenario.ashley.timesheetId, weekEnding: scenario.ashley.weekEnding },
    });
  }
  if (scenario.jason) {
    notifications.push({
      id: nextNotificationId(),
      userId: userIdByKey.get("jason")!,
      at: shiftHours(scenario.jason.approvedAt, 1),
      readAt: shiftHours(scenario.jason.approvedAt, 5),
      text: `Your timesheet for week ending ${scenario.jason.weekEnding} was approved by payroll (your manager was out).`,
      target: { timesheetId: scenario.jason.timesheetId, weekEnding: scenario.jason.weekEnding },
    });
    notifications.push({
      id: nextNotificationId(),
      userId: userIdByKey.get("ananya")!,
      at: shiftHours(scenario.jason.approvedAt, 2),
      readAt: null,
      text: `Jason Walker's week ending ${scenario.jason.weekEnding} was override-approved by payroll while you were out.`,
      target: { timesheetId: scenario.jason.timesheetId, weekEnding: scenario.jason.weekEnding },
    });
  }

  notes.push(
    "Per-person 'home stream' isn't specified by the roster, only function/role — I picked one billable-fitting " +
      "stream per CoreThread hourly person (Bob/Nikhil -> T&M, Daniel -> Milestone, Ashley -> Support, " +
      "Tara -> Internal, matching her Sales & Marketing function) and one product stream for each NexCore " +
      "hourly person (Jason -> RadarIQ, Sunita -> HiveIQ), with a 12% chance per week of logging to Internal " +
      "instead.",
  );
  notes.push(
    "Rates without an explicit 'from N weeks': Bob Ellis's single $22.00 rate is read as effective from his hire " +
      "date (11 weeks ago). Daniel Scott's, Nikhil King's, and Jason Walker's oldest rate is stated as 'from 104' " +
      "weeks — one week before their oldest filed week (they have 104 weeks of history, weeksAgo 0..103) — read " +
      "literally per 'effective from the anchor Friday minus the stated weeks'; it just means the rate was " +
      "already in force before their tenure window starts, which still resolves correctly.",
  );
  notes.push(
    "'Churned customers may appear only on weeks older than 40 weeks' is read as: weeks at or inside 40 weeks " +
      "old draw from Active customers only; weeks older than 40 weeks draw from Active+Churned combined (not " +
      "Churned-only).",
  );
  notes.push(
    "Every id (entities, streams, customers, users, rates, timesheets, events, notifications, chases, " +
      "admin_log) is assigned by a deterministic counter in db/seedData.ts as each row is built, and every " +
      "foreign key is the resolved integer id — db/seed.ts inserts exactly those ids with no RETURNING-based " +
      "linkage.",
  );

  return {
    anchor,
    weeks: WEEKS,
    entities,
    accounts: ACCOUNTS,
    streams,
    customers,
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
    const userId = seed.users.find((row) => row.name === u.name)!.id;
    const userRates = seed.rates
      .filter((r) => r.userId === userId)
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
    const rateStr = userRates.map((r) => `$${r.hourly.toFixed(2)}/hr from ${r.effectiveFrom}`).join(", ");
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
