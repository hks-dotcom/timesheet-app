"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { enterAppCore } from "@/lib/actions/session";
import { SESSION_COOKIE } from "@/lib/session";

export type EnterAppState = { error: string } | null;

// The gate's "Enter the app" action. The decision — which seeded person,
// if any, and where to land — is made by enterAppCore; this wrapper only
// holds the chosen id in a cookie. A refusal returns before the cookie
// is touched, so a refused entry leaves no session behind.
export async function enterAppAction(_prev: EnterAppState, formData: FormData): Promise<EnterAppState> {
  const entry = await enterAppCore(formData);
  if ("error" in entry) return { error: entry.error };

  const store = await cookies();
  store.set(SESSION_COOKIE, String(entry.userId), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });

  redirect(entry.href);
}

// The "Switch" control on every screen: back to the gate, no session.
export async function switchAction(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect("/");
}
