# Server-side access rules

Every row below is enforced on the server, in the page or route handler
itself — never by the nav hiding a link. `requireUser(roles)`
(`lib/session.ts`) resolves the cookie session, redirects to `/` when
there is none, and redirects to `/dashboard` when the role is not in
`roles`. Route handlers call `getCurrentUser()` and redirect to `/`
themselves, because a CSV download has nowhere useful to send a wrong
role.

| Route | Who may open it | Enforced in | Wrong role gets |
|---|---|---|---|
| `/` (the gate) | anyone, no session | — (it *is* the sign-in-less gate) | n/a |
| `/dashboard` | every role | `requireUser()` | redirect `/` if no session |
| `/timesheets` | intern, consultant | `requireUser(["intern","consultant"])` | 307 → `/dashboard` |
| `/timesheets/new` | intern, consultant | `requireUser(["intern","consultant"])` | 307 → `/dashboard` |
| `/queue` | manager | `requireUser(["manager"])` | 307 → `/dashboard` |
| `/overrides` | payroll admin | `requireUser(["admin"])` | 307 → `/dashboard` |
| `/processed` | payroll admin | `requireUser(["admin"])` | 307 → `/dashboard` |
| `/tracker` | payroll admin | `requireUser(["admin"])` | 307 → `/dashboard` |
| `/reports` | payroll admin | `requireUser(["admin"])` | 307 → `/dashboard` |
| `/users` | payroll admin | `requireUser(["admin"])` | 307 → `/dashboard` |
| `/reports/csv` | payroll admin | `getCurrentUser()` + `role !== "admin"` | 307 → `/` |
| `/queue/csv` | manager | `getCurrentUser()` + `role !== "manager"` | 307 → `/` |
| `/timesheets/csv` | any hourly person, own rows only | `getCurrentUser()` + `payType !== "hourly"` | 307 → `/` |

## Entity scoping

Every read is scoped in its own SQL, not by filtering fetched rows:

- **Entity-scoped** (`where entity_id = $1`): `getUsersForEntity`,
  `getManagersForEntity`, `getStreamsForEntity`,
  `getActiveCustomersForEntity`, `getSubmittedForEntity`,
  `getReadyForProcessing`, `getReportableForEntity`,
  `getHourlyUsersForEntity`, `getTrackerStaffForEntity`,
  `getTrackerManagersForEntity`, `getSodFlags`, `getAdminLogForEntity`,
  `countTimesheetsForEntity`.
- **User-scoped**: `listTimesheetsForUser`, `getRatesForUser`,
  `getRateHistoryForUser`, `getContractTermsForUser`,
  `getTimeOffByDate`, `getNotificationsForUser`.
- **Manager-scoped**: `getPendingForManager`, `getApprovedForManager`,
  `listTimesheetsForManager`, `getDirectReports`,
  `getDirectReportsWithContracts`.
- `getReportableForEntity(entityId, userId?)` ands the two together, so
  a `?who=` naming someone in the other entity returns nothing rather
  than that person's rows.

## The Activity panel and `?sel=`

`getRecentEventsForViewer` and `getEventsForTimesheetIfVisible`
(`lib/repo.ts`) share one SQL predicate:

    t.entity_id = $entity
    and ( role = 'admin'
          or t.user_id = $me
          or (role = 'manager' and the owner reports to $me)
          or $me acted on this timesheet )

A contributor sees their own weeks plus anything they performed; a
manager theirs plus their direct reports'; a payroll admin the whole
entity. Entity is in every branch, so a cross-entity `?sel=` is refused
even for an admin — the panel falls back to that viewer's own Activity
instead of rendering someone else's rate. There is no unscoped
entity-wide trail query left in the codebase.
