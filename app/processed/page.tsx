import { AppShell } from "@/components/AppShell";
import { MarkProcessed, type ReadyRow } from "@/components/MarkProcessed";
import { resolveExpenseAccount } from "@/lib/accounts";
import { roundMoney } from "@/lib/format";
import { heldRunOf } from "@/lib/payrun";
import { getReadyForProcessing } from "@/lib/repo";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ProcessedPage({ searchParams }: { searchParams: Promise<{ sel?: string }> }) {
  const me = await requireUser(["admin"]);
  const { sel } = await searchParams;
  const selectedId = sel ? Number(sel) : null;

  const ready = await getReadyForProcessing(me.entityId);

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
    </AppShell>
  );
}
