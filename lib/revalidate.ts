import { revalidatePath } from "next/cache";

// Cache invalidation for a write that has already committed.
//
// Every server action here follows the same shape: open a transaction,
// enforce the rules, commit, then tell Next.js which paths to re-render.
// That last step is a side effect of a write that has ALREADY happened —
// it can never un-happen it. So it must never decide what the action
// returns:
//
//   * It runs only after `commit`, and outside the try/catch that maps a
//     failure to `{ error }` — otherwise a throw here is caught by that
//     catch, the action reports an error for a write that committed, and
//     the user may retry it. For approve and mark-processed a retry is
//     not harmless: the second attempt either double-writes or fails
//     confusingly on a status that has already moved.
//   * A failure here is swallowed and logged, not rethrown, for the same
//     reason: the alternative is an error surfaced to the user for a
//     write that succeeded. The cost of swallowing is a stale cached
//     page until the next navigation; the cost of rethrowing is a
//     committed write that looks like it failed.
//
// `redirect()` is deliberately NOT routed through here. It throws a
// NEXT_REDIRECT signal that Next.js relies on, and swallowing it would
// break the redirect.
export function revalidateAfterCommit(...paths: string[]): void {
  for (const path of paths) {
    try {
      revalidatePath(path);
    } catch (err) {
      console.error(`revalidatePath(${JSON.stringify(path)}) failed after a committed write; the write stands, the cached page may be stale.`, err);
    }
  }
}
