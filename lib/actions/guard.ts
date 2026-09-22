import type { SessionUser } from "../repo";

// Each core asserts the caller's role for itself rather than trusting
// the wrapper that resolved the session. The wrapper's requireUser() is
// the first line of defence; this is the second, so the rule holds
// wherever the core is called from — a proof script, another action, or
// a future endpoint someone adds without thinking it through.
//
// Returns the message to hand back, or null when the caller may proceed.
// Deliberately vague to the caller and deliberately checked BEFORE any
// database work, so a refused call writes nothing.
export function assertRole(me: SessionUser, allowed: SessionUser["role"][]): string | null {
  if (allowed.includes(me.role)) return null;
  return "You are not allowed to do that.";
}
