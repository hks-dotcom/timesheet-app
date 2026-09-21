import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { StatusMark } from "@/components/StatusMark";
import { formatDateLong, formatHours, formatMoney } from "@/lib/format";
import { listTimesheetsForUser } from "@/lib/repo";
import { requireUser } from "@/lib/session";
import { STATUSES, type Status } from "@/lib/status";

export const dynamic = "force-dynamic";

const PER_PAGE = 12;
const FILTERS: { value: "all" | Status; label: string }[] = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "submitted", label: "Submitted" },
  { value: "approved", label: "Approved" },
  { value: "processed", label: "Processed" },
];

export default async function MyTimesheetsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; page?: string; sel?: string }>;
}) {
  const me = await requireUser(["intern", "consultant"]);
  const { filter, page, sel } = await searchParams;
  const selectedId = sel ? Number(sel) : null;

  const all = await listTimesheetsForUser(me.id);
  const activeFilter = FILTERS.some((f) => f.value === filter) ? (filter as (typeof FILTERS)[number]["value"]) : "all";
  const list = activeFilter === "all" ? all : all.filter((t) => t.status === activeFilter);

  const pageCount = Math.max(1, Math.ceil(list.length / PER_PAGE));
  const currentPage = Math.min(Math.max(1, Number(page) || 1), pageCount);
  const pageItems = list.slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE);

  const counts = Object.fromEntries(STATUSES.map((s) => [s, all.filter((t) => t.status === s).length])) as Record<Status, number>;

  return (
    <AppShell me={me} active="timesheets" selectedId={selectedId}>
      <div className="card">
        <div className="card-h">
          <div>
            <h2>My timesheets</h2>
            <p>{all.length} weeks on file.</p>
          </div>
          <div className="row">
            <div className="seg">
              {FILTERS.map((f) => (
                <Link
                  key={f.value}
                  href={`/timesheets?filter=${f.value}`}
                  aria-current={activeFilter === f.value ? "true" : undefined}
                >
                  {f.label} ({f.value === "all" ? all.length : counts[f.value as Status]})
                </Link>
              ))}
            </div>
            <a className="btn sm" href="/timesheets/csv">
              Download CSV
            </a>
          </div>
        </div>
        <div className="card-b flush">
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Week ending</th>
                  <th>Stream</th>
                  <th>Customer</th>
                  <th className="r">Hours</th>
                  <th>Status</th>
                  <th className="r">Rate held</th>
                  <th className="r">Pay</th>
                  <th>Pay run</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.length === 0 ? (
                  <tr>
                    <td colSpan={8}>
                      <div className="empty">Nothing in this state.</div>
                    </td>
                  </tr>
                ) : (
                  pageItems.map((t) => {
                    const hours = t.submitted?.totalHours ?? Object.values(t.draftHours ?? {}).reduce((a, b) => a + b, 0);
                    const pay = t.approved ? t.approved.hourly * (t.submitted?.totalHours ?? 0) : null;
                    return (
                      <tr key={t.id}>
                        <td>
                          <Link className="rowlink" href={`/timesheets?filter=${activeFilter}&page=${currentPage}&sel=${t.id}`}>
                            {formatDateLong(t.weekEnding)}
                          </Link>
                          {t.submitted?.late ? (
                            <>
                              {" "}
                              <span className="pill warn">Late</span>
                            </>
                          ) : null}
                        </td>
                        <td>{t.streamName}</td>
                        <td>{t.customerName ?? <span className="muted">&mdash;</span>}</td>
                        <td className="r num">{formatHours(hours)}</td>
                        <td>
                          <StatusMark status={t.status} returnedReason={t.returnedReason} />
                        </td>
                        <td className="r num">{t.approved ? formatMoney(t.approved.hourly) : <span className="muted">&mdash;</span>}</td>
                        <td className="r num">{pay !== null ? formatMoney(pay) : <span className="muted">&mdash;</span>}</td>
                        <td>{t.processed?.payRun.payday ?? <span className="muted">&mdash;</span>}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          {pageCount > 1 && (
            <div className="card-b row" style={{ justifyContent: "space-between" }}>
              <span className="muted">
                Page {currentPage} of {pageCount}
              </span>
              <span>
                {currentPage <= 1 ? (
                  <button className="btn sm" disabled>
                    Previous
                  </button>
                ) : (
                  <Link className="btn sm" href={`/timesheets?filter=${activeFilter}&page=${currentPage - 1}`}>
                    Previous
                  </Link>
                )}{" "}
                {currentPage >= pageCount ? (
                  <button className="btn sm" disabled>
                    Next
                  </button>
                ) : (
                  <Link className="btn sm" href={`/timesheets?filter=${activeFilter}&page=${currentPage + 1}`}>
                    Next
                  </Link>
                )}
              </span>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
