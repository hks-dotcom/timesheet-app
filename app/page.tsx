import { GateForm } from "@/components/GateForm";
import { ResetDemoControl } from "@/components/ResetDemoControl";
import { ensureFreshDemoData, getDemoMeta } from "@/lib/demo";
import { formatDateTime } from "@/lib/format";
import { listEntities } from "@/lib/repo";

// The gate: no sign-in, pick a role and an entity. Reads live data on
// every request — nothing here is statically prerendered.
export const dynamic = "force-dynamic";

export default async function GatePage() {
  await ensureFreshDemoData();
  const [entities, meta] = await Promise.all([listEntities(), getDemoMeta()]);

  return (
    <div className="gate">
      <div className="gate-card">
        <h1>Timesheet to payroll</h1>
        <p className="sub">Weekly hours, approval, and the hourly feed into the pay run.</p>
        <div className="badge-demo">
          <b>Demo</b> seeded data, no sign-in
        </div>

        <GateForm entities={entities} />

        {meta && <p className="rebuilt">Data last rebuilt {formatDateTime(meta.lastResetAt)}.</p>}
        <div style={{ textAlign: "center", marginTop: 10 }}>
          <ResetDemoControl />
        </div>
      </div>
    </div>
  );
}
