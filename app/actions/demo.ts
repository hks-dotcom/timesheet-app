"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { resetDemo } from "@/lib/demo";
import { SESSION_COOKIE } from "@/lib/session";

export type ResetDemoState = { error: string } | null;

// "Reset the demo": rebuilds everything from scratch via the same seed
// builder db:seed uses, subject to the two-minute cooldown. On success,
// sends everyone back to the gate — the person they were viewing as may
// no longer mean anything to a fresh visitor.
export async function resetDemoAction(_prev: ResetDemoState, _formData: FormData): Promise<ResetDemoState> {
  const result = await resetDemo();
  if (!result.ok) {
    return { error: result.message };
  }

  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect("/");
}
