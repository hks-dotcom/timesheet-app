"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ensureFreshDemoData } from "@/lib/demo";
import { isGuideId, resolveGuideTarget } from "@/lib/guides";
import { findGateUser, type Role } from "@/lib/repo";
import { SESSION_COOKIE } from "@/lib/session";

const ROLE_LABEL: Record<Role, string> = {
  intern: "Intern",
  consultant: "Consultant",
  manager: "Manager",
  admin: "Payroll Admin",
};

const VALID_ROLES: Role[] = ["intern", "consultant", "manager", "admin"];

export type EnterAppState = { error: string } | null;

// The gate's "Enter the app" action. No sign-in: looks up a seeded person
// matching the chosen role and entity, and holds their id in a cookie.
export async function enterAppAction(_prev: EnterAppState, formData: FormData): Promise<EnterAppState> {
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
    const store = await cookies();
    store.set(SESSION_COOKIE, String(target.userId), { httpOnly: true, sameSite: "lax", path: "/" });
    redirect(target.href);
  }

  const role = String(formData.get("role") ?? "");
  if (!VALID_ROLES.includes(role as Role)) {
    return { error: "Choose a role and an entity." };
  }

  const user = await findGateUser(entityId, role as Role);
  if (!user) {
    return { error: `No ${ROLE_LABEL[role as Role]} is seeded for that entity.` };
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, String(user.id), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });

  redirect("/dashboard");
}

// The "Switch" control on every screen: back to the gate, no session.
export async function switchAction(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect("/");
}
