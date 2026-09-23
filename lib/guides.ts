// The two guided entries on the gate. Each one puts the visitor in
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

import { getPool } from "./db";
import type { Role } from "./repo";

export const GUIDE_IDS = ["trail", "payrun"] as const;
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
 */
export async function resolveGuideTarget(guide: GuideId, entityId: number): Promise<GuideTarget | null> {
  const pool = getPool();

  if (guide === "payrun") {
    const admin = await firstAdmin(entityId);
    return admin && { userId: admin.id, role: "admin", href: "/processed" };
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
