import { AppShell } from "@/components/AppShell";
import { OverrideQueue, type OverrideSheet } from "@/components/OverrideQueue";
import { rateAsOf } from "@/lib/domain";
import { getRatesForUser, getSubmittedForEntity } from "@/lib/repo";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function OverridesPage({ searchParams }: { searchParams: Promise<{ sel?: string }> }) {
  const me = await requireUser(["admin"]);
  const { sel } = await searchParams;
  const selectedId = sel ? Number(sel) : null;

  const submitted = await getSubmittedForEntity(me.entityId);

  const sheets: OverrideSheet[] = await Promise.all(
    submitted.map(async (t) => {
      const rates = await getRatesForUser(t.userId);
      const rate = rateAsOf(rates, t.weekEnding);
      return {
        id: t.id,
        userName: t.userName,
        userFunction: t.userFunction,
        managerName: t.managerName,
        weekEnding: t.weekEnding,
        streamName: t.streamName,
        customerName: t.customerName,
        submittedAt: t.latestEventAt,
        total: t.submitted?.totalHours ?? 0,
        rate: rate?.hourly ?? 0,
      };
    }),
  );

  return (
    <AppShell me={me} active="overrides" selectedId={selectedId}>
      <div className="card">
        <div className="card-h">
          <div>
            <h2>Approval queue &mdash; overrides</h2>
            <p>
              These belong to managers. Approve directly, with a comment, when a pay run will not wait. An override is recorded
              against you and stays on the record.
            </p>
          </div>
        </div>
        <OverrideQueue sheets={sheets} />
      </div>
    </AppShell>
  );
}
