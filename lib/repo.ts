// All read queries for the app. Status is never computed in SQL — every
// function here returns the latest event TYPE (a plain string) alongside
// whatever payloads are needed, and callers map it through
// lib/status.ts's statusFromLatestEventType.

import { getPool } from "./db";
import { fromUTCDate, mostRecentFriday } from "./dateutil";
import {
  blockedDaysFromRows,
  latestContractTerm,
  rateAsOf,
  offerableWeeks,
  weekdayDates,
  windowOf,
  type BlockedDay,
  type CapTermRow,
  type ContractTermRow,
  type DayKey,
  type Hours,
  type RateRow,
} from "./domain";
import { getPayRunForWeekEnding } from "./paycalendar";
import type { Status } from "./status";
import { statusFromLatestEventType } from "./status";

export interface EntityRow {
  id: number;
  name: string;
  domain: string;
}

export async function listEntities(): Promise<EntityRow[]> {
  const pool = getPool();
  // id must be converted: Postgres bigint columns come back as strings
  // from node-postgres (to avoid precision loss), and every id in this
  // app is compared with === against a JS number somewhere downstream.
  const result = await pool.query<{ id: string; name: string; domain: string }>(
    "select id, name, domain from entities order by name",
  );
  return result.rows.map((r) => ({ id: Number(r.id), name: r.name, domain: r.domain }));
}

export type Role = "intern" | "consultant" | "manager" | "admin";
export type PayType = "hourly" | "salaried";

export interface SessionUser {
  id: number;
  name: string;
  entityId: number;
  entityName: string;
  entityDomain: string;
  role: Role;
  payType: PayType;
  function: string;
  managerId: number | null;
  managerName: string | null;
  // The caps IN FORCE, read from cap_terms — never from users, which no
  // longer holds them (item b). capsContractRef is the contract that
  // agreed them, so a cap can never travel without its paperwork.
  weeklyCap: number;
  dailyCap: number;
  capsContractRef: string | null;
  active: boolean;
}

// The latest recorded cap_terms row for a user, as a lateral join. Same
// rule as lib/domain.ts's latestCapTerm, expressed in SQL because this
// runs for every session lookup on every request; both orderings are
// (recorded_at desc, id desc), so they cannot disagree.
const CAPS_IN_FORCE = `
  left join lateral (
    select ct.weekly_cap, ct.daily_cap, ct.contract_ref
      from cap_terms ct
     where ct.user_id = u.id
     order by ct.recorded_at desc, ct.id desc
     limit 1
  ) caps on true
`;

const USER_SELECT = `
  select
    u.id, u.name, u.entity_id as "entityId", e.name as "entityName", e.domain as "entityDomain",
    u.role, u.pay_type as "payType", u.function, u.manager_id as "managerId", m.name as "managerName",
    caps.weekly_cap as "weeklyCap", caps.daily_cap as "dailyCap", caps.contract_ref as "capsContractRef",
    u.active
  from users u
  join entities e on e.id = u.entity_id
  left join users m on m.id = u.manager_id
  ${CAPS_IN_FORCE}
`;

export async function getUserById(id: number): Promise<SessionUser | null> {
  const pool = getPool();
  const result = await pool.query(`${USER_SELECT} where u.id = $1`, [id]);
  const row = result.rows[0];
  return row ? normalizeUser(row) : null;
}

// The gate's lookup: the first active user in this entity with this role.
// If none is found for 'intern', falls back to 'consultant' (the mock's
// rule — not every entity necessarily has an intern seeded).
export async function findGateUser(entityId: number, role: Role): Promise<SessionUser | null> {
  const pool = getPool();
  const roles = role === "intern" ? ["intern", "consultant"] : [role];
  for (const r of roles) {
    const result = await pool.query(
      `${USER_SELECT} where u.entity_id = $1 and u.role = $2 and u.active = true order by u.id limit 1`,
      [entityId, r],
    );
    if (result.rows[0]) return normalizeUser(result.rows[0]);
  }
  return null;
}

function normalizeUser(row: Record<string, unknown>): SessionUser {
  return {
    id: Number(row.id),
    name: String(row.name),
    entityId: Number(row.entityId),
    entityName: String(row.entityName),
    entityDomain: String(row.entityDomain),
    role: row.role as Role,
    payType: row.payType as PayType,
    function: String(row.function),
    managerId: row.managerId === null ? null : Number(row.managerId),
    managerName: row.managerName === null ? null : String(row.managerName),
    // A salaried person has no cap_terms row and no caps; an hourly one
    // always does (db/seed.ts checks it). 0 rather than NaN so a missing
    // row can never widen a cap by accident.
    weeklyCap: row.weeklyCap === null ? 0 : Number(row.weeklyCap),
    dailyCap: row.dailyCap === null ? 0 : Number(row.dailyCap),
    capsContractRef: row.capsContractRef === null ? null : String(row.capsContractRef),
    active: Boolean(row.active),
  };
}

export interface DirectReport {
  id: number;
  name: string;
}

export async function getDirectReports(managerId: number): Promise<DirectReport[]> {
  const pool = getPool();
  const result = await pool.query<{ id: string; name: string }>(
    "select id, name from users where manager_id = $1 and active = true order by name",
    [managerId],
  );
  return result.rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

export interface TeamMemberRow {
  id: number;
  name: string;
  endDate: string | null;
  endDateContractRef: string | null;
}

// D10 (manager side): a manager's own direct reports, with the contract
// end date in force for each — everyone reporting to a manager is hourly
// by construction (only interns/consultants have managers), so this
// never needs a pay-type branch the way getUsersForEntity does.
export async function getDirectReportsWithContracts(managerId: number): Promise<TeamMemberRow[]> {
  const pool = getPool();
  const result = await pool.query<{ id: string; name: string }>(
    "select id, name from users where manager_id = $1 and active = true order by name",
    [managerId],
  );
  const rows: TeamMemberRow[] = [];
  for (const r of result.rows) {
    const id = Number(r.id);
    const terms = await getContractTermsForUser(id);
    const latest = latestContractTerm(terms);
    rows.push({ id, name: r.name, endDate: latest?.endDate ?? null, endDateContractRef: latest?.contractRef ?? null });
  }
  return rows;
}

export interface AdminUserRow {
  id: number;
  name: string;
  role: Role;
  function: string;
  payType: PayType;
  weeklyCap: number;
  dailyCap: number;
  capsContractRef: string | null; // the contract that agreed those caps
  managerId: number | null;
  managerName: string | null;
  active: boolean;
  currentRate: number | null; // hourly only
  endDate: string | null; // hourly only — the end date in force
  endDateContractRef: string | null;
  timesheetCount: number; // F3: entity is fixed once any week exists for this person
}

// The Users screen's list — every person in the admin's own entity,
// active or inactive per the filter. Current rate and end date are each
// resolved through the one shared function (lib/domain.ts's rateAsOf /
// latestContractTerm), not a second SQL re-implementation.
export async function getUsersForEntity(entityId: number, activeOnly: boolean): Promise<AdminUserRow[]> {
  const pool = getPool();
  const result = await pool.query<{
    id: string;
    name: string;
    role: Role;
    function: string;
    pay_type: PayType;
    weekly_cap: string | null;
    daily_cap: string | null;
    caps_contract_ref: string | null;
    manager_id: string | null;
    manager_name: string | null;
    active: boolean;
    timesheet_count: string;
  }>(
    `
      select u.id, u.name, u.role, u.function, u.pay_type, u.active,
        caps.weekly_cap, caps.daily_cap, caps.contract_ref as caps_contract_ref,
        u.manager_id, m.name as manager_name,
        (select count(*) from timesheets t where t.user_id = u.id) as timesheet_count
      from users u
      left join users m on m.id = u.manager_id
      ${CAPS_IN_FORCE}
      where u.entity_id = $1 ${activeOnly ? "and u.active = true" : ""}
      order by u.active desc, u.name
    `,
    [entityId],
  );

  const todayISO = fromUTCDate(new Date());
  const rows: AdminUserRow[] = [];
  for (const r of result.rows) {
    const id = Number(r.id);
    let currentRate: number | null = null;
    let endDate: string | null = null;
    let endDateContractRef: string | null = null;
    if (r.pay_type === "hourly") {
      const rates = await getRatesForUser(id);
      currentRate = rateAsOf(rates, todayISO)?.hourly ?? null;
      const terms = await getContractTermsForUser(id);
      const latest = latestContractTerm(terms);
      endDate = latest?.endDate ?? null;
      endDateContractRef = latest?.contractRef ?? null;
    }
    rows.push({
      id,
      name: r.name,
      role: r.role,
      function: r.function,
      payType: r.pay_type,
      weeklyCap: r.weekly_cap === null ? 0 : Number(r.weekly_cap),
      dailyCap: r.daily_cap === null ? 0 : Number(r.daily_cap),
      capsContractRef: r.caps_contract_ref,
      managerId: r.manager_id === null ? null : Number(r.manager_id),
      managerName: r.manager_name,
      active: r.active,
      currentRate,
      endDate,
      endDateContractRef,
      timesheetCount: Number(r.timesheet_count),
    });
  }
  return rows;
}

export async function getManagersForEntity(entityId: number): Promise<DirectReport[]> {
  const pool = getPool();
  const result = await pool.query<{ id: string; name: string }>(
    "select id, name from users where entity_id = $1 and role = 'manager' and active = true order by name",
    [entityId],
  );
  return result.rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

export interface AdminLogRow {
  id: number;
  at: string;
  actorName: string;
  userName: string;
  text: string;
}

export async function getAdminLogForEntity(entityId: number, limit = 60): Promise<AdminLogRow[]> {
  const pool = getPool();
  const result = await pool.query<{ id: string; at: string; actor_name: string; user_name: string; text: string }>(
    `
      select a.id, a.at::text as at, actor.name as actor_name, u.name as user_name, a.text
      from admin_log a
      join users actor on actor.id = a.actor_id
      join users u on u.id = a.user_id
      where u.entity_id = $1
      order by a.at desc, a.id desc
      limit $2
    `,
    [entityId, limit],
  );
  return result.rows.map((r) => ({ id: Number(r.id), at: r.at, actorName: r.actor_name, userName: r.user_name, text: r.text }));
}

export async function getContractTermsForUser(userId: number): Promise<ContractTermRow[]> {
  const pool = getPool();
  const result = await pool.query<{ end_date: string; contract_ref: string; recorded_at: string; kind: "set" | "extend" | "shorten" }>(
    "select end_date::text as end_date, contract_ref, recorded_at::text as recorded_at, kind from contract_terms where user_id = $1",
    [userId],
  );
  return result.rows.map((r) => ({ endDate: r.end_date, contractRef: r.contract_ref, recordedAt: r.recorded_at, kind: r.kind }));
}

// Every cap_terms row for a user; callers pass them through
// lib/domain.ts's latestCapTerm. The Users screen and SessionUser take
// the SQL shortcut (CAPS_IN_FORCE) because they only ever need the one
// in force; this is for anywhere that wants the history, and for the
// proof scripts, which deliberately use the shared pure function rather
// than trusting the SQL.
export async function getCapTermsForUser(userId: number): Promise<CapTermRow[]> {
  const pool = getPool();
  const result = await pool.query<{ weekly_cap: string; daily_cap: string; contract_ref: string; recorded_at: string }>(
    "select weekly_cap, daily_cap, contract_ref, recorded_at::text as recorded_at from cap_terms where user_id = $1",
    [userId],
  );
  return result.rows.map((r) => ({
    weeklyCap: Number(r.weekly_cap),
    dailyCap: Number(r.daily_cap),
    contractRef: r.contract_ref,
    recordedAt: r.recorded_at,
  }));
}

export async function getRatesForUser(userId: number): Promise<RateRow[]> {
  const pool = getPool();
  // effective_from and recorded_at must be cast to text: node-postgres
  // parses bare `date`/`timestamptz` columns into JS Date objects, and
  // comparing those against plain string values in lib/domain.ts's
  // rateAsOf (with <) silently coerces the string to NaN, so every
  // comparison is false.
  const result = await pool.query<{ hourly: string; effective_from: string; contract_ref: string; recorded_at: string }>(
    "select hourly, effective_from::text as effective_from, contract_ref, recorded_at::text as recorded_at from rates where user_id = $1 order by effective_from desc, recorded_at desc",
    [userId],
  );
  return result.rows.map((r) => ({
    hourly: Number(r.hourly),
    effectiveFrom: r.effective_from,
    contractRef: r.contract_ref,
    recordedAt: r.recorded_at,
  }));
}

export interface RateHistoryRow extends RateRow {
  id: number;
  recordedByName: string | null; // null for the original seed rows
  supersededBy: { at: string; byName: string | null } | null; // set when a later row shares this effectiveFrom (a correction)
}

// Full rate history for the Users screen's "Rate history" list — every
// row, including ones a same-dated correction has superseded (shown as
// superseded, never hidden, since nothing here is ever edited or deleted).
export async function getRateHistoryForUser(userId: number): Promise<RateHistoryRow[]> {
  const pool = getPool();
  const result = await pool.query<{
    id: string;
    hourly: string;
    effective_from: string;
    contract_ref: string;
    recorded_at: string;
    recorded_by_name: string | null;
  }>(
    `
      select r.id, r.hourly, r.effective_from::text as effective_from, r.contract_ref, r.recorded_at::text as recorded_at,
        rb.name as recorded_by_name
      from rates r
      left join users rb on rb.id = r.recorded_by
      where r.user_id = $1
      order by r.effective_from desc, r.recorded_at desc
    `,
    [userId],
  );
  const rows: RateHistoryRow[] = result.rows.map((r) => ({
    id: Number(r.id),
    hourly: Number(r.hourly),
    effectiveFrom: r.effective_from,
    contractRef: r.contract_ref,
    recordedAt: r.recorded_at,
    recordedByName: r.recorded_by_name,
    supersededBy: null,
  }));
  // A row is superseded exactly when a later-recorded row shares its
  // effectiveFrom — rows are already sorted latest-recorded-first within
  // each effectiveFrom group, so the row right before it in the list (if
  // any, same effectiveFrom) is the one that superseded it.
  for (let i = 0; i < rows.length - 1; i++) {
    if (rows[i].effectiveFrom === rows[i + 1].effectiveFrom) {
      rows[i + 1].supersededBy = { at: rows[i].recordedAt, byName: rows[i].recordedByName };
    }
  }
  return rows;
}

export interface StreamRow {
  id: number;
  name: string;
  billable: boolean;
  customerRule: "required" | "optional" | "none";
}

export async function getStreamsForEntity(entityId: number): Promise<StreamRow[]> {
  const pool = getPool();
  const result = await pool.query<{ id: string; name: string; billable: boolean; customer_rule: StreamRow["customerRule"] }>(
    "select id, name, billable, customer_rule from streams where entity_id = $1 order by (name = 'Internal'), name",
    [entityId],
  );
  return result.rows.map((r) => ({ id: Number(r.id), name: r.name, billable: r.billable, customerRule: r.customer_rule }));
}

export interface CustomerRow {
  id: number;
  name: string;
}

export async function getActiveCustomersForEntity(entityId: number): Promise<CustomerRow[]> {
  const pool = getPool();
  const result = await pool.query<{ id: string; name: string }>(
    "select id, name from customers where entity_id = $1 and status = 'Active' order by name",
    [entityId],
  );
  return result.rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

export async function getHolidaysByDate(dates: string[]): Promise<Map<string, string>> {
  if (dates.length === 0) return new Map();
  const pool = getPool();
  const result = await pool.query<{ date: string; name: string }>(
    "select date::text as date, name from holidays where date = any($1::date[])",
    [dates],
  );
  return new Map(result.rows.map((r) => [r.date, r.name]));
}

export async function getTimeOffByDate(userId: number, dates: string[]): Promise<Map<string, string>> {
  if (dates.length === 0) return new Map();
  const pool = getPool();
  const result = await pool.query<{ date: string; label: string }>(
    "select date::text as date, label from time_off where user_id = $1 and date = any($2::date[])",
    [userId, dates],
  );
  return new Map(result.rows.map((r) => [r.date, r.label]));
}

// Convenience wrapper for callers (like the approval queue) that just want
// one week's blocked days without juggling the two lookups themselves.
export async function getBlockedDaysBulk(userId: number, weekEnding: string): Promise<Record<DayKey, BlockedDay | null>> {
  const dates = Object.values(weekdayDates(weekEnding));
  const [holidays, timeOff] = await Promise.all([getHolidaysByDate(dates), getTimeOffByDate(userId, dates)]);
  return blockedDaysFromRows(weekEnding, holidays, timeOff);
}

// ---------------------------------------------------------------------------
// timesheets
// ---------------------------------------------------------------------------

export interface SubmittedPayload {
  hours: Hours;
  totalHours: number;
  weeklyCap: number;
  dailyCap: number;
  late?: boolean;
  reason?: string;
  resubmission?: boolean;
}

export interface ApprovedPayload {
  hourly: number;
  rateEffectiveFrom: string;
  contractRef: string;
  override?: boolean;
  batch?: string;
  comment?: string; // required when override is true (D6)
}

export interface ResolverInputs {
  userFunction: string;
  billable: boolean;
  streamDefaultAccount: string | null;
}

export interface ProcessedPayload {
  expenseAccount: string; // the account actually recorded — may be an override
  accountOverrideReason?: string; // only when expenseAccount differs from resolvedAccount
  resolvedAccount: string; // what the resolver rule would have said, snapshotted for audit
  resolverInputs: ResolverInputs; // the inputs the resolver was actually run against, frozen — a later
  // function/stream change can never make this row look wrong in hindsight
  payRun: { payday: string; due: string; cutoff: string };
  amount: number;
}

export interface TimesheetSummary {
  id: number;
  userId: number;
  userName: string;
  userFunction: string;
  managerId: number | null;
  managerName: string | null;
  weekEnding: string;
  streamId: number;
  streamName: string;
  billable: boolean;
  streamDefaultAccount: string | null;
  customerId: number | null;
  customerName: string | null;
  notes: string | null;
  draftHours: Hours | null;
  status: Status;
  latestEventAt: string;
  returnedReason: string | null;
  submitted: SubmittedPayload | null;
  approved: ApprovedPayload | null;
  processed: ProcessedPayload | null;
  approvedById: number | null;
  approvedByName: string | null;
}

const TIMESHEET_SELECT = `
  select
    t.id, t.user_id as "userId", u.name as "userName", u.function as "userFunction",
    u.manager_id as "managerId", mgr.name as "managerName", t.week_ending::text as "weekEnding",
    t.stream_id as "streamId", s.name as "streamName", s.billable, s.default_account as "streamDefaultAccount",
    t.customer_id as "customerId", c.name as "customerName", t.notes, t.draft_hours as "draftHours",
    latest.type as "latestType", latest.at::text as "latestAt",
    ret.payload as "returnedPayload",
    sub.payload as "submittedPayload",
    appr.payload as "approvedPayload",
    proc.payload as "processedPayload",
    apprby.id as "approvedById", apprby.name as "approvedByName"
  from timesheets t
  join users u on u.id = t.user_id
  left join users mgr on mgr.id = u.manager_id
  join streams s on s.id = t.stream_id
  left join customers c on c.id = t.customer_id
  join lateral (
    select type, at from events where timesheet_id = t.id order by at desc, id desc limit 1
  ) latest on true
  left join lateral (
    select payload from events where timesheet_id = t.id and type = 'returned' order by at desc, id desc limit 1
  ) ret on true
  left join lateral (
    select payload from events where timesheet_id = t.id and type = 'submitted' order by at desc, id desc limit 1
  ) sub on true
  left join lateral (
    select payload from events where timesheet_id = t.id and type = 'approved' order by at desc, id desc limit 1
  ) appr on true
  left join lateral (
    select payload from events where timesheet_id = t.id and type = 'processed' order by at desc, id desc limit 1
  ) proc on true
  left join lateral (
    select au.id, au.name from events ae join users au on au.id = ae.actor_id
    where ae.timesheet_id = t.id and ae.type = 'approved' order by ae.at desc, ae.id desc limit 1
  ) apprby on true
`;

function mapTimesheetRow(row: Record<string, unknown>): TimesheetSummary {
  const status = statusFromLatestEventType(row.latestType as string);
  const returnedPayload = row.returnedPayload as { reason?: string } | null;
  return {
    id: Number(row.id),
    userId: Number(row.userId),
    userName: String(row.userName),
    userFunction: String(row.userFunction),
    managerId: row.managerId === null ? null : Number(row.managerId),
    managerName: row.managerName === null ? null : String(row.managerName),
    weekEnding: String(row.weekEnding),
    streamId: Number(row.streamId),
    streamName: String(row.streamName),
    billable: Boolean(row.billable),
    streamDefaultAccount: row.streamDefaultAccount === null ? null : String(row.streamDefaultAccount),
    customerId: row.customerId === null ? null : Number(row.customerId),
    customerName: row.customerName === null ? null : String(row.customerName),
    notes: row.notes === null ? null : String(row.notes),
    draftHours: (row.draftHours as Hours | null) ?? null,
    status,
    latestEventAt: String(row.latestAt),
    returnedReason: status === "draft" && returnedPayload ? (returnedPayload.reason ?? null) : null,
    submitted: (row.submittedPayload as SubmittedPayload | null) ?? null,
    approved: (row.approvedPayload as ApprovedPayload | null) ?? null,
    processed: (row.processedPayload as ProcessedPayload | null) ?? null,
    approvedById: row.approvedById === null ? null : Number(row.approvedById),
    approvedByName: row.approvedByName === null ? null : String(row.approvedByName),
  };
}

export async function listTimesheetsForUser(userId: number): Promise<TimesheetSummary[]> {
  const pool = getPool();
  const result = await pool.query(`${TIMESHEET_SELECT} where t.user_id = $1 order by t.week_ending desc`, [userId]);
  return result.rows.map(mapTimesheetRow);
}

export async function getTimesheetById(id: number): Promise<TimesheetSummary | null> {
  const pool = getPool();
  const result = await pool.query(`${TIMESHEET_SELECT} where t.id = $1`, [id]);
  return result.rows[0] ? mapTimesheetRow(result.rows[0]) : null;
}

// Pending (submitted) timesheets for this manager's direct reports.
export async function getPendingForManager(managerId: number): Promise<TimesheetSummary[]> {
  const pool = getPool();
  const result = await pool.query(
    `${TIMESHEET_SELECT} where u.manager_id = $1 and latest.type = 'submitted' order by latest.at asc`,
    [managerId],
  );
  return result.rows.map(mapTimesheetRow);
}

// Approved or processed timesheets for this manager's direct reports.
export async function getApprovedForManager(managerId: number, limit = 60): Promise<TimesheetSummary[]> {
  const pool = getPool();
  const result = await pool.query(
    `${TIMESHEET_SELECT} where u.manager_id = $1 and latest.type in ('approved', 'processed')
     order by t.week_ending desc limit $2`,
    [managerId, limit],
  );
  return result.rows.map(mapTimesheetRow);
}

// Every timesheet belonging to this manager's direct reports, any status.
export async function listTimesheetsForManager(managerId: number): Promise<TimesheetSummary[]> {
  const pool = getPool();
  const result = await pool.query(`${TIMESHEET_SELECT} where u.manager_id = $1 order by t.week_ending desc`, [managerId]);
  return result.rows.map(mapTimesheetRow);
}

// Approved timesheets for one entity — Mark Processed's queue. One entity
// at a time, matching the rule that a processing batch never mixes them.
export async function getReadyForProcessing(entityId: number): Promise<TimesheetSummary[]> {
  const pool = getPool();
  const result = await pool.query(
    `${TIMESHEET_SELECT} where t.entity_id = $1 and latest.type = 'approved' order by t.week_ending asc`,
    [entityId],
  );
  return result.rows.map(mapTimesheetRow);
}

// D6: every submitted timesheet in this entity — payroll admin's override
// queue. These all belong to a manager; payroll admin isn't in anyone's
// approval chain, so there is no "own reports" scoping here.
export async function getSubmittedForEntity(entityId: number): Promise<TimesheetSummary[]> {
  const pool = getPool();
  const result = await pool.query(
    `${TIMESHEET_SELECT} where t.entity_id = $1 and latest.type = 'submitted' order by latest.at asc`,
    [entityId],
  );
  return result.rows.map(mapTimesheetRow);
}

// Approved or processed timesheets for one entity, optionally for one
// person — Reports' source rows. Pay-run range and status filtering happen
// afterward in JS via lib/paycalendar.ts, not here, since the pay calendar
// has no SQL implementation of its own to filter against.
export async function getReportableForEntity(entityId: number, userId?: number): Promise<TimesheetSummary[]> {
  const pool = getPool();
  const result = userId
    ? await pool.query(
        `${TIMESHEET_SELECT} where t.entity_id = $1 and t.user_id = $2 and latest.type in ('approved', 'processed') order by t.week_ending desc`,
        [entityId, userId],
      )
    : await pool.query(
        `${TIMESHEET_SELECT} where t.entity_id = $1 and latest.type in ('approved', 'processed') order by t.week_ending desc`,
        [entityId],
      );
  return result.rows.map(mapTimesheetRow);
}

// Weeks on file for the admin dashboard tile. A live count(*), derived
// per request — not a stored counter.
export async function countTimesheetsForEntity(entityId: number): Promise<number> {
  const pool = getPool();
  const r = await pool.query<{ n: string }>("select count(*) as n from timesheets where entity_id = $1", [entityId]);
  return Number(r.rows[0].n);
}

export interface HourlyUserRow {
  id: number;
  name: string;
}

export async function getHourlyUsersForEntity(entityId: number): Promise<HourlyUserRow[]> {
  const pool = getPool();
  const result = await pool.query<{ id: string; name: string }>(
    "select id, name from users where entity_id = $1 and pay_type = 'hourly' order by name",
    [entityId],
  );
  return result.rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

export interface SodFlag {
  timesheetId: number;
  userName: string;
  weekEnding: string;
  actorName: string;
  approvedAt: string;
}

// Timesheets whose override-approval and processing were done by the same
// person — the one thing segregation of duties says should never happen.
// This is the DETECTIVE control (after the fact, in Reports); the
// PREVENTIVE half is the warning in the Mark Processed confirm modal
// (components/MarkProcessed.tsx), which checks the same `override` flag
// before the second half of the pair can even happen.
export async function getSodFlags(entityId: number): Promise<SodFlag[]> {
  const pool = getPool();
  const result = await pool.query<{ id: string; user_name: string; week_ending: string; actor_name: string; approved_at: string }>(
    `
      select t.id, u.name as user_name, t.week_ending::text as week_ending, a.name as actor_name, appr.at::text as approved_at
      from timesheets t
      join users u on u.id = t.user_id
      join lateral (
        select actor_id, at, payload from events where timesheet_id = t.id and type = 'approved' order by at desc, id desc limit 1
      ) appr on true
      join users a on a.id = appr.actor_id
      join lateral (
        select actor_id from events where timesheet_id = t.id and type = 'processed' order by at desc, id desc limit 1
      ) proc on true
      where t.entity_id = $1
        and (appr.payload->>'override')::boolean is true
        and appr.actor_id = proc.actor_id
      order by appr.at desc
    `,
    [entityId],
  );
  return result.rows.map((r) => ({
    timesheetId: Number(r.id),
    userName: r.user_name,
    weekEnding: r.week_ending,
    actorName: r.actor_name,
    approvedAt: r.approved_at,
  }));
}

export interface TrailEvent {
  id: number;
  timesheetId: number;
  type: string;
  actorName: string;
  at: string;
  payload: Record<string, unknown>;
  userName: string;
  weekEnding: string;
}

function mapTrailEvent(row: Record<string, unknown>): TrailEvent {
  return {
    id: Number(row.id),
    timesheetId: Number(row.timesheetId),
    type: String(row.type),
    actorName: String(row.actorName),
    at: String(row.at),
    payload: row.payload as Record<string, unknown>,
    userName: String(row.userName),
    weekEnding: String(row.weekEnding),
  };
}

// Who may see a given timesheet's trail at all. Same shape as the rule
// the server actions enforce for writing, applied to reading: a
// contributor sees only their own, a manager their own plus their direct
// reports', a payroll admin anything in their own entity. Entity is
// checked in every branch, so a cross-entity id is refused even for an
// admin. This is a SQL predicate, not a filter applied to rows already
// fetched — the rows never leave the database.
const TRAIL_VISIBILITY = `
  t.entity_id = $ENTITY
  and (
    $ROLE = 'admin'
    or t.user_id = $ME
    or ($ROLE = 'manager' and exists (select 1 from users r where r.id = t.user_id and r.manager_id = $ME))
    or exists (select 1 from events x where x.timesheet_id = t.id and x.actor_id = $ME)
  )
`;

// Binds the predicate's placeholders to actual query parameters. Only
// ever called with literal $n strings written here — no caller-supplied
// text reaches the SQL, the viewer's own id/entity/role travel as bound
// parameters.
function visibilityFor(entityParam: string, meParam: string, roleParam: string): string {
  return TRAIL_VISIBILITY.replaceAll("$ENTITY", entityParam).replaceAll("$ME", meParam).replaceAll("$ROLE", roleParam);
}

// The minimum a caller must tell the trail about itself. Narrower than
// SessionUser so a proof script can construct one without a session.
export interface TrailViewer {
  id: number;
  entityId: number;
  role: Role;
}

// Unscoped on purpose and NOT exported: the only caller is
// getEventsForTimesheetIfVisible below, which checks visibility first.
async function getEventsForTimesheet(timesheetId: number): Promise<TrailEvent[]> {
  const pool = getPool();
  const result = await pool.query(
    `
      select e.id, e.timesheet_id as "timesheetId", e.type, a.name as "actorName", e.at::text as at,
             e.payload, u.name as "userName", t.week_ending::text as "weekEnding"
      from events e
      join users a on a.id = e.actor_id
      join timesheets t on t.id = e.timesheet_id
      join users u on u.id = t.user_id
      where e.timesheet_id = $1
      order by e.at asc, e.id asc
    `,
    [timesheetId],
  );
  return result.rows.map(mapTrailEvent);
}

// The Activity panel's own query, scoped to what this viewer may see.
// A contributor's own events include ones they performed on someone
// else's timesheet — there are none today, but the rule is "yours, plus
// what you did", not "yours" alone, so a future actor-on-another-sheet
// event still shows up for the person who did it.
export async function getRecentEventsForViewer(me: TrailViewer, limit = 16): Promise<TrailEvent[]> {
  const pool = getPool();
  const result = await pool.query(
    `
      select e.id, e.timesheet_id as "timesheetId", e.type, a.name as "actorName", e.at::text as at,
             e.payload, u.name as "userName", t.week_ending::text as "weekEnding"
      from events e
      join users a on a.id = e.actor_id
      join timesheets t on t.id = e.timesheet_id
      join users u on u.id = t.user_id
      where ${visibilityFor("$1", "$2", "$3")}
      order by e.at desc, e.id desc
      limit $4
    `,
    [me.entityId, me.id, me.role, limit],
  );
  return result.rows.map(mapTrailEvent).reverse();
}

// One timesheet's trail, but only if this viewer may see that timesheet.
// Returns null when they may not, so the caller can fall back to the
// scoped Activity list rather than rendering someone else's rates.
export async function getEventsForTimesheetIfVisible(me: TrailViewer, timesheetId: number): Promise<TrailEvent[] | null> {
  const pool = getPool();
  const allowed = await pool.query<{ ok: boolean }>(
    `select true as ok from timesheets t where t.id = $4 and ${visibilityFor("$1", "$2", "$3")}`,
    [me.entityId, me.id, me.role, timesheetId],
  );
  if (allowed.rows.length === 0) return null;
  return getEventsForTimesheet(timesheetId);
}

// ---------------------------------------------------------------------------
// Tracker (Staff / Managers) and chases ("Notify")
// ---------------------------------------------------------------------------

async function getChaseCountsForEntity(entityId: number): Promise<Map<number, number>> {
  const pool = getPool();
  const result = await pool.query<{ target_user_id: string; count: string }>(
    `
      select c.target_user_id, count(*) as count
      from chases c
      join users u on u.id = c.target_user_id
      where u.entity_id = $1
      group by c.target_user_id
    `,
    [entityId],
  );
  return new Map(result.rows.map((r) => [Number(r.target_user_id), Number(r.count)]));
}

export interface TrackerStaffRow {
  id: number;
  name: string;
  function: string;
  managerName: string | null;
  lastSubmittedWeek: string | null;
  openWeeks: number; // within the usual last-4-week window, contract-end-date aware (D9)
  overdueWeeks: number; // of those, past their own cutoff
  chaseCount: number;
}

// Every active hourly person in the entity, with the same "open week"
// definition New Timesheet and the contributor nav badge use — missing or
// still a draft, not future, and never a week past the contract end date
// in force (D9) — so Overdue here always agrees with what that person
// would actually see if they opened New Timesheet themselves.
export async function getTrackerStaffForEntity(entityId: number, todayISO: string): Promise<TrackerStaffRow[]> {
  const pool = getPool();
  const usersResult = await pool.query<{ id: string; name: string; function: string; manager_name: string | null }>(
    `
      select u.id, u.name, u.function, m.name as manager_name
      from users u
      left join users m on m.id = u.manager_id
      where u.entity_id = $1 and u.pay_type = 'hourly' and u.active = true
      order by u.name
    `,
    [entityId],
  );
  const chaseCounts = await getChaseCountsForEntity(entityId);
  const anchor = mostRecentFriday(new Date());

  const rows: TrackerStaffRow[] = [];
  for (const u of usersResult.rows) {
    const id = Number(u.id);
    const sheets = await listTimesheetsForUser(id);
    const lastSubmittedWeek = sheets.find((t) => t.submitted !== null)?.weekEnding ?? null;
    const earliestWeek = sheets.reduce((min, t) => (t.weekEnding < min ? t.weekEnding : min), anchor);
    const terms = await getContractTermsForUser(id);
    const endDate = latestContractTerm(terms)?.endDate ?? null;
    const byWeek = new Map(sheets.map((t) => [t.weekEnding, t]));
    const weeks = offerableWeeks(anchor, earliestWeek, endDate);

    let openWeeks = 0;
    let overdueWeeks = 0;
    for (const we of weeks) {
      const ts = byWeek.get(we);
      if (ts && ts.status !== "draft") continue;
      const win = windowOf(we, todayISO);
      if (win.state === "future") continue;
      openWeeks += 1;
      if (win.state !== "open") overdueWeeks += 1;
    }

    rows.push({
      id,
      name: u.name,
      function: u.function,
      managerName: u.manager_name,
      lastSubmittedWeek,
      openWeeks,
      overdueWeeks,
      chaseCount: chaseCounts.get(id) ?? 0,
    });
  }
  return rows;
}

export interface TrackerManagerRow {
  id: number;
  name: string;
  waiting: number;
  pastDue: number;
}

// Every active manager in the entity, with how many of their direct
// reports' submitted weeks are waiting on them, and how many are already
// past that week's own pay-run due date.
export async function getTrackerManagersForEntity(entityId: number, todayISO: string): Promise<TrackerManagerRow[]> {
  const managers = await getManagersForEntity(entityId);
  const rows: TrackerManagerRow[] = [];
  for (const m of managers) {
    const pending = await getPendingForManager(m.id);
    const pastDue = pending.filter((t) => todayISO > getPayRunForWeekEnding(t.weekEnding).due).length;
    rows.push({ id: m.id, name: m.name, waiting: pending.length, pastDue });
  }
  return rows;
}

// D9: the deep link a "Notify" chase sends a contributor to — the same
// newest-open-week rule New Timesheet's own default uses, so the link
// always lands them exactly where their own page would have opened.
export async function nextOpenWeekForContributor(userId: number, todayISO: string): Promise<string | null> {
  const anchor = mostRecentFriday(new Date());
  const sheets = await listTimesheetsForUser(userId);
  const byWeek = new Map(sheets.map((t) => [t.weekEnding, t]));
  const earliestWeek = sheets.reduce((min, t) => (t.weekEnding < min ? t.weekEnding : min), anchor);
  const terms = await getContractTermsForUser(userId);
  const endDate = latestContractTerm(terms)?.endDate ?? null;
  const weeks = offerableWeeks(anchor, earliestWeek, endDate);

  for (const we of weeks) {
    const ts = byWeek.get(we);
    if (ts && ts.status !== "draft") continue;
    const win = windowOf(we, todayISO);
    if (win.state === "future") continue;
    return we;
  }
  return null;
}

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------

export interface NotificationRow {
  id: number;
  at: string;
  text: string;
  target: Record<string, unknown>;
  readAt: string | null;
}

export async function getNotificationsForUser(userId: number, limit = 30): Promise<NotificationRow[]> {
  const pool = getPool();
  const result = await pool.query<{ id: string; at: string; text: string; target: Record<string, unknown>; read_at: string | null }>(
    "select id, at::text as at, text, target, read_at::text as read_at from notifications where user_id = $1 order by at desc, id desc limit $2",
    [userId, limit],
  );
  return result.rows.map((r) => ({ id: Number(r.id), at: r.at, text: r.text, target: r.target, readAt: r.read_at }));
}
