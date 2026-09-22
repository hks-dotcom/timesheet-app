// The three guided entries on the gate. Each one puts the visitor in
// the right role and lands them on a screen that is already set up to
// show the thing the entry promises.
//
// Two rules hold this together:
//
//   1. Every target is resolved SERVER-SIDE from the data as it stands
//      at the moment of entry — which person, which timesheet, which
//      pay run. Nothing here hardcodes an id or a date, so a guide
//      still lands correctly after the demo is reset at any anchor.
//   2. The guide id arrives from the client, so it is checked against
//      this allowlist and nothing else. The URL a visitor is sent to is
//      built here from resolved data; a client-supplied destination is
//      never followed, so there is no open redirect to find.

import { fromUTCDate, mostRecentFriday } from "./dateutil";
import { getRecentPayRuns } from "./paycalendar";
import { getPool } from "./db";
import type { Role } from "./repo";

export const GUIDE_IDS = ["raise", "trail", "payrun"] as const;
export type GuideId = (typeof GUIDE_IDS)[number];

export function isGuideId(value: string): value is GuideId {
  return (GUIDE_IDS as readonly string[]).includes(value);
}

export interface GuideDef {
  id: GuideId;
  title: string;
  line: string;
}

// Copy is fixed here so the gate and any future surface cannot drift.
export const GUIDES: GuideDef[] = [
  {
    id: "raise",
    title: "A raise doesn't rewrite history",
    line: "Open a week from about eighteen months ago. Pay was captured at approval, so it still matches, even after two raises. Switch on today's rate to see what recomputing would have claimed.",
  },
  {
    id: "trail",
    title: "One timesheet, every step",
    line: "Submitted, returned with a note, resubmitted, approved at a held rate, processed to an account. Nothing overwritten.",
  },
  {
    id: "payrun",
    title: "Record a pay run",
    line: "Tick approved weeks and see the cost by expense account before you confirm. The demo resets, so go ahead.",
  },
];

export interface GuideTarget {
  /** The user whose session the visitor is dropped into. */
  userId: number;
  role: Role;
  /** An app-relative path. Always built here, never taken from input. */
  href: string;
}

const RUN_WINDOW = 52; // matches app/reports/page.tsx, whose filter validates against the same list
const EIGHTEEN_MONTHS_WEEKS = 78;

async function firstAdmin(entityId: number): Promise<{ id: number } | null> {
  const r = await getPool().query<{ id: string }>(
    "select id from users where entity_id = $1 and role = 'admin' and active = true order by id limit 1",
    [entityId],
  );
  return r.rows[0] ? { id: Number(r.rows[0].id) } : null;
}

/**
 * Resolves a guide to a concrete session and landing URL, from the data
 * as it stands now. Returns null when the data cannot support the guide
 * (which the seed's own checks are there to prevent) so the caller can
 * fall back rather than send someone to a dead end.
 *
 * `now` exists so a proof can reseed at a simulated anchor and resolve
 * against the same date the data was built for; production callers
 * leave it alone and it reads the real clock, which is what
 * ensureFreshDemoData keeps the seed's anchor aligned to anyway.
 */
export async function resolveGuideTarget(guide: GuideId, entityId: number, now: Date = new Date()): Promise<GuideTarget | null> {
  const pool = getPool();
  const todayISO = fromUTCDate(now);
  const anchor = mostRecentFriday(now);

  if (guide === "payrun") {
    const admin = await firstAdmin(entityId);
    return admin && { userId: admin.id, role: "admin", href: "/processed" };
  }

  if (guide === "raise") {
    const admin = await firstAdmin(entityId);
    if (!admin) return null;
    // The person who actually demonstrates the claim: three or more
    // rate rows, the earliest in force eighteen months or more back,
    // and an approved week under that earliest rate. Exactly the shape
    // db/seed.ts guarantees.
    const cutoff = new Date(Date.parse(anchor) - EIGHTEEN_MONTHS_WEEKS * 7 * 86_400_000).toISOString().slice(0, 10);
    // (b) Not just the person — the WEEK. The guide says "open a week
    // from about eighteen months ago", so it resolves that one week
    // and lands on it, rather than dropping the visitor into two years
    // of rows and leaving them to find it. The newest processed week
    // at or before the eighteen-month cutoff, for the person who has
    // three or more rate rows with the earliest still in force then —
    // exactly the shape db/seed.ts guarantees.
    const found = await pool.query<{ user_id: string; timesheet_id: string; week_ending: string }>(
      `
        select t.user_id, t.id as timesheet_id, t.week_ending::text as week_ending
          from timesheets t
          join users u on u.id = t.user_id
         where u.entity_id = $1
           and t.week_ending <= $2::date
           and (select type from events e where e.timesheet_id = t.id order by e.at desc, e.id desc limit 1) = 'processed'
           and (
             select count(*) from rates r where r.user_id = t.user_id
           ) >= 3
           and (
             select min(r.effective_from) from rates r where r.user_id = t.user_id
           ) <= $2::date
         order by t.week_ending desc, t.id
         limit 1
      `,
      [entityId, cutoff],
    );
    const row = found.rows[0];
    if (!row) return null;

    // Reports validates `from`/`to` against this same list, so the
    // range has to be built from real paydays, not arbitrary dates.
    // It still spans the whole history: the point is that the resolved
    // week sits inside a long range and is still found for you.
    const runs = getRecentPayRuns(todayISO, RUN_WINDOW);
    if (runs.length === 0) return null;
    const from = runs.find((r) => r.payday >= row.week_ending) ?? runs[0];
    const to = runs[runs.length - 1];
    const q = new URLSearchParams({
      who: row.user_id,
      from: from.payday,
      to: to.payday,
      status: "approved",
      recompute: "1",
      sel: row.timesheet_id,
    });
    // The fragment scrolls the row into view; ?sel= highlights it and
    // opens its trail. Both are resolved here, server-side.
    return { userId: admin.id, role: "admin", href: `/reports?${q}#ts-${row.timesheet_id}` };
  }

  // guide === "trail": a timesheet that went the whole way and still
  // carries its return. Landed on as its OWNER, so the week is in the
  // table they are looking at and the trail beside it is theirs to see
  // — no role-scoping rule has to be bent to show it.
  const sheet = await pool.query<{ id: string; user_id: string; role: Role }>(
    `
      select t.id, t.user_id, u.role
        from timesheets t
        join users u on u.id = t.user_id
       where t.entity_id = $1
         and u.active = true
         and exists (select 1 from events e where e.timesheet_id = t.id and e.type = 'returned')
         and exists (select 1 from events e where e.timesheet_id = t.id and e.type = 'submitted'
                      and (e.payload->>'resubmission')::boolean is true)
         and (select type from events e where e.timesheet_id = t.id order by e.at desc, e.id desc limit 1) = 'processed'
       order by t.week_ending desc
       limit 1
    `,
    [entityId],
  );
  const s = sheet.rows[0];
  if (!s) return null;
  return { userId: Number(s.user_id), role: s.role, href: `/timesheets?sel=${s.id}` };
}
