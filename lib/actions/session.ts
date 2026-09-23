// Core server-side logic for the gate's "Enter the app" action.
//
// Deliberately NOT a "use server" module, like the other cores here: it
// decides WHO the visitor becomes, and only the wrapper in
// app/actions/session.ts may turn that into a session cookie. Splitting
// it out lets a proof script call the real decision directly, with no
// request context, and see that a refused entry yields no user at all.

import { ensureFreshDemoData } from "../demo";
import { isGuideId, resolveGuideTarget } from "../guides";
import { findGateUser, type Role } from "../repo";

const ROLE_LABEL: Record<Role, string> = {
  intern: "Intern",
  consultant: "Consultant",
  manager: "Manager",
  admin: "Payroll Admin",
};

const VALID_ROLES: Role[] = ["intern", "consultant", "manager", "admin"];

// Either a refusal to show on the gate, or the person to hold in the
// session and where to send them.
export type GateEntry = { error: string } | { userId: number; href: string };

// No sign-in: looks up a seeded person matching the chosen role and
// entity. The gate only offers roles that exist in the entity, but this
// does not rely on that — a posted pair with no active user (a crafted
// request, a stale page) is refused here, never mapped to someone else.
export async function enterAppCore(formData: FormData): Promise<GateEntry> {
  await ensureFreshDemoData();

  const entityId = Number(formData.get("entityId"));
  if (!Number.isFinite(entityId)) return { error: "Choose a role and an entity." };

  // A guided entry. The id comes from the client, so it is
  // checked against the allowlist in lib/guides.ts and nothing else;
  // anything unrecognised is refused outright rather than treated as a
  // destination. The landing URL is built server-side from the data as
  // it stands now — the client never supplies one, so there is nothing
  // here to turn into an open redirect.
  const guideRaw = String(formData.get("guide") ?? "");
  if (guideRaw) {
    if (!isGuideId(guideRaw)) return { error: "That guided entry is not one this demo offers." };
    const target = await resolveGuideTarget(guideRaw, entityId);
    if (!target) return { error: "The demo data cannot show that right now. Try Reset the demo, or pick a role below." };
    return { userId: target.userId, href: target.href };
  }

  const role = String(formData.get("role") ?? "");
  if (!VALID_ROLES.includes(role as Role)) {
    return { error: "Choose a role and an entity." };
  }

  const user = await findGateUser(entityId, role as Role);
  if (!user) {
    return { error: `No ${ROLE_LABEL[role as Role]} is seeded for that entity.` };
  }

  return { userId: user.id, href: "/dashboard" };
}
