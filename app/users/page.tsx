import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { UsersAdmin } from "@/components/UsersAdmin";
import { fromUTCDate } from "@/lib/dateutil";
import {
  getAdminLogForEntity,
  getManagersForEntity,
  getRateHistoryForUser,
  getUsersForEntity,
  listEntities,
} from "@/lib/repo";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; sel?: string }>;
}) {
  const me = await requireUser(["admin"]);
  const { filter, sel } = await searchParams;
  const selectedId = sel ? Number(sel) : null;
  const activeOnly = filter !== "inactive";

  const [allUsers, managers, entities, adminLog] = await Promise.all([
    getUsersForEntity(me.entityId, false),
    getManagersForEntity(me.entityId),
    listEntities(),
    getAdminLogForEntity(me.entityId),
  ]);
  const activeCount = allUsers.filter((u) => u.active).length;
  const inactiveCount = allUsers.length - activeCount;
  const users = allUsers.filter((u) => u.active === activeOnly);

  const hourlyIds = users.filter((u) => u.payType === "hourly").map((u) => u.id);
  const histories = await Promise.all(hourlyIds.map((id) => getRateHistoryForUser(id)));
  const rateHistoryByUser = Object.fromEntries(hourlyIds.map((id, i) => [id, histories[i]]));

  return (
    <AppShell me={me} active="users" selectedId={selectedId}>
      <div className="card">
        <div className="card-h">
          <div>
            <h2>Users</h2>
            <p>
              {activeCount} active, {inactiveCount} inactive. Only hourly people file timesheets.
            </p>
          </div>
          <div className="seg">
            <Link href="/users?filter=active" aria-current={activeOnly ? "true" : undefined}>
              Active
            </Link>
            <Link href="/users?filter=inactive" aria-current={!activeOnly ? "true" : undefined}>
              Inactive
            </Link>
          </div>
        </div>
        <UsersAdmin
          users={users}
          managers={managers}
          entities={entities}
          rateHistoryByUser={rateHistoryByUser}
          meEntityId={me.entityId}
          todayISO={fromUTCDate(new Date())}
        />
      </div>

      <div className="card">
        <div className="card-h">
          <div>
            <h2>Admin log</h2>
            <p>User changes, appended and never edited.</p>
          </div>
        </div>
        <div className="card-b flush">
          {adminLog.length === 0 ? (
            <div className="empty">No changes yet.</div>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>By</th>
                    <th>User</th>
                    <th>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {adminLog.map((a) => (
                    <tr key={a.id}>
                      <td className="muted num" style={{ fontSize: 11.5 }}>
                        {new Date(a.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })}
                      </td>
                      <td>{a.actorName}</td>
                      <td>{a.userName}</td>
                      <td>{a.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
