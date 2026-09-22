// All read queries for the app. Status is never computed in SQL — every
// function here returns the latest event TYPE (a plain string) alongside
// whatever payloads are needed, and callers map it through
// lib/status.ts's statusFromLatestEventType.

import { getPool } from "./db";
import { blockedDaysFromRows, weekdayDates, type BlockedDay, type DayKey, type Hours, type RateRow } from "./domain";
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
  weeklyCap: number;
  dailyCap: number;
  active: boolean;
}

const USER_SELECT = `
  select
    u.id, u.name, u.entity_id as "entityId", e.name as "entityName", e.domain as "entityDomain",
    u.role, u.pay_type as "payType", u.function, u.manager_id as "managerId", m.name as "managerName",
    u.weekly_cap as "weeklyCap", u.daily_cap as "dailyCap", u.active
  from users u
  join entities e on e.id = u.entity_id
  left join users m on m.id = u.manager_id
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
    weeklyCap: Number(row.weeklyCap),
    dailyCap: Number(row.dailyCap),
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
  approvedByName: string | null;
}

const TIMESHEET_SELECT = `
  select
    t.id, t.user_id as "userId", u.name as "userName", u.function as "userFunction", t.week_ending::text as "weekEnding",
    t.stream_id as "streamId", s.name as "streamName", s.billable, s.default_account as "streamDefaultAccount",
    t.customer_id as "customerId", c.name as "customerName", t.notes, t.draft_hours as "draftHours",
    latest.type as "latestType", latest.at::text as "latestAt",
    ret.payload as "returnedPayload",
    sub.payload as "submittedPayload",
    appr.payload as "approvedPayload",
    proc.payload as "processedPayload",
    apprby.name as "approvedByName"
  from timesheets t
  join users u on u.id = t.user_id
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
    select au.name from events ae join users au on au.id = ae.actor_id
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
// The override-approve action itself doesn't exist in the app yet; this
// only reads the `override` flag an approved event's payload can carry, so
// it's ready as soon as that action is built.
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

export async function getEventsForTimesheet(timesheetId: number): Promise<TrailEvent[]> {
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

export async function getRecentEntityEvents(entityId: number, limit = 16): Promise<TrailEvent[]> {
  const pool = getPool();
  const result = await pool.query(
    `
      select e.id, e.timesheet_id as "timesheetId", e.type, a.name as "actorName", e.at::text as at,
             e.payload, u.name as "userName", t.week_ending::text as "weekEnding"
      from events e
      join users a on a.id = e.actor_id
      join timesheets t on t.id = e.timesheet_id
      join users u on u.id = t.user_id
      where t.entity_id = $1
      order by e.at desc, e.id desc
      limit $2
    `,
    [entityId, limit],
  );
  return result.rows.map(mapTrailEvent).reverse();
}
