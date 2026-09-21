import { getPool } from "@/lib/db";
import { fromUTCDate } from "@/lib/dateutil";
import { getUpcomingPayRuns } from "@/lib/paycalendar";

// This page hits the database on every request — there is nothing to
// statically cache.
export const dynamic = "force-dynamic";

interface StatusRow {
  type: string;
  count: string;
}

async function getCounts() {
  const pool = getPool();
  const [users, timesheets, events] = await Promise.all([
    pool.query<{ count: string }>("select count(*) from users"),
    pool.query<{ count: string }>("select count(*) from timesheets"),
    pool.query<{ count: string }>("select count(*) from events"),
  ]);
  return {
    users: users.rows[0].count,
    timesheets: timesheets.rows[0].count,
    events: events.rows[0].count,
  };
}

// Status is not a stored column — it is a projection over events: the type
// of the most recent event for each timesheet.
async function getStatusBreakdown(): Promise<StatusRow[]> {
  const pool = getPool();
  const result = await pool.query<StatusRow>(`
    select latest.type, count(*)::text as count
    from (
      select distinct on (timesheet_id) timesheet_id, type
      from events
      order by timesheet_id, at desc, id desc
    ) latest
    group by latest.type
    order by latest.type
  `);
  return result.rows;
}

export default async function Home() {
  const todayISO = fromUTCDate(new Date());
  const [counts, statusBreakdown] = await Promise.all([getCounts(), getStatusBreakdown()]);
  const payRuns = getUpcomingPayRuns(todayISO, 3);

  return (
    <main>
      <h1>Timesheet App — proof page</h1>
      <p>This page proves the database connection and the status projection work. No styling, no app UI yet.</p>

      <h2>Counts</h2>
      <ul>
        <li>users: {counts.users}</li>
        <li>timesheets: {counts.timesheets}</li>
        <li>events: {counts.events}</li>
      </ul>

      <h2>Next three pay runs</h2>
      <table border={1} cellPadding={4}>
        <thead>
          <tr>
            <th>Payday</th>
            <th>Due</th>
            <th>Cutoff</th>
          </tr>
        </thead>
        <tbody>
          {payRuns.map((run) => (
            <tr key={run.payday}>
              <td>{run.payday}</td>
              <td>{run.due}</td>
              <td>{run.cutoff}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Status breakdown (projected from events)</h2>
      <table border={1} cellPadding={4}>
        <thead>
          <tr>
            <th>Status</th>
            <th>Count</th>
          </tr>
        </thead>
        <tbody>
          {statusBreakdown.map((row) => (
            <tr key={row.type}>
              <td>{row.type}</td>
              <td>{row.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
