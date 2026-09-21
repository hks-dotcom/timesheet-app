// Cookie-based "session" — there is no sign-in, just a chosen person. See
// the gate (app/(gate)/page.tsx) and app/actions/session.ts for where the
// cookie is set and cleared.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ensureFreshDemoData } from "./demo";
import { getUserById, type Role, type SessionUser } from "./repo";

export const SESSION_COOKIE = "session_user";

export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  const userId = raw ? Number(raw) : NaN;
  if (!Number.isFinite(userId)) return null;
  return getUserById(userId);
}

// Called at the top of every page: refreshes stale demo data first (so the
// user lookup below always runs against current data), then requires a
// session, redirecting to the gate if there isn't one. Pass `allow` to
// also enforce which roles may see this page — anyone else is sent to
// their own dashboard instead of a dead end.
export async function requireUser(allow?: Role[]): Promise<SessionUser> {
  await ensureFreshDemoData();
  const me = await getCurrentUser();
  if (!me) redirect("/");
  if (allow && !allow.includes(me.role)) redirect("/dashboard");
  return me;
}
