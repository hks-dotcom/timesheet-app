import { AppShell } from "@/components/AppShell";
import { AdminDashboard } from "@/components/dashboard/AdminDashboard";
import { ContributorDashboard } from "@/components/dashboard/ContributorDashboard";
import { ManagerDashboard } from "@/components/dashboard/ManagerDashboard";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ sel?: string }> }) {
  const me = await requireUser();
  const { sel } = await searchParams;
  const selectedId = sel ? Number(sel) : null;

  return (
    <AppShell me={me} active="dashboard" selectedId={selectedId}>
      {me.role === "admin" ? (
        <AdminDashboard me={me} />
      ) : me.role === "manager" ? (
        <ManagerDashboard me={me} />
      ) : (
        <ContributorDashboard me={me} />
      )}
    </AppShell>
  );
}
