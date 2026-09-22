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

## Server actions

A server action is a callable endpoint, not just a function the UI
happens to use. Only the exports of a `"use server"` module become
endpoints, and `npm run build` writes the exact list to
`.next/server/server-reference-manifest.json` — **15 ids, every one an
`*Action` wrapper**:

| File | Endpoint |
|---|---|
| `app/actions/admin.ts` | `saveUserAction`, `addRateAction`, `recordEndDateAction` |
| `app/actions/demo.ts` | `resetDemoAction` |
| `app/actions/notify.ts` | `chaseAction`, `markNotificationReadAction`, `markAllNotificationsReadAction` |
| `app/actions/payroll.ts` | `markProcessedBatchAction` |
| `app/actions/session.ts` | `enterAppAction`, `switchAction` |
| `app/actions/timesheet.ts` | `approveBatchAction`, `overrideApproveAction`, `returnAction`, `saveDraftAction`, `submitAction` |

The `*Core` functions take the acting user as an argument, so if they
were exported from a `"use server"` module a caller could hand them any
user object and walk past the session entirely. They live in
`lib/actions/*.ts`, which is **not** a `"use server"` module, so that is
structural rather than a bundler outcome.

| Action | Roles | Entity check | Ownership / relationship check | Enforced in |
|---|---|---|---|---|
| `saveUserAction` | admin | target's `entity_id` must equal the caller's | new manager must be an active manager in the selected entity; entity may not change once the person has a timesheet | `requireUser(["admin"])` + `assertRole` + SQL in `saveUserCore` |
| `addRateAction` | admin | target's `entity_id` must equal the caller's | target must be `pay_type = 'hourly'` | `requireUser` + `assertRole` + `addRateCore` |
| `recordEndDateAction` | admin, manager | admin: target in caller's entity | manager: target's `manager_id` must be the caller, and the new date must be strictly later (extend only) | `requireUser(["admin","manager"])` + role branch in `recordEndDateCore` |
| `chaseAction` | admin | target's `entity_id` must equal the caller's | target must be active | `requireUser(["admin"])` + `assertRole` + `chaseCore` |
| `markNotificationReadAction` | any signed-in role | — | `where id = $1 and user_id = $2` — someone else's row is a no-op | `requireUser()` + SQL in `markNotificationReadCore` |
| `markAllNotificationsReadAction` | any signed-in role | — | `where user_id = $1` | `requireUser()` + SQL |
| `saveDraftAction` | intern, consultant | stream **and customer** must belong to the caller's entity | row is keyed on `user_id = me.id`, so only their own week | `requireUser([...])` + `assertRole` + `saveDraftCore` |
| `submitAction` | intern, consultant | stream and customer must belong to the caller's entity | own week only; `pay_type` hourly with a manager; window, contract end date and caps re-checked | `requireUser([...])` + `assertRole` + `submitCore` |
| `returnAction` | manager | via the relationship check | the sheet's owner's `manager_id` must be the caller; status must be `submitted` | `requireUser(["manager"])` + `assertRole` + `returnCore` |
| `approveBatchAction` | manager | via the relationship check | every sheet in the batch must be a direct report's and still `submitted`, or the whole batch fails | `requireUser(["manager"])` + `assertRole` + `approveBatchCore` |
| `overrideApproveAction` | admin | sheet's `entity_id` must equal the caller's | status must be `submitted`; comment ≥ 5 chars | `requireUser(["admin"])` + `assertRole` + `overrideApproveCore` |
| `markProcessedBatchAction` | admin | every sheet's `entity_id` must equal the caller's | every sheet still `approved`, account must be a real code, an overridden account needs a reason ≥ 5 chars, or the whole batch fails | `requireUser(["admin"])` + `assertRole` + `markProcessedBatchCore` |
| `enterAppAction` | **none — this is the gate** | the chosen entity must have a seeded user of the chosen role | — | validates role against `VALID_ROLES`; `findGateUser` returns null otherwise |
| `switchAction` | any, including none | — | clears the caller's own cookie only | — |
| `resetDemoAction` | **none by design** | — | — | none but the two-minute cooldown in `resetDemo()` |

`enterAppAction`, `switchAction` and `resetDemoAction` deliberately have
no role check: this demo has no sign-in, the gate and the Switch and
Reset controls are reachable without a session, and requiring one would
break the gate's own page. `resetDemoAction` rebuilds seeded, fictional
data and nothing else; its only guard is the cooldown.
