import { AppShell } from "@/components/AppShell";
import { MarkProcessed, type ReadyRow } from "@/components/MarkProcessed";
import { resolveExpenseAccount } from "@/lib/accounts";
import { formatDateLong, formatDateTime, formatMoney, roundMoney } from "@/lib/format";
import { listBatches } from "@/lib/handoff";
import { heldRunOf } from "@/lib/payrun";
import { getReadyForProcessing, getReportableForEntity } from "@/lib/repo";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const BATCH_LIST = 8;

export default async function ProcessedPage({ searchParams }: { searchParams: Promise<{ sel?: string }> }) {
  const me = await requireUser(["admin"]);
  const { sel } = await searchParams;
  const selectedId = sel ? Number(sel) : null;

  const [ready, reportable] = await Promise.all([getReadyForProcessing(me.entityId), getReportableForEntity(me.entityId)]);
  // Every batch's file stays downloadable: the same builder, sliced to
  // the batch, from the processed events themselves.
  const batches = listBatches(reportable, BATCH_LIST);

  const rows: ReadyRow[] = ready.map((t) => {
    const hours = t.submitted?.totalHours ?? 0;
    const rate = t.approved?.hourly ?? 0;
    // The run held on the approved event — Mark processed copies it, so
    // the label here is exactly what the processed event will say.
    const payRun = heldRunOf(t);
    const defaultAccount = resolveExpenseAccount({ billable: t.billable, defaultAccount: t.streamDefaultAccount }, t.userFunction);
    return {
      id: t.id,
      userName: t.userName,
      userFunction: t.userFunction,
      weekEnding: t.weekEnding,
      streamName: t.streamName,
      customerName: t.customerName,
      hours,
      rate,
      amount: roundMoney(hours * rate),
      payRunLabel: payRun ? `${payRun.payday} run` : "—",
      payday: payRun?.payday ?? null,
      defaultAccount,
      overrideApprovedById: t.approved?.override ? t.approvedById : null,
    };
  });

  return (
    <AppShell me={me} active="processed" selectedId={selectedId}>
      <div className="card">
        <div className="card-h">
          <div>
            <h2>Mark processed</h2>
            <p>
              This records that the pay run has already happened in the payroll system — it does not pay anyone. One entity at a
              time, so what leaves here is a journal for one set of books. Each week carries the pay run its own cutoff put it in.
            </p>
          </div>
        </div>
        <MarkProcessed rows={rows} meId={me.id} />
      </div>

      <div className="card">
        <div className="card-h">
          <div>
            <h2>Batches</h2>
            <p>Each confirmed batch, newest first. Its handoff file holds exactly the weeks that batch processed.</p>
          </div>
        </div>
        <div className="card-b flush">
          {batches.length === 0 ? (
            <div className="empty">No batches yet.</div>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Batch</th>
                    <th>Processed</th>
                    <th>Pay run</th>
                    <th className="r">Weeks</th>
                    <th className="r">Gross</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.batch}>
                      <td className="num">{b.batch}</td>
                      <td>{formatDateTime(b.processedAt)}</td>
                      <td>{formatDateLong(b.payday)}</td>
                      <td className="r num">{b.weeks}</td>
                      <td className="r num">{formatMoney(b.total)}</td>
                      <td className="r">
                        <a className="btn sm" href={`/processed/batch/csv?batch=${encodeURIComponent(b.batch)}`}>
                          Handoff file
                        </a>{" "}
                        <a className="btn sm" href={`/processed/batch/summary/csv?batch=${encodeURIComponent(b.batch)}`}>
                          Summary
                        </a>
                      </td>
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
