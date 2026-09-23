// Pure, deterministic seed data builder. No DB access here — this module
// computes plain-object rows in memory, with every row's id and every
// foreign key already resolved to a deterministic integer, so db/seed.ts
// never has to infer id-to-row linkage from insertion or RETURNING order.
// Because it's pure (only a local file read for customers.csv, no network,
// no DB) it can be run standalone (see `npm run db:seed -- --dry-run`) to
// inspect exactly what a real run would insert, with no DATABASE_URL.

import fs from "node:fs";
import path from "node:path";
import { ACCOUNTS, resolveExpenseAccount, type AccountRow } from "../lib/accounts";
import { addDays, fromUTCDate, mostRecentFriday } from "../lib/dateutil";
import { rateAsOf as domainRateAsOf, windowOf, type RateRow as DomainRateRow } from "../lib/domain";
import { roundMoney } from "../lib/format";
import { federalHolidaysForYears } from "../lib/holidays";
import {
  businessDayBefore,
  calendarSlotForWeek,
  getMostRecentPastPayRun,
  getUpcomingPayRuns,
  payRunForApproval,
  type PayRun,
} from "../lib/paycalendar";
import { payRunRef } from "../lib/payrun";

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
  // Milliseconds, not setUTCHours: that truncates a fractional hour.
  return new Date(new Date(dt).getTime() + hours * 3_600_000).toISOString();
}

function maxDT(a: string, b: string): string {
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function minDT(a: string, b: string): string {
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
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
  // Caps are NOT here any more — they live in cap_terms, so a
  // cap can never be in force without the contract that agreed it.
  active: boolean;
}

export interface RateRow {
  id: number;
  userId: number;
  hourly: number;
  effectiveFrom: string;
  contractRef: string;
  contractSignedOn: string;
}

export interface SeedCapTermRow {
  id: number;
  userId: number;
  weeklyCap: number;
  dailyCap: number;
  contractRef: string;
  contractSignedOn: string;
  recordedBy: number;
}

export interface ContractTermRow {
  id: number;
  userId: number;
  endDate: string;
  contractRef: string;
  contractSignedOn: string;
  recordedBy: number;
  kind: "set" | "extend" | "shorten";
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
  contractTerms: ContractTermRow[];
  capTerms: SeedCapTermRow[];
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
  // process.cwd(), not __dirname: this file is bundled by Next.js/Turbopack
  // when imported from app code, and a bundled __dirname resolves to a
  // virtual path with no filesystem backing. cwd is the project root both
  // under `tsx` (db:seed) and under `next dev`/`next start`.
  const csvPath = path.join(process.cwd(), "db", "data", "customers.csv");
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
  rateSchedule?: { weeksAgo: number; hourly: number; contractRef: string }[];
  // Contract end date — every hourly person gets one. Two deliberate
  // scenarios: Nikhil's already ended (matches his termination), Bob's
  // (the newest hire) ends within the next 3 weeks. Everyone else is
  // comfortably active.
  contractEndInWeeks?: number; // weeks from the anchor; negative = already past
  endDateContractRef?: string;
}

const ROSTER: RosterUser[] = [
  // CoreThread
  { key: "meera", name: "Meera Brown", entityKey: "corethread", role: "manager", payType: "salaried", function: "Delivery", managerKey: null, weeklyCap: 40, dailyCap: 8, active: true },
  { key: "adam", name: "Adam Walker", entityKey: "corethread", role: "admin", payType: "salaried", function: "G&A", managerKey: null, weeklyCap: 40, dailyCap: 8, active: true },
  {
    key: "bob", name: "Bob Ellis", entityKey: "corethread", role: "intern", payType: "hourly",
    function: "Delivery", managerKey: "meera", weeklyCap: 40, dailyCap: 8, active: true,
    hireWeeksAgo: 11, streamKey: "ct-tm",
    rateSchedule: [{ weeksAgo: 11, hourly: 22.0, contractRef: "CTR-2026-0301" }],
    contractEndInWeeks: 2, endDateContractRef: "CTR-2026-0301",
  },
  {
    key: "daniel", name: "Daniel Scott", entityKey: "corethread", role: "consultant", payType: "hourly",
    function: "Delivery", managerKey: "meera", weeklyCap: 40, dailyCap: 8, active: true,
    hireWeeksAgo: 103, streamKey: "ct-milestone",
    rateSchedule: [
      { weeksAgo: 104, hourly: 68.0, contractRef: "CTR-2024-0091" },
      { weeksAgo: 58, hourly: 74.0, contractRef: "CTR-2025-0114" },
      { weeksAgo: 14, hourly: 79.5, contractRef: "CTR-2026-0208" },
    ],
    contractEndInWeeks: 52, endDateContractRef: "CTR-2026-0208",
  },
  {
    key: "ashley", name: "Ashley Davis", entityKey: "corethread", role: "consultant", payType: "hourly",
    function: "Solutions & Support", managerKey: "meera", weeklyCap: 40, dailyCap: 8, active: true,
    hireWeeksAgo: 73, streamKey: "ct-support",
    rateSchedule: [
      { weeksAgo: 73, hourly: 60.0, contractRef: "CTR-2025-0033" },
      { weeksAgo: 26, hourly: 66.0, contractRef: "CTR-2026-0140" },
    ],
    contractEndInWeeks: 52, endDateContractRef: "CTR-2026-0140",
  },
  {
    key: "tara", name: "Tara Young", entityKey: "corethread", role: "consultant", payType: "hourly",
    function: "Sales & Marketing", managerKey: "meera", weeklyCap: 24, dailyCap: 6, active: true,
    hireWeeksAgo: 38, streamKey: "ct-internal",
    rateSchedule: [
      { weeksAgo: 38, hourly: 48.0, contractRef: "CTR-2025-0180" },
      { weeksAgo: 12, hourly: 52.0, contractRef: "CTR-2026-0233" },
    ],
    contractEndInWeeks: 40, endDateContractRef: "CTR-2026-0233",
  },
  {
    key: "nikhil", name: "Nikhil King", entityKey: "corethread", role: "consultant", payType: "hourly",
    function: "Delivery", managerKey: "meera", weeklyCap: 40, dailyCap: 8, active: false,
    hireWeeksAgo: 103, terminationWeeksAgo: 9, streamKey: "ct-tm",
    rateSchedule: [{ weeksAgo: 104, hourly: 62.0, contractRef: "CTR-2024-0090" }],
    contractEndInWeeks: -9, endDateContractRef: "CTR-2024-0090",
  },
  // NexCore
  { key: "ananya", name: "Ananya Scott", entityKey: "nexcore", role: "manager", payType: "salaried", function: "Product Engineering", managerKey: null, weeklyCap: 40, dailyCap: 8, active: true },
  { key: "kevin", name: "Kevin Anderson", entityKey: "nexcore", role: "admin", payType: "salaried", function: "G&A", managerKey: null, weeklyCap: 40, dailyCap: 8, active: true },
  {
    key: "jason", name: "Jason Walker", entityKey: "nexcore", role: "consultant", payType: "hourly",
    function: "Product Engineering", managerKey: "ananya", weeklyCap: 40, dailyCap: 8, active: true,
    hireWeeksAgo: 103, streamKey: "nc-radariq",
    rateSchedule: [
      { weeksAgo: 104, hourly: 70.0, contractRef: "CTR-2024-0092" },
      { weeksAgo: 49, hourly: 76.0, contractRef: "CTR-2025-0126" },
      { weeksAgo: 9, hourly: 82.0, contractRef: "CTR-2026-0271" },
    ],
    contractEndInWeeks: 52, endDateContractRef: "CTR-2026-0271",
  },
  {
    key: "sunita", name: "Sunita Green", entityKey: "nexcore", role: "consultant", payType: "hourly",
    function: "Solutions & Support", managerKey: "ananya", weeklyCap: 40, dailyCap: 8, active: true,
    hireWeeksAgo: 57, streamKey: "nc-hiveiq",
    rateSchedule: [
      { weeksAgo: 57, hourly: 55.0, contractRef: "CTR-2025-0037" },
      { weeksAgo: 18, hourly: 59.5, contractRef: "CTR-2026-0219" },
    ],
    // Ends 3 weeks out: NexCore's "contract ending soon" case, the
    // counterpart to Bob Ellis's in CoreThread, so the admin dashboard
    // tile and the Users end-date column have something in each entity.
    contractEndInWeeks: 3, endDateContractRef: "CTR-2026-0219",
  },
];

// One processed week per entity whose expense account the admin chose
// by hand instead of taking the resolver's default — so the "Account
// override" pill in Reports is visible from a fresh reset. Identified by
// person and by how many weeks before the anchor the week ends, so the
// same week is picked on every rebuild.
const ACCOUNT_OVERRIDE: { userKey: string; weeksAgo: number; account: string; reason: string }[] = [
  {
    userKey: "daniel",
    weeksAgo: 6,
    account: "6200",
    reason: "Internal tooling week, booked to G&A at the finance lead's request.",
  },
  // Not Jason's week 6 — that is the deliberate SoD case, left exactly as it was.
  {
    userKey: "sunita",
    weeksAgo: 6,
    account: "6200",
    reason: "Company onboarding week; not chargeable to the product line.",
  },
];

// ---------------------------------------------------------------------
// A note on dates, checked on every pass: there is not one hardcoded
// calendar date anywhere in this file. Every date is derived from the
// anchor (the most recent Friday when the seed runs) plus an offset in
// weeks or days, so a reset six months from now produces the same
// showcase relative to that day. The only four-digit numbers that look
// like years are inside contract reference strings such as
// "CTR-2026-0301", which are opaque identifiers, not dates, and the
// holiday range, which is computed from the anchor's own year.
//
// Anything added here that a visitor is meant to see immediately —
// unread notifications, the account-override rows, contracts ending
// soon, overdue staff — must follow the same rule, or it stops being
// visible the moment the anchor moves past it.
// ---------------------------------------------------------------------

const PAYROLL_ADMIN_BY_ENTITY: Record<string, string> = {
  corethread: "adam",
  nexcore: "kevin",
};

// ---------------------------------------------------------------------
// Scenarios. Each is a (person, weeks-before-the-anchor) pair with a
// fixed story; everything else follows the calendar. Some are fixed
// weeks, some are derived from today, and they are placed in priority
// order so a derived one never lands on a week another already owns —
// which of the last few weeks is past its cutoff, or belongs to the run
// that just paid, moves with the anchor, so collisions are resolved per
// reset, not assumed away.
// ---------------------------------------------------------------------

type Scenario =
  | "sod" // payroll override-approved AND processed it: the segregation-of-duties case
  | "trail" // submitted, returned, resubmitted, approved, processed: guided entry "One timesheet, every step"
  | "lateStraggler" // submitted after its cutoff (flagged, with a reason), approved after its run's due date
  | "approvedLate" // submitted on time, approved after its run's due date
  | "returnedOpen" // returned and not yet resubmitted: waiting on the contributor
  | "overdue" // still a draft past its cutoff: the Tracker's Overdue pill
  | "forceSubmitted" // submitted, waiting on the manager
  | "forceDraft"; // this week, not started

// Fixed weeks. Old enough that their run has always paid, so each is
// always processed. One "trail" week per ENTITY: the guided entry
// resolves within whichever entity the visitor picked.
const FIXED_SCENARIOS: { userKey: string; weeksAgo: number; scenario: Scenario }[] = [
  { userKey: "jason", weeksAgo: 6, scenario: "sod" },
  { userKey: "ashley", weeksAgo: 20, scenario: "trail" },
  { userKey: "sunita", weeksAgo: 20, scenario: "trail" },
];

// The stragglers: the last week of the run that has just paid, approved
// the day after that run's due date. The approval rule puts each into
// the NEXT run, so the ready batch always has something in it the day
// after a payday, and shows the rule doing its job: Ashley Davis's was
// also filed late, Daniel Scott's and Sunita Green's were filed on time
// and approved late.
const STRAGGLERS: { userKey: string; scenario: Scenario }[] = [
  { userKey: "ashley", scenario: "lateStraggler" },
  { userKey: "daniel", scenario: "approvedLate" },
  { userKey: "sunita", scenario: "approvedLate" },
];

// The gate's contributor in each entity (Bob Ellis, Jason Walker) has a
// week sent back to them last week, and the week after it untouched or
// overdue; someone else in each entity has this week submitted and
// waiting on the manager.
const RETURNED_OPEN = [
  { userKey: "bob", weeksAgo: 1 },
  { userKey: "jason", weeksAgo: 1 },
];
const FORCE_SUBMITTED = [
  { userKey: "tara", weeksAgo: 0 },
  { userKey: "jason", weeksAgo: 0 },
  { userKey: "sunita", weeksAgo: 0 }, // skipped on the days her straggler week is this week
];
const FORCE_DRAFT = [{ userKey: "bob", weeksAgo: 0 }];

// One person per entity left with a week the Tracker calls Overdue, so
// the Tracker's Overdue pill and the admin dashboard's "Staff overdue"
// tile both show something from a fresh reset. Overdue means a week
// inside the four-week window that is missing or still a draft and
// already past its own cutoff — windowOf().state no longer "open" — so
// this picks the NEWEST such week not already taken, using the very same
// windowOf the Tracker uses. A fallback person per entity: on a Friday
// just after a run's cutoff, the only past-cutoff week in someone's
// window can be the one their straggler scenario already owns.
const OVERDUE_STAFF: string[][] = [
  ["ashley", "tara"],
  ["jason", "sunita"],
];

function planScenarios(anchorFriday: string, todayISO: string, lastPaid: PayRun): Map<string, Map<number, Scenario>> {
  const plan = new Map<string, Map<number, Scenario>>();
  const place = (userKey: string, weeksAgo: number, scenario: Scenario) => {
    const mine = plan.get(userKey) ?? new Map<number, Scenario>();
    const taken = mine.get(weeksAgo);
    if (taken) throw new Error(`seed: ${userKey} week ${weeksAgo} is both ${taken} and ${scenario}`);
    mine.set(weeksAgo, scenario);
    plan.set(userKey, mine);
  };
  const isTaken = (userKey: string, weeksAgo: number) =>
    plan.get(userKey)?.has(weeksAgo) === true || ACCOUNT_OVERRIDE.some((o) => o.userKey === userKey && o.weeksAgo === weeksAgo);

  for (const f of FIXED_SCENARIOS) place(f.userKey, f.weeksAgo, f.scenario);

  // The last paid run's own last week: the one whose Friday IS that run's
  // cutoff. Always on or before the anchor (the cutoff is a Friday before
  // a payday that has passed).
  const stragglerWeeksAgo = Math.round((Date.parse(anchorFriday) - Date.parse(lastPaid.cutoff)) / (7 * 86_400_000));
  for (const s of STRAGGLERS) place(s.userKey, stragglerWeeksAgo, s.scenario);

  for (const r of RETURNED_OPEN) place(r.userKey, r.weeksAgo, "returnedOpen");
  for (const f of FORCE_SUBMITTED) if (!isTaken(f.userKey, f.weeksAgo)) place(f.userKey, f.weeksAgo, "forceSubmitted");
  for (const f of FORCE_DRAFT) if (!isTaken(f.userKey, f.weeksAgo)) place(f.userKey, f.weeksAgo, "forceDraft");

  for (const candidates of OVERDUE_STAFF) {
    let placed = false;
    for (const userKey of candidates) {
      for (let w = 1; w <= 3 && !placed; w++) {
        if (isTaken(userKey, w)) continue;
        const state = windowOf(addDays(anchorFriday, -7 * w), todayISO).state;
        if (state === "late" || state === "locked") {
          place(userKey, w, "overdue");
          placed = true;
        }
      }
      if (placed) break;
    }
  }
  return plan;
}

// When an entity's admin handed a run off to payroll. Confirming a batch
// in Mark processed produces the file payroll keys the run from, so the
// handoff comes BEFORE the run: on the last working day before the run's
// due date (payday − 2) — never a weekend or a federal holiday, never on
// or after payday — in the afternoon, NexCore an hour after CoreThread.
// Not two working days before: for about four runs in ten that falls
// before the cutoff Friday, i.e. before the run's last week is even
// filed. One batch per entity per run; the batch reference is derived
// from this moment exactly as markProcessedBatchCore derives it from the
// clock (BP- plus base-36 milliseconds).
function seedProcessedAt(entityKey: string, run: PayRun): string {
  return atTime(businessDayBefore(run.due), entityKey === "corethread" ? 15 : 16, 0);
}

function seedBatchRef(processedAt: string): string {
  return `BP-${Date.parse(processedAt).toString(36).toUpperCase()}`;
}

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
      const effectiveFrom = addDays(anchor, -7 * r.weeksAgo); // the anchor Friday minus the stated weeks
      rates.push({
        id: nextRateId(),
        userId: userIdByKey.get(u.key)!,
        hourly: r.hourly,
        effectiveFrom,
        contractRef: r.contractRef,
        contractSignedOn: addDays(effectiveFrom, -5), // signed a few days before it takes effect
      });
    }
  }

  // Contract end dates — one 'set' row per hourly person, recorded by
  // their entity's payroll admin at hire time.
  const nextContractTermId = makeIdGen();
  const contractTerms: ContractTermRow[] = [];
  for (const u of ROSTER) {
    if (u.contractEndInWeeks === undefined || !u.endDateContractRef) continue;
    const endDate = addDays(anchor, 7 * u.contractEndInWeeks);
    contractTerms.push({
      id: nextContractTermId(),
      userId: userIdByKey.get(u.key)!,
      endDate,
      contractRef: u.endDateContractRef,
      contractSignedOn: addDays(anchor, -7 * (u.hireWeeksAgo ?? 0)),
      recordedBy: userIdByKey.get(PAYROLL_ADMIN_BY_ENTITY[u.entityKey])!,
      kind: "set",
    });
  }

  // Caps traced to contracts — one initial cap_terms row per
  // hourly person, recorded by their entity's payroll admin at hire
  // time, citing the same contract their earliest rate row cites so the
  // paperwork is consistent. Anchor-relative like everything else.
  const nextCapTermId = makeIdGen();
  const capTerms: SeedCapTermRow[] = [];
  for (const u of ROSTER) {
    if (u.payType !== "hourly" || !u.rateSchedule?.length) continue;
    const firstRate = u.rateSchedule.reduce((a, b) => (a.weeksAgo >= b.weeksAgo ? a : b));
    capTerms.push({
      id: nextCapTermId(),
      userId: userIdByKey.get(u.key)!,
      weeklyCap: u.weeklyCap,
      dailyCap: u.dailyCap,
      contractRef: firstRate.contractRef,
      contractSignedOn: addDays(anchor, -7 * firstRate.weeksAgo - 5),
      recordedBy: userIdByKey.get(PAYROLL_ADMIN_BY_ENTITY[u.entityKey])!,
    });
  }

  // Delegates the actual lookup to lib/domain.ts's real rateAsOf (the
  // "one shared function") instead of re-sorting/re-filtering here —
  // recordedAt ties never arise in the seed's own rate schedule, so
  // effectiveFrom stands in for it.
  function rateAsOf(userKey: string, weekEndingISO: string): DomainRateRow {
    const userId = userIdByKey.get(userKey)!;
    const userRates: DomainRateRow[] = rates
      .filter((r) => r.userId === userId)
      .map((r) => ({ hourly: r.hourly, effectiveFrom: r.effectiveFrom, contractRef: r.contractRef, recordedAt: r.effectiveFrom }));
    const found = domainRateAsOf(userRates, weekEndingISO);
    if (!found) throw new Error(`no rate in force for ${userKey} as of ${weekEndingISO}`);
    return found;
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
  const yesterdayISO = addDays(todayISO, -1);
  // Nothing in the seed happens today: every timestamp is on or before
  // yesterday, so no reset, at any hour, can write an event dated after
  // the moment it runs. buildSeed asserts this over every table at the
  // end rather than trusting each formula below.
  const latestAt = atTime(yesterdayISO, 21, 0);

  // The two runs everything hangs off, both derived from today:
  //   lastPaid — the latest run whose payday is already behind us. Every
  //     week held in it or earlier has been processed.
  //   nextRun  — the first run whose payday is today or later: what the
  //     payroll admin processes next. Weeks held in it are approved and
  //     waiting — the ready batch.
  const lastPaid = getMostRecentPastPayRun(yesterdayISO);
  const nextRun = getUpcomingPayRuns(todayISO, 1)[0];
  const scenarioPlan = planScenarios(anchor, todayISO, lastPaid);

  const nextTimesheetId = makeIdGen();
  const nextEventId = makeIdGen();
  const nextChaseId = makeIdGen();
  const nextAdminLogId = makeIdGen();

  const timesheets: TimesheetRow[] = [];
  const events: EventRow[] = [];
  const chases: ChaseRow[] = [];
  const adminLog: AdminLogRow[] = [];

  // Captured while walking the roster below, used to build the
  // notifications afterwards — each one needs a real timesheet id and a
  // real timestamp from the specific scenario it describes.
  interface ShowcaseWeek {
    timesheetId: number;
    weekEnding: string;
    userId: number;
    userName: string;
    managerId: number;
    payrollAdminId: number;
    at: string;
  }
  const scenario: {
    returned: (ShowcaseWeek & { entityKey: string })[];
    ashleyLate?: { timesheetId: number; weekEnding: string; submittedAt: string };
    jason?: { timesheetId: number; weekEnding: string; approvedAt: string };
  } = { returned: [] };

  // One still-submitted and one approved-and-ready week per entity, so the
  // showcase notifications below point at a real event of the right kind
  // for each role: the manager hears about something actually waiting on
  // them, the payroll admin about something actually ready to process,
  // the contributor about their own week. Nothing is invented.
  const showcase: Record<string, { submitted?: ShowcaseWeek; approved?: ShowcaseWeek }> = {};

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
      // The week's calendar slot: its cutoff decides on time vs late.
      // Which run it is PAID in is decided below, at approval.
      const slot: PayRun = calendarSlotForWeek(weekEnding);
      const rate = rateAsOf(u.key, weekEnding);
      const plan = scenarioPlan.get(u.key)?.get(weeksAgo) ?? null;

      // stream / customer for this week
      const useInternal = plan === null && homeStream.id !== internalStream.id && chance(rng, 0.12);
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
      const rawTotal = rawHours.reduce((a, b) => a + b, 0);
      if (rawTotal > u.weeklyCap && rawTotal > 0) {
        // A nicer starting point, not the enforcement itself: scaling here
        // operates on unrounded values, so it can still leave individual
        // days sitting right at the boundary before rounding.
        const scale = u.weeklyCap / rawTotal;
        for (let i = 0; i < rawHours.length; i++) rawHours[i] *= scale;
      }

      // Round each day to the nearest quarter hour, clamped to the daily
      // cap. Rounding alone can push a day up by as much as 0.125h, and
      // summed across 5 independently-rounded days that can push the
      // weekly total back over the cap even when every pre-rounding value
      // was comfortably under it (Tara Young's weekly cap of 24 equals
      // dailyCap(6) * 5 * 0.8 exactly, the average unrounded total, so she
      // hit this every time rounding rounded up more days than it rounded
      // down). So after rounding we deterministically trim any remaining
      // excess back off, 0.25h at a time, from whichever day currently
      // holds the most hours — the actual enforcement step.
      const hours: Record<string, number> = {};
      dayKeys.forEach((k, i) => {
        const rounded = Math.round(rawHours[i] * 4) / 4;
        hours[k] = Math.min(rounded, u.dailyCap);
      });

      let roundedTotal = Math.round(dayKeys.reduce((sum, k) => sum + hours[k], 0) * 100) / 100;
      while (roundedTotal > u.weeklyCap) {
        let maxKey: (typeof dayKeys)[number] | null = null;
        for (const k of dayKeys) {
          if (hours[k] <= 0) continue;
          if (maxKey === null || hours[k] > hours[maxKey]) maxKey = k;
        }
        if (maxKey === null) break; // every day is already at 0; nothing left to trim
        hours[maxKey] = Math.round((hours[maxKey] - 0.25) * 100) / 100;
        roundedTotal = Math.round((roundedTotal - 0.25) * 100) / 100;
      }

      // How far this week goes. A week held in a run that has already
      // paid is processed; one held in the next run is approved and
      // waiting; the rest is submitted or still a draft. Scenarios decide
      // for themselves; everything else follows from its calendar slot.
      let target: "draft" | "submitted" | "approved";
      if (plan === "overdue" || plan === "forceDraft") target = "draft";
      else if (plan === "forceSubmitted") target = "submitted";
      else if (plan === "returnedOpen") target = "draft"; // submitted, then returned — see below
      else if (plan !== null) target = "approved";
      else if (slot.payday < todayISO) target = "approved";
      else if (slot.payday === nextRun.payday) {
        if (todayISO > slot.due) target = chance(rng, 0.8) ? "approved" : "submitted";
        else if (weeksAgo === 0 && chance(rng, 0.35)) target = "draft";
        else target = chance(rng, 0.5) ? "approved" : "submitted";
      } else {
        target = chance(rng, 0.4) ? "draft" : "submitted";
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

      if (target === "draft" && plan !== "returnedOpen") {
        if (chance(rng, 0.5)) {
          chases.push({
            id: nextChaseId(),
            at: shiftHours(atTime(yesterdayISO, 15, 0), -randInt(rng, 0, 48)),
            byUserId: managerId,
            targetUserId: userId,
          });
        }
        continue;
      }

      const submittedPayload: Record<string, unknown> = {
        hours,
        totalHours: roundedTotal,
        // The caps in force at submission, with the contract that
        // agreed them — the same shape submitCore writes.
        weeklyCap: u.weeklyCap,
        dailyCap: u.dailyCap,
        capsContractRef: capTerms.find((c) => c.userId === userId)!.contractRef,
      };

      // A week held in a run that has already paid was handed off to
      // payroll before that run — so it was filed and approved before the
      // handoff, too. The stragglers are approved after their slot's due
      // date and wait in the next run instead, so they have no handoff.
      const straggler = plan === "lateStraggler" || plan === "approvedLate";
      const handoffAt = !straggler && slot.payday < todayISO ? seedProcessedAt(u.entityKey, slot) : null;

      // submission — on time (by the slot's cutoff) unless this is the
      // late-submission scenario, which is filed after it, flagged late
      // and says why: exactly what submitCore demands of a late week.
      let submittedAt: string;
      if (plan === "lateStraggler") {
        submittedAt = atTime(addDays(slot.cutoff, 1), 11, 0);
        submittedPayload.late = true;
        submittedPayload.reason = "Out sick most of the week; submitted after catching up on hours.";
      } else if (plan === "trail") {
        // Submitted, returned and resubmitted on the Friday morning, so the
        // resubmission is inside the week's window and the approval can
        // still come before a handoff that afternoon.
        submittedAt = handoffAt ? minDT(atTime(weekEnding, 8, 30), shiftHours(handoffAt, -6.5)) : atTime(weekEnding, 8, 30);
      } else {
        const candidate = shiftHours(atTime(weekEnding, 17, 0), randInt(rng, 0, 2) * 24);
        submittedAt = minDT(minDT(candidate, atTime(slot.cutoff, 20, 0)), atTime(yesterdayISO, 18, 0));
        if (handoffAt) submittedAt = minDT(submittedAt, shiftHours(handoffAt, -4));
      }
      events.push({ id: nextEventId(), timesheetId, type: "submitted", actorId: userId, at: submittedAt, payload: submittedPayload });
      if (plan === "lateStraggler") scenario.ashleyLate = { timesheetId, weekEnding, submittedAt };

      let lastSubmitAt = submittedAt;

      if (plan === "trail") {
        const returnedAt = shiftHours(submittedAt, 1.75);
        events.push({
          id: nextEventId(),
          timesheetId,
          type: "returned",
          actorId: managerId,
          at: returnedAt,
          payload: { reason: "Hours didn't reconcile with the sprint burn-down — please re-check Thursday before resubmitting." },
        });
        const resubmittedAt = shiftHours(submittedAt, 4);
        events.push({
          id: nextEventId(),
          timesheetId,
          type: "submitted",
          actorId: userId,
          at: resubmittedAt,
          payload: { ...submittedPayload, resubmission: true },
        });
        lastSubmitAt = resubmittedAt;
      }

      if (plan === "returnedOpen") {
        // Sent back and not yet resubmitted: the contributor's own
        // "returned" week, waiting on them.
        const returnedAt = shiftHours(submittedAt, 24);
        events.push({
          id: nextEventId(),
          timesheetId,
          type: "returned",
          actorId: managerId,
          at: returnedAt,
          payload: { reason: "Wednesday's hours look doubled against the client log — please check and resubmit." },
        });
        scenario.returned.push({
          entityKey: u.entityKey, timesheetId, weekEnding, userId, userName: u.name, managerId, payrollAdminId, at: returnedAt,
        });
        continue;
      }

      if (target === "submitted") {
        if (plan === "forceSubmitted") {
          const slotShow = (showcase[u.entityKey] ??= {});
          slotShow.submitted = { timesheetId, weekEnding, userId, userName: u.name, managerId, payrollAdminId, at: lastSubmitAt };
        }
        continue;
      }

      // approval — the moment the pay run is decided. On time means by the
      // slot's due date; the stragglers are approved the day after the last
      // paid run's due date, so the approval rule carries them into the
      // next run, exactly as it would in the app.
      let approvedAt: string;
      if (plan === "lateStraggler" || plan === "approvedLate") {
        approvedAt = maxDT(shiftHours(lastSubmitAt, 24), atTime(addDays(lastPaid.due, 1), 10, 0));
      } else {
        approvedAt = minDT(minDT(shiftHours(lastSubmitAt, 24), atTime(slot.due, 21, 0)), latestAt);
        if (handoffAt) approvedAt = minDT(approvedAt, shiftHours(handoffAt, -1));
      }
      if (new Date(approvedAt).getTime() <= new Date(lastSubmitAt).getTime()) {
        // Too recent to have been approved yet (filed yesterday evening):
        // it is still waiting on the manager.
        if (plan !== null) throw new Error(`seed: ${u.key} week ${weeksAgo} (${plan}) has no room to be approved`);
        continue;
      }
      const heldRun = payRunForApproval(weekEnding, approvedAt.slice(0, 10));
      if ((plan === "lateStraggler" || plan === "approvedLate") && heldRun.payday !== nextRun.payday) {
        throw new Error(`seed: straggler ${u.key} week ${weeksAgo} held in ${heldRun.payday}, expected ${nextRun.payday}`);
      }

      const isOverride = plan === "sod";
      const approverId = isOverride ? payrollAdminId : managerId;
      const approvedPayload: Record<string, unknown> = {
        hourly: rate.hourly,
        rateEffectiveFrom: rate.effectiveFrom,
        contractRef: rate.contractRef,
        payRun: payRunRef(heldRun),
        batch: `${isOverride ? "OV" : "BA"}-${Date.parse(approvedAt).toString(36).toUpperCase()}`,
      };
      if (isOverride) {
        approvedPayload.override = true;
        approvedPayload.comment = "Manager out of office; approving now so this week isn't held up for payroll.";
      }
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

      if (heldRun.payday >= todayISO) {
        // Held in the next run: approved and waiting for payroll.
        if (plan === "approvedLate") {
          const slotShow = (showcase[u.entityKey] ??= {});
          slotShow.approved = { timesheetId, weekEnding, userId, userName: u.name, managerId, payrollAdminId, at: approvedAt };
        }
        continue;
      }

      // processed — in the run the approval held, copied from the approved
      // event, in that run's batch for this entity. The amount comes only
      // from the two snapshots already taken: the hours on the submitted
      // event and the rate on the approved event. expenseAccount is what
      // the admin recorded; resolvedAccount is what the rule said. They
      // differ only on the ACCOUNT_OVERRIDE weeks, where the admin picked a
      // different head by hand — what Mark processed's dropdown allows and
      // Reports' "Account override" pill reports.
      const resolvedAccount = resolveExpenseAccount(stream, u.function);
      const override = ACCOUNT_OVERRIDE.find((o) => o.userKey === u.key && o.weeksAgo === weeksAgo);
      const expenseAccount = override && override.account !== resolvedAccount ? override.account : resolvedAccount;
      const amount = roundMoney(roundedTotal * rate.hourly);
      // Approved by the slot's due date, so the approval rule held it in its
      // own slot — the run whose handoff moment was computed above.
      if (heldRun.payday !== slot.payday || !handoffAt) {
        throw new Error(`seed: ${u.key} week ${weeksAgo} held in ${heldRun.payday}, processed as slot ${slot.payday}`);
      }
      const processedAt = handoffAt;
      events.push({
        id: nextEventId(),
        timesheetId,
        type: "processed",
        actorId: payrollAdminId,
        at: processedAt,
        payload: {
          expenseAccount,
          // Present only when the admin overruled the rule, mirroring
          // what markProcessedBatchCore writes.
          ...(expenseAccount !== resolvedAccount ? { accountOverrideReason: override!.reason } : {}),
          resolvedAccount,
          resolverInputs: { userFunction: u.function, billable: stream.billable, streamDefaultAccount: stream.defaultAccount },
          payRun: payRunRef(heldRun),
          amount,
          batch: seedBatchRef(processedAt),
        },
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

  // Scenario notifications, each targeting a real timesheet in the
  // notified user's own entity — one per scenario rather than one per
  // event.
  const nextNotificationId = makeIdGen();
  const notifications: NotificationRow[] = [];
  for (const r of scenario.returned) {
    notifications.push({
      id: nextNotificationId(),
      userId: r.userId,
      at: shiftHours(r.at, 1),
      readAt: null,
      text: `Your timesheet for week ending ${r.weekEnding} was returned.`,
      target: { timesheetId: r.timesheetId, weekEnding: r.weekEnding },
    });
  }
  if (scenario.ashleyLate) {
    notifications.push({
      id: nextNotificationId(),
      userId: userIdByKey.get("meera")!,
      at: shiftHours(scenario.ashleyLate.submittedAt, 1),
      readAt: shiftHours(scenario.ashleyLate.submittedAt, 4),
      text: `Ashley Davis submitted a late timesheet for week ending ${scenario.ashleyLate.weekEnding}.`,
      target: { timesheetId: scenario.ashleyLate.timesheetId, weekEnding: scenario.ashleyLate.weekEnding },
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

  // Showcase notifications: one UNREAD for a contributor, a manager and
  // a payroll admin in EACH entity, so a visitor arriving at a fresh
  // reset sees the bell badge from whichever role they pick. Every one
  // describes a real seeded event and carries a target that resolves to
  // a page that viewer may actually open — the manager's to the queue
  // entry waiting on them, the admin's to the approved week waiting to
  // be processed, the contributor's to their own week.
  for (const entityKey of Object.keys(showcase).sort()) {
    const slot = showcase[entityKey];
    if (slot.submitted) {
      const w = slot.submitted;
      notifications.push({
        id: nextNotificationId(),
        userId: w.managerId,
        at: shiftHours(w.at, 1),
        readAt: null,
        text: `${w.userName} submitted the week ending ${w.weekEnding} — it is waiting on you.`,
        target: { timesheetId: w.timesheetId, weekEnding: w.weekEnding },
      });
    }
    if (slot.approved) {
      const w = slot.approved;
      notifications.push({
        id: nextNotificationId(),
        userId: w.payrollAdminId,
        at: shiftHours(w.at, 1),
        readAt: null,
        text: `${w.userName}'s week ending ${w.weekEnding} was approved and is ready for payroll.`,
        target: { timesheetId: w.timesheetId, weekEnding: w.weekEnding },
      });
      notifications.push({
        id: nextNotificationId(),
        userId: w.userId,
        at: shiftHours(w.at, 2),
        readAt: null,
        text: `Your week ending ${w.weekEnding} was approved.`,
        target: { timesheetId: w.timesheetId, weekEnding: w.weekEnding },
      });
    }
  }

  notes.push(
    "Every date in this seed is derived from the anchor Friday plus an offset — there is no hardcoded " +
      "calendar date in db/seedData.ts. The showcase items (unread notifications, the account-override " +
      "rows, contracts ending within 21 days, overdue staff) therefore stay visible however far in the " +
      "future the demo is reset.",
  );
  notes.push(
    "Pay runs are decided at approval (lib/paycalendar.ts's payRunForApproval) and held on the approved event. " +
      "Weeks held in a run whose payday has passed are processed, one batch per entity per run; weeks held in " +
      `the next run (${nextRun.payday}) are approved and waiting. Three stragglers — the last week of the ` +
      `${lastPaid.payday} run, approved the day after its due date — show the rule carrying them into the next run.`,
  );
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

  // No reset, on any day at any hour, may write anything dated after the
  // moment it runs. Checked over every timestamp the seed writes, not
  // trusted to the formulas above.
  const nowMs = now.getTime();
  const stamps: [string, string][] = [
    ...events.map((e) => [`event ${e.id} (${e.type})`, e.at] as [string, string]),
    ...notifications.flatMap((n) => [[`notification ${n.id}`, n.at], ...(n.readAt ? [[`notification ${n.id} read`, n.readAt]] : [])] as [string, string][]),
    ...chases.map((c) => [`chase ${c.id}`, c.at] as [string, string]),
    ...adminLog.map((a) => [`admin_log ${a.id}`, a.at] as [string, string]),
  ];
  for (const [what, at] of stamps) {
    if (new Date(at).getTime() > nowMs) throw new Error(`seed: ${what} is dated ${at}, after now (${now.toISOString()})`);
  }

  return {
    anchor,
    weeks: WEEKS,
    entities,
    accounts: ACCOUNTS,
    streams,
    customers,
    users,
    rates,
    contractTerms,
    capTerms,
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
    ["contract_terms", seed.contractTerms.length],
    ["cap_terms", seed.capTerms.length],
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

// No `if (require.main === module)` block here, deliberately. lib/demo.ts
// imports buildSeed from this file, so this module is part of the Next.js
// SERVER bundle, which is ESM — a CommonJS `module` reference in it throws
// "module is not defined" at module-eval time and 500s every page. Running
// the builder on its own and printing the summary is what
// `npm run db:seed -- --dry-run` is for (db/seed.ts), and that needs no
// database.
