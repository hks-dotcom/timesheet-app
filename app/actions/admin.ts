"use server";

// The only callable endpoints for the Users screen. Every export here is
// a server action Next.js registers and exposes; each one resolves the
// session with requireUser() and then delegates to the core in
// lib/actions/admin.ts, which re-checks role, entity and ownership for
// itself. Nothing else is exported — see docs/access.md.

import { addRateCore, recordEndDateCore, saveUserCore } from "@/lib/actions/admin";
import type { AdminState } from "@/lib/actions/admin";
import { requireUser } from "@/lib/session";

export type { AdminState } from "@/lib/actions/admin";

export async function saveUserAction(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const me = await requireUser(["admin"]);
  return saveUserCore(me, formData);
}

export async function addRateAction(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const me = await requireUser(["admin"]);
  return addRateCore(me, formData);
}

export async function recordEndDateAction(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const me = await requireUser(["admin", "manager"]);
  return recordEndDateCore(me, formData);
}
